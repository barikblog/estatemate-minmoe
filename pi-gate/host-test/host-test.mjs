#!/usr/bin/env node
/**
 * Host tests for the EstateMate Raspberry Pi gate controller.
 *
 * There is no Pi here, so GPIO is the fake backend (scripted edges in, recorded
 * writes out) and the Worker is a stub HTTP server. Everything else is the real
 * program: the real Wiegand decoder, the real cache, the real decisions, the
 * real event documents and the real agent protocol.
 *
 *   node pi-gate/host-test/host-test.mjs
 *
 * The event documents are asserted byte for byte against the *ESP32* host
 * test's fixtures: the two controllers must be one protocol, and the only thing
 * that may differ is the human-readable name of the gate in the description.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentApi,
  DEFAULT_CONFIG,
  FakeBackend,
  GateController,
  createClock,
  createGateController,
  createStateFile,
  decodeWiegand,
  loadConfig,
  renderSystemdUnit,
  validateConfig,
} from '../EstateMateGate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const fixturesDir = join(repo, 'esp32-gate', 'host-test', 'fixtures');
const programPath = join(repo, 'pi-gate', 'EstateMateGate.mjs');

let checks = 0;
let failures = 0;
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}
function checkEq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const fixture = (name) => readFileSync(join(fixturesDir, name), 'utf8').trim();

// ---------------------------------------------------------------------------
// A stub Worker, faithful to the routes the real one serves
// ---------------------------------------------------------------------------
const state = {
  cards: [],                // [{ value, validUntil }] served as the full snapshot
  deltaItems: [],
  deltaRemoved: [],
  operations: [],
  retryAfterSeconds: 10,
  snapshotPagesServed: 0,
  failSnapshotPage: 0,      // 1-based page number to fail
  sinceSeen: [],
  seen: { heartbeats: [], snapshotRequests: [], results: [], events: [], operationsPolls: 0 },
  eventsStatus: 200,
};

function resetState() {
  state.cards = [];
  state.deltaItems = [];
  state.deltaRemoved = [];
  state.operations = [];
  state.snapshotPagesServed = 0;
  state.failSnapshotPage = 0;
  state.sinceSeen = [];
  state.eventsStatus = 200;
  state.seen = { heartbeats: [], snapshotRequests: [], results: [], events: [], operationsPolls: 0 };
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api\/isapi\/v1\/agents\/[^/]+/, '');
    const json = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'POST' && path === '/heartbeat') {
      state.seen.heartbeats.push(JSON.parse(body || '{}'));
      json(200, { ok: true, serverTime: '2026-10-10T08:00:00.000Z' });
      return;
    }
    if (request.method === 'GET' && path === '/credential-snapshot') {
      state.snapshotPagesServed += 1;
      const since = url.searchParams.get('since') ?? '';
      const cursor = url.searchParams.get('cursor') ?? '';
      state.seen.snapshotRequests.push({ since, cursor, limit: url.searchParams.get('limit') });
      state.sinceSeen.push(since);
      if (state.failSnapshotPage && state.snapshotPagesServed === state.failSnapshotPage) {
        json(503, { error: 'stub worker is unavailable' });
        return;
      }
      const source = since ? state.deltaItems : state.cards;
      // The real cursor is opaque to the controller; pages are served two at a time.
      let start = 0;
      if (cursor) start = Number(cursor.split('|')[0]) || 0;
      const end = Math.min(source.length, start + 2);
      const items = [{ kind: 'employee', value: 'EMPRITA', status: 'active', validUntil: null }];
      for (let i = start; i < end; i += 1) {
        items.push({ kind: 'card', value: source[i].value, status: 'active', validUntil: source[i].validUntil ?? null });
      }
      const nextCursor = end < source.length ? `${end}|card` : null;
      json(200, {
        agentId: 'agent-pi-gate-test',
        serverTime: '2026-10-10T08:00:00.000Z',
        full: !since,
        items,
        removed: since ? state.deltaRemoved.map((value) => ({ kind: 'card', value })) : [],
        nextCursor,
      });
      return;
    }
    if (request.method === 'GET' && path === '/operations') {
      state.seen.operationsPolls += 1;
      json(200, { items: state.operations, retryAfterSeconds: state.retryAfterSeconds });
      return;
    }
    if (request.method === 'POST' && /^\/operations\/[^/]+\/result$/.test(path)) {
      state.seen.results.push({ id: path.split('/')[2], body: JSON.parse(body || '{}') });
      json(200, { ok: true });
      return;
    }
    if (request.method === 'POST' && path === '/events') {
      if (state.eventsStatus >= 400) { json(state.eventsStatus, { error: 'nope' }); return; }
      const payload = JSON.parse(body || '{}');
      for (const item of payload.items ?? []) state.seen.events.push(item);
      json(200, { ok: true, accepted: (payload.items ?? []).length });
      return;
    }
    json(404, { error: 'not found' });
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const workerUrl = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------
const WALL_BASE = 1791620100;           // 2026-10-10T08:15:00Z, the fixtures' first instant
const BOOT_ID = '5eed1234';

let dir = '';
function freshDir() {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'pi-gate-host-'));
  return dir;
}

function makeRig({ cardNumberFormats, cards = [], config: overrides = {}, bootId = BOOT_ID, wallBase = WALL_BASE } = {}) {
  freshDir();
  const elapsed = { ms: 0 };
  const clock = createClock({ nowMs: () => wallBase * 1000 + elapsed.ms });
  const logLines = [];
  const log = {
    error: (...args) => logLines.push(['error', args.join(' ')]),
    warn: (...args) => logLines.push(['warn', args.join(' ')]),
    info: (...args) => logLines.push(['info', args.join(' ')]),
    debug: () => {},
  };
  const config = {
    ...DEFAULT_CONFIG,
    workerUrl,
    agentId: 'agent-pi-gate-test',
    agentSecret: 'host-test-secret',
    deviceId: 'device-gate-test',
    stateDir: dir,
    label: 'ESP32 gate controller',      // the fixtures were written by the ESP32 sketch
    timings: { ...DEFAULT_CONFIG.timings, ...(overrides.timings ?? {}) },
    gpio: { ...DEFAULT_CONFIG.gpio, backend: 'fake', ...(overrides.gpio ?? {}) },
    ...overrides,
  };
  const events = [];
  const gpio = new FakeBackend({ config: config.gpio, onEvent: (event) => controller.handleGpioEvent(event), log });
  const controller = new GateController({
    config,
    io: gpio,
    clock,
    log,
    maxCards: config.maxCards,
  });
  gpio.start();
  const stateFile = createStateFile(join(dir, 'state.json'));
  gpio.loadState = () => stateFile.loadState();
  gpio.persistState = (patch) => stateFile.persistState(patch);
  controller.bootId = bootId;
  const api = new AgentApi({ workerUrl, agentId: config.agentId, agentSecret: config.agentSecret, log });
  for (const card of cards) controller.cache.cards.set(String(card.value).replace(/^0+(?=[0-9])/, ''), { validUntil: card.validUntil ?? 0 });
  if (cards.length) controller.cache.ready = true;
  return {
    controller, gpio, api, config, clock, logLines, events,
    advance(ms) { elapsed.ms += ms; },
    at(ms) { return ms; },
    state,
    async heartbeat() {
      const body = controller.heartbeatBody({ hostname: 'estatemate-gate-abc123', ip: '192.168.1.5' });
      const result = await api.heartbeat(body);
      return { body, result };
    },
  };
}

/** A parity-correct Wiegand frame, like the ESP32 host test's `wiegandFrame`. */
function wiegandFrame(data, count) {
  const dataBits = count - 2;
  const half = Math.floor(dataBits / 2);
  let bits = BigInt(data) << 1n;
  const firstHalf = (BigInt(data) >> BigInt(dataBits - half)) & ((1n << BigInt(half)) - 1n);
  const secondHalf = BigInt(data) & ((1n << BigInt(dataBits - half)) - 1n);
  if (popcount(firstHalf) % 2) bits |= 1n << BigInt(count - 1);
  if (popcount(secondHalf) % 2 === 0) bits |= 1n;
  return bits;
}

