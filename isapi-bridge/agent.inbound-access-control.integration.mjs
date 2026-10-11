#!/usr/bin/env node
/**
 * Integration checks for inbound access control.
 *
 * The scenario these exist for: a site whose router already forwards a port
 * inward — an ISP-managed box, a rule from a previous installation, an "inbound
 * Internet access" setting somebody else owns — and whose settings nobody can
 * change. The rule cannot be deleted, so the only place left to decide who gets
 * in is the socket that answers. Every check below is that decision, exercised
 * on a real connection or on the agent's own resolved policy; none of them is
 * satisfied by a function agreeing with itself.
 *
 * What is proven:
 *   - the allowlist matches the addresses a terminal actually presents
 *     (`::ffff:` peers, IPv6, CIDR ranges) and refuses everything else;
 *   - a hostname is never an allowlist entry, and a `/0` is never a rule;
 *   - a source outside the allowlist is refused before its body is read, and
 *     learns nothing about what the port is for;
 *   - the shared secret is layered on the allowlist, not instead of it, and a
 *     wrong one is refused in constant time;
 *   - one source cannot bury the listener: the per-source budget throttles;
 *   - refusals are counted and auditable, and the audit never carries a body
 *     (a body can hold a card number);
 *   - the agent derives its allowlist from the terminals it serves, and stays
 *     advisory — loudly — when a devices file names one by hostname;
 *   - the PUSH listener never derives from ISAPI hosts, which would produce a
 *     list every PUSH terminal is missing from;
 *   - an upload that *claims* to be from a terminal it did not come from is
 *     mapped by its socket, not by its body: a forged `ipAddress` is how a
 *     forwarded port becomes an unlocked door;
 *   - the heartbeat reports the inbound surface, so "is anything accepting
 *     connections here?" is answerable from the portal side too.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

process.env.ESTATEMATE_AGENT_STANDBY = '1';

const dir = mkdtempSync(join(tmpdir(), 'estatemate-inbound-'));
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

/**
 * Runs `body` with the agent's own log lines captured, and returns them.
 *
 * Only the agent's lines are captured — they are the ones being asserted on, and
 * they are recognisable by the timestamp the bridge prefixes. Check output goes
 * straight through, so a check inside a captured block is still visible.
 */
async function captureLogs(body) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(line)) lines.push(line);
    else original(...args);
  };
  try {
    await body();
  } finally {
    console.log = original;
  }
  return lines;
}

const nacr = await import('./network-access-control.mjs');
const {
  classifyAddress, normalizeSourceAddress, parseSourceRule, addressMatchesRule,
  classifyBindAddress, bindIsReachableBeyondHost, deriveInboundSources,
  createInboundAccessControl, secretsMatch, assessBindAddress,
} = nacr;

console.log('Inbound access control checks');

// ── 1. Addresses are what the socket says, in every shape Node reports them ──
check('an IPv4 peer on a dual-stack socket is that IPv4 address',
  normalizeSourceAddress('::ffff:192.168.88.11') === '192.168.88.11');
check('a bracketed IPv6 peer with a port is the address',
  normalizeSourceAddress('[2001:db8::5]:443') === '2001:db8::5');
check('a bare IPv6 peer keeps every group',
  normalizeSourceAddress('fe80::1') === 'fe80::1');
check('a carrier-grade NAT address is not called private',
  classifyAddress('100.64.0.1') === 'carrier-grade');
check('an Internet address is called public', classifyAddress('203.0.113.7') === 'public');
check('loopback is loopback in both families',
  classifyAddress('127.0.0.1') === 'loopback' && classifyAddress('::1') === 'loopback');
check('a NAT64 address with an embedded public IPv4 is public',
  classifyAddress('64:ff9b::203.0.113.7') === 'public');
check('garbage is unknown, never silently allowed', classifyAddress('not-an-address') === 'unknown');

// ── 2. Rules are address literals; a hostname or /0 is refused ───────────────
check('a device VLAN parses', parseSourceRule('192.168.88.0/24').ok === true);
check('a single terminal parses', parseSourceRule('10.0.0.5').ok === true);
check('an IPv6 range parses', parseSourceRule('fd00::/8').ok === true);
check('a hostname is refused: resolving one at decision time hands the policy to DNS',
  parseSourceRule('gate1.local').ok === false);
