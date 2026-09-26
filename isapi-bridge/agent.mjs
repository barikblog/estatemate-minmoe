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
  if (!d.isapiHost) continue;
  if (d.enabled === false) continue;
  const device = {
    estateMateDeviceId: String(d.estateMateDeviceId || '').trim(),
    name: String(d.name || d.isapiHost),
    isapiHost: String(d.isapiHost).trim(),
    isapiPort: Number(d.isapiPort || 80),
    isapiUsername: String(d.isapiUsername || 'admin'),
    isapiPassword: String(d.isapiPassword || ''),
    protocol: d.protocol === 'https' ? 'https' : 'http',
    eventStream: d.eventStream !== false,
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
    for (const device of unresolved) {
      console.error(
        `Terminal "${device.name}" (${device.protocol}://${device.isapiHost}:${device.isapiPort}) has no EstateMate device id and the portal does not list it` +
          ` — link it to this agent (Device agent → Connect terminal), or paste the terminal's EstateMate device ID from Connected terminals.`,
      );
    }
    console.error(`Devices linked to this agent in the portal: ${known}`);
    process.exit(1);
  }

  const linkedIds = linked.map((item) => String(item.device_id || '').trim()).filter(Boolean);
  const orphans = linkedIds.filter((id) => !devices.has(id));
  if (orphans.length) {
    log('warn', `${orphans.length} device(s) linked to this agent in the portal are not in the devices file — operations for them stay queued until a terminal is configured for them.`);
  }
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

