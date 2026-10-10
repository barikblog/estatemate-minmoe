import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

/**
 * Visitor account options: the person type a visitor account is filed under on
 * the terminals, how many times a pass may be used, the six-digit PIN, the
 * validity window (and the estate maximum an administrator edits), plus the
 * purpose of visit and the host's remark.
 *
 * Run against the real Worker and the real migration chain, so a rule that only
 * lives in the route is still covered.
 */
describe('visitor account options', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;
  let managerToken: string;
  let securityToken: string;
  let residentToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'security', 'Musa Manager');
    securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
  });

  function addDevice(id = 'device-1', pattern = 'manual'): void {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES (?, 'Gate Terminal', 'Hikvision', 'Gate', 'entry', 'access_terminal_8xx', ?, 'online')`,
      id, pattern,
    );
  }

  const DAY = 24 * 60 * 60 * 1000;

  async function issue(
    token: string,
    body: Record<string, unknown> = {},
    from: Date = new Date(Date.now() - 60_000),
    until: Date = new Date(Date.now() + 8 * 60 * 60_000),
  ) {
    return call(env, 'POST', '/api/visitors', {
      token,
      body: {
        visitorName: 'Grace Visitor',
        visitorPhone: '08030000000',
        propertyId: estate.propertyId,
        validFrom: from.toISOString(),
        validUntil: until.toISOString(),
        ...body,
      },
    });
  }

  /** A gate officer previews the pass and returns the fresh scan id. */
  async function preview(credential: string): Promise<Record<string, unknown>> {
    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: credential, source: 'manual' },
    });
    expect(scan.status).toBe(200);
    return scan.json;
  }

  async function decide(id: string, scanId: string, decision: 'accepted'|'rejected', action?: 'in'|'out') {
    return call(env, 'POST', `/api/visitors/${id}/decision`, {
      token: securityToken,
      body: { decision, action, scanId },
    });
  }

  it('files a new visitor account under the visitor person type with a six-digit PIN', async () => {
    addDevice();
    const created = await issue(residentToken);
    expect(created.status).toBe(201);
    expect(String(created.json.pin)).toMatch(/^\d{6}$/);
    expect(created.json.personType).toBe('visitor');
    expect(created.json.personTypeLabel).toBe('Visitor');

    const row = database.one(`SELECT person_type,pin FROM visitor_requests WHERE id=?`, String(created.json.id));
    expect(row?.person_type).toBe('visitor');
    expect(String(row?.pin)).toMatch(/^\d{6}$/);

    // The terminal write carries the type; visit times travel with it for the
    // operator's benefit but are counted by EstateMate, not the firmware.
    const operation = database.one(
      `SELECT payload_json FROM visitor_device_operations WHERE visitor_request_id=? AND operation='upsert_visitor'`,
      String(created.json.id),
    );
    const payload = JSON.parse(String(operation?.payload_json)) as Record<string, unknown>;
    expect(payload.personType).toBe('visitor');
    expect(payload.visitTimes).toBe(1);
  });

  it('leaves a pass issued before the option existed on the type it was written with', async () => {
    const created = await issue(residentToken);
    expect(created.status).toBe(201);
    // The migration keeps historical passes `normal`, so a reconciliation
    // rebuilds the account the terminal already holds.
    database.run(`UPDATE visitor_requests SET person_type='normal' WHERE id=?`, String(created.json.id));
    addDevice();
    const sync = await call(env, 'POST', '/api/visitors/sync-active', { token: adminToken });
    expect(sync.status).toBe(200);
    const operation = database.one(
      `SELECT payload_json FROM visitor_device_operations WHERE visitor_request_id=? AND operation='upsert_visitor'`,
      String(created.json.id),
    );
    const payload = JSON.parse(String(operation?.payload_json)) as Record<string, unknown>;
    expect(payload.personType).toBe('normal');
  });

  it('lets an estate officer choose the person type and ignores it on a resident request', async () => {
    const byOfficer = await issue(adminToken, { personType: 'normal', residentId: estate.residentId });
    expect(byOfficer.status).toBe(201);
    expect(byOfficer.json.personType).toBe('normal');
    expect(database.one(`SELECT person_type FROM visitor_requests WHERE id=?`, String(byOfficer.json.id))?.person_type).toBe('normal');

    const byResident = await issue(residentToken, { personType: 'normal' });
    expect(byResident.status).toBe(201);
    expect(byResident.json.personType).toBe('visitor');

    const refused = await issue(adminToken, { personType: 'administrator', residentId: estate.residentId });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/personType must be one of/);
  });

  it('keeps visit times inside 1-10 and counts them at the gate', async () => {
    for (const bad of [0, 11, 25, 'soon']) {
      const refused = await issue(residentToken, { visitTimes: bad });
      expect(refused.status, `expected rejection: ${String(bad)}`).toBe(400);
      expect(refused.json.error).toMatch(/visitTimes must be .*between 1 and 10/);
    }
    const single = await issue(residentToken, { visitTimes: 1 });
    expect(single.status).toBe(201);
    expect(single.json.visitTimes).toBe(1);
    expect(single.json.visitsRemaining).toBe(1);

    const credential = String(single.json.credentialNumber);
    const first = await preview(credential);
    expect(first.visitsUsed).toBe(0);
    expect(first.visitsRemaining).toBe(1);

    const checkIn = await decide(String(single.json.id), String(first.scanId), 'accepted', 'in');
    expect(checkIn.status).toBe(200);
    expect(checkIn.json.visitsUsed).toBe(1);
    expect(checkIn.json.visitsRemaining).toBe(0);
    expect(database.one(`SELECT status FROM visitor_requests WHERE id=?`, String(single.json.id))?.status).toBe('checked_in');

    // The allowance is spent: the next entry is refused, with the reason.
    const second = await preview(credential);
    expect(second.valid).toBe(false);
    expect(second.visitsUsed).toBe(1);
    expect(second.visitsRemaining).toBe(0);
    expect(second.reason).toMatch(/used all 1 permitted visit/);

    const refusedEntry = await decide(String(single.json.id), String(second.scanId), 'accepted', 'in');
    expect(refusedEntry.status).toBe(403);
    expect(refusedEntry.json.error).toMatch(/used all 1 permitted visit/);

    // Somebody already inside is never stranded: check-out still works.
    const third = await preview(credential);
    const checkOut = await decide(String(single.json.id), String(third.scanId), 'accepted', 'out');
    expect(checkOut.status).toBe(200);
    expect(database.one(`SELECT status FROM visitor_requests WHERE id=?`, String(single.json.id))?.status).toBe('checked_out');
  });

  it('admits a visitor as many times as the pass allows', async () => {
    const pass = await issue(residentToken, { visitTimes: 3 });
    expect(pass.status).toBe(201);
    const credential = String(pass.json.credentialNumber);

    for (let visit = 1; visit <= 3; visit += 1) {
      const scan = await preview(credential);
      expect(scan.valid, `visit ${visit} must be allowed`).toBe(true);
      const ish = await decide(String(pass.json.id), String(scan.scanId), 'accepted', 'in');
      expect(ish.status).toBe(200);
      expect(ish.json.visitsRemaining).toBe(3 - visit);
      // Leave again so the next visit is a fresh check-in.
      const outScan = await preview(credential);
      const out = await decide(String(pass.json.id), String(outScan.scanId), 'accepted', 'out');
      expect(out.status).toBe(200);
      database.run(`UPDATE visitor_requests SET status='active' WHERE id=?`, String(pass.json.id));
    }

    const used = await preview(credential);
    expect(used.valid).toBe(false);
    expect(used.visitsUsed).toBe(3);
  });

  it('stores the purpose of visit and the remark with the pass', async () => {
    const created = await issue(residentToken, { purposeOfVisit: 'delivery', remark: '  Blue car, after six  ' });
    expect(created.status).toBe(201);
    expect(created.json.purposeOfVisitLabel).toBe('Delivery or collection');
    expect(created.json.remark).toBe('Blue car, after six');

    const row = database.one(`SELECT purpose_of_visit,purpose_of_visit_other,remark FROM visitor_requests WHERE id=?`, String(created.json.id));
    expect(row?.purpose_of_visit).toBe('delivery');
    expect(row?.remark).toBe('Blue car, after six');

    // "Other" keeps what the host typed, and refuses an empty description.
    const other = await issue(residentToken, { purposeOfVisit: 'other', purposeOfVisitOther: 'Medical appointment' });
    expect(other.status).toBe(201);
    expect(other.json.purposeOfVisitLabel).toBe('Medical appointment');

    const noReason = await issue(residentToken, { purposeOfVisit: 'other' });
    expect(noReason.status).toBe(400);
    expect(noReason.json.error).toMatch(/Describe the purpose/);

    const unknown = await issue(residentToken, { purposeOfVisit: 'sightseeing' });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/purposeOfVisit must be one of/);

    const longRemark = await issue(residentToken, { remark: 'x'.repeat(501) });
    expect(longRemark.status).toBe(400);
    expect(longRemark.json.error).toMatch(/500 characters or fewer/);
  });

  it('shows the purpose, remark and visit allowance to the officer at the gate', async () => {
    const created = await issue(residentToken, { purposeOfVisit: 'service_repair', remark: 'Plumber, works for the owner', visitTimes: 2 });
    expect(created.status).toBe(201);
    const scan = await preview(String(created.json.credentialNumber));
    expect(scan.purposeOfVisitLabel).toBe('Service, repair or maintenance');
    expect(scan.remark).toBe('Plumber, works for the owner');
    expect(scan.visitTimes).toBe(2);
    expect(scan.visitsRemaining).toBe(2);
  });

  it('holds every requester to the estate maximum validity period', async () => {
    const now = Date.now();
    const tooLong = await issue(residentToken, {}, new Date(now - 60_000), new Date(now + 8 * DAY));
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.error).toMatch(/more than 7 days/);

    // Inside the maximum: a one-day pass is the default and is accepted.
    const oneDay = await issue(residentToken, {}, new Date(now - 60_000), new Date(now + DAY));
    expect(oneDay.status).toBe(201);
    expect(oneDay.json.validityDays).toBe(1);
    expect(oneDay.json.maxValidityDays).toBe(7);

    // An administrator raises the ceiling; the longer pass is then allowed,
    // for a resident and for an officer alike.
    const raised = await call(env, 'PUT', '/api/portal-config', {
      token: adminToken,
      body: { visitor_max_validity_days: '14' },
    });
    expect(raised.status).toBe(200);

    const tenDays = await issue(residentToken, {}, new Date(now - 60_000), new Date(now + 10 * DAY));
    expect(tenDays.status).toBe(201);
    expect(tenDays.json.maxValidityDays).toBe(14);

    const stillTooLong = await issue(adminToken, { residentId: estate.residentId }, new Date(now - 60_000), new Date(now + 15 * DAY));
    expect(stillTooLong.status).toBe(400);
    expect(stillTooLong.json.error).toMatch(/more than 14 days/);
  });

  it('refuses a maximum that would make the estate default impossible, and out-of-range values', async () => {
    const widened = await call(env, 'PUT', '/api/portal-config', {
      token: adminToken,
      body: { visitor_default_validity_days: '5', visitor_max_validity_days: '10' },
    });
    expect(widened.status).toBe(200);

    const belowDefault = await call(env, 'PUT', '/api/portal-config', {
      token: adminToken,
      body: { visitor_max_validity_days: '3' },
    });
    expect(belowDefault.status).toBe(400);
    expect(belowDefault.json.error).toMatch(/cannot be lower than the default window of 5/);

    const outOfRange = await call(env, 'PUT', '/api/portal-config', {
      token: adminToken,
      body: { visitor_max_validity_days: '0' },
    });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.json.error).toMatch(/whole number of days between 1 and 30/);

    const badType = await call(env, 'PUT', '/api/portal-config', {
      token: adminToken,
      body: { visitor_person_type: 'administrator' },
    });
    expect(badType.status).toBe(400);
    expect(badType.json.error).toMatch(/visitor_person_type must be one of/);

    // A Manager is an operational role: estate-wide settings stay with the
    // Administrator, so the maximum is not editable from that session.
    const managerAttempt = await call(env, 'PUT', '/api/portal-config', {
      token: managerToken,
      body: { visitor_max_validity_days: '9' },
    });
    expect(managerAttempt.status).toBe(403);
  });

  it('uses the estate default window and person type for a pass that names none', async () => {
    await call(env, 'PUT', '/api/portal-config', {
      token: adminToken,
      body: { visitor_default_validity_days: '2', visitor_person_type: 'normal' },
    });
    const created = await issue(residentToken);
    expect(created.status).toBe(201);
    expect(created.json.personType).toBe('normal');
    expect(created.json.defaultValidityDays).toBe(2);
  });
});
