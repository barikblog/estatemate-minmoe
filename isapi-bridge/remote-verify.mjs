/**
 * Remote Network Verification: the terminal reads, this bridge decides.
 *
 * A Hikvision access terminal stores a few thousand people. An estate with more
 * than that cannot put them all on the device, so instead of asking the terminal
 * to decide, we let it report what it saw and decide here, on the LAN, then
 * answer with the door command this agent already knows how to send.
 *
 * Two deliberate design choices are baked into this file, and both are the
 * reason it looks the way it does:
 *
 * 1. **The decision is made against a local snapshot, never a live query.** The
 *    estate's users live in D1, behind the public internet. A lookup per swipe
 *    would make a physical door depend on the estate's uplink and on a round
 *    trip nobody can promise inside the few hundred milliseconds a person stands
 *    at a reader - and it would fail *closed*, which at a gate means a crowd. The
 *    snapshot is refreshed on an interval, so a dead link degrades to "a few
 *    minutes stale", not "nobody gets in".
 *
 * 2. **The door command is best-effort and its result is reported, not
 *    assumed.** No device profile in this repository records a verified
 *    RemoteControl/door response, so an automatic open is a decision the estate
 *    makes with its eyes open. Every attempt returns the terminal's own answer;
 *    a refusal is surfaced rather than retried into a lock.
 *
 * Dependency-free: Node 18+, no network, no filesystem unless a cache file is
 * given. Pure enough to be unit-tested, and deliberately shaped so the Android
 * port carries the same rules.
 */

/** A credential a terminal can present, as the snapshot delivers it. */
// { kind: 'card' | 'employee', value, personId, employeeNo, status, validUntil, deviceIds }

/**
 * Hikvision reports the same physical card in different shapes depending on the
 * terminal's card format setting and the firmware: the raw number, a
 * zero-padded decimal, and (on some Wiegand configurations) a byte-reversed
 * hexadecimal are all the same card. A tap-enrolled card matches exactly, but a
 * card typed from a CSV or read by a differently configured reader often does
 * not, and "the number is right but the lookup missed" is the single most common
 * way this feature appears broken on a real gate.
 *
 * Each formatter is deterministic and cheap; the cache is probed in order.
 */
const CARD_NUMBER_FORMATTERS = {
  /** The string exactly as the terminal reported it. */
  exact: (value) => [value],
  /** Zero-padded to the 10 digits most Hikvision card formats are stored in. */
  padded10: (value) => (/^\d+$/.test(value) && value.length < 10 ? [value.padStart(10, '0')] : []),
  /** A byte-reversed hexadecimal reading of the same card. */
  hexReversed: (value) => {
    if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return [];
    const bytes = value.match(/.{2}/g) ?? [];
    return [bytes.reverse().join('').toUpperCase()];
  },
};

export const DEFAULT_CARD_FORMATS = ['exact', 'padded10'];

/** Normalises a card number the way the terminal and the portal both store it. */
export function normalizeCardNumber(value) {
  return String(value ?? '').trim().toUpperCase();
}

