-- Remote Network Verification: the terminal reads, the bridge decides.
--
-- The problem this closes
-- -----------------------
-- An access terminal holds a few thousand people (a MinMoe is typically
-- 1,500-3,000; the larger K1T8xx boxes are in the same order). An estate with
-- more humans than that cannot fit them on the device at all, so every attempt
-- to keep the terminal's user list in step with the estate fails at the same
-- wall: the device runs out of slots.
--
-- The way out is to stop asking the terminal to decide. It is configured as a
-- reader: it reports the credential it saw, and something on the LAN decides.
-- EstateMate Bridge is already on that LAN, already holds a persistent
-- alertStream connection to each terminal, and already knows how to send the
-- door command - so it can do the whole loop without the terminal ever holding
-- the people.
--
-- Why the decision is made from a local snapshot, not the database
-- ----------------------------------------------------------------
-- The estate's 20,000 users live in D1, which the bridge reaches over the
-- public internet. A live lookup per swipe would make a physical door depend on
-- the estate's uplink, on Cloudflare, and on a round trip nobody can promise
-- inside the few hundred milliseconds a person stands at a reader - and it would
-- fail *closed*, which at a gate means a crowd. So the bridge keeps a local
-- snapshot of the credential set and decides against that, refreshing it on an
-- interval. The loop stays on the LAN, and a dead internet link degrades to
-- "the snapshot is as fresh as it was", not "nobody gets in".
--
-- Defaults matter here: every column below leaves an existing estate behaving
-- exactly as it did before this migration ran. Remote verification is opt-in per
-- terminal, by an Administrator, once the model has been proven.

-- ── 1. Per-terminal configuration ───────────────────────────────────────────

-- 0 = the terminal decides locally, as it always has. 1 = the bridge decides
-- from its snapshot and answers with a door command.
ALTER TABLE hikvision_devices ADD COLUMN remote_verify_enabled INTEGER NOT NULL DEFAULT 0;

-- Which door the unlock command addresses. Hikvision numbers doors from 1 and
-- the agent already validates the range 1-8, so the column is validated in the
-- API rather than here (SQLite cannot add a CHECK to an existing column).
ALTER TABLE hikvision_devices ADD COLUMN remote_verify_door_no INTEGER NOT NULL DEFAULT 1;

-- A card left on a reader, or a person waving twice, produces several events in
-- a second. Without a cooldown each one fires another door command, which is
-- both noisy on the lock and a way to hold a door open. Per credential, per
-- device, in milliseconds.
ALTER TABLE hikvision_devices ADD COLUMN remote_verify_cooldown_ms INTEGER NOT NULL DEFAULT 1500;

-- What the bridge last told us about this terminal's half of the feature:
--   { "cacheVersion": "...", "cacheAgeSeconds": 42, "credentialCount": 20114,
--     "lastDecision": "granted", "lastReason": "unknown_credential",
--     "lastResult": "opened", "lastLatencyMs": 38, "lastAt": "<iso>",
--     "listener": "bound" | "off" }
-- Reported on the heartbeat so the portal can show whether the terminal is
-- actually being served, not merely switched on. Written by the Worker, never
-- read as a decision input - it is a status surface, not state.
ALTER TABLE hikvision_devices ADD COLUMN remote_verify_state TEXT;

-- ── 2. Recording what the bridge decided ────────────────────────────────────
--
-- The decision itself lands in `access_events` like any other gate event, with
-- the remote-verification fields the bridge sends alongside the document. Two
-- columns here because they are the two things an operator asks after the fact:
-- who decided, and did the door actually answer.

ALTER TABLE access_events ADD COLUMN remote_decision TEXT
  CHECK (remote_decision IS NULL OR remote_decision IN ('granted','denied'));
ALTER TABLE access_events ADD COLUMN remote_decision_reason TEXT;
ALTER TABLE access_events ADD COLUMN remote_door_result TEXT
  CHECK (remote_door_result IS NULL OR remote_door_result IN ('opened','refused','not_attempted'));

-- "Show me everything the bridge refused at the main gate this week" is the
-- audit question this feature invites, and it should not be a table scan.
CREATE INDEX idx_events_remote_decision ON access_events(remote_decision, device_timestamp DESC);

PRAGMA foreign_key_check;
