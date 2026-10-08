#!/usr/bin/env node
/**
 * Integration checks for the agent's terminal clock sync.
 *
 * A terminal enforces every time-sensitive decision with its own clock: a
 * visitor's finite pass window is checked against the terminal's hardware,
 * and gate events carry its timestamp. These checks prove the bridge's
 * read → measure → set → confirm loop against a simulated terminal:
 *
 * - a terminal far off the bridge's time is set back, and the state reported
 *   on the heartbeat reflects the corrected clock;
 * - a terminal inside the threshold is left alone (no write, no sync count);
 * - a terminal that stops answering keeps its last good reading plus the
 *   error, instead of erasing the last known clock from the portal;
 * - the write is JSON-first and falls back to XML only when the firmware
 *   does not support the JSON URL.
 *
 * The simulated terminal enforces only documented ISAPI behaviour: the JSON
 * Set URL is not supported on this firmware (so the XML fallback is what
 * must work), and both Set formats are applied to a mutable clock.
 * Exit code 0 = all checks passed. Run by `npm run test:isapi-bridge`.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Simulated terminal: Basic-auth challenge, mutable wall clock in the host's
// own timezone (the invariant the bridge maintains: gate and office PC show
// the same wall clock).
// ---------------------------------------------------------------------------
const requests = [];
let terminalClockMs = Date.now() + 2 * 60 * 60 * 1000; // starts 2h ahead
const wallClockParts = (ms) => {
  const d = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
};
const jsonSetRefusals = { enabled: true };
const deviceServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (!req.headers.authorization) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="terminal"' });
      res.end();
      return;
    }
    requests.push({ method: req.method, url: req.url, body });
    const json = req.url.includes('format=json');
    const ok = (payload) => {
      res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'application/xml' });
      res.end(json ? JSON.stringify(payload) : `<?xml version="1.0" encoding="UTF-8"?>\n<time xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0"><date>${wallClockParts(terminalClockMs).date}</date><time>${wallClockParts(terminalClockMs).time}</time><timeType>local</timeType></time>`);
    };

    if (req.method === 'GET' && req.url.startsWith('/ISAPI/System/time/Get')) {
      const { date, time } = wallClockParts(terminalClockMs);
      if (json) return ok({ time: { date, time, timeType: 'local' } });
      return ok(null); // the XML branch writes its own body above
    }
    if (req.method === 'PUT' && req.url.startsWith('/ISAPI/System/time/Set')) {
      if (json) {
        if (jsonSetRefusals.enabled) {
          // This firmware does not implement the JSON URL at all.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ requestURL: req.url, statusCode: 4, statusString: 'Invalid URL', subStatusCode: 'notSupport', errorCode: 1610612768, errorMsg: 'notSupport' }));
          return;
        }
        const { date, time, timeType } = JSON.parse(body).time || {};
        assert.ok(timeType === 'local', 'the JSON Set must keep the terminal in its own zone');
        terminalClockMs = new Date(`${date}T${time}`).getTime();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 1, statusString: 'OK', subStatusCode: 'ok' }));
        return;
      }
      const date = /<date>([^<]*)<\/date>/.exec(body)?.[1];
      const time = /<time>(\d{2}:\d{2}:\d{2})<\/time>/.exec(body)?.[1];
      const timeType = /<timeType>([^<]*)<\/timeType>/.exec(body)?.[1];
      if (!date || !time || timeType !== 'local') {
        res.writeHead(400, { 'Content-Type': 'application/xml' });
        res.end('bad time body');
        return;
      }
      terminalClockMs = new Date(`${date}T${time}`).getTime();
      return ok(null);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' }));
  });
});
await new Promise((resolve) => deviceServer.listen(0, '127.0.0.1', resolve));
const devicePort = deviceServer.address().port;

// A dead port for the "terminal stops answering" check: bind, close, reuse.
const deadServer = createServer(() => {});
await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
const deadPort = deadServer.address().port;
await new Promise((resolve) => deadServer.close(resolve));

// ---------------------------------------------------------------------------
// Agent configuration, then import the agent in standby (config is read at import).
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'estatemate-agent-clocks-'));
const configPath = join(dir, 'agent-config.json');
const devicesPath = join(dir, 'isapi-devices.json');
const deviceId = '33333333-3333-4333-8333-333333333333';
const deadDeviceId = '44444444-4444-4444-8444-444444444444';
writeFileSync(configPath, JSON.stringify({
  agentId: '00000000-0000-4000-a000-000000000020',
  agentSecret: 'integration-test-secret-123456',
  workerUrl: 'http://127.0.0.1:9',
  eventStream: false,
  logLevel: 'error',
  timeSync: { enabled: true, maxDriftMs: 30000, checkIntervalMinutes: 15 },
}));
writeFileSync(devicesPath, JSON.stringify({
  devices: [
    { estateMateDeviceId: deviceId, name: 'Clock Terminal', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' },
    { estateMateDeviceId: deadDeviceId, name: 'Dead Terminal', isapiHost: '127.0.0.1', isapiPort: deadPort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' },
  ],
}));
process.env.ESTATEMATE_AGENT_STANDBY = '1';
process.env.CONFIG = configPath;
process.env.DEVICES_FILE = devicesPath;

const agent = await import('./agent.mjs');
const device = { estateMateDeviceId: deviceId, name: 'Clock Terminal', isapiHost: '127.0.0.1', isapiPort: devicePort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' };
const deadDevice = { estateMateDeviceId: deadDeviceId, name: 'Dead Terminal', isapiHost: '127.0.0.1', isapiPort: deadPort, isapiUsername: 'admin', isapiPassword: 'device-password', protocol: 'http' };
const toleranceMs = 15000;

try {
  // 0. Config was honoured.
  assert.equal(agent.timeSyncEnabled, true, 'timeSync.enabled must be honoured');
  assert.equal(agent.timeSyncMaxDriftMs, 30000, 'the configured threshold is the threshold');
  console.log('config OK');

  // 1. A terminal 2h ahead is set back to the bridge's time, JSON-first,
  //    falling back to XML when the firmware has no JSON URL.
  {
    terminalClockMs = Date.now() + 2 * 60 * 60 * 1000;
    const before = requests.length;
    const state = await agent.checkTerminalClock(device);
    const made = requests.slice(before);
    assert.equal(made.length, 4, 'read, JSON set (refused), XML set, confirm read');
    assert.equal(made[0].url, '/ISAPI/System/time/Get?format=json');
    assert.equal(made[1].method, 'PUT');
    assert.equal(made[1].url, '/ISAPI/System/time/Set?format=json');
    assert.equal(made[2].method, 'PUT');
    assert.equal(made[2].url, '/ISAPI/System/time/Set', 'the set must fall back to the XML URL');
    assert.match(made[2].body, /<timeType>local<\/timeType>/, 'the set must keep the terminal in its own zone');
    assert.equal(made[3].url, '/ISAPI/System/time/Get?format=json', 'the confirm re-reads the terminal');
    assert.ok(Math.abs(terminalClockMs - Date.now()) <= toleranceMs, 'the terminal clock must be back within tolerance of the bridge');
    assert.equal(state.syncs, 1, 'exactly one sync was recorded');
    assert.ok(state.lastSyncAt, 'the sync is timestamped');
    assert.equal(state.lastError, null);
    assert.ok(Math.abs(state.driftMs) <= toleranceMs, 'the reported drift is the confirmed one');
    console.log('terminal 2h ahead set back OK');
  }

  // 2. A terminal inside the threshold is left alone: no write, no new sync.
  {
    terminalClockMs = Date.now() + 5000;
    const before = requests.length;
    const state = await agent.checkTerminalClock(device);
    const made = requests.slice(before);
    assert.equal(made.length, 1, 'a within-tolerance clock is only read');
    assert.equal(made[0].method, 'GET');
    assert.equal(state.syncs, 1, 'no sync was added');
    assert.ok(state.driftMs > 0 && state.driftMs < 60000, 'the small positive drift is reported, not corrected');
    console.log('within-tolerance terminal left alone OK');
  }

  // 3. The state rides on the heartbeat for the Worker to store.
  {
    const entries = agent.heartbeatDeviceStates();
    const entry = entries.find((item) => item.deviceId === deviceId);
    assert.ok(entry, 'the terminal is in the heartbeat device list');
    assert.ok(entry.clock, 'the clock state is carried on the heartbeat');
    assert.ok(entry.clock.terminalTime, 'terminalTime is present');
    assert.equal(typeof entry.clock.driftMs, 'number');
    assert.ok(entry.clock.lastCheckedAt, 'lastCheckedAt is present');
    assert.ok(entry.clock.lastSyncAt, 'lastSyncAt is present');
    assert.equal(entry.clock.syncs, 1);
    console.log('heartbeat carries the clock state OK');
  }

  // 4. A terminal that stops answering keeps its last good reading plus the
  //    error, instead of erasing the clock the portal last showed.
  {
    const goodBefore = agent.clockStates.get(deviceId);
    const state = await agent.checkTerminalClock(deadDevice);
    assert.equal(state.terminalTime, null, 'a device never read has no stored time');
    assert.ok(state.lastError, 'the failure is reported');
    // A second failure must not lose anything either — and the healthy
    // terminal's state must be untouched by the sick one's failure.
    const stateAgain = await agent.checkTerminalClock(deadDevice);
    assert.ok(stateAgain.lastError, 'the error is kept on repeated failures');
    assert.deepEqual(agent.clockStates.get(deviceId), goodBefore, 'a dead terminal must not touch the healthy one');
    console.log('dead terminal keeps last reading plus error OK');
  }

  // 5. checkAllTerminalClocks is the scheduled entry point; with the standby
  //    device map it must be a quiet no-op, not an error.
  {
    await agent.checkAllTerminalClocks();
    console.log('scheduled entry point no-ops cleanly OK');
  }

  // 6. A zone chosen on the bridge app is read with every report and written
  //    with every set. This agent's config sets no zone, so the historical
  //    behaviour (the host's zone, nothing about zones on the wire) holds.
  {
    assert.equal(agent.timeSyncTimeZone, null, 'no timeSync.timeZone configured means the host zone');

    // A report is interpreted in the chosen zone: 09:00 in Africa/Lagos is
    // 08:00 UTC — one hour behind reading the same wall clock in a UTC host.
    const report = JSON.stringify({ time: { date: '2026-10-05', time: '09:00:00' } });
    const inZone = agent.parseTerminalClockTime(report, false, 'Africa/Lagos');
    assert.equal(new Date(inZone).toISOString(), '2026-10-05T08:00:00.000Z', 'a report is read in the chosen zone');
    const inHost = agent.parseTerminalClockTime(report, false, null);
    assert.notEqual(inZone, inHost, 'a chosen zone must change how a report is read');

    // Reading the live terminal through a chosen zone shifts the reported
    // instant by exactly the difference between the two zones.
    const plain = await agent.readTerminalClock(device);
    const zoned = await agent.readTerminalClock(device, 'Africa/Lagos');
    assert.ok(plain.timeMs !== undefined && zoned.timeMs !== undefined, 'both reads must answer');
    const hostOffsetMs = -new Date().getTimezoneOffset() * 60000;
    const expectedShift = 3600000 - hostOffsetMs; // Africa/Lagos is UTC+1, no DST
    assert.ok(Math.abs(plain.timeMs - zoned.timeMs - expectedShift) <= 2000,
      `reading in the chosen zone must shift the instant by the zone difference (${plain.timeMs - zoned.timeMs} vs ${expectedShift})`);

    // A set carries the zone and renders the wall clock in it: the bridge's
    // 12:00Z is 13:00 in Lagos. This firmware refuses the JSON URL, so both the
    // refused JSON body and the XML fallback must carry the zone.
    const target = Date.UTC(2026, 9, 5, 12, 0, 0);
    const before = requests.length;
    const write = await agent.setTerminalClock(device, target, 'Africa/Lagos');
    assert.equal(write.ok, true, 'the set must succeed through the XML fallback');
    const attempts = requests.slice(before).filter((request) => request.method === 'PUT');
    assert.equal(attempts.length, 2, 'JSON set refused, XML set applied');
    const sent = JSON.parse(attempts[0].body).time;
    assert.equal(sent.timeZone, 'Africa/Lagos', 'the JSON set carries the chosen zone');
    assert.equal(sent.timeType, 'local');
    assert.equal(sent.date, '2026-10-05');
    assert.equal(sent.time, '13:00:00', 'the wall clock is rendered in the chosen zone');
    assert.match(attempts[1].body, /<timeZone>Africa\/Lagos<\/timeZone>/, 'the XML fallback carries the zone too');

    // Without a zone the write is exactly the historical shape: the host's
    // wall clock and nothing about zones on the wire.
    const beforePlain = requests.length;
    const plainWrite = await agent.setTerminalClock(device, target, null);
    assert.equal(plainWrite.ok, true);
    const plainAttempts = requests.slice(beforePlain).filter((request) => request.method === 'PUT');
    const plainSent = JSON.parse(plainAttempts[0].body).time;
    const hostClock = new Date(target);
    const pad = (value) => String(value).padStart(2, '0');
    assert.deepEqual(plainSent, {
      date: `${hostClock.getFullYear()}-${pad(hostClock.getMonth() + 1)}-${pad(hostClock.getDate())}`,
      time: `${pad(hostClock.getHours())}:${pad(hostClock.getMinutes())}:${pad(hostClock.getSeconds())}`,
      timeType: 'local',
    }, 'no zone means the historical write, byte for byte');
    assert.doesNotMatch(plainAttempts[1].body, /timeZone/i, 'no zone is written when none is chosen');
    console.log('chosen time zone read and written OK');
  }
} finally {
  deviceServer.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log('agent time-sync integration: all checks passed');
process.exit(0);
