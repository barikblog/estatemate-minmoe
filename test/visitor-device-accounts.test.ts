import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { call, createTestDatabase, createTestEnv, seedEstate, tokenFor, type SeededEstate, type TestDatabase } from './harness';

/**
 * Visitor device-account lifecycle: a pass automatically occupies a slot on the
 * estate's terminals when issued, and the slot is released automatically as soon
 * as validity ends. The pass record is never deleted — terminals have a limited
 * number of person slots, so a visitor's account may only live there while it
 * can actually open the gate.
 */
describe('visitor device-account lifecycle', () => {
  let database: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;
  let residentToken: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    env = createTestEnv(database.d1);
    estate = seedEstate(database);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
  });

  function addDevice(id = 'device-1', pattern = 'manual'): void {
    database.run(
      `INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
       VALUES (?, 'Gate Terminal', 'Hikvision', 'Gate', 'entry', 'access_terminal_8xx', ?, 'online')`,
      id, pattern,
    );
  }

  async function issuePass(from: Date, until: Date): Promise<Record<string, unknown>> {
    const response = await call(env, 'POST', '/api/visitors', {
      token: residentToken,
      body: {
        visitorName: 'Grace Visitor',
        propertyId: estate.propertyId,
        validFrom: from.toISOString(),
        validUntil: until.toISOString(),
      },
    });
    if (response.status !== 201) throw new Error(`pass creation failed: ${response.status} ${response.text}`);
    return response.json;
  }

  /** Runs the minute-level cron the same way Cloudflare would. */
  async function runMinuteSweep(): Promise<void> {
    // Cloudflare's waitUntil returns control first and lets the work finish
    // afterwards, so the test collects the promises and drains them explicitly.
    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now() } as unknown as Parameters<typeof worker.scheduled>[0],
      env,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);
  }

  it('provisions the visitor account onto the terminals when the pass is requested', async () => {
    addDevice();
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));

    const row = database.one(`SELECT device_account_state,device_account_provisioned_at FROM visitor_requests WHERE id=?`, String(pass.id));
    expect(row?.device_account_state).toBe('provisioned');
    expect(row?.device_account_provisioned_at).toBeTruthy();

    const operation = database.one(
      `SELECT operation,status,payload_json FROM visitor_device_operations WHERE visitor_request_id=? AND operation='upsert_visitor'`,
      String(pass.id),
    );
    expect(operation?.operation).toBe('upsert_visitor');
    const payload = JSON.parse(String(operation?.payload_json)) as Record<string, unknown>;
    // The employee number the terminal will know the visitor by — composed
    // centrally so it can never exceed the 32 characters ISAPI allows.
    expect(String(payload.employeeNo)).toBe(`visitor-${String(pass.credentialNumber)}`);
    expect(String(payload.employeeNo).length).toBeLessThanOrEqual(32);
    expect(payload.department).toBe('Company');
    expect(payload.pin).toBe(pass.pin);
    expect(String(payload.pin)).toMatch(/^\d{4,8}$/);
  });

  it('reconciliation restores the stored PIN and Company department to a failed account operation', async () => {
    addDevice();
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));
    // Model an operation created by the previous bridge contract: it failed with
    // no PIN in its payload. Reconciliation must rebuild it from the pass row.
    database.run(`UPDATE visitor_requests SET pin='004217' WHERE id=?`, String(pass.id));
    database.run(
      `UPDATE visitor_device_operations SET status='failed',payload_json='{"credentialNumber":"legacy"}' WHERE visitor_request_id=? AND operation='upsert_visitor'`,
      String(pass.id),
    );

    const sync = await call(env, 'POST', '/api/visitors/sync-active', { token: adminToken });
    expect(sync.status).toBe(200);
    expect(sync.json.queued).toBe(1);
    const operation = database.one(
      `SELECT status,payload_json FROM visitor_device_operations WHERE visitor_request_id=? AND operation='upsert_visitor'`,
      String(pass.id),
    );
    expect(operation?.status).toBe('manual_action_required');
    const payload = JSON.parse(String(operation?.payload_json)) as Record<string, unknown>;
    expect(payload.department).toBe('Company');
    expect(payload.pin).toBe('004217');
    expect(payload.employeeNo).toBe(`visitor-${String(pass.credentialNumber)}`);
  });

  it('marks a pass with no terminals as none and reports that from the creation call', async () => {
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));
    expect(pass.deviceAccountState).toBe('none');
  });

  it('deletes the visitor account from all devices the minute validity expires, keeping the record', async () => {
    addDevice();
    const now = Date.now();
    // A live pass gets provisioned; make it expire, then the next sweep frees the slot.
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 30_000));
    database.run(`UPDATE visitor_requests SET valid_until=? WHERE id=?`, new Date(now - 5_000).toISOString(), String(pass.id));

    await runMinuteSweep();

    const row = database.one(`SELECT status,device_account_state,device_account_removed_reason FROM visitor_requests WHERE id=?`, String(pass.id));
    // The record is still here — only its device-slot state advanced.
    expect(row?.status).toBe('expired');
    expect(row?.device_account_state).toBe('removal_queued');
    expect(String(row?.device_account_removed_reason)).toMatch(/validity expired/);

    const revocation = database.one(
      `SELECT operation,status,payload_json FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor'`,
      String(pass.id),
    );
    expect(revocation?.operation).toBe('revoke_visitor');
    // No linked agent in this test estate, so it is an operator task.
    expect(revocation?.status).toBe('manual_action_required');
    const payload = JSON.parse(String(revocation?.payload_json)) as Record<string, unknown>;
    expect(payload.credentialNumber).toBe(String(pass.credentialNumber));
  });

  it('releases to every device even one linked after the pass was issued', async () => {
    addDevice('device-early');
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));
    // A second terminal is added after issuance — removal must still reach it.
    addDevice('device-late');
    database.run(`UPDATE visitor_requests SET valid_until=? WHERE id=?`, new Date(now - 5_000).toISOString(), String(pass.id));

    await runMinuteSweep();

    const revocations = database.query(
      `SELECT device_id FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor'`,
      String(pass.id),
    );
    expect(new Set(revocations.map((row) => row.device_id))).toEqual(new Set(['device-early', 'device-late']));
  });

  it('confirms removal once every revocation has been applied', async () => {
    addDevice();
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));
    database.run(`UPDATE visitor_requests SET valid_until=? WHERE id=?`, new Date(now - 5_000).toISOString(), String(pass.id));
    await runMinuteSweep();

    // Sweeping twice must not queue the same revocation again.
    await runMinuteSweep();
    const revocations = database.query(
      `SELECT id FROM visitor_device_operations WHERE visitor_request_id=? AND operation='revoke_visitor'`, String(pass.id));
    expect(revocations).toHaveLength(1);

    // The operator applies the deletion on the terminal and marks it in Hardware actions.
    const applied = await call(env, 'PATCH', `/api/access/operations/${String(revocations[0]!.id)}`, {
      token: adminToken,
      body: { status: 'applied' },
    });
    expect(applied.status).toBe(200);
    const row = database.one(`SELECT device_account_state,device_account_removed_at FROM visitor_requests WHERE id=?`, String(pass.id));
    expect(row?.device_account_state).toBe('removed');
    expect(row?.device_account_removed_at).toBeTruthy();

    // Once removed, the sweep leaves the pass alone forever.
    await runMinuteSweep();
    const done = database.query(`SELECT COUNT(*) AS count FROM visitor_device_operations WHERE visitor_request_id=?`, String(pass.id));
    expect(Number(done[0]!.count)).toBe(2); // the original upsert + the one revocation
  });

  it('treats a manual revocation as the same lifecycle event', async () => {
    addDevice();
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));
    const revoke = await call(env, 'POST', `/api/access/remote/visitors/${String(pass.id)}/revoke`, {
      token: adminToken,
      body: { reason: 'Security incident' },
    });
    expect(revoke.status).toBe(200);
    const row = database.one(`SELECT status,device_account_state FROM visitor_requests WHERE id=?`, String(pass.id));
    expect(row?.status).toBe('revoked');
    expect(row?.device_account_state).toBe('removal_queued');
  });

  it('hourly cron also catches up, and a scan at the gate releases a just-expired slot opportunistically', async () => {
    addDevice();
    const securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 30_000));
    database.run(`UPDATE visitor_requests SET valid_until=? WHERE id=?`, new Date(now - 1_000).toISOString(), String(pass.id));

    // Before any cron or scan: the slot is still recorded as held.
    expect(database.one(`SELECT device_account_state FROM visitor_requests WHERE id=?`, String(pass.id))?.device_account_state).toBe('provisioned');

    // A scan at the gate triggers the release immediately.
    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });
    expect(scan.json.valid).toBe(false);
    expect(database.one(`SELECT device_account_state FROM visitor_requests WHERE id=?`, String(pass.id))?.device_account_state).toBe('removal_queued');
  });

  it('lets a guard check out a visitor whose pass expired while they were inside', async () => {
    addDevice();
    const securityToken = await tokenFor(env, estate.securityId, 'security', 'Sola Security');
    const now = Date.now();
    const pass = await issuePass(new Date(now - 60_000), new Date(now + 30_000));
    database.run(`UPDATE visitor_requests SET status='checked_in',checked_in_at=datetime('now'),valid_until=? WHERE id=?`, new Date(now - 1_000).toISOString(), String(pass.id));

    // The minute sweep releases the credential but must NOT strand the visitor inside.
    await runMinuteSweep();
    expect(database.one(`SELECT status FROM visitor_requests WHERE id=?`, String(pass.id))?.status).toBe('checked_in');
    expect(database.one(`SELECT device_account_state FROM visitor_requests WHERE id=?`, String(pass.id))?.device_account_state).toBe('removal_queued');

    const scan = await call(env, 'POST', '/api/visitors/scan', {
      token: securityToken,
      body: { code: String(pass.credentialNumber), source: 'manual' },
    });
    expect(scan.json.valid).toBe(false);
    const checkout = await call(env, 'POST', `/api/visitors/${String(pass.id)}/decision`, {
      token: securityToken,
      body: { decision: 'accepted', action: 'out', scanId: String(scan.json.scanId) },
    });
    expect(checkout.status).toBe(200);
    expect(database.one(`SELECT status FROM visitor_requests WHERE id=?`, String(pass.id))?.status).toBe('checked_out');
  });

  it('exposes device-account status and a manual sweep button to operators', async () => {
    addDevice();
    const now = Date.now();
    const live = await issuePass(new Date(now - 60_000), new Date(now + 60 * 60_000));
    const aging = await issuePass(new Date(now - 60_000), new Date(now + 30_000));
    database.run(`UPDATE visitor_requests SET valid_until=? WHERE id=?`, new Date(now - 1_000).toISOString(), String(aging.id));

    const free = await call(env, 'POST', '/api/visitors/release-device-accounts', { token: adminToken });
    expect(free.status).toBe(200);
    expect(free.json.passes).toBe(1);
    expect(String(free.json.notice)).toMatch(/Hardware actions/);

    const status = await call(env, 'GET', '/api/visitors/device-accounts', { token: adminToken });
    expect(status.status).toBe(200);
    const summary = status.json.summary as Record<string, number>;
    expect(summary.active_slots).toBe(1);       // the live pass still holds its slot
    expect(summary.manual_removals).toBe(1);    // no linked agent → operator task
    const items = status.json.items as Array<Record<string, unknown>>;
    expect(items.some((item) => item.id === live.id && item.device_account_state === 'provisioned')).toBe(true);
    expect(items.some((item) => item.id === aging.id && item.device_account_state === 'removal_queued')).toBe(true);
  });
});
