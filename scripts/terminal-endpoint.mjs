#!/usr/bin/env node
/**
 * What actually answers at a device address — and whether this estate can
 * integrate it that way.
 *
 * The question this script exists to answer, in the words it was asked:
 *
 *   "The router is not mine to change. `102.211.122.35:8000` is what iVMS-4200
 *    uses to reach the terminal. Can EstateMate reach it too?"
 *
 * A port-forward to a Hikvision terminal can expose any of three different
 * services, and they are not interchangeable:
 *
 *   * the **ISAPI/HTTP** service (usually 80/443, the port the bridge speaks),
 *     possibly on a non-standard outside port such as `:8000`;
 *   * the **SDK/"server" port** (8000 in the factory config, what iVMS-4200 and
 *     Hik-Connect use) — a proprietary binary protocol, *not* HTTP;
 *   * the terminal's **web interface**, which is a management surface and must
 *     not be what an installer "integrates" by pointing the bridge at it.
 *
 * So this script probes before anyone configures anything, says which one it
 * found, and prints the exact devices-file entry that follows from it — including
 * the `publicEndpoint` acknowledgement a public address requires (see
 * `docs/PUBLIC-ENDPOINT-DEVICE.md`), because that decision has to be recorded
 * rather than assumed.
 *
 * It is read-only against the site: a TCP connect, one unauthenticated GET, and
 * (only with credentials) one Digest-authenticated GET. Nothing is written to a
 * device, no configuration file is modified — the JSON block is printed for a
 * human to paste, and `--emit <file>` writes only when asked.
 *
 * Usage:
 *   node scripts/terminal-endpoint.mjs --endpoint <host:port> [options]
 *
 *   --username <user>        terminal account (default: admin, only user for the Digest attempt)
 *   --password <password>    terminal password — never printed, never written
 *   --tls                    the endpoint is https, not http
 *   --timeout <ms>           per-attempt timeout (default 5000)
 *   --name <label>           device name to use in the printed block
 *   --device-id <uuid>       EstateMate device id (Device agent → Connected terminals)
 *   --acknowledge            include the "publicEndpoint" block accepting the risk
 *   --acknowledged-by <who>  who accepts it (default: the current OS user)
 *   --reason <text>          why (goes in the block's note)
 *   --emit <file>            append the printed block to <file> as JSON
 *   --json                   machine-readable findings instead of the plan
 *   --quiet                  only the verdict line
 *
 * Exit codes: 0 = integrable over this endpoint, 1 = not integrable as given
 * (the plan says what to do instead), 2 = usage/network error.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  classifyAddress,
  isAddressLiteral,
  publicEndpointRisks,
} from '../isapi-bridge/network-access-control.mjs';

const ISAPI_DEVICE_INFO_PATH = '/ISAPI/System/deviceInfo?format=json';
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

// ------------------------------------------------------------------ parsing ---

/**
 * `host:port`, `[v6]:port` or `https://host:port/...` → `{ host, port, scheme }`.
 *
 * The port is **required**. Defaulting it would mean guessing which service an
 * operator meant — 80 and 8000 are different services on the same terminal, and
 * a probe that quietly assumed one of them would answer a question nobody asked.
 */
export function parseEndpoint(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'no endpoint given — pass --endpoint <host:port>' };
  let rest = text;
  let scheme = null;
  const schemeMatch = rest.match(/^(https?):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  // A bare "host" with a path has no port; a bare "host:port" does.
  rest = rest.replace(/\/.*$/, '');
  let host;
  let portText;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return { ok: false, reason: `"${text}" has an unclosed IPv6 bracket` };
    host = rest.slice(1, close);
    portText = rest.slice(close + 1).replace(/^:/, '');
  } else {
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > 0 && !rest.slice(lastColon + 1).includes(':')) {
      host = rest.slice(0, lastColon);
      portText = rest.slice(lastColon + 1);
    } else {
      host = rest;
      portText = '';
    }
  }
  if (!host) return { ok: false, reason: `"${text}" has no host` };
  if (!portText) {
    return { ok: false, reason: `"${text}" has no port — write it as host:port (80 is ISAPI, 8000 is the SDK/"server" port; they are different services)` };
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `"${portText}" is not a TCP port (1-65535)` };
  }
  return { ok: true, host, port, scheme, literal: isAddressLiteral(host), addressClass: classifyAddress(host) };
}

