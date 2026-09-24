-- Manager is represented by an explicit compatibility flag so the heavily referenced
-- users table does not need a destructive parent-table rebuild. Existing roles remain unchanged.
ALTER TABLE users ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0 CHECK (is_manager IN (0,1));
ALTER TABLE users ADD COLUMN account_expires_at TEXT;
CREATE INDEX idx_users_manager_status ON users(is_manager,status);
CREATE INDEX idx_users_expiry ON users(account_expires_at,status);

-- Extend private-GitHub-backed imports to common estate setup and access records.
ALTER TABLE import_jobs RENAME TO import_jobs_legacy;
DROP INDEX idx_import_jobs_created;
DROP INDEX idx_import_jobs_kind_created;

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bills','payments','users','properties','ownerships','tenancies','cards')),
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','completed_with_errors','failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  successful_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT REFERENCES stored_files(storage_key),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO import_jobs(id,kind,filename,status,total_rows,successful_rows,error_rows,errors_json,uploaded_by,storage_key,created_at)
SELECT id,kind,filename,status,total_rows,successful_rows,error_rows,errors_json,uploaded_by,storage_key,created_at
FROM import_jobs_legacy;

DROP TABLE import_jobs_legacy;
CREATE INDEX idx_import_jobs_created ON import_jobs(created_at DESC);
CREATE INDEX idx_import_jobs_kind_created ON import_jobs(kind,created_at DESC);

-- Hik-Connect verification material is encrypted by the Worker before persistence.
ALTER TABLE hikvision_devices ADD COLUMN hikconnect_server_address TEXT;
ALTER TABLE hikvision_devices ADD COLUMN hikconnect_device_serial TEXT;
ALTER TABLE hikvision_devices ADD COLUMN hikconnect_verification_code_ciphertext TEXT;
ALTER TABLE hikvision_devices ADD COLUMN hikconnect_verification_code_iv TEXT;
ALTER TABLE hikvision_devices ADD COLUMN sync_agent_secret_hash TEXT;
ALTER TABLE hikvision_devices ADD COLUMN sync_agent_generated_at TEXT;

PRAGMA foreign_key_check;
