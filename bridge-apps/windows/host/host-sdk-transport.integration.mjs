#!/usr/bin/env node
/**
 * The Windows host tooling vs. a terminal on Hikvision's SDK transport.
 *
 * `bridge check` and `bridge setup` are what a technician runs on the gate PC,
 * and they read the same `isapi-devices.json` the agent does. Before this file
 * existed, that tooling knew only about ISAPI: an SDK device was reported as
 * *"has no isapiHost"* (a configuration error) and then, if it survived that,
 * *"no usable device entries"*. A site whose only path to its terminal is the
 * SDK port would be told its correct configuration is broken — which is worse
 * than unhelpful, because the next thing a technician does is "fix" it.
 *
 * So these checks pin the two surfaces that decide that:
 *
 *   - `validateDevicesConfig` (bridge-apps/windows/host/config.cjs) accepts an
 *     SDK entry on its own fields, still errors on a malformed ISAPI entry, and
 *     still reports a missing sdkHost/sdkPort;
 *   - `runCheck` (diagnostics.cjs) reports an SDK terminal as **SKIP** with its
 *     real address and what to verify it with, exits 0 when everything else is
 *     healthy, and never claims it probed a terminal it has no client for;
 *   - an SDK device with no EstateMate device id and no matching portal row is
 *     still a failure (exit 1) — the one thing `check` must not do is pass a
 *     terminal the bridge will refuse to start on.
 *
 * No terminal, no Worker and no vendor SDK: a local HTTP server answers as the
 * Worker, and the agent module is loaded in standby so nothing dials the gate.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:hik-sdk`.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

process.env.ESTATEMATE_AGENT_STANDBY = '1';

const { validateDevicesConfig } = require(join(here, 'config.cjs'));
const { runCheck } = require(join(here, 'diagnostics.cjs'));

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

const dir = mkdtempSync(join(tmpdir(), 'estatemate-host-sdk-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const SDK_DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const sdkEntry = {
  estateMateDeviceId: SDK_DEVICE_ID,
  name: 'Main Gate (SDK transport)',
  transport: 'hik_sdk',
  sdkHost: '192.168.88.60',
  sdkPort: 8000,
  sdkUsername: 'admin',
  sdkPassword: 'device-admin-password',
  enabled: true,
  eventStream: true,
};

console.log('Windows host checks: Hikvision SDK transport');

// ── 1. Device-file validation ────────────────────────────────────────────────
{
  const valid = validateDevicesConfig({ devices: [sdkEntry] });
  check('an SDK device is valid configuration, not "a terminal with no isapiHost"',
    valid.errors.length === 0, JSON.stringify(valid.errors));
  check('and its own fields are what gets checked',
    !valid.warnings.some((warning) => warning.includes('isapi')) && !valid.warnings.some((warning) => warning.includes('sdkPassword')),
    JSON.stringify(valid.warnings));

  const noHost = validateDevicesConfig({ devices: [{ ...sdkEntry, sdkHost: '' }] });
  check('an SDK device with no sdkHost is an error that names the field',
    noHost.errors.some((error) => error.includes('no sdkHost')), JSON.stringify(noHost.errors));

  const badPort = validateDevicesConfig({ devices: [{ ...sdkEntry, sdkPort: 70000 }] });
  check('an impossible sdkPort is an error, and the default stays 8000',
    badPort.errors.some((error) => error.includes('sdkPort')) && Number(sdkEntry.sdkPort) === 8000, JSON.stringify(badPort.errors));

  const noPassword = validateDevicesConfig({ devices: [{ ...sdkEntry, sdkPassword: '' }] });
  check('a missing sdkPassword is a warning about the SDK login, not about ISAPI auth',
    noPassword.warnings.some((warning) => warning.includes('sdkPassword') && warning.includes('SDK login'))
      && !noPassword.warnings.some((warning) => warning.includes('ISAPI authentication')), JSON.stringify(noPassword.warnings));

  const isapiRegression = validateDevicesConfig({ devices: [{ name: 'MinMoe', isapiUsername: 'admin', isapiPassword: 'x' }] });
  check('an ISAPI device is still required to have an address (no relaxation)',
    isapiRegression.errors.some((error) => error.includes('no isapiHost')), JSON.stringify(isapiRegression.errors));

  const noId = validateDevicesConfig({ devices: [{ ...sdkEntry, estateMateDeviceId: '' }] });
  check('a missing device id says how an SDK terminal is matched, not "by LAN address"',
    noId.warnings.some((warning) => warning.includes('sdkHost:sdkPort (192.168.88.60:8000)')), JSON.stringify(noId.warnings));
}

// ── 2. `bridge check` against a fake Worker ──────────────────────────────────
async function withWorker(linkedRows, devices, run) {
  const seen = { auth: null, urls: [] };
  const server = createServer((request, response) => {
    seen.urls.push(request.url);
    seen.auth = request.headers['x-agent-secret'] || request.headers.authorization || null;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ agentId: AGENT_ID, items: linkedRows, serverTime: new Date().toISOString() }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const configPath = join(dir, `agent-config-${port}.json`);
    const devicesPath = join(dir, `isapi-devices-${port}.json`);
    writeFileSync(configPath, JSON.stringify({
      agentId: AGENT_ID,
      agentSecret: 'a-very-long-agent-secret-value',
      workerUrl: `http://127.0.0.1:${port}`,
      logLevel: 'debug',
      eventStream: true,
    }));
    writeFileSync(devicesPath, JSON.stringify({ devices }));
    const deviceFile = { devices };
    const lines = [];
    const logger = {
      raw: (text = '') => lines.push(String(text)),
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const code = await runCheck({
      ctx: {
        version: 'test',
        commit: 'test',
        nodeVersion: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        exePath: join(here, 'unit-test'),
        paths: { configPath, devicesPath, configSource: 'test', devicesSource: 'test' },
        agentEntry: fileURLToPath(new URL('../../../isapi-bridge/agent.mjs', import.meta.url)),
        config: JSON.parse(require('node:fs').readFileSync(configPath, 'utf8')),
        devicesFile: deviceFile,
        configValidation: { errors: [], warnings: [] },
        devicesValidation: validateDevicesConfig(deviceFile),
      },
      logger,
      json: false,
    });
    return run(code, { lines, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

{
  const report = await withWorker(
    [{ device_id: SDK_DEVICE_ID, device_name: 'Main Gate', isapi_host: '192.168.88.60', isapi_port: 8000 }],
    [sdkEntry],
    (code, { lines, seen }) => ({ code, text: lines.join('\n'), seen }),
  );
  check('an SDK-only devices file is a usable configuration',
    report.code === 0 && !report.text.includes('no usable device entries'), `exit=${report.code}\n${report.text}`);
  check('the check authenticates with the Worker before judging anything',
    report.seen.urls.some((url) => url.includes('/devices')), JSON.stringify(report.seen.urls));
  check('the terminal is listed with its SDK address, not an invented http://:80',
    report.text.includes(`hik_sdk://192.168.88.60:8000`) && !report.text.includes('http://:80'), report.text);
  check('and it is marked SKIP, so nobody reads it as a probed OK',
    report.text.includes('[SKIP] Main Gate (SDK transport)') && !report.text.includes('[OK  ] Main Gate (SDK transport)'), report.text);
  check('the note says what to verify it with instead',
    report.text.includes('--selftest 192.168.88.60:8000 admin') && report.text.includes('sdkTransport'), report.text);
  check('the summary does not claim every check passed while a terminal was unverified',
    report.text.includes('NOTE') && !report.text.includes('All checks passed'), report.text);
}

// An SDK device whose id the portal does not carry at that address: the bridge
// will refuse to start, so `check` must fail too — silently passing here is how a
// technician leaves a site whose gate events never arrive.
{
  const unresolved = await withWorker(
    [{ device_id: '66666666-6666-4666-8666-666666666666', device_name: 'Main Gate ISAPI', isapi_host: '192.168.88.60', isapi_port: 80 }],
    [{ ...sdkEntry, estateMateDeviceId: '' }],
    (code, { lines }) => ({ code, text: lines.join('\n') }),
  );
  check('an SDK device the portal cannot match is a failure, not a pass',
    unresolved.code === 1 && unresolved.text.includes('EstateMate device id'), `exit=${unresolved.code}\n${unresolved.text}`);
  check('and the failure names the address the portal row would have to carry',
    unresolved.text.includes('192.168.88.60') && unresolved.text.includes('8000'), unresolved.text);
}

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
