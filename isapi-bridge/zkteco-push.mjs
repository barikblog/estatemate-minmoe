/**
 * EstateMate ZKTeco PUSH (ADMS) bridge
 *
 * ZKTeco's "PUSH" protocol (vendor name: *Attendance/Security PUSH
 * Communication Protocol*; the feature on the terminal is "ADMS" / "Cloud Server"
 * / "iClock Proxy") is plain HTTP with an ASCII body, and — unlike Hikvision
 * ISAPI — **the terminal always dials the server**. Every request, including
 * every command the server wants to run, is initiated by the device
 * (vendor doc §2 "Features": "All actions, such as data upload and command
 * delivered by the server, are all initiated by the client"). There is no
 * inbound connection to a terminal.
 *
 * That shapes this whole module:
 *   - we HOST an HTTP listener the terminals are pointed at (LAN only), and
 *   - a command we must deliver can only travel *downward* the next time the
 *     terminal asks for one, so writes are queued and confirmed asynchronously.
 *     A queue that a terminal has not polled yet is not a failure, and a queue
 *     the terminal answered `Return=0` for is not yet a verified credential —
 *     see the notes on `Return` below.
 *
 * Endpoints (vendor doc §7.1 / §7.4 / §10 / §11.1; confirmed against
 * s0x90/zkteco-adms on SpeedFace-V5L-RFID and ZAM180-NF firmware):
 *   GET  /iclock/cdata?SN=..&pushver=..&options=all   initial interaction (§7.1)
 *   POST /iclock/registry?SN=..                        device parameters (§7.4)
 *   POST /iclock/cdata?SN=..&table=..&Stamp=..         uploads (§10)
 *   GET  /iclock/getrequest?SN=..                      cached commands (§11.1)
 *   POST /iclock/devicecmd?SN=..&Return=..&ID=..       command result (§10.4)
 *
 * The numeric-PIN rule (§ "PIN policy" below) is the reason this file refuses
 * writes that the Hikvision path would happily attempt. Read it before changing
 * `validateTerminalPin`.
 *
 * STATUS: the wire formats here come from the vendor specification and from an
 * implementation confirmed on real firmware; **EstateMate has not yet driven a
 * physical ZKTeco terminal with this code.** `docs/device-profiles/ZKTECO-PUSH.md`
 * records exactly which parts are bench-tested and which are not. Do not
 * describe this transport as working on a specific model until that file says
 * someone has stood in front of one.
 */

/** Field separator of a data record. The vendor doc calls these out explicitly. */
const SP = ' ';
const HT = '\t';
const LF = '\n';

/** §5 Definition: SP is a space, HT a horizontal tab, LF a line feed. */
export const SEPARATORS = { SP, HT, LF };

/**
 * Punch-list of the payload separators that must never appear inside a field
 * we interpolate: a `Name` containing a newline would be read as the next
 * record, and a tab as the next field, so one resident's name could silently
 * corrupt (or forge) another person's credential line.
 */
const FORBIDDEN_FIELD_CHARS = /[\t\n\r]/;

/** Command result codes the vendor doc / field reports give a meaning to. */
export const RETURN_MEANINGS = {
  0: 'applied by the terminal',
  '-1': 'command not supported, or the terminal has no data for it',
  '-2': 'file operation failed',
  '-1002': 'invalid command syntax (the terminal refused to parse it)',
  '-1004': 'this table or feature is not available on this model',
};

/** EstateMate's own cap, from `src/employee-id.ts`: a terminal cannot store more. */
export const PIN_MAX = 32;

/* ------------------------------------------------------------------------- *
 * Device options and the numeric-PIN rule
 * ------------------------------------------------------------------------- */

/**
 * Parses a §7.4 registration body: comma-separated `key=value`, where a key may
 * carry a `~` prefix meaning "optional, only sent when the firmware sets it".
 * The tilde is dropped (as the field-confirmed implementations do) so callers
 * never have to know which convention one model happened to use.
 */
export function parseRegistryBody(body) {
  const options = {};
  for (const pair of String(body ?? '').split(',')) {
    const trimmed = pair.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).replace(/^~/, '').trim();
    if (!key) continue;
    options[key] = decodeRegistryValue(trimmed.slice(index + 1).trim());
  }
  return options;
}

