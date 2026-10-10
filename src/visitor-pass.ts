import { formatEstateDateTime, parseEstateInstantMs } from './datetime';

/**
 * Any visitor row shape. The window and status drive the decision; `visit_times`
 * and `visits_used` cap how many times the pass may be used, and are only read
 * when the caller's query counted accepted check-ins.
 */
export interface VisitorPassWindow {
  valid_from?: unknown;
  valid_until?: unknown;
  status?: unknown;
  visit_times?: unknown;
  visits_used?: unknown;
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
  // Visit times: a pass admits the visitor a fixed number of times, and
  // EstateMate counts those check-ins itself rather than asking a terminal to
  // enforce a field no device profile records (see src/visitor-account.ts).
  // Letting somebody who is already inside back out is never blocked by this —
  // the decision route overrides an invalid evaluation for a check-out.
  const visitTimes = Number(pass.visit_times ?? 0);
  const visitsUsed = Number(pass.visits_used ?? 0);
  if (Number.isFinite(visitTimes) && visitTimes >= 1 && Number.isFinite(visitsUsed) && visitsUsed >= visitTimes) {
    return reject(`This pass has used all ${visitTimes} permitted visit${visitTimes === 1 ? '' : 's'}. Ask the host to issue a new pass`);
  }
  return { valid: true, reason: null, ...base };
}