/** Every cache key this card number might be filed under, most likely first. */
export function cardNumberCandidates(value, formats = DEFAULT_CARD_FORMATS) {
  const base = normalizeCardNumber(value);
  if (!base) return [];
  const out = [];
  for (const name of formats) {
    const format = CARD_NUMBER_FORMATTERS[name];
    if (!format) continue;
    for (const candidate of format(base)) {
      const normalized = normalizeCardNumber(candidate);
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
  }
  return out.length ? out : [base];
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

/** The value of the first <tag> in an XML document, or null. */
function xmlTag(document, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(document);
  return match ? match[1].trim() : null;
}

/**
 * Pulls the credential out of a terminal event, XML or JSON.
 *
 * The terminal reports an employee number for a fingerprint, a face or a PIN, and
 * a card number for a card. Which one is present depends on how the person
 * authenticated, so both are collected and the decision tries the card first
 * (a card number is unambiguous) before falling back to the person's identity.
 *
 * `doorNo` matters because the unlock command addresses one door: a terminal
 * wired to two doors must be told which one to release.
 */
export function parseTerminalEvent(document, contentType = '') {
  if (document == null) return null;
  const text = String(document).trim();
  if (!text) return null;
  const looksJson = contentType.includes('json') || (!contentType && (text.startsWith('{') || text.startsWith('[')));

  let source = null;
  if (looksJson) {
    try {
      const parsed = JSON.parse(text);
      source = (parsed && (parsed.AccessControllerEvent || parsed.EventNotificationAlert || parsed.accessControllerEvent))
        ?? (Array.isArray(parsed) ? parsed[0] : parsed);
    } catch {
      source = null;
    }
  }
  if (source && typeof source === 'object') {
    const event = source.AccessControllerEvent ?? source;
    const pick = (...names) => {
      for (const name of names) {
        const value = event?.[name];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
      return null;
    };
    const doorNo = Number(pick('doorNo', 'door') ?? 1);
    return {
      cardNo: pick('cardNo', 'cardNumber', 'card'),
      employeeNo: pick('employeeNoString', 'employeeNo', 'employeeID'),
      name: pick('name', 'personName'),
      doorNo: Number.isInteger(doorNo) && doorNo > 0 ? doorNo : 1,
      eventType: pick('eventType', 'major') ?? null,
      serialNo: pick('serialNo') ?? null,
      deviceIp: pick('ipAddress') ?? null,
      format: 'json',
    };
  }

  // XML. Tolerant on purpose: an unknown shape yields nulls, never a guess.
  const body = text.includes('<AccessControllerEvent')
    ? (new RegExp('<AccessControllerEvent[\\s\\S]*?</AccessControllerEvent>', 'i').exec(text)?.[0] ?? text)
    : text;
  const doorNo = Number(xmlTag(body, 'doorNo') ?? xmlTag(body, 'door') ?? 1);
  const pickTag = (...names) => {
    for (const name of names) {
      const value = xmlTag(body, name) ?? xmlTag(text, name);
      if (value) return value;
    }
    return null;
  };
  const cardNo = pickTag('cardNo', 'cardNumber');
  const employeeNo = pickTag('employeeNoString', 'employeeNo', 'employeeID');
  if (!cardNo && !employeeNo) return null;
  return {
    cardNo,
    employeeNo,
    name: pickTag('name', 'personName'),
    doorNo: Number.isInteger(doorNo) && doorNo > 0 ? doorNo : 1,
    eventType: pickTag('eventType', 'major'),
    serialNo: pickTag('serialNo'),
    deviceIp: pickTag('ipAddress'),
    format: 'xml',
  };
}

// ---------------------------------------------------------------------------
// The snapshot cache
// ---------------------------------------------------------------------------

/** The cache key for a credential, as the snapshot and the lookup agree on. */
export function credentialKey(kind, value) {
  return `${kind === 'employee' ? 'employee' : 'card'}:${String(value ?? '').trim().toUpperCase()}`;
}

/**
 * Every authorised credential the estate has, held in memory on the bridge host.
 *
 * 20,000+ entries is a few megabytes and a Map lookup is sub-microsecond, which
 * is what keeps the whole loop inside the time a person is willing to stand at a
 * reader. The snapshot is refreshed by `sync()`, which pages through the
 * Worker's endpoint and applies removals as well as additions - a credential
 * that was revoked between two syncs must disappear, or a suspended card keeps
 * opening the door until the next restart.
 */
export class CredentialCache {
  constructor(options = {}) {
    this.credentials = new Map();
    this.cardFormats = options.cardFormats ?? DEFAULT_CARD_FORMATS;
    this.version = null;
    this.lastSyncAt = null;
    this.lastSyncError = null;
    this.lastSyncLatencyMs = null;
    this.syncCount = 0;
    this.removedApplied = 0;
  }

  get count() {
    return this.credentials.size;
  }

  /** Seconds since the snapshot was last refreshed, or null if it never was. */
  ageSeconds(now = Date.now()) {
    return this.lastSyncAt ? Math.max(0, Math.round((now - this.lastSyncAt) / 1000)) : null;
  }

  /**
   * True once a snapshot has been loaded, so a cold start can never open a door.
   *
   * Deliberately keyed on the successful sync and not on `version`: that field is
   * informational, and a Worker that omits it would otherwise leave a perfectly
   * good cache permanently unready - which denies everyone, which is the failure
   * this getter exists to prevent in the other direction.
   */
  get ready() {
    return this.lastSyncAt !== null;
  }

  /** Replaces one credential. `null` removes it. */
  put(item) {
    if (!item || item.value == null || item.value === '') return;
    this.credentials.set(credentialKey(item.kind, item.value), item);
  }

  remove(kind, value) {
    this.credentials.delete(credentialKey(kind, value));
  }

  /** Applies one page of a snapshot response. */
  applyPage(page, { full = false } = {}) {
    if (full) this.credentials.clear();
    for (const item of page.items ?? []) this.put(item);
    for (const gone of page.removed ?? []) {
      const kind = String(gone.kind ?? 'card');
      this.remove(kind, gone.value);
      this.removedApplied += 1;
    }
    if (page.version) this.version = page.version;
  }

  /**
   * Refreshes from the Worker.
   *
   * `fetchPage(cursor)` must resolve to one snapshot page or throw; the caller
   * supplies it so this module stays free of fetch, auth and configuration. A
   * failed sync leaves the previous snapshot in place: a stale list that still
   * opens the right doors is far safer than an empty one that opens none.
   */
  async sync(fetchPage, { maxPages = 500, now = Date.now() } = {}) {
    const startedAt = Date.now();
    this.pendingSince = this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : null;
    let cursor = null;
    let pages = 0;
    try {
      for (;;) {
        if (pages >= maxPages) throw new Error(`credential snapshot did not finish within ${maxPages} pages`);
        const page = await fetchPage(cursor, this.pendingSince);
        pages += 1;
        // A full refresh replaces the set; a delta only edits it. The server says
        // which one it served, because a delta against a version the bridge never
        // had would silently leave revoked credentials in place.
        this.applyPage(page, { full: Boolean(page.full) || pages === 1 && !this.pendingSince });
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      this.lastSyncAt = Date.now();
      this.lastSyncLatencyMs = Date.now() - startedAt;
      this.lastSyncError = null;
      this.syncCount += 1;
      return { ok: true, pages, count: this.count, version: this.version };
    } catch (error) {
      this.lastSyncError = String(error?.message ?? error);
      // A delta that failed half-way leaves the cache possibly incomplete, so the
      // next attempt asks for a full snapshot rather than continuing the delta.
      this.lastSyncAt = null;
      return { ok: false, error: this.lastSyncError, pages, count: this.count };
    }
  }

  /**
   * Finds a credential by card number, then by employee number.
   *
   * Card first: it is the unambiguous identifier, and a card event is the
   * common case. The employee number follows because a fingerprint, a face or a
   * PIN carries no card number at all - only the person's terminal identity.
   */
  lookup({ cardNo, employeeNo } = {}) {
    if (cardNo) {
      for (const candidate of cardNumberCandidates(cardNo, this.cardFormats)) {
        const hit = this.credentials.get(credentialKey('card', candidate));
        if (hit) return { item: hit, matchedOn: 'card', matchedValue: candidate };
      }
      // Fall back to a plain exact match in case the formatter list was narrowed.
      const exact = this.credentials.get(credentialKey('card', cardNo));
      if (exact) return { item: exact, matchedOn: 'card', matchedValue: normalizeCardNumber(cardNo) };
    }
    if (employeeNo) {
      const hit = this.credentials.get(credentialKey('employee', employeeNo));
      if (hit) return { item: hit, matchedOn: 'employee', matchedValue: String(employeeNo).trim() };
    }
    return null;
  }

  /** A compact status block for the heartbeat and the portal. */
  stats(now = Date.now()) {
    return {
      credentialCount: this.count,
      cacheVersion: this.version,
      cacheAgeSeconds: this.ageSeconds(now),
      lastSyncAt: this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : null,
      lastSyncLatencyMs: this.lastSyncLatencyMs,
      lastSyncError: this.lastSyncError,
      syncCount: this.syncCount,
      removedApplied: this.removedApplied,
    };
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decides one presented credential against the snapshot.
 *
 * The reason string is part of the contract: it is what an operator reads in the
 * gate history, so it has to say why - unknown, suspended, expired, or not
 * allowed at this gate - rather than a bare "denied".
 */
export function decideCredential(cache, { cardNo, employeeNo, deviceId } = {}, { now = Date.now() } = {}) {
  if (!cache?.ready) return { decision: 'denied', reason: 'cache_not_ready' };
  if (!cardNo && !employeeNo) return { decision: 'denied', reason: 'no_credential' };

  const match = cache.lookup({ cardNo, employeeNo });
  if (!match) return { decision: 'denied', reason: 'unknown_credential' };

  const { item, matchedOn, matchedValue } = match;
  if (item.status && item.status !== 'active') return { decision: 'denied', reason: 'credential_not_active', personId: item.personId, matchedOn, matchedValue, status: item.status };
  if (item.validUntil) {
    const until = Date.parse(item.validUntil);
    if (Number.isFinite(until) && until <= now) return { decision: 'denied', reason: 'credential_expired', personId: item.personId, matchedOn, matchedValue, validUntil: item.validUntil };
  }
  if (item.validFrom) {
    const from = Date.parse(item.validFrom);
    if (Number.isFinite(from) && from > now) return { decision: 'denied', reason: 'credential_not_yet_valid', personId: item.personId, matchedOn, matchedValue, validFrom: item.validFrom };
  }
  // A credential may be scoped to the gates it is allowed through. An empty or
  // absent list means every gate, which is the default and the common case.
  if (deviceId && Array.isArray(item.deviceIds) && item.deviceIds.length && !item.deviceIds.includes(deviceId)) {
    return { decision: 'denied', reason: 'not_allowed_at_this_gate', personId: item.personId, matchedOn, matchedValue };
  }
  return { decision: 'granted', reason: 'authorised', personId: item.personId, employeeNo: item.employeeNo ?? null, matchedOn, matchedValue };
}

/**
 * Suppresses repeat fires for the same credential at the same terminal.
 *
 * A card resting on a reader, or a person presenting twice because the door did
 * not move, produces a burst of identical events. Each one would otherwise send
 * another unlock command - noisy for the lock, and a way to hold a door open by
 * leaving a card in place.
 */
export class CooldownTracker {
  constructor({ maxKeys = 5000 } = {}) {
    this.last = new Map();
    this.maxKeys = maxKeys;
  }

  /** True when this credential may act at this terminal right now. */
  allow(key, cooldownMs, now = Date.now()) {
    if (!cooldownMs || cooldownMs <= 0) return { allowed: true, waitedMs: 0 };
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < cooldownMs) {
      return { allowed: false, waitedMs: now - previous, retryInMs: cooldownMs - (now - previous) };
    }
    this.set(key, now);
    return { allowed: true, waitedMs: previous === undefined ? Infinity : now - previous };
  }

  /** Records an attempt without asking, used once a command has been sent. */
  set(key, now = Date.now()) {
    // Insertion order is good enough as an eviction policy: Map preserves it, so
    // the oldest key is first. This keeps a busy gate from growing without bound.
    if (this.last.size >= this.maxKeys && !this.last.has(key)) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    this.last.set(key, now);
  }
}

/** The cache key a decision is cooled down under. */
export function cooldownKey(deviceId, decision) {
  const value = decision?.matchedValue ?? decision?.employeeNo ?? '';
  return `${deviceId}|${decision?.matchedOn ?? 'none'}|${value}`;
}