function popcount(value) {
  let n = 0;
  let rest = value;
  while (rest) { n += Number(rest & 1n); rest >>= 1n; }
  return n;
}

/** Taps a card: 26 falling edges on D0/D1, 2 ms apart, then a tick to close the frame. */
function tapCard(rig, data, count = 26) {
  const bits = wiegandFrame(data, count);
  const start = rig.controller.nowMs();
  for (let i = 0; i < count; i += 1) {
    const bit = (bits >> BigInt(count - 1 - i)) & 1n;
    rig.gpio.emit({ line: bit ? 'd1' : 'd0', edge: 'falling', t: start + i * 2 });
  }
  // The frame closes once the lines have been quiet for the frame gap.
  rig.advance(60);
  rig.controller.service(rig.controller.nowMs() + 60);
}

function pressKeys(rig, keys) {
  let at = rig.controller.nowMs();
  for (const key of keys) {
    const code = key === '#' ? 11 : key === '*' ? 10 : Number(key);
    rig.controller.handleKey(code, at);
    at += 100;
  }
}

function keysToPin(rig, pin) {
  pressKeys(rig, `${pin}#`);
}

// ---------------------------------------------------------------------------
console.log('Pi gate host tests');
console.log('');

// 1. Wiegand decoding, identical to the sketch's
{
  const f = decodeWiegand(wiegandFrame(77881, 26), 26);
  checkEq('a 26-bit frame decodes to its card number', f.card, '77881');
  checkEq('an 8-bit keypad frame decodes after its complement check', decodeWiegand(0x4Bn, 8).key, 11);
  check('an 8-bit frame with a broken complement is refused', decodeWiegand(0xBBn, 8).kind === 'error');
  check('a 9-bit frame is unsupported', decodeWiegand(0x1FFn, 9).kind === 'error');
  const broken = wiegandFrame(77881, 26) ^ (1n << 5n);
  check('a 26-bit frame with a flipped data bit fails parity', decodeWiegand(broken, 26).kind === 'error');
  checkEq('a 34-bit frame decodes', decodeWiegand(wiegandFrame(3735928559, 34), 34).card, '3735928559');
  checkEq('a 4-bit keypad burst is a key', decodeWiegand(7n, 4).key, 7);
}

