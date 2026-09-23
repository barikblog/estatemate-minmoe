-- A resident may own many properties, while each property has at most one active owner.
CREATE TABLE property_ownerships (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  resident_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_by TEXT REFERENCES users(id),
  revoked_at TEXT,
  revocation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_property_one_active_owner ON property_ownerships(property_id) WHERE status='active';
CREATE UNIQUE INDEX idx_property_owner_active_pair ON property_ownerships(property_id,resident_id) WHERE status='active';
CREATE INDEX idx_property_ownership_resident ON property_ownerships(resident_id,status,approved_at DESC);

-- Preserve every legacy resident/property assignment. If old data attached several
-- residents to one unit, the earliest active resident is retained as its owner.
INSERT OR IGNORE INTO property_ownerships(id,property_id,resident_id,status,approved_at,created_at)
SELECT lower(hex(randomblob(16))),u.property_id,u.id,'active',u.created_at,u.created_at
FROM users u
WHERE u.role='resident' AND u.property_id IS NOT NULL
ORDER BY u.created_at;

CREATE TABLE property_ownership_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  proposed_unit_number TEXT,
  proposed_street TEXT,
  proposed_address TEXT,
  request_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  resulting_property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (property_id IS NOT NULL OR (proposed_unit_number IS NOT NULL AND proposed_street IS NOT NULL AND proposed_address IS NOT NULL))
);
CREATE INDEX idx_ownership_requests_status ON property_ownership_requests(status,created_at DESC);
CREATE INDEX idx_ownership_requests_resident ON property_ownership_requests(requester_id,status,created_at DESC);
CREATE UNIQUE INDEX idx_one_pending_existing_request ON property_ownership_requests(requester_id,property_id) WHERE status='pending' AND property_id IS NOT NULL;

-- Services created by a multi-property resident can be associated with the correct unit.
ALTER TABLE visitor_requests ADD COLUMN property_id TEXT REFERENCES properties(id) ON DELETE SET NULL;
ALTER TABLE maintenance_requests ADD COLUMN property_id TEXT REFERENCES properties(id) ON DELETE SET NULL;
CREATE INDEX idx_visitors_property ON visitor_requests(property_id,status);
CREATE INDEX idx_maintenance_property ON maintenance_requests(property_id,status);

-- GitHub-backed private file storage configuration. The access token is encrypted
-- by the Worker before it is persisted and is never returned by the API.
CREATE TABLE github_storage_settings (
  id TEXT PRIMARY KEY CHECK (id='default'),
  enabled INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT '',
  repository TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT 'main',
  base_path TEXT NOT NULL DEFAULT 'uploads',
  token_ciphertext TEXT,
  token_iv TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO github_storage_settings(id) VALUES ('default');

CREATE TABLE stored_files (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  github_owner TEXT NOT NULL,
  github_repository TEXT NOT NULL,
  github_branch TEXT NOT NULL,
  github_path TEXT NOT NULL,
  github_sha TEXT NOT NULL,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL DEFAULT 'general',
  linked_entity_type TEXT,
  linked_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE(github_owner,github_repository,github_branch,github_path)
);
CREATE INDEX idx_stored_files_owner ON stored_files(uploaded_by,status,created_at DESC);
CREATE INDEX idx_stored_files_entity ON stored_files(linked_entity_type,linked_entity_id,status);

ALTER TABLE import_jobs ADD COLUMN storage_key TEXT REFERENCES stored_files(storage_key);
