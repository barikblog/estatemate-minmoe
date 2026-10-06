-- Terminal clock sync: the bridge watches the terminals' clocks and the
-- portal can show what it last reported.
--
-- Why the terminals' clocks matter at all
-- ---------------------------------------
-- A terminal enforces everything it enforces with its own clock. A visitor's
-- pass is a finite `UserInfo` window: the terminal compares the swipe moment
-- against `beginTime`/`endTime` on its own hardware. Remote Network
-- Verification decides against the bridge's clock, and gate events are
-- timestamped by the terminal's clock. A terminal that drifts hours from the
-- estate therefore rejects a live visitor pass early, honours a dead one
-- late, and files its gate history at the wrong moment — none of it visible
-- from the database, because nothing was ever asking the terminal what time
-- it thought it was.
--
-- What the column holds
-- ---------------------
-- One JSON object per terminal, written by the Worker from the agent's
-- heartbeat, exactly like `remote_verify_state`:
--
--   { "terminalTime": "<iso>", "driftMs": 7412, "lastCheckedAt": "<iso>",
--     "lastSyncAt": "<iso>|null", "syncs": 3, "lastError": null }
--
-- `driftMs` is terminal minus bridge host, positive = the terminal is ahead.
-- The bridge host sits on the estate LAN and is the reference every other
-- time-sensitive decision already trusts, so agreement with it is what
-- "correct" means here.
--
-- Defaults matter: the column stays NULL until a bridge that runs time sync
-- (opt-in on the bridge host, see isapi-bridge/README.md) reports, and a
-- heartbeat without a clock entry leaves the stored value alone — a bridge
-- that never had the feature keeps the row exactly as it was. This migration
-- adds a column and nothing else; no estate behaviour changes.

ALTER TABLE hikvision_devices ADD COLUMN device_clock TEXT;

PRAGMA foreign_key_check;
