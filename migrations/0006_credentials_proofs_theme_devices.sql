PRAGMA foreign_keys = ON;

-- Broader access-control inventory and safe soft deletion preserve historical gate events.
ALTER TABLE hikvision_devices ADD COLUMN vendor TEXT NOT NULL DEFAULT 'Hikvision';
ALTER TABLE hikvision_devices ADD COLUMN capabilities_json TEXT;
ALTER TABLE hikvision_devices ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_devices_active_status ON hikvision_devices(deleted_at,status,last_seen_at);

-- Visitor credentials can be scanned by phones and provisioned as a numeric card/QR
-- credential on compatible access-control devices. Security approval remains the default.
ALTER TABLE visitor_requests ADD COLUMN credential_number TEXT;
ALTER TABLE visitor_requests ADD COLUMN barcode_payload TEXT;
ALTER TABLE visitor_requests ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'hybrid';
ALTER TABLE visitor_requests ADD COLUMN device_id TEXT REFERENCES hikvision_devices(id) ON DELETE SET NULL;
ALTER TABLE visitor_requests ADD COLUMN requires_security_approval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE visitor_requests ADD COLUMN rejected_at TEXT;
ALTER TABLE visitor_requests ADD COLUMN rejected_by TEXT REFERENCES users(id);
ALTER TABLE visitor_requests ADD COLUMN rejection_note TEXT;
UPDATE visitor_requests SET credential_number=pin,barcode_payload=pin WHERE credential_number IS NULL;
CREATE UNIQUE INDEX idx_visitors_credential_number ON visitor_requests(credential_number);
CREATE INDEX idx_visitors_device_status ON visitor_requests(device_id,status,valid_until);

ALTER TABLE access_events ADD COLUMN visitor_request_id TEXT REFERENCES visitor_requests(id) ON DELETE SET NULL;
CREATE INDEX idx_access_events_visitor ON access_events(visitor_request_id,device_timestamp DESC);

CREATE TABLE credential_scan_sessions (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('card_enrollment','visitor_validation')),
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  resident_id TEXT REFERENCES users(id),
  household_member_id TEXT REFERENCES household_members(id),
  card_label TEXT,
  captured_credential TEXT,
  visitor_request_id TEXT REFERENCES visitor_requests(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','captured','completed','cancelled','expired')),
  expires_at TEXT NOT NULL,
  captured_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_one_waiting_scan_per_device ON credential_scan_sessions(device_id) WHERE status='waiting';
CREATE INDEX idx_scan_sessions_requester ON credential_scan_sessions(requested_by,status,created_at DESC);

CREATE TABLE visitor_code_scans (
  id TEXT PRIMARY KEY,
  visitor_request_id TEXT REFERENCES visitor_requests(id) ON DELETE SET NULL,
  scanned_by TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('phone_camera','device','manual')),
  scanned_value_masked TEXT,
  decision TEXT NOT NULL DEFAULT 'previewed' CHECK (decision IN ('previewed','accepted','rejected','invalid')),
  action TEXT CHECK (action IN ('in','out')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_visitor_scans_visitor ON visitor_code_scans(visitor_request_id,created_at DESC);
CREATE INDEX idx_visitor_scans_actor ON visitor_code_scans(scanned_by,created_at DESC);

CREATE TABLE visitor_device_operations (
  id TEXT PRIMARY KEY,
  visitor_request_id TEXT NOT NULL REFERENCES visitor_requests(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  operation TEXT NOT NULL CHECK (operation IN ('upsert_visitor','revoke_visitor')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','manual_action_required','sent','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_visitor_device_operations_pending ON visitor_device_operations(device_id,status,created_at);

-- Recommended portal defaults remain editable by administrators.
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('portal_name','EstateMate'),
  ('estate_name','EstateMate Estate'),
  ('portal_short_name','EM'),
  ('portal_tagline','One estate. One secure view.'),
  ('portal_welcome_text','Manage residents, visitors, accounts and gate access from a single, secure workspace.'),
  ('theme_mode','light'),
  ('theme_primary_color','#1769e0'),
  ('theme_accent_color','#35d07f'),
  ('theme_navigation_color','#0d1b37'),
  ('theme_surface_color','#ffffff'),
  ('theme_corner_style','comfortable'),
  ('support_email','sornixglobal@gmail.com'),
  ('support_phone',''),
  ('estate_timezone','Africa/Lagos'),
  ('visitor_default_duration_hours','8'),
  ('visitor_gate_policy','security_approval'),
  ('visitor_credential_format','qr_code128_pin'),
  ('card_scan_timeout_minutes','5'),
  ('render_bridge_url','');
