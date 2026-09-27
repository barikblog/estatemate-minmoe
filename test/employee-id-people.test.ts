import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

/**
 * Person-level Employee ID: one terminal identity per person, never longer than
 * 32 characters, shared by their cards and fingerprints, unique across both
 * people tables.
 */
describe('employee ID on people', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
  });

  it('assigns a generated 32-character Employee ID to a new account', async () => {
    const response = await call(env, 'POST', '/api/users', {
      token: adminToken,
      body: { name: 'New Resident', email: 'new@example.com', password: 'temporary-password-1', role: 'resident' },
    });
    expect(response.status).toBe(201);
    const employeeId = String(response.json.employeeId);
    expect(employeeId).toHaveLength(32);
    expect(response.json.employeeIdMaxLength).toBe(32);
    // The identity is persisted on the person, not recomputed per credential.
    expect(database.one(`SELECT employee_id FROM users WHERE id=?`, String(response.json.id))?.employee_id).toBe(employeeId);
  });

  it('keeps an administrator-supplied Employee ID and rejects over-long and duplicates', async () => {
    const supplied = 'EST/2024/0042';
    const created = await call(env, 'POST', '/api/users', {
      token: adminToken,
      body: { name: 'Supplied Id Person', email: 'supplied@example.com', password: 'temporary-password-1', role: 'resident', employeeId: supplied },
    });
    expect(created.status).toBe(201);
    expect(created.json.employeeId).toBe(supplied);

    const tooLong = await call(env, 'POST', '/api/users', {
      token: adminToken,
      body: { name: 'Too Long', email: 'toolong@example.com', password: 'temporary-password-1', role: 'resident', employeeId: 'x'.repeat(33) },
    });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.json.error ?? tooLong.text)).toMatch(/32 characters/);

    const duplicate = await call(env, 'POST', '/api/users', {
      token: adminToken,
      body: { name: 'Duplicate Id', email: 'dupe@example.com', password: 'temporary-password-1', role: 'resident', employeeId: supplied.toLowerCase() },
    });
    expect(duplicate.status).toBe(409);
  });

  it('lets an operator change the Employee ID and blocks a clash with a dependant', async () => {
    database.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by,employee_id)
       VALUES ('member-staff','property-1','user-resident','Ada Staff','domestic_staff','active','user-resident','HOUSE-77')`,
    );
    const clash = await call(env, 'PATCH', `/api/users/${estate.residentId}`, {
      token: adminToken,
      body: { employeeId: 'house-77' },
    });
    expect(clash.status).toBe(409);
    expect(String(clash.json.error)).toMatch(/already assigned/);

    const ok = await call(env, 'PATCH', `/api/users/${estate.residentId}`, {
      token: adminToken,
      body: { employeeId: 'EST-OWNER-01' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.employeeId).toBe('EST-OWNER-01');
  });

  it('assigns dependants their own Employee ID at creation', async () => {
    const created = await call(env, 'POST', '/api/household-members', {
      token: adminToken,
      body: { propertyId: estate.propertyId, name: 'Ada Dependant', relationship: 'spouse' },
    });
    expect(created.status).toBe(201);
    const employeeId = String(created.json.employeeId);
    expect(employeeId).toHaveLength(32);
    expect(database.one(`SELECT employee_id FROM household_members WHERE id=?`, String(created.json.id))?.employee_id).toBe(employeeId);
  });

  it('defaults a fingerprint to the person Employee ID, never a value over 32 chars', async () => {
    const finger = await call(env, 'POST', '/api/access/fingerprints', {
      token: adminToken,
      body: { residentId: estate.residentId, fingerNo: 1 },
    });
    expect(finger.status).toBe(201);
    const employeeId = database.one(`SELECT employee_id FROM users WHERE id=?`, estate.residentId)?.employee_id;
    expect(finger.json.employeeNo).toBe(employeeId);
    expect(String(finger.json.employeeNo).length).toBeLessThanOrEqual(32);

    const tooLong = await call(env, 'POST', '/api/access/fingerprints', {
      token: adminToken,
      body: { residentId: estate.residentId, fingerNo: 2, employeeNo: '9'.repeat(40) },
    });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.json.error)).toMatch(/32 characters/);
  });

  it('sends a card to the terminal with the person Employee ID attached', async () => {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES ('device-cards','Main Gate','Hikvision','Main','entry','access_terminal_8xx','manual','online')`,
    );
    const created = await call(env, 'POST', '/api/access/cards', {
      token: adminToken,
      body: { residentId: estate.residentId, cardUid: '48484848' },
    });
    expect(created.status).toBe(201);
    const employeeId = database.one(`SELECT employee_id FROM users WHERE id=?`, estate.residentId)?.employee_id;
    expect(created.json.employeeNo).toBe(employeeId);
    const operation = database.one(`SELECT payload_json FROM device_operations WHERE card_id=?`, String(created.json.id));
    expect(operation?.payload_json && JSON.parse(String(operation.payload_json)).employeeNo).toBe(employeeId);
  });

  it('enforces the 32-character rule at the database level too', () => {
    expect(() => database.run(
      `UPDATE users SET employee_id=? WHERE id=?`, 'z'.repeat(33), estate.residentId,
    )).toThrow(/CHECK/i);
    database.run(
      `INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,requested_by)
       VALUES ('member-trigger','property-1','user-resident','Trigger Person','other','active','user-resident')`,
    );
    database.run(
      `INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no)
       VALUES ('finger-ok','user-resident','member-trigger','ok-1',1)`,
    );
    expect(() => database.run(
      `INSERT INTO fingerprint_credentials(id,resident_id,household_member_id,employee_no,finger_no)
       VALUES ('finger-bad','user-resident','member-trigger',?,2)`, 'y'.repeat(33),
    )).toThrow(/32 characters|employee_no/i);
  });
});
