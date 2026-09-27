-- Tamper-proof terminal employee numbers.
--
-- An access terminal files every card and fingerprint under a person ID (ISAPI
-- `employeeNo`) and reports it in each gate event, which makes it the identity
-- a cardless gate event is attributed by. Until now that number was either the
-- EstateMate user id (36 characters: more than the 1-32 bytes Hikvision
-- documents, so terminals refused every automatic card write), a value an
-- Administrator or Manager typed in (unvalidated, not unique, and able to
-- redirect another person's gate events), or — on the agents — a guessed "1".
--
-- From this migration on EstateMate issues the number itself
-- (src/employee-number.ts): nine digits, the last a Damm check digit, one per
-- person, and the database enforces the rules below so that no code path can
-- choose, change, reuse or share one.

CREATE TABLE employee_numbers (
  employee_no TEXT PRIMARY KEY
    CHECK (length(employee_no) = 9 AND employee_no NOT GLOB '*[^0-9]*' AND substr(employee_no, 1, 1) <> '0'),
  -- The main resident; for a household member, the main resident the member
  -- belonged to when the number was issued.
  resident_id TEXT NOT NULL REFERENCES users(id),
  -- Set when the number belongs to a household member rather than the main resident.
  household_member_id TEXT REFERENCES household_members(id),
  -- Who caused the number to be issued; NULL when the system issued it
  -- (a card operation, or an agent picking up a queued card).
  issued_by TEXT REFERENCES users(id),
  issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One number per person: a main resident is keyed by user id, a household
-- member by member id.
CREATE UNIQUE INDEX idx_employee_numbers_resident ON employee_numbers(resident_id) WHERE household_member_id IS NULL;
CREATE UNIQUE INDEX idx_employee_numbers_member ON employee_numbers(household_member_id) WHERE household_member_id IS NOT NULL;

-- An issued number never changes and is never deleted, so it can never be
-- moved to, or reissued for, somebody else. (People are never hard-deleted in
-- EstateMate, so these triggers block no existing flow.)
CREATE TRIGGER employee_numbers_immutable
BEFORE UPDATE ON employee_numbers
BEGIN
  SELECT RAISE(ABORT, 'employee numbers are immutable');
END;

CREATE TRIGGER employee_numbers_permanent
BEFORE DELETE ON employee_numbers
BEGIN
  SELECT RAISE(ABORT, 'employee numbers are permanent and never reused');
END;

-- A fingerprint recorded from now on must carry the number issued to that same
-- person — not another person's number, not a typed value, and not NULL.
CREATE TRIGGER fingerprint_employee_no_issued
BEFORE INSERT ON fingerprint_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM employee_numbers e
  WHERE e.employee_no = NEW.employee_no
    AND (
      (NEW.household_member_id IS NULL AND e.household_member_id IS NULL AND e.resident_id = NEW.resident_id)
      OR (NEW.household_member_id IS NOT NULL AND e.household_member_id = NEW.household_member_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a fingerprint must carry the employee number EstateMate issued to that person');
END;

-- A fingerprint's employee number can never be edited afterwards. Rows written
-- before this migration keep whatever they had, for history; they are not
-- rewritten here because the terminal may know the person by that value, and
-- attribution treats them as legacy (see consumeAccessEvents).
CREATE TRIGGER fingerprint_employee_no_immutable
BEFORE UPDATE OF employee_no ON fingerprint_credentials
WHEN OLD.employee_no IS NOT NEW.employee_no
BEGIN
  SELECT RAISE(ABORT, 'a fingerprint employee number is immutable');
END;
