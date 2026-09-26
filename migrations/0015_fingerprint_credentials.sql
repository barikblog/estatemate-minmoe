-- Fingerprint credentials alongside access cards.
--
-- A card is a thing you carry; a fingerprint is a template the terminal stores
-- for a person (employee number + finger slot). Modelling fingerprints as a
-- separate table keeps `access_cards.card_uid` meaning exactly what it always
-- meant — a card number, still NOT NULL and still UNIQUE — instead of inventing
-- a fake card number for a finger, and it avoids rebuilding a table that
-- `access_events`, `device_operations` and `card_status_changes` reference.
--
-- Hardware truth this migration encodes:
--   * capturing a finger requires the physical finger at the terminal, so
--     enrolment is always an operator task (see `enroll_fingerprint`).
--   * the ISAPI access-control surface documents fingerprint *template* upload,
--     download and delete, but no per-model evidence is recorded in
--     `docs/device-profiles/` yet. Fingerprint hardware work is therefore queued
--     as `manual_action_required` and the ISAPI agent is never asked to perform
--     it. Record the evidence before automating any of it.

CREATE TABLE fingerprint_credentials (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES users(id),
  household_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
  -- The person's identifier on the terminal (ISAPI employeeNo / employeeNoString).
  -- This is what a fingerprint access event carries, so it is how an event is
  -- attributed to a person when no card number is present.
  employee_no TEXT,
  -- Finger slot as stored by the terminal (1-10 on most MinMoe/K1T terminals).
  finger_no INTEGER NOT NULL CHECK (finger_no BETWEEN 1 AND 10),
  -- Human label for the slot, e.g. "Right index". Free text on purpose.
  finger_label TEXT,
  -- The terminal the template was captured at, when the operator says which.
  enrolled_device_id TEXT REFERENCES hikvision_devices(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','suspended','revoked')),
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  deactivated_at TEXT,
  deactivated_reason TEXT,
  auto_expired INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One finger slot per person per slot number: re-enrolling slot 3 for the same
-- person replaces nothing, it is a duplicate and must be rejected. Slots are
-- scoped to the *person*, not globally, because every terminal numbers fingers
-- from 1.
CREATE UNIQUE INDEX idx_fingerprints_person_slot ON fingerprint_credentials(resident_id, COALESCE(household_member_id,''), finger_no);
CREATE INDEX idx_fingerprints_resident_status ON fingerprint_credentials(resident_id, status);
CREATE INDEX idx_fingerprints_household ON fingerprint_credentials(household_member_id, status);
CREATE INDEX idx_fingerprints_employee ON fingerprint_credentials(employee_no);
CREATE INDEX idx_fingerprints_status_expires ON fingerprint_credentials(status, expires_at);

-- Status history for fingerprints, mirroring card_status_changes so a reviewer
-- sees the same shape for either credential type.
CREATE TABLE fingerprint_status_changes (
  id TEXT PRIMARY KEY,
  fingerprint_id TEXT NOT NULL REFERENCES fingerprint_credentials(id),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fingerprint_changes_credential ON fingerprint_status_changes(fingerprint_id, created_at DESC);

-- An access event can now point at a fingerprint credential. The existing
-- `card_id` column keeps its FK to `access_cards`, so a fingerprint event records
-- its own link rather than pretending to be a card.
ALTER TABLE access_events ADD COLUMN fingerprint_id TEXT REFERENCES fingerprint_credentials(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend device_operations for fingerprints.
--
-- `operation` carries a CHECK constraint, and SQLite cannot widen one in place,
-- so the table is rebuilt. Nothing references `device_operations` (no other table
-- declares a foreign key to it), so dropping it orphans no child rows; its own
-- outgoing keys are re-declared below. Every column added by migration 0011 is
-- preserved, and the existing rows are copied unchanged.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE device_operations_new (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES hikvision_devices(id),
  -- Exactly one of these is set: a card credential or a fingerprint credential.
  card_id TEXT REFERENCES access_cards(id),
  fingerprint_id TEXT REFERENCES fingerprint_credentials(id),
  operation TEXT NOT NULL CHECK (operation IN (
    'upsert_card','enable_card','disable_card','delete_card',
    'enroll_fingerprint','enable_fingerprint','disable_fingerprint','delete_fingerprint'
  )),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','manual_action_required','sent','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  -- What the operator must do on the terminal for a manual action. Kept apart
  -- from error_message so a failed automatic delivery and a by-design manual step
  -- are never confused in the queue.
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
  id,device_id,card_id,NULL,operation,payload_json,status,attempts,error_message,NULL,
  created_at,updated_at,agent_id,isapi_synced_at,sync_source
FROM device_operations;

DROP TABLE device_operations;
ALTER TABLE device_operations_new RENAME TO device_operations;

CREATE INDEX idx_device_operations_pending ON device_operations(device_id, status, created_at);
CREATE INDEX idx_device_operations_fingerprint ON device_operations(fingerprint_id);

PRAGMA foreign_key_check;
