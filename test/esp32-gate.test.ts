/**
 * ESP32 gate controllers (esp32-gate/, src/esp32-gate.ts, migration 0026).
 *
 * The controller is a dedicated device agent, so the Worker's part is: keep it
 * apart from bridges (its config download rotates the secret), hand out the two
 * files it is built from, refuse to rotate anything when there is no single
 * terminal to give it a device ID, and accept the events and heartbeat the
 * sketch actually sends. The event documents below are the host test's
 * fixtures (esp32-gate/host-test/fixtures), byte for byte what
 * `buildEventDocument` in the sketch produces - so the two halves are tested
 * against one contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { ESP32_GATE_SKETCH } from '../src/esp32-gate-sketch';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call, queueSendsOf } from './harness';
import type { Env } from '../src/types';

type Json = Record<string, unknown>;

async function readRepoFile(path: string): Promise<string> {
  const fs = await import(['node:', 'fs'].join('')) as { readFileSync(path: string, encoding: string): string };
  return fs.readFileSync(path, 'utf8');
}

async function agentRequest(env: Env, method: string, path: string, secret: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const request = new Request(`https://estatemate.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-EstateMate-Agent-Key': secret } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json: (json ?? {}) as Json };
}

async function download(env: Env, method: 'GET' | 'POST', path: string, token: string): Promise<{ status: number; text: string; disposition: string | null; json: Json }> {
  const request = new Request(`https://estatemate.test${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const response = await worker.fetch(request, env, { waitUntil: async () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* a file */ }
  return { status: response.status, text, disposition: response.headers.get('Content-Disposition'), json: (json ?? {}) as Json };
}

/** The value of `#define NAME "value"` in a generated secrets.h. */
function defineValue(header: string, name: string): string | null {
  return new RegExp(`#define ${name} "([^"]*)"`).exec(header)?.[1] ?? null;
}