check('a /0 is refused: "allow everything" is a switch, not a range',
  parseSourceRule('0.0.0.0/0').ok === false);
check('a range matches inside itself', addressMatchesRule('::ffff:192.168.88.42', parseSourceRule('192.168.88.0/24')));
check('a range does not match the neighbour', !addressMatchesRule('192.168.89.42', parseSourceRule('192.168.88.0/24')));
check('an IPv4 rule never matches an IPv6 peer', !addressMatchesRule('2001:db8::1', parseSourceRule('10.0.0.0/8')));
check('a wildcard bind is reachable beyond the host', bindIsReachableBeyondHost('0.0.0.0') === true);
check('a loopback bind is not', bindIsReachableBeyondHost('127.0.0.1') === false);
check('a bind address is classified without being resolved', classifyBindAddress('::') === 'wildcard');

// ── 3. The controller decides in order: source, secret, rate ─────────────────
{
  const warnings = [];
  const access = createInboundAccessControl({
    name: 'test listener',
    allowedSources: ['192.168.88.0/24', '10.0.0.5'],
    requireSecret: true,
    secret: 'shared-lan-key',
    maxRequestsPerMinutePerSource: 3,
    log: (level, message) => warnings.push(`${level}: ${message}`),
  });
  check('a derived allowlist is enforcing', access.enforcing === true);
  const allowed = access.decide({ ip: '192.168.88.11', headers: { 'x-estatemate-terminal-key': 'shared-lan-key' }, url: '/events', method: 'POST' });
  check('a terminal inside the estate is accepted', allowed.allowed === true, JSON.stringify(allowed));
  const outsider = access.decide({ ip: '203.0.113.7', headers: { 'x-estatemate-terminal-key': 'shared-lan-key' }, url: '/events', method: 'POST' });
  check('a source outside the allowlist is refused even with the right secret',
    outsider.allowed === false && outsider.code === 'deniedSource' && outsider.status === 403, JSON.stringify(outsider));
  const wrongKey = access.decide({ ip: '192.168.88.12', headers: { 'x-estatemate-terminal-key': 'nope' }, url: '/events', method: 'POST' });
  check('an allowlisted source with a wrong secret is refused',
    wrongKey.allowed === false && wrongKey.code === 'deniedSecret', JSON.stringify(wrongKey));
  check('the secret is compared, not merely required', secretsMatch('shared-lan-key', 'shared-lan-key') && !secretsMatch('shared-lan-kev', 'shared-lan-key'));
  check('secrets of different lengths do not throw', !secretsMatch('', 'shared-lan-key'));

  for (let index = 0; index < 3; index += 1) {
    access.decide({ ip: '10.0.0.5', presentedSecret: 'shared-lan-key', url: '/iclock/ping', method: 'GET' });
  }
  const flooded = access.decide({ ip: '10.0.0.5', presentedSecret: 'shared-lan-key', url: '/iclock/ping', method: 'GET' });
  check('one source cannot exceed its per-minute budget', flooded.code === 'throttled' && flooded.status === 429, JSON.stringify(flooded));
  check('a different source is not throttled by somebody else\'s flood',
    access.decide({ ip: '192.168.88.20', presentedSecret: 'shared-lan-key', url: '/events', method: 'POST' }).allowed === true);

  // An explicit 0 is an operator switching the limit off, which is different from
  // not configuring one — the controller must not quietly reinstate its default.
  const unlimited = createInboundAccessControl({
    name: 'unlimited listener', allowedSources: ['10.0.0.0/8'], maxRequestsPerMinutePerSource: 0, log: () => {},
  });
  for (let index = 0; index < 25; index += 1) unlimited.decide({ ip: '10.1.1.1', url: '/events', method: 'POST' });
  check('an explicit 0 switches the rate limit off instead of falling back to the default',
    unlimited.stats.throttled === 0 && unlimited.stats.allowed === 25, JSON.stringify(unlimited.stats));

  const denials = access.denials();
  check('every refusal is auditable', denials.length >= 3, JSON.stringify(denials.map((entry) => entry.code)));
  check('the audit records the source and the path', denials[0].source === '203.0.113.7' && denials[0].path === '/events');
  check('the audit never records a request body — a body can carry a card number',
    denials.every((entry) => !JSON.stringify(entry).includes('cardNo')));
  check('a refusal is logged with the source', warnings.some((line) => line.includes('203.0.113.7')));
}

