#!/usr/bin/env node
/**
 * Integration checks for Remote Network Verification.
 *
 * The feature is only real if a credential the terminal does not hold still
 * opens the door, and if one the estate revoked does not. So these checks drive
 * the *agent* against a fake Worker and a fake terminal: nothing here is
 * satisfied by a pure function behaving well in isolation.
 *
 * What is proven:
 *   - the snapshot pages, and a delta removes what was revoked;
 *   - a cold cache denies, rather than deciding from an empty list;
 *   - a known card fires exactly one unlock command, with the documented
 *     RemoteControl payload, and the event records the outcome;
 *   - an unknown credential opens nothing and is still recorded;
 *   - the cooldown stops a card resting on a reader from holding a door open;
 *   - a terminal that refuses the command is reported, not assumed to have
 *     opened;
 *   - the LAN listener ingests XML and JSON, refuses a wrong key, counts an
 *     unmapped source, and never exposes an operation endpoint.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

process.env.ESTATEMATE_AGENT_STANDBY = '1';

const dir = mkdtempSync(join(tmpdir(), 'estatemate-remote-verify-'));
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on('exit', cleanup);

let checks = 0;
let failed = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Fake terminal: answers RemoteControl/door, records everything it was asked.
// ---------------------------------------------------------------------------
const terminalRequests = [];
let doorRefusal = null; // set to a subStatusCode to make the terminal refuse
const terminal = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    terminalRequests.push({ method: req.method, url: req.url, body });
    if (req.url.startsWith('/ISAPI/AccessControl/RemoteControl/door')) {
      if (doorRefusal) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          statusCode: 6, statusString: 'Invalid Operation', subStatusCode: doorRefusal, errorMsg: 'RemoteControl',
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 1, statusString: 'OK', subStatusCode: 'ok' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 1, statusString: 'OK' }));
  });
});
await new Promise((done) => terminal.listen(0, '127.0.0.1', done));
const terminalPort = terminal.address().port;

// ---------------------------------------------------------------------------
// Fake Worker: devices, credential snapshot (paged), events, heartbeat.
// ---------------------------------------------------------------------------
const DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const published = {
  events: [],
  heartbeats: [],
  snapshotRequests: [],
  deviceReads: 0,
};
let snapshotPages = [
  { items: [{ kind: 'card', value: '0001234567', personId: 'p1', employeeNo: 'EMP1', status: 'active', validUntil: null }] },
  { items: [{ kind: 'card', value: '0007654321', personId: 'p2', employeeNo: 'EMP2', status: 'active', validUntil: null }] },
];
let remoteVerifyEnabled = true;

const worker = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === `/api/isapi/v1/agents/${AGENT_ID}/devices`) {
      published.deviceReads += 1;
      return json(200, {
        items: [{
          device_id: DEVICE_ID,
          isapi_host: '127.0.0.1',
          isapi_port: terminalPort,
          remote_verify_enabled: remoteVerifyEnabled ? 1 : 0,
          remote_verify_door_no: 1,
          remote_verify_cooldown_ms: 1500,
        }],
      });
    }
    if (url.pathname === `/api/isapi/v1/agents/${AGENT_ID}/credential-snapshot`) {
      published.snapshotRequests.push({ since: url.searchParams.get('since'), cursor: url.searchParams.get('cursor') });
      const cursorIndex = Number(url.searchParams.get('cursor') ?? 0);
      const since = url.searchParams.get('since');
      // A delta carries only what moved. Serving the full pages again here would
      // re-add the credential the same response just removed, which is a bug in a
      // fake, not in the agent - a real Worker never returns a revoked credential
      // as an item.
      if (since) {
        return json(200, {
          version: 'delta-1',
          full: false,
          items: [],
          removed: [{ kind: 'card', value: '0007654321' }],
          nextCursor: null,
        });
      }
      const page = snapshotPages[cursorIndex];
      if (!page) return json(200, { version: 'full-1', items: [], removed: [], nextCursor: null, full: false });
      const next = cursorIndex + 1 < snapshotPages.length ? String(cursorIndex + 1) : null;
      return json(200, { version: 'full-1', items: page.items, removed: [], nextCursor: next, full: cursorIndex === 0 });
    }
    if (url.pathname === `/api/isapi/v1/agents/${AGENT_ID}/events`) {
      const parsed = JSON.parse(body || '{"items":[]}');
      published.events.push(...(parsed.items ?? []));
      return json(200, { ok: true, accepted: (parsed.items ?? []).length, rejected: 0 });
    }
    if (url.pathname === `/api/isapi/v1/agents/${AGENT_ID}/heartbeat`) {
      published.heartbeats.push(JSON.parse(body || '{}'));
      return json(200, { ok: true, serverTime: new Date().toISOString() });
    }
    if (url.pathname === `/api/isapi/v1/agents/${AGENT_ID}/operations`) return json(200, { items: [] });
    return json(404, { error: `no fake route for ${url.pathname}` });
  });
});
await new Promise((done) => worker.listen(0, '127.0.0.1', done));
const workerPort = worker.address().port;

// ---------------------------------------------------------------------------
// Agent under test
// ---------------------------------------------------------------------------
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');
writeFileSync(configPath, JSON.stringify({
  agentId: AGENT_ID,
  agentSecret: 'a-very-long-agent-secret-value',
  workerUrl: `http://127.0.0.1:${workerPort}`,
  syncIntervalSeconds: 30,
  heartbeatIntervalSeconds: 60,
  eventStream: false,
  remoteVerify: { enabled: true, snapshotIntervalSeconds: 60, pageSize: 1 },
  lanEvents: { enabled: true, port: 0, bindAddress: '127.0.0.1' },
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [{
    name: 'Main Gate',
    estateMateDeviceId: DEVICE_ID,
    isapiHost: '127.0.0.1',
    isapiPort: terminalPort,
    isapiUsername: 'admin',
    isapiPassword: 'pw',
    protocol: 'http',
    eventStream: false,
  }],
}));
process.env.AGENT_CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');

console.log('Remote Network Verification checks');

// ── 1. A cold cache denies ───────────────────────────────────────────────────
const cold = agent.credentialCache;
check('a cache that has never synced is not ready', cold.ready === false);
check('a cold cache denies instead of deciding from nothing', cold.lookup({ cardNo: '0001234567' }) === null);

// ── 2. The snapshot pages, and settings come from the portal ─────────────────
await agent.refreshRemoteVerifyConfig();
await agent.syncCredentialSnapshot();
check('the snapshot paged through every page', published.snapshotRequests.length === 2, JSON.stringify(published.snapshotRequests));
check('both credentials are cached', cold.count === 2, `count=${cold.count}`);
check('the cache is ready after a successful sync', cold.ready === true);
check('the portal says this terminal is a reader', agent.remoteVerifyHeartbeat().devicesEnabled === 1);

// ── 3. A delta removes a revoked credential ──────────────────────────────────
await agent.syncCredentialSnapshot();
check('a revocation between syncs leaves the cache', cold.lookup({ cardNo: '0007654321' }) === null, `count=${cold.count}`);
check('the credential that was not revoked stays', cold.lookup({ cardNo: '0001234567' }) !== null);

// ── 4. A known card opens the door, once ─────────────────────────────────────
const grantedDoc = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<ipAddress>127.0.0.1</ipAddress><eventType>AcsEvent</eventType>
<AccessControllerEvent><cardNo>0001234567</cardNo><doorNo>1</doorNo><name>Ada Resident</name></AccessControllerEvent>
</EventNotificationAlert>`;
const before = terminalRequests.length;
agent.queueEvent(DEVICE_ID, grantedDoc);
// The door command is sent without waiting for the event upload, so give the
// microtask queue a turn before asserting on the terminal.
await new Promise((done) => setTimeout(done, 50));
const opens = terminalRequests.slice(before).filter((r) => r.url.includes('RemoteControl/door'));
check('a known card fires one unlock command', opens.length === 1, `${opens.length} command(s)`);
check('the command is the documented RemoteControlDoor payload', opens[0]?.body.includes('"RemoteControlDoor"') && opens[0]?.body.includes('"cmd":"open"'), opens[0]?.body);
check('the command addresses the configured door', opens[0]?.url.includes('/door/1'), opens[0]?.url);
check('JSON is tried before XML', opens[0]?.url.includes('format=json'));

// ── 5. The event history records the verdict ─────────────────────────────────
agent.flushEvents();
await new Promise((done) => setTimeout(done, 100));
const uploaded = published.events.find((item) => item.remoteVerification);
check('the event carries the decision', uploaded?.remoteVerification?.decision === 'granted', JSON.stringify(uploaded?.remoteVerification));
check('the event carries the door result', uploaded?.remoteVerification?.doorResult === 'opened', JSON.stringify(uploaded?.remoteVerification));
check('the event is not left marked pending', uploaded?.remoteVerification?.doorResult !== 'pending');

// ── 6. The cooldown stops a resting card from holding the door open ───────────
const beforeCooldown = terminalRequests.length;
agent.queueEvent(DEVICE_ID, grantedDoc);
await new Promise((done) => setTimeout(done, 50));
const repeatOpens = terminalRequests.slice(beforeCooldown).filter((r) => r.url.includes('RemoteControl/door'));
check('the same credential inside the cooldown fires nothing', repeatOpens.length === 0, `${repeatOpens.length} command(s)`);
agent.flushEvents();
await new Promise((done) => setTimeout(done, 100));
const suppressed = published.events.filter((item) => item.remoteVerification?.cooldownSuppressed);
check('a suppressed repeat is still recorded, with no command', suppressed.length === 1 && suppressed[0].remoteVerification.doorResult === 'not_attempted');

// ── 7. An unknown credential opens nothing ───────────────────────────────────
const beforeUnknown = terminalRequests.length;
agent.queueEvent(DEVICE_ID, `<?xml version="1.0"?><EventNotificationAlert><AccessControllerEvent><cardNo>9999999999</cardNo><doorNo>1</doorNo></AccessControllerEvent></EventNotificationAlert>`);
await new Promise((done) => setTimeout(done, 50));
check('an unknown card fires no unlock command', terminalRequests.slice(beforeUnknown).filter((r) => r.url.includes('RemoteControl/door')).length === 0);
agent.flushEvents();
await new Promise((done) => setTimeout(done, 100));
const denied = published.events.filter((item) => item.remoteVerification?.decision === 'denied');
check('the denial is recorded with its reason', denied.length >= 1 && denied[0].remoteVerification.reason === 'unknown_credential', JSON.stringify(denied[0]?.remoteVerification));
check('a denial never attempts the door', denied.every((item) => item.remoteVerification.doorResult === 'not_attempted'));

// ── 8. A refusal is reported, not assumed ────────────────────────────────────
doorRefusal = 'notSupport';
// A full re-sync puts 0007654321 back, which gives this check a credential that
// is *not* sitting inside the cooldown from the earlier checks - otherwise the
// cooldown, not the terminal, is what stops the command and nothing is proven.
agent.credentialCache.lastSyncAt = null;
await agent.syncCredentialSnapshot();
check('a full re-sync restores the revoked credential', cold.lookup({ cardNo: '0007654321' }) !== null);
agent.queueEvent(DEVICE_ID, `<?xml version="1.0"?><EventNotificationAlert><AccessControllerEvent><cardNo>0007654321</cardNo><doorNo>1</doorNo></AccessControllerEvent></EventNotificationAlert>`);
await new Promise((done) => setTimeout(done, 50));
agent.flushEvents();
await new Promise((done) => setTimeout(done, 100));
const refused = published.events.filter((item) => item.remoteVerification?.doorResult === 'refused');
check('a terminal refusal is recorded as refused, never as opened', refused.length >= 1 || agent.remoteStats.refused >= 1, `refused=${agent.remoteStats.refused}`);
check('the refusal is visible on the heartbeat status', agent.remoteVerifyHeartbeat().perDevice[DEVICE_ID]?.lastResult === 'refused', JSON.stringify(agent.remoteVerifyHeartbeat().perDevice));
check('the heartbeat reports how stale the snapshot is', typeof agent.remoteVerifyHeartbeat().cache.cacheAgeSeconds === 'number');
doorRefusal = null;

// ── 9. Switching the terminal off in the portal stops the decisions ───────────
remoteVerifyEnabled = false;
await agent.refreshRemoteVerifyConfig();
const beforeOff = terminalRequests.length;
agent.queueEvent(DEVICE_ID, grantedDoc);
await new Promise((done) => setTimeout(done, 50));
check('a terminal switched off in the portal is left to decide for itself', terminalRequests.slice(beforeOff).filter((r) => r.url.includes('RemoteControl/door')).length === 0);
check('no terminal is reported as a reader once it is switched off', agent.remoteVerifyHeartbeat().devicesEnabled === 0);
remoteVerifyEnabled = true;
await agent.refreshRemoteVerifyConfig();

// ── 10. The LAN listener ingests, authenticates and never serves operations ──
const { startLanEventListener } = await import('./lan-event-listener.mjs');
const device = { name: 'Main Gate', estateMateDeviceId: DEVICE_ID, isapiHost: '127.0.0.1' };
const listener = await startLanEventListener({
  port: 0,
  bindAddress: '127.0.0.1',
  requireKey: true,
  agentKey: 'terminal-shared-secret',
  log: () => {},
  resolveDevice: ({ ip }) => (String(ip).replace('::ffff:', '') === '127.0.0.1' ? device : null),
  onEvent: ({ raw }) => agent.queueEvent(DEVICE_ID, raw),
});

const post = (path, body, headers = {}) => new Promise((resolve) => {
  import('node:http').then(({ default: http }) => {
    const r = http.request({
      host: '127.0.0.1',
      port: listener.port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    // A destroyed connection resolves with an Error, which would otherwise be
    // reported as an undefined status and hide what actually happened.
    r.on('error', (error) => resolve({ status: null, text: String(error?.code ?? error) }));
    r.end(body);
  });
});

const unauthenticated = await post('/events', '<EventNotificationAlert><AccessControllerEvent><cardNo>0001234567</cardNo></AccessControllerEvent></EventNotificationAlert>');
check('an upload without the shared secret is refused', unauthenticated.status === 401, `status=${unauthenticated.status}`);

const accepted = await post('/events', '<EventNotificationAlert><AccessControllerEvent><cardNo>0001234567</cardNo></AccessControllerEvent></EventNotificationAlert>', { 'X-EstateMate-Terminal-Key': 'terminal-shared-secret' });
check('a pushed XML event is accepted', accepted.status === 200, `status=${accepted.status}`);

const jsonPush = await post('/events', JSON.stringify({ AccessControllerEvent: { cardNo: '0001234567', doorNo: 1 } }), { 'Content-Type': 'application/json', 'X-EstateMate-Terminal-Key': 'terminal-shared-secret' });
check('a pushed JSON event is accepted', jsonPush.status === 200, `status=${jsonPush.status}`);
check('pushed events are mapped to the terminal', listener.stats.mapped >= 2, JSON.stringify(listener.stats));

const oversized = await post('/events', 'x'.repeat(300 * 1024), { 'X-EstateMate-Terminal-Key': 'terminal-shared-secret' });
check('an oversized upload is rejected', oversized.status === 413, `status=${oversized.status}`);

const { default: http } = await import('node:http');
const getProbe = await new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: listener.port, path: '/events', method: 'GET', agent: false }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode }));
  });
  r.on('error', (error) => resolve({ status: null, error: String(error?.code ?? error) }));
  r.end();
});
check('the listener accepts POST only - it is ingest, never an API', getProbe.status === 405, JSON.stringify(getProbe));

// A pushed event must reach the same decision path as a streamed one.
await new Promise((done) => setTimeout(done, 50));
check('a pushed event reaches the credential decision', agent.remoteStats.decisions > 0, JSON.stringify(agent.remoteStats));

await listener.close();

// ---------------------------------------------------------------------------
terminal.close();
worker.close();
cleanup();

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
