/**
 * Estate-aware date handling.
 *
 * Portal forms submit naive wall-clock strings (`<input type="datetime-local">`
 * produces `2026-09-24T10:00` with no offset). `new Date()` on the Worker reads
 * such a string as UTC, which silently shifts every window by the estate's UTC
 * offset — in Africa/Lagos that is a full hour, enough to report a live visitor
 * pass as "outside its validity window".
 *
 * Everything here resolves a wall-clock string against the configured IANA
 * timezone, and stores/compares the result as a real instant.
 */

export const DEFAULT_ESTATE_TIMEZONE = 'Africa/Lagos';

export type DayBoundary = 'start' | 'end';

const NAIVE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export function isValidTimeZone(timeZone: unknown): boolean {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Falls back to the documented estate default instead of rejecting the request. */
export function normalizeTimeZone(timeZone: unknown): string {
  return isValidTimeZone(timeZone) ? String(timeZone).trim() : DEFAULT_ESTATE_TIMEZONE;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** Offset (in milliseconds) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const read = (type: string): number => Number(formatter.formatToParts(new Date(instantMs)).find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Resolves wall-clock components in `timeZone` to a UTC instant. The offset is
 * sampled twice so dates either side of a DST transition land correctly.
 */
function wallTimeToInstantMs(wall: WallTime, timeZone: string): number {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  if (Number.isNaN(asIfUtc)) return Number.NaN;
  const candidate = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  return asIfUtc - zoneOffsetMs(candidate, timeZone);
}

/**
 * Parses a stored or submitted datetime into epoch milliseconds.
 *
 * - Strings carrying an explicit `Z`/`±HH:MM` offset are already absolute.
 * - Naive strings (including SQLite's `YYYY-MM-DD HH:MM:SS`) are read in `timeZone`.
 * - Date-only values span the whole day: midnight for `start`, 23:59:59.999 for `end`.
 *
 * Returns `null` when the value cannot be understood.
 */
export function parseEstateInstantMs(value: unknown, timeZone: string, boundary: DayBoundary = 'start'): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  const match = NAIVE_PATTERN.exec(text);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction, offset] = match;
    if (offset) {
      const withColon = offset.toUpperCase() === 'Z' ? 'Z' : `${offset.slice(0, 3)}:${offset.slice(3).replace(':', '')}`;
      const absolute = Date.parse(`${year}-${month}-${day}T${hour ?? '00'}:${minute ?? '00'}:${second ?? '00'}${withColon}`);
      return Number.isNaN(absolute) ? null : absolute;
    }
    const hasTime = hour !== undefined && minute !== undefined;
    const endOfDay = boundary === 'end';
    const wall: WallTime = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: hasTime ? Number(hour) : (endOfDay ? 23 : 0),
      minute: hasTime ? Number(minute) : (endOfDay ? 59 : 0),
      second: hasTime ? Number(second ?? 0) : (endOfDay ? 59 : 0),
      millisecond: hasTime ? Number(`${fraction ?? '0'}00`.slice(0, 3)) : (endOfDay ? 999 : 0),
    };
    const instant = wallTimeToInstantMs(wall, normalizeTimeZone(timeZone));
    return Number.isNaN(instant) ? null : instant;
  }

  const fallback = Date.parse(text);
  return Number.isNaN(fallback) ? null : fallback;
}

/** Convenience wrapper returning a `Date`, or `null` for unreadable values. */
export function parseEstateInstant(value: unknown, timeZone: string, boundary: DayBoundary = 'start'): Date | null {
  const ms = parseEstateInstantMs(value, timeZone, boundary);
  return ms === null ? null : new Date(ms);
}

/** Renders an instant for a human reading it in the estate's own timezone. */
export function formatEstateDateTime(value: unknown, timeZone: string): string {
  const ms = typeof value === 'number' ? value : parseEstateInstantMs(value, timeZone);
  if (ms === null || Number.isNaN(ms)) return String(value ?? '—');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: normalizeTimeZone(timeZone),
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date(ms));
}