// ── 4. No allowlist is a policy, and it is a loud one ────────────────────────
{
  const warnings = [];
  const open = createInboundAccessControl({ name: 'open listener', allowedSources: [], log: (l, m) => warnings.push(`${l}: ${m}`) });
  check('with no rule there is nothing to enforce', open.enforcing === false);
  check('an open listener still answers an Internet source', open.decide({ ip: '203.0.113.7' }).allowed === true);
  const advisory = createInboundAccessControl({
    name: 'advisory listener', allowedSources: ['10.0.0.0/8'], allowUnknownSources: true, log: (l, m) => warnings.push(`${l}: ${m}`),
  });
  check('allowUnknownSources makes the list advisory, and says so',
    advisory.enforcing === false && advisory.decide({ ip: '203.0.113.7' }).allowed === true
    && warnings.some((line) => line.includes('advisory only')));
  const noSecret = createInboundAccessControl({ name: 'guarded', requireSecret: true, secret: '', log: (l, m) => warnings.push(`${l}: ${m}`) });
  check('a listener that demands a secret with none set fails closed',
    noSecret.decide({ ip: '127.0.0.1' }).code === 'deniedSecret');
}

// ── 5. The allowlist is derived from the estate's own terminals ──────────────
{
  const derived = deriveInboundSources({
    devices: [
      { name: 'Main Gate', isapiHost: '192.168.88.11' },
      { name: 'Side Gate', isapiHost: '192.168.88.12' },
      { name: 'Disabled', isapiHost: '10.9.9.9', enabled: false },
      { name: 'PUSH gate' }, // dials in; has no address to allow
    ],
    explicit: ['172.16.0.0/16'],
  });
  check('every enabled terminal with an address becomes a rule', derived.sources.length === 3, JSON.stringify(derived.sources));
  check('a disabled terminal is not allowlisted', !derived.sources.some((entry) => entry.includes('10.9.9.9')));
  check('an explicit range is kept alongside the derived ones', derived.sources.includes('172.16.0.0/16'));
  check('a complete derivation says it is complete', derived.complete === true);

  const incomplete = deriveInboundSources({ devices: [{ name: 'Palmerie Gate', isapiHost: 'gate3.estate.local' }] });
  check('a terminal named by hostname cannot be derived', incomplete.complete === false && incomplete.missing.length === 1);
  check('the gap names the terminal, so the warning is actionable',
    incomplete.missing[0].name === 'Palmerie Gate' && incomplete.missing[0].reason === 'not-an-address-literal');
}

// ── 6. Bind assessment: what the startup log tells an operator ───────────────
{
  const wildcard = assessBindAddress({ bindAddress: '0.0.0.0', port: 8080, name: 'LAN event listener', enforcing: false });
  check('a wildcard bind is reported as reachable beyond the host', wildcard.reachableBeyondHost === true);
  check('a wildcard bind with no allowlist warns about the router', wildcard.warnings.some((line) => line.includes('router forwards')));
  const enforced = assessBindAddress({ bindAddress: '0.0.0.0', port: 8080, name: 'LAN event listener', enforcing: true });
  check('the same bind with an allowlist says the allowlist is what refuses traffic',
    enforced.warnings.some((line) => line.includes('only an allowlisted source is accepted')));
  const publicBind = assessBindAddress({ bindAddress: '203.0.113.9', port: 80, name: 'listener', enforcing: true });
  check('binding a public address points at the tunnel kit instead',
    publicBind.warnings.some((line) => line.includes('CLOUDFLARE-TUNNEL-REMOTE-ACCESS')));
  check('a loopback bind produces no warning', assessBindAddress({ bindAddress: '127.0.0.1', port: 8080, name: 'listener', enforcing: true }).warnings.length === 0);
}

