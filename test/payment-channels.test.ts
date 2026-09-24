import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

const HOUR = 3_600_000;

function wallClockInput(date: Date, timeZone = 'Africa/Lagos'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}:${read('second')}`;
}

describe('initiate payment channels', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let residentToken: string;
  let cashierToken: string;
  let adminToken: string;
  let managerToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    cashierToken = await tokenFor(env, estate.cashierId, 'cashier', 'Chidi Cashier');
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    database.run(
      `INSERT INTO bills(id,property_id,resident_id,amount_minor,due_date,bill_type,description,status)
       VALUES ('bill-1','property-1','user-resident',2500000,'2026-12-31','facility_fee','Facility fee','unpaid')`,
    );
  });

  it('offers POS at office, cash at office and bank transfer — and no online option', async () => {
    const response = await call(env, 'GET', '/api/payment-channels', { token: residentToken });

    expect(response.status).toBe(200);
    const methods = response.json.methods as Array<{ id: string; label: string }>;
    expect(methods.map((method) => method.id)).toEqual(['pos', 'cash', 'bank_transfer']);
    expect(methods.map((method) => method.label)).toEqual([
      'POS payment at office',
      'Cash payment at office',
      'Bank transfer',
    ]);
    expect(JSON.stringify(methods)).not.toMatch(/online/i);
    expect(response.json.editable).toBe(false);
  });

  it('lets an Administrator publish bank account details and residents read them', async () => {
    const saved = await call(env, 'PUT', '/api/payment-channels', {
      token: adminToken,
      body: {
        accountName: 'EstateMate Estate Association',
        accountNumber: '0123456789',
        bankName: 'Zenith Bank',
        sortCode: '057-123',
        referenceNote: 'Use your unit number as the transfer reference.',
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.bankAccount).toMatchObject({ bankName: 'Zenith Bank', accountNumber: '0123456789' });

    const residentView = await call(env, 'GET', '/api/payment-channels', { token: residentToken });
    expect(residentView.json.bankAccountConfigured).toBe(true);
    expect(residentView.json.bankAccount).toMatchObject({
      accountName: 'EstateMate Estate Association',
      bankName: 'Zenith Bank',
      sortCode: '057-123',
    });
  });

  it('refuses bank account edits from a Cashier or Manager', async () => {
    const cashier = await call(env, 'PUT', '/api/payment-channels', { token: cashierToken, body: { bankName: 'Rogue Bank' } });
    const manager = await call(env, 'PUT', '/api/payment-channels', { token: managerToken, body: { bankName: 'Rogue Bank' } });

    expect(cashier.status).toBe(403);
    expect(manager.status).toBe(403);
    expect(database.one(`SELECT value FROM settings WHERE key='bank_account_bank'`)?.value).toBe('');
  });

  it('rejects a malformed bank account number', async () => {
    const response = await call(env, 'PUT', '/api/payment-channels', { token: adminToken, body: { accountNumber: 'not-an-account' } });
    expect(response.status).toBe(400);
  });

  it('rejects the removed online payment method', async () => {
    const response = await call(env, 'POST', '/api/payments', {
      token: residentToken,
      body: { billId: 'bill-1', amountMinor: 2500000, paymentMethod: 'online' },
    });

    expect(response.status).toBe(400);
    expect(String(response.json.error)).toMatch(/POS payment at office/);
  });

  it('accepts a bank-transfer payment and leaves it pending review', async () => {
    const response = await call(env, 'POST', '/api/payments', {
      token: residentToken,
      body: { billId: 'bill-1', amountMinor: 2500000, paymentMethod: 'bank_transfer' },
    });

    expect(response.status).toBe(201);
    expect(response.json.status).toBe('pending');
    expect(database.one(`SELECT payment_method FROM payments WHERE id=?`, String(response.json.id))?.payment_method).toBe('bank_transfer');
  });

  it('records POS and cash payments at the office', async () => {
    for (const method of ['pos', 'cash']) {
      const response = await call(env, 'POST', '/api/payments', {
        token: residentToken,
        body: { billId: 'bill-1', amountMinor: 100000, paymentMethod: method },
      });
      expect(response.status).toBe(201);
    }
    expect(database.query(`SELECT payment_method FROM payments ORDER BY payment_method`).map((row) => row.payment_method))
      .toEqual(['cash', 'pos']);
  });
});

describe('resident visitor pass gate scope', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let residentToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
  });

  it('defaults a resident pass to every gate and ignores a requested device', async () => {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES ('device-1','Main Gate Terminal','Hikvision','Main Gate','entry','access_terminal_8xx','manual','online')`,
    );
    const now = Date.now();
    const response = await call(env, 'POST', '/api/visitors', {
      token: residentToken,
      body: {
        visitorName: 'Grace Visitor',
        propertyId: 'property-1',
        deviceId: 'device-1',
        validFrom: wallClockInput(new Date(now - 60_000)),
        validUntil: wallClockInput(new Date(now + 4 * HOUR)),
      },
    });

    expect(response.status).toBe(201);
    expect(response.json.gateScope).toBe('both');
    const row = database.one(`SELECT gate_scope,device_id FROM visitor_requests WHERE id=?`, String(response.json.id));
    expect(row?.gate_scope).toBe('both');
    expect(row?.device_id).toBeNull();
  });

  it('still lets an Administrator attach a pass to one gate', async () => {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES ('device-2','Side Gate Terminal','Hikvision','Side Gate','entry','access_terminal_8xx','manual','online')`,
    );
    const adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    const now = Date.now();
    const response = await call(env, 'POST', '/api/visitors', {
      token: adminToken,
      body: {
        visitorName: 'Grace Visitor',
        residentId: estate.residentId,
        propertyId: 'property-1',
        deviceId: 'device-2',
        validFrom: wallClockInput(new Date(now - 60_000)),
        validUntil: wallClockInput(new Date(now + 4 * HOUR)),
      },
    });

    expect(response.status).toBe(201);
    expect(response.json.gateScope).toBe('gate');
    expect(database.one(`SELECT device_id FROM visitor_requests WHERE id=?`, String(response.json.id))?.device_id).toBe('device-2');
  });

  it('releases a checked-in visitor whose window has already ended', async () => {
    const securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
    const now = Date.now();
    const created = await call(env, 'POST', '/api/visitors', {
      token: residentToken,
      body: {
        visitorName: 'Overstaying Visitor',
        propertyId: 'property-1',
        validFrom: wallClockInput(new Date(now - 3 * HOUR)),
        validUntil: wallClockInput(new Date(now - 2 * HOUR)),
      },
    });
    const passId = String(created.json.id);
    database.run(`UPDATE visitor_requests SET status='checked_in' WHERE id=?`, passId);

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(created.json.credentialNumber), source: 'manual' },
    });
    expect(scan.json.valid).toBe(false);

    const checkout = await call(env, 'POST', `/api/visitors/${passId}/decision`, {
      token: securityToken,
      body: { decision: 'accepted', action: 'out', scanId: String(scan.json.scanId) },
    });
    expect(checkout.status).toBe(200);
    expect(database.one(`SELECT status FROM visitor_requests WHERE id=?`, passId)?.status).toBe('checked_out');
  });
});
