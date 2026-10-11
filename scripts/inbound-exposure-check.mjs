#!/usr/bin/env node
/**
 * Inbound exposure check: does anything on this estate accept a connection that
 * arrived from the Internet, and would it answer?
 *
 *   node scripts/inbound-exposure-check.mjs \
 *     --config isapi-bridge/agent-config.json \
 *     --devices isapi-bridge/isapi-devices.json \
 *     --listen-scan --probe 203.0.113.9:8080
 *
 * WHY THIS EXISTS — the router you cannot change.
 * The recommended posture in README.md is that nothing here listens at all: the
 * agent dials the Worker and dials the terminals, so no port needs opening and a
 * port-forwarding rule has nothing to hand traffic to. Many sites cannot reach
 * that posture by removing the rule, because the rule is not theirs to remove —
 * an ISP-managed CPE, a forward left by a previous installer, an "inbound
 * Internet access" setting on a router whose login belongs to the managing
 * agent. When the rule stays, the two things that can still be true are:
 *
 *   1. nothing on the LAN answers it (no listener, or a listener on loopback), and
 *   2. whatever does answer decides who gets in — a source allowlist, a shared
 *      secret and a rate limit, all of which live in
 *      `isapi-bridge/network-access-control.mjs` and need no router access.
 *
 * This script checks both, from the estate side, and exits non-zero when either
 * is false. It is deliberately the same shape as
 * `scripts/cloudflared-remote-access.mjs --check`: exit 0 clean, 1 on findings,
 * 2 on a usage error, so it can gate a review or a CI step.
 *
 * WHAT IT CANNOT PROVE. A probe run from inside the LAN can fail even when a
 * forward is live, because many routers do not loop hairpin NAT back to the
 * inside. `--probe` therefore reports a refusal as "nothing answered from here"
 * and says so; the authoritative probe is the same command run from a phone on
 * mobile data, or from any host outside the estate. Findings from the config
 * files do not have that caveat — they are read, not guessed.
 *
 * No dependencies beyond Node and the agent's own access-control module.
 */
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  bindIsReachableBeyondHost,
  classifyAddress,
  classifyBindAddress,
  deriveInboundSources,
  deviceIsPublicEndpoint,
  isAddressLiteral,
  parseSourceRule,
  publicEndpointRisks,
  readPublicEndpointAcknowledgement,
} from '../isapi-bridge/network-access-control.mjs';

const SCRIPT_NAME = 'scripts/inbound-exposure-check.mjs';
const DEFAULT_CONFIG = 'isapi-bridge/agent-config.json';
const DEFAULT_DEVICES = 'isapi-bridge/isapi-devices.json';
const DEFAULT_PROBE_TIMEOUT_MS = 4000;

class UsageError extends Error {}

// ------------------------------------------------------------------- reading ---