// ── 7. Real sockets: the LAN event listener refuses what it should ───────────
const { startLanEventListener } = await import('./lan-event-listener.mjs');
const gatedDevice = { name: 'Main Gate', estateMateDeviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isapiHost: '127.0.0.1' };
const gated = await startLanEventListener({
  port: 0,
  bindAddress: '127.0.0.1',
  // Loopback is the only address this test can send from, so refusing it is how
  // an outside source is exercised on a real socket.
  allowLoopback: false,
  allowedSources: ['192.168.88.0/24'],
  log: () => {},
  resolveDevice: ({ ip }) => (ip === '127.0.0.1' ? gatedDevice : null),
  onEvent: () => {},
});

/** One request against a listener, resolved rather than rejected: a destroyed
 * connection is a result to assert on, not an exception to hide. */
const request = (port, method, body = '', headers = {}) => new Promise((resolve) => {
  const call = http.request({
    host: '127.0.0.1', port, path: '/events', method,
    headers: body ? { 'Content-Type': 'application/xml', ...headers } : headers,
  }, (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
  });
  call.on('error', (error) => resolve({ status: null, text: String(error?.code ?? error), headers: {} }));
  call.end(body);
});
const post = (port, body, headers = {}) => request(port, 'POST', body, headers);

const FORGED = '<EventNotificationAlert><AccessControllerEvent>'
  + '<ipAddress>192.168.88.11</ipAddress><cardNo>0001234567</cardNo>'
  + '</AccessControllerEvent></EventNotificationAlert>';

const refused = await post(gated.port, FORGED);
check('a source outside the allowlist is refused on a real socket', refused.status === 403, JSON.stringify(refused));
check('the refusal says nothing about the estate', refused.text === 'forbidden', JSON.stringify(refused));
check('a refused upload is never mapped to a terminal', gated.stats.mapped === 0, JSON.stringify(gated.stats));
check('the refusal is counted', gated.stats.deniedSource === 1, JSON.stringify(gated.stats));
const refusedProbe = await request(gated.port, 'GET');
check('an unauthorised caller is not even told which methods this port speaks',
  refusedProbe.status === 403 && !refusedProbe.headers.allow, JSON.stringify(refusedProbe));
await gated.close();

// The same listener with the caller inside the allowlist ingests normally, so
// the refusal above is the policy and not a broken listener.
const openListener = await startLanEventListener({
  port: 0,
  bindAddress: '127.0.0.1',
  allowedSources: ['192.168.88.0/24', '127.0.0.1'],
  log: () => {},
  resolveDevice: ({ ip }) => (ip === '127.0.0.1' ? gatedDevice : null),
  onEvent: () => {},
});
const accepted = await post(openListener.port, FORGED);
check('an allowlisted source is accepted', accepted.status === 200, JSON.stringify(accepted));
check('and mapped to the terminal it came from', openListener.stats.mapped === 1, JSON.stringify(openListener.stats));
await openListener.close();

// ── 8. Real sockets: the PUSH listener keeps its documented answers ──────────
const { startZktecoPushServer } = await import('./zkteco-push-server.mjs');
const pushLogs = [];
const push = startZktecoPushServer({
  port: 0,
  bindAddress: '127.0.0.1',
  allowLoopback: false,
  allowedSources: ['192.168.88.0/24'],
  requireAgentKey: true,
  agentKey: 'shared-lan-key',
  maxRequestsPerMinutePerSource: 2,
  log: (level, message) => pushLogs.push(`${level}: ${message}`),
  resolveDevice: () => null,
});
await new Promise((resolve) => push.server.once('listening', resolve));
const pushPort = push.address().port;
const pushBase = `http://127.0.0.1:${pushPort}`;

const outside = await fetch(`${pushBase}/iclock/ping?SN=ZK1`);
check('a PUSH request from outside the allowlist is refused', outside.status === 403);
check('and answered with the protocol\'s own short body', (await outside.text()).trim() === 'forbidden');
check('the refusal is counted separately from a key refusal', push.handler.stats.deniedSource === 1, JSON.stringify(push.handler.stats));