/** The endpoint as it should be written in config, credentials never included. */
export function describeEndpoint(endpoint) {
  const scheme = endpoint.scheme || 'http';
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `${scheme}://${host}:${endpoint.port}`;
}

// ------------------------------------------------------------------- probes ---

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ reachable: true, error: null }));
    socket.once('timeout', () => done({ reachable: false, error: 'timed out' }));
    socket.once('error', (error) => done({ reachable: false, error: error.code || error.message }));
  });
}

/**
 * One HTTP(S) GET, without following redirects and without throwing: a site with
 * a terminal that refuses to answer still needs the rest of the answer. The body
 * is capped — this is a probe, not a download.
 */
export function httpProbe(endpoint, { path = '/', headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const secure = (endpoint.scheme || 'http') === 'https';
    const request = (secure ? httpsRequest : httpRequest)({
      host: endpoint.host,
      port: endpoint.port,
      path,
      method: 'GET',
      headers: { Accept: 'application/json, text/xml, text/html;q=0.9, */*;q=0.1', ...headers },
      ...(secure ? { rejectUnauthorized: false } : {}),
      timeout: timeoutMs,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < MAX_BODY_BYTES) body += chunk;
      });
      response.on('end', () => {
        resolve({
          answered: true,
          status: response.statusCode,
          headers: response.headers,
          body,
          error: null,
          tls: secure ? tlsFacts(response.socket) : null,
        });
      });
    });
    request.once('timeout', () => {
      request.destroy();
      resolve({ answered: false, status: null, headers: {}, body: '', error: 'no HTTP response before the timeout', tls: null });
    });
    request.once('error', (error) => {
      resolve({ answered: false, status: null, headers: {}, body: '', error: error.code || error.message, tls: null });
    });
    request.end();
  });
}

function tlsFacts(socket) {
  try {
    const certificate = socket.getPeerCertificate?.() || {};
    return {
      authorized: Boolean(socket.authorized),
      authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
      fingerprint256: certificate.fingerprint256 || null,
      subject: certificate.subject?.CN || null,
      issuer: certificate.issuer?.CN || null,
      validTo: certificate.valid_to || null,
    };
  } catch {
    return null;
  }
}

