/**
 * Presence correctness for agents and their terminals.
 *
 * Both statuses used to be lagging flags: a stored 'online' survived until the
 * hourly cron ran one UPDATE, agents were never swept at all, and a NULL
 * last_seen_at made the sweep's `last_seen_at < ...` comparison NULL (not true),
 * pinning a terminal to online forever. These tests lock down the behaviour that
 * replaced it: reads derive the status, the sweep handles missing proof of life,
 * and an agent reporting a dead event stream retires the terminal immediately.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call } from './harness';
import type { Env } from '../src/types';

async function runScheduled(env: Env): Promise<void> {
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledEvent, env, {
    waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
  } as unknown as ExecutionContext);
  await Promise.all(waits);
}

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

describe('Agent and terminal presence', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: Env;
  let adminToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
  });

  async function createLinkedPair(): Promise<{ deviceId: string; agentId: string; agentSecret: string }> {
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

  it('a heartbeat marks the agent online and the list reports it', async () => {
    const { agentId, agentSecret } = await createLinkedPair();
    expect((await agentHeartbeat(env, agentId, agentSecret, { hostname: 'OFFICE-PC' })).status).toBe(200);

    const list = await call(env, 'GET', '/api/isapi/agents', { token: adminToken });
    const agent = (list.json.items as Array<Record<string, unknown>>).find((row) => row.id === agentId);
    expect(agent?.status).toBe('online');
    expect(agent?.last_seen_at).toBeTruthy();
  });

  it('an agent that stopped heartbeating reads as offline even before the sweep runs', async () => {
    const { agentId, agentSecret } = await createLinkedPair();
    await agentHeartbeat(env, agentId, agentSecret);
    // The host died: no further heartbeats, and the hourly cron has not run.
    db.run(`UPDATE isapi_agents SET last_seen_at=datetime('now','-25 minutes') WHERE id=?`, agentId);

    const list = await call(env, 'GET', '/api/isapi/agents', { token: adminToken });
    const agent = (list.json.items as Array<Record<string, unknown>>).find((row) => row.id === agentId);
    expect(agent?.status).toBe('offline');
    expect(agent?.stored_status).toBe('online'); // the sweep will persist it

    const detail = await call(env, 'GET', `/api/isapi/agents/${agentId}`, { token: adminToken });
    expect((detail.json.agent as Record<string, unknown>).status).toBe('offline');
  });

  it('a terminal whose last event aged out reads as offline', async () => {
    const { deviceId } = await createLinkedPair();
    await db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now','-45 minutes') WHERE id=?`, deviceId);

    const list = await call(env, 'GET', '/api/access/devices', { token: adminToken });
    const device = (list.json.items as Array<Record<string, unknown>>).find((row) => row.id === deviceId);
    expect(device?.status).toBe('offline');

    const configs = await call(env, 'GET', '/api/isapi/device-configs', { token: adminToken });
    const config = (configs.json.items as Array<Record<string, unknown>>).find((row) => row.device_id === deviceId);
    expect(config?.device_status).toBe('offline');
  });

  it('a terminal marked online without ever forwarding an event is not pinned online', async () => {
    const { deviceId } = await createLinkedPair();
    // last_seen_at stays NULL: `NULL < x` is NULL, which the old sweep treated
    // as "still fresh" and left the device online indefinitely.
    db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=NULL WHERE id=?`, deviceId);

    const before = await call(env, 'GET', '/api/access/devices', { token: adminToken });
    const beforeRow = (before.json.items as Array<Record<string, unknown>>).find((row) => row.id === deviceId);
    expect(beforeRow?.status).toBe('offline');

    await runScheduled(env);
    const after = db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId);
    expect(after?.status).toBe('offline');
  });

  it('hourly sweep retires both a silent agent and a stale terminal', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    await agentHeartbeat(env, agentId, agentSecret);
    db.run(`UPDATE isapi_agents SET last_seen_at=datetime('now','-30 minutes') WHERE id=?`, agentId);
    db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now','-2 hours') WHERE id=?`, deviceId);

    await runScheduled(env);

    expect(db.one(`SELECT status FROM isapi_agents WHERE id=?`, agentId)?.status).toBe('offline');
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('offline');
  });

  it('an agent reporting a dead event stream retires the terminal immediately', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now') WHERE id=?`, deviceId);

    const res = await agentHeartbeat(env, agentId, agentSecret, {
      devices: [{ deviceId, stream: 'down', lastError: 'connect ECONNREFUSED 192.168.1.101:80' }],
    });
    expect(res.status).toBe(200);
    expect(res.json.terminalsOffline).toBe(1);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('offline');

    // One audit row per transition, not one per heartbeat.
    await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'down' }] });
    const logs = db.query(`SELECT operation_type,status FROM isapi_sync_logs WHERE device_id=? AND operation_type='event_stream'`, deviceId);
    expect(logs.length).toBe(1);
    expect(logs[0]!.status).toBe('failed');
  });

  it('a terminal holding an open event stream goes online instead of sitting on pending', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    // Registration default: nothing has proved this terminal is alive yet.
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('pending');

    const res = await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up' }] });
    expect(res.status).toBe(200);
    expect(res.json.terminalsOnline).toBe(1);
    expect(res.json.terminalsOffline).toBe(0);
    const row = db.one(`SELECT status,last_seen_at FROM hikvision_devices WHERE id=?`, deviceId);
    expect(row?.status).toBe('online');
    expect(row?.last_seen_at).toBeTruthy();

    // The same verdict reaches both portal surfaces.
    const list = await call(env, 'GET', '/api/access/devices', { token: adminToken });
    const device = (list.json.items as Array<Record<string, unknown>>).find((item) => item.id === deviceId);
    expect(device?.status).toBe('online');
    const configs = await call(env, 'GET', '/api/isapi/device-configs', { token: adminToken });
    const config = (configs.json.items as Array<Record<string, unknown>>).find((item) => item.device_id === deviceId);
    expect(config?.device_status).toBe('online');

    // One audit row per transition, not one per heartbeat.
    await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up' }] });
    const logs = db.query(`SELECT operation_type,status FROM isapi_sync_logs WHERE device_id=? AND operation_type='event_stream'`, deviceId);
    expect(logs.length).toBe(1);
    expect(logs[0]!.status).toBe('success');
  });

  it('an unproven terminal whose stream is down reads offline, not pending', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('pending');

    const res = await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'down', lastError: 'connect ETIMEDOUT' }] });
    expect(res.json.terminalsOffline).toBe(1);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('offline');
  });

  it('a terminal that stops reporting after a live stream falls back to offline', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up' }] });
    // The agent died: the last proof of life ages past the 10-minute window.
    db.run(`UPDATE hikvision_devices SET last_seen_at=datetime('now','-45 minutes') WHERE id=?`, deviceId);

    const list = await call(env, 'GET', '/api/access/devices', { token: adminToken });
    const device = (list.json.items as Array<Record<string, unknown>>).find((item) => item.id === deviceId);
    expect(device?.status).toBe('offline');
  });

  it('a healthy terminal is left alone and another agent cannot retire it', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now') WHERE id=?`, deviceId);

    const healthy = await agentHeartbeat(env, agentId, agentSecret, { devices: [{ deviceId, stream: 'up' }] });
    expect(healthy.json.terminalsOffline).toBe(0);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('online');

    // A second agent that has no link to this terminal must not be able to
    // retire it by reporting a stream state for someone else's device id.
    const other = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'Other Agent', platform: 'windows' } });
    const otherAgent = other.json as { id: string; secret: string };
    const hostile = await agentHeartbeat(env, otherAgent.id, otherAgent.secret, { devices: [{ deviceId, stream: 'down' }] });
    expect(hostile.json.terminalsOffline).toBe(0);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('online');

    // Nor to claim the terminal is alive: an unlinked agent cannot promote it.
    db.run(`UPDATE hikvision_devices SET status='pending',last_seen_at=NULL WHERE id=?`, deviceId);
    const claim = await agentHeartbeat(env, otherAgent.id, otherAgent.secret, { devices: [{ deviceId, stream: 'up' }] });
    expect(claim.json.terminalsOnline).toBe(0);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('pending');
  });

  it('deleting an agent retires the terminals it was serving', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    await agentHeartbeat(env, agentId, agentSecret);
    db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now') WHERE id=?`, deviceId);

    const del = await call(env, 'DELETE', `/api/isapi/agents/${agentId}`, { token: adminToken });
    expect(del.status).toBe(200);
    expect(db.one(`SELECT status FROM hikvision_devices WHERE id=?`, deviceId)?.status).toBe('offline');
  });

  it('disconnecting a terminal retires it while keeping its history intact', async () => {
    const { deviceId, agentId, agentSecret } = await createLinkedPair();
    await agentHeartbeat(env, agentId, agentSecret);
    db.run(`UPDATE hikvision_devices SET status='online',last_seen_at=datetime('now') WHERE id=?`, deviceId);
    const configId = db.one(`SELECT id FROM isapi_device_configs WHERE device_id=?`, deviceId)?.id as string;

    const del = await call(env, 'DELETE', `/api/isapi/device-configs/${configId}`, { token: adminToken });
    expect(del.status).toBe(200);
    const row = db.one(`SELECT status,isapi_agent_id,deleted_at FROM hikvision_devices WHERE id=?`, deviceId);
    expect(row?.status).toBe('offline');
    expect(row?.isapi_agent_id).toBeNull();
    expect(row?.deleted_at ?? null).toBeNull(); // soft-delete is a separate action
  });
});
