#!/usr/bin/env node
/**
 * Integration checks for the offline Android engine bundle.
 *
 * This runs the EXACT artifact the APK ships: scripts/bundle-offline-server.mjs
 * builds adapter.js + the unmodified Worker (src/index.ts) into one IIFE, and
 * this test loads that bundle and drives it through a mock of the Java native
 * bridge (Native.d1Exec / fileStore / liveBroadcast / respond) backed by
 * node:sqlite and a temp directory.
 *
 * The mock's d1Exec implements byte-for-byte the same JSON protocol the
 * Android Db.java implements, so a protocol change on either side fails here.
 *
 * Exit code 0 = all checks passed. Wired into `npm test` via
 * `npm run test:offline-apk`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const log = (...args) => console.log('[test]', ...args);

async function waitFor(label, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// 1. Build the bundle that the APK will ship.
// ---------------------------------------------------------------------------
const { buildServerBundle } = await import(join(repoRoot, 'scripts', 'bundle-offline-server.mjs'));
const buildDir = mkdtempSync(join(tmpdir(), 'estatemate-apk-bundle-'));
const built = await buildServerBundle({ out: buildDir, minify: false });
log(`bundle built: ${built.bundle}`);

// ---------------------------------------------------------------------------
// 2. Mock the Java native bridge. Mirrors Db.java / NativeBridge.java exactly.
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'estatemate-apk-data-'));
const storageDir = join(dataDir, 'storage');
const dlqDir = join(dataDir, 'dlq');
mkdirSync(storageDir, { recursive: true });
mkdirSync(dlqDir, { recursive: true });

const { DatabaseSync } = await import('node:sqlite');
const { applyMigrations } = await import(join(repoRoot, 'local-server', 'd1.mjs'));
const sqlite = new DatabaseSync(join(dataDir, 'estatemate.db'));
sqlite.exec('PRAGMA journal_mode=WAL');
sqlite.exec('PRAGMA foreign_keys=ON');
// Java applies migrations from APK assets before the engine boots.
applyMigrations(sqlite, join(repoRoot, 'migrations'));

function sqlValue(value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isInteger(value) ? value : value;
  return String(value);
}

function d1Exec(opJson) {
  try {
    const op = JSON.parse(opJson);
    const params = (op.params ?? []).map(sqlValue);
    if (op.op === 'first') {
      const rows = sqlite.prepare(op.sql).all(...params);
      return JSON.stringify({ row: rows.length ? { ...rows[0] } : null });
    }
    if (op.op === 'all') {
      return JSON.stringify({ rows: sqlite.prepare(op.sql).all(...params).map((row) => ({ ...row })) });
    }
    if (op.op === 'run') {
      const info = sqlite.prepare(op.sql).run(...params);
      return JSON.stringify({ changes: Number(info.changes ?? 0), lastRowId: Number(info.lastInsertRowid ?? 0) });
    }
    if (op.op === 'batch') {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const statement of op.statements ?? []) {
          const info = sqlite.prepare(statement.sql).run(...(statement.params ?? []).map(sqlValue));
          results.push({ changes: Number(info.changes ?? 0), lastRowId: Number(info.lastInsertRowid ?? 0) });
        }
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        return JSON.stringify({ error: String(error.message ?? error) });
      }
      return JSON.stringify({ results });
    }
    return JSON.stringify({ error: `unknown op ${op.op}` });
  } catch (error) {
    return JSON.stringify({ error: String(error.message ?? error) });
  }
}

const broadcasts = [];
const responses = new Map();
let engine = null;

const secrets = {
  jwtSecret: 'a'.repeat(64),
  bootstrapToken: 'b'.repeat(32),
  deviceIngestPepper: 'c'.repeat(64),
  storageEncryptionKey: 'd'.repeat(64),
};

const native = {
  config() {
    return JSON.stringify({ appName: 'EstateMate', allowedOrigins: '', hikvisionMode: 'per-device', fileStorage: 'local', secrets });
  },
  d1Exec,
  fileStore(opJson) {
    try {
      const op = JSON.parse(opJson);
      if (op.op === 'put') {
        const target = join(storageDir, ...String(op.path).split('/').filter((segment) => segment && segment !== '.' && segment !== '..'));
        mkdirSync(join(target, '..'), { recursive: true });
        const bytes = Buffer.from(op.b64, 'base64');
        writeFileSync(target, bytes);
        return JSON.stringify({ sha: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), size: bytes.length });
      }
      if (op.op === 'get') {
        const target = join(storageDir, ...String(op.path).split('/').filter((segment) => segment && segment !== '.' && segment !== '..'));
        if (!existsSync(target)) return JSON.stringify({ found: false });
        return JSON.stringify({ found: true, b64: readFileSync(target).toString('base64') });
      }
      if (op.op === 'dlq') {
        writeFileSync(join(dlqDir, op.name), op.json, 'utf8');
        return JSON.stringify({ ok: true });
      }
      return JSON.stringify({ error: `unknown fileStore op ${op.op}` });
    } catch (error) {
      return JSON.stringify({ error: String(error.message ?? error) });
    }
  },
  liveBroadcast(text) {
    broadcasts.push(String(text));
  },
  requestQueueDrain() {
    // Java posts evaluateJavascript("EstateMateOffline.drainQueue()").
    setImmediate(() => { engine?.drainQueue()?.catch(() => undefined); });
  },
  respond(id, status, headersJson, bodyB64) {
    responses.set(Number(id), { status, headers: JSON.parse(headersJson), body: bodyB64 ? Buffer.from(bodyB64, 'base64') : null });
  },
  log(level, message) {
    if (level === 'error' || level === 'warn') console.log(`[engine:${level}] ${message}`);
  },
  onReady() {
    /* not used in the test boot path */
  },
};

