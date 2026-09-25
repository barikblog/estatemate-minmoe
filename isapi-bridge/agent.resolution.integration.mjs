#!/usr/bin/env node
/**
 * Integration checks for the one thing that decides whether a bridge setup
 * works on the first try: how the agent learns each terminal's EstateMate
 * device id.
 *
 * The id is the Worker's key for a terminal — operations are addressed with it
 * and events are uploaded against it — and it is a UUID that lives in the
 * portal, which is exactly the sort of value people mistype or simply cannot
 * find. So a device entry may carry only its LAN address and the agent resolves
 * the id from its own linked devices. This script proves both halves:
 *
 *   1. a terminal configured by LAN address alone streams events, and the flush
 *      the Worker receives is addressed with the id it resolved from the portal;
 *   2. a terminal the portal does not link exits 1 with a message naming the
 *      terminal, its address and the devices the portal does list.
 *
 * Both run the real `node isapi-bridge/agent.mjs` in a child process, because
 * the agent reads its configuration at import time.
 *
 * Exit code 0 = all checks passed. Exercised by `npm test` via
 * `npm run test:isapi-bridge`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'agent.mjs');
const PORTAL_DEVICE_ID = '22222222-2222-4222-8222-222222222222';

function terminal(port) {
  return createServer((request, response) => {
    if (!request.headers.authorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="device"' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=bnd' });
    // Two parts, the second left incomplete: the parser emits a document when
    // the NEXT boundary arrives, so this yields exactly one and keeps the
    // stream open the way a terminal holds it.
    response.write('--bnd\r\nContent-Type: application/json\r\n\r\n{"EventNotificationAlert":{"cardNo":"7777"}}\r\n');
    response.write('--bnd\r\nContent-Type: application/json\r\n\r\n');
    const keepAlive = setTimeout(() => response.end('--bnd--\r\n'), 30000);
    request.on('close', () => clearTimeout(keepAlive));
  });
}

/** Fake Worker recording event flushes and answering the linked-device list. */
function worker({ linked }) {
  const state = { flushes: [], deviceListRequests: 0 };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const reply = (payload) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.url.includes('/devices')) {
        state.deviceListRequests += 1;
        reply({ agentId: 'test-agent', items: linked });
        return;
      }
      if (request.url.includes('/events')) {
        state.flushes.push(JSON.parse(body || '{}'));
        const count = Array.isArray(JSON.parse(body || '{}').items) ? JSON.parse(body || '{}').items.length : 0;
        reply({ ok: true, accepted: count, rejected: 0 });
        return;
      }
      reply({ ok: true, items: [], serverTime: new Date().toISOString() });
    });
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function writeConfig(dir, workerPort, devices) {
  const configPath = join(dir, 'agent-config.json');
  const devicesPath = join(dir, 'isapi-devices.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      agentId: '00000000-0000-4000-a000-0000000000aa',
      agentSecret: 'resolution-test-secret-123456',
      workerUrl: `http://127.0.0.1:${workerPort}`,
      syncIntervalSeconds: 3600,
      heartbeatIntervalSeconds: 3600,
      eventFlushCount: 1,
      eventFlushSeconds: 1,
      logLevel: 'debug',
    }),
  );
  writeFileSync(devicesPath, JSON.stringify({ devices }));
  return { configPath, devicesPath };
}

function runAgent(configPath, devicesPath) {
  const child = spawn(process.execPath, [AGENT], {
    env: { ...process.env, CONFIG: configPath, DEVICES_FILE: devicesPath, ESTATEMATE_AGENT_STANDBY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '', exit: null };
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => {
    state.exit = code;
    resolve(code);
  }));
  return { child, state, exited };
}

