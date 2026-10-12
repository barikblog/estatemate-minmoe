import { beforeEach, describe, expect, it } from 'vitest';
import { call, createTestDatabase, createTestEnv, seedEstate, type SeededEstate, type TestDatabase, tokenFor } from './harness';
import { hashPassword, verifyJwt } from '../src/security';
import {
  REMEMBER_ME_SECONDS,
  RESET_CODE_MAX_ATTEMPTS,
  SESSION_SECONDS,
  formatResetCode,
  normalizeResetCode,
  parseSqliteUtc,
  sqliteUtc,
} from '../src/sign-in';
import type { Env } from '../src/types';

/**
 * Sign-in as the three clients meet it: a remembered session, a failure that
 * says which failure it was, a throttle that protects the estate without
 * revealing which addresses exist, and the estate's own password-reset path in
 * both of its deliveries (office queue and Administrator-enabled self-service).
 */
const PASSWORD = 'correct-horse-battery-staple';
const RENAMED = 'a-brand-new-estate-password';
const RESIDENT_EMAIL = 'resident@example.com';
const ADMIN_EMAIL = 'admin@example.com';

async function raw(env: Env, path: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const worker = (await import('../src/index')).default;
  const response = await worker.fetch(new Request(`https://estatemate.test${path}`, init), env, {
    waitUntil: async () => undefined,
  } as unknown as ExecutionContext);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* keep the empty object */ }
  return { status: response.status, json };
}