/** Reads and parses one JSON file the agent itself would read. */
export function readJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (reason) {
    throw new UsageError(`could not read ${label} ${filePath}: ${reason.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (reason) {
    throw new UsageError(`${label} ${filePath} is not valid JSON: ${reason.message}`);
  }
}

/**
 * The per-source rate limit as configured.
 *
 * `undefined` means "not configured", so the module's default of 600/minute per
 * source applies; `0` means an operator turned it off, which is the only case
 * worth a finding. Conflating the two would warn about a limit that is in force.
 */
function readRateLimit(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : undefined;
}

/** A source list from config: an array, or one comma/space-separated string. */
function readSourceList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/** The two listeners the agent can open, described the way the agent reads them. */
export function listenerSpecs(config = {}) {
  const lanEvents = config.lanEvents && typeof config.lanEvents === 'object' ? config.lanEvents : {};
  const pushRaw = config.zktecoPush;
  const push = pushRaw && typeof pushRaw === 'object' ? pushRaw : {};
  // Mirrors agent.mjs exactly: `true`, or an object that does not say false.
  const pushEnabled = pushRaw === true || Boolean(pushRaw && typeof pushRaw === 'object' && push.enabled !== false);
  const remoteVerifyEnabled = Boolean(config.remoteVerify && config.remoteVerify.enabled === true);

  return [
    {
      key: 'lanEvents',
      label: 'LAN event listener',
      enabled: lanEvents.enabled === true,
      bindAddress: String(lanEvents.bindAddress || '127.0.0.1'),
      port: Number.isInteger(lanEvents.port) ? lanEvents.port : 8080,
      explicitSources: readSourceList(lanEvents.allowedSources),
      allowUnknownSources: Boolean(lanEvents.allowUnknownSources),
      secretRequired: Boolean(lanEvents.requireTerminalKey),
      secretConfigured: String(lanEvents.terminalKey || '').trim().length > 0,
      maxRequestsPerMinute: readRateLimit(lanEvents.maxRequestsPerMinute),
      // PUSH terminals dial in and have no address in the devices file, so only
      // this listener can derive its allowlist from the estate's own terminals.
      derivesFromDevices: true,
      // With Remote Network Verification on, an accepted event is a door decision.
      carriesDecisions: remoteVerifyEnabled,
      trustsBodyIdentity: Boolean(lanEvents.trustReportedDeviceIp),
      secretAdvice: 'Hikvision\'s own HTTP Listening upload sends no credential, so the allowlist is the control that works here; requireTerminalKey only helps when something in front of the listener adds the header',
    },
    {
      key: 'zktecoPush',
      label: 'ZKTeco PUSH listener',
      enabled: pushEnabled,
      bindAddress: String(push.bindAddress || '127.0.0.1'),
      port: Number.isInteger(push.port) ? push.port : 8089,
      explicitSources: readSourceList(push.allowedSources),
      allowUnknownSources: Boolean(push.allowUnknownSources),
      secretRequired: Boolean(push.requireAgentKey),
      secretConfigured: String(push.agentKey || '').trim().length > 0,
      maxRequestsPerMinute: readRateLimit(push.maxRequestsPerMinute),
      derivesFromDevices: false,
      carriesDecisions: false,
      trustsBodyIdentity: false,
      secretAdvice: 'PUSH firmwares can send a key: set requireAgentKey and agentKey, and put the same key in the terminal\'s Cloud Server / ADMS settings',
    },
  ];
}

// ------------------------------------------------------------------ assessing ---

/**
 * Assesses an agent configuration and its devices file for inbound exposure.
 *
 * Pure and synchronous so a review or a CI step can assert on the findings
 * without touching a network: every error here is read out of the two files the
 * agent itself starts from. Probes and the listening-socket scan are separate.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], notes: string[], listeners: object[], devices: object[] }}
 */
export function assessInboundPosture({ config = {}, devices = [], options = {} } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const listeners = [];
  const deviceReports = [];

  const enabledDevices = devices.filter((device) => device && device.enabled !== false);

  // -- Terminals themselves: an access device on the public Internet is the one
  //    exposure no allowlist on this host can fix, because the terminal answers
  //    for itself.
  for (const device of enabledDevices) {
    const name = String(device.name || device.isapiHost || device.sdkHost || 'a terminal');
    // Two transports reach a terminal: ISAPI over HTTP (the default) and
    // Hikvision's SDK/"server" port, which is what iVMS-4200 speaks. The second
    // one is a binary protocol driven through the vendor library — there is no
    // HTTP to reason about, and there is no card-record API at all.
    const transport = String(device.transport || 'isapi');
    const isSdkTransport = transport === 'hik_sdk' || transport === 'hcnetsdk';
    const host = String(device.isapiHost || device.sdkHost || '').trim();
    const port = Number(device.isapiPort || device.sdkPort || (isSdkTransport ? 8000 : 80));
    const protocol = isSdkTransport
      ? 'hik_sdk'
      : (String(device.protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http');
    const report = { name, host, port, transport: isSdkTransport ? 'hik_sdk' : transport, protocol, classification: null, findings: [] };
    if (!host) {
      report.classification = 'dial-in';
      deviceReports.push(report);
      continue; // a PUSH terminal calls the bridge; it has no address of its own
    }
    if (!isAddressLiteral(host)) {
      report.classification = 'hostname';
      report.findings.push('warn');
      warnings.push(`${name} is configured by hostname (${host}). It cannot be added to a listener's source allowlist automatically, which keeps that allowlist advisory: give the terminal its LAN address in the devices file, or list its subnet in "allowedSources".`);
      deviceReports.push(report);
      continue;
    }
    const classification = classifyAddress(host);
    report.classification = classification;
    // A public endpoint is a hard error unless the devices file records an
    // operator's acknowledgement of it — some sites cannot reach the terminal's
    // LAN at all, and an exposure that is documented, reported and reviewed is
    // safer than one that is silently tolerated. The acknowledgement never
    // removes the risk; it moves it into the report. docs/PUBLIC-ENDPOINT-DEVICE.md.
    const acknowledged = deviceIsPublicEndpoint(device)
      ? readPublicEndpointAcknowledgement(device)
      : { acknowledged: false, by: null, at: null, note: null };
    report.publicEndpoint = classification === 'public' ? { acknowledged: acknowledged.acknowledged, by: acknowledged.by, at: acknowledged.at } : null;
    if (classification === 'public' && acknowledged.acknowledged) {
      report.findings.push('warn');
      warnings.push(
        `${name} is configured at the public address ${host} and that exposure is acknowledged` +
        `${acknowledged.by ? ` by ${acknowledged.by}` : ''}${acknowledged.at ? ` on ${acknowledged.at}` : ''}` +
        `${acknowledged.note ? ` — "${acknowledged.note}"` : ''}. The acknowledgement records the decision; it does not remove the risk: ` +
        `${publicEndpointRisks({ protocol, host, port }).join('; ')}. ` +
        'Re-check this every review, keep the terminal\'s admin password unique, and treat an agent on that LAN as the exit plan (docs/PUBLIC-ENDPOINT-DEVICE.md).',
      );
    } else if (classification === 'public') {
      report.findings.push('error');
      errors.push(`${name} is configured at the public address ${host}. That is a terminal on the Internet, with its own admin interface answering — the exposure README.md forbids, and no setting on this host changes it. Move it to a LAN address and reach it through the Cloudflare Tunnel kit (docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md). If the LAN path genuinely does not exist, run "node scripts/terminal-endpoint.mjs --endpoint ${host}:${port}" and record the decision with a "publicEndpoint" acknowledgement in the devices file (docs/PUBLIC-ENDPOINT-DEVICE.md) — the agent refuses to start without one.`);
    } else if (classification === 'carrier-grade') {
      report.findings.push('warn');
      warnings.push(`${name} is configured at ${host}, which is in the carrier-grade NAT range (100.64.0.0/10). Traffic from it can arrive indistinguishable from anybody else behind the same CGNAT, so a source allowlist covering this address is weaker than it looks.`);
    }
    if (isSdkTransport) {
      // Stated as a note, not a finding: the transport choice is legitimate, and
      // what it cannot do is the part an operator has to know before queuing work.
      notes.push(`${name} is reached over Hikvision's SDK/"server" port (${host}:${port}) — the protocol iVMS-4200 uses — so live events and door control come from the vendor SDK helper, while card and person changes stay operator tasks: HCNetSDK has no card-record API (docs/HIKVISION-SDK-TRANSPORT.md).`);
    }

    if (protocol === 'http' && !['private', 'loopback'].includes(classification)) {
      // Cleartext ISAPI to an address off this LAN is an error, acknowledged or
      // not — an acknowledgement can accept a public address, but it cannot make
      // Digest credentials and card numbers private. Prefer https.
      report.findings.push(classification === 'public' && acknowledged.acknowledged ? 'warn' : 'error');
      const message = `${name} is reached over plain http at ${host} (${classification}). ISAPI Digest credentials and every card number cross that path in the clear; use https`;

      if (classification === 'public' && acknowledged.acknowledged) {
        warnings.push(`${message} (the acknowledgement covers the address, not the cleartext). On this endpoint prefer https with a certificate the agent host trusts: "protocol": "https" and, for a self-signed terminal, install its certificate on the agent host — see docs/PUBLIC-ENDPOINT-DEVICE.md.`);
      } else {
        errors.push(`${message}, or keep the terminal on a private LAN address.`);
      }
    }
    deviceReports.push(report);
  }

  // -- The agent's own listeners.
  for (const spec of listenerSpecs(config)) {
    const report = {
      key: spec.key,
      label: spec.label,
      enabled: spec.enabled,
      bindAddress: spec.bindAddress,
      port: spec.port,
      bind: classifyBindAddress(spec.bindAddress),
      sources: [],
      enforcing: false,
      findings: [],
    };
    listeners.push(report);

    if (!spec.enabled) {
      notes.push(`${spec.label} is off: no port is opened for it.`);
      continue;
    }

    const beyondHost = bindIsReachableBeyondHost(spec.bindAddress);
    const derived = spec.derivesFromDevices
      ? deriveInboundSources({ devices: enabledDevices, explicit: spec.explicitSources })
      : deriveInboundSources({ devices: [], explicit: spec.explicitSources });
    // The same rule the agent applies: enforce only when the list can be trusted
    // to be complete, so a hostname in the devices file does not quietly turn
    // into a bridge that refuses the estate's own gates.
    const enforcing = derived.sources.length > 0
      && !spec.allowUnknownSources
      && (spec.explicitSources.length > 0 || derived.complete);

    report.sources = derived.sources;
    report.enforcing = enforcing;
    report.allowUnknownSources = spec.allowUnknownSources;
    report.missing = derived.missing;

    for (const invalid of derived.invalid) {
      report.findings.push('warn');
      warnings.push(`${spec.label}: the configured inbound source "${invalid.entry}" is not usable — ${invalid.reason}. It is being ignored, which makes the allowlist narrower than it reads.`);
    }

    if (report.bind === 'public') {
      report.findings.push('error');
      errors.push(`${spec.label} is bound to the public address ${spec.bindAddress}:${spec.port}. That is an Internet listener on the estate's own host; bind it to loopback or the LAN address and let the tunnel kit carry human access instead.`);
    }

    if (beyondHost && !enforcing) {
      report.findings.push('error');
      const why = spec.carriesDecisions
        ? ' Remote Network Verification is on for this host, so an accepted upload is a door decision: a forged event naming a real card would open a gate.'
        : '';
      const fix = spec.derivesFromDevices
        ? `Set "${spec.key}": { "allowedSources": ["<device VLAN>/24"] } (e.g. ["192.168.88.0/24"]), or give every terminal an address in the devices file so the allowlist can be derived and enforced.`
        : `PUSH terminals dial in and cannot be derived, so set "${spec.key}": { "allowedSources": ["<device VLAN>/24"] } explicitly (e.g. ["192.168.88.0/24"]).`;
      errors.push(
        `${spec.label} listens on ${spec.bindAddress}:${spec.port}, which is reachable beyond this host, and enforces no source allowlist — anything that can reach the port is accepted, including whatever a router forwards inward.${why} ${fix}`,
      );
    } else if (beyondHost && enforcing && derived.missing.length) {
      report.findings.push('warn');
      warnings.push(`${spec.label} enforces ${derived.sources.length} source rule(s), but ${derived.missing.map((entry) => `${entry.name} (${entry.host})`).join(', ')} could not be allowlisted automatically. It is only accepted because an explicit range covers it — check that it does.`);
    } else if (!beyondHost) {
      notes.push(`${spec.label} is on loopback (${spec.bindAddress}:${spec.port}): a router port-forwarding rule cannot reach it.`);
    } else {
      notes.push(`${spec.label} enforces ${derived.sources.length} source rule(s): ${derived.sources.join(', ')}.`);
    }

    if (spec.allowUnknownSources && beyondHost) {
      report.findings.push('warn');
      warnings.push(`${spec.label} has allowUnknownSources set, so its ${derived.sources.length} rule(s) are advisory only. On a network whose router forwards this port inward, that is the same as no allowlist.`);
    }

    // Checked before the "no secret" warning: requiring one and not setting one
    // is a broken listener, not a weak one, and it fails closed against the
    // estate's own terminals.
    if (spec.secretRequired && !spec.secretConfigured) {
      report.findings.push('error');
      errors.push(`${spec.label} requires a shared secret but none is configured, so the agent refuses every upload — including the estate's own terminals. Set the key, or switch the requirement off.`);
    } else if (beyondHost && !spec.secretRequired) {
      report.findings.push('warn');
      warnings.push(`${spec.label} accepts requests with no shared secret. ${spec.secretAdvice}.`);
    }

    if (spec.maxRequestsPerMinute === 0) {
      report.findings.push('warn');
      warnings.push(`${spec.label} has its per-source rate limit switched off ("maxRequestsPerMinute": 0), so a port that is reachable from outside can be used to flood it. The default is 600 requests/minute per source; remove the setting to get it back.`);
    }

    if (spec.trustsBodyIdentity) {
      report.findings.push(beyondHost ? 'error' : 'warn');
      const message = `${spec.label} has trustReportedDeviceIp on, so an upload is mapped to the terminal its *body* names rather than the socket it arrived on. A caller who can reach this port can therefore speak for any terminal in the estate${spec.carriesDecisions ? ' — and with Remote Network Verification on, open its door' : ''}.`;
      if (beyondHost) errors.push(`${message} Turn it off unless a relay in front of the listener genuinely rewrites source addresses.`);
      else warnings.push(message);
    }
  }

  if (!listeners.some((entry) => entry.enabled)) {
    notes.push('This agent opens no listening port at all: every connection it makes is outbound, so an inbound router rule has nothing to hand traffic to. That is the recommended posture.');
  }

  // -- Outbound hygiene, because it is the other half of "nothing inbound needed".
  const workerUrl = String(config.workerUrl || '');
  if (workerUrl && !workerUrl.startsWith('https://')) {
    warnings.push(`workerUrl is ${workerUrl || '(unset)'}: the agent\'s outbound path carries the agent secret and every event, so it should be https.`);
  }

  return { ok: errors.length === 0, errors, warnings, notes, listeners, devices: deviceReports };
}

