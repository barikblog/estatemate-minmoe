#!/usr/bin/env node
/**
 * EstateMate Hikvision ISAPI Bridge Agent
 * Polls Cloudflare Worker for pending card/visitor operations and applies them via ISAPI.
 *
 * This agent runs on the same LAN as Hikvision devices (Windows, Linux, macOS).
 * It uses ISAPI (HTTP Digest) to manage cards/persons, not ISUP SDK.
 *
 * Security:
 * - Keep ISAPI devices and this agent on same VLAN, do NOT expose ISAPI to Internet.
 * - Config file contains secrets, set ACL to Administrators / 0600.
 * - Do not log secrets or card UIDs in plaintext beyond debug.
 *
 * Requirements: Node.js 22+, network access to devices via HTTP/HTTPS.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { applyPushOperation, startZktecoPushServer } from './zkteco-push-server.mjs';
import { pinPolicy } from './zkteco-push.mjs';
import { CredentialCache, CooldownTracker, cooldownKey, decideCredential, parseTerminalEvent } from './remote-verify.mjs';
import { startLanEventListener } from './lan-event-listener.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const envKey = name.toUpperCase().replace(/-/g, '_');
  if (process.env[envKey]) return process.env[envKey];
  if (process.env[`ESTATEMATE_${envKey}`]) return process.env[`ESTATEMATE_${envKey}`];
  return fallback;
}

const configPath = resolve(argValue('config', process.env.AGENT_CONFIG || './agent-config.json'));
const devicesPath = resolve(argValue('devices', process.env.DEVICES_FILE || './isapi-devices.json'));

if (!existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  console.error('Create it from agent-config.example.json and set agentId, agentSecret, workerUrl');
  process.exit(1);
}
if (!existsSync(devicesPath)) {
  console.error(`Devices file not found: ${devicesPath}`);
  console.error('Create it from isapi-devices.example.json with your ISAPI hosts');
  process.exit(1);
}

const config = loadJson(configPath);
const devicesConfig = loadJson(devicesPath);

const agentId = String(config.agentId || '').trim();
const agentSecret = String(config.agentSecret || '').trim();
const workerUrl = String(config.workerUrl || 'https://estatemate.estatemate.workers.dev').replace(/\/$/, '');
const syncInterval = Math.max(5, Number(config.syncIntervalSeconds || 30));
const heartbeatInterval = Math.max(15, Number(config.heartbeatIntervalSeconds || 60));
const isapiTimeout = Math.max(2000, Number(config.isapiTimeoutMs || 15000));
const logLevel = String(config.logLevel || 'info');

// Real-time event streaming (ISAPI alertStream). Enabled by default; set
// "eventStream": false in agent-config.json (global) or per device to disable.
const eventStreamEnabled = config.eventStream !== false;
const eventFlushCount = Math.max(1, Math.min(50, Number(config.eventFlushCount || 25)));
const eventFlushSeconds = Math.max(1, Number(config.eventFlushSeconds || 5));
const eventBufferLimit = Math.max(eventFlushCount * 4, Number(config.eventBufferLimit || 500));
const alertStreamPath = String(config.alertStreamPath || '/ISAPI/Event/notification/alertStream?format=json');

// ZKTeco PUSH (ADMS) transport.
//
// Off unless an agent-config.json says otherwise, so every deployed Hikvision
// bridge behaves exactly as it did before this code existed. The terminal is
// what dials us (§7 of the vendor doc), so unlike the ISAPI path this one needs
// a listening port, and that is the whole reason the default bind is loopback:
// an estate that wants a terminal to reach a bridge on another host sets
// `pushBindAddress` deliberately and reads the warning it prints.
const pushEnabled = config.zktecoPush === true || (config.zktecoPush && config.zktecoPush.enabled !== false);
// 0 is meaningful here: it lets the OS pick a free port, which is what the
// integration checks want and what an installer gets by setting "port": 0.
const pushPortConfigured = config.zktecoPush && config.zktecoPush.port !== undefined ? Number(config.zktecoPush.port) : 8089;
const pushPort = Number.isInteger(pushPortConfigured) && pushPortConfigured >= 0 && pushPortConfigured <= 65535 ? pushPortConfigured : 8089;
const pushBindAddress = String((config.zktecoPush && config.zktecoPush.bindAddress) || '127.0.0.1');
const pushRequireAgentKey = Boolean(config.zktecoPush && config.zktecoPush.requireAgentKey);
const pushAgentKey = String((config.zktecoPush && config.zktecoPush.agentKey) || '').trim();
// How long an operation waits for the terminal's Return= before it is reported as
// still queued. A terminal polls on RequestDelay, so this is deliberately longer
// than one poll cycle.
const pushAckTimeoutMs = Math.max(5000, Number((config.zktecoPush && config.zktecoPush.ackTimeoutSeconds) || 180) * 1000);

// Remote Network Verification.
//
// Two switches, and both must be on before any door is opened by this code:
// this host-level one (an estate PC opts in) and the per-terminal one in the
// portal (an Administrator decides which gates are readers). The host switch
// exists because a snapshot of the whole estate's credentials is a real thing to
// hold on a machine, and an operator should be able to say no to it without
// hunting through the portal.
const remoteVerifyEnabled = Boolean(config.remoteVerify && config.remoteVerify.enabled === true);
const snapshotInterval = Math.max(15, Number((config.remoteVerify && config.remoteVerify.snapshotIntervalSeconds) || 60));
// 20,000 credentials page through in a handful of requests at this size; the cap
// is what keeps one request from being bigger than the Worker's body limit.
const snapshotPageSize = Math.min(5000, Math.max(100, Number((config.remoteVerify && config.remoteVerify.pageSize) || 2000)));
const cardNumberFormats = Array.isArray(config.remoteVerify?.cardNumberFormats) && config.remoteVerify.cardNumberFormats.length
  ? config.remoteVerify.cardNumberFormats
  : ['exact', 'padded10'];

// Terminal clock sync.
//
// A terminal enforces everything with its own clock: a visitor pass is a
// finite window the terminal checks against its hardware, and gate events
// carry its timestamp. A terminal hours off the estate rejects a live pass
// early, honours a dead one late, and none of it is visible from the database.
// When this is on, the bridge reads each terminal's system time, measures the
// offset against the bridge host's clock and sets the clock back when the
// offset exceeds the threshold; the per-terminal state rides on the heartbeat.
// Off by default, so an estate that does not opt in gets no extra ISAPI
// traffic and exactly the bridge it had before. The bridge host's clock is the
// reference — see the clock section below for the two assumptions that makes.
const timeSyncConfigured = config.timeSync && typeof config.timeSync === 'object' ? config.timeSync : {};
const timeSyncEnabled = timeSyncConfigured.enabled === true;
const timeSyncMaxDriftMs = Math.max(5000, Number(timeSyncConfigured.maxDriftMs || 30000));
const timeSyncCheckIntervalMs = Math.max(60 * 1000, Number(timeSyncConfigured.checkIntervalMinutes || 15) * 60 * 1000);

// LAN event listener: the terminal pushes its events here instead of the bridge
// pulling them from an alertStream. Off by default and bound to loopback, so a
// default install opens no port at all. See lan-event-listener.mjs for why.
const lanEventsEnabled = Boolean(config.lanEvents && config.lanEvents.enabled === true);
const lanEventsPort = Number.isInteger(config.lanEvents?.port) ? config.lanEvents.port : 8080;
const lanEventsBindAddress = String(config.lanEvents?.bindAddress || '127.0.0.1');
const lanEventsRequireKey = Boolean(config.lanEvents?.requireTerminalKey);
const lanEventsTerminalKey = String(config.lanEvents?.terminalKey || '').trim();

if (!/^[0-9a-f-]{36}$/i.test(agentId)) {
  console.error('Invalid agentId, must be UUID');
  process.exit(1);
}
if (agentSecret.length < 16) {
  console.error('agentSecret too short');
  process.exit(1);
}

// The EstateMate device id is the Worker's primary key for a terminal: queued
// operations are addressed with it and events are uploaded against it. Asking
// an installer to copy a UUID per gate out of the portal is where setups go
// wrong, so a terminal that only has its LAN address is allowed here and the id
// is looked up from the agent's own linked devices (see resolveDeviceIds).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_PATTERN.test(String(value || '').trim());

const devices = new Map();
const unresolvedDevices = [];
for (const d of devicesConfig.devices || []) {
  if (d.enabled === false) continue;
  // A ZKTeco terminal on the PUSH transport is not polled over ISAPI at all: the
  // terminal calls us, so it has no isapiHost and must not be skipped for that.
  const isPushDevice = d.transport === 'zkteco_push' || (pushEnabled && !d.isapiHost && d.pushSerial);
  if (!d.isapiHost && !isPushDevice) continue;
  const device = {
    estateMateDeviceId: String(d.estateMateDeviceId || '').trim(),
    name: String(d.name || d.isapiHost),
    isapiHost: String(d.isapiHost).trim(),
    isapiPort: Number(d.isapiPort || 80),
    isapiUsername: String(d.isapiUsername || 'admin'),
    isapiPassword: String(d.isapiPassword || ''),
    protocol: d.protocol === 'https' ? 'https' : 'http',
    eventStream: d.eventStream !== false,
    transport: isPushDevice ? 'zkteco_push' : 'isapi',
    pushSerial: String(d.pushSerial || '').trim() || null,
  };
  if (isUuid(device.estateMateDeviceId)) devices.set(device.estateMateDeviceId, device);
  else unresolvedDevices.push(device);
}

if (!devices.size && !unresolvedDevices.length) {
  console.error('No enabled devices in devices file');
  process.exit(1);
}

/**
 * Fills in the EstateMate device id for terminals configured by LAN address
 * alone, by matching them against the devices the portal has linked to this
 * agent (same host, and the same port when both sides state one). Exits with an
 * explanation when a terminal cannot be matched, because a device without an id
 * would silently drop the events it reads.
 */
async function resolveDeviceIds() {
  if (!unresolvedDevices.length) return;
  let linked = [];
  try {
    const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/devices`, { method: 'GET' });
    if (!res.ok) {
      console.error(`Cannot resolve EstateMate device ids: the Worker answered HTTP ${res.status} for the linked-device list.`);
      process.exit(1);
    }
    linked = Array.isArray(json.items) ? json.items : [];
  } catch (err) {
    console.error(`Cannot resolve EstateMate device ids: ${err.message}`);
    process.exit(1);
  }

  const matched = new Set();
  for (const device of unresolvedDevices) {
    if (device.transport === 'zkteco_push') continue; // bound by its own serial, at registration
    const host = device.isapiHost.toLowerCase();
    const candidates = linked.filter((item) => String(item.isapi_host || '').trim().toLowerCase() === host);
    const exact = candidates.filter((item) => !item.isapi_port || Number(item.isapi_port) === device.isapiPort);
    const chosen = (exact.length ? exact : candidates)[0];
    const chosenId = chosen && String(chosen.device_id || '').trim();
    if (chosenId && isUuid(chosenId)) {
      device.estateMateDeviceId = chosenId;
      devices.set(chosenId, device);
      matched.add(chosenId);
      log('info', `Resolved EstateMate device id for "${device.name}" from the portal: ${chosenId}${chosen.isapi_port && Number(chosen.isapi_port) !== device.isapiPort ? ' (portal port differs)' : ''}`);
    }
  }

  const unresolved = unresolvedDevices.filter((device) => !devices.has(device.estateMateDeviceId));
  if (unresolved.length) {
    const known = linked.length
      ? linked.map((item) => `${item.device_name || item.device_id} (${item.isapi_host}${item.isapi_port ? `:${item.isapi_port}` : ''})`).join(', ')
      : 'none';
    for (const device of unresolved.filter((entry) => entry.transport !== 'zkteco_push')) {
      console.error(
        `Terminal "${device.name}" (${device.protocol}://${device.isapiHost}:${device.isapiPort}) has no EstateMate device id and the portal does not list it` +
          ` — link it to this agent (Device agent → Connect terminal), or paste the terminal's EstateMate device ID from Connected terminals.`,
      );
    }
    console.error(`Devices linked to this agent in the portal: ${known}`);
    process.exit(1);
  }

  // A push terminal that has not phoned home yet cannot be bound by host, because
  // it has no host: its serial arrives in its first registration. Refusing to
  // start would be wrong (the terminal is the one that decides when to call), so
  // this says what is pending and binds it on arrival.
  const pendingPush = unresolvedDevices.filter((device) => device.transport === 'zkteco_push' && !device.pushSerial && !devices.has(device.estateMateDeviceId));
  for (const device of pendingPush) {
    log('warn', `Terminal "${device.name}" is on the ZKTeco PUSH transport and will be bound to the first serial that registers with this bridge.`);
  }

  const linkedIds = linked.map((item) => String(item.device_id || '').trim()).filter(Boolean);
  const orphans = linkedIds.filter((id) => !devices.has(id));
  if (orphans.length) {
    log('warn', `${orphans.length} device(s) linked to this agent in the portal are not in the devices file — operations for them stay queued until a terminal is configured for them.`);
  }
}

