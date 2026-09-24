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
import { fileURLToPath } from 'node:url';
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

if (!/^[0-9a-f-]{36}$/i.test(agentId)) {
  console.error('Invalid agentId, must be UUID');
  process.exit(1);
}
if (agentSecret.length < 16) {
  console.error('agentSecret too short');
  process.exit(1);
}

const devices = new Map();
for (const d of devicesConfig.devices || []) {
  if (!d.estateMateDeviceId || !d.isapiHost) continue;
  if (d.enabled === false) continue;
  devices.set(d.estateMateDeviceId, {
    estateMateDeviceId: String(d.estateMateDeviceId),
    name: String(d.name || d.isapiHost),
    isapiHost: String(d.isapiHost).trim(),
    isapiPort: Number(d.isapiPort || 80),
    isapiUsername: String(d.isapiUsername || 'admin'),
    isapiPassword: String(d.isapiPassword || ''),
    protocol: d.protocol === 'https' ? 'https' : 'http',
  });
}

if (!devices.size) {
  console.error('No enabled devices in devices file');
  process.exit(1);
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
    'User-Agent': 'EstateMate-ISAPI-Bridge/1.0',
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
        version: '1.0.0',
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'isapi-bridge',
        platform: process.platform,
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
      const basic = Buffer.from(`${device.isapiUsername}:${device.isapiPassword}`).toString('base64');
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': isXml ? 'application/xml; charset=utf-8' : 'application/json',
        },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      clearTimeout(timeout);
      return { status: res.status, body: text, headers: res.headers };
    }
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
  log('info', `Agent: ${agentId}, Worker: ${workerUrl}, Devices: ${devices.size}, Interval: ${syncInterval}s`);

  await heartbeat();
  await pollAndApply();

  setInterval(heartbeat, heartbeatInterval * 1000);
  setInterval(pollAndApply, syncInterval * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('info', 'Shutting down...');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('info', 'Shutting down...');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
