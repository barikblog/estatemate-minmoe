-- Automatic person synchronisation and fingerprint capture from a chosen device.
--
-- Two gaps this closes:
--
-- 1. Cards were written to a terminal, but the *person* they belong to was not.
--    A card written for an employee number that has never been added as a person
--    is stored by some firmwares and ignored by others: the Reddit/Hikvision
--    field reports behind this change are consistent that a user created without
--    doorRight/RightPlan cannot open the door even though the card is recorded.
--    So the portal now queues a person record (UserInfo/Record) before the card,
--    and a delete-person command when the sync is explicitly asked to remove
--    somebody from a terminal.
--
-- 2. Fingerprint enrolment was always manual. The ISAPI surface does allow the
--    whole round trip on the LAN: the terminal collects a template
--    (POST /ISAPI/AccessControl/CaptureFingerPrint), another terminal accepts it
--    (POST/PUT /ISAPI/AccessControl/FingerPrint/SetUp with Base64 `fingerData`).
--    That needs the agent to hold the template between the two calls, which is
--    what `fingerprint_captures` is for. The template is transient on purpose:
--    it is deleted the moment every terminal has accepted it (or the capture
--    expires), so fingerprints stay on the terminals where they belong.
--
-- `device_person_state` is the portal's record of what a terminal actually has,
-- so "Sync now" can be idempotent and the person × terminal grid can be honest
-- about which sites are still waiting.

-- ── 1. What an agent says it can do ──────────────────────────────────────────
-- JSON array of capability tokens from the agent's heartbeat, e.g.
-- ["card","person","fingerprint","door"]. An older agent sends nothing: it keeps
-- card, visitor and door commands and every person/fingerprint operation is
-- queued for an operator instead of being sent to a terminal that cannot take it.
ALTER TABLE isapi_agents ADD COLUMN capabilities TEXT;

-- ── 2. Transient fingerprint templates ───────────────────────────────────────
CREATE TABLE fingerprint_captures (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  resident_id TEXT NOT NULL REFERENCES users(id),
  household_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  employee_no TEXT,
  person_name TEXT NOT NULL,
  finger_no INTEGER NOT NULL CHECK (finger_no BETWEEN 1 AND 10),
  finger_label TEXT,
  -- pending   : queued or claimed by the agent; the reader is waiting.
  -- captured  : the terminal returned a template; it is held until every
  --             terminal this person should be on has accepted it.
  -- failed    : the terminal refused, timed out or nobody touched the reader.
  -- cancelled : the operator stopped waiting.
  -- expired   : the template was held too long and was dropped without being
  --             stored anywhere.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','captured','failed','cancelled','expired')),
  -- Base64 template exactly as the terminal produced it. Never logged, never
  -- returned to a browser; reaching a second terminal is its only purpose.
  template_data TEXT,
  error_message TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_fingerprint_captures_status ON fingerprint_captures(status, device_id, created_at);
CREATE INDEX idx_fingerprint_captures_person ON fingerprint_captures(resident_id, household_member_id, created_at DESC);

-- ── 3. What each terminal holds per person ───────────────────────────────────
-- One row per person per terminal. `state`:
--   synced    : the terminal accepted the person record (and any credentials).
--   pending   : queued or in flight.
--   missing   : never sent, or the command failed and was not retried.
--   manual    : no agent is linked to that terminal; an operator has to do it.
--   removed   : removed from that terminal on purpose.
CREATE TABLE device_person_state (
  id TEXT PRIMARY KEY,
  person_kind TEXT NOT NULL CHECK (person_kind IN ('account','dependant')),
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  employee_no TEXT,
  person_name TEXT,
  state TEXT NOT NULL DEFAULT 'missing' CHECK (state IN ('synced','pending','missing','manual','removed')),
  fingerprint_count INTEGER NOT NULL DEFAULT 0,
  card_count INTEGER NOT NULL DEFAULT 0,
  last_operation_id TEXT,
  last_error TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_kind, person_id, device_id)
);
CREATE INDEX idx_device_person_state_device ON device_person_state(device_id, state);
CREATE INDEX idx_device_person_state_person ON device_person_state(person_kind, person_id);

-- ── 4. device_operations gains the person and the way back ───────────────────
-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt.
-- No other table declares a foreign key to device_operations. The 0016 columns
-- and the two indexes are preserved and every existing row is copied unchanged.
CREATE TABLE device_operations_new (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  -- The person a person-scoped operation is about (UserInfo/Record,
  -- UserInfo/Delete). Both stay NULL for a bare card or door command.
  user_id TEXT REFERENCES users(id),
  household_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  card_id TEXT REFERENCES access_cards(id),
  fingerprint_id TEXT REFERENCES fingerprint_credentials(id),
  -- Set for upload_fingerprint, so the agent can fetch the transient template.
  capture_id TEXT REFERENCES fingerprint_captures(id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'upsert_card','enable_card','disable_card','delete_card',
    'enroll_fingerprint','enable_fingerprint','disable_fingerprint','delete_fingerprint',
    'remote_open','remote_close','remote_always_open','remote_always_close','remote_resume',
    'upsert_person','delete_person','capture_fingerprint','upload_fingerprint','delete_fingerprint_device'
  )),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','manual_action_required','sent','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  manual_instruction TEXT,
  -- What the terminal answered, for the operations that return data: a captured
  -- template is written back here by the Worker, never to a browser.
  result_json TEXT,
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
CREATE INDEX idx_device_operations_person ON device_operations(user_id, household_member_id);
CREATE INDEX idx_device_operations_capture ON device_operations(capture_id);

PRAGMA foreign_key_check;
