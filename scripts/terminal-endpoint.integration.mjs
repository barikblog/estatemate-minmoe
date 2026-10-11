#!/usr/bin/env node
/**
 * Integration checks for `scripts/terminal-endpoint.mjs`.
 *
 * The script exists to stop an installer from configuring the wrong service at
 * the end of a port-forward, so what these checks prove is that each of the
 * things a rule can expose is told apart from the others — with the real script,
 * over real sockets, not with a mock of the classifier:
 *
 *   - a live ISAPI endpoint is `isapi`, and its deviceInfo is what gets printed;
 *   - a Digest-protected one needs credentials (`isapi_auth_required`), accepts
 *     the right password (`isapi`) — with the Digest response **verified
 *     server-side**, so the maths is checked — and names a wrong password as
 *     `isapi_auth_failed` rather than as an unreachable device;
 *   - a terminal's management page is `web_ui` and produces **no** device entry;
 *   - Hikvision's SDK/"server" port — TCP accepted, no HTTP ever — is
 *     `sdk_port`, and the printed entry is the SDK transport, with the helper
 *     instructions;
 *   - a closed port is `closed`, with the hairpin-NAT hint;
 *   - a public address gets the acknowledgement block only when the operator
 *     asked for it, and `--emit` refuses to write one without it.
 *
 * No terminal, no router, no vendor SDK: every service here is a few lines of
 * `node:net`/`node:http` on 127.0.0.1.
 *
 * Exit code 0 = all checks passed. Run by `npm run test:terminal-endpoint`.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDeviceBlock,
  buildPlan,
  classifyHttpResponse,
  describeEndpoint,
  digestHeader,
  emitRefusal,
  endpointIsPublic,
  parseEndpoint,
  probeEndpoint,
} from './terminal-endpoint.mjs';
import { readPublicEndpointAcknowledgement } from '../isapi-bridge/network-access-control.mjs';

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

const dir = mkdtempSync(join(tmpdir(), 'estatemate-endpoint-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const SCRIPT = fileURLToPath(new URL('./terminal-endpoint.mjs', import.meta.url));
const DEVICE_INFO = {
  DeviceInfo: {
    deviceName: 'Main Gate MinMoe',
    model: 'DS-K1T341CMFWX',
    serialNumber: 'DS-K1T341CMFWX20250101AAWR123456789',
    firmwareVersion: 'V3.5.10build 250101',
    deviceType: 'AccessControl',
  },
};

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
/**
 * Closes a fixture server without waiting for probes' keep-alive sockets to
 * wander off: a socket the probe left open is not a leak worth hanging the suite
 * on, and `closeAllConnections` is exactly that on an HTTP server.
 */
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  if (server.closeAllConnections) {
    server.close(() => resolve());
    return;
  }
  // A net.Server has no closeAllConnections: the fixture tracks its own sockets.
  server.destroySockets?.();
  server.close(() => resolve());
});

