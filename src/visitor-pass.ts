import { formatEstateDateTime, parseEstateInstantMs } from './datetime';

/** Any visitor row shape; only these three fields drive the decision. */
export interface VisitorPassWindow {
  valid_from?: unknown;
  valid_until?: unknown;
  status?: unknown;
  [column: string]: unknown;
}

export interface VisitorPassEvaluation {
  valid: boolean;
  /** `null` when the pass can be accepted, otherwise a gate-ready explanation. */
  reason: string | null;
  startsAtMs: number | null;
  endsAtMs: number | null;
}

/**
 * Decides whether a visitor pass may be accepted right now, and names the exact
 * blocking condition instead of a single generic message.
 */
export function evaluateVisitorPass(
  pass: VisitorPassWindow,
  timeZone: string,
  nowMs: number = Date.now(),
): VisitorPassEvaluation {
  const status = String(pass.status ?? '').toLowerCase();
  const startsAtMs = parseEstateInstantMs(pass.valid_from, timeZone, 'start');
  const endsAtMs = parseEstateInstantMs(pass.valid_until, timeZone, 'end');
  const base = { startsAtMs, endsAtMs };
  const reject = (reason: string): VisitorPassEvaluation => ({ valid: false, reason, ...base });

  if (status === 'revoked') return reject('This pass was revoked by the estate and cannot be used');
  if (status === 'checked_out') return reject('This visitor already checked out. Ask the host to issue a new pass');
  if (status === 'expired') return reject('This pass has expired and cannot be used');
  if (status === 'pending') return reject('This pass is still awaiting approval by the estate');

  if (startsAtMs === null || endsAtMs === null) {
    return reject('This pass has an unreadable validity window. Reissue it before accepting entry');
  }
  if (nowMs < startsAtMs) {
    return reject(`This pass is not active yet. It becomes valid at ${formatEstateDateTime(startsAtMs, timeZone)} estate time`);
  }
  if (nowMs > endsAtMs) {
    return reject(`This pass expired at ${formatEstateDateTime(endsAtMs, timeZone)} estate time`);
  }
  return { valid: true, reason: null, ...base };
}
