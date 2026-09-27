-- Cloudflare D1 schema for the Hikvision tunnel bridge Worker.
-- Apply with:
--   npx wrangler d1 execute hikvision-bridge-db --remote --file schema.sql
--   npx wrangler d1 execute hikvision-bridge-db --local  --file schema.sql
-- (The Worker also creates these idempotently at runtime if they are missing.)

-- OPERATION 1 target: access events pulled from the terminal.
CREATE TABLE IF NOT EXISTS access_logs (
  event_id    TEXT PRIMARY KEY,          -- device event id, or hik_<sha256> of time|employee|card|door|monitorIndex
  employee_no TEXT,
  card_no     TEXT,
  event_time  TEXT NOT NULL,             -- ISO-8601 timestamp as reported by the device
  door_no     TEXT,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_logs_time ON access_logs(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_employee ON access_logs(employee_no);

-- OPERATION 2 source: users queued for the device when no request body is sent.
CREATE TABLE IF NOT EXISTS device_users (
  employee_no       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  card_no           TEXT,
  card_type         TEXT NOT NULL DEFAULT 'normalCard',
  user_type         TEXT NOT NULL DEFAULT 'normal',
  group_no          TEXT NOT NULL DEFAULT '1',
  door_no           INTEGER NOT NULL DEFAULT 1,
  plan_template_no  TEXT NOT NULL DEFAULT '1',
  valid_start       TEXT,
  valid_end         TEXT,
  sync_status       TEXT NOT NULL DEFAULT 'pending', -- pending | synced | failed
  last_error        TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Device status reported by the last pull (shown by GET /health).
CREATE TABLE IF NOT EXISTS device_status (
  id               TEXT PRIMARY KEY,
  last_pull_at     TEXT,
  last_pull_ok     INTEGER,
  last_error       TEXT,
  last_event_count INTEGER,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
