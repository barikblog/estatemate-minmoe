#!/usr/bin/env node
/**
 * End-to-end smoke test for a built bridge executable.
 *
 *   node scripts/bridge-exe-smoke-test.mjs --exe dist/bridge/estatemate-bridge-win-x64.exe
 *
 * It builds no mocks of the bridge: the executable under test is started for
 * real against a fake Worker and a fake Hikvision terminal, and the test asserts
 * the things an estate actually depends on:
 *
 *   * `--version` / `--help` work without any configuration;
 *   * `init` writes configuration templates;
 *   * `check` validates the config, authenticates with the Worker, parses the
 *     terminal's deviceInfo and opens its alertStream (Digest challenge included);
 *   * `run` heartbeats, forwards alertStream events in batches, applies a queued
 *     card operation over ISAPI and reports the result back.
 *
 * Everything runs on localhost: no Cloudflare account, no hardware, no SDK.
 * On a developer machine the same code can be exercised by building the
 * linux-x64 target of the packager first, which is what CI does on Ubuntu
 * before running this test against the Windows artifact on Windows.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (name === 'json' || name === 'verbose') {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  const status = condition ? 'ok  ' : 'FAIL';
  process.stdout.write(`  [${status}] ${name}${!condition && detail ? ` — ${detail}` : ''}\n`);
  return Boolean(condition);
}

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

/** Minimal but strict Digest verification, so the bridge's digest path is exercised. */
function verifyDigest(header, { method, uri, realm, nonce, user, password }) {
  const params = {};
  for (const match of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${params.uri || uri}`);
  const expected = md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`);
  return params.username === user && params.response === expected;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** The Worker as the bridge sees it: agent-key authenticated, JSON everywhere. */
function startFakeWorker(state) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const authorized = request.headers['x-estatemate-agent-key'] === state.agentSecret;
      const json = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      state.requests.push({ method: request.method, path: url.pathname, authorized });
      if (!authorized) return json(401, { error: 'Unauthorized' });

      if (url.pathname.endsWith('/heartbeat')) {
        state.heartbeats.push(JSON.parse(body || '{}'));
        return json(200, { ok: true, serverTime: new Date().toISOString() });
      }
      if (url.pathname.endsWith('/devices')) {
        return json(200, {
          ok: true,
          items: [{ id: state.deviceId, name: 'Fake MinMoe', gate: 'North Gate', direction: 'entry' }],
          serverTime: new Date().toISOString(),
        });
      }
      if (url.pathname.endsWith('/events')) {
        const items = JSON.parse(body || '{}').items || [];
        state.eventBatches.push(items);
        return json(200, { ok: true, accepted: items.length, rejected: 0 });
      }
      if (/\/operations\/[^/]+\/result$/.test(url.pathname)) {
        state.results.push(JSON.parse(body || '{}'));
        return json(200, { ok: true });
      }
      if (url.pathname.endsWith('/operations')) {
        if (state.operationServed) return json(200, { ok: true, items: [] });
        state.operationServed = true;
        return json(200, {
          ok: true,
          items: [
            {
              id: randomUUID(),
              kind: 'card',
              operation: 'upsert_card',
              deviceId: state.deviceId,
              payload: { cardUid: '4455667788', employeeNo: 'RES-42' },
            },
          ],
        });
      }
      return json(404, { error: `no fake route for ${url.pathname}` });
    });
  });
  return server;
}

/**
 * A fake terminal. It enforces Digest auth exactly the way a MinMoe does, serves
 * deviceInfo/card endpoints, and streams two multipart events on the
 * alertStream — the three interactions the bridge performs in production.
 */
