/**
 * hikvision-tunnel-worker — Cloudflare Worker bridge between a public web app
 * (Cloudflare Pages) and a Hikvision access-control terminal that is published
 * on your LAN through a Cloudflare Tunnel at `TUNNEL_URL` (e.g. https://mydomain.com).
 *
 * OPERATION 1 — PULL DATA (device → D1)
 *   Triggers: cron (`scheduled`) and `POST /pull-logs`.
 *   GET `${TUNNEL_URL}/ISAPI/AccessControl/AcsEvent?format=json`
 *   with HTTP Digest (default) or Basic authentication, falls back to a POST
 *   event search when the firmware rejects GET, parses `AcsEvent.InfoList`,
 *   and UPSERTs into the D1 table `access_logs`
 *   (event_id, employee_no, card_no, event_time, door_no).
 *
 * OPERATION 2 — POST DATA (D1 / Pages → device)
 *   `POST /sync-user` accepts a JSON body (single user or `{ "users": [...] }`)
 *   or, with no body, the rows queued in D1 `device_users` (sync_status != 'synced').
 *   Converts each row to the strict Hikvision ISAPI `UserInfo` JSON and
 *   `POST ${TUNNEL_URL}/ISAPI/AccessControl/UserInfo/Record?format=json`
 *   across the tunnel (PUT fallback for firmware that rejects POST),
 *   then returns a per-user success/failure report.
 *
 * Secrets are environment bindings only — never hard-coded:
 *   TUNNEL_URL, HIK_USER, HIK_PASS  (required)
 *   API_TOKEN, HIK_AUTH_MODE, HIK_EVENT_LOOKBACK_MINUTES,
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, PAGES_ORIGIN  (optional)
 */

export interface Env {
  /** Cloudflare D1 binding (see wrangler.toml). */
  DB: D1Database;
  /** Origin of the tunnel that publishes the terminal, e.g. `https://mydomain.com`. */
  TUNNEL_URL: string;
  /** Hikvision ISAPI username (set with `wrangler secret put HIK_USER`). */
  HIK_USER: string;
  /** Hikvision ISAPI password (set with `wrangler secret put HIK_PASS`). */
  HIK_PASS: string;
  /** `digest` (default, challenge/response) or `basic` (pre-emptive). */
  HIK_AUTH_MODE?: string;
  /** Look-back window (minutes) for the POST-search fallback. Default 10. */
  HIK_EVENT_LOOKBACK_MINUTES?: string;
  /** Shared bearer token protecting the data endpoints. Strongly recommended. */
  API_TOKEN?: string;
  /** Optional Cloudflare Access service-token pair (see README, Access section). */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  /** Optional CORS allow-list for the Pages origin: `*` or comma-separated origins. */
  PAGES_ORIGIN?: string;
}

const ACS_EVENT_PATH = '/ISAPI/AccessControl/AcsEvent?format=json';
const USER_RECORD_PATH = '/ISAPI/AccessControl/UserInfo/Record?format=json';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_EVENT_BATCH = 50;
const MAX_SYNC_USERS = 100;

// ---------------------------------------------------------------------------
// MD5 (RFC 1321) — Workers' SubtleCrypto has no MD5, and HTTP Digest needs it.
// ---------------------------------------------------------------------------

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** K[i] = floor(|sin(i + 1)| * 2^32) per RFC 1321 (deterministic doubles, exact). */
const MD5_K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
  return table;
})();

/** MD5 hex digest of a UTF-8 string. Exported for tests. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  // Pad: 0x80, zeros, then the 64-bit little-endian bit length.
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const words = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, true);
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const next = (F + A + (MD5_K[i] ?? 0) + (words[g] ?? 0)) >>> 0;
      const shift = MD5_SHIFTS[i] ?? 0;
      const rotated = ((next << shift) | (next >>> (32 - shift))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotated) >>> 0;
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  let hex = '';
  for (const word of [a, b, c, d]) {
    for (let i = 0; i < 4; i += 1) hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// HTTP Digest / Basic authentication for ISAPI.
// `fetch` never answers a 401 challenge on its own, so the flow is:
// request → 401 + WWW-Authenticate → build Digest header → retry (once more
// on a stale nonce). Basic mode is pre-emptive.
// ---------------------------------------------------------------------------

/** Extracts one auth scheme's challenge from a (possibly combined) WWW-Authenticate header. */
export function extractChallenge(header: string, scheme: 'digest' | 'basic'): string | null {
  const match = new RegExp(`(^|[\\s,])${scheme}\\b`, 'i').exec(header);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = header.slice(start);
  // Stop before a second scheme (e.g. `... , qop="auth" Basic realm="x"`).
  const next = /\s+(?:Digest|Basic|Negotiate|NTLM)\b/i.exec(rest);
  const challenge = next ? rest.slice(0, next.index) : rest;
  return challenge.trim() ? challenge : null;
}

