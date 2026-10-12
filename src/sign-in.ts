import { sha256, timingSafeEqual } from './security';

/**
 * Sign-in rules shared by every client: the web portal, the Windows app that
 * opens it, and the Android client.
 *
 * The Worker owns the rules and this module holds the parts that must agree
 * everywhere — session lifetimes, the throttle windows, the reset-code
 * alphabet, password policy and the vocabulary of failure codes the clients
 * translate into a sentence a person can act on. Keeping them here means a
 * client can never drift from the server about what "8 attempts in 15 minutes"
 * or "30-day session" means, and every rule is unit-tested without a database.
 */

/** A session with no "Remember me" lasts a working day. */
export const SESSION_SECONDS = 60 * 60 * 12;
/** "Remember me": 30 days, the length the portal, PC app and phone agree on. */
export const REMEMBER_ME_SECONDS = 60 * 60 * 24 * 30;
/** How long a Security officer has to pick the gate they are posted at. */
export const GATE_SELECTION_SECONDS = 5 * 60;

export const SESSION_COOKIE = 'estatemate_session';

/** Sign-in throttling: per source address, and per account across addresses. */
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_FAILURES_PER_SOURCE = 8;
export const LOGIN_MAX_FAILURES_PER_EMAIL = 25;

/**
 * Forgot-password throttling. Deliberately tighter than sign-in: every request
 * costs a queue row and, in self-service mode, mints a code.
 */
export const FORGOT_PASSWORD_WINDOW_MINUTES = 15;
export const FORGOT_PASSWORD_MAX_PER_SOURCE = 3;
export const FORGOT_PASSWORD_MAX_PER_EMAIL = 10;

/** A self-service reset code is short-lived and single-use. */
export const RESET_CODE_TTL_MINUTES_DEFAULT = 30;
export const RESET_CODE_TTL_MINUTES_MIN = 5;
export const RESET_CODE_TTL_MINUTES_MAX = 120;
export const RESET_CODE_MAX_ATTEMPTS = 5;
/**
 * Ambiguous glyphs are excluded: a code is read off one screen and typed into
 * another, often from a phone, so `0/O` and `1/I/L` must not be possible.
 */
export const RESET_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const RESET_CODE_LENGTH = 8;
export const RESET_REFERENCE_PREFIX = 'PR-';
export const RESET_REFERENCE_LENGTH = 6;
/** An unanswered office request stops being "pending" after this long. */
export const RESET_REQUEST_PENDING_DAYS = 7;
/** A repeat request within this window reuses the reference already shown. */
export const RESET_REQUEST_REUSE_HOURS = 12;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** Where a client said it was when it asked: recorded for the estate office. */
export const SIGN_IN_CLIENTS = ['portal', 'desktop', 'android'] as const;
export type SignInClient = (typeof SIGN_IN_CLIENTS)[number];

/**
 * The machine-readable reason a sign-in or reset failed. Clients map these to
 * their own wording; `error` stays the human sentence for anything that reads
 * the body directly.
 */
export type SignInErrorCode =
  | 'validation'
  | 'invalid_credentials'
  | 'account_inactive'
  | 'account_expired'
  | 'too_many_attempts'
  | 'invalid_reset_code'
  | 'reset_expired'
  | 'weak_password'
  | 'service_unavailable';

/** The estate office's own wording for each code, used when none is supplied. */
export const SIGN_IN_MESSAGES: Record<SignInErrorCode, string> = {
  validation: 'Enter the details the form asks for and try again.',
  invalid_credentials: 'That email and password do not match an active account.',
  account_inactive: 'This account has been deactivated. Ask the estate office to reactivate it.',
  account_expired: 'This account has expired. Ask the estate office for a new one.',
  too_many_attempts: 'Too many attempts. Wait a few minutes, then try again, or reset your password.',
  invalid_reset_code: 'That reset code is not right, or it has already been used.',
  reset_expired: 'That reset code has expired. Request a new one.',
  weak_password: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  service_unavailable: 'The estate server could not complete that request. Try again in a moment.',
};

/** `true` only for a literal boolean `true` or the strings a form sends. */
export function readBooleanFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