// Same source, now allowlisted by turning loopback back on: the key still rules.
const keyed = startZktecoPushServer({
  port: 0,
  bindAddress: '127.0.0.1',
  allowedSources: ['192.168.88.0/24'],
  requireAgentKey: true,
  agentKey: 'shared-lan-key',
  maxRequestsPerMinutePerSource: 2,
  log: () => {},
  resolveDevice: () => null,
});
await new Promise((resolve) => keyed.server.once('listening', resolve));
const keyedBase = `http://127.0.0.1:${keyed.address().port}`;
check('a wrong key is still 403 "unauthorized", exactly as before',
  (await (await fetch(`${keyedBase}/iclock/ping?SN=ZK1&Key=nope`)).text()).trim() === 'unauthorized');
const firstPing = await fetch(`${keyedBase}/iclock/ping?SN=ZK1&Key=shared-lan-key`);
check('the right key is served', firstPing.status === 200 && (await firstPing.text()).trim() === 'OK');
const secondPing = await fetch(`${keyedBase}/iclock/ping?SN=ZK1&Key=shared-lan-key`);
check('a terminal inside its budget keeps being served', secondPing.status === 200);
const floodedPing = await fetch(`${keyedBase}/iclock/ping?SN=ZK1&Key=shared-lan-key`);
check('a flooded source is throttled rather than served', floodedPing.status === 429, `status=${floodedPing.status}`);
check('the throttle is counted', keyed.handler.stats.throttled === 1, JSON.stringify(keyed.handler.stats));
await push.close();
await keyed.close();