/** Parses `realm="…", nonce="…", qop=auth` style parameters (quoted or bare). */
function parseChallengeParams(challenge: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(challenge)) !== null) {
    const key = (match[1] ?? '').toLowerCase();
    params[key] = match[2] ?? match[3] ?? '';
  }
  return params;
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds the `Authorization: Digest …` header for a challenge.
 * `cnonce` is injectable for deterministic tests; production uses randomness.
 * Returns null when the challenge cannot be satisfied (unsupported qop/algorithm).
 */
export function buildDigestHeader(
  challenge: string,
  method: string,
  uri: string,
  username: string,
  password: string,
  cnonceOverride?: string,
): string | null {
  const params = parseChallengeParams(challenge);
  const realm = params.realm ?? '';
  const nonce = params.nonce;
  if (!nonce) return null;

  const algorithm = (params.algorithm ?? 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') return null; // no SHA-256 firmware yet

  // Only quality-of-protection `auth` is supported (never `auth-int`).
  let qop: string | null = null;
  if (params.qop) {
    const options = params.qop.split(',').map((value) => value.trim()).filter(Boolean);
    qop = options.includes('auth') ? 'auth' : null;
    if (!qop) return null;
  }

  const nc = '00000001';
  const cnonce = cnonceOverride ?? randomHex(8);
  let ha1 = md5Hex(`${username}:${realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5Hex(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const response = qop
    ? md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5Hex(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${escapeQuoted(username)}"`,
    `realm="${escapeQuoted(realm)}"`,
    `nonce="${escapeQuoted(nonce)}"`,
    `uri="${escapeQuoted(uri)}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (params.opaque) parts.push(`opaque="${escapeQuoted(params.opaque)}"`);
  return `Digest ${parts.join(', ')}`;
}

function basicHeader(username: string, password: string): string {
  const token = btoa(`${username}:${password}`); // only for latin-1 credentials; Digest is the default
  return `Basic ${token}`;
}

interface IsapiRequest {
  /** Path incl. query string, e.g. `/ISAPI/AccessControl/AcsEvent?format=json`. */
  path: string;
  method?: string;
  /** JSON request body (also sets Content-Type). */
  json?: unknown;
  timeoutMs?: number;
}

/**
 * Performs an authenticated request across the tunnel to the device.
 * Attaches Cloudflare Access service-token headers when configured (needed if
 * the tunnel hostname sits behind a Zero Trust Access application).
 */
async function isapiFetch(env: Env, request: IsapiRequest): Promise<Response> {
  const base = (env.TUNNEL_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('TUNNEL_URL is not configured');
  const url = `${base}${request.path}`;
  const method = (request.method ?? 'GET').toUpperCase();
  const body = request.json === undefined ? undefined : JSON.stringify(request.json);
  const uri = request.path; // Digest uri must echo path + query

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'hikvision-tunnel-worker/1.0',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (env.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;

  const username = env.HIK_USER ?? '';
  const password = env.HIK_PASS ?? '';
  const mode = (env.HIK_AUTH_MODE ?? 'digest').toLowerCase();
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const send = (extra: Record<string, string>): Promise<Response> =>
    fetch(url, {
      method,
      headers: { ...headers, ...extra },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });

  let auth: Record<string, string> = {};
  if (mode === 'basic' && username) auth = { Authorization: basicHeader(username, password) };
  let response = await send(auth);

  if (response.status === 401 && username && password) {
    const challenge = response.headers.get('WWW-Authenticate') ?? '';
    const digestChallenge = extractChallenge(challenge, 'digest');
    const digestHeader = digestChallenge
      ? buildDigestHeader(digestChallenge, method, uri, username, password)
      : null;
    if (digestHeader) {
      response = await send({ Authorization: digestHeader });
      if (response.status === 401) {
        // Stale nonce (device clock/nonce rotation): answer the fresh challenge once.
        const fresh = response.headers.get('WWW-Authenticate') ?? '';
        const freshChallenge = extractChallenge(fresh, 'digest');
        const freshHeader = freshChallenge
          ? buildDigestHeader(freshChallenge, method, uri, username, password)
          : null;
        if (freshHeader) response = await send({ Authorization: freshHeader });
      }
    } else if (extractChallenge(challenge, 'basic')) {
      response = await send({ Authorization: basicHeader(username, password) });
    }
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return { __unparsed: clipped };
  }
}

// ---------------------------------------------------------------------------
// AcsEvent parsing (Operation 1)
// ---------------------------------------------------------------------------

export interface DeviceAcsEvent {
  /** Explicit device event id when the firmware sends one; otherwise null. */
  explicitId: string | null;
  monitorIndex: string | null;
  time: string;
  employeeNo: string;
  cardNo: string | null;
  doorNo: string | null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function pick(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Reads `AcsEvent.InfoList` (list responses) or `AcsEvent.AcsEventInfo`
 * (single-event responses) into plain records.
 * Returns null when the payload has no `AcsEvent` node at all — callers use
 * that to decide whether to fall back to a POST search.
 */
export function collectAcsEvents(payload: unknown): DeviceAcsEvent[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const acs = root.AcsEvent;
  if (!acs || typeof acs !== 'object') return null;
  const acsRecord = acs as Record<string, unknown>;

  const items: unknown[] = [];
  if (Array.isArray(acsRecord.InfoList)) items.push(...acsRecord.InfoList);
  if (acsRecord.AcsEventInfo && typeof acsRecord.AcsEventInfo === 'object') {
    items.push(acsRecord.AcsEventInfo);
  }

  const events: DeviceAcsEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const event: DeviceAcsEvent = {
      explicitId: pick(record, ['eventID', 'eventId', 'event_id']),
      monitorIndex: pick(record, ['monitorIndex']),
      time: pick(record, ['time', 'eventTime', 'dateTime']) ?? new Date().toISOString(),
      employeeNo: pick(record, ['employeeNo', 'employeeNoString']) ?? '',
      cardNo: pick(record, ['cardNo', 'cardNoString']),
      doorNo: pick(record, ['doorNo']),
    };
    if (!event.employeeNo && !event.cardNo && !event.explicitId) continue; // unattributable
    events.push(event);
  }
  return events;
}

/** Deterministic event id so overlapping polls upsert instead of duplicating. */
async function eventIdFor(event: DeviceAcsEvent): Promise<string> {
  if (event.explicitId) return event.explicitId;
  const material = [
    event.time,
    event.employeeNo,
    event.cardNo ?? '',
    event.doorNo ?? '',
    event.monitorIndex ?? '',
  ].join('|');
  return `hik_${(await sha256Hex(material)).slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// D1 schema (idempotent; `schema.sql` exists for one-shot provisioning too)
// ---------------------------------------------------------------------------

let schemaReady = false;

async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS access_logs (
      event_id TEXT PRIMARY KEY,
      employee_no TEXT,
      card_no TEXT,
      event_time TEXT NOT NULL,
      door_no TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_access_logs_time ON access_logs(event_time DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_access_logs_employee ON access_logs(employee_no)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS device_users (
      employee_no TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      card_no TEXT,
      card_type TEXT NOT NULL DEFAULT 'normalCard',
      user_type TEXT NOT NULL DEFAULT 'normal',
      group_no TEXT NOT NULL DEFAULT '1',
      door_no INTEGER NOT NULL DEFAULT 1,
      plan_template_no TEXT NOT NULL DEFAULT '1',
      valid_start TEXT,
      valid_end TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS device_status (
      id TEXT PRIMARY KEY,
      last_pull_at TEXT,
      last_pull_ok INTEGER,
      last_error TEXT,
      last_event_count INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// OPERATION 1 — PULL: device → D1 `access_logs`
// ---------------------------------------------------------------------------

export interface PullSummary {
  ok: boolean;
  mode: 'get' | 'search' | 'none';
  fetched: number;
  persisted: number;
  error?: string;
}

interface EventSearchWindow {
  startTime: string;
  endTime: string;
}

/** `YYYY-MM-DDTHH:mm:ss+00:00` — the shape Hikvision search criteria expect. */
function isapiTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`
  );
}

function searchWindow(env: Env): EventSearchWindow {
  const lookbackMinutes = Math.min(
    1440,
    Math.max(1, Number.parseInt(env.HIK_EVENT_LOOKBACK_MINUTES ?? '10', 10) || 10),
  );
  const end = new Date();
  const start = new Date(end.getTime() - lookbackMinutes * 60_000);
  return { startTime: isapiTimestamp(start), endTime: isapiTimestamp(end) };
}

async function recordPullStatus(env: Env, summary: PullSummary): Promise<void> {
  try {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO device_status (id, last_pull_at, last_pull_ok, last_error, last_event_count, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_pull_at = excluded.last_pull_at,
         last_pull_ok = excluded.last_pull_ok,
         last_error = excluded.last_error,
         last_event_count = excluded.last_event_count,
         updated_at = excluded.updated_at`,
    )
      .bind(now, summary.ok ? 1 : 0, summary.error ?? null, summary.persisted, now)
      .run();
  } catch (error) {
    console.error('[hikvision-bridge] device_status update failed', error);
  }
}

/**
 * Pulls AcsEvents from the terminal and upserts them into `access_logs`.
 * GET first (as specified); if the firmware rejects GET or returns a payload
 * without an `AcsEvent` node, falls back to the POST search with a time window.
 */
export async function pullAccessLogs(env: Env): Promise<PullSummary> {
  let summary: PullSummary = { ok: false, mode: 'none', fetched: 0, persisted: 0 };
  try {
    await ensureSchema(env);

    let mode: 'get' | 'search' = 'get';
    let response = await isapiFetch(env, { path: ACS_EVENT_PATH, method: 'GET' });
    let payload = await readJson(response);
    let events = response.ok ? collectAcsEvents(payload) : null;

    const fallbackStatuses = [400, 405, 501];
    if (events === null && (response.ok || fallbackStatuses.includes(response.status))) {
      // Firmware refused GET (or answered without an AcsEvent node): POST search.
      mode = 'search';
      const window = searchWindow(env);
      response = await isapiFetch(env, {
        path: ACS_EVENT_PATH,
        method: 'POST',
        json: {
          AcsEvent: {
            searchID: crypto.randomUUID(),
            searchResultPosition: 0,
            maxResults: MAX_EVENT_BATCH,
            startTime: window.startTime,
            endTime: window.endTime,
          },
        },
      });
      payload = await readJson(response);
      events = response.ok ? collectAcsEvents(payload) : null;
    }

    if (!response.ok || events === null) {
      const unparsed = payload && typeof payload === 'object' && '__unparsed' in (payload as object)
        ? `: ${String((payload as { __unparsed: unknown }).__unparsed)}`
        : '';
      const statusText = response.status === 401
        ? 'authentication failed — check HIK_USER/HIK_PASS'
        : `device responded ${response.status} ${response.statusText}`;
      throw new Error(`${statusText}${unparsed}`);
    }

    const rows = events.slice(0, MAX_EVENT_BATCH);
    const insert = env.DB.prepare(
      `INSERT INTO access_logs (event_id, employee_no, card_no, event_time, door_no)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         employee_no = excluded.employee_no,
         card_no = excluded.card_no,
         event_time = excluded.event_time,
         door_no = excluded.door_no`,
    );
    const statements: D1PreparedStatement[] = [];
    for (const event of rows) {
      statements.push(
        insert.bind(await eventIdFor(event), event.employeeNo || null, event.cardNo, event.time, event.doorNo),
      );
    }
    if (statements.length > 0) await env.DB.batch(statements);

    summary = { ok: true, mode, fetched: events.length, persisted: rows.length };
    await recordPullStatus(env, summary);
    return summary;
  } catch (error) {
    summary = {
      ...summary,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    await recordPullStatus(env, summary);
    return summary;
  }
}

// ---------------------------------------------------------------------------
// OPERATION 2 — POST: D1 / Pages → device `UserInfo/Record`
// ---------------------------------------------------------------------------

export interface SyncUserInput {
  employeeNo: string;
  name?: string;
  cardNo?: string | null;
  cardType?: string;
  userType?: string;
  groupNo?: string;
  doorNo?: number | string;
  planTemplateNo?: string;
  validStart?: string;
  validEnd?: string;
}

interface StagedUserRow {
  employee_no: string;
  name: string;
  card_no: string | null;
  card_type: string | null;
  user_type: string | null;
  group_no: string | null;
  door_no: number | null;
  plan_template_no: string | null;
  valid_start: string | null;
  valid_end: string | null;
}

export interface SyncUserResult {
  employeeNo: string;
  ok: boolean;
  statusCode?: number;
  statusString?: string;
  error?: string;
}

/** Validates one incoming user object; returns null when unusable. */
export function toSyncUser(value: unknown): SyncUserInput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const employeeNo = text(record.employeeNo ?? record.employee_no);
  if (!employeeNo) return null;
  const user: SyncUserInput = { employeeNo };
  const name = text(record.name);
  if (name) user.name = name;
  const cardNo = text(record.cardNo ?? record.card_no);
  if (cardNo) user.cardNo = cardNo;
  const cardType = text(record.cardType ?? record.card_type);
  if (cardType) user.cardType = cardType;
  const userType = text(record.userType ?? record.user_type);
  if (userType) user.userType = userType;
  const groupNo = text(record.groupNo ?? record.group_no);
  if (groupNo) user.groupNo = groupNo;
  const doorNo = text(record.doorNo ?? record.door_no);
  if (doorNo) user.doorNo = Number.parseInt(doorNo, 10) || 1;
  const planTemplateNo = text(record.planTemplateNo ?? record.plan_template_no);
  if (planTemplateNo) user.planTemplateNo = planTemplateNo;
  const validStart = text(record.validStart ?? record.valid_start);
  if (validStart) user.validStart = validStart;
  const validEnd = text(record.validEnd ?? record.valid_end);
  if (validEnd) user.validEnd = validEnd;
  return user;
}

/**
 * Converts an internal user into the strict ISAPI `UserInfo` JSON document
 * accepted by `/ISAPI/AccessControl/UserInfo/Record?format=json`.
 */
export function buildUserInfoRecord(user: SyncUserInput): { UserInfo: Record<string, unknown> } {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const userInfo: Record<string, unknown> = {
    employeeNo: String(user.employeeNo),
    name: user.name?.trim() || String(user.employeeNo),
    userType: user.userType ?? 'normal',
    Valid: {
      enable: true,
      startTime: user.validStart ?? now,
      endTime: user.validEnd ?? '2099-12-31T23:59:59+00:00',
    },
    doorRight: '1',
    RightPlan: [
      {
        doorNo: Number.isFinite(Number(user.doorNo)) ? Number(user.doorNo) : 1,
        planTemplateNo: String(user.planTemplateNo ?? '1'),
      },
    ],
    groupNo: String(user.groupNo ?? '1'),
  };
  if (user.cardNo) {
    userInfo.cardInfos = [{ cardNo: String(user.cardNo), cardType: user.cardType ?? 'normalCard' }];
  }
  return { UserInfo: userInfo };
}

function isResponseStatusOk(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const status = (payload as Record<string, unknown>).ResponseStatus;
  if (!status || typeof status !== 'object') return false;
  const record = status as Record<string, unknown>;
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : Number(record.statusCode);
  const subStatusCode = typeof record.subStatusCode === 'string' ? record.subStatusCode : '';
  return subStatusCode === 'ok' || statusCode === 1 || statusCode === 200;
}

function statusMessageOf(payload: unknown): { statusCode?: number; statusString?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const status = (payload as Record<string, unknown>).ResponseStatus;
  if (!status || typeof status !== 'object') return {};
  const record = status as Record<string, unknown>;
  const result: { statusCode?: number; statusString?: string } = {};
  const statusCode = Number(record.statusCode);
  if (Number.isFinite(statusCode)) result.statusCode = statusCode;
  const statusString = text(record.statusString) ?? text(record.subStatusCode);
  if (statusString) result.statusString = statusString;
  return result;
}

/** Pushes one user to the device; answers POST, falls back to PUT on 405/501. */
async function pushUserToDevice(env: Env, user: SyncUserInput): Promise<SyncUserResult> {
  const employeeNo = user.employeeNo;
  const record = buildUserInfoRecord(user);
  try {
    let response = await isapiFetch(env, { path: USER_RECORD_PATH, method: 'POST', json: record });
    if (response.status === 405 || response.status === 501) {
      // Some firmware only accepts PUT for add/modify.
      response = await isapiFetch(env, { path: USER_RECORD_PATH, method: 'PUT', json: record });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const info = statusMessageOf(payload);
      if (response.status === 401) {
        return { employeeNo, ok: false, error: 'authentication failed — check HIK_USER/HIK_PASS' };
      }
      return {
        employeeNo,
        ok: false,
        statusCode: info.statusCode ?? response.status,
        statusString: info.statusString ?? `device responded ${response.status}`,
      };
    }
    if (!isResponseStatusOk(payload)) {
      const unparsed = payload && typeof payload === 'object' && '__unparsed' in (payload as object)
        ? String((payload as { __unparsed: unknown }).__unparsed)
        : 'unexpected device response';
      const info = statusMessageOf(payload);
      return {
        employeeNo,
        ok: false,
        statusCode: info.statusCode,
        statusString: info.statusString ?? unparsed,
        error: info.statusString ?? unparsed,
      };
    }
    const info = statusMessageOf(payload);
    return { employeeNo, ok: true, statusCode: info.statusCode ?? 1, statusString: info.statusString ?? 'OK' };
  } catch (error) {
    return { employeeNo, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function stagedUsers(env: Env): Promise<SyncUserInput[]> {
  const result = await env.DB.prepare(
    `SELECT employee_no, name, card_no, card_type, user_type, group_no, door_no,
            plan_template_no, valid_start, valid_end
       FROM device_users
      WHERE sync_status != 'synced'
      ORDER BY updated_at ASC
      LIMIT ?`,
  )
    .bind(MAX_SYNC_USERS)
    .all<StagedUserRow>();
  return result.results
    .map((row) => toSyncUser(row))
    .filter((user): user is SyncUserInput => user !== null);
}

async function markStaged(env: Env, results: SyncUserResult[]): Promise<void> {
  const statements = results.map((result) =>
    env.DB.prepare(
      result.ok
        ? `UPDATE device_users SET sync_status = 'synced', last_error = NULL, updated_at = datetime('now') WHERE employee_no = ?`
        : `UPDATE device_users SET sync_status = 'failed', last_error = ?, updated_at = datetime('now') WHERE employee_no = ?`,
    ).bind(...(result.ok ? [result.employeeNo] : [result.error ?? result.statusString ?? 'failed', result.employeeNo])),
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

/** Operation 2: resolve input (body or staged D1 rows) and push to the device. */
async function handleSyncUser(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (request.method === 'GET') {
    const pending = await env.DB.prepare(
      `SELECT employee_no, name, card_no, sync_status, last_error, updated_at
         FROM device_users WHERE sync_status != 'synced' ORDER BY updated_at ASC LIMIT ?`,
    )
      .bind(MAX_SYNC_USERS)
      .all();
    return json({ pending: pending.results }, 200, cors);
  }

  const raw = await request.text();
  if (raw.length > 200_000) return json({ error: 'Request body too large' }, 413, cors);

  let users: SyncUserInput[] = [];
  let source: 'body' | 'd1' = 'body';
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return json({ error: 'Body must be valid JSON' }, 400, cors);
    }
    const candidates: unknown[] =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { users?: unknown[] }).users)
        ? (parsed as { users: unknown[] }).users
        : [parsed];
    for (const candidate of candidates.slice(0, MAX_SYNC_USERS)) {
      const user = toSyncUser(candidate);
      if (user) users.push(user);
    }
    if (users.length === 0) {
      return json(
        { error: 'Provide at least one user with an employeeNo, or send an empty body to sync queued D1 rows' },
        400,
        cors,
      );
    }
  } else {
    source = 'd1';
    await ensureSchema(env);
    users = await stagedUsers(env);
    if (users.length === 0) {
      return json(
        { ok: true, source, synced: 0, failed: 0, results: [], message: 'No pending users in D1 device_users' },
        200,
        cors,
      );
    }
  }

  const results: SyncUserResult[] = [];
  for (const user of users) results.push(await pushUserToDevice(env, user));
  if (source === 'd1') await markStaged(env, results);

  const synced = results.filter((result) => result.ok).length;
  const failed = results.length - synced;
  const payload = { ok: failed === 0, source, synced, failed, results };
  return json(payload, failed === 0 ? 200 : 502, cors);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowList = (env.PAGES_ORIGIN ?? '').trim();
  const allowed =
    allowList === '' || allowList === '*' || allowList.split(',').some((value) => value.trim() === origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/** Bearer (or X-Api-Token) check — enforced only when API_TOKEN is configured. */
function isAuthorized(request: Request, env: Env): boolean {
  const token = env.API_TOKEN;
  if (!token) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '');
  const presented = bearer?.[1] ?? request.headers.get('X-Api-Token') ?? '';
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(token);
  const presentedBytes = encoder.encode(presented);
  if (expectedBytes.length !== presentedBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedBytes.length; i += 1) {
    diff |= (expectedBytes[i] ?? 0) ^ (presentedBytes[i] ?? 0);
  }
  return diff === 0;
}

async function handleHealth(env: Env, cors: Record<string, string>): Promise<Response> {
  await ensureSchema(env);
  const status = await env.DB.prepare(`SELECT last_pull_at, last_pull_ok, last_error, last_event_count, updated_at FROM device_status WHERE id = 'default'`).first();
  const logCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_logs`).first<{ n: number }>();
  return json(
    {
      ok: true,
      tunnelConfigured: Boolean((env.TUNNEL_URL ?? '').trim()),
      deviceAuthConfigured: Boolean(env.HIK_USER && env.HIK_PASS),
      endpointAuthConfigured: Boolean(env.API_TOKEN),
      accessServiceTokenConfigured: Boolean(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET),
      lastPull: status ?? null,
      accessLogRows: logCount?.n ?? 0,
    },
    200,
    cors,
  );
}

async function handleAccessLogs(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  await ensureSchema(env);
  const url = new URL(request.url);
  const requested = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(requested) ? requested : 50));
  const result = await env.DB.prepare(
    `SELECT event_id, employee_no, card_no, event_time, door_no, synced_at
       FROM access_logs ORDER BY event_time DESC, rowid DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return json({ logs: result.results }, 200, cors);
}

// ---------------------------------------------------------------------------
// Handler entry points
// ---------------------------------------------------------------------------

/**
 * Route path normalisation: collapses duplicate slashes (wrangler prints the
 * Worker URL with a trailing slash, so CI probes arrive as `//health`) and
 * strips trailing slashes, so `/health`, `/health/` and `//health` all route.
 */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // GET / and GET /health are unauthenticated liveness probes.
  if (request.method === 'GET' && (path === '/' || path === '/health')) {
    if (path === '/') {
      return json(
        {
          service: 'hikvision-tunnel-worker',
          operations: {
            'POST /pull-logs': 'Operation 1 — pull AcsEvents from the device into D1 access_logs',
            'POST /sync-user': 'Operation 2 — push users (body or queued D1 device_users) to the device',
            'GET /access-logs': 'read back D1 access_logs',
            'GET /sync-user': 'list D1 device_users not yet synced',
            'GET /health': 'configuration + last pull status',
          },
        },
        200,
        cors,
      );
    }
    return handleHealth(env, cors);
  }

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  if (path === '/pull-logs' && request.method === 'POST') {
    const summary = await pullAccessLogs(env);
    return json(summary, summary.ok ? 200 : 502, cors);
  }
  if (path === '/sync-user' && (request.method === 'POST' || request.method === 'GET')) {
    return handleSyncUser(request, env, cors);
  }
  if (path === '/access-logs' && request.method === 'GET') {
    return handleAccessLogs(request, env, cors);
  }

  return json({ error: `No route for ${request.method} ${path}` }, 404, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[hikvision-bridge] request failed', message);
      return json({ error: message }, 500);
    }
  },

  /** Cron: Operation 1 on a schedule (see `[triggers] crons` in wrangler.toml). */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pullAccessLogs(env).then((summary) => {
        console.log(`[hikvision-bridge] scheduled pull ${JSON.stringify(summary)}`);
      }),
    );
  },
};
