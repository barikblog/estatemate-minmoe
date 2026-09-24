-- Portal gate welcome image and Security gate-scoped login sessions.
--
-- 1. Estate gate welcome image
--    An Administrator may upload a photograph of the estate gate that is shown
--    behind the welcome text on the login screen and on the dashboard hero.
--    The image itself lives in the administrator-configured private GitHub
--    repository (D1 stores metadata only, per project rules); these settings
--    hold the resulting storage key plus presentation options. The image is
--    served by the unauthenticated GET /api/portal-gate-image route because the
--    login screen is rendered before a session exists, so only images the
--    administrator explicitly published under the `portal-branding` category can
--    ever be returned.
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('portal_gate_image_key',''),
  ('portal_gate_image_caption',''),
  ('portal_gate_image_enabled','false');

-- 2. Security gate assignments
--    Administrators and Managers attach one or more access-control devices
--    (gates) to a Security account. On login a Security officer must choose
--    which of those gates they are working for the session; that choice scopes
--    their visitor queue, gate activity and device list to a single gate so a
--    guard posted at Gate A cannot action passes issued for Gate B.
CREATE TABLE security_gate_assignments (
  id TEXT PRIMARY KEY,
  security_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  assigned_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (security_user_id, device_id)
);
CREATE INDEX idx_security_gates_user ON security_gate_assignments(security_user_id,active);
CREATE INDEX idx_security_gates_device ON security_gate_assignments(device_id,active);

-- 3. Gate session history
--    Records which gate each Security officer selected, so shift coverage and
--    gate-level decisions remain attributable after the session ends.
CREATE TABLE security_gate_sessions (
  id TEXT PRIMARY KEY,
  security_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX idx_security_sessions_user ON security_gate_sessions(security_user_id,started_at DESC);
CREATE INDEX idx_security_sessions_device ON security_gate_sessions(device_id,started_at DESC);
CREATE INDEX idx_security_sessions_open ON security_gate_sessions(security_user_id,ended_at);

PRAGMA foreign_key_check;