async function waitFor(predicate, { timeoutMs = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const temporaries = [];

try {
  // ── 1. a terminal with no EstateMate device id takes it from the portal ────
  {
    const dir = mkdtempSync(join(tmpdir(), 'estatemate-resolution-'));
    temporaries.push(dir);
    const devicePort = await listen(terminal());
    const { server, state: workerState } = worker({
      linked: [
        { device_id: PORTAL_DEVICE_ID, device_name: 'Portal MinMoe', isapi_host: '127.0.0.1', isapi_port: devicePort, protocol: 'http' },
      ],
    });
    const workerPort = await listen(server);
    const { configPath, devicesPath } = writeConfig(dir, workerPort, [
      // No estateMateDeviceId: only what an installer can read off the terminal.
      { name: 'Main Gate MinMoe', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' },
    ]);

    const agent = runAgent(configPath, devicesPath);
    try {
      await waitFor(() => workerState.flushes.length > 0, { label: 'the resolved-id flush' });
      const items = workerState.flushes.flatMap((flush) => flush.items || []);
      assert.equal(workerState.deviceListRequests, 1, 'the agent should consult the linked-device list exactly once');
      assert.equal(items.length, 1, `expected 1 forwarded event, got ${items.length}`);
      assert.equal(items[0].deviceId, PORTAL_DEVICE_ID, 'the event must be addressed with the id resolved from the portal');
      assert.match(agent.state.stdout, /Resolved EstateMate device id for "Main Gate MinMoe" from the portal: 22222222-2222-4222-8222-222222222222/);
      console.log('resolution by LAN address OK: event addressed with the portal id');
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
      server.close();
    }
  }

  // ── 2. a terminal the portal does not link is refused, with an explanation ─
  {
    const dir = mkdtempSync(join(tmpdir(), 'estatemate-unlinked-'));
    temporaries.push(dir);
    const { server } = worker({
      linked: [
        { device_id: '33333333-3333-4333-8333-333333333333', device_name: 'Other Gate', isapi_host: '10.0.0.77', isapi_port: 80, protocol: 'http' },
      ],
    });
    const workerPort = await listen(server);
    const { configPath, devicesPath } = writeConfig(dir, workerPort, [
      { name: 'Unlinked Terminal', isapiHost: '192.168.1.44', isapiPort: 80, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' },
    ]);

    const agent = runAgent(configPath, devicesPath);
    const code = await agent.exited;
    server.close();
    assert.equal(code, 1, `expected exit 1 for an unlinked terminal, got ${code}`);
    assert.match(agent.state.stderr, /Terminal "Unlinked Terminal" \(http:\/\/192\.168\.1\.44:80\) has no EstateMate device id and the portal does not list it/);
    assert.match(agent.state.stderr, /Connect terminal/, 'the message must say how to fix it');
    assert.match(agent.state.stderr, /Devices linked to this agent in the portal: Other Gate \(10\.0\.0\.77:80\)/, 'the message must list what the portal has');
    console.log('unlinked terminal OK: exit 1 and an actionable message');
  }

  // ── 3. a wrong id in the file is not silently accepted ─────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'estatemate-mismatch-'));
    temporaries.push(dir);
    const devicePort = await listen(terminal());
    const { server, state: workerState } = worker({
      linked: [
        { device_id: PORTAL_DEVICE_ID, device_name: 'Portal MinMoe', isapi_host: '127.0.0.1', isapi_port: devicePort, protocol: 'http' },
      ],
    });
    const workerPort = await listen(server);
    const { configPath, devicesPath } = writeConfig(dir, workerPort, [
      // A plausible mistake: the device NAME pasted where the id belongs.
      { estateMateDeviceId: 'Main Gate MinMoe', name: 'Main Gate MinMoe', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' },
    ]);

    const agent = runAgent(configPath, devicesPath);
    try {
      await waitFor(() => workerState.flushes.length > 0, { label: 'the corrected flush' });
      const items = workerState.flushes.flatMap((flush) => flush.items || []);
      assert.equal(items[0].deviceId, PORTAL_DEVICE_ID, 'a non-UUID id must be replaced by the portal match, not trusted');
      console.log('name-instead-of-id OK: the portal match wins');
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
      server.close();
    }
  }

  console.log('ISAPI bridge device-id resolution checks passed');
  process.exit(0);
} catch (error) {
  console.error(`device-id resolution checks failed: ${error.message}`);
  process.exit(1);
} finally {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
}