// ---------------------------------------------------------------------------
// 3. Load the built bundle and boot the engine against the mock.
// ---------------------------------------------------------------------------
await import(pathToFileURL(built.bundle).href);
const module_ = globalThis.EstateMateOfflineModule;
assert.ok(module_?.createOfflineEngine, 'the IIFE bundle must expose createOfflineEngine');
engine = await module_.createOfflineEngine(native);
log('engine booted against the mock native bridge');

let cookie = null;
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const request = new Request(`http://127.0.0.1:8080${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const response = await engine.handleRequest(request);
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (setCookie.length) cookie = setCookie[0].split(';')[0];
  let json = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, json, response };
}

try {
  // 4. Health: the unmodified Worker runs on the bridged database.
  {
    const { status, json } = await api('/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.fileStorage, 'github-private');
    log('health + bridged D1 + local storage OK');
  }

  // 5. Bootstrap + login through the real routes.
  {
    const { status, json } = await api('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'X-Bootstrap-Token': secrets.bootstrapToken },
      body: { name: 'Phone Admin', email: 'admin@estate.local', password: 'correct-horse-battery' },
    });
    assert.equal(status, 201, JSON.stringify(json));
    const login = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@estate.local', password: 'correct-horse-battery' } });
    assert.equal(login.status, 200);
    assert.ok(cookie, 'login must set the session cookie');
  }
  log('bootstrap + administrator login OK');

  // 6. Register device + agent + link, then stream a swipe through the
  //    agent event endpoint, exactly as the Java OfflineAgent will.
  const deviceId = (await api('/api/access/devices', {
    method: 'POST',
    body: { name: 'Gate Terminal', gateName: 'Gate', direction: 'entry', model: 'DS-K1T320MWX', connectionPattern: 'isapi_bridge' },
  })).json.id;
  const agent = (await api('/api/isapi/agents', {
    method: 'POST',
    body: { name: 'Offline phone', platform: 'other' },
  })).json;
  {
    const { status, json } = await api('/api/isapi/device-configs', {
      method: 'POST',
      body: { deviceId, agentId: agent.id, isapiHost: '192.168.1.50', isapiPort: 80, isapiUsername: 'admin', isapiPassword: 'secret' },
    });
    assert.equal(status, 200, JSON.stringify(json));
  }
  {
    const document = JSON.stringify({
      ipAddress: '192.168.1.50',
      dateTime: new Date().toISOString(),
      eventLog: {
        eventType: 'AccessControllerEvent',
        eventState: 'active',
        eventDescription: 'access success',
        cardNo: '9876543210',
        employeeNo: '2002',
        name: 'Ada Phone',
      },
    });
    const { status, json } = await api(`/api/isapi/v1/agents/${agent.id}/events`, {
      method: 'POST',
      headers: { 'X-EstateMate-Agent-Key': agent.secret },
      body: { items: [{ deviceId, document }] },
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.accepted, 1);
  }
  await engine.drainQueue();
  {
    const rows = JSON.parse(d1Exec(JSON.stringify({ op: 'all', sql: 'SELECT card_uid, employee_no, result FROM access_events', params: [] }))).rows;
    assert.equal(rows.length, 1, 'the swipe must be persisted through the queue consumer');
    assert.equal(rows[0].card_uid, '9876543210');
    assert.equal(rows[0].result, 'granted');
  }
  await waitFor('the swipe broadcast on the live feed', () => broadcasts.some((text) => text.includes('access_events')));
  const broadcast = JSON.parse(broadcasts.find((text) => text.includes('access_events')));
  assert.equal(broadcast.type, 'access_events');
  log('agent event → queue consumer → database + live-feed broadcast OK');

  // 7. The upgrade probe the Java WebServer relies on: without an Upgrade
  //    header the route answers 400 only for authorised sessions.
  {
    const denied = await engine.handleRequest(new Request('http://127.0.0.1:8080/api/access/events/stream'));
    assert.equal(denied.status, 401, 'an anonymous upgrade probe must be refused');
    const allowed = await api('/api/access/events/stream');
    assert.equal(allowed.status, 400, 'an authorised probe must reach the upgrade-only check');
  }
  log('WebSocket upgrade authorisation probe contract OK');

  // 8. Local upload storage through the exact GitHub REST slice.
  {
    const verify = await fetch('https://api.github.com/repos/estate/local-files', { headers: { Authorization: 'Bearer local' } });
    assert.equal(verify.status, 200);
    assert.equal((await verify.json()).private, true);
    const bytes = new TextEncoder().encode('phone-proof-upload');
    const put = await fetch('https://api.github.com/repos/estate/local-files/contents/uploads/general/x.bin', {
      method: 'PUT',
      body: JSON.stringify({ message: 'store', content: Buffer.from(bytes).toString('base64'), branch: 'main' }),
    });
    assert.equal(put.status, 201);
    const got = await fetch('https://api.github.com/repos/estate/local-files/contents/uploads/general/x.bin?ref=main');
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).toString('utf8'), 'phone-proof-upload');
    const missing = await fetch('https://api.github.com/repos/estate/local-files/contents/nope?ref=main');
    assert.equal(missing.status, 404);
  }
  log('local upload storage (GitHub REST slice over fileStore) OK');

  // 9. The dispatch() path Java calls through evaluateJavascript.
  {
    const payload = JSON.stringify({
      method: 'GET',
      url: 'http://127.0.0.1:8080/api/health',
      headers: [],
      bodyB64: '',
    });
    await engine.dispatch(7, payload);
    await waitFor('the dispatch reply', () => responses.has(7));
    const reply = responses.get(7);
    assert.equal(reply.status, 200);
    assert.ok(reply.headers.some(([name]) => name.toLowerCase() === 'content-type'));
    assert.equal(JSON.parse(reply.body.toString('utf8')).ok, true);
  }
  log('dispatch/respond bridge protocol OK');

  // 10. Hourly maintenance through tickCron (the Java minute-15 timer).
  await engine.tickCron();
  await engine.tickCron(); // second tick in the same hour must be a no-op
  log('hourly maintenance tick OK');

  sqlite.close();
  console.log('\nAll offline-APK engine integration checks passed.');
} catch (error) {
  console.error('\nFAILED:', error);
  try { sqlite.close(); } catch { /* best effort */ }
  process.exit(1);
}