describe('ESP32 gate controller', () => {
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
  });

  async function createEsp32Agent(name = 'Main gate ESP32'): Promise<{ agentId: string; secret: string }> {
    const res = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name, platform: 'esp32' } });
    expect(res.status).toBe(201);
    return { agentId: String(res.json.id), secret: String(res.json.secret) };
  }

  async function registerTerminal(name = 'Main gate ESP32 reader'): Promise<string> {
    const res = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name, gateName: 'Main Gate', direction: 'entry', model: 'ESP32 Wiegand controller', connectionPattern: 'isapi_bridge' },
    });
    expect(res.status).toBe(201);
    return String(res.json.id);
  }

  async function link(deviceId: string, agentId: string, token = adminToken) {
    // No password: the controller never logs in to a terminal.
    return call(env, 'POST', '/api/isapi/device-configs', { token, body: { deviceId, agentId, isapiHost: '192.168.1.77', syncEnabled: true } });
  }

  it('serves the exact sketch the host tests compile', async () => {
    const source = await readRepoFile('esp32-gate/EstateMateGate/EstateMateGate.ino');
    // Regenerate with `npm run build:esp32-sketch` when this fails.
    expect(ESP32_GATE_SKETCH).toBe(source);
  });

  it('creates an ESP32 agent of its own kind, stored without widening the platform list', async () => {
    const { agentId } = await createEsp32Agent();
    const row = db.one(`SELECT platform,agent_kind FROM isapi_agents WHERE id=?`, agentId);
    expect(row).toEqual({ platform: 'other', agent_kind: 'esp32' });
    const list = await call(env, 'GET', '/api/isapi/agents', { token: managerToken });
    const item = (list.json.items as Json[]).find((agent) => agent.id === agentId)!;
    expect(item.agent_kind).toBe('esp32');
    const bridge = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'Office PC', platform: 'windows' } });
    expect(db.one(`SELECT agent_kind FROM isapi_agents WHERE id=?`, String(bridge.json.id))?.agent_kind).toBe('bridge');
    expect((await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'x', platform: 'arduino' } })).status).toBe(400);
  });

  it('refuses a bridge setup file for an ESP32 agent without rotating its secret', async () => {
    const { agentId, secret } = await createEsp32Agent();
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/installer`, adminToken);
    expect(res.status).toBe(409);
    expect(String(res.json.error)).toMatch(/ESP32 sketch/);
    expect((await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, secret, {})).status).toBe(200);
  });

  it('hands the sketch to Administrators and Managers, with no secret in it', async () => {
    const { agentId, secret } = await createEsp32Agent('Gate "A" */ ESP32');
    for (const token of [adminToken, managerToken]) {
      const res = await download(env, 'GET', `/api/isapi/agents/${agentId}/esp32-sketch`, token);
      expect(res.status).toBe(200);
      expect(res.disposition).toBe('attachment; filename="EstateMateGate.ino"');
      expect(res.text.endsWith(ESP32_GATE_SKETCH)).toBe(true);
      expect(res.text).toContain(agentId);
      expect(res.text).not.toContain(secret);
      // An agent name cannot close the banner's comment or break out of it.
      expect(res.text.split('\n').slice(0, 3).join('\n')).not.toMatch(/"Gate "A" \*\//);
    }
    // Only ESP32 agents get one.
    const bridge = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'Office PC', platform: 'windows' } });
    expect((await download(env, 'GET', `/api/isapi/agents/${String(bridge.json.id)}/esp32-sketch`, adminToken)).status).toBe(409);
  });

  it('explains a missing terminal instead of rotating the secret', async () => {
    const { agentId, secret } = await createEsp32Agent();
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/esp32-config`, adminToken);
    expect(res.status).toBe(200);
    expect(res.disposition).toBe('attachment; filename="secrets.h"');
    expect(res.text).toMatch(/^#error "No terminal is connected to this ESP32 agent yet/m);
    expect(res.text).toMatch(/never dials it/);
    expect(res.text).not.toContain('ESTATEMATE_AGENT_SECRET');
    // The controller already in the field keeps working.
    expect((await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, secret, {})).status).toBe(200);
  });

  it('writes a working config for the one linked terminal and rotates the secret', async () => {
    const { agentId, secret: oldSecret } = await createEsp32Agent();
    const deviceId = await registerTerminal();
    expect((await link(deviceId, agentId)).status).toBe(200);

    expect((await download(env, 'POST', `/api/isapi/agents/${agentId}/esp32-config`, managerToken)).status).toBe(403);
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/esp32-config`, adminToken);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/^#error/m);
    expect(res.text).toContain('#define ESTATEMATE_CONFIG_VERSION 1');
    expect(res.text).toContain('#define ESTATEMATE_WIFI_CONFIGURED 0');
    expect(defineValue(res.text, 'ESTATEMATE_WORKER_URL')).toBe('https://estatemate.test');
    expect(defineValue(res.text, 'ESTATEMATE_AGENT_ID')).toBe(agentId);
    expect(defineValue(res.text, 'ESTATEMATE_DEVICE_ID')).toBe(deviceId);
    const newSecret = defineValue(res.text, 'ESTATEMATE_AGENT_SECRET')!;
    expect(newSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(newSecret).not.toBe(oldSecret);

    // The old secret is gone; the one in the file is what the board signs in with.
    expect((await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, oldSecret, {})).status).toBe(401);
    const heartbeat = await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, newSecret, {
      version: 'esp32-gate-1.0.0', hostname: 'estatemate-gate-c3d4e5', capabilities: [],
      devices: [{ deviceId, stream: 'up' }],
      remoteVerify: { enabled: true, controller: 'esp32', cache: { credentialCount: 2, cacheAgeSeconds: 5, lastSyncError: null }, perDevice: { [deviceId]: { lastDecision: 'granted', lastReason: 'authorised', lastResult: 'opened' } } },
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.json.terminalsOnline).toBe(1);
    const device = db.one(`SELECT status,remote_verify_state FROM hikvision_devices WHERE id=?`, deviceId);
    expect(device?.status).toBe('online');
    expect(JSON.parse(String(device?.remote_verify_state)).cache.credentialCount).toBe(2);
    const agent = db.one(`SELECT status,capabilities,version FROM isapi_agents WHERE id=?`, agentId);
    expect(agent?.status).toBe('online');
    expect(agent?.version).toBe('esp32-gate-1.0.0');
  });

  it('keeps an ESP32 agent to one terminal', async () => {
    const { agentId } = await createEsp32Agent();
    const first = await registerTerminal('Gate A');
    const second = await registerTerminal('Gate B');
    expect((await link(first, agentId)).status).toBe(200);
    // Re-saving the same link is fine; a second terminal is not.
    expect((await link(first, agentId, managerToken)).status).toBe(200);
    const refused = await link(second, agentId);
    expect(refused.status).toBe(409);
    expect(String(refused.json.error)).toMatch(/already serves Gate A/);
    // A config made while several are linked (e.g. from before this rule) is a
    // file that refuses to compile, not a guess.
    db.run(`INSERT INTO isapi_device_configs(id,device_id,agent_id,isapi_host,isapi_port,sync_enabled) VALUES ('cfg-legacy',?,?,'192.168.1.78',80,1)`, second, agentId);
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/esp32-config`, adminToken);
    expect(res.text).toMatch(/^#error "Several terminals/m);
    expect(res.text).toContain('Gate A');
    expect(res.text).toContain('Gate B');
  });

  it('accepts the events the sketch sends and files them as gate history', async () => {
    const { agentId } = await createEsp32Agent();
    const deviceId = await registerTerminal();
    await link(deviceId, agentId);
    const config = await download(env, 'POST', `/api/isapi/agents/${agentId}/esp32-config`, adminToken);
    const secret = defineValue(config.text, 'ESTATEMATE_AGENT_SECRET')!;

    const fixture = async (name: string) => (await readRepoFile(`esp32-gate/host-test/fixtures/${name}`)).trim();
    const items = [
      { deviceId, contentType: 'application/json', document: await fixture('event-card-granted.json'), remoteVerification: { decision: 'granted', reason: 'authorised', doorResult: 'opened' } },
      { deviceId, contentType: 'application/json', document: await fixture('event-card-denied.json'), remoteVerification: { decision: 'denied', reason: 'unknown_credential', doorResult: 'not_attempted' } },
      { deviceId, contentType: 'application/json', document: await fixture('event-pin-granted.json'), remoteVerification: { decision: 'granted', reason: 'authorised', doorResult: 'opened' } },
      { deviceId, contentType: 'application/json', document: await fixture('event-exit.json') },
    ];
    const res = await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/events`, secret, { items });
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(4);
    expect(res.json.rejected).toBe(0);

    const sends = queueSendsOf(env);
    const batch = (sends[0]!.body as { batch: Json[] }).batch;
    const [granted, denied, pin, exit] = batch;
    expect(granted).toMatchObject({ deviceId, cardUid: '77881', credentialType: 'card', result: 'granted', direction: 'entry', vendorEventId: '5eed1234-1', remoteDecision: 'granted', remoteDoorResult: 'opened' });
    expect(granted!.deviceTimestamp).toBe('2026-10-10T08:15:00.000Z');
    expect(denied).toMatchObject({ cardUid: '99999999', result: 'denied', remoteDecision: 'denied', remoteDecisionReason: 'unknown_credential', remoteDoorResult: 'not_attempted' });
    expect(pin).toMatchObject({ cardUid: null, employeeNo: 'visitorV12345', credentialType: 'pin', result: 'granted' });
    expect(exit).toMatchObject({ cardUid: null, employeeNo: null, credentialType: null, result: 'granted', direction: 'exit' });
  });

  it('queues portal door commands for the controller to pick up', async () => {
    const { agentId } = await createEsp32Agent();
    const deviceId = await registerTerminal();
    await link(deviceId, agentId);
    const config = await download(env, 'POST', `/api/isapi/agents/${agentId}/esp32-config`, adminToken);
    const secret = defineValue(config.text, 'ESTATEMATE_AGENT_SECRET')!;
    const queued = await call(env, 'POST', '/api/access/remote/door', { token: adminToken, body: { deviceId, command: 'remote_open', doorNo: 1, reason: 'Delivery at the gate' } });
    expect(queued.status).toBe(201);
    expect(queued.json.status).toBe('pending');
    const poll = await agentRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/operations?limit=10`, secret);
    const op = (poll.json.items as Json[])[0]!;
    expect(op).toMatchObject({ kind: 'door', deviceId, operation: 'remote_open' });
    expect((op.payload as Json).doorNo).toBe(1);
    const result = await agentRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/operations/${String(op.id)}/result`, secret, { kind: 'door', status: 'applied', durationMs: 4 });
    expect(result.status).toBe(200);
    expect(db.one(`SELECT status FROM device_operations WHERE id=?`, String(op.id))?.status).toBe('applied');
  });
});