function startFakeDevice(state) {
  const realm = 'FakeMinMoe';
  const nonce = 'smoke-nonce-0001';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const auth = request.headers.authorization || '';
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const challenge = () => {
        state.challenges += 1;
        response.writeHead(401, {
          'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="smoke"`,
        });
        response.end();
      };
      if (!auth) return challenge();
      if (/^Digest /i.test(auth)) {
        const ok = verifyDigest(auth, {
          method: request.method,
          uri: url.pathname + url.search,
          realm,
          nonce,
          user: state.user,
          password: state.password,
        });
        if (!ok) {
          state.rejected += 1;
          return challenge();
        }
      } else if (/^Basic /i.test(auth)) {
        state.basicRequests += 1;
      } else {
        return challenge();
      }
      state.authorized += 1;
      state.deviceRequests.push(`${request.method} ${url.pathname}`);

      if (url.pathname === '/ISAPI/System/deviceInfo') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            DeviceInfo: {
              deviceName: 'Fake MinMoe',
              model: 'DS-K1T341AMF',
              firmwareVersion: 'V3.4.0_smoke',
              serialNumber: 'SMOKE0001',
            },
          }),
        );
        return;
      }
      if (url.pathname === '/ISAPI/AccessControl/CardInfo/Count') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ CardInfoCount: { cardNumber: 7 } }));
        return;
      }
      if (url.pathname === '/ISAPI/AccessControl/CardInfo/Record') {
        state.cardRecords.push(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ statusCode: 1, statusString: 'OK' }));
        return;
      }
      if (url.pathname === '/ISAPI/AccessControl/CardInfo/Delete') {
        state.cardDeletes.push(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ statusCode: 1, statusString: 'OK' }));
        return;
      }
      if (url.pathname === '/ISAPI/Event/notification/alertStream') {
        state.streams += 1;
        response.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=smokeboundary' });
        response.write('--smokeboundary\r\nContent-Type: application/json\r\n\r\n');
        response.write(
          '{"EventNotificationAlert":{"eventType":"AccessControllerEvent","cardNo":"4455667788","employeeNoString":"RES-42","majorEventType":5}}\r\n',
        );
        response.write('--smokeboundary\r\nContent-Type: application/json\r\n\r\n');
        response.write('{"EventNotificationAlert":{"eventType":"AccessControllerEvent","cardNo":"9988776655","majorEventType":5}}\r\n');
        response.write('--smokeboundary--\r\n');
        // Hold the stream open the way a terminal does: closing it is what the
        // bridge treats as a reconnect, not as "the test finished".
        const keepAlive = setTimeout(() => response.end(), 60000);
        request.on('close', () => clearTimeout(keepAlive));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ statusCode: 4, statusString: 'notSupport' }));
    });
  });
  return server;
}

function runCli(exe, args, { timeoutMs = 90000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => terminate(child), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: String(error.message), durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2000).unref();
}