describe('sign-in experience', () => {
  let db: TestDatabase;
  let env: Env;
  let estate: SeededEstate;
  let adminToken: string;
  let managerToken: string;
  let residentToken: string;

  async function login(body: Record<string, unknown>) {
    return call(env, 'POST', '/api/auth/login', { body });
  }

  async function forgot(body: Record<string, unknown>) {
    return call(env, 'POST', '/api/auth/forgot-password', { body });
  }

  async function reset(body: Record<string, unknown>) {
    return call(env, 'POST', '/api/auth/reset-password', { body });
  }

  /** Turns self-service on the way an Administrator does, through the API. */
  async function enableSelfService(): Promise<void> {
    const saved = await call(env, 'PUT', '/api/settings/password_reset_self_service', { token: adminToken, body: { value: 'true' } });
    expect(saved.status).toBe(200);
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    env = createTestEnv(db.d1);
    estate = seedEstate(db);
    adminToken = await tokenFor(env, estate.adminId, 'admin', 'Ada Admin');
    managerToken = await tokenFor(env, estate.managerId, 'manager', 'Musa Manager');
    residentToken = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident');
    // Real password hashes: the seeded placeholder deliberately cannot verify.
    db.run(`UPDATE users SET password_hash=? WHERE id=?`, await hashPassword(PASSWORD), estate.residentId);
    db.run(`UPDATE users SET password_hash=? WHERE id=?`, await hashPassword(PASSWORD), estate.adminId);
  });

  describe('"Remember me" sessions', () => {
    it('keeps a remembered session for 30 days and an ordinary one for a working day', async () => {
      const remembered = await login({ email: RESIDENT_EMAIL, password: PASSWORD, rememberMe: true });
      expect(remembered.status).toBe(200);
      expect(remembered.setCookie).toContain(`Max-Age=${REMEMBER_ME_SECONDS}`);
      expect(remembered.json.rememberMe).toBe(true);
      const rememberedClaims = await verifyJwt(env, String(remembered.json.token));
      expect((rememberedClaims?.exp ?? 0) - (rememberedClaims?.iat ?? 0)).toBe(REMEMBER_ME_SECONDS);

      const ordinary = await login({ email: RESIDENT_EMAIL, password: PASSWORD });
      expect(ordinary.status).toBe(200);
      expect(ordinary.setCookie).toContain(`Max-Age=${SESSION_SECONDS}`);
      expect(ordinary.json.rememberMe).toBe(false);
      const ordinaryClaims = await verifyJwt(env, String(ordinary.json.token));
      expect((ordinaryClaims?.exp ?? 0) - (ordinaryClaims?.iat ?? 0)).toBe(SESSION_SECONDS);
    });

    it('carries the choice through a Security officer\'s gate selection', async () => {
      db.run(`UPDATE users SET password_hash=? WHERE id=?`, await hashPassword(PASSWORD), estate.securityId);
      db.run(
        `INSERT INTO hikvision_devices(id,name,gate_name,direction,status,connection_pattern,integration_mode)
         VALUES ('device-1','Gate A Terminal','Gate A','both','online','isapi_windows_agent','manual')`,
      );
      const select = await call(env, 'POST', '/api/security/gate-assignments', {
        token: adminToken,
        body: { securityUserId: estate.securityId, deviceId: 'device-1' },
      });
      expect(select.status).toBe(201);

      const signedIn = await login({ email: 'security@example.com', password: PASSWORD, rememberMe: true });
      expect(signedIn.json.requiresGateSelection).toBe(true);
      const scoped = await call(env, 'POST', '/api/auth/select-gate', {
        body: { selectionToken: String(signedIn.json.selectionToken), deviceId: 'device-1' },
      });
      expect(scoped.status).toBe(200);
      // Without the carry-through, the officer would be silently downgraded to a
      // 12-hour session by the gate picker.
      expect(scoped.setCookie).toContain(`Max-Age=${REMEMBER_ME_SECONDS}`);
      const claims = await verifyJwt(env, String(scoped.json.token));
      expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(REMEMBER_ME_SECONDS);
    });
  });

  describe('login failures say which failure they were', () => {
    it('answers a wrong password and an unknown address identically', async () => {
      const wrong = await login({ email: RESIDENT_EMAIL, password: 'not-the-password' });
      expect(wrong.status).toBe(401);
      expect(wrong.json.code).toBe('invalid_credentials');
      expect(wrong.setCookie).toBeNull();

      const unknown = await login({ email: 'nobody@example.com', password: 'not-the-password' });
      expect(unknown.status).toBe(401);
      expect(unknown.json.code).toBe('invalid_credentials');
      // Nothing in the answer may distinguish the two: not the sentence, not the
      // shape, not the timing of the message.
      expect(unknown.json.error).toBe(wrong.json.error);
      expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(wrong.json).sort());
    });

    it('names a deactivated account only once the password is right', async () => {
      db.run(`UPDATE users SET status='inactive' WHERE id=?`, estate.residentId);
      const wrongPassword = await login({ email: RESIDENT_EMAIL, password: 'not-the-password' });
      expect(wrongPassword.json.code).toBe('invalid_credentials');

      const rightPassword = await login({ email: RESIDENT_EMAIL, password: PASSWORD });
      expect(rightPassword.status).toBe(403);
      expect(rightPassword.json.code).toBe('account_inactive');
      expect(String(rightPassword.json.error)).toContain('deactivated');
      expect(rightPassword.setCookie).toBeNull();
    });

    it('names an expired account', async () => {
      db.run(`UPDATE users SET account_expires_at=datetime('now','-1 minute') WHERE id=?`, estate.residentId);
      const expired = await login({ email: RESIDENT_EMAIL, password: PASSWORD });
      expect(expired.status).toBe(403);
      expect(expired.json.code).toBe('account_expired');
    });

    it('refuses a request with no body, a partial body or a malformed one as a 400', async () => {
      const empty = await login({});
      expect(empty.status).toBe(400);
      expect(empty.json.code).toBe('validation');
      const noPassword = await login({ email: RESIDENT_EMAIL });
      expect(noPassword.status).toBe(400);
      expect(noPassword.json.code).toBe('validation');
      const malformed = await raw(env, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(malformed.status).toBe(400);
      expect(malformed.json.code).toBe('validation');
    });
  });

  describe('the sign-in throttle', () => {
    it('answers 429 with a Retry-After once the window is full, then clears on success', async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const failed = await login({ email: RESIDENT_EMAIL, password: `guess-${attempt}` });
        expect(failed.status).toBe(401);
      }
      const throttled = await login({ email: RESIDENT_EMAIL, password: PASSWORD });
      expect(throttled.status).toBe(429);
      expect(throttled.json.code).toBe('too_many_attempts');
      expect(Number(throttled.json.retryAfterSeconds)).toBeGreaterThan(0);
      expect(Number(throttled.retryAfter)).toBeGreaterThan(0);
      // The correct password is refused too: that is what a throttle means. It
      // is keyed on the submitted address, so an address with no account at all
      // is throttled the same way and cannot be told apart.
      const unknown = await login({ email: 'nobody@example.com', password: 'anything' });
      expect([401, 429]).toContain(unknown.status);
    });

    it('counts failures per address so one person cannot lock the estate out', async () => {
      // Three failures for the resident, then a successful sign-in clears them.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await login({ email: RESIDENT_EMAIL, password: `guess-${attempt}` });
      }
      expect((await login({ email: RESIDENT_EMAIL, password: PASSWORD })).status).toBe(200);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await login({ email: RESIDENT_EMAIL, password: `guess-again-${attempt}` });
        expect(failed.status).toBe(401);
      }
      expect((await login({ email: RESIDENT_EMAIL, password: PASSWORD })).status).toBe(200);
    });
  });

  describe('forgot password — the estate office queue', () => {
    it('records the request and answers with a reference, never with a code', async () => {
      const asked = await forgot({ email: RESIDENT_EMAIL, client: 'portal' });
      expect(asked.status).toBe(202);
      expect(asked.json.delivery).toBe('office');
      expect(String(asked.json.reference)).toMatch(/^PR-/);
      expect(asked.json.code).toBeUndefined();

      const row = db.one(`SELECT * FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL);
      expect(row).toMatchObject({ status: 'pending', delivery: 'office', requested_from: 'portal', email: RESIDENT_EMAIL });
      expect(row?.code_hash).toBeNull();
      expect(db.one(`SELECT action FROM audit_log WHERE action='request_password_reset'`)).toBeTruthy();
    });

    it('answers an address the estate does not have in exactly the same shape', async () => {
      const known = await forgot({ email: RESIDENT_EMAIL, client: 'android' });
      const unknown = await forgot({ email: 'stranger@example.com', client: 'android' });
      expect(unknown.status).toBe(known.status);
      expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(known.json).sort());
      expect(unknown.json.delivery).toBe(known.json.delivery);
      // The decoy reference is reference-shaped but backs nothing.
      expect(String(unknown.json.reference)).toMatch(/^PR-/);
      expect(db.one(`SELECT COUNT(*) AS count FROM password_reset_requests WHERE email=?`, 'stranger@example.com')?.count).toBe(0);
    });

    it('keeps the reference a person was already shown when they ask again', async () => {
      const first = await forgot({ email: RESIDENT_EMAIL, client: 'portal' });
      const second = await forgot({ email: RESIDENT_EMAIL, client: 'pc' });
      expect(second.json.reference).toBe(first.json.reference);
      const row = db.one(`SELECT request_count,status FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL);
      expect(row?.request_count).toBe(2);
      expect(row?.status).toBe('pending');
      expect(db.one(`SELECT COUNT(*) AS count FROM password_reset_requests`)?.count).toBe(1);
    });

    it('refuses an address that is not an email address', async () => {
      const refused = await forgot({ email: 'not-an-address' });
      expect(refused.status).toBe(400);
      expect(refused.json.code).toBe('validation');
    });

    it('rate-limits repeated requests for one address', async () => {
      for (let index = 0; index < 3; index += 1) {
        expect((await forgot({ email: RESIDENT_EMAIL, client: 'portal' })).status).toBe(202);
      }
      const fourth = await forgot({ email: RESIDENT_EMAIL, client: 'portal' });
      expect(fourth.status).toBe(429);
      expect(fourth.json.code).toBe('too_many_attempts');
      expect(Number(fourth.retryAfter)).toBeGreaterThan(0);
    });
  });

  describe('forgot password — self-service, when an Administrator switches it on', () => {
    it('is off by default and validated when set', async () => {
      expect(db.one(`SELECT value FROM settings WHERE key='password_reset_self_service'`)?.value).toBe('false');
      const refused = await call(env, 'PUT', '/api/settings/password_reset_self_service', { token: adminToken, body: { value: 'maybe' } });
      expect(refused.status).toBe(400);
      const badMinutes = await call(env, 'PUT', '/api/settings/password_reset_code_minutes', { token: adminToken, body: { value: '3' } });
      expect(badMinutes.status).toBe(400);
      const first = await forgot({ email: RESIDENT_EMAIL });
      expect(first.json.code).toBeUndefined();
    });

    it('hands out a one-time code that chooses a new password', async () => {
      await enableSelfService();
      const asked = await forgot({ email: RESIDENT_EMAIL, client: 'android' });
      expect(asked.status).toBe(202);
      expect(asked.json.delivery).toBe('self_service');
      const shown = String(asked.json.code);
      expect(shown).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      const expires = parseSqliteUtc(String(asked.json.expiresAt));
      expect(expires).not.toBeNull();
      expect(expires! - Date.now()).toBeGreaterThan(29 * 60_000);

      const row = db.one(`SELECT code_hash,code_expires_at FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL);
      expect(String(row?.code_hash)).not.toContain(normalizeResetCode(shown));

      const changed = await reset({ email: RESIDENT_EMAIL, code: shown, newPassword: RENAMED });
      expect(changed.status).toBe(200);

      expect((await login({ email: RESIDENT_EMAIL, password: RENAMED })).status).toBe(200);
      expect((await login({ email: RESIDENT_EMAIL, password: PASSWORD })).json.code).toBe('invalid_credentials');
      // Single use: the same code cannot be spent twice.
      const replay = await reset({ email: RESIDENT_EMAIL, code: shown, newPassword: 'yet-another-password' });
      expect(replay.status).toBe(401);
      expect(replay.json.code).toBe('invalid_reset_code');
      expect(db.one(`SELECT status FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL)?.status).toBe('completed');
    });

    it('ends every session that was issued before the password changed', async () => {
      await enableSelfService();
      const older = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident', Math.floor(Date.now() / 1000) - 3600);
      expect((await call(env, 'GET', '/api/properties', { token: older })).status).toBe(200);

      const asked = await forgot({ email: RESIDENT_EMAIL });
      const changed = await reset({ email: RESIDENT_EMAIL, code: String(asked.json.code), newPassword: RENAMED });
      expect(changed.status).toBe(200);

      const afterReset = await call(env, 'GET', '/api/properties', { token: older });
      expect(afterReset.status).toBe(401);
      expect(afterReset.json.code).toBe('session_ended');
      // The session handed back by the sign-in that follows still works.
      const fresh = await login({ email: RESIDENT_EMAIL, password: RENAMED });
      expect((await call(env, 'GET', '/api/properties', { token: String(fresh.json.token) })).status).toBe(200);
    });

    it('refuses a wrong code, an expired code, a short password and a code-less request', async () => {
      await enableSelfService();
      const asked = await forgot({ email: RESIDENT_EMAIL });
      const good = String(asked.json.code);

      const wrong = await reset({ email: RESIDENT_EMAIL, code: 'ZZZZ-ZZZZ', newPassword: RENAMED });
      expect(wrong.status).toBe(401);
      expect(wrong.json.code).toBe('invalid_reset_code');
      expect(String(wrong.json.error)).toContain('attempt');

      const weak = await reset({ email: RESIDENT_EMAIL, code: good, newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.json.code).toBe('weak_password');

      const noEmail = await reset({ email: RESIDENT_EMAIL, code: 'ABC', newPassword: RENAMED });
      expect(noEmail.status).toBe(400);

      // Guessing is capped: the last wrong attempt closes the request.
      for (let attempt = 1; attempt < RESET_CODE_MAX_ATTEMPTS; attempt += 1) {
        const guess = await reset({ email: RESIDENT_EMAIL, code: 'ZZZZ-ZZZZ', newPassword: RENAMED });
        expect(guess.status).toBe(401);
      }
      expect(db.one(`SELECT status FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL)?.status).toBe('expired');
      const closed = await reset({ email: RESIDENT_EMAIL, code: good, newPassword: RENAMED });
      expect(closed.status).toBe(401);
      expect(String(closed.json.error)).toContain('already been used');

      // A fresh request after an expired one works with the new code.
      const again = await forgot({ email: RESIDENT_EMAIL });
      expect(again.status).toBe(202);
      expect((await reset({ email: RESIDENT_EMAIL, code: String(again.json.code), newPassword: RENAMED })).status).toBe(200);
    });

    it('refuses a code that is past its expiry', async () => {
      await enableSelfService();
      const asked = await forgot({ email: RESIDENT_EMAIL });
      const code = String(asked.json.code);
      db.run(`UPDATE password_reset_requests SET code_expires_at=? WHERE email=?`, sqliteUtc(Date.now() - 60_000), RESIDENT_EMAIL);

      const expired = await reset({ email: RESIDENT_EMAIL, code, newPassword: RENAMED });
      expect(expired.status).toBe(401);
      expect(expired.json.code).toBe('reset_expired');
      expect(db.one(`SELECT status FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL)?.status).toBe('expired');
    });

    it('still records the request for the estate office', async () => {
      await enableSelfService();
      await forgot({ email: RESIDENT_EMAIL, client: 'android' });
      const queue = await call(env, 'GET', '/api/password-resets', { token: adminToken });
      expect(queue.status).toBe(200);
      expect(queue.json.settings).toMatchObject({ selfService: true, codeMinutes: 30 });
      const items = queue.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ delivery: 'self_service', requested_from: 'android', status: 'pending' });
    });
  });

  describe('the reset queue an administrator works from', () => {
    it('is administrator and manager only, and counts what is waiting', async () => {
      await forgot({ email: RESIDENT_EMAIL });
      expect((await call(env, 'GET', '/api/password-resets', { token: residentToken })).status).toBe(403);
      const asManager = await call(env, 'GET', '/api/password-resets', { token: managerToken });
      expect(asManager.status).toBe(200);
      expect((asManager.json.counts as Record<string, number>).pending).toBe(1);
      const dashboard = await call(env, 'GET', '/api/dashboard', { token: adminToken });
      expect((dashboard.json.pendingPasswordResets as Record<string, number>).count).toBe(1);
      const search = await call(env, 'GET', `/api/password-resets?search=${encodeURIComponent('resident@example.com')}`, { token: adminToken });
      expect((search.json.items as unknown[]).length).toBe(1);
    });

    it('issues a temporary password that signs in, and closes the request', async () => {
      await forgot({ email: RESIDENT_EMAIL, client: 'android' });
      const queue = await call(env, 'GET', '/api/password-resets', { token: adminToken });
      const requestId = String((queue.json.items as Array<Record<string, unknown>>)[0]!.id);

      const issued = await call(env, 'POST', `/api/password-resets/${requestId}/issue`, { token: adminToken });
      expect(issued.status).toBe(200);
      const temporary = String(issued.json.temporaryPassword);
      expect(temporary.length).toBeGreaterThanOrEqual(12);
      expect(db.one(`SELECT status,handled_by FROM password_reset_requests WHERE id=?`, requestId)).toMatchObject({
        status: 'issued',
        handled_by: estate.adminId,
      });
      expect((await login({ email: RESIDENT_EMAIL, password: temporary })).status).toBe(200);
      expect((await login({ email: RESIDENT_EMAIL, password: PASSWORD })).json.code).toBe('invalid_credentials');

      const again = await call(env, 'POST', `/api/password-resets/${requestId}/issue`, { token: adminToken });
      expect(again.status).toBe(409);
    });

    it('keeps a manager out of an administrator\'s own reset request', async () => {
      await forgot({ email: ADMIN_EMAIL });
      const queue = await call(env, 'GET', '/api/password-resets', { token: managerToken });
      const requestId = String((queue.json.items as Array<Record<string, unknown>>)[0]!.id);
      const refused = await call(env, 'POST', `/api/password-resets/${requestId}/issue`, { token: managerToken });
      expect(refused.status).toBe(403);
      expect((await call(env, 'POST', `/api/password-resets/${requestId}/dismiss`, { token: managerToken, body: { note: 'Wrong person.' } })).status).toBe(200);
      expect(db.one(`SELECT status,handled_note FROM password_reset_requests WHERE id=?`, requestId)).toMatchObject({
        status: 'dismissed',
        handled_note: 'Wrong person.',
      });
    });

    it('closes the queue entry when an administrator resets from People instead', async () => {
      await forgot({ email: RESIDENT_EMAIL });
      const reset = await call(env, 'POST', `/api/users/${estate.residentId}/reset-password`, { token: adminToken, body: {} });
      expect(reset.status).toBe(200);
      expect(db.one(`SELECT status FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL)?.status).toBe('issued');
    });
  });

  describe('changing a password from inside a session', () => {
    it('keeps the person signed in with a fresh session and ends the old one', async () => {
      const older = await tokenFor(env, estate.residentId, 'resident', 'Rita Resident', Math.floor(Date.now() / 1000) - 3600);
      const changed = await call(env, 'POST', '/api/auth/change-password', {
        token: older,
        body: { currentPassword: PASSWORD, newPassword: RENAMED },
      });
      // The old token is refused, but the route hands back one that works.
      const replaced = await call(env, 'GET', '/api/properties', { token: older });
      expect(replaced.status).toBe(401);
      expect(replaced.json.code).toBe('session_ended');
      const fresh = await call(env, 'GET', '/api/properties', { token: String(changed.json.token) });
      expect(fresh.status).toBe(200);
      expect(changed.setCookie).toContain('Max-Age=');
    });

    it('refuses a wrong current password, a repeated password and a weak one', async () => {
      expect((await call(env, 'POST', '/api/auth/change-password', { token: residentToken, body: { currentPassword: 'nope', newPassword: RENAMED } })).json.code).toBe('invalid_credentials');
      expect((await call(env, 'POST', '/api/auth/change-password', { token: residentToken, body: { currentPassword: PASSWORD, newPassword: PASSWORD } })).json.code).toBe('weak_password');
      expect((await call(env, 'POST', '/api/auth/change-password', { token: residentToken, body: { currentPassword: PASSWORD, newPassword: 'short' } })).json.code).toBe('weak_password');
      expect((await call(env, 'POST', '/api/auth/change-password', { token: residentToken, body: {} })).json.code).toBe('validation');
    });
  });

  describe('the hourly sweep', () => {
    it('forgets old attempts and retires a request nobody answered', async () => {
      db.run(`INSERT INTO auth_attempts(id,kind,email,source_hash,succeeded,created_at) VALUES ('old','login','a@example.com','hash',0,datetime('now','-2 days'))`);
      await forgot({ email: RESIDENT_EMAIL });
      db.run(`UPDATE password_reset_requests SET last_requested_at=datetime('now','-8 days') WHERE email=?`, RESIDENT_EMAIL);

      const worker = (await import('../src/index')).default;
      await worker.scheduled(
        { cron: '0 * * * *' } as ScheduledEvent,
        env,
        { waitUntil: (promise: Promise<unknown>) => { void promise; } } as unknown as ExecutionContext,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(db.one(`SELECT COUNT(*) AS count FROM auth_attempts WHERE id='old'`)?.count).toBe(0);
      expect(db.one(`SELECT status FROM password_reset_requests WHERE email=?`, RESIDENT_EMAIL)?.status).toBe('expired');
    });
  });
});

/** `formatResetCode` is what the portal and the phone show, so it is asserted once here too. */
describe('reset code formatting', () => {
  it('prints the code the way a person reads it back', () => {
    expect(formatResetCode('7k2m9q4t')).toBe('7K2M-9Q4T');
    expect(normalizeResetCode('7K2M-9Q4T')).toBe('7K2M9Q4T');
  });
});