// 2. A cold cache denies; the first snapshot arms it
{
  resetState();
  const rig = makeRig();
  const cold = rig.controller.decideCard('77881', WALL_BASE);
  check('a cold cache denies every card', cold.granted === false && cold.reason === 'cache_not_ready');

  state.cards = [
    { value: '0000077881', validUntil: null },
    { value: '0000077882', validUntil: null },
    { value: '0000010003', validUntil: '2026-10-10T08:00:00Z' },
  ];
  const ok = await rig.controller.syncSnapshot(rig.api);
  check('the full snapshot syncs', ok === true);
  checkEq('every page was fetched with the page size the sketch uses', state.seen.snapshotRequests[0].limit, '250');
  check('the employee row is not cached: the reader presents cards only', rig.controller.cache.count === 3);
  check('an unexpired card is granted', rig.controller.decideCard('77881', WALL_BASE).granted === true);
  check('leading zeroes are ignored when matching', rig.controller.decideCard('00000077881', WALL_BASE).granted === true);
  check('an unknown card is denied', rig.controller.decideCard('99999999', WALL_BASE).reason === 'unknown_credential');
  rig.advance(3600 * 1000);
  check('an expired card is denied', rig.controller.decideCard('10003', rig.clock.nowSeconds()).reason === 'credential_expired');
  check('the next delta asks from two minutes before the server time', rig.controller.cache.since === '2026-10-10 07:58:00');
  const stats = rig.controller.cache.stats(rig.clock.nowSeconds());
  check('the heartbeat cache block says the snapshot is ready', stats.ready === true && stats.credentialCount === 3);
  check('the sync count moved', stats.syncCount === 1);
}

