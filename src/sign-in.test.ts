import { describe, expect, it } from 'vitest';
import {
  FORGOT_PASSWORD_MAX_PER_SOURCE,
  LOGIN_MAX_FAILURES_PER_SOURCE,
  MIN_PASSWORD_LENGTH,
  REMEMBER_ME_SECONDS,
  RESET_CODE_LENGTH,
  RESET_CODE_TTL_MINUTES_DEFAULT,
  RESET_CODE_TTL_MINUTES_MAX,
  RESET_CODE_TTL_MINUTES_MIN,
  SESSION_SECONDS,
  attemptSourceHash,
  formatResetCode,
  generateResetCode,
  generateResetReference,
  looksLikeEmail,
  normalizeEmail,
  normalizeResetCode,
  parseSqliteUtc,
  passwordProblem,
  readBooleanFlag,
  readRequestedFrom,
  readResetCodeMinutes,
  readSelfServiceEnabled,
  resetCodeHash,
  resetCodeMatches,
  resetExpiry,
  retryAfterSeconds,
  retryHint,
  sessionCookie,
  sessionIssuedBeforePasswordChange,
  sessionSecondsFor,
  signInMessage,
  signInProblem,
  sqliteUtc,
} from '../src/sign-in';

/**
 * The sign-in rules, tested without a database: the values the three clients
 * and the Worker must agree about. A mistake here shows up as a phone holding a
 * session the Worker has already expired, or as a reset code that cannot be
 * typed off a screen.
 */