// ---------------------------------------------------------------------------
// ZKTeco PUSH (ADMS) transport state
//
// Serial -> device, built from the config and from what terminals register with.
// The bridge is the only place that can answer "which EstateMate device is this
// serial?", because it is the only place the serial is ever seen.
// ---------------------------------------------------------------------------
const pushSerialBindings = new Map();
const pushState = { registered: 0, eventsForwarded: 0, listener: null };

function pushDevicesFor() {
  // Both lists, deduplicated: a terminal that arrives with an EstateMate id lives
  // in `devices`, one the portal has yet to be matched against lives in
  // `unresolvedDevices` until resolveDeviceIds() succeeds, and after that it is in
  // both. A PUSH terminal with no id at all is a normal way to start an install —
  // the id can be looked up from the serial once the terminal first calls in.
  const every = new Set([...devices.values(), ...unresolvedDevices]);
  return [...every].filter((device) => device.transport === 'zkteco_push');
}

/** Resolves a reporting serial to its local device, binding an unbound one. */
function resolvePushDevice(serial, reportedOptions = {}) {
  const configured = pushDevicesFor().find((device) => device.pushSerial === serial);
  if (configured) return configured;
  const bound = pushSerialBindings.get(serial);
  if (bound) return bound;
  // Bind automatically only when exactly one PUSH terminal is unclaimed.
  // Choosing between two gates is how a resident ends up with a card on the
  // wrong door, so with two or more configured this returns null and the log
  // tells the installer to write pushSerial by hand.
  const free = pushDevicesFor().filter((device) => !device.pushSerial);
  if (free.length === 1) {
    const device = free[0];
    device.pushSerial = serial;
    pushSerialBindings.set(serial, device);
    log('info', `Bound ZKTeco terminal serial ${serial}${reportedOptions.DeviceName ? ` (${reportedOptions.DeviceName})` : ''} to "${device.name}" (the only PUSH device on this bridge; set pushSerial to pin it down)`);
    return device;
  }
  if (free.length > 1) {
    log('warn', `ZKTeco terminal ${serial} registered but ${free.length} PUSH devices are unbound — set "pushSerial" on each device entry to say which terminal is which gate.`);
  }
  return null;
}

function startPushListener() {
  if (!pushEnabled || pushState.listener) return pushState.listener;
  pushState.listener = startZktecoPushServer({
    port: pushPort,
    bindAddress: pushBindAddress,
    log,
    requireAgentKey: pushRequireAgentKey,
    agentKey: pushAgentKey,
    ackTimeoutMs: pushAckTimeoutMs,
    resolveDevice: (serial, reportedOptions) => resolvePushDevice(serial, reportedOptions),
    onEvent: (deviceId, document) => {
      pushState.eventsForwarded += 1;
      queueEvent(deviceId, document);
    },
    onDeviceInfo: (serial, parsed) => {
      pushState.registered += 1;
      const policy = pinPolicy(parsed);
      log('info', `ZKTeco terminal ${serial} stores ${policy.allowStringPin ? 'string User IDs' : 'numeric User IDs only'} (StringPinFunOn=${policy.stringPinReported ? parsed.StringPinFunOn : 'not reported'})`);
      // A terminal that has just told us who it is can now be handed work.
      const device = resolvePushDevice(serial, parsed);
      if (device) {
        device.pushSerial = serial;
        pushSerialBindings.set(serial, device);
        if (device.estateMateDeviceId) devices.set(device.estateMateDeviceId, device);
      }
    },
  });
  return pushState.listener;
}

function log(level, ...args) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((order[level] ?? 1) < (order[logLevel] ?? 1)) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