// 3. A delta applies removals before additions, and a failed refresh changes nothing
{
  resetState();
  const rig = makeRig();
  state.cards = [{ value: '1234', validUntil: null }, { value: '5678', validUntil: null }];
  await rig.controller.syncSnapshot(rig.api);

  state.deltaItems = [{ value: '1234', validUntil: null }];
  state.deltaRemoved = ['5678'];
  await rig.controller.syncSnapshot(rig.api);
  check('a revocation between syncs leaves the cache', rig.controller.cache.lookup('5678') === null);
  check('a credential that was not revoked stays', rig.controller.cache.lookup('1234') !== null);
  const before = rig.controller.cache.count;
  checkEq('a delta asks with the since value', state.sinceSeen.at(-1), '2026-10-10 07:58:00');

  state.failSnapshotPage = state.snapshotPagesServed + 1;
  state.deltaRemoved = [];
  state.deltaItems = [];
  const failed = await rig.controller.syncSnapshot(rig.api);
  check('a failed page is reported as a failed sync', failed === false);
  check('a failed refresh keeps the whole previous snapshot', rig.controller.cache.count === before && rig.controller.cache.lookup('1234') !== null);
  check('a failed refresh is visible in the heartbeat', /HTTP 503/.test(String(rig.controller.cache.stats().lastSyncError)));
  check('the cache stays ready after a failed refresh', rig.controller.cache.ready === true);
}

// 4. An oversized snapshot is refused, and the previous one survives
{
  resetState();
  const rig = makeRig({ config: { maxCards: 3 } });
  state.cards = [{ value: '1', validUntil: null }, { value: '2', validUntil: null }];
  check('a snapshot inside the capacity syncs', await rig.controller.syncSnapshot(rig.api) === true);
  state.cards = [
    { value: '1', validUntil: null }, { value: '2', validUntil: null },
    { value: '3', validUntil: null }, { value: '4', validUntil: null },
  ];
  rig.controller.cache.since = '';   // force a full refresh, as a first boot would
  const refused = await rig.controller.syncSnapshot(rig.api);
  check('a snapshot larger than maxCards is refused', refused === false);
  check('the refusal names the capacity', /holds 3/.test(String(rig.controller.cache.stats().lastSyncError)));
  check('the previous snapshot survived the refusal', rig.controller.cache.count === 2 && rig.controller.cache.lookup('1') !== null);
}

// 5. The event documents are byte for byte the ESP32 sketch's
{
  resetState();
  const rig = makeRig({ cards: [{ value: '77881' }] });
  rig.controller.visitors.upsert('visitorV12345', '482913', 0, Math.floor(Date.parse('2026-10-11T08:00:00Z') / 1000));

  // Card granted at 08:15:00 (fixture 1)
  tapCard(rig, 77881);
  const grantedEvent = rig.controller.events.at(-1);
  checkEq('a granted card produces the ESP32 fixture document', rig.controller.buildEventDocument(grantedEvent), fixture('event-card-granted.json'));
  check('the granted card pulsed the relay', rig.gpio.writes.at(-1)?.role === 'relay' && rig.gpio.writes.at(-1)?.value === true);

  // Card denied at 08:15:00 (fixture 2) - same instant, a 34-bit card, as the
  // ESP32 host test taps it (99999999 does not fit a 26-bit frame).
  tapCard(rig, 99999999, 34);
  const deniedEvent = rig.controller.events.at(-1);
  checkEq('a denied card produces the ESP32 fixture document', rig.controller.buildEventDocument(deniedEvent), fixture('event-card-denied.json'));
  tapCard(rig, 99999999, 34);
  checkEq('a resting card inside the cooldown is ignored', rig.controller.events.length, 2);

  // PIN granted at 08:16:00 (fixture 3)
  rig.advance(60 * 1000);
  keysToPin(rig, '482913');
  const pinEvent = rig.controller.events.at(-1);
  checkEq('a granted PIN produces the ESP32 fixture document', rig.controller.buildEventDocument(pinEvent), fixture('event-pin-granted.json'));
  check('the typed PIN is nowhere in the event document', !rig.controller.buildEventDocument(pinEvent).includes('482913'));

  // Exit button at 08:17:00 (fixture 4)
  rig.advance(60 * 1000);
  rig.gpio.emit({ line: 'exit', edge: 'falling', t: rig.controller.nowMs() });
  const exitEvent = rig.controller.events.at(-1);
  checkEq('the exit button produces the ESP32 fixture document', rig.controller.buildEventDocument(exitEvent), fixture('event-exit.json'));

  checkEq('the four serial numbers are the fixtures\'', rig.controller.events.map((event) => event.seq).join(','), '1,2,3,4');
  check('the counters add up', rig.controller.grantedCount === 2 && rig.controller.deniedCount === 1);
  check('the exit button never becomes the last decision', rig.controller.lastDecision === 'granted' && rig.controller.lastReason === 'authorised');
}

