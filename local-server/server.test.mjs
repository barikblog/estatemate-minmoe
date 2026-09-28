#!/usr/bin/env node
/**
 * Integration checks for the EstateMate offline LAN server.
 *
 * Runs without real hardware:
 *  1. the server boots the unmodified Worker code against a temp SQLite
 *     database, applies the real migration chain and answers /api/health;
 *  2. first-run bootstrap → Administrator login → session works;
 *  3. local file storage honours the exact GitHub REST calls the Worker
 *     makes (verify / PUT / GET-raw);
 *  4. the full device loop end-to-end: a fake Hikvision terminal (Basic
 *     challenge + multipart alertStream + ISAPI Digest) → the embedded
 *     production agent child process → loopback API → queue consumer →
 *     access_events persisted and the device shown online;
 *  5. a card issued through the portal is queued, claimed by the agent,
 *     applied to the terminal over ISAPI and marked applied;
 *  6. the live feed WebSocket authenticates via the Worker and receives the
 *     broadcast of a later gate event;
 *  7. the built portal is served with SPA fallback (when apps/web/dist
 *     exists).
 *
 * Exit code 0 = all checks passed. Wired into `npm test` as
 * `npm run test:local-server`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..');

const log = (...args) => console.log('[test]', ...args);

async function waitFor(label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

// ---------------------------------------------------------------------------
// Fake Hikvision terminal: Basic challenge for the alertStream, Digest
// challenge for ISAPI operations, multipart JSON event stream.
// ---------------------------------------------------------------------------
const streamClients = [];
let isapiOperationCount = 0;
const terminal = createServer((req, res) => {
  const finish = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };
  if (!req.headers.authorization) {
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="ISAPI", nonce="abc123", qop="auth", stale=FALSE, Basic realm="ISAPI"` });
    res.end();
    return;
  }
  if (req.url?.includes('/ISAPI/Event/notification/alertStream')) {
    res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=streambnd' });
    streamClients.push(res);
    log('terminal: alertStream opened (auth:', req.headers.authorization.slice(0, 12) + '...)');
    return;
  }
  isapiOperationCount += 1;
  finish(200, '<?xml version="1.0" encoding="UTF-8"?><ResponseStatus><statusCode>1</statusCode></ResponseStatus>', 'application/xml');
});
await new Promise((resolve) => terminal.listen(0, '127.0.0.1', resolve));
const terminalPort = terminal.address().port;
log(`fake terminal listening on 127.0.0.1:${terminalPort}`);

function emitGateEvent(cardNo, employeeNo = '1001') {
  const document = JSON.stringify({
    ipAddress: '127.0.0.1',
    dateTime: new Date().toISOString(),
    eventLog: {
      eventType: 'AccessControllerEvent',
      eventState: 'active',
      eventDescription: 'access success',
      cardNo: String(cardNo),
      employeeNo: String(employeeNo),
      name: 'Integration Resident',
    },
  });
  for (const client of streamClients) {
    // A trailing boundary marker closes the part for the agent's streaming
    // parser, exactly like the next chunk a real terminal would send.
    client.write(`--streambnd\r\nContent-Type: application/json\r\n\r\n${document}\r\n--streambnd\r\n`);
  }
}

// ---------------------------------------------------------------------------
// Boot the offline server against a temp data directory.
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'estatemate-offline-'));
const { startServer } = await import('./server.mjs');
const server = await startServer({
  config: {
    port: 0,
    dataDir,
    fileStorage: 'local',
    agent: { enabled: false },
  },
  quiet: true,
});
const base = `http://127.0.0.1:${server.port}`;
const bootstrapToken = server.config.secrets.bootstrapToken;
log(`offline server on ${base} (db ${dataDir})`);

let cookie = null;
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await response.json(); } catch { /* non-JSON */ }
  return { status: response.status, json };
}

