/**
 * Raspberry Pi agents: a Pi running the LAN bridge, and a Pi that is the gate
 * (pi-gate/, src/pi-bridge-setup.ts, src/pi-gate.ts, migration 0027).
 *
 * Two new "Runs on" choices, both stored without widening the `platform` CHECK
 * (0026 fixed `agent_kind` to 'bridge'/'esp32', so 0027 adds `agent_kind_ext`):
 *
 *   Raspberry Pi (bridge)          platform linux, agent_kind bridge,     ext pi_bridge
 *   Raspberry Pi gate controller   platform other, agent_kind bridge,     ext pi_gate
 *
 * The rules the ESP32 controller got must hold for every controller kind, so
 * most of what is asserted here is the same rule twice: a bridge installer is
 * refused before anything rotates, both roles may download the program (it has
 * no secret), only an Administrator may download the config, and the config
 * rotates only when exactly one terminal is linked. The event documents are the
 * ESP32 host test's fixtures, byte for byte, because one gate controller is not
 * allowed to speak a different protocol from the other.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { PI_GATE_PROGRAM } from '../src/pi-gate-program';
import { PI_BRIDGE_SERVICE_NAME } from '../src/pi-bridge-setup';
import { createTestDatabase, createTestEnv, seedEstate, tokenFor, call, queueSendsOf } from './harness';
import type { Env } from '../src/types';

type Json = Record<string, unknown>;

async function readRepoFile(path: string): Promise<string> {
  const fs = await import(['node:', 'fs'].join('')) as { readFileSync(path: string, encoding: string): string };
  return fs.readFileSync(path, 'utf8');
}

async function nodeRequest(env: Env, method: string, path: string, secret: string, body?: unknown): Promise<{ status: number; json: Json }> {
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

describe('Raspberry Pi agents', () => {
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

  async function createAgent(platform: string, name: string): Promise<{ agentId: string; secret: string }> {
    const res = await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name, platform } });
    expect(res.status).toBe(201);
    return { agentId: String(res.json.id), secret: String(res.json.secret) };
  }

  async function registerTerminal(name = 'Side gate Pi reader'): Promise<string> {
    const res = await call(env, 'POST', '/api/access/devices', {
      token: adminToken,
      body: { name, gateName: 'Side Gate', direction: 'entry', model: 'Raspberry Pi Wiegand controller', connectionPattern: 'isapi_bridge' },
    });
    expect(res.status).toBe(201);
    return String(res.json.id);
  }

  async function link(deviceId: string, agentId: string, token = adminToken) {
    return call(env, 'POST', '/api/isapi/device-configs', { token, body: { deviceId, agentId, isapiHost: '192.168.1.60', syncEnabled: true } });
  }

  it('serves the exact controller program and systemd unit the host tests run', async () => {
    const source = await readRepoFile('pi-gate/EstateMateGate.mjs');
    // Regenerate with `npm run build:pi-gate` when this fails.
    expect(PI_GATE_PROGRAM).toBe(source);
    // The unit shipped in the repository is the one the program renders itself,
    // so the Pi can print its own service file and get the same text.
    const gate = await import(/* @vite-ignore */ ['..', 'pi-gate', 'EstateMateGate.mjs'].join('/')) as {
      renderSystemdUnit(options?: { node?: string; program?: string; config?: string }): string;
    };
    expect(await readRepoFile('pi-gate/systemd/estatemate-pi-gate.service')).toBe(gate.renderSystemdUnit());
    expect(gate.renderSystemdUnit()).toContain(`StateDirectory=${PI_BRIDGE_SERVICE_NAME.replace('-isapi-agent', '-pi-gate')}`);
  });

  it('records both Raspberry Pi choices without touching the platform or agent_kind checks', async () => {
    const bridge = await createAgent('pi_bridge', 'Gate Pi bridge');
    const gate = await createAgent('pi_gate', 'Side gate Pi');
    expect(db.one(`SELECT platform,agent_kind,agent_kind_ext FROM isapi_agents WHERE id=?`, bridge.agentId))
      .toEqual({ platform: 'linux', agent_kind: 'bridge', agent_kind_ext: 'pi_bridge' });
    expect(db.one(`SELECT platform,agent_kind,agent_kind_ext FROM isapi_agents WHERE id=?`, gate.agentId))
      .toEqual({ platform: 'other', agent_kind: 'bridge', agent_kind_ext: 'pi_gate' });

    // An ordinary bridge keeps reading back as a bridge, ext column and all.
    const plain = await createAgent('windows', 'Office PC');
    const list = await call(env, 'GET', '/api/isapi/agents', { token: managerToken });
    const kinds = Object.fromEntries((list.json.items as Json[]).map((agent) => [agent.id, agent.agent_kind]));
    expect(kinds[bridge.agentId]).toBe('pi_bridge');
    expect(kinds[gate.agentId]).toBe('pi_gate');
    expect(kinds[plain.agentId]).toBe('bridge');
    expect((await call(env, 'POST', '/api/isapi/agents', { token: adminToken, body: { name: 'x', platform: 'raspberry' } })).status).toBe(400);
  });

  it('refuses a bridge setup file for the Pi controller without rotating its secret', async () => {
    const { agentId, secret } = await createAgent('pi_gate', 'Side gate Pi');
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/installer`, adminToken);
    expect(res.status).toBe(409);
    expect(String(res.json.error)).toMatch(/Raspberry Pi gate controller/);
    expect(String(res.json.error)).toMatch(/Download Pi gate program/);
    expect((await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, secret, {})).status).toBe(200);
  });

  it('hands the program to both roles and the config to Administrators only', async () => {
    const { agentId, secret: oldSecret } = await createAgent('pi_gate', 'Gate "A" */ Pi');
    const deviceId = await registerTerminal();
    expect((await link(deviceId, agentId)).status).toBe(200);

    for (const token of [adminToken, managerToken]) {
      const res = await download(env, 'GET', `/api/isapi/agents/${agentId}/pi-gate-program`, token);
      expect(res.status).toBe(200);
      expect(res.disposition).toBe('attachment; filename="EstateMateGate.mjs"');
      expect(res.text.endsWith(PI_GATE_PROGRAM)).toBe(true);
      expect(res.text).toContain(agentId);
      expect(res.text).not.toContain(oldSecret);
    }

    // The config carries the secret: Administrator-only, like every rotation.
    expect((await download(env, 'POST', `/api/isapi/agents/${agentId}/pi-gate-config`, managerToken)).status).toBe(403);
    const config = await download(env, 'POST', `/api/isapi/agents/${agentId}/pi-gate-config`, adminToken);
    expect(config.status).toBe(200);
    expect(config.disposition).toBe('attachment; filename="estatemate-gate.json"');
    const parsed = JSON.parse(config.text) as Json;
    expect(parsed.workerUrl).toBe('https://estatemate.test');
    expect(parsed.agentId).toBe(agentId);
    expect(parsed.deviceId).toBe(deviceId);
    expect(parsed.doorNo).toBe(1);
    expect(parsed.stateDir).toBe('/var/lib/estatemate-pi-gate');
    expect(parsed.gpio).toMatchObject({ backend: 'libgpiod', wiegandD0: 17, wiegandD1: 18, relay: 25, exitButton: 27 });
    const newSecret = String(parsed.agentSecret);
    expect(newSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(newSecret).not.toBe(oldSecret);

    // The old secret is gone; the one in the file is what the Pi signs in with.
    expect((await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, oldSecret, {})).status).toBe(401);
    const heartbeat = await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, newSecret, {
      version: 'pi-gate-1.0.0', hostname: 'estatemate-gate-abc123', ip: '192.168.1.60', capabilities: [],
      devices: [{ deviceId, stream: 'up' }],
      remoteVerify: {
        enabled: true, controller: 'pi-gate',
        cache: { credentialCount: 3, capacity: 100000, ready: true, syncCount: 1, lastSyncError: null, cacheAgeSeconds: 4 },
        perDevice: { [deviceId]: { lastDecision: 'granted', lastReason: 'authorised', lastResult: 'opened', doorMode: 'normal' } },
      },
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.json.terminalsOnline).toBe(1);
    const row = db.one(`SELECT status,remote_verify_state FROM hikvision_devices WHERE id=?`, deviceId);
    expect(row?.status).toBe('online');
    const stored = JSON.parse(String(row?.remote_verify_state)) as { cache: Json; lastDecision: string };
    expect(stored.cache.credentialCount).toBe(3);
    expect(stored.lastDecision).toBe('granted');
    expect(db.one(`SELECT version FROM isapi_agents WHERE id=?`, agentId)?.version).toBe('pi-gate-1.0.0');
  });

  it('explains the missing terminal instead of rotating anything', async () => {
    const { agentId, secret } = await createAgent('pi_gate', 'Side gate Pi');
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/pi-gate-config`, adminToken);
    expect(res.status).toBe(200);
    expect(res.disposition).toBe('attachment; filename="estatemate-gate.json"');
    const parsed = JSON.parse(res.text) as Json;
    expect(String(parsed.error)).toMatch(/No terminal is connected/);
    expect(parsed.secretRotated).toBe(false);
    expect(parsed.agentSecret).toBeUndefined();
    expect(res.text).not.toContain(secret);
    // The controller already in the field keeps working.
    expect((await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, secret, {})).status).toBe(200);
  });

  it('refuses to guess between several terminals, and keeps the Pi controller to one', async () => {
    const { agentId, secret } = await createAgent('pi_gate', 'Side gate Pi');
    const first = await registerTerminal('Gate A');
    const second = await registerTerminal('Gate B');
    expect((await link(first, agentId)).status).toBe(200);
    // Re-saving the same link is fine; a second terminal is not.
    expect((await link(first, agentId, managerToken)).status).toBe(200);
    const refused = await link(second, agentId);
    expect(refused.status).toBe(409);
    expect(String(refused.json.error)).toMatch(/already serves Gate A/);
    expect(String(refused.json.error)).toMatch(/Raspberry Pi gate controller/);

    // A config made while several are linked (e.g. from before this rule) is a
    // file the program refuses to start from, not a guess.
    db.run(`INSERT INTO isapi_device_configs(id,device_id,agent_id,isapi_host,isapi_port,sync_enabled) VALUES ('cfg-legacy-pi',?,?,'192.168.1.61',80,1)`, second, agentId);
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/pi-gate-config`, adminToken);
    const parsed = JSON.parse(res.text) as Json;
    expect(String(parsed.error)).toMatch(/2 terminals are connected/);
    expect(parsed.terminals).toHaveLength(2);
    expect(parsed.secretRotated).toBe(false);
    expect(res.text).not.toContain(secret);
  });

  it('keeps the two controller kinds apart: no ESP32 files for a Pi, no Pi files for an ESP32', async () => {
    const { agentId: piGate } = await createAgent('pi_gate', 'Side gate Pi');
    const { agentId: esp32 } = await createAgent('esp32', 'Main gate ESP32');
    const { agentId: piBridge } = await createAgent('pi_bridge', 'Gate Pi bridge');

    expect((await download(env, 'GET', `/api/isapi/agents/${piGate}/esp32-sketch`, adminToken)).status).toBe(409);
    expect((await download(env, 'POST', `/api/isapi/agents/${piGate}/esp32-config`, adminToken)).status).toBe(409);
    expect((await download(env, 'GET', `/api/isapi/agents/${esp32}/pi-gate-program`, adminToken)).status).toBe(409);
    expect((await download(env, 'POST', `/api/isapi/agents/${esp32}/pi-gate-config`, adminToken)).status).toBe(409);
    // A bridge is a bridge: neither controller download belongs to it.
    expect((await download(env, 'GET', `/api/isapi/agents/${piBridge}/pi-gate-program`, adminToken)).status).toBe(409);
    expect((await download(env, 'POST', `/api/isapi/agents/${piBridge}/installer`, adminToken)).status).toBe(200);
  });

  it('installs a Raspberry Pi bridge with one script that survives a reboot', async () => {
    const { agentId, secret: oldSecret } = await createAgent('pi_bridge', 'Gate Pi bridge');
    const res = await download(env, 'POST', `/api/isapi/agents/${agentId}/installer`, adminToken);
    expect(res.status).toBe(200);
    expect(res.disposition).toBe(`attachment; filename="estatemate-isapi-agent-${agentId.slice(0,8)}.pi.sh"`);
    expect(res.text).toMatch(/^#!\/bin\/bash/);
    expect(res.text).toContain('Installing Node $NODE_MAJOR for $NODE_ARCH');       // Node 22, arm64/armv7l
    expect(res.text).toContain('aarch64|arm64) NODE_ARCH="arm64"');
    expect(res.text).toContain('armv7l|armv8l) NODE_ARCH="armv7l"');
    expect(res.text).toContain('codeload.github.com/$BRIDGE_REPO/tar.gz/refs/heads/$BRIDGE_REF');
    expect(res.text).toContain(`systemctl enable --now "$SERVICE_NAME"`);
    expect(res.text).toContain('[Install]');   // the unit starts on boot
    expect(res.text).not.toContain('Download the agent binary');
    // The script carries the rotated secret, and the old one is dead.
    const rotated = /AGENT_SECRET="([^"]+)"/.exec(res.text)?.[1] ?? '';
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(rotated).not.toBe(oldSecret);
    expect((await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, oldSecret, {})).status).toBe(401);
    expect((await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/heartbeat`, rotated, {})).status).toBe(200);
    // A plain Linux bridge still gets the generic script, which stops before the
    // service unit and points at the released agent binary.
    const generic = await createAgent('linux', 'Shop PC');
    const genericRes = await download(env, 'POST', `/api/isapi/agents/${generic.agentId}/installer`, adminToken);
    expect(genericRes.disposition).toBe(`attachment; filename="estatemate-isapi-agent-${generic.agentId.slice(0,8)}.sh"`);
    expect(genericRes.text).toContain('EstateMate ISAPI Bridge Agent Installer (Linux/macOS)');
    expect(genericRes.text).toContain('Download the agent binary');
  });

  it('accepts the gate events the Pi sends, as gate history, from the ESP32 fixtures', async () => {
    const { agentId } = await createAgent('pi_gate', 'Side gate Pi');
    const deviceId = await registerTerminal();
    await link(deviceId, agentId);
    const config = await download(env, 'POST', `/api/isapi/agents/${agentId}/pi-gate-config`, adminToken);
    const secret = String((JSON.parse(config.text) as Json).agentSecret);

    const fixture = async (name: string) => (await readRepoFile(`esp32-gate/host-test/fixtures/${name}`)).trim();
    const items = [
      { deviceId, contentType: 'application/json', document: await fixture('event-card-granted.json'), remoteVerification: { decision: 'granted', reason: 'authorised', doorResult: 'opened' } },
      { deviceId, contentType: 'application/json', document: await fixture('event-card-denied.json'), remoteVerification: { decision: 'denied', reason: 'unknown_credential', doorResult: 'not_attempted' } },
      { deviceId, contentType: 'application/json', document: await fixture('event-pin-granted.json'), remoteVerification: { decision: 'granted', reason: 'authorised', doorResult: 'opened' } },
      { deviceId, contentType: 'application/json', document: await fixture('event-exit.json') },
    ];
    const res = await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/events`, secret, { items });
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(4);
    expect(res.json.rejected).toBe(0);

    const batch = (queueSendsOf(env)[0]!.body as { batch: Json[] }).batch;
    const [granted, denied, pin, exit] = batch;
    expect(granted).toMatchObject({ deviceId, cardUid: '77881', credentialType: 'card', result: 'granted', direction: 'entry', vendorEventId: '5eed1234-1', remoteDecision: 'granted', remoteDoorResult: 'opened' });
    expect(denied).toMatchObject({ cardUid: '99999999', result: 'denied', remoteDecisionReason: 'unknown_credential' });
    expect(pin).toMatchObject({ employeeNo: 'visitorV12345', credentialType: 'pin', result: 'granted' });
    expect(exit).toMatchObject({ result: 'granted', direction: 'exit' });
  });

  it('gives the Pi controller the credential snapshot and queues its door commands', async () => {
    const { agentId } = await createAgent('pi_gate', 'Side gate Pi');
    const deviceId = await registerTerminal();
    await link(deviceId, agentId);
    const config = await download(env, 'POST', `/api/isapi/agents/${agentId}/pi-gate-config`, adminToken);
    const secret = String((JSON.parse(config.text) as Json).agentSecret);

    const snapshot = await nodeRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/credential-snapshot?limit=250`, secret);
    expect(snapshot.status).toBe(200);
    expect(Array.isArray(snapshot.json.items)).toBe(true);

    const queued = await call(env, 'POST', '/api/access/remote/door', { token: adminToken, body: { deviceId, command: 'remote_open', doorNo: 1, reason: 'Courier at the side gate' } });
    expect(queued.status).toBe(201);
    const poll = await nodeRequest(env, 'GET', `/api/isapi/v1/agents/${agentId}/operations?limit=10`, secret);
    const op = (poll.json.items as Json[])[0]!;
    expect(op).toMatchObject({ kind: 'door', deviceId, operation: 'remote_open' });
    expect((op.payload as Json).doorNo).toBe(1);
    const result = await nodeRequest(env, 'POST', `/api/isapi/v1/agents/${agentId}/operations/${String(op.id)}/result`, secret, { kind: 'door', status: 'applied', durationMs: 3 });
    expect(result.status).toBe(200);
    expect(db.one(`SELECT status FROM device_operations WHERE id=?`, String(op.id))?.status).toBe('applied');
  });
});
