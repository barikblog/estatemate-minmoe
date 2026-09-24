-- Expand visitor requests to support mandatory or optional gate ID / invitation verification
ALTER TABLE visitor_requests ADD COLUMN require_gate_id_verification INTEGER NOT NULL DEFAULT 0 CHECK (require_gate_id_verification IN (0,1));
ALTER TABLE visitor_requests ADD COLUMN gate_verified_at TEXT;
ALTER TABLE visitor_requests ADD COLUMN gate_verified_by TEXT REFERENCES users(id);
ALTER TABLE visitor_requests ADD COLUMN gate_proof_key TEXT;
CREATE INDEX idx_visitors_gate_id_req ON visitor_requests(require_gate_id_verification, status);

-- Expand bill batches to support target_type all and audience targeting
ALTER TABLE bill_batches RENAME TO bill_batches_legacy;
DROP INDEX IF EXISTS idx_bill_batches_created;

CREATE TABLE bill_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  street_filter_json TEXT NOT NULL DEFAULT '[]',
  target_type TEXT NOT NULL DEFAULT 'street' CHECK (target_type IN ('street','block','zone','all')),
  target_filter_json TEXT,
  audience TEXT NOT NULL DEFAULT 'all_owners_and_tenants' CHECK (audience IN ('standard','all_owners_and_tenants','only_owners','only_tenants')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  due_date TEXT NOT NULL,
  bill_type TEXT NOT NULL,
  description TEXT,
  bill_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bill_batches(
  id,name,street_filter_json,target_type,target_filter_json,audience,amount_minor,currency,due_date,bill_type,description,bill_count,created_by,created_at
)
SELECT id,name,street_filter_json,target_type,target_filter_json,'standard',amount_minor,currency,due_date,bill_type,description,bill_count,created_by,created_at
FROM bill_batches_legacy;

DROP TABLE bill_batches_legacy;
CREATE INDEX idx_bill_batches_created ON bill_batches(created_at DESC);

-- Expand maintenance requests with scope (personal/street/block/zone/estate), status workflow and charging features
ALTER TABLE maintenance_requests RENAME TO maintenance_requests_legacy;
DROP INDEX IF EXISTS idx_maintenance_resident_status;
DROP INDEX IF EXISTS idx_maintenance_status_created;
DROP INDEX IF EXISTS idx_maintenance_property;

CREATE TABLE maintenance_requests (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES users(id),
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'personal' CHECK (scope_type IN ('personal','street','block','zone','estate')),
  scope_target TEXT,
  photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','needs_verification','rejected','completed','resolved','closed')),
  status_note TEXT,
  charge_amount_minor INTEGER,
  charge_target TEXT CHECK (charge_target IS NULL OR charge_target IN ('residence','resident','tenant','owner','street','block','zone','all')),
  charge_bill_id TEXT REFERENCES bills(id) ON DELETE SET NULL,
  charge_batch_id TEXT REFERENCES bill_batches(id) ON DELETE SET NULL,
  charged_at TEXT,
  charged_by TEXT REFERENCES users(id),
  ai_summary TEXT,
  ai_category TEXT,
  ai_urgency TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO maintenance_requests(
  id,resident_id,property_id,description,scope_type,photo_key,status,ai_summary,ai_category,ai_urgency,created_at,updated_at
)
SELECT id,resident_id,property_id,description,'personal',photo_key,status,ai_summary,ai_category,ai_urgency,created_at,updated_at
FROM maintenance_requests_legacy;

DROP TABLE maintenance_requests_legacy;

CREATE INDEX idx_maintenance_resident_status ON maintenance_requests(resident_id, status);
CREATE INDEX idx_maintenance_status_created ON maintenance_requests(status, created_at DESC);
CREATE INDEX idx_maintenance_property ON maintenance_requests(property_id,status);
CREATE INDEX idx_maintenance_scope ON maintenance_requests(scope_type,status);

PRAGMA foreign_key_check;