try {
  // 1. Health: the unmodified Worker runs on Node SQLite, storage seeded.
  {
    const { status, json } = await api('/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.fileStorage, 'github-private', 'local storage must present as the configured private store');
    log('health + database + local storage OK');
  }

  // 2. Bootstrap the first Administrator, then log in.
  {
    const { status, json } = await api('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'X-Bootstrap-Token': bootstrapToken },
      body: { name: 'Estate Admin', email: 'admin@estate.local', password: 'correct-horse-battery' },
    });
    assert.equal(status, 201, JSON.stringify(json));
    const second = await api('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'X-Bootstrap-Token': bootstrapToken },
      body: { name: 'Again', email: 'again@estate.local', password: 'correct-horse-battery' },
    });
    assert.equal(second.status, 409, 'bootstrap must close after the first administrator');
  }
  {
    const { status, json } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@estate.local', password: 'correct-horse-battery' },
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(cookie, 'login must set the session cookie');
    const me = await api('/api/auth/me');
    assert.equal(me.status, 200);
    log('bootstrap + administrator login OK');
  }

  // 3. Local file storage speaks the GitHub REST slice the Worker uses.
  {
    const repo = 'https://api.github.com/repos/estate/local-files';
    const verify = await fetch(repo, { headers: { Authorization: 'Bearer local' } });
    assert.equal(verify.status, 200);
    assert.equal((await verify.json()).private, true, 'the local store must look like a private repository');

    const bytes = Buffer.from('proof-of-ownership-upload', 'utf8');
    const put = await fetch(`${repo}/contents/uploads/general/2026/09/28/test-file.txt`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'store upload', content: bytes.toString('base64'), branch: 'main' }),
    });
    assert.equal(put.status, 201);
    const sha = (await put.json()).content.sha;
    assert.match(sha, /^[0-9a-f]{40}$/, 'a git blob sha must come back');

    const got = await fetch(`${repo}/contents/uploads/general/2026/09/28/test-file.txt?ref=main`, {
      headers: { Authorization: 'Bearer local', Accept: 'application/vnd.github.raw+json' },
    });
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).toString('utf8'), 'proof-of-ownership-upload');

    const missing = await fetch(`${repo}/contents/uploads/general/nope.txt?ref=main`, {
      headers: { Authorization: 'Bearer local' },
    });
    assert.equal(missing.status, 404);
    log('local file storage (GitHub REST slice) OK');
  }

  // 4. Register the access-control device, the agent, and link them.
  const deviceId = await (async () => {
    const { status, json } = await api('/api/access/devices', {
      method: 'POST',
      body: { name: 'Main Gate Terminal', gateName: 'Main Gate', direction: 'entry', model: 'DS-K1T320MWX', connectionPattern: 'isapi_bridge' },
    });
    assert.equal(status, 201, JSON.stringify(json));
    assert.equal(json.connectionPattern, 'isapi_bridge');
    return json.id;
  })();

  const { id: agentId, secret: agentSecret } = await (async () => {
    const { status, json } = await api('/api/isapi/agents', {
      method: 'POST',
      body: { name: 'Estate Office PC (offline)', platform: 'windows' },
    });
    assert.equal(status, 201, JSON.stringify(json));
    return json;
  })();

  {
    const { status, json } = await api('/api/isapi/device-configs', {
      method: 'POST',
      body: {
        deviceId,
        agentId,
        isapiHost: '127.0.0.1',
        isapiPort: terminalPort,
        isapiUsername: 'admin',
        isapiPassword: 'terminal-password',
      },
    });
    assert.equal(status, 200, JSON.stringify(json));
  }

  // The live feed must refuse anonymous sockets but accept the admin session.
  const wsUrl = `ws://127.0.0.1:${server.port}/api/access/events/stream`;
  await new Promise((resolve, reject) => {
    const probe = new WebSocket(wsUrl);
    probe.on('error', () => { probe.terminate(); resolve(); });
    probe.on('open', () => reject(new Error('anonymous WebSocket upgrade must be refused')));
  });
  log('live feed refuses unauthenticated upgrades OK');

  const liveMessages = [];
  const liveSocket = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  const opened = new Promise((resolve, reject) => {
    liveSocket.once('open', resolve);
    liveSocket.once('error', reject);
  });
  // Attach before awaiting open: the server greets with `ready` immediately.
  liveSocket.on('message', (data) => { liveMessages.push(String(data)); });
  await opened;
  await waitFor('the live feed greeting', () => liveMessages.length >= 1);
  assert.equal(JSON.parse(liveMessages[0]).type, 'ready');
  log('live feed WebSocket (authenticated) OK');

  // 5. Start the embedded agent against the fake terminal and stream a swipe.
  await server.agent.update({
    agentId,
    agentSecret,
    devices: [{
      estateMateDeviceId: deviceId,
      name: 'Main Gate Terminal',
      isapiHost: '127.0.0.1',
      isapiPort: terminalPort,
      isapiUsername: 'admin',
      isapiPassword: 'terminal-password',
      protocol: 'http',
      eventStream: true,
    }],
    syncIntervalSeconds: 2,
    heartbeatIntervalSeconds: 3600,
    eventFlushCount: 25,
    eventFlushSeconds: 1,
    logLevel: 'info',
  });
  assert.equal(server.agent.isRunning(), true, 'the agent child process must be running');

  await waitFor('the agent to open the alertStream', () => streamClients.length > 0);
  emitGateEvent('1234567890');

  await waitFor('the swipe to be persisted', () => {
    const rows = server.all('SELECT card_uid, employee_no, result, direction FROM access_events');
    return rows.length >= 1;
  });
  {
    const rows = server.all('SELECT card_uid, employee_no, result FROM access_events');
    const event = rows.find((row) => row.card_uid === '1234567890');
    assert.ok(event, `expected the card swipe in access_events, got ${JSON.stringify(rows)}`);
    assert.equal(event.result, 'granted', 'access success description must map to granted');
    assert.equal(event.employee_no, '1001');
  }
  await waitFor('the terminal to be shown online', () => {
    const rows = server.all('SELECT status FROM hikvision_devices WHERE id=?', deviceId);
    return rows[0]?.status === 'online';
  });
  await waitFor('the swipe to reach the live feed', () => liveMessages.length >= 2);
  assert.equal(JSON.parse(liveMessages[liveMessages.length - 1]).type, 'access_events');
  log('end-to-end swipe: terminal → agent → loopback API → queue → database + live feed OK');

  // 6. Issue a card through the portal; the agent must apply it over ISAPI.
  const residentId = await (async () => {
    const { status, json } = await api('/api/users', {
      method: 'POST',
      body: { name: 'Ada Resident', email: 'ada@estate.local', password: 'twelve-char-secret', role: 'resident' },
    });
    assert.equal(status, 201, JSON.stringify(json));
    return json.id;
  })();
  {
    const { status, json } = await api('/api/access/cards', {
      method: 'POST',
      body: { residentId, cardUid: '1234567890', cardLabel: 'Ada gate card' },
    });
    assert.equal(status, 201, JSON.stringify(json));
  }
  await waitFor('the card operation to be applied on the terminal', () => {
    const rows = server.all('SELECT operation, status FROM device_operations WHERE card_id IS NOT NULL');
    return rows.length >= 1 && rows.every((row) => row.status === 'applied');
  }, 30000);
  assert.ok(isapiOperationCount >= 1, 'the agent must have sent the ISAPI card command');
  {
    const rows = server.all("SELECT status FROM device_operations WHERE operation='upsert_card'");
    assert.equal(rows[0].status, 'applied');
  }
  log('card issue → operation queue → agent → ISAPI terminal → applied OK');

  // 7. The built portal is served (when it has been built).
  if (existsSync(join(repoRoot, 'apps', 'web', 'dist', 'index.html'))) {
    const portal = await fetch(`${base}/`);
    assert.equal(portal.status, 200);
    assert.match(portal.headers.get('content-type') ?? '', /text\/html/);
    const spaRoute = await fetch(`${base}/people/some-portal-route`);
    assert.equal(spaRoute.status, 200);
    assert.match(await spaRoute.text(), /<!doctype html>/i);
    log('static portal + SPA fallback OK');
  } else {
    log('static portal check skipped (apps/web/dist not built)');
  }

  // 8. Clean shutdown flushes and closes without hanging.
  const agentDirConfig = join(dataDir, 'agent', 'agent-config.json');
  assert.ok(existsSync(agentDirConfig), 'the agent config must have been generated');
  const written = JSON.parse(readFileSync(agentDirConfig, 'utf8'));
  assert.equal(written.workerUrl, base, 'the agent must talk to the server loopback, never the Internet');
  assert.equal(written.agentId, agentId);
  assert.doesNotMatch(JSON.stringify(written), /workers\.dev/, 'no Cloudflare URL may leak into the agent config');

  await server.close();
  await new Promise((resolve) => terminal.closeAllConnections?.() ?? resolve());
  await new Promise((resolve) => terminal.close(resolve));
  liveSocket.terminate();
  log('shutdown OK');
  console.log('\nAll offline-server integration checks passed.');
} catch (error) {
  console.error('\nFAILED:', error);
  try {
    await server.close();
  } catch { /* best effort during failure cleanup */ }
  terminal.closeAllConnections?.();
  terminal.close();
  process.exit(1);
}
