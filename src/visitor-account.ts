/**
 * Visitor account options.
 *
 * A visitor account on the estate's terminals is deliberately narrow: one
 * finite, PIN-only person record that exists only while the pass can open a
 * gate (see `docs/VISITOR-DEVICE-ACCOUNTS.md`). This module holds the rules
 * for the values that go into it — the person type the terminal files it under,
 * how many times the pass may be used, the six-digit keypad PIN, how long the
 * window may be, and why the person is coming.
 *
 * Everything here is pure so the same rules can be unit-tested and reused by
 * the route that creates a pass, the reconciliation that re-queues it, and the
 * gate decision that honours it.
 *
 * **Visit times are counted and enforced by EstateMate, not by the terminal.**
 * No device profile in `docs/device-profiles/` records a firmware field that
 * counts visits, and an ISAPI `UserInfo` write that carries an undocumented
 * field is answered with `badJsonContent` — which would stop the visitor
 * account being created at all. So EstateMate counts accepted check-ins
 * against the pass and refuses the next one. That is auditable, works on every
 * terminal, and is independent of how quickly a slot is released.
 */

/** Every visitor PIN is exactly six digits — a keypad code, not a card number. */
export const VISITOR_PIN_DIGITS = 6;

/** One pass admits the visitor at least once and at most ten times. */
export const VISIT_TIMES_MIN = 1;
export const VISIT_TIMES_MAX = 10;

/**
 * Terminal person types a visitor account may be filed under.
 *
 * `visitor` is the default: it is the type a visitor slot is meant to hold and
 * it is what the terminal's own person editor shows. `normal` remains
 * available because firmware varies — a terminal that refuses the visitor type
 * answers the write with `badJsonContent`, and the estate needs a supported
 * value to fall back to.
 */
export const VISITOR_PERSON_TYPES = ['visitor', 'normal'] as const;
export type VisitorPersonType = (typeof VISITOR_PERSON_TYPES)[number];

/** A pass window is at least a day and never longer than this ceiling. */
export const VISITOR_VALIDITY_MIN_DAYS = 1;
export const VISITOR_VALIDITY_MAX_CEILING_DAYS = 30;
export const VISITOR_DEFAULT_VALIDITY_DAYS = 1;
export const VISITOR_DEFAULT_MAX_VALIDITY_DAYS = 7;

/** Why the visitor is coming. `other` carries its own free text. */
export const VISITOR_PURPOSE_OPTIONS = [
  { id: 'family_social', label: 'Family or social visit' },
  { id: 'delivery', label: 'Delivery or collection' },
  { id: 'service_repair', label: 'Service, repair or maintenance' },
  { id: 'business', label: 'Business or official' },
  { id: 'domestic_staff', label: 'Domestic staff or caregiver' },
  { id: 'event', label: 'Event or celebration' },
  { id: 'other', label: 'Other — state it below' },
] as const;
export type VisitorPurposeId = (typeof VISITOR_PURPOSE_OPTIONS)[number]['id'];
export const VISITOR_PURPOSE_IDS: readonly string[] = VISITOR_PURPOSE_OPTIONS.map((option) => option.id);
export const VISITOR_PURPOSE_OTHER_MAX = 120;
export const VISITOR_REMARK_MAX = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReadResult<T> {
  value: T;
  error: string | null;
}

const accepted = <T>(value: T): ReadResult<T> => ({ value, error: null });
const refused = <T>(value: T, error: string): ReadResult<T> => ({ value, error });

