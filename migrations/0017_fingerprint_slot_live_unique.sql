-- Fix the fingerprint slot uniqueness to match what the application enforces.
--
-- Migration 0015 created idx_fingerprints_person_slot as a plain (table-wide)
-- unique index on (resident_id, household member, finger_no), and its
-- accompanying documentation said the index "stops the same slot being
-- recorded twice for one person while still allowing a new record after a
-- revocation". The second half was false: DELETE /api/access/fingerprints/:id
-- keeps the row with status='revoked' (history-preserving), so the next
-- re-enrollment of the same slot for the same person — the documented
-- "delete and re-add" flow — always failed with a unique-constraint violation,
-- because the revoked historical row still occupied the (person, slot) key.
--
-- The application's own duplicate check (POST /api/access/fingerprints) only
-- refuses slots with a status of 'active' or 'suspended'. This migration makes
-- the schema say the same thing: a partial unique index covering only live
-- rows. Revoked rows (history) no longer block a fresh enrollment of the same
-- slot, and two live rows for one person and slot remain impossible.
--
-- No data is altered; only the index is replaced.

DROP INDEX idx_fingerprints_person_slot;

CREATE UNIQUE INDEX idx_fingerprints_person_slot_live
  ON fingerprint_credentials(resident_id, COALESCE(household_member_id,''), finger_no)
  WHERE status IN ('active','suspended');