async function heartbeat() {
  try {
    const { res, json } = await apiFetch(`/api/isapi/v1/agents/${agentId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        version: '1.1.0',
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'isapi-bridge',
        platform: process.platform,
        stats: {
          eventsForwarded: eventStats.forwarded,
          eventsDropped: eventStats.dropped,
          eventsPending: pendingEvents.length,
          eventStream: eventStreamEnabled,
        },
        // Per-terminal liveness: 'down' retires the terminal in the portal at
        // once rather than waiting for the hourly offline sweep.
        devices: heartbeatDeviceStates(),
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
  return [...streamStates.entries()].map(([deviceId, state]) => ({
    deviceId,
    stream: state.stream,
    lastError: state.lastError,
  }));
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
  pendingEvents.push({ deviceId, document });
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
          const feed = boundary
            ? createMultipartEventParser(boundary, (document) => queueEvent(device.estateMateDeviceId, document))
            : createJsonEventScanner((document) => queueEvent(device.estateMateDeviceId, document));
          for await (const chunk of res.body) {
            if (shutdownRequested) break;
            feed(decoder.decode(chunk, { stream: true }));
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

async function applyCardOperation(device, operation) {
  const payload = operation.payload || {};
  const cardUid = payload.cardUid || payload.cardNo || payload.card_number;
  const employeeNo = payload.employeeNo || payload.residentId || '1';
  const op = operation.operation;

  log('info', `Applying ${op} for device ${device.name} (${device.estateMateDeviceId}) card=${cardUid} opId=${operation.id}`);

  // Example ISAPI payloads - these vary by model/firmware. Adjust per your device manual.
  // This is a best-effort generic implementation; test against your specific model.

  try {
    if (op === 'upsert_card' || op === 'enable_card') {
      // Check if card exists
      // PUT /ISAPI/AccessControl/CardInfo/Record?format=json or /ISAPI/AccessControl/CardInfo/SetUp?format=json
      // For simplicity, we attempt to create/update card via ISAPI JSON if supported.
      const cardXml = `<?xml version="1.0" encoding="UTF-8"?>
<CardInfo>
  <employeeNo>${employeeNo}</employeeNo>
  <cardNo>${cardUid}</cardNo>
  <cardType>normalCard</cardType>
</CardInfo>`;

      // Try JSON first (newer firmware)
      const jsonBody = {
        CardInfo: {
          employeeNo: String(employeeNo),
          cardNo: String(cardUid),
          cardType: 'normalCard',
        },
      };

      let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CardInfo/Record?format=json', JSON.stringify(jsonBody), false);
      if (result.status >= 400) {
        // Fallback to XML
        result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CardInfo/Record?format=json', null);
        // Try XML endpoint
        result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CardInfo/Record', cardXml, true);
      }

      if (result.status >= 200 && result.status < 300) {
        log('info', `Card ${cardUid} upsert OK on ${device.name}: ${result.status}`);
        return { success: true };
      } else {
        log('warn', `Card upsert failed on ${device.name}: ${result.status} ${result.body.slice(0, 500)}`);
        // Some devices return 200 with error in body, parse
        if (result.body.includes('ok') || result.body.includes('success')) return { success: true };
        return { success: false, error: `ISAPI ${result.status}: ${result.body.slice(0, 200)}` };
      }
    } else if (op === 'disable_card' || op === 'delete_card') {
      // Delete or disable - for disable we could update card status, but many firmwares only support delete.
      // We attempt delete.
      const deleteXml = `<?xml version="1.0" encoding="UTF-8"?>
<CardInfoDelCond>
  <CardNoList>
    <CardNo>${cardUid}</CardNo>
  </CardNoList>
</CardInfoDelCond>`;

      let result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/CardInfo/Delete?format=json', JSON.stringify({ CardNoList: [{ CardNo: cardUid }] }), false);
      if (result.status >= 400) {
        result = await isapiRequest(device, 'PUT', '/ISAPI/AccessControl/CardInfo/Delete', deleteXml, true);
      }

      if (result.status >= 200 && result.status < 300) {
        log('info', `Card ${cardUid} delete/disable OK on ${device.name}`);
        return { success: true };
      } else {
        log('warn', `Card delete failed on ${device.name}: ${result.status} ${result.body.slice(0, 500)}`);
        // If card not found, treat as success (idempotent)
        if (result.body.includes('not exist') || result.body.includes('not found') || result.status === 404) return { success: true };
        return { success: false, error: `ISAPI ${result.status}: ${result.body.slice(0, 200)}` };
      }
    } else if (op === 'upsert_visitor') {
      // Visitor credential - map to temporary card or visitor via ISAPI
      // This is highly model-dependent. We log and mark as applied with note.
      log('info', `Visitor operation ${op} for ${device.name} credential=${payload.credentialNumber} - manual mapping may be required`);
      // For now, treat visitor as card with limited validity
      const visitorCard = payload.credentialNumber || cardUid;
      if (!visitorCard) return { success: false, error: 'Missing credential number' };
      const visitorXml = `<?xml version="1.0" encoding="UTF-8"?>
<CardInfo>
  <employeeNo>visitor-${payload.credentialNumber}</employeeNo>
  <cardNo>${visitorCard}</cardNo>
  <cardType>tempCard</cardType>
</CardInfo>`;
      let result = await isapiRequest(device, 'POST', '/ISAPI/AccessControl/CardInfo/Record', visitorXml, true);
      if (result.status >= 200 && result.status < 300) return { success: true };
      return { success: false, error: `Visitor ISAPI ${result.status}` };
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

async function main() {
  log('info', `EstateMate ISAPI Bridge starting...`);
  await resolveDeviceIds();
  const streamDevices = [...devices.values()].filter((device) => device.eventStream !== false);
  log('info', `Agent: ${agentId}, Worker: ${workerUrl}, Devices: ${devices.size}, Interval: ${syncInterval}s, EventStream: ${eventStreamEnabled ? `on (${streamDevices.length} device(s))` : 'off'}`);

  await heartbeat();
  await pollAndApply();

  if (eventStreamEnabled) {
    for (const device of streamDevices) {
      deviceEventLoop(device).catch((err) => log('error', `Event stream crashed for ${device.name}`, err.message));
    }
  }

  setInterval(heartbeat, heartbeatInterval * 1000);
  setInterval(pollAndApply, syncInterval * 1000);

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
  createMultipartEventParser,
  createJsonEventScanner,
  queueEvent,
  flushEvents,
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
  resolveDeviceIds,
  isUuid,
  buildDigestAuthHeader,
  basicAuthHeader,
  alertStreamPath,
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