function text(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

/**
 * The person type for one visitor account. An omitted value takes the estate
 * default rather than failing, so a resident's request and a reconciliation of
 * an older pass both land on a supported value.
 */
export function readVisitorPersonType(
  value: unknown,
  fallback: VisitorPersonType = 'visitor',
): ReadResult<VisitorPersonType> {
  const requested = text(value)?.toLowerCase() ?? null;
  if (!requested) return accepted(fallback);
  const match = VISITOR_PERSON_TYPES.find((type) => type === requested);
  if (!match) {
    return refused(fallback, `personType must be one of: ${VISITOR_PERSON_TYPES.join(', ')}`);
  }
  return accepted(match);
}

/** How many times the pass may be used. Blank means the default of one visit. */
export function readVisitTimes(value: unknown): ReadResult<number> {
  const raw = text(value);
  if (!raw) return accepted(VISIT_TIMES_MIN);
  if (!/^\d{1,3}$/.test(raw)) return refused(VISIT_TIMES_MIN, `visitTimes must be a whole number between ${VISIT_TIMES_MIN} and ${VISIT_TIMES_MAX}`);
  const times = Number(raw);
  if (times < VISIT_TIMES_MIN || times > VISIT_TIMES_MAX) {
    return refused(VISIT_TIMES_MIN, `visitTimes must be between ${VISIT_TIMES_MIN} and ${VISIT_TIMES_MAX}`);
  }
  return accepted(times);
}

/**
 * Purpose of visit. A preset is stored as its id; `other` stores the text the
 * requester typed so the gate, the pass and every export can show the real
 * reason rather than the word "other".
 */
export function readVisitorPurpose(
  value: unknown,
  other: unknown,
): ReadResult<{ purpose: VisitorPurposeId | null; purposeOther: string | null }> {
  const purpose = text(value)?.toLowerCase() ?? null;
  const empty = { purpose: null, purposeOther: null };
  if (!purpose) return accepted(empty);
  if (!VISITOR_PURPOSE_IDS.includes(purpose)) {
    return refused(empty, `purposeOfVisit must be one of: ${VISITOR_PURPOSE_IDS.join(', ')}`);
  }
  if (purpose !== 'other') return accepted({ purpose: purpose as VisitorPurposeId, purposeOther: null });
  const typed = text(other);
  if (!typed) return refused(empty, 'Describe the purpose of visit when you choose "Other"');
  if (typed.length > VISITOR_PURPOSE_OTHER_MAX) {
    return refused(empty, `The purpose of visit must be ${VISITOR_PURPOSE_OTHER_MAX} characters or fewer`);
  }
  return accepted({ purpose: 'other', purposeOther: typed });
}

/** Free-text remark from the host. Optional, and never sent to a terminal. */
export function readVisitorRemark(value: unknown): ReadResult<string | null> {
  const remark = text(value);
  if (!remark) return accepted(null);
  if (remark.length > VISITOR_REMARK_MAX) {
    return refused(null, `The remark must be ${VISITOR_REMARK_MAX} characters or fewer`);
  }
  return accepted(remark);
}

/** Human label for a stored purpose, falling back to the raw value. */
export function visitorPurposeLabel(purpose: unknown, purposeOther?: unknown): string {
  const id = text(purpose)?.toLowerCase() ?? null;
  if (!id) return '';
  const preset = VISITOR_PURPOSE_OPTIONS.find((option) => option.id === id);
  if (preset && preset.id === 'other') return text(purposeOther) ?? 'Other';
  return preset?.label ?? id;
}

/** Human label for a stored person type. */
export function visitorPersonTypeLabel(value: unknown): string {
  const type = text(value)?.toLowerCase() ?? null;
  if (type === 'visitor') return 'Visitor';
  if (type === 'normal') return 'Normal user';
  return type ?? '';
}

/**
 * A whole number of days clamped into the window EstateMate supports. Used for
 * both the estate default and the administrator-editable maximum.
 */
export function readValidityDays(
  value: unknown,
  fallback: number,
  min: number = VISITOR_VALIDITY_MIN_DAYS,
  max: number = VISITOR_VALIDITY_MAX_CEILING_DAYS,
): number {
  const raw = text(value);
  if (!raw || !/^\d{1,3}$/.test(raw)) return fallback;
  const days = Number(raw);
  if (!Number.isFinite(days)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(days)));
}

/** The default length of a new pass, in whole days. */
export function readVisitorDefaultValidityDays(value: unknown): number {
  return readValidityDays(value, VISITOR_DEFAULT_VALIDITY_DAYS);
}

/**
 * The longest window an estate allows. Never longer than the ceiling, and
 * never shorter than the default: an administrator cannot set a maximum that
 * makes the estate's own default invalid.
 */
export function readVisitorMaxValidityDays(value: unknown, defaultDays: number = VISITOR_DEFAULT_VALIDITY_DAYS): number {
  return readValidityDays(value, Math.max(VISITOR_DEFAULT_MAX_VALIDITY_DAYS, defaultDays), Math.max(VISITOR_VALIDITY_MIN_DAYS, defaultDays));
}

/** Milliseconds in a whole number of days. */
export function validityDaysToMs(days: number): number {
  return days * DAY_MS;
}

/**
 * Whether a window fits the estate's maximum. A minute of slack absorbs the
 * rounding a datetime-local field introduces; anything longer is refused with
 * a message that names the limit, so the requester knows what to ask for.
 */
export function withinVisitorValidity(fromMs: number, untilMs: number, maxDays: number): boolean {
  return untilMs - fromMs <= validityDaysToMs(maxDays) + 60_000;
}

/** Rejection text for a window that is too long. */
export function visitorValidityError(maxDays: number): string {
  return `A visitor pass cannot be valid for more than ${maxDays} day${maxDays === 1 ? '' : 's'}. Ask an administrator to raise the limit in Settings if the estate needs longer.`;
}
