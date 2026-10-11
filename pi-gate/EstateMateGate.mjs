#!/usr/bin/env node
/**
 * EstateMate Raspberry Pi gate controller
 * =======================================
 *
 * A Raspberry Pi that *is* the gate: it reads a Wiegand card reader / keypad,
 * decides against a local copy of the estate's credentials, drives the door
 * relay, and reports every decision to EstateMate. It signs in as a dedicated
 * EstateMate device agent, so it speaks the same agent protocol as the Windows,
 * Linux, Android and ESP32 agents:
 *
 *   POST /api/isapi/v1/agents/<agent>/heartbeat            presence + snapshot health
 *   GET  /api/isapi/v1/agents/<agent>/credential-snapshot  the estate's active cards
 *   GET  /api/isapi/v1/agents/<agent>/operations           door commands, visitor PINs
 *   POST /api/isapi/v1/agents/<agent>/operations/<id>/result
 *   POST /api/isapi/v1/agents/<agent>/events               gate history
 *
 * It never contacts a Hikvision terminal: the terminal record it reports for in
 * the portal exists only to give the gate an EstateMate device ID, and its LAN
 * address is never dialled.
 *
 * This is the Raspberry Pi twin of `esp32-gate/EstateMateGate/EstateMateGate.ino`.
 * The behaviour is deliberately identical - the same Wiegand decoding, the same
 * fail-closed decisions against the same cached snapshot, the same door modes,
 * the same event documents (byte for byte: `pi-gate/host-test/` builds them from
 * the ESP32's own fixtures), the same operations protocol and the same
 * intervals. The differences are the ones the hardware forces: GPIO goes through
 * the libgpiod tools instead of `digitalWrite`, the wall clock is the Pi's own
 * NTP-synchronised system time instead of `configTime`, and the optional
 * non-decision state (card cache, visitor PINs, door mode) is a file on disk
 * instead of LittleFS and Preferences.
 *
 * Rules this file keeps (see `pi-gate/README.md`):
 *   - Decisions are made against the cached snapshot, never a live query, so
 *     the gate keeps working when the estate's internet does not.
 *   - A cold cache denies every card until the first snapshot arrives.
 *   - A failed refresh keeps the previous snapshot, page for page.
 *   - The exit button opens the door in every mode.
 *   - The typed PIN never leaves the controller; events name the visitor's
 *     employee number only.
 *   - Person and fingerprint work is not advertised and is never pretended: it
 *     is answered with a clear failure.
 *
 * Dependency-free: Node 22+, no npm packages. Real GPIO needs the `gpiomon` and
 * `gpioset` command-line tools (the `gpiod` package); `gpio.backend: "fake"`
 * runs the whole gate with no hardware at all, which is what the host tests and
 * `--check` use.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_VERSION = '1.0.0';
export const SERVICE_NAME = 'estatemate-pi-gate';
export const DEFAULT_CONFIG_PATH = '/etc/estatemate/pi-gate.json';
export const DEFAULT_PROGRAM_PATH = '/opt/estatemate/pi-gate/EstateMateGate.mjs';
export const DEFAULT_STATE_DIR = '/var/lib/estatemate-pi-gate';

/** The defaults the config file may override. They mirror the sketch's #defines. */
export const DEFAULT_CONFIG = {
  workerUrl: '',
  agentId: '',
  agentSecret: '',
  deviceId: '',
  doorNo: 1,
  label: 'Raspberry Pi gate controller',
  stateDir: DEFAULT_STATE_DIR,
  logLevel: 'info',
  maxCards: 100000,
  maxVisitors: 200,
  timings: {
    doorOpenMs: 3000,
    cardCooldownMs: 1500,
    frameGapMs: 25,
    heartbeatSeconds: 60,
    snapshotSeconds: 120,
    snapshotRetrySeconds: 30,
    operationsSeconds: 10,
    serviceIntervalMs: 50,
    tickIntervalMs: 250,
    pinTimeoutMs: 15000,
    pinMaxAttempts: 5,
    pinAttemptWindowMs: 60000,
    pinLockoutMs: 60000,
    exitDebounceMs: 50,
    apiTimeoutMs: 15000,
  },
  gpio: {
    // 'libgpiod' drives real hardware; 'fake' replays a script and records
    // writes, for dry runs and tests.
    backend: 'libgpiod',
    chip: 'gpiochip0',
    gpiodVersion: 'auto',
    wiegandD0: 17,
    wiegandD1: 18,
    relay: 25,
    relayActiveHigh: true,
    exitButton: 27,
    exitButtonPullUp: true,
    readerLed: null,
    readerBuzzer: null,
    readerActiveHigh: false,
    script: null,
    writeLog: null,
    scriptSpeed: 1,
  },
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info', sink = console) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const write = (name, args) => {
    if ((LOG_LEVELS[name] ?? 9) > threshold) return;
    const line = `[${new Date().toISOString()}] [${name.toUpperCase()}]`;
    if (name === 'error') sink.error(line, ...args); else sink.log(line, ...args);
  };
  return {
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
  };
}

// ---------------------------------------------------------------------------
// Time helpers (mirrors the sketch's parseTimestamp/formatTimestamp)
// ---------------------------------------------------------------------------

/** Unix seconds for a "YYYY-MM-DD", ISO 8601 or D1 "YYYY-MM-DD HH:MM:SS" text. 0 when unreadable. */
export function parseTimestamp(value) {
  const text = String(value ?? '').trim();
  if (text.length < 10 || text[4] !== '-' || text[7] !== '-') return 0;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (![year, month, day].every(Number.isInteger)) return 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return 0;
  let hour = 0, minute = 0, second = 0, rest = text.slice(10);
  if (rest.startsWith('T') || rest.startsWith(' ')) {
    if (!/^\d{2}:\d{2}:\d{2}/.test(rest.slice(1))) return 0;
    hour = Number(rest.slice(1, 3));
    minute = Number(rest.slice(4, 6));
    second = Number(rest.slice(7, 9));
    rest = rest.slice(10).replace(/^\.\d*/, '');
  }
  let offsetSeconds = 0;
  const offset = /^([+-])(\d{2}):?(\d{2})/.exec(rest);
  if (offset) offsetSeconds = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3]) * 60);
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000) - offsetSeconds;
}

/** "YYYY-MM-DDTHH:MM:SSZ" (iso) or D1's "YYYY-MM-DD HH:MM:SS". */
export function formatTimestamp(seconds, iso = true) {
  const text = new Date(Math.max(0, Math.floor(seconds)) * 1000).toISOString();
  return iso ? `${text.slice(0, 19)}Z` : text.slice(0, 19).replace('T', ' ');
}

/** The sketch refuses to trust a clock before 2023-11-14; a Pi without NTP is the same problem. */
export function timeKnown(seconds) {
  return Number(seconds) > 1700000000;
}

/**
 * The Pi's wall clock, with an offset that can be adopted from the portal's
 * `serverTime` when the Pi has not got a clock yet (no RTC, no network time: it
 * wakes up in 1970). The offset is never invented - it is only taken from the
 * Worker, and only while the local clock is unusable, exactly like the sketch's
 * `adoptServerTime`.
 */
