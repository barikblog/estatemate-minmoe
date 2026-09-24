import { describe, expect, it } from 'vitest';
import { formatEstateDateTime, isValidTimeZone, normalizeTimeZone, parseEstateInstantMs } from './datetime';

describe('estate datetime parsing', () => {
  it('reads a naive wall-clock string in the estate timezone, not UTC', () => {
    // 10:00 in Africa/Lagos (UTC+1) is 09:00Z.
    expect(parseEstateInstantMs('2026-09-24T10:00', 'Africa/Lagos')).toBe(Date.parse('2026-09-24T09:00:00Z'));
    expect(parseEstateInstantMs('2026-09-24T10:00', 'UTC')).toBe(Date.parse('2026-09-24T10:00:00Z'));
  });

  it('honours an explicit offset when one is present', () => {
    expect(parseEstateInstantMs('2026-09-24T10:00:00Z', 'Africa/Lagos')).toBe(Date.parse('2026-09-24T10:00:00Z'));
    expect(parseEstateInstantMs('2026-09-24T10:00:00+01:00', 'UTC')).toBe(Date.parse('2026-09-24T09:00:00Z'));
    expect(parseEstateInstantMs('2026-09-24T10:00:00+0100', 'UTC')).toBe(Date.parse('2026-09-24T09:00:00Z'));
  });

  it('accepts the SQLite datetime shape used by legacy rows', () => {
    expect(parseEstateInstantMs('2026-09-24 10:00:00', 'Africa/Lagos')).toBe(Date.parse('2026-09-24T09:00:00Z'));
  });

  it('spans the whole day for date-only values', () => {
    expect(parseEstateInstantMs('2026-09-24', 'Africa/Lagos', 'start')).toBe(Date.parse('2026-09-23T23:00:00Z'));
    expect(parseEstateInstantMs('2026-09-24', 'Africa/Lagos', 'end')).toBe(Date.parse('2026-09-24T22:59:59.999Z'));
  });

  it('resolves both sides of a daylight-saving transition', () => {
    // Europe/London is UTC+1 on 24 June and UTC+0 on 24 December.
    expect(parseEstateInstantMs('2026-06-24T10:00', 'Europe/London')).toBe(Date.parse('2026-06-24T09:00:00Z'));
    expect(parseEstateInstantMs('2026-12-24T10:00', 'Europe/London')).toBe(Date.parse('2026-12-24T10:00:00Z'));
    // 25 Oct 2026 is when London clocks go back at 01:00Z, so local 01:30 happens twice.
    // An ambiguous hour resolves to the post-transition offset rather than failing.
    expect(parseEstateInstantMs('2026-10-25T01:30', 'Europe/London')).toBe(Date.parse('2026-10-25T01:30:00Z'));
  });

  it('returns null for values it cannot read', () => {
    expect(parseEstateInstantMs('', 'Africa/Lagos')).toBeNull();
    expect(parseEstateInstantMs(null, 'Africa/Lagos')).toBeNull();
    expect(parseEstateInstantMs('not-a-date', 'Africa/Lagos')).toBeNull();
  });

  it('falls back to the default estate timezone for an unusable setting', () => {
    expect(isValidTimeZone('Africa/Lagos')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(normalizeTimeZone('Mars/Olympus')).toBe('Africa/Lagos');
    expect(normalizeTimeZone(' UTC ')).toBe('UTC');
  });

  it('renders an instant in estate time for gate messages', () => {
    expect(formatEstateDateTime(Date.parse('2026-09-24T09:00:00Z'), 'Africa/Lagos')).toContain('10:00');
    expect(formatEstateDateTime('nonsense', 'Africa/Lagos')).toBe('nonsense');
  });
});