/**
 * POSIX permission check on a file that holds secrets.
 *
 * The bridge README asks for 0600 on `agent-config.json` and the devices file,
 * because both carry the agent secret and every terminal's admin password. On a
 * host whose router is managed by somebody else, the file's own permissions are
 * one of the few things still under the estate's control.
 */
export function assessFilePermissions(filePath, { mode = 0o600, holds = 'secrets' } = {}) {
  if (process.platform === 'win32') {
    return { checked: false, reason: 'Windows ACLs are not read here; use icacls to confirm only Administrators and the service account can read the file' };
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (reason) {
    return { checked: false, reason: `could not stat ${filePath}: ${reason.message}` };
  }
  const actual = stats.mode & 0o777;
  return {
    checked: true,
    ok: (actual & ~mode) === 0,
    mode: actual.toString(8).padStart(3, '0'),
    filePath,
    holds,
  };
}

// ------------------------------------------------------------------- probing ---

/**
 * Probes one host:port the way an outsider would: open a socket, and if it opens
 * ask a question.
 *
 * A refusal is reported as a refusal, never as "safe" — from inside the LAN a
 * hairpin NAT gap looks exactly like a closed port, and the difference matters.
 */
export async function probeTarget({ host, port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  const startedAt = Date.now();
  const connected = await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ connected: true }));
    socket.once('timeout', () => finish({ connected: false, reason: 'timeout' }));
    socket.once('error', (error) => finish({ connected: false, reason: String(error?.code ?? error.message) }));
  });

  if (!connected.connected) {
    return { host, port, reachable: false, reason: connected.reason, elapsedMs: Date.now() - startedAt };
  }

  // Something answered the TCP handshake. Ask it one HTTP question so the report
  // can say whether it is a listener of ours or a device's admin interface.
  const answer = await new Promise((resolve) => {
    const request = http.request({ host, port, path: '/', method: 'GET', timeout: timeoutMs, agent: false }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, server: res.headers?.server ?? null, bytes }));
      res.resume();
    });
    request.on('timeout', () => { request.destroy(); resolve({ status: null, reason: 'no HTTP answer' }); });
    request.on('error', (error) => resolve({ status: null, reason: String(error?.code ?? error.message) }));
    request.end();
  });

  return { host, port, reachable: true, ...answer, elapsedMs: Date.now() - startedAt };
}