/** §7.4 sends some values URI-encoded (names, in particular). */
function decodeRegistryValue(value) {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * PIN policy for a terminal, read from what the terminal itself reported.
 *
 * `StringPinFunOn` is the field the vendor doc defines as "Specify whether to
 * support the string-type user ID", and it is pushed by the device at
 * registration (§7.4). A terminal that does not say `1` is a **digits-only
 * User ID** terminal.
 *
 * This is the whole reason ZKTeco support is not a one-line adapter over the
 * Hikvision path. EstateMate's Employee ID is deliberately terminal-safe for
 * ISAPI — `[A-Za-z0-9]{1,32}`, and by default a person's UUID without its
 * hyphens, which is 32 *hex* characters and so full of letters. A Hex string is
 * exactly what a `StringPinFunOn=0` terminal cannot hold. Silently truncating or
 * rewriting it would file the resident under a number that resolves to somebody
 * else at the gate, which is the failure mode PR #38 exists to prevent; so the
 * bridge refuses and explains instead.
 */
export function pinPolicy(options) {
  const reported = String(options?.StringPinFunOn ?? '').trim();
  return {
    // Absent is NOT the same as 0: an old firmware that never reports the flag
    // is treated as digits-only, because that is the documented default
    // behaviour and the conservative answer for a gate.
    allowStringPin: reported === '1' || reported === 'true',
    stringPinReported: reported !== '',
    maxPinLength: positiveInt(options?.MaxPinWidth) ?? positiveInt(options?.PIN2Width) ?? null,
    source: reported !== '' ? 'StringPinFunOn' : 'default (terminal did not report StringPinFunOn)',
  };
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Digits, no leading zero, at most `max` long — the shape a ZK User ID takes. */
const NUMERIC_PIN = /^[1-9][0-9]*$/;

/**
 * Decides whether a terminal may be handed this Employee ID as its User ID (PIN).
 *
 * Returns `{ ok, pin, error }`. `error` is written for an operator to read in
 * the portal, because the fix (give the person a numeric Employee ID) is a
 * portal action, not a field trip.
 */
export function validateTerminalPin(candidate, options) {
  const value = String(candidate ?? '').trim();
  if (!value) return { ok: false, error: 'the terminal PIN (EstateMate Employee ID) is missing; refusing to guess which person owns this credential' };
  const policy = pinPolicy(options);
  if (value.length > PIN_MAX) {
    return { ok: false, error: `Employee ID is ${value.length} characters; a ZKTeco terminal cannot store more than ${PIN_MAX}` };
  }
  if (policy.maxPinLength && value.length > policy.maxPinLength) {
    return { ok: false, error: `Employee ID is ${value.length} characters; this terminal reports a maximum User ID length of ${policy.maxPinLength}` };
  }
  if (NUMERIC_PIN.test(value)) return { ok: true, pin: value };
  if (policy.allowStringPin) {
    // The terminal says it stores string User IDs, but the separators of the
    // command format still apply.
    if (FORBIDDEN_FIELD_CHARS.test(value)) {
      return { ok: false, error: 'Employee ID contains a tab or line break, which the PUSH command format cannot carry' };
    }
    return { ok: true, pin: value, stringPin: true };
  }
  const kind = /[A-Za-z]/.test(value) ? 'letters' : 'a leading zero or other non-digit';
  return {
    ok: false,
    error:
      `this terminal only accepts a numeric User ID (StringPinFunOn=${policy.stringPinReported ? '0' : 'not reported'}), ` +
      `and the EstateMate Employee ID "${value}" contains ${kind}. Set a numeric Employee ID for this person, ` +
      `or enable alphanumeric User IDs on the terminal if its firmware supports them`,
  };
}

/* ------------------------------------------------------------------------- *
 * Command encoding
 * ------------------------------------------------------------------------- */

/**
 * `DATA UPDATE USERINFO` (§12.1.1). Fields are HT-separated; the record is one
 * line. Only the fields we actually hold are emitted — the doc's own examples
 * send a subset, and inventing a `Passwd` for a resident would be worse.
 *
 * The verb is spelled in full on purpose: `DATA DEL USERINFO` and the datasheet's
 * `USER ADD` / `USER DEL` are rejected by real firmware with -1002, which reads
 * like a broken cable and is neither.
 */
export function encodeUserUpdate(pin, fields = {}) {
  const parts = [`PIN=${pin}`];
  const push = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    assertFieldSafe(name, value);
    parts.push(`${name}=${value}`);
  };
  assertFieldSafe('PIN', pin);
  push('Name', fields.name);
  push('Pri', fields.privilege ?? 0);
  push('Card', fields.card);
  push('Grp', fields.group ?? 1);
  // Time zone 1 is the "always granted" schedule on these firmwares: a person
  // with no TZ entry is a person who cannot open the door at 03:00.
  push('TZ', fields.timezone ?? '0000000100000000');
  push('Verify', fields.verify ?? 0);
  // A card that is not enabled is a card that does not open the gate, and the
  // terminal reports success anyway.
  push('Enable', fields.enabled === false ? 0 : 1);
  if (fields.startDatetime) push('StartDatetime', fields.startDatetime);
  if (fields.endDatetime) push('EndDatetime', fields.endDatetime);
  return `DATA${SP}UPDATE${SP}USERINFO${SP}${parts.join(HT)}`;
}

/** `DATA DELETE USERINFO PIN=..` — takes the person, their card and their templates. */
export function encodeUserDelete(pin) {
  return `DATA${SP}DELETE${SP}USERINFO${SP}PIN=${pin}`;
}

/**
 * Card-only removal. There is no documented card table in the PUSH protocol, so
 * the honest implementation removes the person (whose card travels with them)
 * rather than inventing `DELETE CARDINFO` that would come back -1004.
 */
export function encodeCardRemoval(pin) {
  return encodeUserDelete(pin);
}

/** `GET OPTION FROM <key>` (§12.5.2) — used to read what registration omitted. */
export function encodeGetOption(key) {
  assertFieldSafe('option key', key);
  return `GET${SP}OPTION${SP}FROM${SP}${key}`;
}

/**
 * A field that would break the line framing is refused, never rewritten.
 *
 * `sanitizeField` is the *conservative* half of this: it collapses runs of
 * whitespace so a caller that genuinely wants a printable form can have one.
 * Command builders do not use it on identity data, because quietly turning
 * "Amina\nC:9:..." into "Amina C:9:..." would file a resident under a name the
 * portal no longer shows — the exact class of silent divergence this project
 * refuses for card numbers and Employee IDs. Identity fields go through
 * `assertFieldSafe` and the operator sees the rejection instead.
 */
export function sanitizeField(value) {
  return String(value).replace(/[\t\n\r]+/g, ' ').trim();
}

/** Thrown when a value carries a character the PUSH record format cannot hold. */
export class PushFieldError extends Error {}

export function assertFieldSafe(name, value) {
  if (value !== undefined && value !== null && FORBIDDEN_FIELD_CHARS.test(String(value))) {
    throw new PushFieldError(`"${name}" contains a tab or a line break, which the ZKTeco PUSH record format cannot carry; fix it in EstateMate and sync again (nothing was written to the terminal)`);
  }
}

/* ------------------------------------------------------------------------- *
 * Upload parsing (§10)
 * ------------------------------------------------------------------------- */

/**
 * Splits an upload body into records. §10.5/§12.1 use one record per LF line and
 * HT-separated `key=value` pairs; a bare `OK` (a terminal with nothing to send)
 * and a `ATTLOG`-style tab-separated list both occur in the field.
 */
export function parseDataRecords(body) {
  const text = String(body ?? '').trim();
  if (!text || text === 'OK') return [];
  const records = [];
  for (const rawLine of text.split(LF)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.includes('=')) {
      const record = {};
      for (const field of line.split(HT)) {
        const index = field.indexOf('=');
        if (index <= 0) continue;
        const key = field.slice(0, index).trim();
        let value = field.slice(index + 1).trim();
        // Some firmwares URL-encode names, and the doc says non-ASCII user
        // names are encoded rather than raw.
        if (value.includes('%')) {
          try {
            value = decodeURIComponent(value);
          } catch {
            /* keep as-is */
          }
        }
        record[key] = value;
      }
      if (Object.keys(record).length) records.push(record);
    } else {
      // §10.2 form: UserID<TAB>Timestamp<TAB>Status<TAB>VerifyMode<TAB>WorkCode
      const columns = line.split(HT);
      if (columns.length >= 2) {
        records.push({ PIN: columns[0], Time: columns[1], Status: columns[2], VerifyMode: columns[3], WorkCode: columns[4] });
      }
    }
  }
  return records;
}