// 6. The exit button opens in every mode and the door commands follow the sketch
{
  resetState();
  const rig = makeRig({ cards: [{ value: '77881' }] });
  rig.controller.applyDoorCommand(3);                       // remain open
  checkEq('remain-open holds the relay on', rig.controller.doorMode, 'remain_open');
  rig.controller.handleCard('77881', rig.controller.nowMs());
  const writesWhileOpen = rig.gpio.writes.length;
  rig.gpio.emit({ line: 'exit', edge: 'falling', t: rig.controller.nowMs() + 1000 });
  checkEq('the exit button records an event in remain-open', rig.controller.events.at(-1).type, 'exit');
  check('the exit button does not re-pulse an already-open relay', rig.gpio.writes.length === writesWhileOpen);

  rig.controller.applyDoorCommand(4);                       // remain closed
  checkEq('remain-closed refuses a known card', rig.controller.decideCard('77881', rig.clock.nowSeconds()).reason, 'door_remain_closed');
  rig.advance(5000);
  rig.controller.handleCard('77881', rig.controller.nowMs());
  checkEq('a refused card still produces an event', rig.controller.events.at(-1).reason, 'door_remain_closed');
  rig.gpio.emit({ line: 'exit', edge: 'falling', t: rig.controller.nowMs() + 2000 });
  check('the exit button opens the door even in remain-closed', rig.controller.events.at(-1).reason === 'exit_button');

  check('a second exit press inside the debounce window is ignored', (() => {
    const before = rig.controller.events.length;
    rig.gpio.emit({ line: 'exit', edge: 'falling', t: rig.controller.nowMs() + 2010 });
    return rig.controller.events.length === before;
  })());

  rig.controller.applyDoorCommand(5);                       // resume
  checkEq('resume returns to normal mode', rig.controller.doorMode, 'normal');
  rig.controller.applyDoorCommand(1);                       // momentary open
  check('remote_open pulses the relay', rig.gpio.writes.at(-1).value === true);
  rig.controller.service(rig.controller.nowMs() + DEFAULT_CONFIG.timings.doorOpenMs + 1);
  check('the relay closes after the pulse', rig.gpio.writes.at(-1).value === false);
}

// 7. Visitor PINs: lockout, expiry, revoke, and what the operations carry
{
  resetState();
  const rig = makeRig();
  const valid = { validFrom: '2026-10-10T07:00:00Z', validUntil: '2026-10-10T09:00:00Z' };
  checkEq('a visitor operation is applied', rig.controller.visitors.upsert('visitorV1', '482913', Date.parse(valid.validFrom) / 1000, Date.parse(valid.validUntil) / 1000), null);
  check('a five-digit PIN is accepted', rig.controller.decidePin('482913').granted === true);
  check('a PIN outside its window is refused as expired', rig.controller.visitors.upsert('visitorV2', '111111', 0, Math.floor(Date.parse('2026-10-10T08:00:00Z') / 1000)) === null && rig.controller.decidePin('111111').reason === 'credential_expired');
  checkEq('an over-long PIN is refused before the store is touched', rig.controller.visitors.upsert('visitorV3', '123456789', 0, 1), 'visitor PIN must be 4 to 8 digits');
  checkEq('a non-numeric visitor identity is refused', rig.controller.visitors.upsert('visitor-V-4', '1234', 0, 1), 'operation has no valid visitor employee number');

  keysToPin(rig, '000000');
  for (let i = 0; i < 5; i += 1) keysToPin(rig, '999999');
  check('five wrong PINs lock the keypad', rig.controller.pinLockedUntil !== null);
  const before = rig.controller.events.length;
  keysToPin(rig, '482913');
  check('a locked keypad refuses even the right PIN', rig.controller.events.length === before + 1 && rig.controller.events.at(-1).reason === 'too_many_attempts');
  rig.advance(61 * 1000);
  rig.controller.handlePin('482913', rig.controller.nowMs());
  check('the keypad unlocks after the lockout window', rig.controller.events.at(-1).granted === true);

  rig.controller.visitors.revoke('visitorV1');
  rig.controller.handlePin('482913', rig.controller.nowMs() + 2000);
  check('a revoked visitor PIN is refused', rig.controller.events.at(-1).reason === 'unknown_credential');
}

