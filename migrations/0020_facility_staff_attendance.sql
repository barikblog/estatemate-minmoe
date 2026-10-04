-- Dedicated facility-staff accounts and an auditable attendance register.
--
-- Facility staff is represented as an explicit compatibility flag because the
-- users.role CHECK constraint is intentionally append-only and Manager already
-- uses the same pattern. The API presents the effective role as `facility_staff`.
ALTER TABLE users ADD COLUMN is_facility_staff INTEGER NOT NULL DEFAULT 0
  CHECK (is_facility_staff IN (0,1));
CREATE INDEX idx_users_facility_staff_status ON users(is_facility_staff,status);

-- One row is one clock-in/clock-out session. `work_date` is the estate-local
-- date on which the session began; timestamps are stored as absolute UTC instants.
-- Self punches are stamped by the Worker, while manual HR entries/corrections
-- preserve who entered them and the reason in the normal audit log.
CREATE TABLE staff_attendance (
  id TEXT PRIMARY KEY,
  staff_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  work_date TEXT NOT NULL CHECK (length(work_date)=10),
  clock_in_at TEXT NOT NULL,
  clock_out_at TEXT,
  source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self','manual','adjusted')),
  note TEXT CHECK (note IS NULL OR length(note)<=500),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (clock_out_at IS NULL OR julianday(clock_out_at)>julianday(clock_in_at))
);

-- A person can have split sessions in one work day, but never two open sessions.
CREATE UNIQUE INDEX idx_staff_attendance_one_open
  ON staff_attendance(staff_user_id) WHERE clock_out_at IS NULL;
CREATE INDEX idx_staff_attendance_month
  ON staff_attendance(work_date,staff_user_id,clock_in_at);
CREATE INDEX idx_staff_attendance_person
  ON staff_attendance(staff_user_id,work_date DESC,clock_in_at DESC);

-- Defence in depth: attendance is for the dedicated Facility staff set only.
CREATE TRIGGER trg_staff_attendance_facility_staff_insert
BEFORE INSERT ON staff_attendance
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.staff_user_id AND is_facility_staff=1)
BEGIN
  SELECT RAISE(ABORT, 'attendance is only available to facility staff');
END;

CREATE TRIGGER trg_staff_attendance_facility_staff_update
BEFORE UPDATE OF staff_user_id ON staff_attendance
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.staff_user_id AND is_facility_staff=1)
BEGIN
  SELECT RAISE(ABORT, 'attendance is only available to facility staff');
END;

-- Keep past HR rows reportable even if an account is being reclassified. The
-- application returns a friendlier 409 first; this protects direct DB writes.
CREATE TRIGGER trg_facility_staff_attendance_role_history
BEFORE UPDATE OF is_facility_staff ON users
FOR EACH ROW
WHEN OLD.is_facility_staff=1 AND NEW.is_facility_staff=0
  AND EXISTS (SELECT 1 FROM staff_attendance WHERE staff_user_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'facility staff with attendance history cannot change roles');
END;

PRAGMA foreign_key_check;
