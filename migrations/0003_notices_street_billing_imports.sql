ALTER TABLE properties ADD COLUMN street TEXT;
CREATE INDEX idx_properties_street ON properties(street, unit_number);

ALTER TABLE bills ADD COLUMN batch_id TEXT;
ALTER TABLE bills ADD COLUMN external_reference TEXT;
CREATE UNIQUE INDEX idx_bills_external_reference ON bills(external_reference) WHERE external_reference IS NOT NULL;
CREATE INDEX idx_bills_batch ON bills(batch_id, created_at);

ALTER TABLE payments ADD COLUMN external_reference TEXT;
CREATE UNIQUE INDEX idx_payments_external_reference ON payments(external_reference) WHERE external_reference IS NOT NULL;

CREATE TABLE bill_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  street_filter_json TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  due_date TEXT NOT NULL,
  bill_type TEXT NOT NULL,
  description TEXT,
  bill_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bill_batches_created ON bill_batches(created_at DESC);

CREATE TABLE estate_notices (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','important','urgent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','inactive')),
  requires_acknowledgement INTEGER NOT NULL DEFAULT 1,
  published_from TEXT NOT NULL DEFAULT (datetime('now')),
  published_until TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notices_active_window ON estate_notices(status, published_from, published_until);
CREATE INDEX idx_notices_created ON estate_notices(created_at DESC);

CREATE TABLE notice_acknowledgements (
  notice_id TEXT NOT NULL REFERENCES estate_notices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(notice_id, user_id)
);
CREATE INDEX idx_notice_ack_user ON notice_acknowledgements(user_id, acknowledged_at DESC);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bills','payments')),
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','completed_with_errors','failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  successful_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_import_jobs_created ON import_jobs(created_at DESC);
CREATE INDEX idx_import_jobs_kind_created ON import_jobs(kind, created_at DESC);

-- Preserve any old administrator announcements as general estate notices before
-- the Community feature is removed from the clients.
INSERT INTO estate_notices(id,title,body,severity,status,requires_acknowledgement,published_from,created_by,created_at,updated_at)
SELECT id,title,body,'info','active',1,created_at,author_id,created_at,created_at
FROM community_posts
WHERE is_announcement = 1;