// 8. Operations: doors, visitors, cards, and the two failures the sketch names
{
  resetState();
  const quiet = { error() {}, warn() {}, info() {}, debug() {} };
  const rig = makeRig({ cards: [{ value: '77881' }] });
  state.operations = [
    { id: 'op-open', kind: 'door', operation: 'remote_open', deviceId: 'device-gate-test', payload: { doorNo: 1 } },
    { id: 'op-door2', kind: 'door', operation: 'remote_open', deviceId: 'device-gate-test', payload: { doorNo: 2 } },
    { id: 'op-other', kind: 'door', operation: 'remote_open', deviceId: 'device-other', payload: { doorNo: 1 } },
    { id: 'op-visitor', kind: 'visitor', operation: 'upsert_visitor', deviceId: 'device-gate-test', payload: { employeeNo: 'visitorV9', pin: '4567', validFrom: '2026-10-10T00:00:00Z', validUntil: '2026-10-11T00:00:00Z' } },
    { id: 'op-card', kind: 'card', operation: 'upsert_card', deviceId: 'device-gate-test', payload: {} },
    { id: 'op-finger', kind: 'fingerprint', operation: 'upload_fingerprint', deviceId: 'device-gate-test', payload: {} },
    { id: 'op-person', kind: 'person', operation: 'upsert_person', deviceId: 'device-gate-test', payload: {} },
  ];
  const runner = createGateController(rig.config, { gpio: rig.gpio, api: rig.api, clock: rig.clock, log: quiet });
  await runner.pollOperations();

  const results = new Map(state.seen.results.map((entry) => [entry.id, entry.body]));
  check('the poll asked the Worker for a batch of operations', state.seen.operationsPolls >= 1);
  checkEq('a door command for this door is applied', results.get('op-open')?.status, 'applied');
  check('the applied door command opened the relay', runner.controller.relayOn === true);
  check('a door command for another door is refused with the sketch\'s wording', /door 2 is not wired/.test(String(results.get('op-door2')?.errorMessage)));
  check('an operation for another terminal is refused with the one-terminal message', /serves one terminal only/.test(String(results.get('op-other')?.errorMessage)));
  checkEq('a visitor pass is applied', results.get('op-visitor')?.status, 'applied');
  check('the visitor PIN reached the store', runner.controller.visitors.matchPin('4567', rig.clock.nowSeconds()).employeeNo === 'visitorV9');
  checkEq('a card operation is applied by refreshing the snapshot', results.get('op-card')?.status, 'applied');
  check('fingerprint work is refused, never silently dropped', /no person or fingerprint store/.test(String(results.get('op-finger')?.errorMessage)));
  check('person work is refused too', /no person or fingerprint store/.test(String(results.get('op-person')?.errorMessage)));
  check('every result carried a duration', state.seen.results.every((entry) => typeof entry.body.durationMs === 'number'));
}

