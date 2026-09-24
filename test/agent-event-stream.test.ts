/**
 * Real-time agent event streaming (ISAPI alertStream bridge), queue batching
 * and free-tier retention pruning.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call, queueSendsOf, liveBroadcastsOf } from './harness';
import type { Env } from '../src/types';

function eventDocument(cardNo: string, when = '2026-09-24T10:15:30+01:00'): string {
  return JSON.stringify({
    EventNotificationAlert: {
      ipAddress: '192.168.1.101',
      eventType: 'AccessControllerEvent',
      eventState: 'active',
      eventDescription: 'accessAllowed',
      dateTime: when,
      AccessControllerEvent: {
        cardNo,
        employeeNoString: '1001',
        name: 'Rita Resident',
        currentVerifyMode: 'card',
        doorNo: 1,
      },
    },
  });
}

describe('Agent event streaming and queue batching', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let env: Env;
  let adminToken: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    const estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
  });

  async function createDeviceAndAgent(): Promise<{ deviceId: string; agentId: string; agentSecret: string }> {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: {
        name: 'Main Gate K1T808',
        gateName: 'Main Gate',
        direction: 'entry',
        model: 'DS-K1T808MFWX-B',
        connectionPattern: 'isapi_bridge',
      },
    });
    expect(deviceRes.status).toBe(201);
    const deviceId = (deviceRes.json as { id: string }).id;

    const agentRes = await call(env, 'POST', '/api/isapi/agents', {
      token: adminToken,
      body: { name: 'Gate Agent', platform: 'linux' },
    });
    expect(agentRes.status).toBe(201);
    const { id: agentId, secret: agentSecret } = agentRes.json as { id: string; secret: string };

    const linkRes = await call(env, 'POST', '/api/isapi/device-configs', {
      token: adminToken,
      body: {
        deviceId,
        agentId,
        isapiHost: '192.168.1.101',
        isapiPort: 80,
        isapiUsername: 'admin',
        isapiPassword: 'device-password',
        protocol: 'http',
        syncEnabled: true,
      },
    });
    expect(linkRes.status).toBe(200);
    return { deviceId, agentId, agentSecret };
  }

  async function callAgentEventsRaw(
  env: Env,
  agentId: string,
  agentSecret: string,
  items: unknown[],
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const request = new Request(`https://estatemate.test/api/isapi/v1/agents/${agentId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EstateMate-Agent-Key': agentSecret },
    body: JSON.stringify({ items }),
  });
  const response = await worker.fetch(request, env, { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, json: (json ?? {}) as Record<string, unknown>, text };
}

  it('requires the agent secret', async () => {
    const { agentId } = await createDeviceAndAgent();
    const res = await callAgentEventsRaw(env, agentId, 'wrong-secret-aaaaaaaaaaaa', []);
    expect(res.status).toBe(401);
  });

  it('normalizes a batch of alertStream events and queues them as one message', async () => {
    const { deviceId, agentId, agentSecret } = await createDeviceAndAgent();
    const res = await callAgentEventsRaw(env, agentId, agentSecret, [
      { deviceId, document: eventDocument('12345678') },
      { deviceId, document: eventDocument('87654321') },
      { deviceId, document: eventDocument('11223344') },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(3);
    expect(res.json.rejected).toBe(0);

    const sends = queueSendsOf(env);
    expect(sends.length).toBe(1);
    expect(sends[0]!.kind).toBe('send');
    const payload = sends[0]!.body as { batch: Array<{ deviceId: string; cardUid: string | null; credentialType: string | null }> };
    expect(payload.batch.length).toBe(3);
    expect(payload.batch[0]!.cardUid).toBe('12345678');
    expect(payload.batch[0]!.credentialType).toBe('card');
    expect(payload.batch[0]!.deviceId).toBe(deviceId);

    const device = db.one(`SELECT status,last_seen_at FROM hikvision_devices WHERE id=?`, deviceId);
    expect(device?.status).toBe('online');
    expect(device?.last_seen_at).toBeTruthy();
  });

  it('consumer persists flattened batches and broadcasts them to the live feed', async () => {
    const { deviceId, agentId, agentSecret } = await createDeviceAndAgent();
    await callAgentEventsRaw(env, agentId, agentSecret, [
      { deviceId, document: eventDocument('12345678') },
      { deviceId, document: eventDocument('87654321') },
    ]);
    const sends = queueSendsOf(env);
    expect(sends.length).toBe(1);
    const payload = sends[0]!.body;

    await worker.queue(
      { messages: [{ body: payload }], ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<import('../src/types').AccessEventQueuePayload>,
      env,
    );
    const rows = db.query(`SELECT card_uid,device_id FROM access_events ORDER BY card_uid`, );
    expect(rows.length).toBe(2);
    expect(rows[0]!.card_uid).toBe('12345678');
    expect(rows[1]!.card_uid).toBe('87654321');
    const broadcast = liveBroadcastsOf(env);
    expect(broadcast.length).toBe(1);
    expect((broadcast[0] as { events: unknown[] }).events.length).toBe(2);
  });

  it('consumer still accepts legacy single-event messages', async () => {
    const { deviceId, agentId, agentSecret } = await createDeviceAndAgent();
    await callAgentEventsRaw(env, agentId, agentSecret, [{ deviceId, document: eventDocument('12345678') }]);
    const body = queueSendsOf(env)[0]!.body;
    await worker.queue(
      { messages: [{ body }], ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<import('../src/types').AccessEventQueuePayload>,
      env,
    );
    expect(db.query(`SELECT id FROM access_events`).length).toBe(1);
  });

  it('rejects documents for devices not linked to this agent', async () => {
    const { deviceId: deviceA, agentId: agentA, agentSecret: secretA } = await createDeviceAndAgent();
    const other = await createDeviceAndAgent();
    const before = queueSendsOf(env).length;

    const res = await callAgentEventsRaw(env, agentA, secretA, [
      { deviceId: other.deviceId, document: eventDocument('99999999') },
      { deviceId: deviceA, document: eventDocument('12345678') },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(1);
    expect(res.json.rejected).toBe(1);
    expect(queueSendsOf(env).length).toBe(before + 1);
  });

  it('rejects oversized batches with 413', async () => {
    const { deviceId, agentId, agentSecret } = await createDeviceAndAgent();
    const items = Array.from({ length: 51 }, () => ({ deviceId, document: eventDocument('1') }));
    const res = await callAgentEventsRaw(env, agentId, agentSecret, items);
    expect(res.status).toBe(413);
  });

  it('honours the agent_event_stream_enabled kill switch', async () => {
    const { agentId, agentSecret } = await createDeviceAndAgent();
    const put = await call(env, 'PUT', '/api/settings/agent_event_stream_enabled', { token: adminToken, body: { value: 'false' } });
    expect(put.status).toBe(200);
    const res = await callAgentEventsRaw(env, agentId, agentSecret, [{ deviceId: 'x', document: '{}' }]);
    expect(res.status).toBe(409);
  });

  it('hourly schedule prunes events older than the retention setting', async () => {
    const deviceRes = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name: 'Prune Gate', gateName: 'Prune Gate', direction: 'entry', model: 'DS-K1T808MFWX-B' },
    });
    const deviceId = (deviceRes.json as { id: string }).id;
    const oldIso = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const recentIso = new Date(Date.now() - 10 * 86_400_000).toISOString();
    db.run(
      `INSERT INTO access_events(id,vendor_event_id,device_id,direction,result,event_type,device_timestamp,profile_key) VALUES (?,?,?,?,?,?,?,?)`,
      'evt-old', 'old-1', deviceId, 'entry', 'unknown', 'access', oldIso, 'access_terminal_8xx',
    );
    db.run(
      `INSERT INTO access_events(id,vendor_event_id,device_id,direction,result,event_type,device_timestamp,profile_key) VALUES (?,?,?,?,?,?,?,?)`,
      'evt-new', 'new-1', deviceId, 'entry', 'unknown', 'access', recentIso, 'access_terminal_8xx',
    );

    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledEvent, env, {
      waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
    } as unknown as ExecutionContext);
    await Promise.all(waits);

    const remaining = db.query(`SELECT id FROM access_events`);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe('evt-new');
  });
});