/** Minimal Digest (RFC 7616) so a protected ISAPI endpoint can be identified. */
export function digestHeader({ method, uri, challenge, username, password }) {
  const params = {};
  for (const match of String(challenge || '').replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  if (!params.realm || !params.nonce) return null;
  const md5 = (text) => createHash('md5').update(text).digest('hex');
  const qop = params.qop ? String(params.qop).split(',')[0].trim() : null;
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${username}:${params.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${params.nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${params.realm}"`,
    `nonce="${params.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (params.opaque) parts.push(`opaque="${params.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

function parseIsapiDeviceInfo(response) {
  const body = String(response.body || '').trim();
  if (!body) return null;
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      const info = parsed.DeviceInfo || parsed.deviceInfo || null;
      if (info && typeof info === 'object') return normaliseDeviceInfo(info);
    } catch {
      return null;
    }
    return null;
  }
  if (body.startsWith('<')) {
    const pick = (tag) => {
      const match = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
      return match ? match[1].trim() : null;
    };
    if (!/<DeviceInfo/i.test(body)) return null;
    return normaliseDeviceInfo({
      deviceName: pick('deviceName'),
      model: pick('model'),
      serialNumber: pick('serialNumber'),
      firmwareVersion: pick('firmwareVersion'),
      deviceType: pick('deviceType'),
    });
  }
  return null;
}

function normaliseDeviceInfo(info) {
  const text = (value) => (value === undefined || value === null || value === '' ? null : String(value));
  return {
    deviceName: text(info.deviceName),
    model: text(info.model),
    serialNumber: text(info.serialNumber),
    firmwareVersion: text(info.firmwareVersion),
    deviceType: text(info.deviceType),
  };
}

/**
 * Classifies one answered HTTP response. Kept pure so the verdict table in
 * `docs/PUBLIC-ENDPOINT-DEVICE.md` can be checked against it without a device.
 */
export function classifyHttpResponse(response) {
  if (!response || !response.answered) return { kind: 'no_answer', detail: response?.error || 'no HTTP response' };
  const status = Number(response.status || 0);
  const challenge = String(response.headers?.['www-authenticate'] || '');
  const contentType = String(response.headers?.['content-type'] || '');
  const server = String(response.headers?.server || '');
  const info = parseIsapiDeviceInfo(response);
  if (status === 401 && /digest/i.test(challenge)) {
    return { kind: 'auth_required', status, detail: `ISAPI is there but this request had no credentials (HTTP 401, Digest challenge from ${server || 'the device'})`, challenge };
  }
  if (status === 401) {
    return { kind: 'other', status, detail: `HTTP 401 without a Digest challenge (${server || 'unknown server'}) — not an ISAPI device`, server };
  }
  if (status >= 200 && status < 300 && info) {
    return { kind: 'isapi', status, detail: `ISAPI deviceInfo answered (HTTP ${status}${server ? `, ${server}` : ''})`, deviceInfo: info, server };
  }
  if (status >= 200 && status < 300 && /html/i.test(contentType)) {
    return { kind: 'web_ui', status, detail: `an HTML page answered (HTTP ${status}${server ? `, ${server}` : ''}) — this is the terminal's management interface, not an integration point`, server };
  }
  return { kind: 'other', status, detail: `HTTP ${status}${server ? ` ${server}` : ''} ${contentType || ''}`.trim(), server, contentType };
}

/**
 * The whole probe: TCP, then HTTP, then (when credentials are given) one
 * authenticated Digest attempt.
 *
 * `verdict` is what a human acts on, and it is deliberately blunt:
 *   `isapi`              — point the bridge at it (with the printed block)
 *   `isapi_auth_needed`  — ISAPI, but no credentials were offered (or they were not given)
 *   `sdk_port`           — Hikvision's SDK protocol: use the SDK transport
 *   `web_ui`             — the management page is what is published
 *   `http_other`         — something answers HTTP, but not this terminal's ISAPI
 *   `closed`             — accepted nothing (or refused); check the rule
 *   `unreachable`        — no TCP at all from here (timeout/refused/DNS)
 */
export async function probeEndpoint(endpoint, { username = 'admin', password = '', tls = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const primary = { ...endpoint, scheme: tls ? 'https' : 'http' };
  const result = {
    endpoint: { host: endpoint.host, port: endpoint.port, literal: endpoint.literal, addressClass: endpoint.addressClass },
    tcp: { reachable: false, error: null },
    attempts: [],
    verdict: 'unreachable',
    detail: '',
    deviceInfo: null,
    authenticated: false,
    tls: null,
  };

  result.tcp = await tcpProbe(endpoint.host, endpoint.port, timeoutMs);
  if (!result.tcp.reachable) {
    result.verdict = 'closed';
    result.detail = `nothing accepted a TCP connection at ${describeEndpoint(primary)} (${result.tcp.error})`;
    return result;
  }

  const first = await httpProbe(primary, { path: ISAPI_DEVICE_INFO_PATH, timeoutMs });
  let classification = classifyHttpResponse(first);
  if (first.tls) result.tls = first.tls;
  result.attempts.push({ scheme: primary.scheme, path: ISAPI_DEVICE_INFO_PATH, answered: first.answered, status: first.status, error: first.error, reason: classification.kind, deviceInfo: classification.deviceInfo || null, tls: first.tls });

  // A 401 with a Digest challenge is the fingerprint of an ISAPI endpoint. With
  // credentials, prove it: the second request is the one that says whether the
  // account works, and a wrong password is the difference between "point the
  // bridge here" and "fix the credentials first".
  if (classification.kind === 'auth_required' && password) {
    const header = digestHeader({ method: 'GET', uri: ISAPI_DEVICE_INFO_PATH, challenge: classification.challenge, username, password });
    if (header) {
      const authed = await httpProbe(primary, { path: ISAPI_DEVICE_INFO_PATH, headers: { Authorization: header }, timeoutMs });
      const authedClass = classifyHttpResponse(authed);
      result.attempts.push({ scheme: primary.scheme, path: ISAPI_DEVICE_INFO_PATH, answered: authed.answered, status: authed.status, error: authed.error, reason: authedClass.kind, deviceInfo: authedClass.deviceInfo || null, tls: authed.tls });
      if (authedClass.kind === 'isapi') {
        result.authenticated = true;
        classification = authedClass;
      } else if (authed.status === 401) {
        result.authenticated = false;
        classification = {
          kind: 'auth_failed',
          status: 401,
          detail: `the device answered HTTP 401 to a valid Digest request — the username or password is wrong, or that account has no remote-access right`,
        };
      }
    }
  }

  if (classification.deviceInfo) result.deviceInfo = classification.deviceInfo;

  switch (classification.kind) {
    case 'isapi':
      result.verdict = 'isapi';
      result.detail = `ISAPI answered at ${describeEndpoint(primary)}${result.authenticated ? ' with the given credentials' : ''} — an ISAPI device entry works from here`;
      break;
    case 'auth_required':
      result.verdict = 'isapi_auth_needed';
      result.detail = `ISAPI is there at ${describeEndpoint(primary)} but credentials are needed — pass --username/--password to prove an account works`;
      break;
    case 'auth_failed':
      result.verdict = 'isapi_auth_failed';
      result.detail = classification.detail;
      break;
    case 'web_ui':
      result.verdict = 'web_ui';
      result.detail = classification.detail;
      break;
    case 'no_answer':
      result.verdict = 'sdk_port';
      result.detail = `TCP connects but nothing HTTP ever answers at ${describeEndpoint(primary)} — this is Hikvision's SDK/"server" port (the protocol iVMS-4200 speaks). EstateMate reaches it with the SDK transport, not with isapiHost`;
      break;
    default:
      result.verdict = 'http_other';
      result.detail = classification.detail;
  }

  // When the caller said https and it did not answer HTTP either, say so rather
  // than blaming the SDK port: a TLS handshake failure looks like silence here.
  if (result.verdict === 'sdk_port' && primary.scheme === 'https' && result.attempts[0].error && /SSL|TLS|certificate|ECONNRESET|EPROTO/i.test(String(result.attempts[0].error))) {
    result.verdict = 'http_other';
    result.detail = `nothing answered https at ${describeEndpoint(primary)} (${result.attempts[0].error}). Retry without --tls: port 8000 is not TLS, and a handshake against it fails exactly like this`;
  }
  return result;
}

// --------------------------------------------------------------------- plan ---

/** Whether this endpoint needs the recorded acknowledgement. */
export function endpointIsPublic(endpoint) {
  return endpoint.literal && endpoint.addressClass === 'public';
}

/**
 * The devices-file entry that follows from the findings. It never contains the
 * password — that is the operator's to paste — and it only carries a
 * `publicEndpoint` block when the operator asked for one with `--acknowledge`,
 * because writing an acknowledgement on someone's behalf would defeat the point
 * of recording it.
 */
export function buildDeviceBlock(endpoint, { name = null, deviceId = null, acknowledge = false, acknowledgedBy = null, reason = null, at = new Date().toISOString() } = {}) {
  const isPublic = endpointIsPublic(endpoint);
  const label = name || `${endpoint.host}${isPublic ? ' (public endpoint)' : ''}`;
  if (endpoint.kind === 'sdk_port') {
    const block = {
      ...(deviceId ? { estateMateDeviceId: deviceId } : {}),
      name: label,
      transport: 'hik_sdk',
      sdkHost: endpoint.host,
      sdkPort: endpoint.port,
      sdkUsername: endpoint.username || 'admin',
      sdkPassword: '<device admin password>',
      enabled: true,
      eventStream: true,
    };
    if (isPublic && acknowledge) {
      block.publicEndpoint = {
        acknowledged: true,
        acknowledgedBy: acknowledgedBy || defaultAcknowledgedBy(),
        acknowledgedAt: at,
        note: reason || 'port-forward on a router this site does not control; the SDK port is the only path to this terminal',
      };
    }
    return block;
  }
  const block = {
    ...(deviceId ? { estateMateDeviceId: deviceId } : {}),
    name: label,
    isapiHost: endpoint.host,
    isapiPort: endpoint.port,
    isapiUsername: endpoint.username || 'admin',
    isapiPassword: '<device admin password>',
    protocol: endpoint.scheme || 'http',
    enabled: true,
    eventStream: true,
  };
  if (isPublic && acknowledge) {
    block.publicEndpoint = {
      acknowledged: true,
      acknowledgedBy: acknowledgedBy || defaultAcknowledgedBy(),
      acknowledgedAt: at,
      note: reason || 'port-forward on a router this site does not control; no LAN path to the terminal',
    };
  }
  return block;
}

function defaultAcknowledgedBy() {
  try {
    return userInfo().username || '<your name>';
  } catch {
    return '<your name>';
  }
}

/** The human-readable plan: what answered, what it means, what to do next. */
export function buildPlan(result, endpoint, { acknowledged = false, acknowledgedBy = null, reason = null, deviceId = null, name = null } = {}) {
  const isPublic = endpointIsPublic(endpoint);
  const lines = [];
  lines.push(`Endpoint        ${describeEndpoint(endpoint)}${endpoint.literal ? ` (${endpoint.addressClass} address)` : ' (hostname — not judged as public/private)'}`);
  lines.push(`TCP             ${result.tcp.reachable ? 'accepted' : `no connection (${result.tcp.error})`}`);
  for (const attempt of result.attempts) {
    const where = `${attempt.scheme} ${attempt.path}`;
    const what = attempt.answered ? `HTTP ${attempt.status} → ${attempt.reason}` : `${attempt.error} → ${attempt.reason}`;
    lines.push(`Probe           ${where} — ${what}`);
  }
  if (result.deviceInfo) {
    const bits = [result.deviceInfo.model, result.deviceInfo.deviceName, result.deviceInfo.firmwareVersion, result.deviceInfo.serialNumber].filter(Boolean);
    if (bits.length) lines.push(`Device          ${bits.join(' | ')}`);
  }
  if (result.tls) {
    lines.push(`TLS             ${result.tls.authorized ? 'trusted' : `NOT trusted (${result.tls.authorizationError})`}${result.tls.fingerprint256 ? `, sha256 ${result.tls.fingerprint256}` : ''}`);
    if (!result.tls.authorized) {
      lines.push('                this host would refuse it until the certificate is trusted (NODE_EXTRA_CA_CERTS, or the OS trust store) —');
      lines.push('                see docs/PUBLIC-ENDPOINT-DEVICE.md §5. Until then, use the SDK port or a LAN path.');
    }
  }
  lines.push(`Verdict         ${result.verdict.toUpperCase()} — ${result.detail}`);
  lines.push('');

  if (result.verdict === 'sdk_port') {
    lines.push('This is Hikvision\'s SDK/"server" port — the protocol iVMS-4200 uses, not HTTP.');
    lines.push('The bridge can reach it with the SDK transport, which drives a helper linking the site\'s own HCNetSDK:');
    lines.push('  • Build it:        bridge-apps/windows/hcnetsdk/build-hcnetsdk-helper.cmd   (Windows, no toolchain needed)');
    lines.push('  • Prove it:        EstateMateHikSdk.exe --selftest ' + endpoint.host + ':' + endpoint.port + ' admin \'<password>\'');
    lines.push('  • Enable it:       "hikSdk": { "enabled": true } in agent-config.json');
    lines.push('  • Full procedure:  docs/HIKVISION-SDK-TRANSPORT.md');
    lines.push('');
    lines.push('Before you do: the terminal\'s own LAN address needs no vendor SDK, no helper and no exposure. If you can');
    lines.push('reach that LAN at all, find it first — SADP on the site network, or iVMS-4200 → Device Management →');
    lines.push('Remote Configuration → Network → TCP/IP — and run this probe against <lan-address>:80. Until then, the');
    lines.push('honest interim is manual synchronization (Hardware actions), which needs no exposure at all.');
  } else if (result.verdict === 'isapi' || result.verdict === 'isapi_auth_needed') {
    lines.push('This is an ISAPI endpoint, which the bridge already speaks — no helper install needed.');
    if (result.verdict === 'isapi_auth_needed') {
      lines.push('Prove the account before configuring it: re-run with --username and --password.');
    }
  } else if (result.verdict === 'isapi_auth_failed') {
    lines.push('The credentials are the problem, not the route. Reset the terminal account (or try another one) and re-run.');
  } else if (result.verdict === 'web_ui') {
    lines.push('Do NOT point the bridge at the management page: it is not ISAPI, and publishing it is a separate risk to remove.');
    lines.push('On the terminal: turn off platform access (Hik-Connect/HiDDNS) and UPnP, remove that forwarding rule, and use the ISAPI or SDK port instead.');
  } else if (result.verdict === 'closed') {
    lines.push('Nothing answered. If this was run from the estate itself, the router may be refusing its own WAN address (hairpin NAT):');
    lines.push('re-run from outside (phone on mobile data), or from the machine that already reaches the terminal.');
  } else {
    lines.push('Something else lives at this address. Check which outside port the router forwards to the terminal, and from where.');
  }
  lines.push('');

  if (isPublic) {
    const risks = publicEndpointRisks({ protocol: result.verdict === 'sdk_port' ? 'hik_sdk' : (endpoint.scheme || 'http'), host: endpoint.host, port: endpoint.port });
    lines.push('This address is on the public Internet, so the terminal answers for itself and this must be a recorded decision:');
    for (const risk of risks) lines.push(`  ! ${risk}`);
    if (acknowledged) {
      lines.push('  → the block below records the decision and who made it. Recorded is not removed: the risks above stay true,');
      lines.push('    the agent logs them at every start, and a LAN address stays the posture to aim for.');
    } else {
      lines.push('  → re-run with --acknowledge --acknowledged-by "<your name>" --reason "<why>" to add it, or give the terminal a LAN address.');
    }
    lines.push('');
  }

  const integrable = ['isapi', 'isapi_auth_needed', 'sdk_port'].includes(result.verdict);
  if (!integrable) {
    // Printing a device entry for an endpoint that cannot work is how a
    // management page or an unrelated service ends up in a devices file.
    lines.push('No device entry is printed: this endpoint is not an integration point for this bridge.');
    lines.push('');
    return lines.join('\n');
  }

  const block = buildDeviceBlock({ ...endpoint, kind: result.verdict, username: endpoint.username }, { name, deviceId, acknowledge: acknowledged, acknowledgedBy, reason });
  lines.push('Device entry for isapi-devices.json:');
  lines.push(JSON.stringify(block, null, 2));
  if (!acknowledged && isPublic) {
    lines.push('(no "publicEndpoint" block yet — the agent refuses to start on a public address without one, and');
    lines.push(' the exposure checker reports an error until it is there: docs/PUBLIC-ENDPOINT-DEVICE.md)');
  }
  lines.push('');
  lines.push('Then: npm run inbound:check -- --config agent-config.json --devices isapi-devices.json');
  return lines.join('\n');
}

// ---------------------------------------------------------------------- CLI ---

/**
 * Why `--emit` will not write an entry, or `null` when it may.
 *
 * A pure function on purpose: the first refusal is about what the probe found,
 * the second is about the operator's decision to record a public endpoint, and
 * both are policy — they must be checkable without depending on how the address
 * happens to answer on the network the check is running from.
 */
export function emitRefusal({ integrable, endpoint, acknowledge = false }) {
  if (!integrable) return 'terminal-endpoint: not emitting a device entry for an endpoint that is not integrable';
  if (!acknowledge && endpointIsPublic(endpoint)) {
    return 'terminal-endpoint: refusing to emit a public endpoint without --acknowledge (the agent would refuse to start on it)';
  }
  return null;
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { flags._.push(token); continue; }
    const name = token.slice(2);
    if (['json', 'quiet', 'tls', 'acknowledge', 'help'].includes(name)) { flags[name] = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function usage(stream = process.stdout) {
  stream.write(`usage: node scripts/terminal-endpoint.mjs --endpoint <host:port> [options]

  --username <user>        terminal account (default: admin)
  --password <password>    terminal password (never printed or written)
  --tls                    the endpoint speaks https
  --timeout <ms>           per-attempt timeout (default ${DEFAULT_TIMEOUT_MS})
  --name <label>           device name for the printed entry
  --device-id <uuid>       EstateMate device id from the portal
  --acknowledge            include the publicEndpoint acknowledgement
  --acknowledged-by <who>  who accepts the risk (default: current OS user)
  --reason <text>          why (stored in the acknowledgement note)
  --emit <file>            append the printed entry to <file> as JSON
  --json                   machine-readable findings
  --quiet                  verdict line only

Exit codes: 0 integrable, 1 not integrable as given, 2 usage or network error.
`);
}

async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`terminal-endpoint: ${error.message}\n`);
    return 2;
  }
  if (flags.help) { usage(); return 0; }
  if (!flags.endpoint) {
    process.stderr.write('terminal-endpoint: --endpoint <host:port> is required\n');
    usage(process.stderr);
    return 2;
  }

  const parsed = parseEndpoint(flags.endpoint);
  if (!parsed.ok) {
    // A usage error goes where the operator is looking, and the stack trace
    // stays out of it: this is a one-line command, not a program.
    process.stderr.write(`terminal-endpoint: ${parsed.reason}\n`);
    usage(process.stderr);
    return 2;
  }
  const timeoutMs = Number(flags.timeout || DEFAULT_TIMEOUT_MS);
  const endpoint = {
    ...parsed,
    kind: null,
    username: String(flags.username || 'admin'),
  };

  const result = await probeEndpoint(endpoint, {
    username: endpoint.username,
    password: String(flags.password || ''),
    tls: Boolean(flags.tls),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });
  endpoint.kind = result.verdict;
  endpoint.username = endpoint.username;
  endpoint.scheme = parsed.scheme || (flags.tls ? 'https' : 'http');

  const integrable = result.verdict === 'isapi' || result.verdict === 'isapi_auth_needed' || result.verdict === 'sdk_port';
  const plan = buildPlan(result, endpoint, {
    acknowledged: Boolean(flags.acknowledge),
    acknowledgedBy: flags['acknowledged-by'] || null,
    reason: flags.reason || null,
    deviceId: flags['device-id'] || null,
    name: flags.name || null,
  });

  if (flags.json) {
    const block = buildDeviceBlock(endpoint, {
      name: flags.name || null,
      deviceId: flags['device-id'] || null,
      acknowledge: Boolean(flags.acknowledge),
      acknowledgedBy: flags['acknowledged-by'] || null,
      reason: flags.reason || null,
    });
    process.stdout.write(`${JSON.stringify({
      endpoint: { ...result.endpoint, scheme: endpoint.scheme },
      probe: result,
      integrable,
      plan,
      deviceEntry: integrable ? block : null,
    }, null, 2)}\n`);
  } else if (flags.quiet) {
    process.stdout.write(`${describeEndpoint(endpoint)} → ${result.verdict}: ${result.detail}\n`);
  } else {
    process.stdout.write(`${plan}\n`);
  }

  if (flags.emit) {
    const refusal = emitRefusal({ integrable, endpoint, acknowledge: Boolean(flags.acknowledge) });
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      return 1;
    }
    const block = buildDeviceBlock(endpoint, {
      name: flags.name || null,
      deviceId: flags['device-id'] || null,
      acknowledge: Boolean(flags.acknowledge),
      acknowledgedBy: flags['acknowledged-by'] || null,
      reason: flags.reason || null,
    });
    appendFileSync(flags.emit, `${JSON.stringify(block)}\n`);
    process.stderr.write(`terminal-endpoint: appended the device entry to ${flags.emit}\n`);
  }

  return integrable ? 0 : 1;
}

const isEntrypoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isEntrypoint) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`terminal-endpoint: ${error.message}\n`);
    process.exit(2);
  });
}

export { main };
