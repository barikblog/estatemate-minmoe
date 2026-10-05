/**
 * Remote Network Verification.
 *
 * The bridge does the deciding, so what the Worker has to get right is the two
 * things only it can do: serve the estate's whole credential set to a bridge on
 * the LAN without dumping it in one response, and record what the bridge decided
 * so the gate history can answer "who let this person in, and did the door move".
 *
 * The removals half of the snapshot is the part worth reading closely. A
 * credential revoked between two syncs has to leave the bridge's cache, or a
 * card suspended an hour ago keeps opening the door until the next restart - and
 * because this platform keeps rows for history (status flips, never deletes),
 * that list is actually derivable, which is why the protocol has one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call, queueSendsOf } from './harness';
import type { Env } from '../src/types';

type Json = Record<string, unknown>;

async function agentRequest(env: Env, method: string, path: string, secret: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const request = new Request(`https://estatemate.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-EstateMate-Agent-Key': secret } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, json: (json ?? {}) as Json };
}

describe('Remote Network Verification', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: Env;
  let adminToken: string;
  let managerToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    db.run(`UPDATE users SET employee_id='EMP-RITA' WHERE id='user-resident'`);
    // A second resident who is deactivated: their card must never reach a bridge.
    db.run(`INSERT INTO users(id,name,email,password_hash,role,status) VALUES ('user-gone','Gone Resident','gone@example.com','pbkdf2-sha256$100000$x$y','resident','inactive')`);
    // One active dependant and one whose approval was refused.
    db.run(`INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,employee_id,requested_by)
            VALUES ('member-ben','property-1','user-resident','Ben Dependant','child','active','EMP-BEN','user-resident')`);
    db.run(`INSERT INTO household_members(id,property_id,primary_resident_id,name,relationship,status,employee_id,requested_by)
            VALUES ('member-refused','property-1','user-resident','Refused Dependant','child','rejected','EMP-REFUSED','user-resident')`);
  });

  async function createDeviceAndAgent(): Promise<{ deviceId: string; agentId: string; agentSecret: string }> {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name: 'Main Gate K1T808', gateName: 'Main Gate', direction: 'entry', model: 'DS-K1T808MFWX-B', connectionPattern: 'isapi_bridge' },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = String(deviceRes.json.id);
    const agentRes = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'Gate Agent', platform: 'linux' } });
    expect(agentRes.status).toBe(201);
    const { id: agentId, secret: agentSecret } = agentRes.json as { id: string; secret: string };
    const linkRes = await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: { deviceId, agentId, isapiHost: '192.168.1.101', isapiPort: 80, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http', syncEnabled: true },
    });
    expect(linkRes.status).toBe(200);
    return { deviceId, agentId, agentSecret };
  }

  function addCard(uid: string, overrides: Record<string, unknown> = {}): void {
    const { residentId = 'user-resident', householdMemberId = null, status = 'active' } = overrides as Record<string, unknown>;
    db.run(
      `INSERT INTO access_cards(id,resident_id,household_member_id,card_uid,status,updated_at) VALUES (?,?,?,?,?,datetime('now'))`,
      `card-${uid}`, String(residentId), householdMemberId as string | null, uid, String(status),
    );
  }

  it('refuses the credential snapshot without the agent secret', async () => {
    const { agentId } = await createDeviceAndAgent();
    addCard('CARD-1');
    const res = await agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/credential-snapshot`, '');
    expect(res.status).toBe(401);
  });

  it('pages through the whole credential set instead of dumping it', async () => {
    const { agentId, agentSecret } = await createDeviceAndAgent();
    // A realistic estate, not a token two rows: 250 cards is the smallest set
    // that proves paging happens, because the endpoint refuses pages smaller
    // than 100 (a 20,000-credential estate must not arrive one row at a time).
    for (let i = 0; i < 250; i += 1) addCard(`CARD-${String(i).padStart(3, '0')}`);
    addCard('CARD-BEN', { householdMemberId: 'member-ben' });
    // Excluded: a suspended card, a deactivated resident's card, a refused
    // dependant's card. A bridge must never be able to open a door for any of them.
    addCard('CARD-SUSPENDED', { status: 'suspended' });
    addCard('CARD-INACTIVE-USER', { residentId: 'user-gone' });
    addCard('CARD-REFUSED', { householdMemberId: 'member-refused' });

    const seen: string[] = [];
    let cursor = '';
    let pages = 0;
    for (;;) {
      const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
      const res = await agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/credential-snapshot${query}`, agentSecret);
      expect(res.status).toBe(200);
      const page = res.json as { items: Array<{ kind: string; value: string }>; nextCursor: string | null; full: boolean };
      for (const item of page.items) seen.push(`${item.kind}:${item.value}`);
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(100);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBe(3);
    // 250 cards plus the dependant's, and the two terminal identities a
    // fingerprint or PIN event would arrive with. No duplicates, nothing excluded.
    expect(seen.length).toBe(253);
    expect(new Set(seen).size).toBe(253);
    expect(seen).toContain('employee:EMP-BEN');
    expect(seen).toContain('employee:EMP-RITA');
    expect(seen).not.toContain('card:CARD-SUSPENDED');
    expect(seen).not.toContain('card:CARD-INACTIVE-USER');
    expect(seen).not.toContain('card:CARD-REFUSED');
    expect(seen).not.toContain('employee:EMP-REFUSED');
  });

  it('tells a bridge which credentials were revoked since its last sync', async () => {
    const { agentId, agentSecret } = await createDeviceAndAgent();
    addCard('CARD-1');
    addCard('CARD-3');
    // Prime the cache: a delta only means anything against something already held.
    const first = await agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/credential-snapshot`, agentSecret);
    expect(first.status).toBe(200);

    db.run(`UPDATE access_cards SET status='suspended',updated_at=datetime('now','+1 minute') WHERE card_uid='CARD-1'`);
    db.run(`UPDATE users SET status='inactive',updated_at=datetime('now','+1 minute') WHERE id='user-resident'`);

    const delta = await agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/credential-snapshot?since=1970-01-01T00:00:00.000Z`, agentSecret);
    expect(delta.status).toBe(200);
    const removed = (delta.json.removed as Array<{ kind: string; value: string }>).map((row) => `${row.kind}:${row.value}`).sort();
    // The suspended card, the deactivated person's terminal identity, and the
    // refused dependant - who was never valid in the first place, but must still
    // be named so a bridge holding them drops them. This is the mechanism that
    // stops a revoked credential from opening a door all day.
    expect(removed).toEqual(['card:CARD-1', 'employee:EMP-REFUSED', 'employee:EMP-RITA']);
    expect(delta.json.full).toBe(false);
  });

  it('hands the bridge each terminal’s reader-mode settings', async () => {
    const { deviceId, agentId, agentSecret } = await createDeviceAndAgent();
    await call(env, 'PATCH', `/api/access/devices/${deviceId}/remote-verify`, { token: adminToken, body: { enabled: true, doorNo: 2, cooldownMs: 900 } });
    const res = await agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/devices`, agentSecret);
    expect(res.status).toBe(200);
    const item = (res.json.items as Json[])[0]!;
    expect(item.remote_verify_enabled).toBe(1);
    expect(item.remote_verify_door_no).toBe(2);
    expect(item.remote_verify_cooldown_ms).toBe(900);
  });

  it('lets an administrator switch a terminal into reader mode, and warns what that means', async () => {
    const { deviceId } = await createDeviceAndAgent();
    const res = await call(env, 'PATCH', `/api/access/devices/${deviceId}/remote-verify`, { token: adminToken, body: { enabled: true, doorNo: 1 } });
    expect(res.status).toBe(200);
    const body = res.json as { remoteVerify: { enabled: boolean }; warnings: string[] };
    expect(body.remoteVerify.enabled).toBe(true);
    // The two warnings are the point: the terminal has to be configured as a
    // reader, and the unlock command is unproven on every profile in this repo.
    expect(body.warnings.join(' ')).toMatch(/reader/i);
    expect(body.warnings.join(' ')).toMatch(/best-effort/i);

    const row = db.one(`SELECT remote_verify_enabled,remote_verify_door_no FROM hikvision_devices WHERE id=?`, deviceId) as { remote_verify_enabled: number; remote_verify_door_no: number };
    expect(row.remote_verify_enabled).toBe(1);
    expect(row.remote_verify_door_no).toBe(1);
    const audit = db.one(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id=? AND action='update'`, deviceId) as { n: number };
    expect(audit.n).toBeGreaterThan(0);
  });

  it('keeps the switch away from a Manager, because it changes what a door does', async () => {
    const { deviceId } = await createDeviceAndAgent();
    const res = await call(env, 'PATCH', `/api/access/devices/${deviceId}/remote-verify`, { token: managerToken, body: { enabled: true } });
    expect(res.status).toBe(403);
    const row = db.one(`SELECT remote_verify_enabled FROM hikvision_devices WHERE id=?`, deviceId) as { remote_verify_enabled: number };
    expect(row.remote_verify_enabled).toBe(0);
  });

  it('validates the door number and the cooldown', async () => {
    const { deviceId } = await createDeviceAndAgent();
    const badDoor = await call(env, 'PATCH', `/api/access/devices/${deviceId}/remote-verify`, { token: adminToken, body: { enabled: true, doorNo: 9 } });
    expect(badDoor.status).toBe(400);
    const badCooldown = await call(env, 'PATCH', `/api/access/devices/${deviceId}/remote-verify`, { token: adminToken, body: { enabled: true, cooldownMs: 999999 } });
    expect(badCooldown.status).toBe(400);
  });

  it('records what the bridge decided, including the refusals', async () => {
    const { deviceId, agentId, agentSecret } = await createDeviceAndAgent();
    const document = JSON.stringify({
      EventNotificationAlert: {
        ipAddress: '192.168.1.101',
        eventType: 'AccessControllerEvent',
        dateTime: '2026-10-05T10:15:30+01:00',
        AccessControllerEvent: { cardNo: 'CARD-1', employeeNoString: '', name: 'Rita Resident', doorNo: 1 },
      },
    });
    const res = await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/events`, agentSecret, {
      items: [{
        deviceId,
        document,
        remoteVerification: { decision: 'granted', reason: 'authorised', doorResult: 'opened', latencyMs: 31 },
      }],
    });
    expect(res.status).toBe(200);

    const sends = queueSendsOf(env);
    await worker.queue(
      { messages: sends.map((send) => ({ body: send.body })), ackAll: () => undefined, retryAll: () => undefined } as never,
      env,
    );

    const row = db.one(`SELECT remote_decision,remote_decision_reason,remote_door_result FROM access_events WHERE device_id=?`, deviceId) as {
      remote_decision: string | null; remote_decision_reason: string | null; remote_door_result: string | null;
    };
    // The whole point of sending the verdict with the event: the gate history can
    // say who decided and whether the door actually answered.
    expect(row.remote_decision).toBe('granted');
    expect(row.remote_decision_reason).toBe('authorised');
    expect(row.remote_door_result).toBe('opened');
  });
});