describe('sign-in rules', () => {
  it('gives a remembered session 30 days and a plain one a working day', () => {
    expect(sessionSecondsFor(true)).toBe(REMEMBER_ME_SECONDS);
    expect(sessionSecondsFor('true')).toBe(REMEMBER_ME_SECONDS);
    expect(sessionSecondsFor('on')).toBe(REMEMBER_ME_SECONDS);
    expect(sessionSecondsFor(false)).toBe(SESSION_SECONDS);
    expect(sessionSecondsFor(undefined)).toBe(SESSION_SECONDS);
    // A JSON body that sends something else entirely must not be read as "yes".
    expect(sessionSecondsFor('yes please')).toBe(SESSION_SECONDS);
    expect(sessionSecondsFor(1)).toBe(SESSION_SECONDS);
    expect(readBooleanFlag(1)).toBe(false);
    expect(readBooleanFlag('TRUE')).toBe(true);
  });

  it('writes a session cookie whose Max-Age matches the token lifetime', () => {
    const remembered = sessionCookie('token-value', REMEMBER_ME_SECONDS);
    expect(remembered).toContain('estatemate_session=token-value');
    expect(remembered).toContain('HttpOnly');
    expect(remembered).toContain('Secure');
    expect(remembered).toContain('SameSite=Strict');
    expect(remembered).toContain(`Max-Age=${REMEMBER_ME_SECONDS}`);
    expect(sessionCookie(null, 0)).toContain('Max-Age=0');
    expect(sessionCookie(null, -5)).toContain('Max-Age=0');
  });

  it('salts the source hash so an address is never stored in the clear', async () => {
    const a = await attemptSourceHash('pepper-one', '197.210.0.1');
    const b = await attemptSourceHash('pepper-one', '197.210.0.1');
    const c = await attemptSourceHash('pepper-two', '197.210.0.1');
    const d = await attemptSourceHash('pepper-one', '197.210.0.2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).not.toContain('197');
    expect(a).toHaveLength(32);
  });

  it('counts a retry window from the oldest attempt in it', () => {
    const now = Date.parse('2026-10-12T10:15:00Z');
    // The oldest attempt happened 10 minutes ago in a 15-minute window.
    expect(retryAfterSeconds('2026-10-12 10:05:00', LOGIN_MAX_FAILURES_PER_SOURCE && 15, now)).toBe(300);
    // An attempt that has already aged out means there is nothing to wait for.
    expect(retryAfterSeconds('2026-10-12 09:50:00', 15, now)).toBe(0);
    // No attempt at all still answers with the window rather than zero.
    expect(retryAfterSeconds(null, 15, now)).toBe(900);
    expect(retryHint(45)).toBe('Try again in 45 seconds.');
    expect(retryHint(60)).toBe('Try again in 1 minute.');
    expect(retryHint(301)).toBe('Try again in 6 minutes.');
    expect(retryHint(0)).toBe('Try again in 1 second.');
  });

  it('refuses a password that turns a reset into a lockout', () => {
    expect(passwordProblem('short')).toMatch(/at least 12 characters/);
    expect(passwordProblem('            ')).toMatch(/empty or only spaces/);
    expect(passwordProblem('a'.repeat(201))).toMatch(/no longer than 200/);
    expect(passwordProblem('person@example.com', 'person@example.com')).toMatch(/your own email/);
    expect(passwordProblem('a-good-and-long-password')).toBeNull();
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('retires a session issued before the password changed', () => {
    const changed = sqliteUtc(Date.parse('2026-10-12T12:00:00Z'));
    const before = Math.floor(Date.parse('2026-10-12T11:00:00Z') / 1000);
    const after = Math.floor(Date.parse('2026-10-12T12:00:05Z') / 1000);
    expect(sessionIssuedBeforePasswordChange(changed, before)).toBe(true);
    expect(sessionIssuedBeforePasswordChange(changed, after)).toBe(false);
    // A password that never changed through these routes cannot end a session.
    expect(sessionIssuedBeforePasswordChange(null, before)).toBe(false);
    expect(sessionIssuedBeforePasswordChange(undefined, before)).toBe(false);
    // Same-second and clock-skew cases keep the session the route just re-issued.
    expect(sessionIssuedBeforePasswordChange(changed, Math.floor(Date.parse('2026-10-12T12:00:00Z') / 1000))).toBe(false);
  });

  it('reads SQLite timestamps as the UTC they are', () => {
    expect(parseSqliteUtc('2026-10-12 10:15:00')).toBe(Date.parse('2026-10-12T10:15:00Z'));
    expect(parseSqliteUtc('2026-10-12T10:15:00.000Z')).toBe(Date.parse('2026-10-12T10:15:00Z'));
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc('not a date')).toBeNull();
    expect(sqliteUtc(Date.parse('2026-10-12T10:15:00Z'))).toBe('2026-10-12 10:15:00');
  });

  it('mints reset codes that can be read off one screen and typed into another', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = generateResetCode();
      expect(code).toHaveLength(RESET_CODE_LENGTH);
      // No 0/O/1/I/L: the alphabet itself is checked, because a code that
      // cannot be transcribed reliably is a support call, not a reset.
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
    }
    expect(generateResetReference()).toMatch(/^PR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // Punctuation, spacing and case are all how a person retypes it.
    expect(normalizeResetCode('7k2m-9q4t')).toBe('7K2M9Q4T');
    expect(formatResetCode('7k2m9q4t')).toBe('7K2M-9Q4T');
    expect(formatResetCode('7K2M')).toBe('7K2M');
  });

  it('stores and checks a reset code as a hash, in constant time', async () => {
    const code = '7K2M9Q4T';
    const hash = await resetCodeHash(code);
    expect(hash).not.toContain(code);
    expect(hash).toHaveLength(64);
    await expect(resetCodeMatches('7k2m-9q4t', hash)).resolves.toBe(true);
    await expect(resetCodeMatches('7K2M9Q4X', hash)).resolves.toBe(false);
    await expect(resetCodeMatches('', hash)).resolves.toBe(false);
  });

  it('resolves reset settings into the range the estate may configure', () => {
    expect(readSelfServiceEnabled('true')).toBe(true);
    expect(readSelfServiceEnabled(' TRUE ')).toBe(true);
    expect(readSelfServiceEnabled('false')).toBe(false);
    expect(readSelfServiceEnabled(undefined)).toBe(false);
    expect(readResetCodeMinutes('45')).toBe(45);
    expect(readResetCodeMinutes(String(RESET_CODE_TTL_MINUTES_MIN))).toBe(RESET_CODE_TTL_MINUTES_MIN);
    expect(readResetCodeMinutes(String(RESET_CODE_TTL_MINUTES_MAX))).toBe(RESET_CODE_TTL_MINUTES_MAX);
    // Out of range, or not a number at all: the default, never an unvalidated value.
    expect(readResetCodeMinutes('2')).toBe(RESET_CODE_TTL_MINUTES_DEFAULT);
    expect(readResetCodeMinutes('600')).toBe(RESET_CODE_TTL_MINUTES_DEFAULT);
    expect(readResetCodeMinutes('soon')).toBe(RESET_CODE_TTL_MINUTES_DEFAULT);
    expect(readResetCodeMinutes(undefined)).toBe(RESET_CODE_TTL_MINUTES_DEFAULT);
    expect(resetExpiry(30, Date.parse('2026-10-12T10:00:00Z'))).toBe('2026-10-12 10:30:00');
  });

  it('normalises the email and the client name a request arrives with', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
    expect(normalizeEmail(undefined)).toBe('');
    expect(looksLikeEmail('person@example.com')).toBe(true);
    expect(looksLikeEmail('person@example')).toBe(false);
    expect(looksLikeEmail('person example.com')).toBe(false);
    expect(readRequestedFrom('desktop')).toBe('desktop');
    expect(readRequestedFrom('ANDROID')).toBe('android');
    expect(readRequestedFrom('curl')).toBe('unknown');
    expect(readRequestedFrom(undefined)).toBe('unknown');
  });

  it('answers every failure in one shape, with the estate wording', () => {
    expect(signInProblem('invalid_credentials', signInMessage('invalid_credentials'))).toEqual({
      error: 'That email and password do not match an active account.',
      code: 'invalid_credentials',
    });
    expect(signInProblem('too_many_attempts', 'Too many attempts. Try again in 4 minutes.', { retryAfterSeconds: 240 })).toEqual({
      error: 'Too many attempts. Try again in 4 minutes.',
      code: 'too_many_attempts',
      retryAfterSeconds: 240,
    });
    expect(signInMessage('validation', '  Enter your email address.  ')).toBe('Enter your email address.');
    expect(FORGOT_PASSWORD_MAX_PER_SOURCE).toBeLessThan(LOGIN_MAX_FAILURES_PER_SOURCE);
  });
});
