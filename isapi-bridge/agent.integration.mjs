#!/usr/bin/env node
/**
 * Integration checks for the ISAPI bridge agent event streaming.
 *
 * Runs without real hardware:
 *  1. multipart/mixed and bare-JSON stream parsers produce exact event documents;
 *  2. the agent streams events from a fake ISAPI terminal (auth challenge)
 *     and flushes them to a fake Worker as batched requests.
 *
 * Exit code 0 = all checks passed. Exercised by `npm test` via
 * `npm run test:isapi-bridge`.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fake Worker: accepts agent heartbeats/operation polls and records event flushes.
// ---------------------------------------------------------------------------
const receivedFlushes = [];
const workerServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url.includes('/events')) {
      const parsed = JSON.parse(body || '{}');
      receivedFlushes.push(parsed);
      const count = Array.isArray(parsed.items) ? parsed.items.length : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accepted: count, rejected: 0 }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: [], serverTime: new Date().toISOString() }));
    }
  });
});
await new Promise((resolve) => workerServer.listen(0, '127.0.0.1', resolve));
const workerPort = workerServer.address().port;

// ---------------------------------------------------------------------------
// Fake ISAPI terminal: one Basic-auth challenge, then a multipart alertStream.
// ---------------------------------------------------------------------------
const deviceServer = createServer((req, res) => {
  if (!req.headers.authorization) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="device"' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=streambnd' });
  res.write('--streambnd\r\nContent-Type: application/json\r\n\r\n{"EventNotificationAlert":{"eventType":"AccessControllerEvent","cardNo":"1111"}}\r\n');
  setTimeout(() => {
    res.write('--streambnd\r\nContent-Type: application/json\r\n\r\n{"EventNotificationAlert":{"eventType":"AccessControllerEvent","cardNo":"2222"}}\r\n');
    res.end('--streambnd--\r\n');
  }, 300);
});
await new Promise((resolve) => deviceServer.listen(0, '127.0.0.1', resolve));
const devicePort = deviceServer.address().port;

// ---------------------------------------------------------------------------
// Agent configuration, then import the agent (config is read at import time).
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'estatemate-agent-'));
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');
writeFileSync(configPath, JSON.stringify({
  agentId: '00000000-0000-4000-a000-000000000009',
  agentSecret: 'integration-test-secret-123456',
  workerUrl: `http://127.0.0.1:${workerPort}`,
  syncIntervalSeconds: 3600,
  heartbeatIntervalSeconds: 3600,
  eventFlushCount: 2,
  eventFlushSeconds: 1,
  logLevel: 'debug',
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [{
    estateMateDeviceId: '11111111-1111-4111-8111-111111111111',
    name: 'Integration Terminal',
    isapiHost: '127.0.0.1',
    isapiPort: devicePort,
    isapiUsername: 'admin',
    isapiPassword: 'device-password',
    protocol: 'http',
  }],
}));
process.env.ESTATEMATE_AGENT_STANDBY = '1';
process.env.CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');

try {
  // 1. Parser checks (no network)
  {
    const documents = [];
    const feed = agent.createMultipartEventParser('MultipartBoundary', (document) => documents.push(document));
    const whole = [
      '--MultipartBoundary\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n',
      '--MultipartBoundary\r\nContent-Type: application/json\r\n\r\n{"b":"brace } in string"}\r\n',
      '--MultipartBoundary\r\nContent-Type: application/xml\r\n\r\n<EventNotificationAlert><eventType>x</eventType></EventNotificationAlert>\r\n',
      '--MultipartBoundary--\r\n',
    ].join('');
    // Feed in awkward chunk sizes to prove incremental parsing.
    for (let i = 0; i < whole.length; i += 7) feed(whole.slice(i, i + 7));
    assert.equal(documents.length, 3, `expected 3 documents, got ${documents.length}`);
    assert.equal(documents[0], '{"a":1}');
    assert.equal(documents[1], '{"b":"brace } in string"}');
    assert.equal(documents[2], '<EventNotificationAlert><eventType>x</eventType></EventNotificationAlert>');
    console.log('multipart parser OK');

    const jsonDocuments = [];
    const jsonFeed = agent.createJsonEventScanner((document) => jsonDocuments.push(document));
    const jsonWhole = '{"first":1}  {"nested":{"text":"}{"},"deep":[1,2,{"x":"}"}]} {"last":3}';
    for (let i = 0; i < jsonWhole.length; i += 5) jsonFeed(jsonWhole.slice(i, i + 5));
    assert.equal(jsonDocuments.length, 3, `expected 3 JSON documents, got ${jsonDocuments.length}`);
    assert.deepEqual(JSON.parse(jsonDocuments[0]), { first: 1 });
    assert.deepEqual(JSON.parse(jsonDocuments[1]), { nested: { text: '}{' }, deep: [1, 2, { x: '}' }] });
    assert.deepEqual(JSON.parse(jsonDocuments[2]), { last: 3 });
    console.log('JSON scanner OK');
  }

  // 2. Streaming end-to-end
  await agent.main();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const items = receivedFlushes.flatMap((flush) => flush.items || []);
    if (items.length >= 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const items = receivedFlushes.flatMap((flush) => flush.items || []);
  assert.equal(items.length, 2, `expected 2 forwarded items, got ${items.length}`);
  assert.equal(items[0].deviceId, '11111111-1111-4111-8111-111111111111');
  assert.ok(items[0].document.includes('"cardNo":"1111"'), 'first document mismatch');
  assert.ok(items[1].document.includes('"cardNo":"2222"'), 'second document mismatch');
  assert.equal(agent.pendingEvents.length, 0, 'buffer should be empty after flush');
  console.log('streaming end-to-end OK:', receivedFlushes.length, 'flush request(s)');

  console.log('ISAPI bridge agent integration checks passed');
  process.exit(0);
} finally {
  workerServer.close();
  deviceServer.close();
  rmSync(dir, { recursive: true, force: true });
}