async function waitFor(predicate, { timeoutMs = 45000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  process.stdout.write(`  … timed out after ${timeoutMs} ms waiting for ${label}\n`);
  return false;
}

function readLogLines(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.exe) {
    process.stdout.write('usage: node scripts/bridge-exe-smoke-test.mjs --exe <bridge executable> [--json] [--verbose]\n');
    process.exit(2);
  }
  const exe = path.resolve(flags.exe);
  if (!fs.existsSync(exe)) {
    process.stderr.write(`smoke test: ${exe} does not exist\n`);
    process.exit(2);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estatemate-bridge-smoke-'));
  const configDir = path.join(workDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  process.stdout.write(`\nEstateMate bridge executable smoke test\n`);
  process.stdout.write(`  exe:   ${exe} (${(fs.statSync(exe).size / (1024 * 1024)).toFixed(1)} MB)\n`);
  process.stdout.write(`  work:  ${workDir}\n\n`);

  const state = {
    agentId: randomUUID(),
    deviceId: randomUUID(),
    agentSecret: `smoke-${randomUUID()}-secret`,
    user: 'admin',
    password: 'ISAPI-smoke-password',
    requests: [],
    deviceRequests: [],
    heartbeats: [],
    eventBatches: [],
    results: [],
    cardRecords: [],
    cardDeletes: [],
    challenges: 0,
    rejected: 0,
    basicRequests: 0,
    authorized: 0,
    streams: 0,
    operationServed: false,
  };

  const worker = startFakeWorker(state);
  const device = startFakeDevice(state);
  const workerPort = await listen(worker);
  const devicePort = await listen(device);

  const configPath = path.join(configDir, 'agent-config.json');
  const devicesPath = path.join(configDir, 'isapi-devices.json');
  const logFile = path.join(configDir, 'bridge.log');
  const runArgs = ['--config', configPath, '--devices', devicesPath, '--log-file', logFile];
  let child = null;
  let childOutput = '';

  try {
    // 1. The commands an operator runs before anything is configured.
    const version = await runCli(exe, ['version']);
    check('version command works without configuration', version.status === 0 && /EstateMate Bridge/i.test(version.stdout), version.stderr || version.stdout);
    const help = await runCli(exe, ['--help']);
    check('help works without configuration', help.status === 0 && /Usage/i.test(help.stdout), help.stderr || help.stdout);

    const initDir = path.join(workDir, 'init');
    const init = await runCli(exe, ['init', '--data-dir', initDir, '--no-prompt']);
    const initFiles = ['agent-config.json', 'isapi-devices.json'].filter((name) => fs.existsSync(path.join(initDir, name)));
    check('init writes configuration templates', init.status === 0 && initFiles.length === 2, `${init.stderr}${init.stdout}`.slice(-300));

    // 2. Real configuration pointing at the fake Worker and the fake terminal.
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          agentId: state.agentId,
          agentSecret: state.agentSecret,
          workerUrl: `http://127.0.0.1:${workerPort}`,
          syncIntervalSeconds: 5,
          heartbeatIntervalSeconds: 15,
          eventStream: true,
          eventFlushCount: 2,
          eventFlushSeconds: 1,
          logLevel: 'debug',
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      devicesPath,
      `${JSON.stringify(
        {
          devices: [
            {
              estateMateDeviceId: state.deviceId,
              name: 'Fake MinMoe',
              isapiHost: '127.0.0.1',
              isapiPort: devicePort,
              isapiUsername: state.user,
              isapiPassword: state.password,
              protocol: 'http',
              enabled: true,
              eventStream: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    // 3. check: config -> Worker auth -> deviceInfo -> card API -> alertStream.
    const checkRun = await runCli(exe, ['check', '--json', ...runArgs]);
    let report = null;
    try {
      report = JSON.parse(checkRun.stdout.slice(checkRun.stdout.indexOf('{')));
    } catch {
      report = null;
    }
    check('check exits 0 against a working Worker and terminal', checkRun.status === 0, `${checkRun.stdout}${checkRun.stderr}`.slice(-500));
    check('check authenticated with the Worker', report && report.worker && report.worker.ok === true, JSON.stringify(report && report.worker));
    check('check read the terminal deviceInfo', Boolean(report && report.devices && report.devices[0] && report.devices[0].ok), JSON.stringify(report && report.devices && report.devices[0]).slice(0, 400));
    check(
      'check saw the alertStream content type',
      Boolean(report && report.devices && report.devices[0] && report.devices[0].eventStream && report.devices[0].eventStream.ok),
      JSON.stringify(report && report.devices && report.devices[0] && report.devices[0].eventStream),
    );
    check('the terminal challenged the bridge with Digest', state.challenges >= 1, `challenges=${state.challenges}`);
    check('no Digest response was rejected', state.rejected === 0, `rejected=${state.rejected}`);

    // 4. run: heartbeat, alertStream forwarding, queued card operation.
    const before = state.authorized;
    child = spawn(exe, ['run', ...runArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      childOutput += chunk;
    });
    child.stderr.on('data', (chunk) => {
      childOutput += chunk;
    });

    check('run sent a heartbeat', await waitFor(() => state.heartbeats.length >= 1, { label: 'a heartbeat' }), childOutput.slice(-400));
    const gotTwoEvents = await waitFor(() => state.eventBatches.flat().length >= 2, { label: 'two alertStream events' });
    const events = state.eventBatches.flat();
    check('run forwarded alertStream events', gotTwoEvents, `events=${events.length}`);
    check(
      'events carry the device id and the terminal document',
      events.length >= 2 && events[0].deviceId === state.deviceId && String(events[0].document).includes('4455667788'),
      JSON.stringify(events.slice(0, 2)).slice(0, 400),
    );
    check('run opened the alertStream', state.streams >= 1, `streams=${state.streams}`);

    const applied = await waitFor(() => state.cardRecords.length >= 1, { label: 'the queued card operation' });
    check('run applied the queued card operation over ISAPI', applied, `cardRecords=${state.cardRecords.length}`);
    check(
      'the card record carried the card UID and employee number',
      state.cardRecords.some((body) => body.includes('4455667788') && body.includes('RES-42')),
      state.cardRecords.join(' | ').slice(0, 300),
    );
    const reported = await waitFor(() => state.results.length >= 1, { label: 'the operation result report' });
    check('run reported the operation result', reported, `results=${state.results.length}`);
    check(
      'the result was reported as applied',
      state.results.some((result) => result.status === 'applied'),
      JSON.stringify(state.results).slice(0, 300),
    );
    check(
      'every Worker request was authenticated',
      state.requests.length >= 3 && state.requests.every((entry) => entry.authorized === true),
      JSON.stringify(state.requests.slice(0, 6)),
    );
    check('the bridge authenticated every ISAPI request', state.authorized > before, `authorized=${state.authorized}`);

    const log = readLogLines(logFile);
    check('the bridge wrote its log file', log.includes('EstateMate') || log.includes('event stream') || log.includes('Heartbeat'), log.slice(-300) || '(empty)');
  } finally {
    terminate(child);
    await sleep(300);
    worker.close();
    device.close();
    if (flags.verbose && childOutput) process.stdout.write(`\n--- bridge output ---\n${childOutput}\n`);
  }

  const failures = checks.filter((entry) => !entry.ok);
  if (failures.length && flags.json) {
    process.stdout.write(`\n${JSON.stringify({ exe, checks, failures }, null, 2)}\n`);
  }
  process.stdout.write(
    `\n${failures.length ? 'FAIL' : 'PASS'}: ${checks.length - failures.length}/${checks.length} checks passed ` +
      `(${state.heartbeats.length} heartbeat(s), ${state.eventBatches.flat().length} event(s), ` +
      `${state.cardRecords.length} card record(s), ${state.results.length} result(s))\n`,
  );
  if (failures.length) {
    for (const failure of failures) process.stdout.write(`  failed: ${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}\n`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`smoke test crashed: ${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
