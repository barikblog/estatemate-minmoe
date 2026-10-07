-- EstateMate's Employee ID policy is intentionally stricter than the terminal
-- wire limit: new or changed IDs must be 1-30 alphanumeric characters.
--
-- Migration 0018's original CHECK and migration 0022's charset triggers allow
-- 32 characters because that is what ISAPI terminals support. Do not rewrite
-- existing 31-32-character IDs here: some may already be stored on hardware.
-- The update triggers below allow an unrelated edit that writes the same legacy
-- value back, but reject creating a new long ID or changing one to another long
-- ID. Operators can replace legacy values with a new <=30-character ID when
-- device synchronization can be coordinated.

CREATE TRIGGER trg_users_employee_id_max_30_insert
BEFORE INSERT ON users
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL AND length(NEW.employee_id) > 30
BEGIN
  SELECT RAISE(ABORT, 'employee_id must not exceed 30 characters');
END;

CREATE TRIGGER trg_users_employee_id_max_30_update
BEFORE UPDATE OF employee_id ON users
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL
  AND NEW.employee_id IS NOT OLD.employee_id
  AND length(NEW.employee_id) > 30
BEGIN
  SELECT RAISE(ABORT, 'employee_id must not exceed 30 characters');
END;

CREATE TRIGGER trg_household_employee_id_max_30_insert
BEFORE INSERT ON household_members
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL AND length(NEW.employee_id) > 30
BEGIN
  SELECT RAISE(ABORT, 'employee_id must not exceed 30 characters');
END;

CREATE TRIGGER trg_household_employee_id_max_30_update
BEFORE UPDATE OF employee_id ON household_members
FOR EACH ROW WHEN NEW.employee_id IS NOT NULL
  AND NEW.employee_id IS NOT OLD.employee_id
  AND length(NEW.employee_id) > 30
BEGIN
  SELECT RAISE(ABORT, 'employee_id must not exceed 30 characters');
END;

CREATE TRIGGER trg_fingerprint_employee_no_max_30_insert
BEFORE INSERT ON fingerprint_credentials
FOR EACH ROW WHEN NEW.employee_no IS NOT NULL AND length(NEW.employee_no) > 30
BEGIN
  SELECT RAISE(ABORT, 'employee_no must not exceed 30 characters');
END;

CREATE TRIGGER trg_fingerprint_employee_no_max_30_update
BEFORE UPDATE OF employee_no ON fingerprint_credentials
FOR EACH ROW WHEN NEW.employee_no IS NOT NULL
  AND NEW.employee_no IS NOT OLD.employee_no
  AND length(NEW.employee_no) > 30
BEGIN
  SELECT RAISE(ABORT, 'employee_no must not exceed 30 characters');
END;

INSERT INTO settings(key,value)
VALUES ('employee_id_max_length','30')
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now');