// 9. Heartbeat shape, and the events batch that follows it
{
  resetState();
  const rig = makeRig({ cards: [{ value: '77881' }] });
  // The runner owns the timers, the event queue and the operations poll; the
  // fake backend is pointed at its controller, as createGateController does.
  const quiet = { error() {}, warn() {}, info() {}, debug() {} };
  const runner = createGateController(rig.config, { gpio: rig.gpio, api: rig.api, clock: rig.clock, log: quiet });
  rig.gpio.onEvent = (event) => runner.controller.handleGpioEvent(event);
  const live = { ...rig, controller: runner.controller };
  state.cards = [{ value: '77881', validUntil: null }];
  await live.controller.syncSnapshot(rig.api);
  tapCard(live, 77881);
  const body = live.controller.heartbeatBody({ hostname: 'estatemate-gate-abc123', ip: '192.168.1.5' });
  await rig.api.heartbeat(body);
  checkEq('the heartbeat announces the Pi gate controller version', body.version, 'pi-gate-1.0.0');
  check('the heartbeat advertises no person or fingerprint work', Array.isArray(body.capabilities) && body.capabilities.length === 0);
  check('the heartbeat reports the one terminal as up', body.devices[0].deviceId === 'device-gate-test' && body.devices[0].stream === 'up');
  check('the heartbeat carries the snapshot health in the sketch\'s shape', body.remoteVerify.cache.credentialCount === 1 && body.remoteVerify.cache.ready === true);
  checkEq('the heartbeat marks the controller as a Pi gate', body.remoteVerify.controller, 'pi-gate');
  check('the heartbeat carries this terminal\'s last decision', body.remoteVerify.perDevice['device-gate-test'].lastDecision === 'granted');
  checkEq('the heartbeat reports the door mode', body.remoteVerify.perDevice['device-gate-test'].doorMode, 'normal');

  await runner.flushEvents();
  const item = state.seen.events.at(-1);
  check('the uploaded event carries the document', JSON.parse(item.document).AccessControllerEvent.cardNo === '77881');
  check('the uploaded event carries the verdict', item.remoteVerification.decision === 'granted' && item.remoteVerification.doorResult === 'opened');
  check('the queue is empty once the batch was accepted', live.controller.events.length === 0);

  state.eventsStatus = 503;
  live.advance(10_000);
  tapCard(live, 77881);
  await runner.flushEvents();
  check('an event the Worker cannot take is kept for retry', live.controller.events.length === 1);
  state.eventsStatus = 200;
  await runner.flushEvents();
  check('the retry clears the queue', live.controller.events.length === 0);
  state.eventsStatus = 409;
  live.advance(10_000);
  tapCard(live, 77881);
  await runner.flushEvents();
  check('an event stream switched off server-side is dropped, not retried forever', live.controller.events.length === 0);
  state.eventsStatus = 200;
}

// 10. The event ring drops the oldest and counts them
{
  resetState();
  const rig = makeRig({ cards: [{ value: '77881' }] });
  for (let i = 0; i < 70; i += 1) rig.controller.handleCard('77881', rig.controller.nowMs() + i * 10_000);
  check('the ring keeps the newest 64 events', rig.controller.events.length === 64);
  checkEq('the dropped ones are counted', rig.controller.eventsDropped, 6);
  check('the batch is twenty events at a time', rig.controller.takeEventBatch().length === 20);
}

// 11. Persistence: the snapshot, visitors and door mode survive a restart
{
  resetState();
  const rig = makeRig();
  state.cards = [{ value: '0000077881', validUntil: null }, { value: '2222', validUntil: null }];
  await rig.controller.syncSnapshot(rig.api);
  rig.controller.visitors.upsert('visitorV1', '482913', 0, Math.floor(Date.parse('2026-10-11T00:00:00Z') / 1000));
  rig.controller.visitors.save(join(dir, 'visitors.json'));
  rig.controller.applyDoorCommand(3);

  const restarted = createGateController(rig.config, { gpio: new FakeBackend({ config: rig.config.gpio, onEvent: () => {}, log: { error() {}, warn() {}, info() {}, debug() {} } }), clock: rig.clock, log: { error() {}, warn() {}, info() {}, debug() {} } });
  check('the card cache comes back warm from disk', restarted.controller.cache.ready === true && restarted.controller.cache.count === 2);
  check('a warm cache decides without a fresh sync', restarted.controller.decideCard('77881', rig.clock.nowSeconds()).granted === true);
  check('the visitor PINs come back', restarted.controller.visitors.count === 1);
  restarted.start({ immediate: false });
  checkEq('the door mode comes back', restarted.controller.doorMode, 'remain_open');
  restarted.stop();
}