export function createClock({ nowMs = () => Date.now() } = {}) {
  let offsetSeconds = 0;
  const self = {
    nowMs,
    nowSeconds: () => Math.floor(nowMs() / 1000) + offsetSeconds,
    adopt(serverTime, localSeconds = Math.floor(nowMs() / 1000)) {
      if (timeKnown(self.nowSeconds())) return false;
      const parsed = parseTimestamp(serverTime);
      if (!parsed) return false;
      offsetSeconds = parsed - localSeconds;
      return true;
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// Card numbers
// ---------------------------------------------------------------------------

/**
 * A card number as the cache files it: digits keep their value but lose leading
 * zeroes, because a Wiegand reader reports 1234 for a card the portal stores as
 * 0000001234. Anything that is not all digits is kept (upper-cased) and simply
 * never matches a reader. This is `cardKey()` from the sketch without the hash:
 * the Pi has the memory to keep the number itself, which makes the gate state
 * inspectable.
 */
export function cardNumberKey(value) {
  let text = String(value ?? '');
  while (text.startsWith(' ')) text = text.slice(1);
  const head = text.split(' ')[0] ?? '';
  if (head && /^[0-9]+$/.test(head)) return head.replace(/^0+(?=[0-9])/, '');
  return text.replace(/ +$/, '').toUpperCase();
}

/** A terminal identity that can be used on the wire (letters and digits, 1-32). */
export function validEmployeeNo(value) {
  const text = String(value ?? '');
  return text.length >= 1 && text.length <= 32 && /^[A-Za-z0-9]+$/.test(text);
}

// ---------------------------------------------------------------------------
// Wiegand
// ---------------------------------------------------------------------------

function popcount(value) {
  let n = 0;
  let rest = value;
  while (rest) { n += Number(rest & 1n); rest >>= 1n; }
  return n;
}

/**
 * Decodes one complete frame, most significant (first received) bit first.
 *   4 bits  keypad key (burst mode)
 *   8 bits  keypad key + its complement
 *   26..64  card: leading even parity, data, trailing odd parity
 */
export function decodeWiegand(bits, count) {
  if (count === 4) return { kind: 'key', bits: count, key: Number(bits & 15n) };
  if (count === 8) {
    const low = Number(bits & 15n);
    const high = Number((bits >> 4n) & 15n);
    if ((high ^ 0x0f) !== low) return { kind: 'error', bits: count, error: '8-bit key failed its complement check' };
    return { kind: 'key', bits: count, key: low };
  }
  if (count < 26 || count > 64) return { kind: 'error', bits: count, error: `unsupported ${count}-bit frame` };
  const dataBits = count - 2;
  if (count === 26 || count === 34) {
    const half = dataBits / 2;
    const firstMask = ((1n << BigInt(half + 1)) - 1n) << BigInt(count - half - 1);
    const secondMask = (1n << BigInt(half + 1)) - 1n;
    if ((popcount(bits & firstMask) % 2) !== 0 || (popcount(bits & secondMask) % 2) !== 1) {
      return { kind: 'error', bits: count, error: `${count}-bit card failed its parity check` };
    }
  }
  const data = (bits >> 1n) & ((1n << BigInt(dataBits)) - 1n);
  return { kind: 'card', bits: count, card: data.toString() };
}

/**
 * Collects falling edges from the D0/D1 lines into frames.
 *
 * The sketch assembles a frame in an interrupt handler and closes it once the
 * lines have been quiet for `gapMs`. Here the edges arrive from the kernel
 * (libgpiod) or a script (the fake backend) with their own timestamps, so the
 * same rule is applied to those timestamps: a frame is complete when the next
 * edge is more than `gapMs` later, or when `poll()` is called and the lines
 * have been quiet that long. Timestamps are milliseconds on any monotonic
 * basis; only the gaps between them matter.
 */
export class WiegandReader {
  constructor({ gapMs = 25, onFrame = () => {} } = {}) {
    this.gapMs = gapMs;
    this.onFrame = onFrame;
    this.bits = 0n;
    this.count = 0;
    this.lastAt = null;
  }

  /** One pulse: `line` is 'd0' or 'd1'. */
  push(line, atMs) {
    if (this.count && this.lastAt !== null && atMs - this.lastAt > this.gapMs) this.poll(atMs);
    if (this.count < 64) this.bits = (this.bits << 1n) | (line === 'd1' ? 1n : 0n);
    if (this.count < 255) this.count += 1;
    this.lastAt = atMs;
  }

  /** Closes the frame when the lines have been quiet long enough. */
  poll(atMs) {
    if (!this.count || this.lastAt === null || atMs - this.lastAt <= this.gapMs) return null;
    const frame = decodeWiegand(this.bits, this.count);
    this.bits = 0n;
    this.count = 0;
    this.lastAt = null;
    this.onFrame(frame);
    return frame;
  }
}

// ---------------------------------------------------------------------------
// Credential cache (cards)
// ---------------------------------------------------------------------------

/**
 * Every card the estate has authorised, held in memory on the Pi.
 *
 * The set is loaded from disk at startup, so a warm gate works offline straight
 * away; a controller that has never loaded a snapshot is *not ready* and denies
 * every card rather than deciding from nothing. A full snapshot replaces the
 * set in one step and a delta applies removals before additions, both only once
 * every page of the response has arrived - a failed refresh leaves the previous
 * snapshot exactly as it was.
 */
export class CredentialCache {
  constructor({ capacity = DEFAULT_CONFIG.maxCards } = {}) {
    this.capacity = Math.max(1, capacity);
    this.cards = new Map();         // normalised card number -> { validUntil: seconds|0 }
    this.ready = false;
    this.since = '';                // "YYYY-MM-DD HH:MM:SS" the next delta asks from
    this.version = null;
    this.lastSyncAt = null;         // unix seconds of the last successful refresh in this boot
    this.lastSyncLatencyMs = null;
    this.lastSyncError = null;
    this.syncCount = 0;
    this.removedApplied = 0;
  }

  get count() {
    return this.cards.size;
  }

  lookup(cardNo) {
    const key = cardNumberKey(cardNo);
    if (!key) return null;
    const entry = this.cards.get(key);
    return entry ? { cardNo: key, validUntil: entry.validUntil } : null;
  }

  /** Replaces the whole set from a complete snapshot. Refuses an oversized one. */
  replaceAll(items) {
    if (items.length > this.capacity) {
      return { ok: false, error: `estate has ${items.length} cards but this controller holds ${this.capacity}; raise maxCards` };
    }
    const next = new Map();
    let dropped = 0;
    for (const item of items) {
      const key = cardNumberKey(item.value);
      if (!key) continue;
      const validUntil = Number(item.validUntil) > 0 ? Math.floor(Number(item.validUntil)) : 0;
      const existing = next.get(key);
      if (existing) {
        existing.validUntil = existing.validUntil === 0 || validUntil === 0 ? 0 : Math.max(existing.validUntil, validUntil);
        continue;
      }
      if (next.size >= this.capacity) { dropped += 1; continue; }
      next.set(key, { validUntil });
    }
    this.cards = next;
    return { ok: true, changed: next.size, dropped };
  }

  /** Applies one complete delta: removals first, then additions. */
  applyDelta(removes, adds) {
    let changed = 0;
    for (const value of removes) {
      const key = cardNumberKey(value);
      if (key && this.cards.delete(key)) { changed += 1; this.removedApplied += 1; }
    }
    let dropped = 0;
    for (const item of adds) {
      const key = cardNumberKey(item.value);
      if (!key) continue;
      const validUntil = Number(item.validUntil) > 0 ? Math.floor(Number(item.validUntil)) : 0;
      const existing = this.cards.get(key);
      if (existing) {
        const merged = existing.validUntil === 0 || validUntil === 0 ? 0 : Math.max(existing.validUntil, validUntil);
        if (merged !== existing.validUntil) { existing.validUntil = merged; changed += 1; }
        continue;
      }
      if (this.cards.size >= this.capacity) { dropped += 1; continue; }
      this.cards.set(key, { validUntil });
      changed += 1;
    }
    return { changed, dropped };
  }

  /** Seconds since the snapshot was last refreshed in this boot, or null. */
  ageSeconds(nowSeconds = 0) {
    if (this.lastSyncAt === null || !timeKnown(nowSeconds)) return null;
    return Math.max(0, nowSeconds - this.lastSyncAt);
  }

  /** The status block the heartbeat carries, the same shape as the sketch's. */
  stats(nowSeconds = 0) {
    return {
      credentialCount: this.count,
      capacity: this.capacity,
      ready: this.ready,
      syncCount: this.syncCount,
      removedApplied: this.removedApplied,
      lastSyncLatencyMs: this.lastSyncLatencyMs,
      lastSyncAt: this.lastSyncAt ? formatTimestamp(this.lastSyncAt, true) : null,
      cacheAgeSeconds: this.ageSeconds(nowSeconds),
      lastSyncError: this.lastSyncError || null,
    };
  }

  /** The on-disk form. Written atomically so a power cut cannot leave half a file. */
  save(path) {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      since: this.since,
      cards: [...this.cards.entries()].map(([cardNo, entry]) => [cardNo, entry.validUntil]),
    };
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, path);
      return true;
    } catch (error) {
      this.lastSyncError = `cannot write the snapshot to disk: ${error.message}`;
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
      return false;
    }
  }

  load(path) {
    if (!existsSync(path)) return false;
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      if (!payload || payload.version !== 1 || !Array.isArray(payload.cards)) return false;
      const next = new Map();
      for (const [cardNo, validUntil] of payload.cards) {
        const key = cardNumberKey(cardNo);
        if (!key) continue;
        next.set(key, { validUntil: Number(validUntil) > 0 ? Math.floor(Number(validUntil)) : 0 });
      }
      this.cards = next;
      this.since = typeof payload.since === 'string' ? payload.since : '';
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Visitor PINs
// ---------------------------------------------------------------------------

/**
 * Visitor passes as they reach a gate: employee number, PIN and the window the
 * PIN is valid in. The typed PIN never leaves this process - it is compared
 * here and the event carries the employee number only.
 */
export class VisitorStore {
  constructor({ maxVisitors = DEFAULT_CONFIG.maxVisitors, nowSeconds = () => 0 } = {}) {
    this.maxVisitors = maxVisitors;
    this.nowSeconds = nowSeconds;
    this.visitors = new Map();
  }

  get count() {
    return this.visitors.size;
  }

  /** Drops passes that ended more than a day ago, so a missed revoke cannot fill the store. */
  prune() {
    const now = this.nowSeconds();
    if (!now) return;
    for (const [employeeNo, visitor] of this.visitors) {
      if (visitor.validUntil && visitor.validUntil < now - 86400) this.visitors.delete(employeeNo);
    }
  }

  /** Returns null on success, or the reason the operation could not be applied. */
  upsert(employeeNo, pin, validFrom, validUntil) {
    if (!validEmployeeNo(employeeNo)) return 'operation has no valid visitor employee number';
    const text = String(pin ?? '');
    if (text.length < 4 || text.length > 8) return 'visitor PIN must be 4 to 8 digits';
    if (!/^[0-9]+$/.test(text)) return 'visitor PIN must be digits only';
    if (!Number(validUntil)) return 'visitor pass has no readable validUntil';
    this.prune();
    const existing = this.visitors.get(employeeNo);
    if (existing) {
      existing.pin = text;
      existing.validFrom = Number(validFrom) || 0;
      existing.validUntil = Number(validUntil);
      return null;
    }
    if (this.visitors.size >= this.maxVisitors) return "this controller's visitor store is full";
    this.visitors.set(employeeNo, { pin: text, validFrom: Number(validFrom) || 0, validUntil: Number(validUntil) });
    return null;
  }

  revoke(employeeNo) {
    this.visitors.delete(String(employeeNo));
  }

  /** The visitor whose PIN matches, and why it was refused otherwise. */
  matchPin(pin, now) {
    let reason = 'unknown_credential';
    let lastRefused = null;
    for (const [employeeNo, visitor] of this.visitors) {
      if (visitor.pin !== pin) continue;
      if (visitor.validFrom && now < visitor.validFrom) { reason = 'credential_not_yet_valid'; lastRefused = employeeNo; continue; }
      if (now >= visitor.validUntil) { reason = 'credential_expired'; lastRefused = employeeNo; continue; }
      return { employeeNo, reason: 'authorised' };
    }
    return { employeeNo: lastRefused, reason };
  }

  save(path) {
    const payload = { version: 1, visitors: [...this.visitors.entries()].map(([employeeNo, v]) => [employeeNo, v.pin, v.validFrom, v.validUntil]) };
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, path);
      return true;
    } catch {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
      return false;
    }
  }

  load(path) {
    if (!existsSync(path)) return false;
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      if (!payload || payload.version !== 1 || !Array.isArray(payload.visitors)) return false;
      this.visitors = new Map();
      for (const [employeeNo, pin, validFrom, validUntil] of payload.visitors) {
        if (!validEmployeeNo(employeeNo) || !pin) continue;
        this.visitors.set(String(employeeNo), { pin: String(pin), validFrom: Number(validFrom) || 0, validUntil: Number(validUntil) || 0 });
      }
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Door
// ---------------------------------------------------------------------------

export const DOOR_NORMAL = 'normal';
export const DOOR_ALWAYS_OPEN = 'remain_open';
export const DOOR_ALWAYS_CLOSED = 'remain_closed';

export const DOOR_COMMANDS = {
  remote_open: 1,
  remote_close: 2,
  remote_always_open: 3,
  remote_always_close: 4,
  remote_resume: 5,
};

const EVENT_RING_SIZE = 64;
const EVENT_BATCH_SIZE = 20;
const SNAPSHOT_PAGE = 250;
const SNAPSHOT_OVERLAP_SECONDS = 120;
const DELTA_MAX = 20000;

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

/**
 * The controller: reader in, relay out, and the state the heartbeat reports.
 *
 * Everything is driven by explicit timestamps (`clock.nowMs()` for the gate's
 * own clock, `clock.nowSeconds()` for the wall clock the decisions need), so
 * the whole state machine is exercised on a host with no hardware - the same
 * reason the sketch's host test compiles the real sketch against stand-ins.
 */
export class GateController {
  constructor({ config, io, clock, log, onDecision = () => {} }) {
    this.config = config;
    this.io = io;
    this.clock = clock;
    this.log = log;
    this.onDecision = onDecision;
    this.label = config.label || DEFAULT_CONFIG.label;
    this.doorNo = Number(config.doorNo) || 1;
    this.timings = { ...DEFAULT_CONFIG.timings, ...config.timings };
    this.bootId = '00000000';

    this.cache = new CredentialCache({ capacity: Number(config.maxCards) || DEFAULT_CONFIG.maxCards });
    this.visitors = new VisitorStore({ maxVisitors: Number(config.maxVisitors) || DEFAULT_CONFIG.maxVisitors, nowSeconds: () => this.clock.nowSeconds() });
    this.reader = new WiegandReader({ gapMs: this.timings.frameGapMs, onFrame: (frame) => this.handleFrame(frame, this.nowMs()) });

    this.doorMode = DOOR_NORMAL;
    this.relayOffAt = null;
    this.relayOn = false;

    this.events = [];
    this.eventSeq = 0;
    this.eventsDropped = 0;
    this.grantedCount = 0;
    this.deniedCount = 0;
    this.lastDecision = null;
    this.lastReason = null;
    this.lastResult = null;

    this.pinBuffer = '';
    this.pinLastKeyAt = null;
    this.pinFailures = 0;
    this.pinFailureWindowStart = 0;
    this.pinLockedUntil = null;

    this.lastCardKey = null;
    this.lastCardAt = null;
    this.lastExitAt = null;

    // Reader feedback (optional lines; both off by default)
    this.ledOffAt = null;
    this.beepsLeft = 0;
    this.beepNextAt = null;
    this.beepOn = false;
  }

  nowMs() {
    return this.clock.nowMs();
  }

  // ---- GPIO events ---------------------------------------------------------

  /** One edge from the reader or the exit button. */
  handleGpioEvent(event) {
    const at = Number(event.t) || 0;
    if (event.line === 'd0' || event.line === 'd1') this.reader.push(event.line, at);
    else if (event.line === 'exit' && event.edge === 'falling') this.pressExit(at);
  }

  handleFrame(frame, atMs) {
    if (frame.kind === 'card') {
      this.log.info(`[reader] ${frame.bits}-bit card ${frame.card}`);
      this.handleCard(frame.card, atMs);
    } else if (frame.kind === 'key') {
      this.handleKey(frame.key, atMs);
    } else {
      this.log.warn(`[reader] ignored: ${frame.error}`);
    }
  }

  // ---- Decisions -----------------------------------------------------------

  decideCard(cardNo, now) {
    if (this.doorMode === DOOR_ALWAYS_CLOSED) return { granted: false, reason: 'door_remain_closed' };
    if (!this.cache.ready) return { granted: false, reason: 'cache_not_ready' };
    const match = this.cache.lookup(cardNo);
    if (!match) return { granted: false, reason: 'unknown_credential' };
    if (match.validUntil) {
      if (!now) return { granted: false, reason: 'clock_not_set' };
      if (match.validUntil <= now) return { granted: false, reason: 'credential_expired' };
    }
    return { granted: true, reason: 'authorised' };
  }

  decidePin(pin) {
    const now = this.clock.nowSeconds();
    if (this.doorMode === DOOR_ALWAYS_CLOSED) return { granted: false, reason: 'door_remain_closed', employeeNo: null };
    if (!now) return { granted: false, reason: 'clock_not_set', employeeNo: null };
    const match = this.visitors.matchPin(pin, now);
    return { granted: match.reason === 'authorised', reason: match.reason, employeeNo: match.employeeNo };
  }

  // ---- Cards, PINs and the exit button ------------------------------------

  handleCard(cardNo, atMs) {
    const key = cardNumberKey(cardNo);
    if (key && key === this.lastCardKey && this.lastCardAt !== null && atMs - this.lastCardAt < this.timings.cardCooldownMs) return;
    this.lastCardKey = key;
    this.lastCardAt = atMs;
    const decision = this.decideCard(cardNo, this.clock.nowSeconds());
    this.log.info(`[gate] card ${cardNo} ${decision.granted ? 'GRANTED' : 'DENIED'} (${decision.reason})`);
    if (decision.granted) {
      if (this.doorMode !== DOOR_ALWAYS_OPEN) this.pulseDoor(atMs);
      this.feedbackGranted(atMs);
    } else {
      this.feedbackDenied(atMs);
    }
    this.recordEvent('card', decision.granted, decision.granted, cardNo, null, decision.reason);
    this.onDecision(cardNo, decision);
  }

  handlePin(pin, atMs) {
    if (this.pinLockedUntil !== null && atMs - this.pinLockedUntil < 0) {
      this.feedbackDenied(atMs);
      this.recordEvent('pin', false, false, null, null, 'too_many_attempts');
      return;
    }
    this.pinLockedUntil = null;
    const decision = this.decidePin(pin);
    this.log.info(`[gate] PIN ${decision.granted ? 'GRANTED' : 'DENIED'} (${decision.reason})`);
    if (decision.granted) {
      this.pinFailures = 0;
      if (this.doorMode !== DOOR_ALWAYS_OPEN) this.pulseDoor(atMs);
      this.feedbackGranted(atMs);
    } else {
      if (!this.pinFailures || atMs - this.pinFailureWindowStart > this.timings.pinAttemptWindowMs) {
        this.pinFailures = 0;
        this.pinFailureWindowStart = atMs;
      }
      this.pinFailures += 1;
      // Five wrong PINs inside a minute lock the keypad for a minute.
      if (this.pinFailures >= this.timings.pinMaxAttempts) {
        this.pinLockedUntil = atMs + this.timings.pinLockoutMs;
        this.pinFailures = 0;
      }
      this.feedbackDenied(atMs);
    }
    this.recordEvent('pin', decision.granted, decision.granted, null, decision.employeeNo, decision.reason);
    this.onDecision(pin, decision);
  }

  /** Keys: 0-9, 10 = '*', 11 = '#'. Nothing is decided until '#' submits. */
  handleKey(key, atMs) {
    if (this.pinBuffer && this.pinLastKeyAt !== null && atMs - this.pinLastKeyAt > this.timings.pinTimeoutMs) this.pinBuffer = '';
    this.pinLastKeyAt = atMs;
    if (key <= 9) {
      if (this.pinBuffer.length < 12) this.pinBuffer += String(key);
    } else if (key === 10) {
      this.pinBuffer = '';
    } else if (key === 11) {
      const pin = this.pinBuffer;
      this.pinBuffer = '';
      if (pin) this.handlePin(pin, atMs);
    }
  }

  /** The exit button opens the door in every mode, for life safety. */
  pressExit(atMs) {
    if (this.lastExitAt !== null && atMs - this.lastExitAt < this.timings.exitDebounceMs) return;
    this.lastExitAt = atMs;
    if (this.doorMode !== DOOR_ALWAYS_OPEN) this.pulseDoor(atMs);
    this.recordEvent('exit', true, true, null, null, 'exit_button');
  }

  // ---- Relay ---------------------------------------------------------------

  writeRelay(on) {
    this.relayOn = Boolean(on);
    this.io.write('relay', this.relayOn);
  }

  pulseDoor(atMs) {
    this.writeRelay(true);
    this.relayOffAt = atMs + this.timings.doorOpenMs;
  }

  setDoorMode(mode, { persist = true } = {}) {
    this.doorMode = mode;
    this.relayOffAt = null;
    this.writeRelay(mode === DOOR_ALWAYS_OPEN);
    if (persist) this.io.persistState?.({ doorMode: mode });
  }

  /** Latch mode from a previous run, without writing the relay twice. */
  restoreDoorMode(mode) {
    if (mode === DOOR_ALWAYS_OPEN || mode === DOOR_ALWAYS_CLOSED) this.setDoorMode(mode, { persist: false });
  }

  applyDoorCommand(command, doorNo) {
    if (doorNo !== undefined && Number(doorNo) !== this.doorNo) return false;
    switch (command) {
      case 1: if (this.doorMode !== DOOR_ALWAYS_OPEN) this.pulseDoor(this.nowMs()); break;
      // CMD_CLOSE drops the relay without touching the mode, exactly as the
      // sketch does: "close now" must not silently resume a held-open door.
      case 2: if (this.doorMode !== DOOR_ALWAYS_OPEN) { this.relayOffAt = null; this.writeRelay(false); } break;
      case 3: this.setDoorMode(DOOR_ALWAYS_OPEN); break;
      case 4: this.setDoorMode(DOOR_ALWAYS_CLOSED); break;
      case 5: this.setDoorMode(DOOR_NORMAL); break;
      default: return false;
    }
    this.log.info(`[gate] door command ${command} applied, mode ${this.doorMode}`);
    return true;
  }

  /** Turns the relay off when its pulse has elapsed, closes quiet reader frames, services feedback. */
  service(atMs = this.nowMs()) {
    this.reader.poll(atMs);
    if (this.relayOffAt !== null && this.doorMode !== DOOR_ALWAYS_OPEN && atMs - this.relayOffAt >= 0) {
      this.relayOffAt = null;
      this.writeRelay(false);
    }
    if (this.io.has('led') && this.ledOffAt !== null && atMs - this.ledOffAt >= 0) {
      this.io.write('led', false);
      this.ledOffAt = null;
    }
    if (this.io.has('buzzer') && (this.beepsLeft || this.beepOn) && this.beepNextAt !== null && atMs - this.beepNextAt >= 0) {
      this.beepOn = !this.beepOn;
      this.io.write('buzzer', this.beepOn);
      if (!this.beepOn && this.beepsLeft) this.beepsLeft -= 1;
      this.beepNextAt = atMs + (this.beepOn ? 120 : 100);
    }
  }

  feedbackGranted(atMs) {
    if (this.io.has('led')) {
      this.io.write('led', true);
      this.ledOffAt = atMs + this.timings.doorOpenMs;
    }
    if (this.io.has('buzzer')) {
      this.beepsLeft = 1;
      this.beepNextAt = atMs;
    }
  }

  feedbackDenied(atMs) {
    if (this.io.has('buzzer')) {
      this.beepsLeft = 3;
      this.beepNextAt = atMs;
    }
  }

  // ---- Events --------------------------------------------------------------

  recordEvent(type, granted, doorOpened, cardNo, employeeNo, reason) {
    const event = {
      seq: ++this.eventSeq,
      at: this.clock.nowSeconds(),
      type,
      granted: Boolean(granted),
      doorOpened: Boolean(doorOpened),
      cardNo: cardNo ?? null,
      employeeNo: employeeNo ?? null,
      reason: reason ?? null,
      bootId: this.bootId,
    };
    if (this.events.length >= EVENT_RING_SIZE) {
      // Offline for a long time: keep the newest history, count what was lost.
      this.events.shift();
      this.eventsDropped += 1;
    }
    this.events.push(event);
    if (type !== 'exit') {
      if (granted) this.grantedCount += 1; else this.deniedCount += 1;
      this.lastDecision = granted ? 'granted' : 'denied';
      this.lastReason = reason;
      this.lastResult = doorOpened ? 'opened' : 'not_attempted';
    }
    return event;
  }

  /**
   * The event as an ISAPI-style AccessControllerEvent document, which the
   * Worker normalises with the same pipeline it uses for terminal events. The
   * typed PIN is never part of it.
   */
  buildEventDocument(event) {
    const doc = { eventType: 'AccessControllerEvent' };
    if (event.at) doc.dateTime = formatTimestamp(event.at, true);
    const ace = { serialNo: `${event.bootId}-${event.seq}`, doorNo: this.doorNo };
    if (event.type === 'exit') {
      ace.eventState = 'granted';
      ace.eventDescription = `Exit button pressed at the ${this.label}`;
      ace.direction = 'exit';
    } else {
      ace.eventState = event.granted ? 'granted' : 'denied';
      const what = event.type === 'card' ? 'Card' : 'PIN';
      ace.eventDescription = event.granted
        ? `${what} accepted by the ${this.label}`
        : `${what} refused by the ${this.label}: ${event.reason}`;
      ace.currentVerifyMode = event.type === 'card' ? 'card' : 'pin';
      if (event.cardNo) ace.cardNo = event.cardNo;
      if (event.employeeNo) ace.employeeNoString = event.employeeNo;
    }
    doc.AccessControllerEvent = ace;
    return JSON.stringify(doc);
  }

  /** The upload payload for the queued events, oldest first. */
  takeEventBatch(limit = EVENT_BATCH_SIZE) {
    return this.events.slice(0, limit);
  }

  /** Removes events that were accepted (or can never be accepted). */
  dropEvents(events) {
    if (!events.length) return;
    const lastSeq = events[events.length - 1].seq;
    this.events = this.events.filter((event) => event.seq > lastSeq);
  }

  /** The heartbeat body, in the shape the ESP32 sketch sends. */
  heartbeatBody({ hostname, ip }) {
    const usage = process.memoryUsage();
    const stats = {
      eventsQueued: this.events.length,
      eventsDropped: this.eventsDropped,
      visitorPins: this.visitors.count,
      uptimeSeconds: Math.round(this.nowMs() / 1000),
      freeMemBytes: Math.max(0, usage.heapTotal - usage.heapUsed),
      pid: process.pid,
    };
    const remote = {
      enabled: true,
      controller: 'pi-gate',
      cache: this.cache.stats(this.clock.nowSeconds()),
      perDevice: {},
    };
    const state = {};
    if (this.lastDecision) {
      state.lastDecision = this.lastDecision;
      state.lastReason = this.lastReason;
      state.lastResult = this.lastResult;
    }
    state.granted = this.grantedCount;
    state.denied = this.deniedCount;
    state.doorMode = this.doorMode;
    remote.perDevice[this.config.deviceId] = state;
    return {
      version: `pi-gate-${GATE_VERSION}`,
      hostname,
      ip,
      capabilities: [],                       // no person / fingerprint work for a controller
      devices: [{ deviceId: this.config.deviceId, stream: 'up' }],
      stats,
      remoteVerify: remote,
    };
  }

  // ---- Snapshot ------------------------------------------------------------

  snapshotPath() {
    return join(this.config.stateDir, 'snapshot.json');
  }

  setSyncError(message) {
    this.cache.lastSyncError = message;
    this.log.warn(`[snapshot] ${message}`);
  }

  /** Refreshes the card cache. A failed refresh keeps the previous snapshot. */
  async syncSnapshot(api, atMs = this.nowMs()) {
    const startedMs = Date.now();
    const full = !this.cache.ready || !this.cache.since;
    const since = full ? '' : this.cache.since;
    const items = [];
    const removes = [];
    let cursor = '';
    let firstServerTime = '';
    try {
      for (let page = 0; page < 1000; page += 1) {
        const body = await api.snapshotPage({ limit: SNAPSHOT_PAGE, cursor, since });
        if (page === 0) firstServerTime = String(body.serverTime ?? '');
        for (const item of Array.isArray(body.items) ? body.items : []) {
          if (item?.kind !== 'card') continue;       // the reader presents cards only
          const value = String(item.value ?? '');
          if (!cardNumberKey(value)) continue;
          items.push({ value, validUntil: parseTimestamp(item.validUntil) });
        }
        for (const gone of Array.isArray(body.removed) ? body.removed : []) {
          if (String(gone?.kind ?? 'card') !== 'card') continue;
          removes.push(String(gone.value ?? ''));
        }
        if (!full && items.length + removes.length > DELTA_MAX) {
          // A delta that large is a full snapshot in disguise; start over cleanly.
          this.cache.since = '';
          this.setSyncError('delta too large; a full snapshot follows');
          return false;
        }
        const next = body.nextCursor ? String(body.nextCursor) : '';
        if (!next) break;
        cursor = next;
      }
    } catch (error) {
      this.setSyncError(`snapshot page failed: ${error.message}`);
      return false;
    }

    let serverNow = parseTimestamp(firstServerTime);
    if (!serverNow) serverNow = this.clock.nowSeconds();
    // Two minutes of overlap: re-applying a change is harmless, missing one is not.
    const nextSince = serverNow ? formatTimestamp(serverNow - SNAPSHOT_OVERLAP_SECONDS, false) : '';

    let changed = 0;
    let dropped = 0;
    if (full) {
      const result = this.cache.replaceAll(items);
      if (!result.ok) {
        this.setSyncError(result.error);
        return false;
      }
      changed = result.changed;
      dropped = result.dropped;
      this.cache.ready = true;
    } else {
      const result = this.cache.applyDelta(removes, items);
      changed = result.changed;
      dropped = result.dropped;
    }
    if (full || changed) this.cache.save(this.snapshotPath());
    this.cache.since = nextSince;
    this.cache.syncCount += 1;
    this.cache.lastSyncAt = serverNow || this.clock.nowSeconds();
    this.cache.lastSyncLatencyMs = Date.now() - startedMs;
    this.cache.lastSyncError = dropped ? `card store full: ${dropped} new card(s) not cached` : null;
    this.log.info(`[snapshot] ${full ? 'full' : 'delta'} refresh OK: ${this.cache.count} card(s) cached, ${changed} change(s)`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// GPIO
// ---------------------------------------------------------------------------

/** Which libgpiod generation the installed tools are, from their own --help text. */
export function probeGpiodVersion(run) {
  const help = run('gpiomon', ['--help']);
  if (!help) return 0;
  if (help.includes('--event-clock')) return 2;
  if (help.includes('--format')) return 1;
  return 0;
}

/** Runs a command and returns its stdout, or null when it cannot run. */
export function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 || result.stdout ? String(result.stdout ?? '') : null;
}

/**
 * Real hardware, through the libgpiod command-line tools.
 *
 *   input   one long-running `gpiomon` on the reader lines and the exit button,
 *           printing every edge with the kernel's own timestamp. Reading the
 *           kernel timestamps is what makes a Node process able to see a
 *           Wiegand frame at all: a 26-bit card is a burst of ~100 us pulses,
 *           far faster than any polling loop, and the kernel has recorded each
 *           edge before we are scheduled.
 *   output  a long-running `gpioset` that holds the relay line. libgpiod v2 has
 *           an interactive mode, which is used when available; v1 holds a fixed
 *           value per process, so a change re-asserts the line.
 *
 * The tools' version is probed once - their output format changed between v1 and
 * v2 - and can be forced with `gpio.gpiodVersion`. Nothing here is on the
 * decision path: if the tools are missing the program says so and exits rather
 * than pretending the gate is armed.
 */
export class LibgpiodBackend {
  constructor({ config, onEvent, log, spawnImpl = spawn, run = runCapture }) {
    this.config = config;
    this.onEvent = onEvent;
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.run = run;
    this.writes = [];
    this.children = new Map();
    this.wanted = new Map();
    this.version = config.gpiodVersion === 'v1' ? 1 : config.gpiodVersion === 'v2' ? 2 : 0;
    this.epoch = null;   // kernel-clock reference, in seconds
  }

  chip() {
    return String(this.config.chip || 'gpiochip0');
  }

  /** Input lines that are wired. */
  inputLines() {
    const lines = [];
    const add = (role, offset) => {
      if (offset !== null && offset !== undefined) lines.push({ role, offset: Number(offset) });
    };
    add('d0', this.config.wiegandD0);
    add('d1', this.config.wiegandD1);
    add('exit', this.config.exitButton);
    return lines;
  }

  /** Output lines that are wired. */
  outputLines() {
    const lines = [];
    const add = (role, offset) => {
      if (offset !== null && offset !== undefined) lines.push({ role, offset: Number(offset) });
    };
    add('relay', this.config.relay);
    add('led', this.config.readerLed);
    add('buzzer', this.config.readerBuzzer);
    return lines;
  }

  /** The electrical level for a logical value on a role. */
  levelFor(role, value) {
    const activeHigh = role === 'relay' ? this.config.relayActiveHigh !== false : this.config.readerActiveHigh === true;
    return Boolean(value) === activeHigh ? 1 : 0;
  }

  start() {
    if (!this.version) {
      this.version = probeGpiodVersion(this.run);
      if (!this.version) {
        throw new Error('the gpiomon tool from libgpiod was not found (install the "gpiod" package, or set gpio.backend to "fake")');
      }
    }
    if (this.version === 1 && this.config.exitButtonPullUp && this.inputLines().some((line) => line.role === 'exit')) {
      this.log.warn('[gpio] libgpiod v1 cannot enable the internal pull-up: give the exit button an external pull-up to 3.3 V, or use gpiod v2');
    }
    this.log.info(`[gpio] libgpiod v${this.version} on ${this.chip()}: D0=${this.config.wiegandD0} D1=${this.config.wiegandD1}, relay=${this.config.relay}${this.config.exitButton !== null && this.config.exitButton !== undefined ? `, exit=${this.config.exitButton}` : ''}`);
    this.stopped = false;
    this.startInputMonitor();
    if (this.outputLines().length) this.startOutputHolder();
  }

  startInputMonitor() {
    const lines = this.inputLines();
    if (!lines.length) return;
    const offsets = lines.map((line) => String(line.offset));
    const byOffset = new Map(lines.map((line) => [String(line.offset), line.role]));
    const args = this.version >= 2
      ? ['--chip', this.chip(), '--edges', 'falling', ...(this.config.exitButtonPullUp ? ['--bias', 'pull-up'] : []), '--format', '%S %e %o', ...offsets]
      : ['--format', '%e %o %s %n', '--falling-edge', this.chip(), ...offsets];
    const child = this.spawnImpl('gpiomon', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set('gpiomon', child);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const event = this.parseEventLine(line, byOffset);
        if (event) this.onEvent(event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.log.warn(`[gpio] ${String(chunk).trim()}`));
    child.on('exit', (code) => {
      if (this.stopped) return;
      this.log.warn(`[gpio] gpiomon exited with ${code}; restarting in 2s`);
      setTimeout(() => { if (!this.stopped) this.startInputMonitor(); }, 2000).unref?.();
    });
  }

  /** Parses one gpiomon line in the probed version's format. */
  parseEventLine(line, byOffset) {
    const text = line.trim();
    if (!text) return null;
    let edgeCode;
    let offset;
    let seconds;
    if (this.version >= 2) {
      // "%S %e %o" -> "123456.789012345 2 17"
      const [stamp, edge, lineOffset] = text.split(' ');
      seconds = Number(stamp);
      edgeCode = edge;
      offset = lineOffset;
    } else {
      // "%e %o %s %n" -> "0 17 123456 789012345"
      const [edge, lineOffset, s, n] = text.split(' ');
      seconds = Number(s) + Number(n) / 1e9;
      edgeCode = edge;
      offset = lineOffset;
    }
    const role = byOffset.get(String(offset));
    if (!role || !Number.isFinite(seconds)) return null;
    const falling = String(edgeCode) === (this.version >= 2 ? '2' : '0');
    if (this.epoch === null) this.epoch = seconds;
    return { line: role, edge: falling ? 'falling' : 'rising', t: Math.round((seconds - this.epoch) * 1000) };
  }

  startOutputHolder() {
    const outputs = this.outputLines();
    for (const line of outputs) if (!this.wanted.has(line.role)) this.wanted.set(line.role, false);
    if (this.version >= 2) {
      const args = ['--chip', this.chip(), '--interactive', ...outputs.map((line) => `${line.offset}=${this.levelFor(line.role, this.wanted.get(line.role))}`)];
      const child = this.spawnImpl('gpioset', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.set('gpioset', child);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this.log.warn(`[gpio] ${String(chunk).trim()}`));
      child.on('exit', (code) => {
        if (this.stopped) return;
        this.log.warn(`[gpio] gpioset exited with ${code}; re-asserting the output lines`);
        this.startOutputHolder();
      });
    } else {
      this.restartV1Holder();
    }
  }

  /** libgpiod v1 has no interactive mode, so the holder is replaced on every change. */
  restartV1Holder() {
    const outputs = this.outputLines();
    const previous = this.children.get('gpioset');
    if (previous) {
      try { previous.kill('SIGTERM'); } catch { /* already gone */ }
    }
    const args = ['--mode', 'signal', this.chip(), ...outputs.map((line) => `${line.offset}=${this.levelFor(line.role, this.wanted.get(line.role))}`)];
    const child = this.spawnImpl('gpioset', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set('gpioset', child);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.log.warn(`[gpio] ${String(chunk).trim()}`));
    child.on('exit', (code) => {
      if (this.stopped || this.children.get('gpioset') !== child) return;
      this.log.warn(`[gpio] gpioset exited with ${code}; re-asserting the output lines`);
      this.restartV1Holder();
    });
  }

  has(role) {
    return this.outputLines().some((line) => line.role === role);
  }

  write(role, value) {
    const line = this.outputLines().find((candidate) => candidate.role === role);
    if (!line) return;
    this.wanted.set(role, Boolean(value));
    this.writes.push({ role, value: Boolean(value), t: Date.now() });
    const child = this.children.get('gpioset');
    if (!child) return;
    if (this.version >= 2 && child.stdin?.writable) {
      // gpioset's interactive prompt: one command per line.
      child.stdin.write(`set ${line.offset}=${this.levelFor(role, value)}\n`);
    } else {
      this.restartV1Holder();
    }
  }

  stop() {
    this.stopped = true;
    for (const child of this.children.values()) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.children.clear();
  }
}

/** The stand-in the tests and dry runs use: scripted edges in, recorded writes out. */
export class FakeBackend {
  constructor({ config, onEvent, log }) {
    this.config = config;
    this.onEvent = onEvent;
    this.log = log;
    this.writes = [];
    this.events = [];
    this.wanted = new Map();
    this.stopped = true;
  }

  has(role) {
    const offsets = { relay: this.config.relay, led: this.config.readerLed, buzzer: this.config.readerBuzzer };
    return offsets[role] !== null && offsets[role] !== undefined;
  }

  start() {
    this.stopped = false;
    this.log.info('[gpio] fake backend: no hardware is driven');
    if (typeof this.config.script === 'string' && this.config.script) this.playScriptFile(this.config.script);
  }

  /** Feeds one edge, as the kernel would. */
  emit(event) {
    const prepared = { edge: 'falling', ...event, t: Number(event.t) || 0 };
    this.events.push(prepared);
    if (!this.stopped) this.onEvent(prepared);
    return prepared;
  }

  /**
   * Replays a scripted burst of edges from a JSON file.
   *
   * Only the *gaps* are replayed; every edge is stamped with the process clock
   * as it is emitted. A script is a timing pattern - one card swipe - and the
   * reader closes frames against the same clock the gate runs on, so the
   * absolute times of a recording would put the two timebases out of step (the
   * first service tick would then cut the frame short).
   */
  playScriptFile(path) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      this.log.warn(`[gpio] cannot read script ${path}: ${error.message}`);
      return;
    }
    const events = Array.isArray(payload) ? payload : Array.isArray(payload.events) ? payload.events : [];
    const speed = Math.max(0.001, Number(payload.speed ?? this.config.scriptSpeed) || 1);
    // Each edge's delay is measured from the start of playback (so a script may
    // begin with a pause), never from the previous edge: every timer is armed at
    // once, and relative delays would fire the later edges ahead of the first.
    for (const event of events) {
      const at = Number(event.t) || 0;
      const delay = Math.max(0, at) / speed;
      setTimeout(() => { if (!this.stopped) this.emit({ ...event, t: Date.now() }); }, delay).unref?.();
    }
  }

  write(role, value) {
    const record = { role, value: Boolean(value), t: Date.now() };
    this.writes.push(record);
    this.wanted.set(role, Boolean(value));
    if (typeof this.config.writeLog === 'string' && this.config.writeLog) {
      try { writeFileSync(this.config.writeLog, `${JSON.stringify(record)}\n`, { flag: 'a' }); } catch { /* best effort */ }
    }
    this.log.debug(`[gpio] fake write ${role} = ${Boolean(value)}`);
  }

  stop() {
    this.stopped = true;
  }
}

export function createGpio(config, { onEvent, log }) {
  if (config.backend === 'fake') return new FakeBackend({ config, onEvent, log });
  return new LibgpiodBackend({ config, onEvent, log });
}

// ---------------------------------------------------------------------------
// The agent protocol
// ---------------------------------------------------------------------------

export class AgentApi {
  constructor({ workerUrl, agentId, agentSecret, fetchImpl = fetch, timeoutMs = DEFAULT_CONFIG.timings.apiTimeoutMs, log }) {
    this.base = String(workerUrl).replace(/\/$/, '');
    this.agentId = agentId;
    this.agentSecret = agentSecret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  path(suffix) {
    return `${this.base}/api/isapi/v1/agents/${encodeURIComponent(this.agentId)}${suffix}`;
  }

  async request(method, suffix, body) {
    const init = {
      method,
      headers: { 'X-EstateMate-Agent-Key': this.agentSecret, 'User-Agent': `EstateMate-Pi-Gate/${GATE_VERSION}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.path(suffix), init);
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, ok: response.ok, json };
  }

  async heartbeat(body) {
    return this.request('POST', '/heartbeat', body);
  }

  async snapshotPage({ limit, cursor, since }) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    else if (since) params.set('since', since);
    const { status, ok, json } = await this.request('GET', `/credential-snapshot?${params.toString()}`);
    if (!ok) throw new Error(`HTTP ${status}${json?.error ? ` ${json.error}` : ''}`);
    return json ?? {};
  }

  async pollOperations(limit = 10) {
    const { status, ok, json } = await this.request('GET', `/operations?limit=${limit}`);
    if (!ok) throw new Error(`HTTP ${status}`);
    return json ?? { items: [] };
  }

  async reportResult(id, kind, applied, errorMessage, durationMs) {
    const body = { kind, status: applied ? 'applied' : 'failed', durationMs };
    if (!applied && errorMessage) body.errorMessage = errorMessage;
    const { status, ok } = await this.request('POST', `/operations/${encodeURIComponent(id)}/result`, body);
    if (!ok) this.log.warn(`[ops] result for ${id} not accepted: HTTP ${status}`);
    return ok;
  }

  async uploadEvents(items) {
    const { status } = await this.request('POST', '/events', { items });
    return status;
  }
}

// ---------------------------------------------------------------------------
// State file (the door mode survives a restart, like the sketch's Preferences)
// ---------------------------------------------------------------------------

export function createStateFile(path) {
  const loadState = () => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
  };
  const persistState = (patch) => {
    const next = { ...loadState(), ...patch };
    try { writeFileSync(path, JSON.stringify(next)); } catch { /* best effort */ }
  };
  return { loadState, persistState };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function pickIp(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') return entry.address;
    }
  }
  return '127.0.0.1';
}

export function pickHostname(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.mac || entry.mac === '00:00:00:00:00:00') continue;
      return `estatemate-gate-${entry.mac.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-6)}`;
    }
  }
  return `estatemate-gate-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/** A per-boot id, the sketch's `bootId`, used to make event serial numbers unique. */
export function createBootId(random = Math.random) {
  return Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');
}

/**
 * Wires the controller, the GPIO backend and the agent API together and owns
 * the clock: heartbeat, snapshot, operations poll and event flush, in the
 * sketch's order and at the sketch's intervals.
 */
export function createGateController(config, {
  log = createLogger(config.logLevel),
  api = null,
  gpio = null,
  clock = createClock(),
  fetchImpl = fetch,
  random = Math.random,
  interfaces = null,
} = {}) {
  if (!config.stateDir) throw new Error('stateDir is required');
  mkdirSync(config.stateDir, { recursive: true });

  let controller = null;
  const backend = gpio ?? createGpio(config.gpio, { log, onEvent: (event) => controller?.handleGpioEvent(event) });
  const stateFile = createStateFile(join(config.stateDir, 'state.json'));
  backend.loadState ??= () => stateFile.loadState();
  backend.persistState ??= (patch) => stateFile.persistState(patch);

  const agentApi = api ?? new AgentApi({
    workerUrl: config.workerUrl,
    agentId: config.agentId,
    agentSecret: config.agentSecret,
    fetchImpl,
    timeoutMs: config.timings.apiTimeoutMs,
    log,
  });

  controller = new GateController({ config, io: backend, clock, log, maxCards: config.maxCards });
  controller.bootId = createBootId(random);
  controller.cache.load(controller.snapshotPath());
  controller.visitors.load(join(config.stateDir, 'visitors.json'));

  const hostname = pickHostname(interfaces ?? undefined);
  const ip = pickIp(interfaces ?? undefined);
  const timings = controller.timings;
  const timers = [];
  let nextHeartbeat = 0;
  let nextSnapshot = 0;
  let nextOps = 0;
  let stopped = false;

  async function flushEvents() {
    const batch = controller.takeEventBatch();
    if (!batch.length) return null;
    const items = batch.map((event) => {
      const item = { deviceId: config.deviceId, contentType: 'application/json', document: controller.buildEventDocument(event) };
      if (event.type !== 'exit') {
        item.remoteVerification = {
          decision: event.granted ? 'granted' : 'denied',
          reason: event.reason,
          doorResult: event.doorOpened ? 'opened' : 'not_attempted',
        };
      }
      return item;
    });
    try {
      const status = await agentApi.uploadEvents(items);
      // 409: an Administrator switched agent event streaming off; 400/413: the
      // batch can never be accepted. Either way, retrying it forever helps nobody.
      if ((status >= 200 && status < 300) || status === 409 || status === 400 || status === 413) {
        if (status !== 200 && status !== 201) log.warn(`[events] batch dropped: HTTP ${status}`);
        controller.dropEvents(batch);
      } else {
        log.warn(`[events] upload failed: HTTP ${status} (kept for retry)`);
      }
      return status;
    } catch (error) {
      log.warn(`[events] upload failed: ${error.message} (kept for retry)`);
      return null;
    }
  }

  async function pollOperations() {
    const body = await agentApi.pollOperations(10);
    const items = Array.isArray(body.items) ? body.items : [];
    const cardOps = [];
    for (const op of items) {
      const startedMs = Date.now();
      const id = String(op?.id ?? '');
      const kind = String(op?.kind ?? '');
      const operation = String(op?.operation ?? '');
      const deviceId = String(op?.deviceId ?? '');
      const payload = op?.payload && typeof op.payload === 'object' ? op.payload : {};
      if (!id) continue;
      if (deviceId !== config.deviceId) {
        await agentApi.reportResult(id, kind, false, `this ${config.label} serves one terminal only; link this terminal to a bridge instead`, Date.now() - startedMs);
        continue;
      }
      if (kind === 'door') {
        const command = DOOR_COMMANDS[operation];
        const doorNo = Number(payload.doorNo ?? 1);
        if (!command) { await agentApi.reportResult(id, kind, false, 'unknown door command', Date.now() - startedMs); continue; }
        if (doorNo !== controller.doorNo) {
          await agentApi.reportResult(id, kind, false, `door ${doorNo} is not wired to this controller (it drives door ${controller.doorNo})`, Date.now() - startedMs);
          continue;
        }
        controller.applyDoorCommand(command);
        await agentApi.reportResult(id, kind, true, null, Date.now() - startedMs);
      } else if (kind === 'visitor') {
        const given = String(payload.employeeNo ?? '');
        const credential = String(payload.credentialNumber ?? '');
        const employeeNo = given || (credential ? `visitor${credential}` : '');
        let error = null;
        if (operation === 'upsert_visitor') {
          error = controller.visitors.upsert(employeeNo, payload.pin, parseTimestamp(payload.validFrom), parseTimestamp(payload.validUntil));
          if (!error) controller.visitors.save(join(config.stateDir, 'visitors.json'));
        } else if (operation === 'revoke_visitor') {
          if (validEmployeeNo(employeeNo)) {
            controller.visitors.revoke(employeeNo);
            controller.visitors.save(join(config.stateDir, 'visitors.json'));
          } else error = 'operation has no valid visitor employee number';
        } else error = 'unknown visitor operation';
        await agentApi.reportResult(id, kind, error === null, error, Date.now() - startedMs);
      } else if (kind === 'card') {
        // Cards are enforced from the snapshot, so a card change is applied by
        // refreshing it. Reported after the refresh succeeds; if it fails the
        // operation is left unreported and the Worker hands it out again.
        cardOps.push(id);
      } else {
        await agentApi.reportResult(id, kind, false, `the ${config.label} has no person or fingerprint store; enrol at a terminal served by a bridge`, Date.now() - startedMs);
      }
    }
    if (cardOps.length) {
      const startedMs = Date.now();
      const ok = await controller.syncSnapshot(agentApi).catch((error) => {
        controller.setSyncError(`snapshot sync failed: ${error.message}`);
        return false;
      });
      if (ok) for (const id of cardOps) await agentApi.reportResult(id, 'card', true, null, Date.now() - startedMs);
    }
    const retry = Number(body.retryAfterSeconds);
    return Number.isFinite(retry) && retry > 0 ? Math.max(1, Math.min(retry, timings.operationsSeconds)) : timings.operationsSeconds;
  }

  async function tick(atMs = controller.nowMs()) {
    if (atMs - nextHeartbeat >= 0) {
      try {
        const { ok, json } = await agentApi.heartbeat(controller.heartbeatBody({ hostname, ip }));
        if (ok && json?.serverTime) clock.adopt(json.serverTime);
      } catch (error) {
        log.warn(`[api] heartbeat failed: ${error.message}`);
      }
      nextHeartbeat = controller.nowMs() + timings.heartbeatSeconds * 1000;
    }
    if (atMs - nextSnapshot >= 0) {
      const ok = await controller.syncSnapshot(agentApi, atMs).catch((error) => {
        controller.setSyncError(`snapshot sync failed: ${error.message}`);
        return false;
      });
      nextSnapshot = controller.nowMs() + (ok ? timings.snapshotSeconds : timings.snapshotRetrySeconds) * 1000;
    }
    if (atMs - nextOps >= 0) {
      let waitSeconds = timings.operationsSeconds;
      try {
        waitSeconds = await pollOperations();
      } catch (error) {
        log.warn(`[ops] poll failed: ${error.message}`);
      }
      nextOps = controller.nowMs() + Math.max(1, Math.min(waitSeconds, timings.operationsSeconds)) * 1000;
    }
    await flushEvents();
  }

  return {
    controller,
    backend,
    api: agentApi,
    clock,
    hostname,
    ip,
    tick,
    flushEvents,
    pollOperations,
    start({ immediate = true } = {}) {
      backend.start();
      controller.restoreDoorMode(backend.loadState?.()?.doorMode);
      if (immediate) {
        // Bring the snapshot in before the first swipe: a cold cache denies
        // everything, which is correct but useless if it is only because the
        // process started in the wrong order.
        tick(controller.nowMs() + 1).catch((error) => log.warn(`[startup] ${error.message}`));
      }
      timers.push(setInterval(() => { tick().catch((error) => log.warn(`[tick] ${error.message}`)); }, timings.tickIntervalMs));
      timers.push(setInterval(() => { controller.service(); }, timings.serviceIntervalMs));
      return this;
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      backend.stop();
    },
    get stopped() {
      return stopped;
    },
  };
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

export function renderSystemdUnit({ node = '/usr/bin/node', program = DEFAULT_PROGRAM_PATH, config = DEFAULT_CONFIG_PATH } = {}) {
  return `[Unit]
Description=EstateMate Raspberry Pi gate controller
# The gate keeps working while the estate's internet is down: nothing here
# needs the network to make a decision.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${program} --config ${config}
Restart=always
RestartSec=5
# The relay line is held by this process through libgpiod, which is why it runs
# as root. A dedicated user works too: add SupplementaryGroups=gpio and make
# sure it can open /dev/gpiochip0.
User=root
WorkingDirectory=${dirname(program)}
# The agent's network path is outbound only; it never listens on a port.
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
StateDirectory=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** Parses a config document. A file the portal wrote to explain a problem is reported as such. */
export function loadConfig(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : (text ?? {});
  if (parsed.error) return { config: null, error: String(parsed.error), steps: Array.isArray(parsed.steps) ? parsed.steps : [] };
  return { config: deepMerge(DEFAULT_CONFIG, parsed), error: null, steps: [] };
}

/** Everything the gate cannot work without, in one place. */
export function validateConfig(config) {
  const problems = [];
  if (!config.workerUrl) problems.push('workerUrl is missing');
  if (!/^https?:\/\//.test(config.workerUrl)) problems.push('workerUrl must start with http:// or https://');
  if (!config.agentId) problems.push('agentId is missing');
  if (!config.agentSecret) problems.push('agentSecret is missing');
  if (!config.deviceId) problems.push('deviceId is missing');
  if (!Number.isInteger(Number(config.doorNo)) || Number(config.doorNo) < 1 || Number(config.doorNo) > 8) problems.push('doorNo must be 1 to 8');
  if (!['libgpiod', 'fake'].includes(config.gpio.backend)) problems.push('gpio.backend must be "libgpiod" or "fake"');
  return problems;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function main(argv = process.argv) {
  const configPath = resolve(argValue('config', process.env.ESTATEMATE_PI_GATE_CONFIG || DEFAULT_CONFIG_PATH));
  const logLevel = argValue('log-level', process.env.ESTATEMATE_PI_GATE_LOG_LEVEL || null);
  const has = (flag) => argv.includes(flag);

  if (has('--help') || has('-h')) {
    process.stdout.write(`EstateMate Raspberry Pi gate controller ${GATE_VERSION}

  node EstateMateGate.mjs --config ${DEFAULT_CONFIG_PATH}

Options:
  --config <path>     configuration file (default ${DEFAULT_CONFIG_PATH})
  --once              one heartbeat, snapshot, operations poll and event flush, then exit
  --check             validate the configuration, open the GPIO lines and exit
  --print-service     print the systemd unit for this installation
  --install-service   install that unit, enable it and start it (needs root)
  --log-level <level> error | warn | info | debug
  --version           print the version
  --help              this text
`);
    return 0;
  }
  if (has('--version')) {
    process.stdout.write(`${GATE_VERSION}\n`);
    return 0;
  }
  if (has('--print-service')) {
    process.stdout.write(renderSystemdUnit({ node: process.execPath, program: fileURLToPath(import.meta.url), config: configPath }));
    return 0;
  }

  if (!existsSync(configPath)) {
    process.stderr.write(`Config file not found: ${configPath}\nDownload it from the portal (Device agent > Download Pi gate config) and place it there.\n`);
    return 1;
  }
  let loaded;
  try {
    loaded = loadConfig(readFileSync(configPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`Config file is not valid JSON: ${error.message}\n`);
    return 1;
  }
  if (loaded.error) {
    // The portal writes this file when there is no single terminal to give the
    // gate: it explains the problem instead of arming a gate with no door.
    process.stderr.write(`This configuration cannot run a gate:\n\n${loaded.error}\n`);
    for (const step of loaded.steps) process.stderr.write(`  - ${step}\n`);
    return 1;
  }
  const config = loaded.config;
  if (logLevel) config.logLevel = logLevel;
  const log = createLogger(config.logLevel);
  const problems = validateConfig(config);
  if (problems.length) {
    process.stderr.write(`The configuration is not usable:\n${problems.map((problem) => `  - ${problem}\n`).join('')}`);
    return 1;
  }

  const state = createGateController(config, { log });

  if (has('--check')) {
    try {
      state.backend.start();
    } catch (error) {
      process.stderr.write(`The GPIO lines could not be opened: ${error.message}\n`);
      return 1;
    }
    state.backend.stop();
    process.stdout.write(`Configuration OK: agent ${config.agentId}, device ${config.deviceId}, ${config.gpio.backend} GPIO backend.\n`);
    return 0;
  }
  if (has('--install-service')) {
    const unitPath = `/etc/systemd/system/${SERVICE_NAME}.service`;
    const unit = renderSystemdUnit({ node: process.execPath, program: fileURLToPath(import.meta.url), config: configPath });
    try {
      writeFileSync(unitPath, unit);
    } catch (error) {
      process.stderr.write(`Could not write ${unitPath}: ${error.message}. Run --install-service as root.\n`);
      return 1;
    }
    const { execFileSync } = await import('node:child_process');
    execFileSync('systemctl', ['daemon-reload']);
    execFileSync('systemctl', ['enable', '--now', SERVICE_NAME]);
    process.stdout.write(`${SERVICE_NAME} installed and started.\n`);
    return 0;
  }

  const once = has('--once');
  log.info(`EstateMate ${config.label} ${GATE_VERSION} starting: agent ${config.agentId}, device ${config.deviceId}, door ${config.doorNo}, ${config.gpio.backend} GPIO`);
  try {
    state.start({ immediate: false });
  } catch (error) {
    // A gate whose lines cannot be opened must not look like a running gate.
    log.error(`[gpio] ${error.message}`);
    return 1;
  }
  if (!state.controller.cache.ready) log.warn('[cache] no snapshot yet: cards are denied until the first refresh');
  if (once) {
    await state.tick();
    await state.flushEvents();
    state.stop();
    return 0;
  }
  const shutdown = () => {
    log.info('Shutting down; the relay line is released.');
    state.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then((code) => { if (typeof code === 'number') process.exit(code); }).catch((error) => {
    process.stderr.write(`Fatal: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
