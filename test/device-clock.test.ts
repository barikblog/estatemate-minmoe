/**
 * Terminal clock sync, Worker side.
 *
 * The bridge's time-sync check reports each terminal's clock on the heartbeat;
 * the Worker stores it on the device row so the portal can show what time the
 * gate thinks it is. These tests lock down the storage contract:
 *
 * - a reported clock is stored as the bridge reported it (a status surface,
 *   never read back as a decision input);
 * - the write is scoped to the reporting agent's own terminals, like every
 *   other heartbeat write;
 * - a heartbeat without a clock entry leaves the stored value alone — a
 *   bridge built before time sync, or with it switched off, must keep the row
 *   exactly as it was;
 * - an entry that cannot be trusted to display is dropped, not stored.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call } from './harness';
import type { Env } from '../src/types';

async function agentHeartbeat(
  env: Env,
  agentId: string,
  agentSecret: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EstateMate-Agent-Key': agentSecret },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, {
    waitUntil: async () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext);
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, json };
}

describe('Terminal clock sync, Worker side', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: Env;
  let adminToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
  });

  async function createLinkedDevice(): Promise<{ deviceId: string; agentId: string; agentSecret: string }> {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name: 'Main Gate K1T808', gateName: 'Main Gate', direction: 'entry', model: 'DS-K1T808MFWX-B', connectionPattern: 'isapi_bridge' },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = (deviceRes.json as { id: string }).id;

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

  const clockPayload = {
    terminalTime: '2026-10-05T18:14:03.000Z',
    driftMs: 7412,
    lastCheckedAt: '2026-10-05T18:14:03.500Z',
    lastSyncAt: '2026-10-05T15:00:00.000Z',
    syncs: 3,
    lastError: null,
  };

  it('stores a reported clock on the device row and counts it in the response', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedDevice();
    const result = await agentHeartbeat(env, agentId, agentSecret, {
      devices: [{ deviceId, stream: 'up', clock: clockPayload }],
    });
    expect(result.status).toBe(200);
    expect(result.json.terminalClocks).toBe(1);

    const row = db.one(`SELECT device_clock FROM hikvision_devices WHERE id=?`, deviceId);
    expect(row?.device_clock).toBeTruthy();
    expect(JSON.parse(String(row?.device_clock))).toMatchObject(clockPayload);
  });

  it('a clock-only entry is stored without touching presence', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedDevice();
    const before = db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status;

    // No `stream` field at all: the terminal is not being streamed (or the
    // entry exists only to carry the clock). The device row's status must not
    // move, and the clock must still land.
    const result = await agentHeartbeat(env, agentId, agentSecret, {
      devices: [{ deviceId, clock: clockPayload }],
    });
    expect(result.status).toBe(200);
    expect(result.json.terminalClocks).toBe(1);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe(before);
    expect(db.one(`SELECT device_clock FROM hikvision_devices WHERE id=?`, deviceId)?.device_clock).toBeTruthy();
  });

  it('scopes the clock write to the reporting agent\'s own terminals', async () => {
    const { agentId, agentSecret } = await createLinkedDevice();
    const strangerId = '99999999-9999-4999-a999-999999999999';
    db.run(`INSERT INTO hikvision_devices(id,name,vendor,gate_name,direction,profile_key,connection_pattern,status)
            VALUES (?,?,?,?,?, 'access_terminal_8xx', 'isapi_bridge', 'online')`,
      strangerId, 'Stray Gate', 'Hikvision', 'Stray Gate', 'entry');

    const result = await agentHeartbeat(env, agentId, agentSecret, {
      devices: [{ deviceId: strangerId, clock: clockPayload }],
    });
    expect(result.status).toBe(200);
    expect(result.json.terminalClocks).toBe(0);
    expect(db.one(`SELECT device_clock FROM hikvision_devices WHERE id=?`, strangerId)?.device_clock).toBeNull();
  });

  it('a heartbeat without a clock leaves the stored value alone', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedDevice();
    await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up', clock: clockPayload }] });
    const first = db.one(`SELECT device_clock FROM hikvision_devices WHERE id=?`, deviceId)?.device_clock;

    // The next heartbeat reports presence only (a bridge with time sync off
    // never sends the field). The last known clock is what the portal keeps
    // showing, with its lastCheckedAt marking how old it is.
    await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up' }] });
    expect(db.one(`SELECT device_clock FROM hikvision_devices WHERE id=?`, deviceId)?.device_clock).toBe(first);
  });

  it('drops a clock entry that cannot be trusted to display', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedDevice();

    for (const broken of [
      { terminalTime: 'not-a-time', driftMs: 1 },
      { driftMs: 1 },
      { terminalTime: '2026-10-05T18:14:03.000Z' },
      { terminalTime: '2026-10-05T18:14:03.000Z', driftMs: Number.NaN },
    ]) {
      const result = await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, clock: broken }] });
      expect(result.status).toBe(200);
      expect(result.json.terminalClocks).toBe(0);
    }
    expect(db.one(`SELECT device_clock FROM hikvision_devices WHERE id=?`, deviceId)?.device_clock).toBeNull();
  });

  it('exposes the stored clock through the devices API', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedDevice();
    await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up', clock: clockPayload }] });

    const list = await call(env, 'GET', '/api/access/devices', { token: adminToken });
    expect(list.status).toBe(200);
    const device = (list.json.items as Array<Record<string, unknown>>).find((row) => row.id === deviceId);
    expect(JSON.parse(String(device?.device_clock ?? ''))).toMatchObject(clockPayload);
  });
});