/** The session lifetime a sign-in asked for. */
export function sessionSecondsFor(rememberMe: unknown): number {
  return readBooleanFlag(rememberMe) ? REMEMBER_ME_SECONDS : SESSION_SECONDS;
}

/**
 * The session cookie. `Max-Age` matches the token's own lifetime, so a browser
 * can never hold a cookie for a session the Worker has already expired — the
 * exact bug a fixed 12-hour `Max-Age` would create for a 30-day session.
 */
export function sessionCookie(token: string | null, maxAgeSeconds: number): string {
  const value = token ? encodeURIComponent(token) : '';
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** Clears the session cookie. */
export const CLEARED_SESSION_COOKIE = sessionCookie(null, 0);

/** The address that asked, as the edge sees it. Never stored in the clear. */
export function requestAddress(header: (name: string) => string | undefined): string {
  const direct = header('CF-Connecting-IP');
  if (direct?.trim()) return direct.trim();
  const forwarded = header('X-Forwarded-For');
  const first = forwarded?.split(',')[0]?.trim();
  return first || 'unknown';
}

/**
 * A salted, truncated hash of the caller's address: enough to count attempts
 * from one source, useless as an address if the database is ever read.
 */
export async function attemptSourceHash(secret: string, address: string): Promise<string> {
  return (await sha256(`${secret}|${address}`)).slice(0, 32);
}

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A form-level email check good enough to refuse an obvious typo early. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function randomChar(index: number): string {
  const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  // Rejection-free modulo is fine here: the bias across 31 symbols is far below
  // anything that matters for a code that expires in minutes and is
  // rate-limited to a handful of guesses.
  return RESET_CODE_ALPHABET[byte % RESET_CODE_ALPHABET.length]!;
}

/** A fresh one-time reset code, e.g. `7K2M9Q4T` (stored hashed, never plain). */
export function generateResetCode(): string {
  return Array.from({ length: RESET_CODE_LENGTH }, (_, index) => randomChar(index)).join('');
}

/** Uppercase, alphanumeric-only reading of whatever the person typed. */
export function normalizeResetCode(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^0-9A-Z]/g, '') : '';
}