// 12. Configuration files: usable, and the portal's explanation file is refused
{
  const good = JSON.stringify({
    workerUrl: 'https://estatemate.example',
    agentId: 'agent-1',
    agentSecret: 'secret',
    deviceId: 'device-1',
    gpio: { backend: 'fake' },
  });
  const loaded = loadConfig(good);
  check('a complete config loads with defaults filled in', loaded.error === null && loaded.config.doorNo === 1 && loaded.config.timings.doorOpenMs === 3000);
  checkEq('a complete config has no problems', validateConfig(loaded.config).length, 0);
  const bad = loadConfig(JSON.stringify({ error: 'No terminal is connected to this Raspberry Pi gate controller yet.' }));
  check('the portal\'s explanation file is reported as an error', bad.error !== null && bad.config === null);
  const configWithPins = loadConfig(JSON.stringify({
    workerUrl: 'https://estatemate.example', agentId: 'a', agentSecret: 's', deviceId: 'd',
    gpio: { backend: 'libgpiod', wiegandD0: 5 },
  })).config;
  check('a config file can move a single pin without losing the others', configWithPins.gpio.wiegandD0 === 5 && configWithPins.gpio.wiegandD1 === 18);
}

// 13. A child process runs the real thing: script -> decision -> event -> Worker
{
  resetState();
  const runDir = freshDir();
  state.cards = [{ value: '77881', validUntil: null }];
  const script = [];
  // A cold controller denies everything by design, so the swipe waits for the
  // first snapshot (a second or so on a real Pi) before the reader is tapped.
  let at = 2000;
  const bits = wiegandFrame(77881, 26);
  for (let i = 0; i < 26; i += 1) {
    const bit = (bits >> BigInt(25 - i)) & 1n;
    script.push({ line: bit ? 'd1' : 'd0', edge: 'falling', t: at });
    at += 2;
  }
  const scriptPath = join(runDir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ speed: 1, events: script }));
  const writeLog = join(runDir, 'writes.jsonl');
  const configPath = join(runDir, 'estatemate-gate.json');
  writeFileSync(configPath, JSON.stringify({
    workerUrl,
    agentId: 'agent-pi-gate-test',
    agentSecret: 'host-test-secret',
    deviceId: 'device-gate-test',
    stateDir: runDir,
    logLevel: 'info',
    gpio: { backend: 'fake', script: scriptPath, writeLog },
  }));
  const child = spawn(process.execPath, [programPath, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !state.seen.events.some((item) => item.remoteVerification?.decision === 'granted' && JSON.parse(item.document).AccessControllerEvent?.cardNo === '77881')) {
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill('SIGTERM');
  await new Promise((done) => child.on('exit', done));
  const granted = state.seen.events.find((item) => JSON.parse(item.document).AccessControllerEvent?.cardNo === '77881');
  check('the real program heartbeats on its own', state.seen.heartbeats.length >= 1);
  check('the real program syncs the credential snapshot on its own', state.seen.snapshotRequests.length >= 1);
  check('the real program reads the scripted reader, decides and reports the card', Boolean(granted), output.slice(-400));
  check('the reported decision is the cached snapshot\'s', granted?.remoteVerification?.decision === 'granted');
  const writes = readFileSync(writeLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  check('the relay was driven by the decision', writes.some((write) => write.role === 'relay' && write.value === true));
  check('the state directory was written', (() => { try { return readFileSync(join(runDir, 'snapshot.json'), 'utf8').includes('77881'); } catch { return false; } })());
}

// 14. The systemd unit the program installs names the program and the config
{
  const unit = renderSystemdUnit({ node: '/usr/bin/node', program: '/opt/estatemate/pi-gate/EstateMateGate.mjs', config: '/etc/estatemate/pi-gate.json' });
  check('the unit starts the program with its config', unit.includes('ExecStart=/usr/bin/node /opt/estatemate/pi-gate/EstateMateGate.mjs --config /etc/estatemate/pi-gate.json'));
  check('the unit restarts on failure and starts on boot', unit.includes('Restart=always') && unit.includes('WantedBy=multi-user.target'));
}

server.close();
console.log('');
if (failures) {
  console.error(`${checks - failures}/${checks} Pi gate host checks passed`);
  process.exit(1);
}
console.log(`${checks}/${checks} Pi gate host checks passed`);
