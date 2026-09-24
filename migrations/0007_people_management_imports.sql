-- Expand import history to include administrator-managed bulk user registration.
ALTER TABLE import_jobs RENAME TO import_jobs_legacy;
DROP INDEX idx_import_jobs_created;
DROP INDEX idx_import_jobs_kind_created;

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bills','payments','users')),
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
