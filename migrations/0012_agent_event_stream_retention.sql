-- Agent event streaming (ISAPI alertStream) and D1 free-tier retention.
--
-- The ISAPI bridge / Windows agent can now stream real-time device events to
-- EstateMate in batches (POST /api/isapi/v1/agents/:id/events). Two settings
-- keep the deployment inside the Cloudflare Workers Free plan:
--
-- - agent_event_stream_enabled: master kill switch for agent event ingestion.
-- - access_event_retention_days: hourly cron prunes access_events and
--   isapi_sync_logs older than this many days (D1 free tier is 500 MB/DB).

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('agent_event_stream_enabled','true'),
  ('access_event_retention_days','365');

PRAGMA foreign_key_check;