async function apiFetch(path, init = {}) {
  const url = `${workerUrl}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-EstateMate-Agent-Key': agentSecret,
    'User-Agent': 'EstateMate-ISAPI-Bridge/1.1',
    ...(init.headers || {}),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { res, json, text };
  } finally { clearTimeout(timeout); }
}

/**
 * Probes the terminals this bridge serves and remembers what they support.
 * 'card' and 'door' are unconditional: those endpoints have been on every
 * terminal EstateMate has been tested against. 'person' and 'fingerprint' are
 * decided by the terminal's own answers, so the portal never queues an API the
 * firmware does not have — that would leave an operation failed that an operator
 * never sees, which is worse than an explicit instruction.
 *
 * The probe is deliberately never awaited by the heartbeat: an access terminal
 * holding a long-lived connection open (an alertStream, an event stream, a slow
 * firmware) must not be able to delay the heartbeat that tells the portal this
 * estate is alive. The remembered answer is sent, and a refresh is started in the
 * background when it goes stale.
 */
const CAPABILITY_TTL_MS = 10 * 60 * 1000;
const BASELINE_CAPABILITIES = ['card', 'door'];
const capabilityCache = { at: 0, value: null };
let capabilityRefresh = null;

/** What to put in a heartbeat right now, refreshing the answer in the background. */
function capabilitiesForHeartbeat() {
  if (!capabilityCache.value || Date.now() - capabilityCache.at >= CAPABILITY_TTL_MS) {
    if (!capabilityRefresh) {
      capabilityRefresh = probeCapabilities()
        .catch((err) => log('debug', `Capability probe failed: ${err.message}`))
        .finally(() => { capabilityRefresh = null; });
    }
  }
  return capabilityCache.value ?? BASELINE_CAPABILITIES;
}

async function probeCapabilities() {
  if (capabilityCache.value && Date.now() - capabilityCache.at < CAPABILITY_TTL_MS) return capabilityCache.value;
  const found = new Set(['card', 'door']);
  // The PUSH transport writes a person a person with `DATA UPDATE USERINFO`, which is the
  // same unit of work the Worker gates behind 'person'. It is advertised only for
  // a terminal that has actually registered: the capability is the terminal's,
  // not the bridge's. Fingerprint work is deliberately absent — this transport
  // refuses it, and the portal keeps the manual instruction (see the profile doc).
  if (pushEnabled && pushState.registered > 0) found.add('person');
  for (const device of devices.values()) {
    // A terminal on the PUSH transport has no ISAPI to ask; it advertises its own
    // parameters when it registers, and probing it over HTTP would burn the probe
    // timeout on every refresh for a device that answers no ISAPI at all.
    if (device.transport === 'zkteco_push') continue;
    try {
      const person = await isapiRequest(device, 'GET', '/ISAPI/AccessControl/UserInfo/capabilities?format=json', null, false);
      if (isapiOk(person) || (!isapiUnsupported(person) && person.status >= 200 && person.status < 300)) found.add('person');
      const fingerprint = await isapiRequest(device, 'GET', '/ISAPI/AccessControl/FingerPrintCfg/capabilities?format=json', null, false);
      if (isapiOk(fingerprint) || (!isapiUnsupported(fingerprint) && fingerprint.status >= 200 && fingerprint.status < 300)) found.add('fingerprint');
      if (!found.has('fingerprint')) {
        const capture = await isapiRequest(device, 'GET', '/ISAPI/AccessControl/CaptureFingerPrint/capabilities', null, true);
        if (isapiOk(capture) || (!isapiUnsupported(capture) && capture.status >= 200 && capture.status < 300)) found.add('fingerprint');
      }
    } catch (err) {
      log('debug', `Capability probe failed for ${device.name}: ${err.message}`);
    }
  }
  capabilityCache.at = Date.now();
  capabilityCache.value = [...found];
  return capabilityCache.value;
}

async function heartbeat() {
  try {
    const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        version: process.env.ESTATEMATE_BRIDGE_VERSION || '2.0.0',
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'isapi-bridge',
        platform: process.platform,
        stats: {
          eventsForwarded: eventStats.forwarded,
          eventsDropped: eventStats.dropped,
          eventsPending: pendingEvents.length,
          eventStream: eventStreamEnabled,
          ...(pushEnabled ? {
            pushTransport: {
              registered: pushState.registered,
              bound: pushDevicesFor().filter((device) => device.pushSerial).length,
              eventsForwarded: pushState.eventsForwarded,
              commandsSent: pushState.listener?.handler.stats.commandsSent ?? 0,
              commandsConfirmed: pushState.listener?.handler.stats.commandsConfirmed ?? 0,
              commandsUnconfirmed: pushState.listener?.handler.stats.commandsTimedOut ?? 0,
              unmappedUploads: pushState.listener?.handler.stats.unmapped ?? 0,
            },
          } : {}),
        },
        // What this bridge can actually do, probed against the terminals it
        // serves rather than claimed. EstateMate only hands a bridge person and
        // fingerprint work when the matching capability is here, so an old
        // bridge keeps working exactly as before instead of failing operations.
        capabilities: capabilitiesForHeartbeat(),
        // Per-terminal liveness: 'down' retires the terminal in the portal at
        // once rather than waiting for the hourly offline sweep.
        devices: heartbeatDeviceStates(),
        // Remote verification is the one feature where the portal has to be able
        // to see the agent's own state - how fresh the snapshot is, how many
        // decisions it made, whether the door actually answered - because none of
        // that is observable from the database alone.
        ...(remoteVerifyEnabled ? { remoteVerify: remoteVerifyHeartbeat() } : {}),
      }),
    });
    if (!res.ok) log('warn', 'Heartbeat failed', res.status, json);
    else log('debug', 'Heartbeat OK', json.serverTime);
  } catch (err) {
    log('warn', 'Heartbeat error', err.message);
  }
}

// ISAPI helpers - Digest auth implementation (simplified, uses fetch with digest if available, else basic)
// Node's fetch does not handle digest automatically, so we implement minimal digest flow.

function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

function parseDigest(header) {
  const params = {};
  const regex = /(\w+)=["']?([^"',\s]+)["']?/g;
  let m;
  while ((m = regex.exec(header)) !== null) {
    params[m[1]] = m[2];
  }
  return params;
}

/** Builds an ISAPI HTTP Digest authorization header from a WWW-Authenticate challenge. */
function buildDigestAuthHeader(device, method, path, wwwAuth) {
  const digest = parseDigest(wwwAuth);
  const realm = digest.realm || '';
  const nonce = digest.nonce || '';
  const qop = digest.qop || 'auth';
  const opaque = digest.opaque || '';
  const algorithm = digest.algorithm || 'MD5';
  const nc = '00000001';
  const cnonce = Math.random().toString(36).slice(2, 10);

  const ha1 = md5(`${device.isapiUsername}:${realm}:${device.isapiPassword}`);
  const ha2 = md5(`${method}:${path}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  let authHeader = `Digest username="${device.isapiUsername}", realm="${realm}", nonce="${nonce}", uri="${path}", algorithm=${algorithm}, response="${response}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) authHeader += `, opaque="${opaque}"`;
  return authHeader;
}

function basicAuthHeader(device) {
  return `Basic ${Buffer.from(`${device.isapiUsername}:${device.isapiPassword}`).toString('base64')}`;
}

async function isapiRequest(device, method, path, body = null, isXml = true) {
  const base = `${device.protocol}://${device.isapiHost}:${device.isapiPort}`;
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), isapiTimeout);

  // First request to get digest challenge
  try {
    let res = await fetch(url, {
      method,
      headers: { 'Content-Type': isXml ? 'application/xml; charset=utf-8' : 'application/json' },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
    if (res.status !== 401) {
      const text = await res.text();
      clearTimeout(timeout);
      return { status: res.status, body: text, headers: res.headers };
    }
    const wwwAuth = res.headers.get('www-authenticate') || '';
    if (!wwwAuth.toLowerCase().includes('digest')) {
      // Fallback to basic
      res = await fetch(url, {
        method,
        headers: {
          Authorization: basicAuthHeader(device),
          'Content-Type': isXml ? 'application/xml; charset=utf-8' : 'application/json',
        },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      clearTimeout(timeout);
      return { status: res.status, body: text, headers: res.headers };
    }
    const authHeader = buildDigestAuthHeader(device, method, path, wwwAuth);
    res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': isXml ? 'application/xml; charset=utf-8' : 'application/json',
      },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
    if (res.status === 401) {
      // A nonce can go stale and be reissued, which RFC 2617 answers with a
      // fresh challenge. Answer it once. This is the only retry: a 401 without
      // a new Digest challenge is an authentication failure, and repeating it
      // risks locking the account (the guide: remaining attempts 0 ⇒ the next
      // attempt locks the user).
      const reChallenge = res.headers.get('www-authenticate') || '';
      if (reChallenge.toLowerCase().includes('digest')) {
        await res.text().catch(() => '');
        res = await fetch(url, {
          method,
          headers: {
            Authorization: buildDigestAuthHeader(device, method, path, reChallenge),
            'Content-Type': isXml ? 'application/xml; charset=utf-8' : 'application/json',
          },
          body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
          signal: controller.signal,
        });
      }
    }
    const text = await res.text();
    clearTimeout(timeout);
    return { status: res.status, body: text, headers: res.headers };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Real-time event streaming (ISAPI alertStream)
//
// The agent keeps one persistent GET /ISAPI/Event/notification/alertStream
// connection per device and forwards every event document to the Worker in
// small batches. This gives real-time Gate activity even for terminals whose
// firmware has no HTTP Listening push: the device streams events over its
// documented ISAPI interface on the LAN, and the agent relays them outbound.
// ---------------------------------------------------------------------------

let shutdownRequested = false;
const eventStats = { forwarded: 0, dropped: 0 };
const pendingEvents = [];
let flushTimer = null;
let flushing = false;

// The guide's alertStream heartbeat is ~10 s with a 30 s timeout; three windows
// of silence is worth a warning, checked on a coarse timer.
const STREAM_IDLE_WARN_MS = 90 * 1000;
const STREAM_IDLE_CHECK_MS = 15 * 1000;

/**
 * Per-terminal alertStream state, keyed by EstateMate device id.
 *
 * The agent staying online does not mean a terminal is reachable: the agent
 * heartbeats on its own timer, and a terminal that stopped answering ISAPI
 * leaves the agent looping in backoff while the portal still shows it online.
 * Each stream loop records up/down here and the heartbeat carries it to the
 * Worker, which retires the terminal immediately instead of waiting for the
 * hourly sweep to notice that no events arrived.
 */
const streamStates = new Map();

function setStreamState(deviceId, stream, lastError = null) {
  if (!deviceId) return;
  const previous = streamStates.get(deviceId);
  streamStates.set(deviceId, {
    stream,
    lastError: lastError ? String(lastError).slice(0, 300) : null,
    since: previous && previous.stream === stream ? previous.since : new Date().toISOString(),
  });
}

function heartbeatDeviceStates() {
  // Union, not intersection: a terminal whose event stream is switched off
  // (or that is not streamed at all) still gets its clock reported, and the
  // Worker treats stream presence and clock state as independent fields.
  const ids = new Set([...streamStates.keys(), ...clockStates.keys()]);
  return [...ids].map((deviceId) => {
    const stream = streamStates.get(deviceId);
    const clock = clockStates.get(deviceId);
    return {
      deviceId,
      ...(stream ? { stream: stream.stream, lastError: stream.lastError } : {}),
      ...(clock ? {
        clock: {
          terminalTime: clock.terminalTime,
          driftMs: clock.driftMs,
          lastCheckedAt: clock.lastCheckedAt,
          lastSyncAt: clock.lastSyncAt,
          syncs: clock.syncs,
          lastError: clock.lastError,
        },
      } : {}),
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens the alertStream request, answering one Digest/Basic challenge. Returns the raw Response. */
async function openAlertStream(device) {
  const url = `${device.protocol}://${device.isapiHost}:${device.isapiPort}${alertStreamPath}`;
  let res = await fetch(url, { headers: { Accept: 'multipart/mixed, application/json' } });
  if (res.status === 401) {
    const wwwAuth = res.headers.get('www-authenticate') || '';
    const authHeader = wwwAuth.toLowerCase().includes('digest')
      ? buildDigestAuthHeader(device, 'GET', alertStreamPath, wwwAuth)
      : basicAuthHeader(device);
    try { await res.arrayBuffer(); } catch { /* drain best effort */ }
    res = await fetch(url, { headers: { Accept: 'multipart/mixed, application/json', Authorization: authHeader } });
  }
  return res;
}

/**
 * Incremental multipart/mixed parser. Each complete part between boundary
 * markers becomes one event document string (JSON text or XML) exactly the
 * shape the EstateMate normalizer accepts.
 */
function createMultipartEventParser(boundary, onEvent) {
  const delimiter = `--${boundary}`;
  let buffer = '';
  const extractPart = (raw) => {
    const trimmed = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const separator = trimmed.search(/\r?\n\r?\n/);
    if (separator < 0) return;
    const body = trimmed.slice(separator + (trimmed.includes('\r\n\r\n') ? 4 : 2)).trim();
    if (!body.startsWith('{') && !body.startsWith('<')) return;
    onEvent(body);
  };
  return function feed(chunk) {
    buffer += chunk;
    for (;;) {
      const start = buffer.indexOf(delimiter);
      if (start < 0) {
        if (buffer.length > 1024 * 1024) buffer = buffer.slice(-1024);
        return;
      }
      const next = buffer.indexOf(delimiter, start + delimiter.length);
      if (next < 0) return; // wait for the next boundary marker
      extractPart(buffer.slice(start + delimiter.length, next));
      buffer = buffer.slice(next);
    }
  };
}

/**
 * Fallback parser for firmwares that stream bare JSON objects without a
 * multipart envelope. Walks brace depth while respecting JSON strings.
 * A scan cursor plus buffer trimming guarantee chunks are never re-scanned.
 */
function createJsonEventScanner(onEvent) {
  let buffer = '';
  let scanned = 0; // index into buffer of the first unscanned char
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return function feed(chunk) {
    buffer += chunk;
    let i = scanned;
    while (i < buffer.length) {
      const ch = buffer[i];
      let restart = false;
      if (depth > 0) {
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            onEvent(buffer.slice(start, i + 1));
            buffer = buffer.slice(i + 1);
            scanned = 0;
            start = -1;
            i = 0;
            restart = true;
          }
        }
      } else if (ch === '{') {
        depth = 1;
        start = i;
      }
      if (!restart) i++;
    }
    scanned = i; // === buffer.length
    if (depth === 0) {
      // Fully scanned and not inside a document: drop everything scanned.
      buffer = '';
      scanned = 0;
      start = -1;
    } else if (start > 0) {
      // Mid-document: keep only the in-progress document bytes.
      buffer = buffer.slice(start);
      scanned -= start;
      start = 0;
    }
    if (buffer.length > 1024 * 1024) {
      buffer = '';
      scanned = 0;
      depth = 0;
      start = -1;
      inString = false;
      escaped = false;
    }
  };
}

function queueEvent(deviceId, document) {
  if (!document || document.length > 512 * 1024) {
    log('warn', 'Skipping missing or oversized event document for device', deviceId);
    return;
  }
  const item = { deviceId, document };
  // Remote verification runs here because this is the one place every event
  // passes through, whichever way it arrived: an alertStream the bridge holds
  // open, or a document a terminal pushed to the LAN listener.
  beginRemoteVerification(deviceId, document, item);
  pendingEvents.push(item);
  if (pendingEvents.length > eventBufferLimit) {
    const drop = pendingEvents.length - eventBufferLimit;
    pendingEvents.splice(0, drop);
    eventStats.dropped += drop;
    log('warn', `Event buffer overflow; dropped ${drop} oldest document(s)`);
  }
  if (pendingEvents.length >= eventFlushCount) {
    flushEvents();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushEvents(); }, eventFlushSeconds * 1000);
  }
}

async function flushEvents() {
  if (flushing || !pendingEvents.length) return;
  flushing = true;
  try {
    while (pendingEvents.length) {
      const items = pendingEvents.splice(0, 50);
      // Wait for any door command these events triggered, so the history records
      // what actually happened at the lock instead of a permanent "pending". The
      // command was already sent the moment the decision was made - this only
      // holds the upload, never the door.
      await Promise.all(items.map((item) => pendingDoorCommands.get(item)).filter(Boolean));
      try {
        const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/events`, {
          method: 'POST',
          body: JSON.stringify({ items }),
        });
        if (!res.ok) {
          log('warn', 'Event flush failed', res.status, json);
          pendingEvents.unshift(...items);
          break;
        }
        eventStats.forwarded += Number(json.accepted || 0);
        log('debug', `Forwarded ${json.accepted} event(s), ${json.rejected} rejected, pending ${pendingEvents.length}`);
      } catch (err) {
        log('warn', 'Event flush error', err.message);
        pendingEvents.unshift(...items);
        break;
      }
    }
  } finally {
    flushing = false;
  }
  if (pendingEvents.length > eventBufferLimit) {
    const drop = pendingEvents.length - eventBufferLimit;
    pendingEvents.splice(0, drop);
    eventStats.dropped += drop;
    log('warn', `Event buffer overflow after failed flush; dropped ${drop} oldest document(s)`);
  }
}

async function deviceEventLoop(device) {
  let backoffMs = 5000;
  for (;;) {
    if (shutdownRequested) break;
    try {
      const res = await openAlertStream(device);
      if (res.status !== 200) {
        const snippet = await res.text().catch(() => '');
        log('warn', `Alert stream unavailable for ${device.name}: HTTP ${res.status} ${snippet.slice(0, 200)}`);
        setStreamState(device.estateMateDeviceId, 'down', `HTTP ${res.status} ${snippet.slice(0, 200)}`.trim());
      } else {
        const contentType = res.headers.get('content-type') || '';
        const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1] || null;
        backoffMs = 5000;
        if (!res.body) {
          log('warn', `Alert stream for ${device.name} returned no body`);
          setStreamState(device.estateMateDeviceId, 'down', 'terminal returned no stream body');
        } else {
          log('info', `Event stream connected for ${device.name}${boundary ? ' (multipart)' : ' (bare JSON)'}`);
          setStreamState(device.estateMateDeviceId, 'up');
          const decoder = new TextDecoder();
          // The stream carries the terminal's keep-alive heartbeat as well as
          // events. Keeping the link alive is the heartbeat's only job, so it is
          // counted as activity but never forwarded as a gate event.
          let lastActivityAt = Date.now();
          const onDocument = (document) => {
            lastActivityAt = Date.now();
            if (isStreamHeartbeat(document)) {
              log('debug', `Heartbeat on ${device.name}`);
              return;
            }
            queueEvent(device.estateMateDeviceId, document);
          };
          const feed = boundary
            ? createMultipartEventParser(boundary, onDocument)
            : createJsonEventScanner(onDocument);
          // The guide's heartbeat cadence is ~10 s with a 30 s timeout; a TCP
          // connection can stay open while the terminal stops streaming, so warn
          // (log only — the stream state must not flip on a guess) once a stream
          // goes quiet for three of those windows.
          const idleTimer = setInterval(() => {
            const quietMs = Date.now() - lastActivityAt;
            if (quietMs < STREAM_IDLE_WARN_MS) return;
            lastActivityAt = Date.now();
            log('warn', `No heartbeat or event from ${device.name} for ${Math.round(quietMs / 1000)}s; the terminal may have stopped streaming even though the connection is open`);
          }, STREAM_IDLE_CHECK_MS);
          try {
            for await (const chunk of res.body) {
              if (shutdownRequested) break;
              feed(decoder.decode(chunk, { stream: true }));
            }
          } finally {
            clearInterval(idleTimer);
          }
          log('warn', `Event stream closed for ${device.name}`);
          setStreamState(device.estateMateDeviceId, 'down', 'terminal closed the event stream');
        }
      }
    } catch (err) {
      log('warn', `Event stream error for ${device.name}`, err.message);
      setStreamState(device.estateMateDeviceId, 'down', err.message);
    }
    if (shutdownRequested) break;
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60000);
  }
  log('info', `Event stream stopped for ${device.name}`);
}

// The person a terminal files a card under is the holder's employee number,
// issued by EstateMate and sent with every card operation. The agent never
// invents one: it used to fall back to the resident's user id (36 characters —
// terminals refuse person IDs over 32 bytes) or to a literal "1", which attached
// a re-enabled card to whoever terminal person 1 was and still reported success.
// Only values a terminal accepts pass: letters and digits, at most 32.
//
// Deletion is the one exception. Estates provisioned before the charset rule
// may hold terminal person records under the old shape (letters, digits and
// `._-/`, e.g. a `visitor-<credential>` visitor account), and a terminal that
// stored them still needs them addressed to free the slot. Delete paths accept
// that legacy shape; every write path refuses it, so nothing new is ever filed
// under an identity a strict terminal cannot store.
const TERMINAL_EMPLOYEE_NO = /^[A-Za-z0-9]{1,32}$/;
const LEGACY_TERMINAL_EMPLOYEE_NO = /^[A-Za-z0-9._/-]{1,32}$/;
const VISITOR_EMPLOYEE_NO = /^visitor-?\d/;

function terminalEmployeeNo(payload, options = {}) {
  const value = String(payload.employeeNo ?? '').trim();
  if (TERMINAL_EMPLOYEE_NO.test(value)) return value;
  if (options.allowLegacy && LEGACY_TERMINAL_EMPLOYEE_NO.test(value)) return value;
  return null;
}

/**
 * A short, readable reason for an ISAPI rejection. Hikvision answers with a
 * ResponseStatus (JSON or XML); its statusString / subStatusCode / errorMsg name
 * the cause, e.g. "Invalid Content / badParameters / employeeNo". A raw 200-byte
 * slice of the XML used to cut off right before that field name.
 *
 * A 401 is the terminal refusing the credentials, and the guide defines the
 * authentication-failed document that carries the remaining attempts
 * (retryTimes), the lock state and the lock time — a lockout the operator needs
 * to see before the account is barred. A 401 is only repeated when the terminal
 * reissues the challenge (a stale nonce); a bare 401 never is, because "if the
 * remaining attempts is 0, the user will be locked at the next attempt".
 */
function describeIsapiFailure(result) {
  const body = String(result.body || '');
  const field = (name) => {
    const json = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(body);
    if (json) return json[1];
    const xml = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
    return xml ? xml[1] : '';
  };
  if (result.status === 401) {
    const notes = [];
    if (field('lockStatus')) notes.push(`lockStatus ${field('lockStatus')}`);
    if (field('retryTimes')) notes.push(`${field('retryTimes')} attempt(s) left`);
    if (field('resLockTime')) notes.push(`locked for ${field('resLockTime')}s`);
    if (field('subStatusCode')) notes.push(field('subStatusCode'));
    const suffix = notes.length ? ` (${notes.join(', ')})` : '';
    return `ISAPI 401: authentication failed${suffix} — check the ISAPI username and password`;
  }
  const reason = [field('statusString'), field('subStatusCode'), field('errorMsg')].filter(Boolean).join(' / ');
  return `ISAPI ${result.status}: ${reason || body.slice(0, 200)}`;
}

/**
 * Whether an alertStream document is the terminal's keep-alive heartbeat rather
 * than a gate event. The guide defines the heartbeat as eventType "videoloss"
 * with eventState "inactive" (a subscription heartbeat is "heartBeat"/"active").
 * Forwarding one files a bogus "videoloss" entry against the terminal in
 * EstateMate. A real video-loss alarm is "videoloss"/"active" and is kept.
 */
function isStreamHeartbeat(document) {
  const text = String(document || '');
  const pick = (name) => {
    const json = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(text);
    if (json) return json[1];
    const xml = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text);
    return xml ? xml[1] : '';
  };
  const eventType = pick('eventType').trim().toLowerCase();
  if (eventType === 'heartbeat') return true;
  if (eventType !== 'videoloss') return false;
  return pick('eventState').trim().toLowerCase() === 'inactive';
}

/**
 * Whether a terminal accepted a request. A 2xx is normally enough, but some
 * firmware answers 200 with a ResponseStatus whose statusCode is not 1 (OK).
 */
function isapiOk(result) {
  if (result.status < 200 || result.status >= 300) return false;
  const body = String(result.body || '');
  const code = /"statusCode"\s*:\s*(\d+)/.exec(body) || /<statusCode>(\d+)<\/statusCode>/.exec(body);
  return !code || Number(code[1]) === 1;
}

/**
 * The terminal does not implement this URL or format at all (as opposed to
 * rejecting the content we sent). Only then is it worth retrying in another
 * format: retrying a content error in XML just buries the real reason.
 */
function isapiUnsupported(result) {
  if (result.status === 404 || result.status === 405 || result.status === 501) return true;
  return /notSupport|invalidURL|invalidOperation/i.test(String(result.body || ''));
}

/** The failure reasons worth showing: real rejections, else the unsupported ones. */
function describeAttempts(attempts) {
  const rejections = attempts.filter((attempt) => !isapiUnsupported(attempt));
  return (rejections.length ? rejections : attempts).map(describeIsapiFailure).join('; then ');
}

const ISAPI_XML_NS = 'xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0"';

// ---------------------------------------------------------------------------
// Terminal clock sync
//
// The terminal decides every time-sensitive thing with its own clock. A
// visitor's pass is a finite `UserInfo` window: the terminal compares the
// swipe moment against `beginTime`/`endTime` on its own hardware. Gate events
// carry the terminal's timestamp, and remote verification decides against the
// bridge's clock. A terminal that drifts hours from the estate rejects a live
// pass early, honours a dead one late, and files its history at the wrong
// moment — none of it visible from the database, because nothing was ever
// asking the terminal what time it thought it was.
//
// Two assumptions, stated because they are operational, not technical:
//
// * The **bridge host is the reference**. It sits on the estate LAN and is the
//   clock every other decision on that LAN already trusts (event timestamps
//   are checked against it, the remote-verify cache ages against it). If the
//   office PC's time is wrong, set the PC's time — this feature makes the
//   terminals agree with the estate, it does not make the estate right.
// * The terminal's **timezone matches the bridge host's**. The sync aligns
//   wall clocks. A terminal configured to a different zone shows up as a
//   constant offset in the portal and belongs re-zoned at the terminal, not
//   "corrected" into a wrong wall clock by the bridge.
//
// Off by default (see the config block at the top): no key means no clock
// traffic at all, so every existing estate behaves exactly as before.
// ---------------------------------------------------------------------------

/** Latest per-terminal clock state, keyed by EstateMate device id. */
const clockStates = new Map();

/**
 * Parse a system-time answer into epoch milliseconds, or null.
 *
 * The terminal reports a wall-clock date and time (in its own zone). It is
 * read in the bridge host's zone: that is what makes "the gate shows the same
 * wall clock as the office PC" the invariant, and it is the reading under
 * which drift means what the portal says it means (see the section above).
 */
function parseTerminalClockTime(body, isXml) {
  let date;
  let time;
  if (isXml) {
    date = /<date>([^<]*)<\/date>/.exec(String(body || ''))?.[1];
    time = /<time>(\d{2}:\d{2}:\d{2})<\/time>/.exec(String(body || ''))?.[1];
  } else {
    let parsed;
    try { parsed = JSON.parse(String(body || '')); } catch { return null; }
    date = parsed?.time?.date;
    time = parsed?.time?.time;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(`${String(date || '').trim()} ${String(time || '').trim()}`);
  if (!match) return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Reads the terminal's system time. JSON first; XML only when the JSON URL is not supported. */
async function readTerminalClock(device) {
  const attempts = [];
  let result = await isapiRequest(device, 'GET', '/ISAPI/System/time/Get?format=json', null, false);
  attempts.push(result);
  const jsonTime = parseTerminalClockTime(result.body, false);
  if (isapiOk(result) && jsonTime !== null) return { timeMs: jsonTime };
  if (!isapiUnsupported(result)) return { error: describeIsapiFailure(result) };
  result = await isapiRequest(device, 'GET', '/ISAPI/System/time/Get', null, true);
  attempts.push(result);
  const xmlTime = parseTerminalClockTime(result.body, true);
  if (isapiOk(result) && xmlTime !== null) return { timeMs: xmlTime };
  return { error: describeAttempts(attempts) };
}

/**
 * Writes the bridge host's wall clock to the terminal. JSON first; XML only
 * when the firmware does not support the JSON URL. The body is the wall clock
 * with `timeType: local`, matching how the terminal reports its own time.
 */
async function setTerminalClock(device, timeMs = Date.now()) {
  const d = new Date(timeMs);
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const jsonBody = JSON.stringify({ time: { date, time, timeType: 'local' } });
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>\n<time ${ISAPI_XML_NS}><date>${date}</date><time>${time}</time><timeType>local</timeType></time>`;
  const attempts = [];
  let result = await isapiRequest(device, 'PUT', '/ISAPI/System/time/Set?format=json', jsonBody, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };
  if (!isapiUnsupported(result)) return { ok: false, result, attempts };
  result = await isapiRequest(device, 'PUT', '/ISAPI/System/time/Set', xmlBody, true);
  attempts.push(result);
  return { ok: isapiOk(result), result, attempts };
}

/**
 * One terminal's clock, end to end: read, measure the offset against the
 * bridge host, and — when the offset exceeds the threshold — set it back to
 * the bridge's time and re-read to confirm. A failed read keeps the last good
 * reading plus the error: a terminal that just went down must not erase the
 * last known clock from the portal, and the error is what the operator acts
 * on.
 */
async function checkTerminalClock(device) {
  const previous = clockStates.get(device.estateMateDeviceId);
  const state = {
    terminalTime: previous?.terminalTime ?? null,
    driftMs: previous?.driftMs ?? 0,
    lastCheckedAt: new Date().toISOString(),
    lastSyncAt: previous?.lastSyncAt ?? null,
    syncs: previous?.syncs ?? 0,
    lastError: null,
  };
  const finish = () => {
    clockStates.set(device.estateMateDeviceId, state);
    return state;
  };
  const read = await readTerminalClock(device).catch((err) => ({ error: err.message }));
  if (read.error || read.timeMs === undefined) {
    state.lastError = String(read.error ?? 'unreadable terminal clock').slice(0, 300);
    return finish();
  }
  const driftMs = Math.round(read.timeMs - Date.now());
  state.terminalTime = new Date(read.timeMs).toISOString();
  state.driftMs = driftMs;
  if (Math.abs(driftMs) <= timeSyncMaxDriftMs) return finish();

  const write = await setTerminalClock(device).catch((err) => ({ ok: false, attempts: [], error: err.message }));
  if (!write.ok) {
    state.lastError = (write.error ? String(write.error) : describeAttempts(write.attempts || [])).slice(0, 300);
    log('warn', `Terminal clock for ${device.name} is off by ${Math.round(driftMs / 1000)}s and could not be set: ${state.lastError}`);
    return finish();
  }
  // Confirm against the terminal, not against our own write: the Set answer
  // is not proof the clock moved.
  const confirm = await readTerminalClock(device).catch((err) => ({ error: err.message }));
  if (!confirm.error && confirm.timeMs !== undefined) {
    state.terminalTime = new Date(confirm.timeMs).toISOString();
    state.driftMs = Math.round(confirm.timeMs - Date.now());
  }
  state.lastSyncAt = new Date().toISOString();
  state.syncs += 1;
  log('info', `Terminal clock for ${device.name} was off by ${Math.round(driftMs / 1000)}s; set to the bridge's time`);
  return finish();
}

/** Checks every ISAPI terminal this agent serves. No-op while the feature is off. */
async function checkAllTerminalClocks() {
  if (!timeSyncEnabled) return;
  for (const device of devices.values()) {
    if (shutdownRequested) return;
    if (device.transport !== 'isapi') continue;
    await checkTerminalClock(device);
  }
}

/**
 * Adds a card to the terminal, or updates it when the terminal already has that
 * card number. Terminals answer a duplicate Record with an error, so a re-enable
 * or re-issue of an existing card must fall through to Modify.
 * JSON is the format these terminals speak; XML is only tried when the JSON URL
 * is not supported.
 */
async function writeTerminalCard(device, employeeNo, cardNo) {
  const body = JSON.stringify({ CardInfo: { employeeNo: String(employeeNo), cardNo: String(cardNo), cardType: 'normalCard' } });
  const attempts = [];
  let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CardInfo/Record?format=json', body, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };
  if (!isapiUnsupported(result)) {
    const modify = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/CardInfo/Modify?format=json', body, false);
    if (isapiOk(modify)) return { ok: true, result: modify, attempts: [...attempts, modify] };
    // "No such card" from Modify means the card was never the problem: Record's
    // own rejection is the reason worth reporting.
    if (alreadyGone(modify)) return { ok: false, result, attempts };
    attempts.push(modify);
    return { ok: false, result: modify, attempts };
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CardInfo ${ISAPI_XML_NS}>
  <employeeNo>${employeeNo}</employeeNo>
  <cardNo>${cardNo}</cardNo>
  <cardType>normalCard</cardType>
</CardInfo>`;
  result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CardInfo/Record', xml, true);
  attempts.push(result);
  return { ok: isapiOk(result), result, attempts };
}

/**
 * Removes a card. The delete condition must be wrapped in CardInfoDelCond with a
 * lower-case cardNo; a bare {CardNoList:[{CardNo}]} is what produced
 * "Invalid Format / badJsonFormat". A card that is already gone counts as removed,
 * but a terminal that simply does not support the call does not.
 */
async function deleteTerminalCard(device, cardNo) {
  const body = JSON.stringify({ CardInfoDelCond: { CardNoList: [{ cardNo: String(cardNo) }] } });
  const attempts = [];
  let result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/CardInfo/Delete?format=json', body, false);
  attempts.push(result);
  if (!isapiOk(result) && isapiUnsupported(result) && !alreadyGone(result)) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CardInfoDelCond ${ISAPI_XML_NS}>
  <CardNoList>
    <cardNo>${cardNo}</cardNo>
  </CardNoList>
</CardInfoDelCond>`;
    result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/CardInfo/Delete', xml, true);
    attempts.push(result);
  }
  if (isapiOk(result) || alreadyGone(result)) return { ok: true, result, attempts };
  return { ok: false, result, attempts };
}

function alreadyGone(result) {
  return /not ?exist|not ?found|cardNoNotExist|employeeNoNotExist/i.test(String(result.body || '')) && !/notSupport/i.test(String(result.body || ''));
}

function xmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Build only the temporary terminal account shown in the device's person UI:
 * employee ID, name, Company department, finite validity, non-administrator
 * normal-user role, and PIN. Visitor provisioning intentionally sends no card,
 * fingerprint, face, door-right, or right-plan record.
 */
function visitorPersonInfo(payload, employeeNo) {
  const asUtc = (value, label) => {
    const instant = new Date(String(value || ''));
    if (!Number.isFinite(instant.getTime())) throw new Error(`visitor ${label} is not a valid date`);
    return instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };
  const beginTime = asUtc(payload.validFrom, 'validFrom');
  const endTime = asUtc(payload.validUntil, 'validUntil');
  if (Date.parse(endTime) <= Date.parse(beginTime)) throw new Error('visitor validUntil must be after validFrom');
  const pin = String(payload.pin || '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw new Error('visitor PIN must contain 4 to 8 digits');
  return {
    employeeNo: String(employeeNo),
    name: String(payload.visitorName || 'Visitor').trim().slice(0, 32) || 'Visitor',
    belongGroup: 'Company',
    userType: 'normal',
    Valid: { enable: true, beginTime, endTime, timeType: 'UTC' },
    localUIRight: false,
    password: pin,
  };
}

/**
 * Add or update the finite visitor UserInfo account. Record is the documented
 * add call; duplicate IDs continue through Modify, and SetUp covers firmware
 * exposing only the combined add/edit operation. XML is used only when the JSON
 * URL is unsupported, never to hide a content rejection.
 */
async function writeTerminalVisitorPerson(device, payload, employeeNo) {
  const info = visitorPersonInfo(payload, employeeNo);
  const body = JSON.stringify({ UserInfo: info });
  const attempts = [];
  let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', body, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };

  if (!isapiUnsupported(result)) {
    const modify = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', body, false);
    attempts.push(modify);
    if (isapiOk(modify)) return { ok: true, result: modify, attempts };
  }

  result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfo/SetUp?format=json', body, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };
  if (!isapiUnsupported(result)) return { ok: false, result, attempts };
  if (attempts.some((attempt) => !isapiUnsupported(attempt))) return { ok: false, result, attempts };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<UserInfo ${ISAPI_XML_NS}>
  <employeeNo>${info.employeeNo}</employeeNo>
  <name>${xmlText(info.name)}</name>
  <belongGroup>Company</belongGroup>
  <userType>normal</userType>
  <Valid><enable>true</enable><beginTime>${info.Valid.beginTime}</beginTime><endTime>${info.Valid.endTime}</endTime><timeType>UTC</timeType></Valid>
  <localUIRight>false</localUIRight>
  <password>${info.password}</password>
</UserInfo>`;
  result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/UserInfo/Record', xml, true);
  attempts.push(result);
  return { ok: isapiOk(result), result, attempts };
}

// ---------------------------------------------------------------------------
// People and fingerprints
//
// A terminal stores a card *against a person*: the ISAPI employee number. Field
// reports (and Hikvision's own field integrators) are consistent that a person
// added without doorRight and RightPlan exists but is authorised for nothing —
// the card is recorded, the door does not open. So the person is written first,
// with door rights, and the card follows.
//
// Fingerprints are the other half. The ISAPI surface on an access terminal can
// both *read* a template (CaptureFingerPrint: the reader beams, the finger goes
// on the glass, the template comes back Base64) and *write* one
// (FingerPrint/SetUp with `fingerData`). That is what makes "scan once, work at
// every gate" possible without putting a template anywhere but the terminals.
// Both are probed against the device: nothing here assumes a firmware supports
// them, and a terminal that does not gets the operator instruction instead of a
// silent failure.
// ---------------------------------------------------------------------------

/** The number of the terminal's own fingerprint module. 1 is the built-in reader. */
const FINGERPRINT_MODULE = 1;
/** How often to re-arm the reader while a capture is pending. */
const CAPTURE_RETRY_MS = Number(process.env.ESTATEMATE_CAPTURE_RETRY_MS || 5000);
/** A capture operation is given at most this long before it reports failure. */
const CAPTURE_MAX_MS = Number(process.env.ESTATEMATE_CAPTURE_MAX_MS || 100000);

/** The JSON person body. Every load-bearing node the guide requires is here. */
function personBody(payload) {
  const doors = Array.isArray(payload.doorNumbers) && payload.doorNumbers.length
    ? payload.doorNumbers.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= 8)
    : [1];
  return {
    employeeNo: String(payload.employeeNo),
    name: String(payload.name || payload.employeeNo).slice(0, 63),
    userType: payload.userType === 'visitor' || payload.userType === 'blackList' ? payload.userType : 'normal',
    // enable:false means a permanent validity window, which is what the estate
    // wants: EstateMate's own card/account lifecycle decides when access stops,
    // and a terminal-side end date would silently override it.
    Valid: { enable: false, beginTime: '2020-01-01T00:00:00', endTime: '2037-12-31T23:59:59', timeType: 'local' },
    doorRight: doors.join(','),
    RightPlan: doors.map((doorNo) => ({ doorNo, planTemplateNo: '1' })),
    localUIRight: false,
    gender: 'unknown',
  };
}

/**
 * Adds or updates a person. Record first (the terminal's add), Modify second with
 * `addUser: true` (its edit — and its add when Record refused because the person
 * was already there), SetUp third for a firmware that only implements the
 * combined call. A terminal that took the write is verified by the caller's next
 * operation (the card, or the fingerprint template), so a false "success" here
 * would surface on the very next command rather than silently.
 */
async function writeTerminalPerson(device, payload) {
  const body = JSON.stringify({ UserInfo: personBody(payload) });
  const attempts = [];
  let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', body, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };
  if (!isapiUnsupported(result)) {
    const modify = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', body, false);
    attempts.push(modify);
    if (isapiOk(modify)) return { ok: true, result: modify, attempts };
    // "Person exists" from Record, or "no such person" from Modify, both mean the
    // other verb is the right one; try the combined call before giving up.
    const setUp = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfo/SetUp?format=json', body, false);
    attempts.push(setUp);
    if (isapiOk(setUp)) return { ok: true, result: setUp, attempts };
    return { ok: false, result: setUp, attempts };
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<UserInfo ${ISAPI_XML_NS}>
  <employeeNo>${payload.employeeNo}</employeeNo>
  <name>${String(payload.name || payload.employeeNo)}</name>
  <userType>normal</userType>
  <Valid>
    <enable>false</enable>
    <beginTime>2020-01-01T00:00:00</beginTime>
    <endTime>2037-12-31T23:59:59</endTime>
    <timeType>local</timeType>
  </Valid>
  <doorRight>${personBody(payload).doorRight}</doorRight>
  <RightPlan>
    ${personBody(payload).RightPlan.map((plan) => `<RightPlanEntry><doorNo>${plan.doorNo}</doorNo><planTemplateNo>1</planTemplateNo></RightPlanEntry>`).join('\n    ')}
  </RightPlan>
</UserInfo>`;
  result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/UserInfo/Record', xml, true);
  attempts.push(result);
  return { ok: isapiOk(result), result, attempts };
}

/**
 * Removes a person from the terminal.
 *
 * The full removal is `UserInfoDetail/Delete`: it takes the person, their cards,
 * their fingerprints and their permissions together. The narrower
 * `UserInfo/Delete` removes only the person record, which leaves a card on the
 * terminal that nobody can use and that a later re-add would inherit, so it is
 * only used when the full removal is not supported.
 */
async function deleteTerminalPerson(device, payload) {
  const employeeNo = String(payload.employeeNo);
  const attempts = [];
  if (payload.fullRemoval !== false) {
    const detailBodies = [
      JSON.stringify({ UserInfoDetail: { mode: 'byEmployeeNo', EmployeeNoList: [{ employeeNo }] } }),
      JSON.stringify({ UserInfoDetail: { EmployeeNoList: [{ employeeNo }] } }),
    ];
    for (const body of detailBodies) {
      const result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfoDetail/Delete?format=json', body, false);
      attempts.push(result);
      if (isapiOk(result)) return { ok: true, result, attempts, mode: 'UserInfoDetail/Delete' };
      if (isapiUnsupported(result)) break;
      if (alreadyGone(result)) return { ok: true, result, attempts, mode: 'UserInfoDetail/Delete' };
    }
  }
  const condBodies = [
    JSON.stringify({ UserInfoDelCond: { EmployeeNoList: [{ employeeNo }] } }),
    JSON.stringify({ UserInfoDelCond: { employeeNo } }),
  ];
  for (const body of condBodies) {
    const result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfo/Delete?format=json', body, false);
    attempts.push(result);
    if (isapiOk(result) || alreadyGone(result)) return { ok: true, result, attempts, mode: 'UserInfo/Delete' };
    if (!isapiUnsupported(result)) break;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<UserInfoDelCond ${ISAPI_XML_NS}>
  <EmployeeNoList>
    <employeeNo>${employeeNo}</employeeNo>
  </EmployeeNoList>
</UserInfoDelCond>`;
  const result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/UserInfo/Delete', xml, true);
  attempts.push(result);
  return { ok: isapiOk(result) || alreadyGone(result), result, attempts, mode: 'UserInfo/Delete (XML)' };
}

/**
 * Writes a fingerprint template to the terminal. `fingerData` is Base64 exactly
 * as another terminal produced it; it is never logged.
 */
async function writeTerminalFingerprint(device, payload, fingerData) {
  if (!fingerData) return { ok: false, error: 'no template was supplied for this fingerprint' };
  const body = JSON.stringify({
    FingerPrintCfg: {
      employeeNo: String(payload.employeeNo),
      enableCardReader: [FINGERPRINT_MODULE],
      fingerPrintID: Number(payload.fingerNo),
      fingerType: 'normalFP',
      fingerData,
      checkEmployeeNo: true,
    },
  });
  const attempts = [];
  let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/FingerPrint/SetUp?format=json', body, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };
  if (!isapiUnsupported(result)) {
    const put = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/FingerPrint/SetUp?format=json', body, false);
    attempts.push(put);
    return { ok: isapiOk(put), result: put, attempts };
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FingerPrintCfg ${ISAPI_XML_NS}>
  <employeeNo>${payload.employeeNo}</employeeNo>
  <enableCardReader>
    <cardReaderNo>${FINGERPRINT_MODULE}</cardReaderNo>
  </enableCardReader>
  <fingerPrintID>${payload.fingerNo}</fingerPrintID>
  <fingerType>normalFP</fingerType>
  <fingerData>${fingerData}</fingerData>
</FingerPrintCfg>`;
  result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/FingerPrint/SetUp', xml, true);
  attempts.push(result);
  return { ok: isapiOk(result), result, attempts };
}

/** Deletes one finger slot for a person. The terminal answers success either way. */
async function deleteTerminalFingerprint(device, payload) {
  const body = JSON.stringify({
    FingerPrintCfg: {
      employeeNo: String(payload.employeeNo),
      enableCardReader: [Number(payload.module || FINGERPRINT_MODULE)],
      fingerPrintID: Number(payload.fingerNo),
      fingerType: 'normalFP',
      deleteFingerPrint: true,
    },
  });
  const attempts = [];
  let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/FingerPrint/SetUp?format=json', body, false);
  attempts.push(result);
  if (isapiOk(result)) return { ok: true, result, attempts };
  if (isapiUnsupported(result)) {
    const put = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/FingerPrint/SetUp?format=json', body, false);
    attempts.push(put);
    if (isapiOk(put)) return { ok: true, result: put, attempts };
  }
  return { ok: false, result: attempts[attempts.length - 1], attempts };
}

/** Whether this terminal documents the fingerprint collection URL at all. */
async function supportsFingerprintCapture(device) {
  const result = await isapiRequest(device, 'GET', '/ISAPI/AccessControl/CaptureFingerPrint/capabilities', null, true);
  return !isapiUnsupported(result) && result.status !== 401;
}

/**
 * Reads a fingerprint template from the terminal's own reader.
 *
 * The JSON flavour returns the template in one call
 * (`CaptureFingerPrintCond` in, `CaptureFingerPrint` out with Base64
 * `fingerData`); the XML flavour is the documented form on the terminal wiki.
 * Both are tried, JSON first, and a "nobody touched the reader" answer is
 * retried until the operation's deadline — the person is standing there, and an
 * access terminal arms its reader per request.
 */
async function captureTerminalFingerprint(device, payload, deadlineMs) {
  const fingerNo = Number(payload.fingerNo);
  if (!Number.isInteger(fingerNo) || fingerNo < 1 || fingerNo > 10) {
    return { ok: false, error: 'fingerNo must be 1-10' };
  }
  if (!(await supportsFingerprintCapture(device))) {
    return { ok: false, error: 'this terminal does not document fingerprint collection (CaptureFingerPrint); enrol the finger on its own menu and record the slot in EstateMate' };
  }

  const jsonBody = JSON.stringify({ CaptureFingerPrintCond: { fingerNo } });
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<CaptureFingerPrintCond ${ISAPI_XML_NS}>
  <fingerNo>${fingerNo}</fingerNo>
</CaptureFingerPrintCond>`;

  const attempts = [];
  let lastError = 'the reader did not answer';
  let heartbeatAt = Date.now();
  while (Date.now() < deadlineMs) {
    // JSON first: on the access terminals that document fingerprint collection
    // this returns the template directly.
    let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CaptureFingerPrint?format=json', jsonBody, false);
    attempts.push(result);
    let template = extractFingerprintData(result.body);
    if (template) return { ok: true, template, quality: extractFingerprintQuality(result.body), attempts };
    let unsupported = isapiUnsupported(result);
    if (!isapiOk(result) && !unsupported) lastError = describeIsapiFailure(result);

    if (unsupported) {
      const xmlResult = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CaptureFingerPrint', xmlBody, true);
      attempts.push(xmlResult);
      template = extractFingerprintData(xmlResult.body);
      if (template) return { ok: true, template, quality: extractFingerprintQuality(xmlResult.body), attempts };
      if (!isapiOk(xmlResult) && !isapiUnsupported(xmlResult)) lastError = describeIsapiFailure(xmlResult);
      if (isapiUnsupported(xmlResult)) {
        return { ok: false, error: `this terminal does not accept fingerprint collection (${describeIsapiFailure(xmlResult)}); enrol the finger on its menu and record the slot in EstateMate`, attempts };
      }
    }

    // Keep the portal's view of this bridge fresh while a person is pressing a
    // finger on the glass, then arm the reader again.
    if (Date.now() - heartbeatAt > 30000) {
      heartbeatAt = Date.now();
      await heartbeat();
    }
    await sleep(CAPTURE_RETRY_MS);
  }
  return { ok: false, error: `${lastError} (nobody placed a finger on the reader within the time allowed)`, attempts };
}

/** Base64 template from either flavour of the capture response. */
function extractFingerprintData(body) {
  const text = String(body || '');
  const json = /"fingerData"\s*:\s*"([^"]+)"/.exec(text);
  if (json?.[1]) return json[1];
  const xml = /<fingerData>([^<]+)<\/fingerData>/.exec(text);
  return xml?.[1] ?? null;
}

function extractFingerprintQuality(body) {
  const text = String(body || '');
  const json = /"fingerPrintQuality"\s*:\s*(\d+)/.exec(text);
  if (json?.[1]) return Number(json[1]);
  const xml = /<fingerPrintQuality>(\d+)<\/fingerPrintQuality>/.exec(text);
  return xml?.[1] ? Number(xml[1]) : null;
}

/**
 * Sends one Hikvision RemoteControl door command: JSON first, XML only when the
 * firmware does not implement the JSON URL.
 *
 * Best-effort by design. No device profile in docs/device-profiles/ records a
 * verified RemoteControl/door response, so both callers - an operator pressing
 * "open" in Access control remote, and the remote-verification path below -
 * receive the terminal's own answer and are expected to surface a refusal rather
 * than assume the door moved.
 *
 * Note the payload: `{"RemoteControlDoor":{"cmd":"open"}}` over
 * `?format=json`, and for the XML form the namespace is
 * `http://www.isapi.org/ver20/XMLSchema` (ISAPI_XML_NS). The bare
 * `xmlns="http://isapi.org"` form that appears in some examples is not what the
 * terminals in this project accept.
 */
async function sendDoorCommand(device, doorCmd, doorNo) {
  const attempts = [];
  let result = await isapiRequest(device, 'PUT', `/ISAPI/AccessControl/RemoteControl/door/${doorNo}?format=json`, JSON.stringify({ RemoteControlDoor: { cmd: doorCmd } }), false);
  attempts.push(result);
  if (!isapiOk(result)) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<RemoteControlDoor ${ISAPI_XML_NS}><cmd>${doorCmd}</cmd></RemoteControlDoor>`;
    result = await isapiRequest(device, 'PUT', `/ISAPI/AccessControl/RemoteControl/door/${doorNo}`, xml, true);
    attempts.push(result);
  }
  return { ok: isapiOk(result), attempts, result };
}

async function applyCardOperation(device, operation) {
  const payload = operation.payload || {};
  const cardUid = payload.cardUid || payload.cardNo || payload.card_number;
  const employeeNo = terminalEmployeeNo(payload);
  const op = operation.operation;

  // A ZKTeco terminal on the PUSH transport is not an ISAPI device: the same
  // operation vocabulary is delivered as a queued command the terminal picks up
  // on its next call, and it counts as applied only when the terminal answers
  // Return=0. Everything below is the Hikvision path and must stay untouched.
  if (device.transport === 'zkteco_push') {
    const serial = device.pushSerial;
    // Guard first: a null listener here would throw past pollAndApply's own
    // catch and take the rest of the batch with it. This is the state an
    // installer reaches by editing one file and not the other, so the answer has
    // to name the config key rather than be an exception in a log.
    if (!pushState.listener) {
      return { success: false, error: pushEnabled
        ? 'the ZKTeco PUSH listener is not up on this bridge yet; it starts with the agent, so retry once the service has finished starting'
        : 'this terminal is on the ZKTeco PUSH transport but the bridge has it switched off: set "zktecoPush": {"enabled": true} in agent-config.json and restart the agent' };
    }
    if (!serial) {
      return { success: false, error: 'this terminal has not registered with the bridge yet; it decides when to call in, so the work stays queued until it does' };
    }
    log('info', `Queueing ${op} for ZKTeco terminal ${device.name} (serial ${serial}) opId=${operation.id}`);
    return applyPushOperation({
      handler: pushState.listener.handler,
      serial,
      operation,
      employeeNo: payload.employeeId || payload.employeeNo || employeeNo,
      log,
      ackTimeoutMs: pushAckTimeoutMs,
    });
  }

  log('info', `Applying ${op} for device ${device.name} (${device.estateMateDeviceId}) card=${cardUid} opId=${operation.id}`);

  try {
    if (op === 'upsert_card' || op === 'enable_card') {
      if (!cardUid) return { success: false, error: 'operation has no card number' };
      if (!employeeNo) {
        return { success: false, error: 'operation has no valid EstateMate employee number; refusing to guess which terminal person owns the card' };
      }
      const written = await writeTerminalCard(device, employeeNo, cardUid);
      if (written.ok) {
        log('info', `Card ${cardUid} upsert OK on ${device.name}: ${written.result.status}`);
        return { success: true };
      }
      log('warn', `Card upsert failed on ${device.name}: ${written.result.status} ${String(written.result.body).slice(0, 500)}`);
      return { success: false, error: describeAttempts(written.attempts) };
    } else if (op === 'disable_card' || op === 'delete_card') {
      if (!cardUid) return { success: false, error: 'operation has no card number' };
      const removed = await deleteTerminalCard(device, cardUid);
      if (removed.ok) {
        log('info', `Card ${cardUid} delete/disable OK on ${device.name}`);
        return { success: true };
      }
      log('warn', `Card delete failed on ${device.name}: ${removed.result.status} ${String(removed.result.body).slice(0, 500)}`);
      return { success: false, error: describeAttempts(removed.attempts) };
    } else if (op === 'revoke_visitor') {
      const credential = payload.credentialNumber || cardUid;
      const legacyEmployeeNo = terminalEmployeeNo(payload, { allowLegacy: true });
      const visitorEmployeeNo = legacyEmployeeNo || (credential && TERMINAL_EMPLOYEE_NO.test(`visitor${credential}`) ? `visitor${credential}` : null);
      if (!visitorEmployeeNo) return { success: false, error: 'operation has no valid visitor employee number' };
      const removed = await deleteTerminalPerson(device, { employeeNo: visitorEmployeeNo, fullRemoval: true });
      if (removed.ok) return { success: true };
      return { success: false, error: `Visitor account revoke ${describeAttempts(removed.attempts)}` };
    } else if (op === 'upsert_visitor') {
      // A visitor is a PIN-only, finite UserInfo account. Do not create CardInfo,
      // fingerprint, or face records: those fields remain "Not added" on device.
      const credential = payload.credentialNumber || cardUid;
      const visitorEmployeeNo = employeeNo || (credential && TERMINAL_EMPLOYEE_NO.test(`visitor${credential}`) ? `visitor${credential}` : null);
      if (!visitorEmployeeNo) return { success: false, error: 'operation has no valid visitor employee number' };
      const person = await writeTerminalVisitorPerson(device, payload, visitorEmployeeNo);
      if (person.ok) return { success: true };
      return { success: false, error: `Visitor account ${describeAttempts(person.attempts)}` };
    }

    else if (op === 'upsert_person') {
      if (!employeeNo) return { success: false, error: 'operation has no valid EstateMate employee number' };
      const written = await writeTerminalPerson(device, { ...payload, employeeNo, userType: payload.userType || (VISITOR_EMPLOYEE_NO.test(employeeNo) ? 'visitor' : 'normal') });
      if (written.ok) {
        log('info', `Person ${employeeNo} upsert OK on ${device.name}: ${written.result.status}`);
        return { success: true };
      }
      log('warn', `Person upsert failed on ${device.name}: ${written.result.status} ${String(written.result.body).slice(0, 500)}`);
      return { success: false, error: describeAttempts(written.attempts) };
    } else if (op === 'delete_person') {
      const legacyEmployeeNo = terminalEmployeeNo(payload, { allowLegacy: true });
      if (!legacyEmployeeNo) return { success: false, error: 'operation has no valid EstateMate employee number' };
      const removed = await deleteTerminalPerson(device, { ...payload, employeeNo: legacyEmployeeNo });
      if (removed.ok) {
        log('info', `Person ${legacyEmployeeNo} removed from ${device.name} via ${removed.mode}`);
        return { success: true };
      }
      log('warn', `Person delete failed on ${device.name}: ${removed.result.status} ${String(removed.result.body).slice(0, 500)}`);
      return { success: false, error: describeAttempts(removed.attempts) };
    } else if (op === 'upload_fingerprint') {
      if (!employeeNo) return { success: false, error: 'operation has no valid EstateMate employee number' };
      if (!operation.fingerData) return { success: false, error: 'the template for this fingerprint has expired; capture it again from a terminal' };
      const written = await writeTerminalFingerprint(device, { ...payload, employeeNo }, operation.fingerData);
      if (written.ok) {
        log('info', `Fingerprint ${payload.fingerNo} for ${employeeNo} written to ${device.name}`);
        return { success: true };
      }
      log('warn', `Fingerprint write failed on ${device.name}: ${written.result.status}`);
      return { success: false, error: describeAttempts(written.attempts) };
    } else if (op === 'delete_fingerprint_device') {
      if (!employeeNo) return { success: false, error: 'operation has no valid EstateMate employee number' };
      const removed = await deleteTerminalFingerprint(device, { ...payload, employeeNo });
      if (removed.ok) {
        log('info', `Fingerprint ${payload.fingerNo} for ${employeeNo} deleted from ${device.name}`);
        return { success: true };
      }
      return { success: false, error: describeAttempts(removed.attempts) };
    } else if (op === 'capture_fingerprint') {
      const captured = await captureTerminalFingerprint(device, payload, Date.now() + CAPTURE_MAX_MS);
      if (captured.ok) {
        log('info', `Fingerprint captured for ${payload.employeeNo ?? '?'} slot ${payload.fingerNo} on ${device.name} (${captured.template.length} chars${captured.quality != null ? `, quality ${captured.quality}` : ''})`);
        // The template goes back to EstateMate, which hands it to the other
        // terminals. It is never written to the bridge log or to disk.
        return { success: true, result: { templateData: captured.template, quality: captured.quality ?? null, fingerNo: Number(payload.fingerNo) } };
      }
      log('warn', `Fingerprint capture failed on ${device.name}: ${captured.error}`);
      return { success: false, error: captured.error };
    }

    const doorCmd = {
      remote_open: 'open',
      remote_close: 'close',
      remote_always_open: 'alwaysOpen',
      remote_always_close: 'alwaysClose',
      remote_resume: 'resume',
    }[op];
    if (doorCmd) {
      const doorNo = Number(payload.doorNo || 1);
      if (!Number.isInteger(doorNo) || doorNo < 1 || doorNo > 8) return { success: false, error: 'doorNo must be 1-8' };
      const sent = await sendDoorCommand(device, doorCmd, doorNo);
      if (sent.ok) return { success: true };
      return { success: false, error: `Door ${describeAttempts(sent.attempts)}` };
    }

    return { success: false, error: `Unknown operation ${op}` };
  } catch (err) {
    log('error', `ISAPI exception for ${device.name}:`, err.message);
    return { success: false, error: err.message };
  }
}

async function pollAndApply() {
  try {
    const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/operations?limit=20`, { method: 'GET' });
    if (!res.ok) {
      log('warn', 'Operations poll failed', res.status, json);
      return;
    }
    const items = json.items || [];
    if (!items.length) {
      log('debug', 'No pending operations');
      return;
    }
    log('info', `Found ${items.length} pending operation(s)`);

    for (const op of items) {
      const device = devices.get(op.deviceId);
      if (!device) {
        log('warn', `Device ${op.deviceId} not configured locally, skipping operation ${op.id}`);
        // Report as failed to avoid stuck queue, or skip? We'll skip and leave for other agent.
        continue;
      }

      const start = Date.now();
      const result = await applyCardOperation(device, op);
      const duration = Date.now() - start;

      // Report result
      try {
        const { res: rRes, json: rJson } = await apiFetch(`/api/isapi/v1/agents/${agentId}/operations/${op.id}/result`, {
          method: 'POST',
          body: JSON.stringify({
            kind: op.kind,
            status: result.success ? 'applied' : 'failed',
            errorMessage: result.error || null,
            durationMs: duration,
            result: result.result || null,
          }),
        });
        if (!rRes.ok) log('warn', `Result report failed for ${op.id}:`, rRes.status, rJson);
        else log('info', `Reported ${result.success ? 'applied' : 'failed'} for ${op.id} in ${duration}ms`);
      } catch (err) {
        log('error', `Failed to report result for ${op.id}:`, err.message);
      }

      // Small delay between operations to avoid overwhelming device
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    log('error', 'Poll error', err.message);
  }
}

// ---------------------------------------------------------------------------
// Remote Network Verification
//
// A terminal holds a few thousand people. An estate with more than that cannot
// fit them on the device, so instead of asking the terminal to decide we let it
// report and decide here, on the LAN, then answer with the door command above.
//
// The rules this section enforces, in the order they matter:
//
// 1. Both switches must be on - this host (`remoteVerify.enabled`) and the
//    terminal in the portal. Neither alone opens anything.
// 2. The decision is made against the local snapshot, never a live query, so a
//    lost internet link makes the gate stale rather than dead.
// 3. A cold cache denies. An agent that has not yet loaded a snapshot must not
//    decide that a stranger is a resident.
// 4. Every decision is recorded, including the refusals, and the door command's
//    own answer is surfaced rather than assumed.
// ---------------------------------------------------------------------------

const credentialCache = new CredentialCache({ cardFormats: cardNumberFormats });
const remoteCooldowns = new CooldownTracker();
const remoteStats = {
  decisions: 0, granted: 0, denied: 0, opened: 0, refused: 0, cooldownSuppressed: 0,
  lastError: null, lastLatencyMs: null, lastAt: null,
};
/** deviceId -> what the portal shows for this terminal's last decision. */
const remoteDeviceState = new Map();
/** Queued event item -> the door command still running for it. */
const pendingDoorCommands = new WeakMap();

const clampDoorNo = (value) => {
  const doorNo = Number(value);
  return Number.isInteger(doorNo) && doorNo >= 1 && doorNo <= 8 ? doorNo : 1;
};

const remoteVerifyActive = (device) => remoteVerifyEnabled && Boolean(device?.remoteVerify?.enabled);
/** The LAN event listener, when one is running. Never opens a port unless configured. */
let lanEventsListener = null;

/** Re-reads each terminal's remote-verification settings from the portal. */
async function refreshRemoteVerifyConfig() {
  if (!remoteVerifyEnabled) return;
  try {
    const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/devices`, { method: 'GET' });
    if (!res.ok) {
      log('warn', `Remote verification: the Worker answered HTTP ${res.status} for terminal settings; the last known settings stay in force`);
      return;
    }
    const items = Array.isArray(json.items) ? json.items : [];
    const byId = new Map(items.map((item) => [String(item.device_id || '').trim(), item]));
    for (const [id, device] of devices) {
      const row = byId.get(id);
      device.remoteVerify = row
        ? {
          enabled: Number(row.remote_verify_enabled) === 1,
          doorNo: clampDoorNo(row.remote_verify_door_no),
          cooldownMs: Number(row.remote_verify_cooldown_ms) > 0 ? Number(row.remote_verify_cooldown_ms) : 1500,
        }
        : { enabled: false, doorNo: 1, cooldownMs: 1500 };
    }
  } catch (err) {
    log('warn', `Remote verification: terminal settings refresh failed: ${err.message}`);
  }
}

/** One page of the credential snapshot, or a thrown error the caller keeps. */
async function fetchSnapshotPage(cursor, since) {
  const params = new URLSearchParams({ limit: String(snapshotPageSize) });
  if (cursor) params.set('cursor', cursor);
  else if (since) params.set('since', since);
  const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/credential-snapshot?${params.toString()}`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}${json?.error ? ` ${json.error}` : ''}`);
  return json;
}

/**
 * Refreshes the local credential set.
 *
 * A failed sync keeps the previous snapshot in place on purpose: a list that is
 * a few minutes stale still opens the right doors, whereas an empty one opens
 * none, and a gate that stops working is worse than a gate that is catching up.
 */
async function syncCredentialSnapshot() {
  if (!remoteVerifyEnabled) return null;
  const result = await credentialCache.sync(fetchSnapshotPage);
  if (result.ok) {
    log('debug', `Credential snapshot: ${result.count} credential(s) in ${result.pages} page(s), version ${result.version ?? 'unknown'}`);
  } else {
    log('warn', `Credential snapshot sync failed: ${result.error}. Keeping the previous snapshot of ${result.count} credential(s); the next attempt asks for a full one.`);
  }
  return result;
}

/**
 * Decides one event and, when it is granted, opens the door.
 *
 * Called from the single event ingest point, so an event that arrived over the
 * alertStream and one that a terminal pushed to the LAN listener are treated
 * identically. The decision itself is synchronous - a Map lookup - and only the
 * door command is allowed to be slow, which is why the event's annotation is
 * written before the command is even sent.
 */
function beginRemoteVerification(deviceId, document, item) {
  if (!remoteVerifyEnabled) return;
  const device = devices.get(deviceId);
  if (!remoteVerifyActive(device)) return;

  const event = parseTerminalEvent(document, '');
  if (!event) return;

  const startedAt = Date.now();
  const decision = decideCredential(credentialCache, { cardNo: event.cardNo, employeeNo: event.employeeNo, deviceId });
  remoteStats.decisions += 1;
  remoteStats.lastAt = new Date().toISOString();
  remoteStats.lastLatencyMs = Date.now() - startedAt;

  const record = {
    decision: decision.decision,
    reason: decision.reason,
    matchedOn: decision.matchedOn ?? null,
    latencyMs: remoteStats.lastLatencyMs,
    doorResult: 'not_attempted',
    doorNo: null,
  };
  item.remoteVerification = record;

  if (decision.decision !== 'granted') {
    remoteStats.denied += 1;
    // The wording the request asked for, and the reason an operator can act on.
    log('info', `Access Denied - Remote Database Lookup Failed at ${device.name}: ${decision.reason} (${event.cardNo ? `card ${event.cardNo}` : `employee ${event.employeeNo}`})`);
    remoteDeviceState.set(deviceId, {
      enabled: true, lastDecision: decision.decision, lastReason: decision.reason,
      lastResult: 'not_attempted', lastLatencyMs: record.latencyMs, lastAt: new Date().toISOString(),
      matchedOn: decision.matchedOn ?? null,
    });
    return;
  }

  remoteStats.granted += 1;
  const cooldownMs = device.remoteVerify?.cooldownMs ?? 1500;
  const gate = remoteCooldowns.allow(cooldownKey(deviceId, decision), cooldownMs);
  if (!gate.allowed) {
    // The same credential moments ago. Counted in the history, but no second
    // command: a card left resting on a reader must not hold the door open.
    remoteStats.cooldownSuppressed += 1;
    record.doorResult = 'not_attempted';
    record.cooldownSuppressed = true;
    log('debug', `Remote verification: ${decision.matchedValue} at ${device.name} is inside the ${cooldownMs}ms cooldown (${gate.waitedMs}ms since the last attempt)`);
    remoteDeviceState.set(deviceId, {
      enabled: true, lastDecision: decision.decision, lastReason: 'cooldown',
      lastResult: 'not_attempted', lastLatencyMs: record.latencyMs, lastAt: new Date().toISOString(),
      matchedOn: decision.matchedOn ?? null,
    });
    return;
  }

  const doorNo = clampDoorNo(event.doorNo || device.remoteVerify?.doorNo || 1);
  record.doorNo = doorNo;
  record.doorResult = 'pending';
  const command = sendDoorCommand(device, 'open', doorNo)
    .then((sent) => {
      if (sent.ok) {
        record.doorResult = 'opened';
        remoteStats.opened += 1;
        log('info', `Remote verification: opened door ${doorNo} at ${device.name} for ${decision.matchedOn} ${decision.matchedValue}`);
      } else {
        record.doorResult = 'refused';
        remoteStats.refused += 1;
        remoteStats.lastError = describeAttempts(sent.attempts);
        // The terminal's own words, not a paraphrase: whether this model honours
        // RemoteControl/door at all is exactly what a refusal settles.
        log('warn', `Remote verification: ${device.name} refused the door command for ${decision.matchedValue}: ${remoteStats.lastError}`);
      }
      remoteDeviceState.set(deviceId, {
        enabled: true, lastDecision: decision.decision, lastReason: decision.reason,
        lastResult: record.doorResult, lastLatencyMs: Date.now() - startedAt, lastAt: new Date().toISOString(),
        matchedOn: decision.matchedOn ?? null,
      });
    })
    .catch((err) => {
      record.doorResult = 'refused';
      remoteStats.refused += 1;
      remoteStats.lastError = String(err?.message ?? err);
      log('warn', `Remote verification: door command failed for ${device.name}: ${remoteStats.lastError}`);
    });
  pendingDoorCommands.set(item, command);
}

/** Per-terminal remote-verification state for the heartbeat, keyed by device id. */
function remoteVerifyHeartbeat() {
  if (!remoteVerifyEnabled) return null;
  const perDevice = {};
  for (const [id, state] of remoteDeviceState) perDevice[id] = state;
  const enabledDevices = [...devices.values()].filter(remoteVerifyActive).length;
  return {
    enabled: true,
    devicesEnabled: enabledDevices,
    listener: lanEventsListener ? { bound: true, ...lanEventsListener.stats } : { bound: false },
    cache: credentialCache.stats(),
    // A snapshot the size of the estate is worth watching: a bridge serving
    // 20,000 credentials from a list it refreshed an hour ago is a different
    // risk from one that refreshed ten seconds ago.
    stale: credentialCache.ageSeconds() !== null && credentialCache.ageSeconds() > Math.max(300, snapshotInterval * 5),
    ...remoteStats,
    perDevice,
  };
}

async function main() {
  log('info', `EstateMate ISAPI Bridge starting...`);
  await resolveDeviceIds();
  const streamDevices = [...devices.values()].filter((device) => device.eventStream !== false);
  log('info', `Agent: ${agentId}, Worker: ${workerUrl}, Devices: ${devices.size}, Interval: ${syncInterval}s, EventStream: ${eventStreamEnabled ? `on (${streamDevices.length} device(s))` : 'off'}`);

  // Remote verification has to have its snapshot before the first event arrives:
  // a cold cache denies everything, which is the correct failure mode but a
  // useless one if it is only because we started in the wrong order.
  if (remoteVerifyEnabled) {
    await refreshRemoteVerifyConfig();
    await syncCredentialSnapshot();
    const readers = [...devices.values()].filter(remoteVerifyActive);
    log('info', `Remote verification: on, ${readers.length} terminal(s) in reader mode, ${credentialCache.count} credential(s) cached, refresh every ${snapshotInterval}s`);
    if (!readers.length) {
      log('warn', 'Remote verification is enabled on this host but no terminal has it switched on in the portal — Access control devices → the terminal → Remote Network Verification.');
    }
    if (!credentialCache.ready) {
      log('warn', 'Remote verification started without a credential snapshot. Every decision denies until the first sync succeeds; check that the Worker is reachable.');
    }
  }

  if (pushEnabled) {
    const listener = startPushListener();
    const pushDeviceCount = pushDevicesFor().length;
    log('info', `ZKTeco PUSH transport: ${pushDeviceCount} device(s), listening on ${pushBindAddress}:${pushPort} under /iclock/ (terminals must be pointed at this address)`);
    if (!pushDeviceCount) {
      log('warn', 'ZKTeco PUSH is enabled but no device uses it — add "transport": "zkteco_push" to a device entry, or turn zktecoPush off.');
    }
    if (listener?.server) {
      // Bind failures are loud and non-fatal: the ISAPI half of this bridge still
      // has work to do and must not be taken down by a port clash.
      listener.server.once('error', (err) => log('error', `ZKTeco PUSH listener error: ${err.code || err.message}`));
    }
  }

  // A PUSH terminal with the transport switched off is a device nobody will ever
  // serve: it has no ISAPI to fall back on, so say it here rather than letting
  // every operation for it fail with the same message minutes later.
  const disabledPushDevices = pushDevicesFor();
  if (!pushEnabled && disabledPushDevices.length) {
    log('warn', `${disabledPushDevices.length} device(s) are on the ZKTeco PUSH transport but zktecoPush is disabled — no terminal can reach them. Set "zktecoPush": {"enabled": true, "port": ${pushPort}} in agent-config.json.`);
  }

  // The LAN event listener is the alternative to pulling an alertStream: some
  // terminals only push. It ingests events for every terminal whether or not
  // remote verification is on, because the history is useful either way - only
  // the decision needs the feature switched on.
  if (lanEventsEnabled) {
    try {
      lanEventsListener = await startLanEventListener({
        port: lanEventsPort,
        bindAddress: lanEventsBindAddress,
        requireKey: lanEventsRequireKey,
        agentKey: lanEventsTerminalKey,
        log,
        resolveDevice: ({ ip, event }) => {
          // The terminal's own reported address is the better identifier; the
          // socket address is the fallback for firmware that omits it.
          const candidates = [event?.deviceIp, ip]
            .map((value) => String(value ?? '').trim().replace(/^::ffff:/, ''))
            .filter(Boolean);
          for (const address of candidates) {
            const hit = [...devices.values()].find((device) => String(device.isapiHost).trim() === address);
            if (hit) return hit;
          }
          return null;
        },
        onEvent: ({ device, raw }) => {
          if (!device?.estateMateDeviceId) return;
          queueEvent(device.estateMateDeviceId, raw);
        },
      });
    } catch (err) {
      // Non-fatal on purpose: a port clash or a missing firewall rule must not
      // take down the half of the bridge that polls and streams.
      log('error', `LAN event listener could not start on ${lanEventsBindAddress}:${lanEventsPort}: ${err?.code || err?.message}`);
    }
  }

  // The first clock check runs before the first heartbeat, so the portal sees
  // each terminal's time from the very first report — a terminal hours off is
  // exactly the one an operator most needs to see early.
  if (timeSyncEnabled) {
    await checkAllTerminalClocks();
    const isapiDevices = [...devices.values()].filter((device) => device.transport === 'isapi').length;
    log('info', `Terminal clock sync: on, ${isapiDevices} terminal(s) checked every ${timeSyncCheckIntervalMs / 60000} min, set when off by more than ${timeSyncMaxDriftMs / 1000}s`);
  }

  await heartbeat();
  await pollAndApply();

  if (eventStreamEnabled) {
    for (const device of streamDevices) {
      deviceEventLoop(device).catch((err) => log('error', `Event stream crashed for ${device.name}`, err.message));
    }
  }

  setInterval(heartbeat, heartbeatInterval * 1000);
  setInterval(pollAndApply, syncInterval * 1000);
  if (timeSyncEnabled) {
    // A clock drifts slowly; the interval exists so a terminal that loses NTP
    // or a battery-backed RTC catches up without anyone noticing the pass
    // window first.
    setInterval(checkAllTerminalClocks, timeSyncCheckIntervalMs);
  }

  // The snapshot is refreshed together with the terminal settings, so a terminal
  // switched into reader mode in the portal starts being served without a restart.
  if (remoteVerifyEnabled) {
    setInterval(async () => {
      await refreshRemoteVerifyConfig();
      await syncCredentialSnapshot();
    }, snapshotInterval * 1000);
  }

  // Graceful shutdown: stop stream loops first, then flush buffered events.
  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log('info', 'Shutting down...');
    // Report the terminals as down first: an orderly stop should not leave the
    // portal showing gates as online while the agent is no longer watching them.
    for (const deviceId of [...streamStates.keys()]) {
      setStreamState(deviceId, 'down', 'agent shutting down');
    }
    // Stop accepting terminal calls before anything else, so a punch that arrives
    // mid-shutdown is not lost between the listener and the event buffer.
    if (pushState.listener) {
      pushState.listener.close().catch(() => undefined);
    }
    if (lanEventsListener) {
      lanEventsListener.close().catch(() => undefined);
    }
    heartbeat()
      .catch(() => undefined)
      .then(() => flushEvents())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Runnable as CLI (`node agent.mjs`), auto-starting when imported by the
// Windows service wrapper. Set ESTATEMATE_AGENT_STANDBY=1 to import the
// exported functions for testing without starting the main loops.
export {
  // Exported for the ZKTeco PUSH checks and for the config wizard: the transport
  // is only real if the agent routes work to it, so this is asserted through the
  // agent rather than only against the standalone module.
  resolvePushDevice,
  startPushListener,
  pushDevicesFor,
  pushState,
  createMultipartEventParser,
  createJsonEventScanner,
  queueEvent,
  flushEvents,
  // Remote Network Verification. Exported so the integration checks drive the
  // real agent - a decision that never reaches the terminal proves nothing, and
  // these are the seams that let a fake Worker and a fake terminal observe it.
  credentialCache,
  remoteStats,
  remoteDeviceState,
  beginRemoteVerification,
  refreshRemoteVerifyConfig,
  syncCredentialSnapshot,
  remoteVerifyHeartbeat,
  sendDoorCommand,
  deviceEventLoop,
  openAlertStream,
  main,
  pendingEvents,
  eventStats,
  streamStates,
  setStreamState,
  heartbeatDeviceStates,
  // Exported for sibling hosts that need to talk to a device without starting
  // the main loops: bridge-apps/windows runs `bridge check` in standby mode and
  // reuses the digest/basic ISAPI client instead of reimplementing it, so there
  // is exactly one place where Hikvision authentication is spelled out.
  isapiRequest,
  // Exported for the card-operation integration checks, which drive the
  // employee-number rules against a simulated terminal without the main loops.
  applyCardOperation,
  describeIsapiFailure,
  // Exported for the person/fingerprint integration checks: the capability probe
  // decides what the Worker will ever hand this bridge, so it is worth asserting
  // against a simulated terminal rather than trusting a comment.
  probeCapabilities,
  capabilitiesForHeartbeat,
  writeTerminalPerson,
  deleteTerminalPerson,
  writeTerminalFingerprint,
  deleteTerminalFingerprint,
  captureTerminalFingerprint,
  extractFingerprintData,
  personBody,
  isStreamHeartbeat,
  terminalEmployeeNo,
  resolveDeviceIds,
  isUuid,
  buildDigestAuthHeader,
  basicAuthHeader,
  alertStreamPath,
  // Terminal clock sync, exported so the integration checks can drive the real
  // read/measure/set/confirm loop against a simulated terminal.
  clockStates,
  timeSyncEnabled,
  timeSyncMaxDriftMs,
  parseTerminalClockTime,
  readTerminalClock,
  setTerminalClock,
  checkTerminalClock,
  checkAllTerminalClocks,
};
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!isEntrypoint && !process.env.ESTATEMATE_AGENT_STANDBY) {
  // Imported by windows-agent/agent.mjs — keep the historical auto-start behavior.
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
} else if (isEntrypoint) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
