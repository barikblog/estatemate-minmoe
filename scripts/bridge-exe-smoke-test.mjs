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
 *   * the `setup` wizard turns the portal's "Download setup" script into a working
 *     configuration (by path and piped on stdin), never echoes the agent secret,
 *     and is never entered when there is no console to answer on;
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

/**
 * GitHub renders workflow failure messages only in the job log, which the
 * sandboxed reviewers of this repository cannot always fetch. Surface the
 * message as a check annotation too, so a red run explains itself.
 */
function annotateError(error) {
  if (!process.env.GITHUB_ACTIONS) return;
  const message = String((error && error.message) || error).replace(/[\r\n]+/g, ' | ').slice(0, 3000);
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error::${escaped}`);
}


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
              payload: { cardUid: '4455667788', employeeNo: 'RES42' },
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
/** The fake terminal's wall clock rendered in a zone, the way it reports it. */
function wallClockInZone(instantMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

/** The instant a wall-clock reading names in a zone (the inverse of the above). */
function instantFromWallClockInZone(date, time, timeZone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute, second] = String(time).split(':').map(Number);
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (instantMs) => {
    const rendered = wallClockInZone(instantMs, timeZone);
    const [y, mo, d] = rendered.date.split('-').map(Number);
    const [h, mi, s] = rendered.time.split(':').map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(instantMs / 1000) * 1000;
  };
  const candidate = asIfUtc - offsetAt(asIfUtc);
  return asIfUtc - offsetAt(candidate);
}

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
      if (url.pathname === '/ISAPI/System/time/Get') {
        const { date, time } = wallClockInZone(state.terminalClockMs, 'Africa/Lagos');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ time: { date, time, timeType: 'local' } }));
        return;
      }
      if (url.pathname === '/ISAPI/System/time/Set') {
        state.timeSets.push(body);
        const clock = JSON.parse(body || '{}').time || {};
        // The terminal applies the wall clock in the zone the bridge sent —
        // that is what re-zoning with the clock set means.
        const zone = typeof clock.timeZone === 'string' && clock.timeZone.trim() ? clock.timeZone.trim() : 'Africa/Lagos';
        state.terminalClockMs = instantFromWallClockInZone(clock.date, clock.time, zone);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ statusCode: 1, statusString: 'OK' }));
        return;
      }
      if (url.pathname === '/ISAPI/Event/notification/alertStream') {
        state.streams += 1;
        response.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=smokeboundary' });
        response.write('--smokeboundary\r\nContent-Type: application/json\r\n\r\n');
        response.write(
          '{"EventNotificationAlert":{"eventType":"AccessControllerEvent","cardNo":"4455667788","employeeNoString":"RES42","majorEventType":5}}\r\n',
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

function runCli(exe, args, { timeoutMs = 90000, input = null } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    // `--from-installer -` reads the script from stdin, which is how a technician
    // pipes the portal's file in: Get-Content installer.ps1 | .\exe setup --from-installer -
    if (input !== null) child.stdin.end(input);
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

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The file the portal's "Download setup" button produces for a Windows agent,
 * reduced to what the setup wizard parses: `$agentId`, `$agentSecret`,
 * `$installerKey` and `$workerUrl`. Kept byte-shaped like the Worker's
 * /api/isapi/agents/:id/installer response on purpose — if the portal ever
 * renames one of those variables, this test fails before a technician sees
 * "no agentId/agentSecret found".
 */
function portalInstallerScript({ agentId, agentSecret, installerKey, workerUrl, name = 'Smoke PC' }) {
  return `# EstateMate Windows ISAPI Agent Installer
# Agent: ${name} (${agentId})
# This script is one-time use and expires in 24 hours.

$ErrorActionPreference = "Stop"
Write-Host "Installing EstateMate ISAPI Bridge Agent..." -ForegroundColor Cyan

$agentId = "${agentId}"
$agentSecret = "${agentSecret}"
$installerKey = "${installerKey}"
$workerUrl = "${workerUrl}"
`;
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
    // The fake terminal's own clock, mutable through /ISAPI/System/time/Set.
    // It starts 2h ahead; the wall clock it reports is rendered in the zone the
    // sync-clocks configuration chooses (Africa/Lagos), the way a terminal in
    // that zone would report it.
    terminalClockMs: Date.now() + 2 * 60 * 60 * 1000,
    timeSets: [],
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

    // 1b. Nothing to answer with: the wizard must never be entered when there is
    //     no console. A Scheduled Task or a service starts this executable with
    //     no arguments on a machine whose configuration is not there yet, and it
    //     has to fail with instructions rather than wait for a keypress forever.
    const headless = await runCli(exe, [], { timeoutMs: 20000 });
    const headlessText = `${headless.stdout}${headless.stderr}`;
    check(
      'an unconfigured exe with no console refuses instead of prompting',
      headless.status === 2 && /cannot start until the configuration is fixed/i.test(headlessText) && !/Installer script path/i.test(headlessText),
      `status=${headless.status} ${headlessText}`.slice(-400),
    );

    // 1c. The setup wizard: the portal's "Download setup" file becomes a working
    //     configuration with no hand-edited JSON, which is what the executable on
    //     the releases page is expected to do first on an estate PC.
    const wizardDir = path.join(workDir, 'wizard');
    const installerPath = path.join(workDir, 'estatemate-isapi-agent.ps1');
    const installerKey = `installer-${randomUUID()}`;
    const wizardSecret = `wizard-${randomUUID()}-secret`;
    const installerScript = portalInstallerScript({
      agentId: state.agentId,
      agentSecret: wizardSecret,
      installerKey,
      workerUrl: `http://127.0.0.1:${workerPort}`,
    });
    fs.writeFileSync(installerPath, installerScript);

    const wizardDevicesPath = path.join(workDir, 'wizard-devices.json');
    const wizardDevice = {
      estateMateDeviceId: state.deviceId,
      name: 'Wizard terminal',
      isapiHost: '127.0.0.1',
      isapiPort: devicePort,
      isapiUsername: state.user,
      isapiPassword: state.password,
      protocol: 'http',
      enabled: true,
      eventStream: false,
    };
    fs.writeFileSync(wizardDevicesPath, `${JSON.stringify({ devices: [wizardDevice] }, null, 2)}\n`);

    const wizard = await runCli(exe, [
      'setup',
      '--no-prompt',
      '--no-verify',
      '--from-installer',
      installerPath,
      '--devices-json',
      wizardDevicesPath,
      '--data-dir',
      wizardDir,
      '--log-file',
      path.join(wizardDir, 'bridge.log'),
    ]);
    const wizardOutput = `${wizard.stdout}${wizard.stderr}`;
    const wizardConfig = readJsonIfExists(path.join(wizardDir, 'agent-config.json'));
    const wizardDevices = readJsonIfExists(path.join(wizardDir, 'isapi-devices.json'));
    check(
      'setup wizard accepts the portal installer script',
      wizard.status === 0 && Boolean(wizardConfig) && wizardConfig.agentId === state.agentId,
      `status=${wizard.status} ${wizardOutput}`.slice(-400),
    );
    check(
      'setup wizard writes the agent secret, Worker URL and installer key',
      Boolean(wizardConfig) &&
        wizardConfig.agentSecret === wizardSecret &&
        wizardConfig.workerUrl === `http://127.0.0.1:${workerPort}` &&
        wizardConfig.installerKey === installerKey,
      JSON.stringify(wizardConfig && { ...wizardConfig, agentSecret: '***' }),
    );
    check(
      'setup wizard writes the terminal list it was given',
      Boolean(wizardDevices) &&
        wizardDevices.devices?.length === 1 &&
        wizardDevices.devices[0].isapiHost === '127.0.0.1' &&
        Number(wizardDevices.devices[0].isapiPort) === devicePort &&
        wizardDevices.devices[0].estateMateDeviceId === state.deviceId,
      JSON.stringify(wizardDevices),
    );
    check('setup wizard never echoes the agent secret', !wizardOutput.includes(wizardSecret), 'the one-time secret appeared in the wizard output');
    check('setup wizard reports the next commands', /Setup complete/i.test(wizardOutput) && /install-service/.test(wizardOutput), wizardOutput.slice(-300));

    // The same wizard, with the installer piped in instead of named.
    const pipedDir = path.join(workDir, 'wizard-piped');
    const piped = await runCli(
      exe,
      ['setup', '--no-prompt', '--no-verify', '--from-installer', '-', '--devices-json', wizardDevicesPath, '--data-dir', pipedDir, '--log-file', path.join(pipedDir, 'bridge.log')],
      { input: installerScript },
    );
    const pipedConfig = readJsonIfExists(path.join(pipedDir, 'agent-config.json'));
    check(
      'setup wizard reads the installer from stdin (--from-installer -)',
      piped.status === 0 && Boolean(pipedConfig) && pipedConfig.agentId === state.agentId && pipedConfig.agentSecret === wizardSecret,
      `status=${piped.status} ${piped.stderr}${piped.stdout}`.slice(-300),
    );

    // 1d. The same configuration, typed instead of imported: this is the path the
    //     Windows dashboard uses when there is no portal script to point at, so it
    //     must produce the identical files (and keep the secret out of the output).
    const manualDir = path.join(workDir, 'manual');
    const manualSecret = `manual-${randomUUID()}-secret`;
    const manual = await runCli(exe, [
      'setup',
      '--no-prompt',
      '--no-verify',
      '--agent-id',
      state.agentId,
      '--agent-secret',
      manualSecret,
      '--worker-url',
      `http://127.0.0.1:${workerPort}`,
      '--devices-json',
      wizardDevicesPath,
      '--data-dir',
      manualDir,
      '--log-file',
      path.join(manualDir, 'bridge.log'),
    ]);
    const manualOutput = `${manual.stdout}${manual.stderr}`;
    const manualConfig = readJsonIfExists(path.join(manualDir, 'agent-config.json'));
    const manualDevices = readJsonIfExists(path.join(manualDir, 'isapi-devices.json'));
    check(
      'setup accepts a hand-typed agent id, secret and Worker URL',
      manual.status === 0 &&
        Boolean(manualConfig) &&
        manualConfig.agentId === state.agentId &&
        manualConfig.agentSecret === manualSecret &&
        manualConfig.workerUrl === `http://127.0.0.1:${workerPort}`,
      `status=${manual.status} ${manualOutput}`.slice(-400),
    );
    check(
      'the hand-typed path writes the terminal list too',
      Boolean(manualDevices) && manualDevices.devices?.length === 1 && manualDevices.devices[0].estateMateDeviceId === state.deviceId,
      JSON.stringify(manualDevices),
    );
    check('the hand-typed path never echoes the agent secret', !manualOutput.includes(manualSecret), 'the secret appeared in the setup output');
    const badId = await runCli(exe, ['setup', '--no-prompt', '--no-verify', '--agent-id', 'not-a-uuid', '--agent-secret', manualSecret, '--data-dir', path.join(workDir, 'manual-bad')]);
    check(
      'setup refuses an agent id that is not a UUID',
      badId.status !== 0 && /not an agent id/i.test(`${badId.stdout}${badId.stderr}`),
      `status=${badId.status} ${badId.stderr}${badId.stdout}`.slice(-300),
    );

    // 1e. Terminal clock sync plumbing: the CLI flag (what the Windows
    //     dashboard's checkbox sends), the interactive ask, the default-off
    //     fresh setup, and the thresholds a re-save must preserve.
    const syncSetup = (dir, extraArgs) => runCli(exe, [
      'setup', '--no-prompt', '--no-verify',
      '--agent-id', state.agentId,
      '--agent-secret', manualSecret,
      '--worker-url', `http://127.0.0.1:${workerPort}`,
      '--devices-json', wizardDevicesPath,
      ...extraArgs,
      '--data-dir', dir,
      '--log-file', path.join(dir, 'bridge.log'),
    ]);

    const syncOnDir = path.join(workDir, 'time-sync-on');
    const syncOn = await syncSetup(syncOnDir, ['--time-sync-enabled=true']);
    const syncOnConfig = readJsonIfExists(path.join(syncOnDir, 'agent-config.json'));
    check(
      'setup --time-sync-enabled=true writes terminal clock sync on',
      syncOn.status === 0 && Boolean(syncOnConfig) && syncOnConfig.timeSync?.enabled === true,
      `status=${syncOn.status} timeSync=${JSON.stringify(syncOnConfig && syncOnConfig.timeSync)}`,
    );

    const syncOffDir = path.join(workDir, 'time-sync-off');
    const syncOff = await syncSetup(syncOffDir, ['--time-sync-enabled=false']);
    const syncOffConfig = readJsonIfExists(path.join(syncOffDir, 'agent-config.json'));
    check(
      'setup --time-sync-enabled=false writes terminal clock sync off',
      syncOff.status === 0 && Boolean(syncOffConfig) && syncOffConfig.timeSync?.enabled === false,
      `status=${syncOff.status} timeSync=${JSON.stringify(syncOffConfig && syncOffConfig.timeSync)}`,
    );

    const syncDefaultDir = path.join(workDir, 'time-sync-default');
    const syncDefault = await syncSetup(syncDefaultDir, []);
    const syncDefaultConfig = readJsonIfExists(path.join(syncDefaultDir, 'agent-config.json'));
    check(
      'a fresh setup without the flag keeps terminal clock sync off',
      syncDefault.status === 0 && Boolean(syncDefaultConfig) && syncDefaultConfig.timeSync?.enabled === false,
      `status=${syncDefault.status} timeSync=${JSON.stringify(syncDefaultConfig && syncDefaultConfig.timeSync)}`,
    );

    // The dashboard's save path: the configuration on disk already carries
    // thresholds and a chosen zone, and saving again (with the checkbox
    // flipped and no zone flag) must keep both.
    const preserveDir = path.join(workDir, 'time-sync-preserve');
    fs.mkdirSync(preserveDir, { recursive: true });
    fs.writeFileSync(
      path.join(preserveDir, 'agent-config.json'),
      `${JSON.stringify({
        agentId: state.agentId,
        agentSecret: manualSecret,
        workerUrl: `http://127.0.0.1:${workerPort}`,
        timeSync: { enabled: true, maxDriftMs: 90000, checkIntervalMinutes: 45, timeZone: 'Africa/Lagos' },
      }, null, 2)}\n`,
    );
    const preserve = await syncSetup(preserveDir, ['--time-sync-enabled=false']);
    const preserveConfig = readJsonIfExists(path.join(preserveDir, 'agent-config.json'));
    check(
      'saving preserves the existing sync thresholds and zone',
      preserve.status === 0 && Boolean(preserveConfig)
        && preserveConfig.timeSync?.enabled === false
        && preserveConfig.timeSync?.maxDriftMs === 90000
        && preserveConfig.timeSync?.checkIntervalMinutes === 45
        && preserveConfig.timeSync?.timeZone === 'Africa/Lagos',
      `status=${preserve.status} timeSync=${JSON.stringify(preserveConfig && preserveConfig.timeSync)}`,
    );

    // The interactive wizard asks about clock sync and honours the answer.
    const askDir = path.join(workDir, 'time-sync-ask');
    const asked = await runCli(exe, [
      'setup', '--no-verify',
      '--from-installer', installerPath,
      '--devices-json', wizardDevicesPath,
      '--data-dir', askDir,
      '--log-file', path.join(askDir, 'bridge.log'),
    ], { input: 'y\n' });
    const askConfig = readJsonIfExists(path.join(askDir, 'agent-config.json'));
    check(
      'the setup wizard asks about terminal clock sync and honours the answer',
      asked.status === 0 && Boolean(askConfig) && askConfig.timeSync?.enabled === true,
      `status=${asked.status} timeSync=${JSON.stringify(askConfig && askConfig.timeSync)}`,
    );

    // 1f. The time-zone chooser (the --time-sync-timezone flag) and the
    //     synchronisation button's command (sync-clocks), end to end against
    //     the fake terminal, whose clock starts 2h ahead in Africa/Lagos.
    const zoneDir = path.join(workDir, 'time-sync-zone');
    const zone = await syncSetup(zoneDir, ['--time-sync-timezone=Africa/Lagos']);
    const zoneConfig = readJsonIfExists(path.join(zoneDir, 'agent-config.json'));
    check(
      'setup --time-sync-timezone saves the chosen zone',
      zone.status === 0 && Boolean(zoneConfig) && zoneConfig.timeSync?.timeZone === 'Africa/Lagos',
      `status=${zone.status} timeSync=${JSON.stringify(zoneConfig && zoneConfig.timeSync)}`,
    );

    const zoneClearDir = path.join(workDir, 'time-sync-zone-clear');
    const zoneClear = await syncSetup(zoneClearDir, ['--time-sync-timezone=']);
    const zoneClearConfig = readJsonIfExists(path.join(zoneClearDir, 'agent-config.json'));
    check(
      'setup --time-sync-timezone= (empty) clears the zone',
      zoneClear.status === 0 && Boolean(zoneClearConfig) && !zoneClearConfig.timeSync?.timeZone,
      `status=${zoneClear.status} timeSync=${JSON.stringify(zoneClearConfig && zoneClearConfig.timeSync)}`,
    );

    const zoneBad = await runCli(exe, ['setup', '--no-prompt', '--no-verify', '--agent-id', state.agentId, '--agent-secret', manualSecret, '--time-sync-timezone=Mars/Olympus', '--data-dir', path.join(workDir, 'time-sync-zone-bad')]);
    check(
      'setup rejects a time zone that is not an IANA zone',
      zoneBad.status !== 0 && /IANA time zone/i.test(`${zoneBad.stdout}${zoneBad.stderr}`),
      `status=${zoneBad.status} ${zoneBad.stderr}${zoneBad.stdout}`.slice(-300),
    );

    const clocksDir = path.join(workDir, 'sync-clocks');
    fs.mkdirSync(clocksDir, { recursive: true });
    const clocksConfigPath = path.join(clocksDir, 'agent-config.json');
    const clocksDevicesPath = path.join(clocksDir, 'isapi-devices.json');
    fs.writeFileSync(
      clocksDevicesPath,
      `${JSON.stringify({
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
            eventStream: false,
          },
        ],
      }, null, 2)}\n`,
    );
    const writeClocksConfig = (enabled) => fs.writeFileSync(
      clocksConfigPath,
      `${JSON.stringify({
        agentId: state.agentId,
        agentSecret: state.agentSecret,
        workerUrl: `http://127.0.0.1:${workerPort}`,
        eventStream: false,
        logLevel: 'info',
        timeSync: { enabled, maxDriftMs: 30000, checkIntervalMinutes: 15, timeZone: 'Africa/Lagos' },
      }, null, 2)}\n`,
    );
    writeClocksConfig(true);
    const clocksArgs = ['sync-clocks', '--config', clocksConfigPath, '--devices', clocksDevicesPath, '--log-file', path.join(clocksDir, 'bridge.log')];
    const timeSetsBefore = state.timeSets.length;
    const firstPass = await runCli(exe, clocksArgs);
    const firstOutput = `${firstPass.stdout}${firstPass.stderr}`;
    const setBody = state.timeSets.length > timeSetsBefore ? JSON.parse(state.timeSets[state.timeSets.length - 1]) : null;
    const setInstant = setBody ? instantFromWallClockInZone(setBody.time.date, setBody.time.time, 'Africa/Lagos') : null;
    check(
      'sync-clocks synchronises a drifted terminal in the chosen zone',
      firstPass.status === 0
        && Boolean(setBody)
        && setBody.time.timeZone === 'Africa/Lagos'
        && setBody.time.timeType === 'local'
        && Boolean(setInstant)
        && Math.abs(setInstant - Date.now()) <= 5000
        && Math.abs(state.terminalClockMs - Date.now()) <= 5000,
      `status=${firstPass.status} set=${JSON.stringify(setBody)} terminalClock=${state.terminalClockMs}`,
    );
    check(
      'sync-clocks reports the terminal, its drift and the chosen zone',
      firstPass.status === 0
        && firstOutput.includes('Fake MinMoe')
        && /off by \d+s/.test(firstOutput)
        && firstOutput.includes('Africa/Lagos'),
      firstOutput.slice(-400),
    );

    const secondPass = await runCli(exe, clocksArgs);
    const secondOutput = `${secondPass.stdout}${secondPass.stderr}`;
    check(
      'a second sync-clocks pass finds the clock within tolerance',
      secondPass.status === 0
        && state.timeSets.length === timeSetsBefore + 1
        && secondOutput.includes('within tolerance'),
      `status=${secondPass.status} sets=${state.timeSets.length} ${secondOutput}`.slice(-300),
    );

    // The button's command runs on demand even when the automatic sync is off.
    writeClocksConfig(false);
    const offPass = await runCli(exe, clocksArgs);
    const offOutput = `${offPass.stdout}${offPass.stderr}`;
    check(
      'sync-clocks runs even when automatic sync is off',
      offPass.status === 0
        && offOutput.includes('Fake MinMoe')
        && /automatic sync: off/.test(offOutput),
      `status=${offPass.status} ${offOutput}`.slice(-300),
    );

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
      state.cardRecords.some((body) => body.includes('4455667788') && body.includes('RES42')),
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
  annotateError(error);
  process.exit(2);
});