/** How the code is shown: two groups of four, which is easier to copy. */
export function formatResetCode(code: string): string {
  const normalized = normalizeResetCode(code);
  if (normalized.length !== RESET_CODE_LENGTH) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** The reference the requester quotes to the estate office. */
export function generateResetReference(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const code = Array.from({ length: RESET_REFERENCE_LENGTH }, () => {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
    return alphabet[byte % alphabet.length]!;
  }).join('');
  return `${RESET_REFERENCE_PREFIX}${code}`;
}

/** The hash of a reset code as it is stored: codes are never kept in the clear. */
export async function resetCodeHash(code: string): Promise<string> {
  return sha256(`reset-code|${normalizeResetCode(code)}`);
}

/** Constant-time comparison of a submitted code against the stored hash. */
export async function resetCodeMatches(code: string, storedHash: string): Promise<boolean> {
  const candidate = await resetCodeHash(code);
  const a = new TextEncoder().encode(candidate);
  const b = new TextEncoder().encode(storedHash);
  return timingSafeEqual(a, b);
}

/**
 * Windows and Linux disagree about `datetime('now')` parsing in JavaScript, so
 * every SQLite timestamp is read here and nowhere else: SQLite writes UTC as
 * `YYYY-MM-DD HH:MM:SS`, which needs the `T` and the `Z` to be understood.
 */
export function parseSqliteUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** SQLite's own UTC timestamp format, from a JavaScript one. */
export function sqliteUtc(timestampMs: number = Date.now()): string {
  return new Date(timestampMs).toISOString().slice(0, 19).replace('T', ' ');
}

/** When a self-service code minted now stops being usable. */
export function resetExpiry(codeMinutes: number, now: number = Date.now()): string {
  return sqliteUtc(now + codeMinutes * 60_000);
}

/**
 * Seconds until the oldest attempt in the window ages out. This is what the
 * client shows as "try again in N minutes", so it is counted from the attempt
 * that is about to expire rather than from a fixed lock.
 */
export function retryAfterSeconds(
  oldestAttemptAt: string | null | undefined,
  windowMinutes: number,
  now: number = Date.now(),
): number {
  const oldest = parseSqliteUtc(oldestAttemptAt);
  if (oldest === null) return windowMinutes * 60;
  const freesAt = oldest + windowMinutes * 60_000;
  const remaining = Math.ceil((freesAt - now) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** A whole number of minutes, clamped into the range the estate may configure. */
export function readResetCodeMinutes(value: unknown, fallback = RESET_CODE_TTL_MINUTES_DEFAULT): number {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return fallback;
  const minutes = Number(text);
  if (minutes < RESET_CODE_TTL_MINUTES_MIN || minutes > RESET_CODE_TTL_MINUTES_MAX) return fallback;
  return minutes;
}

/** The self-service switch: off unless an Administrator turned it on. */
export function readSelfServiceEnabled(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

/**
 * What is wrong with a chosen password, or null when it is acceptable.
 *
 * The estate's rule is length-based (12 characters) rather than a character-class
 * checklist, and the only content rules are the two that turn a reset into a
 * lockout: a password that is the account's own email address, or a password
 * made only of spaces, which no phone keyboard shows clearly.
 */
export function passwordProblem(password: unknown, email?: string): string | null {
  const value = typeof password === 'string' ? password : '';
  if (value.trim().length === 0) return 'Your new password cannot be empty or only spaces.';
  if (value.length < MIN_PASSWORD_LENGTH) return `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  if (value.length > MAX_PASSWORD_LENGTH) return `Your new password must be no longer than ${MAX_PASSWORD_LENGTH} characters.`;
  if (email && value.toLowerCase() === normalizeEmail(email)) return 'Your new password cannot be your own email address.';
  return null;
}

/**
 * Whether a session was issued before the account's password last changed.
 * Such a session is refused: a 30-day "remember me" cookie must not survive the
 * password reset that was made precisely because someone else had it.
 *
 * A small skew is tolerated so the sign-in that follows a password change — and
 * the new token handed back by the route that changed it — are never rejected.
 */
export function sessionIssuedBeforePasswordChange(
  passwordChangedAt: string | null | undefined,
  issuedAt: number | null | undefined,
  skewSeconds = 5,
): boolean {
  const changed = parseSqliteUtc(passwordChangedAt);
  if (changed === null || typeof issuedAt !== 'number') return false;
  return issuedAt * 1000 < changed - skewSeconds * 1000;
}

/** The client name recorded on a reset request, from what the client sent. */
export function readRequestedFrom(value: unknown): SignInClient | 'unknown' {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SIGN_IN_CLIENTS as readonly string[]).includes(text) ? (text as SignInClient) : 'unknown';
}

/** Where a reset can be delivered, as the requester is told. */
export type ResetDelivery = 'office' | 'self_service';

export interface ThrottleLimits {
  perSource: number;
  perEmail: number;
  windowMinutes: number;
}

export const LOGIN_THROTTLE: ThrottleLimits = {
  perSource: LOGIN_MAX_FAILURES_PER_SOURCE,
  perEmail: LOGIN_MAX_FAILURES_PER_EMAIL,
  windowMinutes: LOGIN_WINDOW_MINUTES,
};

export const FORGOT_PASSWORD_THROTTLE: ThrottleLimits = {
  perSource: FORGOT_PASSWORD_MAX_PER_SOURCE,
  perEmail: FORGOT_PASSWORD_MAX_PER_EMAIL,
  windowMinutes: FORGOT_PASSWORD_WINDOW_MINUTES,
};

/**
 * Plain sentence for a "try again in N" answer: whole minutes above a minute,
 * seconds below it, because "try again in 0 minutes" is worse than useless.
 */
export function retryHint(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `Try again in ${rounded} second${rounded === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(rounded / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * Mirrors `jsonError` for the sign-in routes: the same `{ error }` shape every
 * client already reads, plus a `code` the clients switch on and, for a
 * throttle, the seconds to wait.
 */
export function signInProblem(
  code: SignInErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): { error: string; code: SignInErrorCode } & Record<string, unknown> {
  return { error: message, code, ...extra };
}

/** The estate's own sentence for a code, so callers never invent wording. */
export function signInMessage(code: SignInErrorCode, override?: string): string {
  return override?.trim() ? override.trim() : SIGN_IN_MESSAGES[code];
}
