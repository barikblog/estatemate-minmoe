-- Hikvision ISAPI bridge and Windows agent sync support
-- Provides agent registry, per-device ISAPI config, sync logs and extends device_operations for ISAPI.

-- ISAPI bridge / Windows agent registry
CREATE TABLE isapi_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT,
  platform TEXT NOT NULL DEFAULT 'windows' CHECK (platform IN ('windows','linux','darwin','other')),
  version TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline','disabled')),
  secret_hash TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX idx_isapi_agents_status ON isapi_agents(status, last_seen_at);
CREATE INDEX idx_isapi_agents_created ON isapi_agents(created_at DESC);

-- Per-device ISAPI configuration (how the agent reaches the device via ISAPI)
CREATE TABLE isapi_device_configs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES isapi_agents(id) ON DELETE SET NULL,
  isapi_host TEXT NOT NULL,
  isapi_port INTEGER NOT NULL DEFAULT 80 CHECK (isapi_port BETWEEN 1 AND 65535),
  isapi_username TEXT,
  isapi_password_ciphertext TEXT,
  isapi_password_iv TEXT,
  protocol TEXT NOT NULL DEFAULT 'http' CHECK (protocol IN ('http','https')),
  sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sync_enabled IN (0,1)),
  capabilities_json TEXT,
  last_sync_at TEXT,
  last_sync_status TEXT CHECK (last_sync_status IS NULL OR last_sync_status IN ('ok','failed','pending','syncing')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(device_id)
);
CREATE INDEX idx_isapi_device_configs_agent ON isapi_device_configs(agent_id, sync_enabled);
CREATE INDEX idx_isapi_device_configs_device ON isapi_device_configs(device_id);

-- Sync audit logs for ISAPI operations
CREATE TABLE isapi_sync_logs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES isapi_agents(id) ON DELETE SET NULL,
  operation_id TEXT,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','success','failed','pending')),
  message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_isapi_sync_logs_device ON isapi_sync_logs(device_id, created_at DESC);
CREATE INDEX idx_isapi_sync_logs_agent ON isapi_sync_logs(agent_id, created_at DESC);
CREATE INDEX idx_isapi_sync_logs_operation ON isapi_sync_logs(operation_id);

-- Windows agent installer / one-time sync keys (similar to site-sync)
CREATE TABLE isapi_agent_installers (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES isapi_agents(id) ON DELETE CASCADE,
  installer_key_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_isapi_agent_installers_agent ON isapi_agent_installers(agent_id, created_at DESC);

-- Extend hikvision_devices with ISAPI sync status (denormalized for quick listing)
ALTER TABLE hikvision_devices ADD COLUMN isapi_agent_id TEXT REFERENCES isapi_agents(id) ON DELETE SET NULL;
ALTER TABLE hikvision_devices ADD COLUMN isapi_sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (isapi_sync_enabled IN (0,1));
ALTER TABLE hikvision_devices ADD COLUMN last_isapi_sync_at TEXT;
ALTER TABLE hikvision_devices ADD COLUMN last_isapi_sync_status TEXT CHECK (last_isapi_sync_status IS NULL OR last_isapi_sync_status IN ('ok','failed','pending','syncing','offline'));
ALTER TABLE hikvision_devices ADD COLUMN isapi_host TEXT;
ALTER TABLE hikvision_devices ADD COLUMN isapi_port INTEGER CHECK (isapi_port IS NULL OR (isapi_port BETWEEN 1 AND 65535));
ALTER TABLE hikvision_devices ADD COLUMN isapi_username TEXT;
ALTER TABLE hikvision_devices ADD COLUMN isapi_password_ciphertext TEXT;
ALTER TABLE hikvision_devices ADD COLUMN isapi_password_iv TEXT;
ALTER TABLE hikvision_devices ADD COLUMN isapi_protocol TEXT CHECK (isapi_protocol IS NULL OR isapi_protocol IN ('http','https'));

CREATE INDEX idx_devices_isapi_agent ON hikvision_devices(isapi_agent_id, isapi_sync_enabled);

-- Extend device_operations to track which agent handled it
ALTER TABLE device_operations ADD COLUMN agent_id TEXT REFERENCES isapi_agents(id) ON DELETE SET NULL;
ALTER TABLE device_operations ADD COLUMN isapi_synced_at TEXT;
ALTER TABLE device_operations ADD COLUMN sync_source TEXT CHECK (sync_source IS NULL OR sync_source IN ('isup_gateway','isapi_bridge','windows_agent','manual'));

ALTER TABLE visitor_device_operations ADD COLUMN agent_id TEXT REFERENCES isapi_agents(id) ON DELETE SET NULL;
ALTER TABLE visitor_device_operations ADD COLUMN isapi_synced_at TEXT;
ALTER TABLE visitor_device_operations ADD COLUMN sync_source TEXT CHECK (sync_source IS NULL OR sync_source IN ('isup_gateway','isapi_bridge','windows_agent','manual'));

-- Seed settings for ISAPI bridge defaults
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('isapi_bridge_enabled','1'),
  ('windows_agent_enabled','1'),
  ('isapi_default_port','80'),
  ('isapi_sync_interval_seconds','30'),
  ('isapi_retry_interval_seconds','60');

PRAGMA foreign_key_check;
