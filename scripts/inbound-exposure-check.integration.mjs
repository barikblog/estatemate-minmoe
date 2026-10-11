#!/usr/bin/env node
/**
 * Integration checks for the inbound exposure check.
 *
 * `assessInboundPosture` is the part a review or CI step can rely on: it reads
 * the two files the agent starts from and reports whether anything here would
 * accept a connection that a router forwarded inward. These checks drive it with
 * real configurations — the exposed one and the fixed one — and then exercise the
 * parts that need a socket and a process: a live probe, a listening-socket scan
 * crossed against the configured ports, and the exit codes.
 *
 * Exit code 0 = all checks passed. Exercised by `npm test` via
 * `npm run test:inbound-check`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessFilePermissions,
  assessInboundPosture,
  assessListeningSockets,
  collectListeningSockets,
  listenerSpecs,
  main,
  parseArgs,
  parseProbeTarget,
  probeTarget,
} from './inbound-exposure-check.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'inbound-exposure-check.mjs');
const dir = mkdtempSync(join(tmpdir(), 'estatemate-inbound-check-'));
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

/** Runs the checker as a process, returning { code, output }. Never throws. */
function run(args) {
  try {
    const output = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

console.log('Inbound exposure check');

const DEVICES = [
  { name: 'Main Gate', isapiHost: '192.168.88.11', isapiPort: 80, protocol: 'http' },
  { name: 'Side Gate', isapiHost: '192.168.88.12', isapiPort: 80, protocol: 'http' },
];

// ── 1. The posture an EstateMate install is supposed to have ─────────────────
{
  const result = assessInboundPosture({
    config: { agentId: 'a', workerUrl: 'https://estatemate.estatemate.workers.dev' },
    devices: DEVICES,
  });
  check('an agent with both listeners off is clean', result.ok === true, JSON.stringify(result.errors));
  check('and says why that is the recommended posture',
    result.notes.some((note) => note.includes('opens no listening port')), JSON.stringify(result.notes));
  check('terminals on private addresses are reported, not flagged',
    result.devices.every((device) => device.findings.length === 0 && device.classification === 'private'), JSON.stringify(result.devices));
}

// ── 2. The site this script exists for: a forward inward, nothing deciding ───
{
  const result = assessInboundPosture({
    config: {
      workerUrl: 'https://estatemate.estatemate.workers.dev',
      remoteVerify: { enabled: true },
      lanEvents: { enabled: true, port: 8080, bindAddress: '0.0.0.0' },
    },
    devices: [{ name: 'Palmerie Gate', isapiHost: 'gate3.estate.local' }],
  });
  check('a wildcard listener with no allowlist is an error', result.ok === false);
  check('the error names the router rule nobody can remove',
    result.errors.some((error) => error.includes('a router forwards inward')), JSON.stringify(result.errors));
  check('the error says what a forged upload would do when verification is on',
    result.errors.some((error) => error.includes('door decision')), JSON.stringify(result.errors));
  check('the error carries the fix',
    result.errors.some((error) => error.includes('allowedSources')), JSON.stringify(result.errors));
  check('a terminal named by hostname keeps the allowlist advisory, and says so',
    result.warnings.some((warning) => warning.includes('gate3.estate.local')), JSON.stringify(result.warnings));
}

// ── 3. The same site, fixed without touching the router ──────────────────────
{
  const result = assessInboundPosture({
    config: {
      workerUrl: 'https://estatemate.estatemate.workers.dev',
      remoteVerify: { enabled: true },
      lanEvents: { enabled: true, port: 8080, bindAddress: '0.0.0.0', allowedSources: ['192.168.88.0/24'] },
      zktecoPush: { enabled: true, port: 8089, bindAddress: '192.168.88.5', allowedSources: ['192.168.88.0/24'], requireAgentKey: true, agentKey: 'k' },
    },
    devices: DEVICES,
  });
  check('an allowlist on the device VLAN makes it clean', result.ok === true, JSON.stringify(result.errors));
  check('the LAN listener derived the terminals as well as the range',
    result.listeners[0].sources.length === 3, JSON.stringify(result.listeners[0].sources));
  check('the PUSH listener enforces only what was written for it',
    result.listeners[1].sources.length === 1 && result.listeners[1].enforcing === true, JSON.stringify(result.listeners[1].sources));
}

// ── 4. Loopback needs no allowlist: a forward cannot reach it ────────────────
{
  const result = assessInboundPosture({
    config: { lanEvents: { enabled: true, port: 8080, bindAddress: '127.0.0.1' } },
    devices: DEVICES,
  });
  check('a loopback listener is clean without an allowlist', result.ok === true, JSON.stringify(result.errors));
  check('and the reason is stated', result.notes.some((note) => note.includes('router port-forwarding rule cannot reach it')));
}

// ── 5. A terminal on the Internet is the finding no host setting can fix ─────
{
  const result = assessInboundPosture({
    config: {},
    devices: [
      { name: 'Exposed Gate', isapiHost: '203.0.113.40', isapiPort: 8000, protocol: 'http' },
      { name: 'CGNAT Gate', isapiHost: '100.64.7.9', protocol: 'http' },
      { name: 'Dial-in gate', transport: 'zkteco_push', pushSerial: 'ZK1' },
    ],
  });
  check('a public terminal address is an error', result.ok === false);
  check('plain http to a public terminal is its own error',
    result.errors.filter((error) => error.includes('Exposed Gate')).length === 2, JSON.stringify(result.errors));
  check('a CGNAT address is called out as a weak allowlist entry',
    result.warnings.some((warning) => warning.includes('carrier-grade')), JSON.stringify(result.warnings));
  check('a dial-in PUSH terminal has no address to judge',
    result.devices.find((device) => device.name === 'Dial-in gate').classification === 'dial-in');
}

// ── 6. The switches that weaken the control are findings in their own right ──
{
  const advisory = assessInboundPosture({
    config: { lanEvents: { enabled: true, bindAddress: '0.0.0.0', allowedSources: ['192.168.88.0/24'], allowUnknownSources: true } },
    devices: DEVICES,
  });
  check('allowUnknownSources makes the allowlist advisory, and fails the check',
    advisory.ok === false && advisory.warnings.some((warning) => warning.includes('advisory only')), JSON.stringify(advisory));

  const trusting = assessInboundPosture({
    config: { lanEvents: { enabled: true, bindAddress: '0.0.0.0', allowedSources: ['192.168.88.0/24'], trustReportedDeviceIp: true } },
    devices: DEVICES,
  });
  check('trusting the body\'s ipAddress on a reachable listener is an error',
    trusting.errors.some((error) => error.includes('trustReportedDeviceIp')), JSON.stringify(trusting.errors));

  const keyless = assessInboundPosture({
    config: { zktecoPush: { enabled: true, bindAddress: '0.0.0.0', allowedSources: ['192.168.88.0/24'], requireAgentKey: true } },
    devices: DEVICES,
  });
  check('requiring a secret and not setting one fails closed, and is reported as broken',
    keyless.errors.some((error) => error.includes('refuses every upload')), JSON.stringify(keyless.errors));

  const flooded = assessInboundPosture({
    config: { lanEvents: { enabled: true, bindAddress: '0.0.0.0', allowedSources: ['192.168.88.0/24'], maxRequestsPerMinute: 0 } },
    devices: DEVICES,
  });
  check('switching the rate limit off is a warning',
    flooded.warnings.some((warning) => warning.includes('switched off')), JSON.stringify(flooded.warnings));

  const defaulted = assessInboundPosture({
    config: { lanEvents: { enabled: true, bindAddress: '0.0.0.0', allowedSources: ['192.168.88.0/24'] } },
    devices: DEVICES,
  });
  check('not configuring the rate limit is not a finding — the default is in force',
    !defaulted.warnings.some((warning) => warning.includes('rate limit')), JSON.stringify(defaulted.warnings));

  const plaintext = assessInboundPosture({ config: { workerUrl: 'http://estatemate.example.workers.dev' }, devices: DEVICES });
  check('an outbound http workerUrl is a warning', plaintext.warnings.some((warning) => warning.includes('workerUrl')));
}

// ── 7. What the agent would actually start, read the same way ────────────────
{
  const specs = listenerSpecs({ zktecoPush: true });
  check('"zktecoPush": true means enabled, exactly as the agent reads it',
    specs.find((spec) => spec.key === 'zktecoPush').enabled === true);
  check('an object that does not say false also means enabled',
    listenerSpecs({ zktecoPush: { port: 9 } }).find((spec) => spec.key === 'zktecoPush').enabled === true);
  check('"enabled": false means off',
    listenerSpecs({ zktecoPush: { enabled: false } }).find((spec) => spec.key === 'zktecoPush').enabled === false);
  check('the LAN listener is off unless it says true',
    listenerSpecs({ lanEvents: { port: 8080 } }).find((spec) => spec.key === 'lanEvents').enabled === false);
}

// ── 8. Secret-bearing files are checked for what they are ────────────────────
{
  const tight = join(dir, 'tight.json');
  const loose = join(dir, 'loose.json');
  writeFileSync(tight, '{}');
  writeFileSync(loose, '{}');
  if (process.platform !== 'win32') {
    const { chmodSync } = await import('node:fs');
    chmodSync(tight, 0o600);
    chmodSync(loose, 0o644);
    check('a 0600 file passes', assessFilePermissions(tight).ok === true);
    const looseResult = assessFilePermissions(loose, { holds: 'the agent secret' });
    check('a 0644 file is reported with its mode', looseResult.ok === false && looseResult.mode === '644', JSON.stringify(looseResult));
    check('and with what it holds', looseResult.holds === 'the agent secret');
  } else {
    check('Windows ACLs are not read here, and the report says so', assessFilePermissions(tight).checked === false);
  }
}

// ── 9. Probe targets parse the way an operator types them ────────────────────
check('host:port parses', JSON.stringify(parseProbeTarget('203.0.113.9:8080')) === JSON.stringify({ host: '203.0.113.9', port: 8080 }));
check('a bare host takes the default port', parseProbeTarget('203.0.113.9').port === 80);
check('a bracketed IPv6 target parses', parseProbeTarget('[2001:db8::9]:8080').host === '2001:db8::9');
check('a bad port is a usage error', (() => { try { parseProbeTarget('host:99999'); return false; } catch { return true; } })());

// ── 10. A probe tells the truth about a live port and a dead one ─────────────
{
  const server = http.createServer((req, res) => { res.writeHead(403, { 'Server': 'EstateMate-Test' }); res.end('forbidden'); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const livePort = server.address().port;

  const live = await probeTarget({ host: '127.0.0.1', port: livePort, timeoutMs: 3000 });
  check('a listening port is reported as answering, with what it said',
    live.reachable === true && live.status === 403 && live.server === 'EstateMate-Test', JSON.stringify(live));

  const dead = await probeTarget({ host: '127.0.0.1', port: livePort + 1, timeoutMs: 2000 });
  check('a closed port is reported as not answering', dead.reachable === false && dead.reason === 'ECONNREFUSED', JSON.stringify(dead));
  server.close();
}

// ── 11. The listening-socket scan crosses real sockets with the config ───────
{
  const scan = collectListeningSockets();
  if (!scan.available) {
    check('the scan reports itself unavailable rather than inventing findings',
      assessListeningSockets({ scan, listeners: [], devices: [] }).notes.length === 1);
  } else {
    const server = http.createServer((req, res) => res.end('x'));
    await new Promise((done) => server.listen(0, '0.0.0.0', done));
    const port = server.address().port;
    const fresh = collectListeningSockets();
    check('the scan sees a real wildcard listener', fresh.entries.some((entry) => entry.port === port), JSON.stringify(fresh.entries.slice(0, 5)));

    const assessed = assessListeningSockets({
      scan: fresh,
      listeners: [{ key: 'lanEvents', label: 'LAN event listener', enabled: true, port, enforcing: false, sources: [] }],
      devices: [],
    });
    check('a wildcard listener with no allowlist is an error on the live socket table',
      assessed.errors.some((error) => error.includes(`:${port}`)), JSON.stringify(assessed.errors));

    const enforced = assessListeningSockets({
      scan: fresh,
      listeners: [{ key: 'lanEvents', label: 'LAN event listener', enabled: true, port, enforcing: true, sources: ['192.168.88.0/24'] }],
      devices: [],
    });
    check('the same socket with an allowlist is a warning, not an error',
      enforced.errors.length === 0 && enforced.warnings.some((warning) => warning.includes('source rule')), JSON.stringify(enforced));

    const devicePort = assessListeningSockets({
      scan: fresh,
      listeners: [],
      devices: [{ name: 'Main Gate', isapiHost: '192.168.88.11', isapiPort: port }],
    });
    check('this host answering a terminal\'s ISAPI port is reported',
      devicePort.warnings.some((warning) => warning.includes('Main Gate')), JSON.stringify(devicePort.warnings));
    server.close();
  }
}

// ── 12. CLI: files, findings and exit codes ─────────────────────────────────
{
  const cleanConfig = join(dir, 'clean-config.json');
  const cleanDevices = join(dir, 'clean-devices.json');
  const exposedConfig = join(dir, 'exposed-config.json');
  // A terminal named by hostname is what keeps a derived allowlist advisory, and
  // advisory plus a wildcard bind is the finding. With both terminals addressable
  // the same config is clean — the agent derives the allowlist for itself, which
  // is the point of deriving it.
  const exposedDevices = join(dir, 'exposed-devices.json');
  writeFileSync(cleanConfig, JSON.stringify({
    agentId: '11111111-1111-4111-8111-111111111111',
    agentSecret: 'a-very-long-agent-secret-value',
    workerUrl: 'https://estatemate.estatemate.workers.dev',
  }));
  writeFileSync(cleanDevices, JSON.stringify({ devices: DEVICES }));
  writeFileSync(exposedConfig, JSON.stringify({
    agentId: '11111111-1111-4111-8111-111111111111',
    agentSecret: 'a-very-long-agent-secret-value',
    workerUrl: 'https://estatemate.estatemate.workers.dev',
    lanEvents: { enabled: true, port: 8080, bindAddress: '0.0.0.0' },
  }));
  writeFileSync(exposedDevices, JSON.stringify({ devices: [...DEVICES, { name: 'Palmerie Gate', isapiHost: 'gate3.estate.local' }] }));

  // The same listener with every terminal addressable derives a complete
  // allowlist and needs nothing written by hand: that is the fix, and it is what
  // makes the exposed case below a real finding rather than a config quirk.
  const derived = run(['--config', exposedConfig, '--devices', cleanDevices, '--no-permissions']);
  check('a wildcard listener with fully addressable terminals is clean, because the allowlist is derived',
    derived.code === 0 && derived.output.includes('enforces 2 source rule(s)'), derived.output);

  const clean = run(['--config', cleanConfig, '--devices', cleanDevices, '--no-permissions']);
  check('a clean configuration exits 0', clean.code === 0, clean.output);

  const exposed = run(['--config', exposedConfig, '--devices', exposedDevices, '--no-permissions']);
  check('an exposed configuration exits 1', exposed.code === 1, exposed.output);
  check('and prints the finding on stderr-free stdout for a reviewer', exposed.output.includes('error:'), exposed.output);

  const usage = run(['--config', cleanConfig, '--devices', cleanDevices, '--nonsense']);
  check('an unknown flag exits 2', usage.code === 2, usage.output);

  const missing = run(['--config', join(dir, 'nope.json'), '--devices', cleanDevices]);
  check('a missing config file exits 2, not 1', missing.code === 2, missing.output);

  const json = run(['--config', exposedConfig, '--devices', exposedDevices, '--no-permissions', '--json']);
  const parsed = JSON.parse(json.output);
  check('--json prints a machine-readable report', parsed.ok === false && Array.isArray(parsed.listeners) && parsed.listeners.length === 2);
  check('the JSON report carries the probes and the socket scan keys', 'probes' in parsed && 'listeningSockets' in parsed);

  const help = run(['--help']);
  check('--help exits 0 and documents the exit codes', help.code === 0 && help.output.includes('Exit codes:'));

  // main() is exported so a caller can drive it without a subprocess; the exit
  // code contract has to be identical either way.
  const lines = [];
  const code = await main(['--config', exposedConfig, '--devices', exposedDevices, '--no-permissions'], (line) => lines.push(line));
  check('main() returns the same exit code as the process', code === 1, String(code));
  check('main() writes through the log sink it is given', lines.some((line) => line.startsWith('error:')));
}

// ── 13. parseArgs keeps the flag surface honest ─────────────────────────────
{
  const options = parseArgs(['--config', 'a.json', '--devices', 'b.json', '--probe', '1.2.3.4:80', '--probe', '1.2.3.4:81', '--probe-port', '443', '--listen-scan', '--timeout', '1500']);
  check('probes are collected', options.probes.length === 2, JSON.stringify(options.probes));
  check('--probe-port extends the host list', options.probePorts?.[0] === 443);
  check('--listen-scan is a switch', options.listenScan === true);
  check('--timeout is validated', options.timeoutMs === 1500);
  check('a too-small timeout is a usage error', (() => { try { parseArgs(['--timeout', '10']); return false; } catch { return true; } })());
}

cleanup();

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
