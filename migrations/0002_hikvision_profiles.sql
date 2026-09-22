ALTER TABLE hikvision_devices ADD COLUMN profile_key TEXT NOT NULL DEFAULT 'generic_isapi';
ALTER TABLE hikvision_devices ADD COLUMN connection_pattern TEXT NOT NULL DEFAULT 'direct_http_listener';
ALTER TABLE hikvision_devices ADD COLUMN listener_format TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE hikvision_devices ADD COLUMN profile_config_json TEXT;

ALTER TABLE access_events ADD COLUMN employee_no TEXT;
ALTER TABLE access_events ADD COLUMN credential_type TEXT;
ALTER TABLE access_events ADD COLUMN door_no TEXT;
ALTER TABLE access_events ADD COLUMN profile_key TEXT NOT NULL DEFAULT 'generic_isapi';

CREATE INDEX idx_devices_profile_status ON hikvision_devices(profile_key, status);
CREATE INDEX idx_events_employee_time ON access_events(employee_no, device_timestamp DESC);
CREATE INDEX idx_events_credential_time ON access_events(credential_type, device_timestamp DESC);

UPDATE settings SET value = 'per_device', updated_at = datetime('now') WHERE key = 'hikvision_control_mode';
