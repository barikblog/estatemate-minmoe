PRAGMA foreign_keys = ON;

CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  unit_number TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  owner_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','resident','security','cashier')),
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_role_status ON users(role, status);
CREATE INDEX idx_users_property ON users(property_id);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  resident_id TEXT NOT NULL REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid','void')),
  bill_type TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bills_property_status ON bills(property_id, status);
CREATE INDEX idx_bills_resident_status ON bills(resident_id, status);
CREATE INDEX idx_bills_type_due ON bills(bill_type, due_date, status);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  proof_image_key TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','pos','bank_transfer','online')),
  receipt_number TEXT NOT NULL UNIQUE,
  recorded_by TEXT REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'payment' CHECK (type IN ('payment','refund','adjustment')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT
);
CREATE INDEX idx_payments_bill_status ON payments(bill_id, status);
CREATE INDEX idx_payments_submitted ON payments(submitted_at DESC);

CREATE TABLE cash_reconciliations (
  id TEXT PRIMARY KEY,
  cashier_id TEXT NOT NULL REFERENCES users(id),
  business_date TEXT NOT NULL,
  expected_amount_minor INTEGER NOT NULL,
  counted_amount_minor INTEGER NOT NULL,
  variance_minor INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cashier_id, business_date)
);

CREATE TABLE visitor_requests (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES users(id),
  visitor_name TEXT NOT NULL,
  visitor_phone TEXT,
  pin TEXT NOT NULL UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','checked_in','checked_out','revoked','expired')),
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  checked_in_at TEXT,
  checked_in_by TEXT REFERENCES users(id),
  checked_out_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_visitors_resident_status ON visitor_requests(resident_id, status);
CREATE INDEX idx_visitors_pin ON visitor_requests(pin);
CREATE INDEX idx_visitors_valid ON visitor_requests(valid_until, status);

CREATE TABLE maintenance_requests (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','resolved','closed')),
  ai_summary TEXT,
  ai_category TEXT,
  ai_urgency TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_maintenance_resident_status ON maintenance_requests(resident_id, status);
CREATE INDEX idx_maintenance_status_created ON maintenance_requests(status, created_at DESC);

CREATE TABLE community_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_announcement INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_posts_created ON community_posts(created_at DESC);
CREATE INDEX idx_posts_announcement ON community_posts(is_announcement, created_at DESC);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  reported_by TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_incidents_created ON incidents(created_at DESC);

CREATE TABLE hikvision_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  serial_number TEXT UNIQUE,
  model TEXT,
  firmware TEXT,
  mac_address TEXT,
  gate_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('entry','exit','both')),
  integration_mode TEXT NOT NULL DEFAULT 'http_listener' CHECK (integration_mode IN ('http_listener','isup_bridge','manual')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline','disabled')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_devices_status_seen ON hikvision_devices(status, last_seen_at);

CREATE TABLE access_points (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('entry','exit')),
  device_id TEXT REFERENCES hikvision_devices(id) ON DELETE SET NULL,
  hikvision_channel INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_access_points_device ON access_points(device_id, enabled);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  UNIQUE(device_id, username)
);
CREATE INDEX idx_device_credentials_device ON device_credentials(device_id, revoked_at);

CREATE TABLE access_cards (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES users(id),
  card_uid TEXT NOT NULL UNIQUE,
  card_label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','suspended','revoked')),
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  deactivated_at TEXT,
  deactivated_reason TEXT,
  auto_expired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cards_resident_status ON access_cards(resident_id, status);
CREATE INDEX idx_cards_uid ON access_cards(card_uid);
CREATE INDEX idx_cards_expires ON access_cards(expires_at, status);

CREATE TABLE access_events (
  id TEXT PRIMARY KEY,
  vendor_event_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  access_point_id TEXT REFERENCES access_points(id),
  card_id TEXT REFERENCES access_cards(id),
  resident_id TEXT REFERENCES users(id),
  card_uid TEXT,
  person_name TEXT,
  direction TEXT CHECK (direction IN ('entry','exit')),
  result TEXT NOT NULL CHECK (result IN ('granted','denied','unknown')),
  event_type TEXT NOT NULL,
  device_timestamp TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_summary TEXT,
  UNIQUE(device_id, vendor_event_id)
);
CREATE INDEX idx_events_time ON access_events(device_timestamp DESC);
CREATE INDEX idx_events_point_time ON access_events(access_point_id, device_timestamp DESC);
CREATE INDEX idx_events_resident_time ON access_events(resident_id, device_timestamp DESC);
CREATE INDEX idx_events_card_time ON access_events(card_uid, device_timestamp DESC);
CREATE INDEX idx_events_result_time ON access_events(result, device_timestamp DESC);

CREATE TABLE card_status_changes (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES access_cards(id),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  bill_id TEXT REFERENCES bills(id),
  changed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_card_changes_card ON card_status_changes(card_id, created_at DESC);

CREATE TABLE device_operations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  card_id TEXT REFERENCES access_cards(id),
  operation TEXT NOT NULL CHECK (operation IN ('upsert_card','enable_card','disable_card','delete_card')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','manual_action_required','sent','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_device_operations_pending ON device_operations(device_id, status, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO settings(key, value) VALUES
  ('facility_fee_grace_period_days', '7'),
  ('currency', 'NGN'),
  ('hikvision_control_mode', 'events_only');

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  github_path TEXT,
  github_url TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_exports_created ON exports(created_at DESC);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, created_at DESC);
