-- Sign-in experience: "remember me", failure throttling and the estate's own
-- password-reset path.
--
-- Why this exists
-- ---------------
-- Signing in is the one screen every role meets, and until now it answered every
-- failure with one sentence ("Invalid email or password") whether the password
-- was wrong, the account was deactivated, the account had expired, or the
-- estate's Worker was simply unreachable. There was also no way at all to
-- recover a forgotten password: the only path was asking an administrator to
-- issue a temporary password, with nothing recording that the person had asked.
--
-- What this migration adds
-- ------------------------
--   * `users.password_changed_at` — set whenever a password is set by
--     change-password, an administrator/manager reset or a completed reset. The
--     authentication middleware compares it with the token's `iat`, so a
--     password change invalidates every session issued before it. That matters
--     now that "Remember me" keeps a session for 30 days: without it, a
--     password reset would leave the old session live for a month.
--
--   * `auth_attempts` — one row per sign-in or forgot-password attempt, with the
--     source address stored as a salted hash and never as a plain address. It
--     backs a sliding-window throttle that protects the estate (and the free
--     plan's CPU budget, since every sign-in costs a PBKDF2 verification) and
--     gives the clients a real thing to say: "Too many attempts. Try again in
--     N minutes." Rows are pruned hourly.
--
--   * `password_reset_requests` — the estate's own reset queue. A request is
--     always recorded, whichever way it is delivered:
--       - `office`      (default) the requester is given a reference and the
--                       estate office issues a temporary password from the
--                       portal or the phone, exactly as it already can;
--       - `self_service` (Administrator opt-in) a short one-time code is handed
--                       to the requester over the same channel they asked, and
--                       a reset with it closes the request.
--     Both are visible to Administrators and Managers, and both are audited.
--
--   * Two private settings. They are deliberately NOT in the portal-config
--     projection (`PORTAL_SETTING_KEYS`), because that endpoint is
--     unauthenticated by necessity and this one is an estate security decision:
--     `password_reset_self_service` (default 'false') and
--     `password_reset_code_minutes` (default '30').

ALTER TABLE users ADD COLUMN password_changed_at TEXT;

CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('login','forgot_password')),
  email TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_source ON auth_attempts(kind, email, source_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_email ON auth_attempts(kind, email, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_created ON auth_attempts(created_at);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issued','dismissed','completed','expired')),
  delivery TEXT NOT NULL DEFAULT 'office' CHECK (delivery IN ('office','self_service')),
  requested_from TEXT NOT NULL DEFAULT 'unknown',
  requested_source_hash TEXT,
  code_hash TEXT,
  code_expires_at TEXT,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  handled_at TEXT,
  handled_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_reset_status ON password_reset_requests(status, last_requested_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_requests(user_id, status);

INSERT INTO settings(key, value) VALUES
  ('password_reset_self_service', 'false'),
  ('password_reset_code_minutes', '30')
ON CONFLICT(key) DO NOTHING;

-- Nothing above may leave a row pointing at a row that is not there.
PRAGMA foreign_key_check;
