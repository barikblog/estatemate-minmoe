import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8788);
const workerOrigin = String(process.env.ESTATEMATE_WORKER_URL || 'https://estatemate.barikblog.workers.dev').replace(/\/$/, '');
const configPath = process.env.ESTATEMATE_DEVICES_FILE || '/etc/estatemate/isup-devices.json';
const adapterSecret = String(process.env.ADAPTER_SHARED_SECRET || '');
const maxBody = 2 * 1024 * 1024;

if (!adapterSecret || adapterSecret.length < 32) throw new Error('ADAPTER_SHARED_SECRET must contain at least 32 characters');

function loadDevices() {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!Array.isArray(parsed.devices) || !parsed.devices.length) throw new Error(`${configPath} must define a non-empty devices array`);
  const devices = new Map();
  for (const item of parsed.devices) {
    const localDeviceId = String(item.localDeviceId || '').trim();
    const estateMateDeviceId = String(item.estateMateDeviceId || '').trim();
    const deviceKey = String(item.deviceKey || '').trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(localDeviceId)) throw new Error(`Invalid localDeviceId: ${localDeviceId}`);
    if (!/^[0-9a-f-]{36}$/i.test(estateMateDeviceId)) throw new Error(`Invalid EstateMate device UUID for ${localDeviceId}`);
    if (deviceKey.length < 32) throw new Error(`Device key for ${localDeviceId} is missing or too short`);
    if (devices.has(localDeviceId)) throw new Error(`Duplicate localDeviceId: ${localDeviceId}`);
    devices.set(localDeviceId, { localDeviceId, estateMateDeviceId, deviceKey });
  }
  return devices;
}

let devices = loadDevices();
process.on('SIGHUP', () => {
  try {
    devices = loadDevices();
    console.log(`Reloaded ${devices.size} ISUP device mapping(s)`);
  } catch (error) {
    console.error('Device mapping reload failed:', error instanceof Error ? error.message : String(error));
  }
});

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function authorized(request) {
  const header = request.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBytes = Buffer.from(adapterSecret);
  const presentedBytes = Buffer.from(presented);
  return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

async function bodyBytes(request) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maxBody) throw new Error('PAYLOAD_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function workerFetch(path, device, init = {}) {
  const response = await fetch(`${workerOrigin}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'EstateMate-ISUP-Gateway/1.0',
      'X-EstateMate-Device-Key': device.deviceKey,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(25_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}

function relay(response, upstream) {
  response.writeHead(upstream.response.status, {
    'Content-Type': upstream.response.headers.get('content-type') || 'application/json',
    'Cache-Control': 'no-store',
    'X-EstateMate-Gateway': 'isup-control',
  });
  response.end(upstream.bytes);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, {
      ok: true,
      service: 'EstateMate ISUP gateway control plane',
      configuredDevices: devices.size,
      workerOrigin,
      rawTcpOwnedBy: 'official-hikvision-sdk-adapter',
    });
  }
  if (!authorized(request)) return json(response, 401, { error: 'Adapter authentication required' });

  const eventMatch = /^\/v1\/adapter\/events\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
  const operationMatch = /^\/v1\/adapter\/operations\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
  const resultMatch = /^\/v1\/adapter\/operations\/([A-Za-z0-9._-]+)\/([0-9a-f-]{36})\/result$/i.exec(url.pathname);
  const localDeviceId = eventMatch?.[1] || operationMatch?.[1] || resultMatch?.[1];
  const device = localDeviceId ? devices.get(localDeviceId) : null;
  if (localDeviceId && !device) return json(response, 404, { error: 'Unknown local ISUP device ID' });

  try {
    if (request.method === 'POST' && eventMatch && device) {
      const body = await bodyBytes(request);
      if (!body.length) return json(response, 400, { error: 'Event body is empty' });
      const upstream = await workerFetch(`/api/hikvision/v1/events/${device.estateMateDeviceId}`, device, {
        method: 'POST',
        headers: { 'Content-Type': request.headers['content-type'] || 'application/json' },
        body,
      });
      return relay(response, upstream);
    }
    if (request.method === 'GET' && operationMatch && device) {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20) || 20));
      const upstream = await workerFetch(`/api/hikvision/v1/operations/${device.estateMateDeviceId}?limit=${limit}`, device);
      return relay(response, upstream);
    }
    if (request.method === 'POST' && resultMatch && device) {
      const body = await bodyBytes(request);
      const upstream = await workerFetch(`/api/hikvision/v1/operations/${device.estateMateDeviceId}/${resultMatch[2]}/result`, device, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return relay(response, upstream);
    }
    return json(response, 404, { error: 'Route not found' });
  } catch (error) {
    if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') return json(response, 413, { error: 'Payload exceeds 2 MB' });
    console.error('Gateway request failed:', error instanceof Error ? error.message : String(error));
    return json(response, 502, { error: 'EstateMate Worker request failed' });
  }
});

server.listen(port, host, () => {
  console.log(`EstateMate ISUP control plane listening on ${host}:${port} for ${devices.size} device mapping(s)`);
});