// ── 9. The agent resolves the policy from a real config and devices file ─────
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');
writeFileSync(configPath, JSON.stringify({
  agentId: AGENT_ID,
  agentSecret: 'a-very-long-agent-secret-value',
  workerUrl: 'http://127.0.0.1:1', // never dialled: nothing here calls main()
  eventStream: false,
  logLevel: 'debug',
  zktecoPush: { enabled: true, port: 0, bindAddress: '127.0.0.1', allowedSources: ['192.168.88.0/24'] },
  lanEvents: { enabled: true, port: 0, bindAddress: '0.0.0.0', requireTerminalKey: true, terminalKey: 'terminal-shared-secret' },
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [
    { name: 'Main Gate', estateMateDeviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isapiHost: '127.0.0.1', isapiPort: 80 },
    { name: 'Side Gate', estateMateDeviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', isapiHost: '192.168.88.12', isapiPort: 80 },
    { name: 'Palmerie Gate', isapiHost: 'gate3.estate.local', isapiPort: 80 },
  ],
}));
process.env.AGENT_CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;
const agent = await import('./agent.mjs');

{
  const lines = await captureLogs(async () => {
    const policy = agent.inboundPolicyFor({ name: 'LAN event listener', explicit: [], deriveFromDevices: true, bindAddress: '0.0.0.0' });
    check('a devices file with a hostname in it does not silently become deny-by-default', policy.enforcing === false);
    check('the derived rules still contain every terminal with an address', policy.allowedSources.length === 2, JSON.stringify(policy.allowedSources));
    check('the gap is reported, not swallowed', policy.missing.length === 1 && policy.missing[0].host === 'gate3.estate.local');
  });
  check('the operator is told how to close the gap',
    lines.some((line) => line.includes('allowedSources') && line.includes('gate3.estate.local')), lines.join('\n'));
}

let explicitPolicy = null;
await captureLogs(async () => {
  explicitPolicy = agent.inboundPolicyFor({ name: 'LAN event listener', explicit: ['172.16.5.0/24'], deriveFromDevices: true, bindAddress: '0.0.0.0' });
});
check('an explicit range makes the list enforced even with a hostname device present', explicitPolicy.enforcing === true);
check('and keeps the derived terminals in it', explicitPolicy.allowedSources.length === 3, JSON.stringify(explicitPolicy.allowedSources));

let pushPolicy = null;
const pushPolicyLogs = await captureLogs(async () => {
  pushPolicy = agent.inboundPolicyFor({ name: 'ZKTeco PUSH listener', explicit: [], deriveFromDevices: false, bindAddress: '0.0.0.0' });
});
check('the PUSH listener never derives from ISAPI hosts', pushPolicy.allowedSources.length === 0 && pushPolicy.enforcing === false);
check('and says why that leaves the port open', pushPolicyLogs.some((line) => line.includes('any address that can reach it is accepted')), pushPolicyLogs.join('\n'));

// ── 10. A forged `ipAddress` never becomes another terminal's door ───────────
{
  const mismatches = await captureLogs(async () => {
    const bySocket = agent.resolveLanEventDevice({ ip: '127.0.0.1', event: { deviceIp: '127.0.0.1', cardNo: '0001234567' } });
    check('an upload is mapped to the terminal it came from', bySocket?.name === 'Main Gate', JSON.stringify(bySocket?.name));

    const spoofed = agent.resolveLanEventDevice({ ip: '127.0.0.1', event: { deviceIp: '192.168.88.12', cardNo: '0001234567' } });
    check('a body claiming another terminal does not become that terminal', spoofed?.name === 'Main Gate', JSON.stringify(spoofed?.name));

    const fromNowhere = agent.resolveLanEventDevice({ ip: '203.0.113.7', event: { deviceIp: '127.0.0.1', cardNo: '0001234567' } });
    check('an upload from outside the estate naming a real terminal maps to nothing', fromNowhere === null, JSON.stringify(fromNowhere));
  });
  check('the claim is said out loud', mismatches.some((line) => line.includes('claimed to be from 192.168.88.12')), mismatches.join('\n'));
}

// ── 11. The heartbeat reports the inbound surface ────────────────────────────
{
  const listener = agent.startPushListener();
  await new Promise((resolve) => listener.server.once('listening', resolve));
  const report = agent.inboundAccessHeartbeat();
  check('an agent with a listener reports it', Array.isArray(report?.listeners) && report.listeners.length === 1, JSON.stringify(report));
  const entry = report.listeners[0];
  check('the report carries the listener, its bind address and its policy',
    entry.listener === 'zkteco_push' && entry.bindAddress === '127.0.0.1' && entry.policy.enforcing === true, JSON.stringify(entry));
  check('the report carries the allowlist it enforces', entry.policy.sources.includes('192.168.88.0/24'), JSON.stringify(entry.policy));
  check('the report carries the refusal counters', typeof entry.deniedSource === 'number' && typeof entry.throttled === 'number');
  check('the report never carries a request body', !JSON.stringify(report).includes('cardNo'));

  // A refused connection from outside the allowlist shows up in the next report,
  // which is the only way an operator would ever see it: the caller's own log
  // says "server unreachable" and the estate's log says nothing.
  const pushUrl = `http://127.0.0.1:${listener.address().port}/iclock/ping?SN=ZK-OUTSIDE`;
  const before = report.listeners[0].requests;
  await fetch(pushUrl).catch(() => null);
  const after = agent.inboundAccessHeartbeat().listeners[0];
  check('a request is counted on the reported surface', after.requests === before + 1, JSON.stringify({ before, after: after.requests }));
  await listener.close();
}

// ── 11b. A public endpoint is a recorded decision, and the agent enforces it ──
// The live case this exists for: a router rule from someone else already
// publishes a terminal at <public-ip>:<port>, the LAN address is unknown and the
// router cannot be edited. Integration is then possible, but only as an explicit
// acknowledgement in the devices file — never because an address was typed in.
// Driven through real child processes, because the refusal happens at startup.
{
  const rootDir = new URL('..', import.meta.url);
  const childScript = `
    process.env.ESTATEMATE_AGENT_STANDBY = '1';
    const agent = await import('./isapi-bridge/agent.mjs');
    console.log('IMPORTED ' + JSON.stringify(agent.publicEndpointStatus()));
  `;
  const runAgent = (devices) => {
    const file = join(dir, `public-endpoint-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ devices }));
    return spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: new URL('.', rootDir).pathname,
      env: { ...process.env, AGENT_CONFIG: configPath, DEVICES_FILE: file },
      encoding: 'utf8',
    });
  };

  const refused = runAgent([
    { name: 'Exposed Gate', estateMateDeviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', isapiHost: '203.0.113.40', isapiPort: 8000, protocol: 'http' },
  ]);
  check('a public endpoint with no acknowledgement stops the agent',
    refused.status === 1 && !refused.stdout.includes('IMPORTED'), `status=${refused.status} stdout=${refused.stdout.trim()}`);
  check('and the refusal says which terminal, and why this host cannot fix it',
    refused.stderr.includes('Exposed Gate') && refused.stderr.includes('203.0.113.40:8000') && refused.stderr.includes('answers for itself'), refused.stderr.trim());
  check('and it names the LAN path first, the acknowledgement second, manual sync third',
    refused.stderr.includes('SADP') && refused.stderr.includes('publicEndpoint') && refused.stderr.includes('manual synchronization'), refused.stderr.trim());
  check('and it hands the operator the exact command to see what is really answering',
    refused.stderr.includes('scripts/terminal-endpoint.mjs --endpoint 203.0.113.40:8000'), refused.stderr.trim());

  const accepted = runAgent([
    {
      name: 'Exposed Gate',
      estateMateDeviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      isapiHost: '203.0.113.40',
      isapiPort: 8000,
      protocol: 'http',
      publicEndpoint: {
        acknowledged: true,
        acknowledgedBy: 'admin@royalpalm',
        acknowledgedAt: '2026-10-11T09:00:00Z',
        note: 'contractor rule on the ISP router; no LAN path to the terminal',
      },
    },
  ]);
  check('an acknowledged public endpoint starts, and the agent reports it rather than hiding it',
    accepted.status === 0 && accepted.stdout.includes('IMPORTED'), `status=${accepted.status} stderr=${accepted.stderr.trim()}`);
  const status = JSON.parse((accepted.stdout.match(/IMPORTED (.*)/) || [])[1] || 'null');
  check('the report carries the address, the protocol and who accepted it',
    status?.[0]?.host === '203.0.113.40' && status?.[0]?.protocol === 'http' && status?.[0]?.acknowledgedBy === 'admin@royalpalm', JSON.stringify(status));

  const privateDevice = runAgent([
    { name: 'Main Gate', estateMateDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', isapiHost: '192.168.88.12', isapiPort: 80 },
  ]);
  check('a private address needs no acknowledgement and produces no report',
    privateDevice.status === 0 && privateDevice.stdout.includes('IMPORTED []'), privateDevice.stdout.trim());
}

// ── 12. The Windows bridge's `check` reports the same policy ─────────────────
// The dashboard and the exe read the inbound surface through diagnostics.cjs,
// which asks the *agent* for its resolved policy. Both are exercised here on
// Linux, because a report that disagrees with what the bridge would actually do
// is worse than no report.
{
  const diagnostics = (await import('../bridge-apps/windows/host/diagnostics.cjs')).default;
  const loadedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  const loadedDevices = JSON.parse(readFileSync(devicesPath, 'utf8'));
  const inbound = diagnostics.describeInbound(agent, loadedConfig, loadedDevices);

  check('the check report resolves the inbound surface', inbound.available === true, JSON.stringify(inbound.notes));
  const lan = inbound.listeners.find((entry) => entry.key === 'lanEvents');
  const push = inbound.listeners.find((entry) => entry.key === 'zktecoPush');
  check('a wildcard bind is reported as reachable beyond this PC', lan.reachableBeyondHost === true, JSON.stringify(lan));
  check('and as not enforcing, because a terminal is named by hostname', lan.enforcing === false && lan.sources.length === 2, JSON.stringify(lan));
  check('a loopback PUSH listener with a written range is reported as enforcing',
    push.reachableBeyondHost === false && push.enforcing === true && push.sources.includes('192.168.88.0/24'), JSON.stringify(push));
  check('the agent\'s own warning about the gap reaches the report',
    inbound.notes.some((note) => note.includes('gate3.estate.local')), JSON.stringify(inbound.notes));

  const missingAgent = diagnostics.describeInbound({}, loadedConfig, loadedDevices);
  check('a bridge build without the policy function says so instead of guessing',
    missingAgent.available === false && missingAgent.notes.length === 1, JSON.stringify(missingAgent));
}

cleanup();

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