/** Splits `host:port`, defaulting the port and rejecting anything unparseable. */
export function parseProbeTarget(text, defaultPort = 80) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new UsageError('--probe needs a value like 203.0.113.9:8080');
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
  }
  const parts = raw.split(':');
  if (parts.length === 1) return { host: parts[0], port: defaultPort };
  if (parts.length === 2) {
    const port = Number(parts[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--probe ${raw} has a port that is not 1-65535`);
    return { host: parts[0], port };
  }
  throw new UsageError(`--probe ${raw} is not host:port`);
}

// ------------------------------------------------------- listening socket scan ---

/**
 * Best-effort read of what this host is listening on.
 *
 * Never fails the run: a container or a locked-down host may have no `ss` and no
 * `netstat`, and "could not look" is a note, not a finding.
 */
export function collectListeningSockets() {
  const windows = process.platform === 'win32';
  const attempts = windows
    ? [['netstat', ['-ano', '-p', 'TCP']]]
    : [['ss', ['-ltnH']], ['netstat', ['-ltn']]];

  for (const [command, args] of attempts) {
    let output;
    try {
      output = execFileSync(command, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    const entries = [];
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const fields = trimmed.split(/\s+/);
      // Three layouts, and picking the wrong column silently reports "nothing is
      // listening":
      //   ss -ltnH        LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*      -> column 3
      //   netstat -ltn    tcp    0   0 0.0.0.0:8080 0.0.0.0:*  LISTEN -> column 3
      //   netstat -ano    TCP    0.0.0.0:8080  0.0.0.0:0  LISTENING 1234 -> column 1
      const local = windows ? fields[1] : fields[3];
      if (windows && fields[3] !== 'LISTENING') continue;
      if (!local || !local.includes(':')) continue;
      const port = Number(local.slice(local.lastIndexOf(':') + 1));
      if (!Number.isInteger(port) || port < 0 || port > 65535) continue;
      entries.push({ address: local.slice(0, local.lastIndexOf(':')).replace(/^\[|\]$/g, ''), port });
    }
    return { available: true, command: `${command} ${args.join(' ')}`, entries };
  }
  return { available: false, command: null, entries: [], reason: 'neither ss nor netstat answered' };
}

/**
 * Crosses the listening sockets against the ports this configuration names.
 *
 * The useful finding is not "a port is open" — it is "a port this agent's config
 * says it listens on is open on every interface", which is what a router rule
 * forwards into.
 */
export function assessListeningSockets({ scan, listeners = [], devices = [] }) {
  const errors = [];
  const warnings = [];
  const notes = [];
  if (!scan?.available) {
    notes.push(`the listening-socket scan was skipped: ${scan?.reason ?? 'unavailable'} — check with "ss -ltn" (Linux/macOS) or "netstat -ano" (Windows) instead`);
    return { errors, warnings, notes };
  }

  const configured = listeners.filter((entry) => entry.enabled);
  for (const socket of scan.entries) {
    const beyondHost = socket.address === '0.0.0.0' || socket.address === '::' || socket.address === '*'
      ? true
      : !['127.0.0.1', '::1'].includes(socket.address) && classifyAddress(socket.address) !== 'loopback';
    const listener = configured.find((entry) => entry.port === socket.port);
    if (listener) {
      const finding = `${listener.label} is listening on ${socket.address}:${socket.port}${beyondHost ? ', reachable beyond this host' : ''}`;
      if (beyondHost && !listener.enforcing) {
        errors.push(`${finding}, and it enforces no source allowlist.`);
      } else if (beyondHost) {
        warnings.push(`${finding}. It enforces ${listener.sources.length} source rule(s); confirm the router does not forward this port, or that the allowlist is what refuses the traffic.`);
      } else {
        notes.push(`${finding} (loopback only).`);
      }
      continue;
    }
    // A terminal's ISAPI port answered by *this* host is a forward pointing at the
    // wrong machine, or a device emulator somebody left running: either way it is
    // worth saying, because the estate's terminals are meant to answer it, not us.
    const devicePort = devices.find((device) => Number(device.isapiPort || 80) === socket.port && beyondHost);
    if (devicePort) {
      warnings.push(`something on this host listens on ${socket.address}:${socket.port}, which is the ISAPI port of ${devicePort.name || 'a configured terminal'}. A router rule for that port lands here, not on the terminal.`);
    }
  }
  return { errors, warnings, notes };
}

// ------------------------------------------------------------------ CLI layer ---

/**
 * Parses the CLI flags. Unknown flags and missing values throw UsageError so the
 * caller can print usage and exit 2, keeping usage errors distinct from the
 * findings that exit 1.
 */
export function parseArgs(argv) {
  const options = {
    config: DEFAULT_CONFIG,
    devices: DEFAULT_DEVICES,
    probes: [],
    listenScan: false,
    permissions: true,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    json: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const take = () => {
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--config': options.config = take(); break;
      case '--devices': options.devices = take(); break;
      case '--probe': options.probes.push(parseProbeTarget(take())); break;
      case '--probe-port': {
        const port = Number(take());
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--probe-port must be 1-65535');
        options.probePorts = [...(options.probePorts ?? []), port];
        break;
      }
      case '--listen-scan': options.listenScan = true; break;
      case '--no-permissions': options.permissions = false; break;
      case '--timeout': {
        const timeout = Number(take());
        if (!Number.isFinite(timeout) || timeout < 500) throw new UsageError('--timeout must be at least 500 (milliseconds)');
        options.timeoutMs = Math.trunc(timeout);
        break;
      }
      case '--json': options.json = true; break;
      case '--quiet': options.quiet = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new UsageError(`unknown flag ${flag}`);
    }
  }
  return options;
}

const HELP = `EstateMate inbound exposure check

Answers two questions on a site whose router cannot be changed: does anything
here accept an inbound connection, and would it decide who gets in?

Usage:
  node ${SCRIPT_NAME} [--config <agent-config.json>] [--devices <isapi-devices.json>] [options]

Options:
  --config <path>      Agent config to assess (default: ${DEFAULT_CONFIG})
  --devices <path>     Devices file to assess (default: ${DEFAULT_DEVICES})
  --probe <host:port>  Try to reach a port from here (repeatable). Run it from
                       outside the estate for a verdict you can trust: from
                       inside, a router without NAT loopback answers nothing
                       even when the forward is live
  --probe-port <port>  Probe this port on every --probe host (repeatable)
  --listen-scan        Also read what this host is listening on (ss/netstat)
  --no-permissions     Skip the 0600 check on the two secret-bearing files
  --timeout <ms>       Probe timeout (default: ${DEFAULT_PROBE_TIMEOUT_MS})
  --json               Print findings as JSON
  --quiet              Only print errors and the verdict
  --help               This text

Exit codes: 0 no errors, 1 findings to fix, 2 usage error — the same contract as
scripts/cloudflared-remote-access.mjs --check, so either can gate a review.
`;

/** Combines a host list with a port list into probe targets. */
function expandProbes(options) {
  const targets = [...options.probes];
  const ports = options.probePorts ?? [];
  if (ports.length) {
    for (const probe of options.probes) {
      for (const port of ports) {
        if (port !== probe.port) targets.push({ host: probe.host, port });
      }
    }
  }
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.host}:${target.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (reason) {
    log(`error: ${reason.message}`);
    log(HELP);
    return 2;
  }
  if (options.help) { log(HELP); return 0; }

  let config;
  let deviceList;
  try {
    config = readJsonFile(options.config, 'agent config');
    const devicesFile = readJsonFile(options.devices, 'devices file');
    deviceList = Array.isArray(devicesFile) ? devicesFile : Array.isArray(devicesFile?.devices) ? devicesFile.devices : null;
    if (!deviceList) throw new UsageError(`${options.devices} must be an array of devices or an object with a "devices" array`);
  } catch (reason) {
    if (reason instanceof UsageError) { log(`error: ${reason.message}`); return 2; }
    throw reason;
  }

  const posture = assessInboundPosture({ config, devices: deviceList, options });
  const findings = {
    errors: [...posture.errors],
    warnings: [...posture.warnings],
    notes: [...posture.notes],
  };

  if (options.permissions) {
    for (const entry of [
      { filePath: options.config, holds: 'the agent secret' },
      { filePath: options.devices, holds: "the terminals' ISAPI admin passwords" },
    ]) {
      const filePath = entry.filePath;
      const permission = assessFilePermissions(filePath, { holds: entry.holds });
      if (permission.checked && !permission.ok) {
        findings.warnings.push(`${filePath} is mode ${permission.mode}: it holds ${permission.holds}, so make it 0600 (chmod 600) or the Windows equivalent.`);
      } else if (!permission.checked) {
        findings.notes.push(`permissions of ${filePath} were not checked: ${permission.reason}`);
      }
    }
  }

  let scan = null;
  if (options.listenScan) {
    scan = collectListeningSockets();
    const assessed = assessListeningSockets({ scan, listeners: posture.listeners, devices: deviceList });
    findings.errors.push(...assessed.errors);
    findings.warnings.push(...assessed.warnings);
    findings.notes.push(...assessed.notes);
  }

  const probes = [];
  for (const target of expandProbes(options)) {
    const result = await probeTarget({ ...target, timeoutMs: options.timeoutMs });
    probes.push(result);
    if (result.reachable) {
      findings.errors.push(
        `${target.host}:${target.port} answered from here${result.status ? ` with HTTP ${result.status}${result.server ? ` (Server: ${result.server})` : ''}` : ''}. `
        + 'If that is a public address, an inbound rule is live and something is behind it: confirm it is not a terminal, and that the listener refuses sources outside the estate.',
      );
    } else {
      findings.notes.push(`${target.host}:${target.port} did not answer from here (${result.reason}). From inside the LAN that is not proof the forward is dead — routers without NAT loopback answer nothing. Re-run this probe from outside the estate.`);
    }
  }

  const ok = findings.errors.length === 0;
  const report = {
    ok,
    config: options.config,
    devices: options.devices,
    listeners: posture.listeners,
    terminals: posture.devices,
    probes,
    listeningSockets: scan ? { available: scan.available, command: scan.command, count: scan.entries.length } : null,
    ...findings,
  };

  if (options.json) {
    log(JSON.stringify(report, null, 2));
    return ok ? 0 : 1;
  }

  for (const note of findings.notes) if (!options.quiet) log(`note: ${note}`);
  for (const warning of findings.warnings) log(`warning: ${warning}`);
  for (const error of findings.errors) log(`error: ${error}`);
  log(ok
    ? `ok: nothing here accepts an inbound connection it does not decide on${probes.length ? ` (${probes.length} probe(s) run)` : ''}`
    : `failed: ${findings.errors.length} inbound exposure problem(s) to fix`);
  return ok ? 0 : 1;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().then((code) => { process.exitCode = code; }).catch((reason) => {
    console.error(`error: ${reason?.message ?? reason}`);
    process.exitCode = 2;
  });
}
