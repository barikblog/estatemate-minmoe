-- Employee IDs are letters and digits only.
--
-- Hardware truth this migration encodes: a terminal accepts nothing else as
-- an employeeNo/employeeNoString. The previous charset (letters, digits and
-- `._-/`) let the portal issue identities a strict terminal silently refuses,
-- so the person simply never opened the gate and nothing explained why.
--
-- Existing values are normalised by stripping the separators the old charset
-- allowed. Rows that would collide after stripping keep the first 24
-- characters and gain 8 characters of their own id, so every identity stays
-- unique, still within the 32-character cap, and still readable. Anything
-- that cannot be repaired (an identifier made only of separators) is set NULL
-- and re-issued by the API on first use; no person row is ever deleted here.
--
-- Enforcement going forward is by trigger on all three columns (SQLite cannot
-- add a CHECK to an existing column): `users.employee_id`,
-- `household_members.employee_id` and `fingerprint_credentials.employee_no`.
-- The triggers only fire when the guarded column itself is written, so rows
-- holding history are never blocked from other updates.
--
-- Deliberately untouched: `access_events.employee_no` (what the terminal
-- reported — history), `device_person_state.employee_no` (a cache the next
-- sync overwrites), `fingerprint_captures.employee_no` (rows that expire
-- within minutes), and queued-operation payloads (a stale pending visitor
-- upsert is created under the new name by the bridge; anything already on a
-- terminal under the old shape stays deletable because the bridges accept the
-- legacy shape on delete paths only).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Accounts: strip the old separators, disambiguating collisions.
-- ---------------------------------------------------------------------------
UPDATE users
   SET employee_id = REPLACE(REPLACE(REPLACE(REPLACE(employee_id, '-', ''), '_', ''), '.', ''), '/', '')
 WHERE employee_id IS NOT NULL
   AND employee_id GLOB '*[^A-Za-z0-9]*'
   AND NOT EXISTS (
     SELECT 1 FROM users u2
      WHERE u2.id <> users.id
        AND REPLACE(REPLACE(REPLACE(REPLACE(u2.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
            = REPLACE(REPLACE(REPLACE(REPLACE(users.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
   )
   AND NOT EXISTS (
     SELECT 1 FROM household_members h
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(h.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
            = REPLACE(REPLACE(REPLACE(REPLACE(users.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
   );

UPDATE users
   SET employee_id = substr(REPLACE(REPLACE(REPLACE(REPLACE(employee_id, '-', ''), '_', ''), '.', ''), '/', ''), 1, 24)
                     || substr(REPLACE(REPLACE(REPLACE(REPLACE(id, '-', ''), '_', ''), '.', ''), '/', ''), 1, 8)
 WHERE employee_id IS NOT NULL
   AND employee_id GLOB '*[^A-Za-z0-9]*';

UPDATE users SET employee_id = NULL
 WHERE employee_id IS NOT NULL
   AND (employee_id GLOB '*[^A-Za-z0-9]*' OR length(employee_id) < 1 OR length(employee_id) > 32);

-- ---------------------------------------------------------------------------
-- 2. Dependants: the same normalisation, still unique against both tables.
-- ---------------------------------------------------------------------------
UPDATE household_members
   SET employee_id = REPLACE(REPLACE(REPLACE(REPLACE(employee_id, '-', ''), '_', ''), '.', ''), '/', '')
 WHERE employee_id IS NOT NULL
   AND employee_id GLOB '*[^A-Za-z0-9]*'
   AND NOT EXISTS (
     SELECT 1 FROM household_members h2
      WHERE h2.id <> household_members.id
        AND REPLACE(REPLACE(REPLACE(REPLACE(h2.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
            = REPLACE(REPLACE(REPLACE(REPLACE(household_members.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
   )
   AND NOT EXISTS (
     SELECT 1 FROM users u
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(u.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
            = REPLACE(REPLACE(REPLACE(REPLACE(household_members.employee_id, '-', ''), '_', ''), '.', ''), '/', '')
   );

UPDATE household_members
   SET employee_id = substr(REPLACE(REPLACE(REPLACE(REPLACE(employee_id, '-', ''), '_', ''), '.', ''), '/', ''), 1, 24)
                     || substr(REPLACE(REPLACE(REPLACE(REPLACE(id, '-', ''), '_', ''), '.', ''), '/', ''), 1, 8)
 WHERE employee_id IS NOT NULL
   AND employee_id GLOB '*[^A-Za-z0-9]*';

UPDATE household_members SET employee_id = NULL
 WHERE employee_id IS NOT NULL
   AND (employee_id GLOB '*[^A-Za-z0-9]*' OR length(employee_id) < 1 OR length(employee_id) > 32);

-- ---------------------------------------------------------------------------
-- 3. Fingerprints: re-point unusable values at the person's own identity.
-- ---------------------------------------------------------------------------
UPDATE fingerprint_credentials
   SET employee_no = COALESCE(
     (SELECT h.employee_id FROM household_members h WHERE h.id = fingerprint_credentials.household_member_id),
     (SELECT u.employee_id FROM users u WHERE u.id = fingerprint_credentials.resident_id),
     REPLACE(REPLACE(REPLACE(REPLACE(employee_no, '-', ''), '_', ''), '.', ''), '/', '')
   )
 WHERE employee_no IS NOT NULL
   AND (employee_no GLOB '*[^A-Za-z0-9]*' OR length(employee_no) < 1 OR length(employee_no) > 32);

UPDATE fingerprint_credentials SET employee_no = NULL
 WHERE employee_no IS NOT NULL
   AND (employee_no GLOB '*[^A-Za-z0-9]*' OR length(employee_no) < 1 OR length(employee_no) > 32);

-- ---------------------------------------------------------------------------
-- 4. Triggers: letters and digits, 1-32 characters, on every future write.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_fingerprint_employee_no_max_insert;
DROP TRIGGER IF EXISTS trg_fingerprint_employee_no_max_update;

CREATE TRIGGER trg_users_employee_id_charset_insert
BEFORE INSERT ON users
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL
  AND (NEW.employee_id GLOB '*[^A-Za-z0-9]*' OR length(NEW.employee_id) < 1 OR length(NEW.employee_id) > 32)
BEGIN
  SELECT RAISE(ABORT, 'employee_id may only contain letters and numbers (1-32 characters)');
END;

CREATE TRIGGER trg_users_employee_id_charset_update
BEFORE UPDATE OF employee_id ON users
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL
  AND (NEW.employee_id GLOB '*[^A-Za-z0-9]*' OR length(NEW.employee_id) < 1 OR length(NEW.employee_id) > 32)
BEGIN
  SELECT RAISE(ABORT, 'employee_id may only contain letters and numbers (1-32 characters)');
END;

CREATE TRIGGER trg_household_employee_id_charset_insert
BEFORE INSERT ON household_members
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL
  AND (NEW.employee_id GLOB '*[^A-Za-z0-9]*' OR length(NEW.employee_id) < 1 OR length(NEW.employee_id) > 32)
BEGIN
  SELECT RAISE(ABORT, 'employee_id may only contain letters and numbers (1-32 characters)');
END;

CREATE TRIGGER trg_household_employee_id_charset_update
BEFORE UPDATE OF employee_id ON household_members
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL
  AND (NEW.employee_id GLOB '*[^A-Za-z0-9]*' OR length(NEW.employee_id) < 1 OR length(NEW.employee_id) > 32)
BEGIN
  SELECT RAISE(ABORT, 'employee_id may only contain letters and numbers (1-32 characters)');
END;

CREATE TRIGGER trg_fingerprint_employee_no_charset_insert
BEFORE INSERT ON fingerprint_credentials
FOR EACH ROW WHEN NEW.employee_no IS NOT NULL
  AND (NEW.employee_no GLOB '*[^A-Za-z0-9]*' OR length(NEW.employee_no) < 1 OR length(NEW.employee_no) > 32)
BEGIN
  SELECT RAISE(ABORT, 'employee_no may only contain letters and numbers (1-32 characters)');
END;

CREATE TRIGGER trg_fingerprint_employee_no_charset_update
BEFORE UPDATE OF employee_no ON fingerprint_credentials
FOR EACH ROW WHEN NEW.employee_no IS NOT NULL
  AND (NEW.employee_no GLOB '*[^A-Za-z0-9]*' OR length(NEW.employee_no) < 1 OR length(NEW.employee_no) > 32)
BEGIN
  SELECT RAISE(ABORT, 'employee_no may only contain letters and numbers (1-32 characters)');
END;

PRAGMA foreign_key_check;
