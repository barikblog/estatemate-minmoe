import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

/**
 * Reproduces what a browser `<input type="datetime-local">` submits: a naive
 * wall-clock string in the resident's own timezone, with no offset.
 */
function wallClockInput(date: Date, timeZone: string): string {
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

const ESTATE_ZONE = 'Africa/Lagos';

async function issuePass(env: Env, residentToken: string, from: Date, until: Date): Promise<Record<string, unknown>> {
  const response = await call(env, 'POST', '/api/visitors', {
    token: residentToken,
    body: {
      visitorName: 'Grace Visitor',
      visitorPhone: '08030000000',
      propertyId: 'property-1',
      validFrom: wallClockInput(from, ESTATE_ZONE),
      validUntil: wallClockInput(until, ESTATE_ZONE),
    },
  });
  if (response.status !== 201) throw new Error(`pass creation failed: ${response.status} ${response.text}`);
  return response.json;
}

describe('visitor pass validity window', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let residentToken: string;
  let securityToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
  });

  it('accepts a pass that is inside the window the resident entered', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now - 30 * 60_000), new Date(now + 8 * 3_600_000));

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });

    expect(scan.status).toBe(200);
    expect(scan.json.valid).toBe(true);
    expect(scan.json.reason).toBeNull();
  });

  it('accepts a pass issued to start right now in the estate timezone', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now), new Date(now + 8 * 3_600_000));

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.pin), source: 'phone_camera' },
    });

    expect(scan.json.valid).toBe(true);
  });

  it('rejects a pass that has not started yet and says why', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now + 2 * 3_600_000), new Date(now + 8 * 3_600_000));

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });

    expect(scan.json.valid).toBe(false);
    expect(String(scan.json.reason)).toMatch(/not active yet/i);
  });

  it('rejects an expired pass and says why', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now - 8 * 3_600_000), new Date(now - 60_000));

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });

    expect(scan.json.valid).toBe(false);
    expect(String(scan.json.reason)).toMatch(/expired/i);
  });

  it('stores the validity window as an unambiguous instant', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now - 60_000), new Date(now + 3_600_000));
    const row = database.one(`SELECT valid_from,valid_until FROM visitor_requests WHERE id=?`, String(pass.id));
    expect(String(row?.valid_from)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(String(row?.valid_until)).toMatch(/Z$/);
  });

  it('reads legacy naive rows in the estate timezone instead of UTC', async () => {
    const now = Date.now();
    const from = wallClockInput(new Date(now - 60_000), ESTATE_ZONE).slice(0, 16);
    const until = wallClockInput(new Date(now + 3_600_000), ESTATE_ZONE).slice(0, 16);
    database.run(
      `INSERT INTO visitor_requests(id,resident_id,property_id,visitor_name,pin,qr_token,credential_number,barcode_payload,credential_mode,status,valid_from,valid_until)
       VALUES ('legacy-pass','user-resident','property-1','Legacy Visitor','111222','legacy-token','990011','990011','hybrid','active',?,?)`,
      from, until,
    );

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: '990011', source: 'manual' },
    });

    expect(scan.json.valid).toBe(true);
  });

  it('keeps a checked-out pass invalid', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now - 60_000), new Date(now + 3_600_000));
    database.run(`UPDATE visitor_requests SET status='checked_out' WHERE id=?`, String(pass.id));

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });

    expect(scan.json.valid).toBe(false);
    expect(String(scan.json.reason)).toMatch(/checked out/i);
  });

  it('lets Security accept a previewed pass that is inside its window', async () => {
    const now = Date.now();
    const pass = await issuePass(env, residentToken, new Date(now - 60_000), new Date(now + 3_600_000));
    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });

    const decision = await call(env, 'POST', `/api/visitors/${String(pass.id)}/decision`, {
      token: securityToken,
      body: { decision: 'accepted', action: 'in', scanId: String(scan.json.scanId) },
    });

    expect(decision.status).toBe(200);
    expect(database.one(`SELECT status FROM visitor_requests WHERE id=?`, String(pass.id))?.status).toBe('checked_in');
  });
});