/** A terminal that answers ISAPI, optionally behind Digest. */
function isapiServer({ credentials = null, xml = false } = {}) {
  const state = { attempts: 0, authorized: 0, challenges: 0 };
  const server = createHttpServer((request, response) => {
    state.attempts += 1;
    const digest = credentials && verifyDigest(request.headers.authorization, {
      method: request.method,
      uri: request.url,
      realm: 'DS-1',
      nonce: 'nonce-1234',
      user: credentials.username,
      password: credentials.password,
    });
    if (credentials && !digest) {
      state.challenges += 1;
      response.writeHead(401, { 'WWW-Authenticate': 'Digest realm="DS-1", qop="auth", nonce="nonce-1234", opaque="opaque-1"' });
      response.end('');
      return;
    }
    if (digest) state.authorized += 1;
    if (xml) {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end(`<?xml version="1.0"?><DeviceInfo xmlns="http://www.hikvision.com/ver20/XMLSchema"><deviceName>${DEVICE_INFO.DeviceInfo.deviceName}</deviceName><model>${DEVICE_INFO.DeviceInfo.model}</model><serialNumber>${DEVICE_INFO.DeviceInfo.serialNumber}</serialNumber><firmwareVersion>${DEVICE_INFO.DeviceInfo.firmwareVersion}</firmwareVersion><deviceType>${DEVICE_INFO.DeviceInfo.deviceType}</deviceType></DeviceInfo>`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', Server: 'App-webs/' });
    response.end(JSON.stringify(DEVICE_INFO));
  });
  return { server, state };
}

/** The same Digest verification the bridge's own smoke test does. */
function verifyDigest(header, { method, uri, realm, nonce, user, password }) {
  if (!header || !/^Digest\s/i.test(header)) return false;
  const params = {};
  for (const match of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  if (params.username !== user || params.uri !== uri || params.nonce !== nonce) return false;
  const md5 = (text) => createHash('md5').update(text).digest('hex');
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const expected = params.qop
    ? md5(`${ha1}:${nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  return params.response === expected;
}

/** A published web interface: HTML everywhere. */
function webUiServer() {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8', Server: 'webs' });
    response.end('<html><head><title>Hikvision Digital Technology Co.,Ltd</title></head><body>login</body></html>');
  });
  return { server, state: {} };
}

/** Hikvision's SDK/"server" port: TCP accepted, nothing HTTP, ever. */
function sdkPortServer() {
  const state = { connections: 0 };
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // Deliberately silent: the vendor library speaks first, and an HTTP client
    // waiting for a status line gets nothing. This is the whole point.
  });
  server.destroySockets = () => { for (const socket of sockets) socket.destroy(); };
  return { server, state };
}

/**
 * Runs the CLI as a child process and waits for it.
 *
 * Async on purpose: `spawnSync` blocks this process's event loop, and the fake
 * terminals below live *in* this process — a blocked parent accepts the TCP
 * connection (the kernel backlog does that) but never answers the request, so
 * every CLI probe would look like Hikvision's silent SDK port. That is a harness
 * bug, and it produced exactly that false verdict before this comment existed.
 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

console.log('Terminal endpoint probe checks');

// ── 1. Endpoint parsing ──────────────────────────────────────────────────────
{
  const plain = parseEndpoint('102.211.122.35:8000');
  check('host:port parses, and the literal is classified',
    plain.ok && plain.host === '102.211.122.35' && plain.port === 8000 && plain.addressClass === 'public',
    JSON.stringify(plain));
  check('a scheme and a path are accepted',
    parseEndpoint('https://terminal.estate.local:8443/ISAPI/System/deviceInfo').port === 8443);
  check('a bracketed IPv6 literal keeps its port',
    parseEndpoint('[2001:db8::1]:8000').host === '2001:db8::1' && parseEndpoint('[2001:db8::1]:8000').port === 8000);
  check('a LAN address is not judged public',
    parseEndpoint('192.168.88.60:8000').addressClass === 'private');
  check('a nonsense port is refused with a sentence, not a crash',
    parseEndpoint('10.0.0.5:99999').ok === false && parseEndpoint('10.0.0.5:99999').reason.includes('TCP port'));
  check('and it is written back the way config writes it',
    describeEndpoint({ host: '102.211.122.35', port: 8000, scheme: 'http' }) === 'http://102.211.122.35:8000');
  check('a missing port is a usage error rather than a guess at the service',
    parseEndpoint('102.211.122.35').ok === false && parseEndpoint('102.211.122.35').reason.includes('has no port'),
    JSON.stringify(parseEndpoint('102.211.122.35')));
  check('port 0 is refused, and not treated as "the default"',
    parseEndpoint('10.0.0.5:0').ok === false, JSON.stringify(parseEndpoint('10.0.0.5:0')));
}

// ── 2. Live ISAPI, Digest, and the wrong password ────────────────────────────
{
  const { server, state } = isapiServer();
  const port = await listen(server);
  const endpoint = { ...parseEndpoint(`127.0.0.1:${port}`), scheme: 'http', username: 'admin' };

  const open = await probeEndpoint(endpoint, { timeoutMs: 2000 });
  check('an ISAPI terminal is identified as ISAPI', open.verdict === 'isapi', JSON.stringify(open.attempts));
  check('and its deviceInfo is read out (model, serial, firmware)',
    open.deviceInfo?.model === 'DS-K1T341CMFWX' && open.deviceInfo?.serialNumber?.startsWith('DS-K1T341CMFWX'), JSON.stringify(open.deviceInfo));

  const json = JSON.parse((await runCli(['--endpoint', `127.0.0.1:${port}`, '--json'])).stdout);
  check('the CLI exits 0 and offers a device entry for it', json.integrable === true && json.deviceEntry?.isapiHost === '127.0.0.1', JSON.stringify(json.deviceEntry));
  check('the entry carries no publicEndpoint block for a loopback address',
    json.deviceEntry && !('publicEndpoint' in json.deviceEntry), JSON.stringify(json.deviceEntry));
  check('and the password is never echoed back', !json.plan.includes('password"') && json.deviceEntry?.isapiPassword === '<device admin password>');

  await close(server);

  const protected_ = isapiServer({ credentials: { username: 'admin', password: 's3cret-device' } });
  const protectedPort = await listen(protected_.server);
  const protectedEndpoint = { ...parseEndpoint(`127.0.0.1:${protectedPort}`), scheme: 'http', username: 'admin' };

  const anonymous = await probeEndpoint(protectedEndpoint, { timeoutMs: 2000 });
  check('a Digest-protected endpoint is reported as needing credentials, not as broken',
    anonymous.verdict === 'isapi_auth_needed' && protected_.state.challenges === 1, JSON.stringify(anonymous.attempts));

  const wrong = await probeEndpoint(protectedEndpoint, { username: 'admin', password: 'wrong-password', timeoutMs: 2000 });
  check('a wrong password is a credentials failure, named as one', wrong.verdict === 'isapi_auth_failed', wrong.detail);

  const right = await probeEndpoint(protectedEndpoint, { username: 'admin', password: 's3cret-device', timeoutMs: 2000 });
  check('the right password authenticates — the Digest response verified by the device',
    right.verdict === 'isapi' && right.authenticated === true && protected_.state.authorized >= 1, JSON.stringify(protected_.state));
  check('and the device block is read through the authenticated request too',
    right.deviceInfo?.model === 'DS-K1T341CMFWX', JSON.stringify(right.deviceInfo));

  const cliAuthed = await runCli(['--endpoint', `127.0.0.1:${protectedPort}`, '--username', 'admin', '--password', 's3cret-device', '--quiet']);
  check('the CLI reports the authenticated verdict without printing the password',
    cliAuthed.status === 0 && cliAuthed.stdout.includes('isapi:') && !cliAuthed.stdout.includes('s3cret-device'), cliAuthed.stdout.trim());

  await close(protected_.server);
}

// ── 2b. Classification, without a device ────────────────────────────────────
{
  const answer = (over) => classifyHttpResponse({ answered: true, status: 200, headers: { 'content-type': 'application/json' }, body: '', ...over });
  check('a JSON body without a DeviceInfo block is not a terminal',
    answer({ body: '{"statusCode":4,"statusString":"Invalid Operation","subStatusCode":"notSupport"}' }).kind === 'other');
  check('an empty body is not a terminal either',
    answer({ body: '' }).kind === 'other');
  check('an unrelated HTML page is a web UI, not the API',
    answer({ headers: { 'content-type': 'text/html' }, body: '<html><title>Router</title></html>' }).kind === 'web_ui');
  check('a 401 with a Basic challenge is not mistaken for ISAPI Digest',
    answer({ status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } }).kind === 'other');
  check('a JSON deviceInfo block is recognised as the terminal',
    answer({ body: JSON.stringify(DEVICE_INFO) }).kind === 'isapi');
}

// ── 3. XML firmware ─────────────────────────────────────────────────────────
{
  const { server } = isapiServer({ xml: true });
  const port = await listen(server);
  const endpoint = { ...parseEndpoint(`127.0.0.1:${port}`), scheme: 'http', username: 'admin' };
  const result = await probeEndpoint(endpoint, { timeoutMs: 2000 });
  check('a firmware that answers XML instead of JSON is still an ISAPI terminal',
    result.verdict === 'isapi' && result.deviceInfo?.model === 'DS-K1T341CMFWX', JSON.stringify(result.attempts));
  await close(server);
}

// ── 4. The web interface must never become a device entry ───────────────────
{
  const { server } = webUiServer();
  const port = await listen(server);
  const endpoint = { ...parseEndpoint(`127.0.0.1:${port}`), scheme: 'http', username: 'admin' };
  const result = await probeEndpoint(endpoint, { timeoutMs: 2000 });
  check('a management page is identified as one', result.verdict === 'web_ui', result.detail);

  const cli = await runCli(['--endpoint', `127.0.0.1:${port}`, '--json']);
  const payload = JSON.parse(cli.stdout);
  check('the CLI refuses to hand out a device entry for it',
    cli.status === 1 && payload.integrable === false && payload.deviceEntry === null, `status=${cli.status}`);
  check('and the plan tells the operator to remove the rule, not to configure it',
    payload.plan.includes('management page') && payload.plan.includes('UPnP'), payload.plan.slice(-400));
  await close(server);
}

// ── 5. Hikvision's SDK port ─────────────────────────────────────────────────
{
  const { server, state } = sdkPortServer();
  const port = await listen(server);
  const endpoint = { ...parseEndpoint(`127.0.0.1:${port}`), scheme: 'http', username: 'admin' };
  const result = await probeEndpoint(endpoint, { timeoutMs: 700 });
  check('TCP accepted but no HTTP ever answers is the SDK port, not a broken device',
    result.verdict === 'sdk_port' && result.tcp.reachable === true, JSON.stringify(result.attempts));
  check('and the probe really did connect to it', state.connections >= 1, JSON.stringify(state));

  const cli = await runCli(['--endpoint', `127.0.0.1:${port}`, '--timeout', '700', '--json']);
  const payload = JSON.parse(cli.stdout);
  check('the printed entry is the SDK transport, not an isapiHost with the wrong port',
    cli.status === 0 && payload.deviceEntry?.transport === 'hik_sdk' && payload.deviceEntry?.sdkPort === port && !('isapiHost' in payload.deviceEntry),
    JSON.stringify(payload.deviceEntry));
  check('and the plan hands over the helper build and the self-test command',
    payload.plan.includes('build-hcnetsdk-helper.cmd') && payload.plan.includes('--selftest') && payload.plan.includes('docs/HIKVISION-SDK-TRANSPORT.md'),
    payload.plan.slice(-600));
  check('the SDK verdict needs no ISAPI password line', !payload.plan.includes('isapiPassword'));
  await close(server);
}

// ── 6. A closed port: the common hairpin-NAT false negative ─────────────────
{
  // A port that was listened on and then closed: something on this machine used
  // to answer there, and nothing does now.
  const placeholder = createHttpServer(() => {});
  const closedPort = await listen(placeholder);
  await close(placeholder);
  const endpoint = { ...parseEndpoint(`127.0.0.1:${closedPort}`), scheme: 'http', username: 'admin' };
  const result = await probeEndpoint(endpoint, { timeoutMs: 700 });
  check('a closed port is reported as closed with what to check',
    result.verdict === 'closed' && result.tcp.reachable === false, result.detail);
  const cli = await runCli(['--endpoint', `127.0.0.1:${closedPort}`, '--timeout', '700']);
  check('and the plan names hairpin NAT as the first thing to rule out',
    cli.status === 1 && cli.stdout.includes('hairpin NAT'), cli.stdout.slice(-300));
}

// ── 7. The acknowledgement rule for a public address ────────────────────────
{
  const publicEndpoint = { ...parseEndpoint('203.0.113.9:8000'), scheme: 'http', kind: 'sdk_port', username: 'admin' };
  check('an address on the Internet is recognised as one', endpointIsPublic(publicEndpoint) === true);
  check('and a LAN address is not', endpointIsPublic({ ...parseEndpoint('192.168.88.60:8000'), literal: true, addressClass: 'private' }) === false);

  const plain = buildDeviceBlock(publicEndpoint, { name: 'Main Gate (SDK)' });
  check('without --acknowledge the entry carries no acknowledgement to paste',
    !('publicEndpoint' in plain) && plain.transport === 'hik_sdk', JSON.stringify(plain));

  check('a truthy-but-not-true value is not an acknowledgement',
    readPublicEndpointAcknowledgement({ publicEndpoint: { acknowledged: 'yes' } }).acknowledged === false);
  check('and the spellings the other readers accept are read the same way here',
    readPublicEndpointAcknowledgement({ public_endpoint: { acknowledged: true, by: 'x', reason: 'contractor rule' } }).by === 'x'
      && readPublicEndpointAcknowledgement({ publicEndpoint: { acknowledged: true, acknowledgedBy: 'y', at: '2026-01-01', note: 'n' } }).at === '2026-01-01');
  check('a private address never gets the block, even when one is asked for',
    !('publicEndpoint' in buildDeviceBlock({ ...parseEndpoint('192.168.88.60:8000'), scheme: 'http', kind: 'isapi', username: 'admin' }, { acknowledge: true, acknowledgedBy: 'x' })));

  const accepted = buildDeviceBlock(publicEndpoint, { name: 'Main Gate (SDK)', acknowledge: true, acknowledgedBy: 'admin@royalpalm', reason: 'contractor rule', at: '2026-10-11T09:00:00Z' });
  check('with it, the block names who accepted the risk and when',
    accepted.publicEndpoint?.acknowledged === true
      && accepted.publicEndpoint?.acknowledgedBy === 'admin@royalpalm'
      && accepted.publicEndpoint?.acknowledgedAt === '2026-10-11T09:00:00Z'
      && accepted.publicEndpoint?.note === 'contractor rule',
    JSON.stringify(accepted.publicEndpoint));

  // The plan is what the operator reads: it must say the decision is recorded,
  // not that the risk went away, and it must keep pointing at the LAN.
  const plannedAck = buildPlan(
    { tcp: { reachable: true, error: null }, attempts: [], verdict: 'sdk_port', detail: 'the SDK port', deviceInfo: null, tls: null },
    publicEndpoint,
    { acknowledged: true, acknowledgedBy: 'admin@royalpalm' },
  );
  check('with the acknowledgement the plan says the decision is recorded, not the risk removed',
    plannedAck.includes('recorded') && plannedAck.includes('Recorded is not removed'), plannedAck.slice(0, 400));
  check('and it still names the LAN address as the posture to aim for',
    plannedAck.includes('LAN address stays the posture to aim for') || plannedAck.includes('LAN'), plannedAck.slice(0, 400));
  check('and it offers the LAN discovery tools and the no-exposure interim before the helper',
    plannedAck.includes('SADP') && plannedAck.includes('iVMS-4200') && plannedAck.includes('manual synchronization'), plannedAck.slice(0, 900));

  const plannedPlain = buildPlan(
    { tcp: { reachable: true, error: null }, attempts: [], verdict: 'isapi', detail: 'ISAPI', deviceInfo: null, tls: null },
    { ...publicEndpoint, kind: 'isapi' },
    { acknowledged: false },
  );
  check('without it, the plan says the agent will refuse the entry',
    plannedPlain.includes('the agent refuses to start on a public address without one'), plannedPlain.slice(-500));
  check('and it names the cleartext risk of an http public endpoint',
    plannedPlain.includes('cleartext'), plannedPlain.slice(0, 700));

  // The entry must use exactly the field names the agent normalises, or the
  // paste-a-block workflow produces a device the bridge cannot read.
  const isapiEntry = buildDeviceBlock({ ...parseEndpoint('192.168.88.60:80'), scheme: 'http', kind: 'isapi', username: 'admin' }, { name: 'Gate' });
  check('the ISAPI entry uses the fields the agent reads, and a placeholder password',
    isapiEntry.isapiHost === '192.168.88.60' && isapiEntry.isapiPort === 80 && isapiEntry.protocol === 'http'
      && isapiEntry.enabled === true && isapiEntry.eventStream === true
      && isapiEntry.isapiPassword === '<device admin password>' && !('password' in isapiEntry),
    JSON.stringify(isapiEntry));
  const sdkEntry = buildDeviceBlock({ ...parseEndpoint('192.168.88.60:8000'), scheme: 'http', kind: 'sdk_port', username: 'admin' }, { name: 'Gate' });
  check('and the SDK entry uses the SDK fields, never an isapiHost',
    sdkEntry.transport === 'hik_sdk' && sdkEntry.sdkHost === '192.168.88.60' && sdkEntry.sdkPort === 8000
      && sdkEntry.sdkPassword === '<device admin password>' && !('isapiHost' in sdkEntry),
    JSON.stringify(sdkEntry));

  // --emit is the one thing that writes; it must not write a public entry the
  // agent would refuse to start on. The rule itself is pure, so it is checked
  // here without depending on how a TEST-NET address answers on this machine's
  // network — the probe below is the end-to-end half of the same rule.
  check('a public endpoint without --acknowledge is refused by name',
    emitRefusal({ integrable: true, endpoint: publicEndpoint, acknowledge: false })?.includes('--acknowledge') === true);
  check('and with it there is nothing to refuse',
    emitRefusal({ integrable: true, endpoint: publicEndpoint, acknowledge: true }) === null);
  check('a private endpoint needs no acknowledgement to be written',
    emitRefusal({ integrable: true, endpoint: { ...parseEndpoint('192.168.88.60:8000') }, acknowledge: false }) === null);
  check('and a probe that found nothing integrable is refused for that reason first, not for the missing acknowledgement',
    emitRefusal({ integrable: false, endpoint: publicEndpoint, acknowledge: false })?.includes('not integrable') === true);

  const outFile = join(dir, 'devices.json');
  const refused = await runCli(['--endpoint', '203.0.113.9:8000', '--emit', outFile, '--json', '--timeout', '300']);
  const refusedReport = JSON.parse(refused.stdout);
  check('--emit writes nothing for a public endpoint without --acknowledge, whatever the probe found',
    refused.status === 1 && !existsSync(outFile)
      && refused.stderr.trim() === emitRefusal({ integrable: refusedReport.integrable, endpoint: publicEndpoint, acknowledge: false }),
    `status=${refused.status} verdict=${refusedReport.probe.verdict} stderr=${refused.stderr.trim()}`);

  // And a private address emits without an acknowledgement, which is the path an
  // installer on the estate LAN takes.
  const { server } = isapiServer();
  const port = await listen(server);
  const emitted = await runCli(['--endpoint', `127.0.0.1:${port}`, '--emit', outFile, '--device-id', '55555555-5555-4555-8555-555555555555', '--name', 'Main Gate MinMoe', '--json']);
  check('--emit writes the entry for an integrable private endpoint',
    emitted.status === 0 && readFileSync(outFile, 'utf8').includes('"estateMateDeviceId":"55555555-5555-4555-8555-555555555555"'), emitted.stderr.trim());
  check('and the entry it writes is one JSON object per line',
    readFileSync(outFile, 'utf8').trim().split('\n').every((line) => (() => { try { JSON.parse(line); return true; } catch { return false; } })()));
  await close(server);
}

// ── 8. Digest maths, on its own ─────────────────────────────────────────────
{
  const header = digestHeader({
    method: 'GET',
    uri: '/ISAPI/System/deviceInfo?format=json',
    challenge: 'Digest realm="DS-1", qop="auth", nonce="abc", opaque="def"',
    username: 'admin',
    password: 'pw',
  });
  check('a Digest challenge produces a header with qop, nc and cnonce',
    header.startsWith('Digest ') && header.includes('qop=auth') && header.includes('nc=00000001') && header.includes('cnonce="'), header);
  check('the opaque value is echoed back verbatim, as RFC 7616 requires',
    header.includes('opaque="def"'), header);
  check('a challenge without a realm or nonce produces no header rather than a broken one',
    digestHeader({ method: 'GET', uri: '/', challenge: 'Basic realm="x"', username: 'a', password: 'b' }) === null);
  check('a challenge without qop falls back to the legacy single-hash form',
    digestHeader({ method: 'GET', uri: '/', challenge: 'Digest realm="R", nonce="N"', username: 'u', password: 'p' })
      .includes('response="') && !digestHeader({ method: 'GET', uri: '/', challenge: 'Digest realm="R", nonce="N"', username: 'u', password: 'p' }).includes('qop='));
  const md5 = (text) => createHash('md5').update(text).digest('hex');
  const legacy = digestHeader({ method: 'GET', uri: '/ISAPI/System/deviceInfo', challenge: 'Digest realm="DS-1", nonce="abc"', username: 'admin', password: 'pw' });
  const expectedLegacy = md5(`${md5('admin:DS-1:pw')}:abc:${md5('GET:/ISAPI/System/deviceInfo')}`);
  check('and that hash is the one a legacy device checks',
    legacy.includes(`response="${expectedLegacy}"`), legacy);
  const otherPassword = digestHeader({ method: 'GET', uri: '/ISAPI/System/deviceInfo', challenge: 'Digest realm="DS-1", nonce="abc"', username: 'admin', password: 'not-pw' });
  check('a different password produces a different response',
    !otherPassword.includes(`response="${expectedLegacy}"`));
}

// ── 9. The CLI's own contract ───────────────────────────────────────────────
{
  const malformed = await runCli(['--endpoint', '102.211.122.35']);
  check('a malformed endpoint exits 2 and prints the usage, not a stack trace',
    malformed.status === 2 && malformed.stderr.includes('has no port') && malformed.stderr.includes('usage:'),
    `status=${malformed.status} stderr=${malformed.stderr.slice(0, 200)}`);

  const help = await runCli(['--help']);
  check('--help exits 0 and names the exit codes',
    help.status === 0 && help.stdout.includes('Exit codes') && help.stdout.includes('integrable'),
    `status=${help.status}`);

  const noEndpoint = await runCli([]);
  check('no endpoint at all is a usage error', noEndpoint.status === 2 && noEndpoint.stderr.includes('--endpoint'), `status=${noEndpoint.status}`);
}

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