/** Terminal time is "YYYY-MM-DD HH:mm:ss"; the terminal's own zone is assumed. */
export function pushTimestampToIso(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return new Date().toISOString();
  if (/^\d{9,11}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
  }
  const [, y, mo, d, h, mi, s] = match;
  // Built as local time on purpose: the terminal clock is wall-clock at the
  // gate, and EstateMate stores UTC. `Z` would re-read it as UTC and slide every
  // event by the estate's offset, which is how an estate ends up with punches
  // filed against the wrong day.
  const asUtcGuess = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${localOffsetSuffix()}`);
  return Number.isNaN(asUtcGuess.valueOf()) ? new Date().toISOString() : asUtcGuess.toISOString();
}

function localOffsetSuffix() {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * §10.2 real-time event -> the document shape `src/hikvision.ts` normalises.
 *
 * The Worker resolves fields through the device profile's aliases, so emitting a
 * Hikvision-shaped document is not a lie about the vendor: it is the internal
 * event envelope EstateMate already understands, and the `zkteco_push` profile
 * carries the ZKTeco spellings too.
 *
 * `verifyMode` maps to the doc's Appendix 3 bit positions for the modes EstateMate
 * has a credential story for; anything else stays `unknown` rather than being
 * guessed into "card", because a mislabelled credential type at a gate is an
 * audit finding.
 */
const VERIFY_MODE_LABELS = {
  0: 'password',
  1: 'fingerprint',
  2: 'card',
  4: 'pin',
  15: 'face',
  16: 'palm_vein',
  22: 'fingerprint_or_card',
};

export function accessEventDocument(record, { profileKey = 'zkteco_push' } = {}) {
  const pin = record.PIN ?? record.UserID ?? record.pin ?? null;
  const card = record.Card ?? record.cardNo ?? record.CardNo ?? null;
  const verifyMode = record.VerifyMode ?? record.verifyMode ?? null;
  const status = record.Status ?? record.status ?? null;
  // Status is the attendance in/out state (§10.2). Access terminals report the
  // event type instead; a denied attempt arrives as an event code, which this
  // first cut does not decode, so it is preserved raw rather than mapped.
  const label = status === null ? null : Number(status);
  const direction = label === null ? null : label % 2 === 0 ? 'entry' : 'exit';
  return {
    eventType: 'access_controller_event',
    majorEventType: 5,
    minorEventType: 0,
    accessControllerEvent: {
      employeeNoString: pin ?? '',
      cardNo: card ?? '',
      dateTime: pushTimestampToIso(record.Time ?? record.DateTime ?? record.timestamp),
      verifyMode: verifyMode === null ? '' : String(verifyMode),
      doorNo: 1,
      // Raw terminal fields ride along so a later firmware pass can decode the
      // event codes without the data having to be invented here.
      workCode: record.WorkCode ?? '',
      statusCode: status === null ? '' : String(status),
      profileKey,
    },
  };
}

export function verifyModeLabel(verifyMode) {
  if (verifyMode === null || verifyMode === undefined || verifyMode === '') return 'unknown';
  return VERIFY_MODE_LABELS[Number(verifyMode)] ?? `unknown(${verifyMode})`;
}

/* ------------------------------------------------------------------------- *
 * Command queue
 * ------------------------------------------------------------------------- */

/**
 * One queue per terminal, keyed by the serial number the terminal reports.
 *
 * The queue exists because the protocol is asynchronous: `/iclock/getrequest`
 * drains what has accumulated, and `/iclock/devicecmd` confirms it later. An
 * operation is `applied` only on `Return=0`.
 */
export function createCommandQueue({ now = Date.now, maxPerDevice = 200 } = {}) {
  const bySerial = new Map();
  let nextId = 1;

  const bucket = (serial) => {
    const key = String(serial ?? '').trim();
    if (!key) throw new Error('a push command needs the terminal serial number');
    if (!bySerial.has(key)) bySerial.set(key, { nextId: 1, pending: [], delivered: new Map(), sent: 0, refused: 0 });
    return bySerial.get(key);
  };

  return {
    /** Queues a command for the next time the terminal asks. */
    queue(serial, command, meta = {}) {
      const state = bucket(serial);
      if (state.pending.length >= maxPerDevice) {
        state.refused += 1;
        return { queued: false, error: `this terminal has ${state.pending.length} commands it has not fetched yet; nothing more can be queued` };
      }
      const id = state.nextId++;
      state.pending.push({ id, command, meta, queuedAt: now() });
      return { queued: true, id, command };
    },

    /** What §11.1 should answer: `C:<id>:<command>` lines, then forgotten? No — kept until confirmed. */
    take(serial) {
      const state = bucket(serial);
      const lines = [];
      for (const item of state.pending.splice(0, state.pending.length)) {
        lines.push(`C:${item.id}:${item.command}${LF}`);
        // A terminal that never confirms is a terminal that is offline, not a
        // command that succeeded; the delivery deadline lives in the caller.
        state.delivered.set(item.id, { ...item, deliveredAt: now() });
      }
      state.sent += lines.length;
      return lines.join('');
    },

    /** Correlates a §10.4 result with the queued command. */
    confirm(serial, { id, returnCode, command }) {
      const state = bucket(serial);
      const key = Number(id);
      if (!state.delivered.has(key)) return { matched: false, id: key, returnCode };
      const item = state.delivered.get(key);
      state.delivered.delete(key);
      const code = Number(returnCode);
      return {
        matched: true,
        id: key,
        command,
        returnCode: Number.isFinite(code) ? code : null,
        meaning: RETURN_MEANINGS[code] ?? (Number.isFinite(code) ? `terminal answered ${code}` : 'the terminal did not say what went wrong'),
        meta: item.meta,
        waitedMs: now() - item.deliveredAt,
      };
    },

    /** Times out a delivered-but-unconfirmed command so an operation cannot hang. */
    expireDelivered(serial, olderThanMs) {
      const state = bucket(serial);
      const expired = [];
      for (const [id, item] of [...state.delivered.entries()]) {
        if (now() - item.deliveredAt >= olderThanMs) {
          state.delivered.delete(id);
          expired.push(item);
        }
      }
      return expired;
    },

    depth(serial) {
      const state = bySerial.get(String(serial ?? '').trim());
      return { queued: state?.pending.length ?? 0, delivered: state?.delivered.size ?? 0, sent: state?.sent ?? 0, refused: state?.refused ?? 0 };
    },

    /** A terminal whose command was answered `Return=0` still needs its card checked. */
    serials() {
      return [...bySerial.keys()];
    },
  };
}

/**
 * Server response for §7.1 when the terminal is already known: the registry code
 * plus the configuration the terminal will obey. Field names and defaults follow
 * §7.1's list; `Realtime=1` is what makes an access event arrive when it happens
 * instead of on a two-minute timer, which is the entire point of running this.
 */
export function buildRegistrationConfig({ registryCode, serverName = 'EstateMate Bridge', serverVersion = '1', pushProtocolVersion = '3.1.2', requestDelaySeconds = 5, transIntervalMinutes = 1, timeoutSeconds = 10, sessionId }) {
  return [
    'registry=ok',
    `RegistryCode=${registryCode}`,
    `ServerVersion=${serverVersion}`,
    `ServerName=${serverName}`,
    `PushProtVer=${pushProtocolVersion}`,
    'ErrorDelay=30',
    `RequestDelay=${requestDelaySeconds}`,
    `TransInterval=${transIntervalMinutes}`,
    'TransTables=User Transaction',
    'Realtime=1',
    `SessionID=${sessionId}`,
    `TimeoutSec=${timeoutSeconds}`,
  ].join(LF);
}

/**
 * §11.1: the body of a command response. `OK` means "nothing for you", and a
 * terminal that receives an empty body instead waits out its own timeout.
 */
export function buildCommandBody(lines) {
  return lines && lines.trim() ? lines : `OK${LF}`;
}
