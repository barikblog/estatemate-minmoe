-- Remote door commands from the administrator Access control remote page.
--
-- SQLite cannot widen a CHECK constraint in place, so device_operations is
-- rebuilt. No other table references it. Existing rows are copied unchanged.
-- The new operations are agent-side ISAPI commands (or a manual task when no
-- agent is linked). They are not an ISUP transport and they do not travel
-- through a Cloudflare Tunnel.

CREATE TABLE device_operations_new (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  card_id TEXT REFERENCES access_cards(id),
  fingerprint_id TEXT REFERENCES fingerprint_credentials(id),
  operation TEXT NOT NULL CHECK (operation IN (
    'upsert_card','enable_card','disable_card','delete_card',
    'enroll_fingerprint','enable_fingerprint','disable_fingerprint','delete_fingerprint',
    'remote_open','remote_close','remote_always_open','remote_always_close','remote_resume'
  )),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','manual_action_required','sent','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  manual_instruction TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  agent_id TEXT REFERENCES isapi_agents(id) ON DELETE SET NULL,
  isapi_synced_at TEXT,
  sync_source TEXT CHECK (sync_source IS NULL OR sync_source IN ('isup_gateway','isapi_bridge','windows_agent','manual'))
);

INSERT INTO device_operations_new(
  id,device_id,card_id,fingerprint_id,operation,payload_json,status,attempts,error_message,manual_instruction,
  created_at,updated_at,agent_id,isapi_synced_at,sync_source
)
SELECT
  id,device_id,card_id,fingerprint_id,operation,payload_json,status,attempts,error_message,manual_instruction,
  created_at,updated_at,agent_id,isapi_synced_at,sync_source
FROM device_operations;

DROP TABLE device_operations;
ALTER TABLE device_operations_new RENAME TO device_operations;

CREATE INDEX idx_device_operations_pending ON device_operations(device_id, status, created_at);
CREATE INDEX idx_device_operations_fingerprint ON device_operations(fingerprint_id);

PRAGMA foreign_key_check;
