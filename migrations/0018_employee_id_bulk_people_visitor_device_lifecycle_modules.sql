-- Person-level Employee ID, bulk people operations, visitor device-account
-- lifecycle, and the six rolled-out estate modules.
--
-- Hardware truth this migration encodes:
--   * A MinMoe/ISAPI terminal identifies a person by `employeeNo` (or
--     `employeeNoString`). That field is bounded — 32 characters — so an
--     identifier longer than 32 is rejected by the terminal, silently on some
--     firmware. Before this migration the portal defaulted a fingerprint's
--     employee number to the EstateMate user id, which is a 36-character UUID
--     and therefore *always* over the limit. Every employee identifier is now
--     capped at 32 characters in the schema as well as in the API.
--   * Terminals have a limited number of person/card slots. A visitor pass must
--     therefore occupy a slot only while it is valid, and the slot must be
--     released when validity ends — while EstateMate keeps the pass record for
--     audit. `visitor_requests.device_account_state` is the ledger of that
--     lifecycle; nothing here ever deletes a visitor row.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Employee ID: one terminal identity per person, never longer than 32 chars.
--
-- Stored on the person (account or household dependant), not on each
-- credential, so a card and a fingerprint for the same human carry the same
-- employee number and a cardless gate event attributes to one person.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN employee_id TEXT
  CHECK (employee_id IS NULL OR length(employee_id) BETWEEN 1 AND 32);
ALTER TABLE household_members ADD COLUMN employee_id TEXT
  CHECK (employee_id IS NULL OR length(employee_id) BETWEEN 1 AND 32);

-- Backfill: a UUID without its hyphens is exactly 32 hex characters, so every
-- existing person gets a stable employee ID that already satisfies the cap and
-- that the terminal can store. Rows whose id is not UUID-shaped (or would
-- collide) are left NULL and are assigned by the API on first use.
UPDATE users
   SET employee_id = lower(replace(id,'-',''))
 WHERE employee_id IS NULL
   AND length(replace(id,'-','')) BETWEEN 1 AND 32
   AND lower(replace(id,'-','')) NOT IN (SELECT employee_id FROM users WHERE employee_id IS NOT NULL);

UPDATE household_members
   SET employee_id = lower(replace(id,'-',''))
 WHERE employee_id IS NULL
   AND length(replace(id,'-','')) BETWEEN 1 AND 32
   AND lower(replace(id,'-','')) NOT IN (SELECT employee_id FROM household_members WHERE employee_id IS NOT NULL);

-- Uniqueness is what makes cardless-event attribution unambiguous. Enforced per
-- table here; the API checks both tables because a dependant and an account must
-- not share one terminal identity.
CREATE UNIQUE INDEX idx_users_employee_id ON users(employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX idx_household_employee_id ON household_members(employee_id) WHERE employee_id IS NOT NULL;

-- Fingerprints already carried an employee_no with no length rule. Normalise the
-- over-long values the old UUID default produced (this maps them onto exactly the
-- person's new employee_id), then refuse over-long values at the database level
-- for both writes. SQLite cannot add a CHECK to an existing column, so triggers
-- carry the rule.
UPDATE fingerprint_credentials
   SET employee_no = substr(lower(replace(employee_no,'-','')),1,32)
 WHERE employee_no IS NOT NULL AND length(employee_no) > 32;

-- A fingerprint belonging to a dependant was left with no employee number at all
-- unless the operator typed one. Give every credential its person's identity.
UPDATE fingerprint_credentials
   SET employee_no = COALESCE(
     (SELECT h.employee_id FROM household_members h WHERE h.id = fingerprint_credentials.household_member_id),
     (SELECT u.employee_id FROM users u WHERE u.id = fingerprint_credentials.resident_id)
   )
 WHERE employee_no IS NULL;

CREATE TRIGGER trg_fingerprint_employee_no_max_insert
BEFORE INSERT ON fingerprint_credentials
FOR EACH ROW WHEN NEW.employee_no IS NOT NULL AND length(NEW.employee_no) > 32
BEGIN
  SELECT RAISE(ABORT, 'employee_no must not exceed 32 characters');
END;

CREATE TRIGGER trg_fingerprint_employee_no_max_update
BEFORE UPDATE OF employee_no ON fingerprint_credentials
FOR EACH ROW WHEN NEW.employee_no IS NOT NULL AND length(NEW.employee_no) > 32
BEGIN
  SELECT RAISE(ABORT, 'employee_no must not exceed 32 characters');
END;

-- ---------------------------------------------------------------------------
-- 2. Visitor device-account lifecycle.
--
-- A pass is provisioned onto terminals when it is issued, and the slot is
-- released as soon as validity expires. The app record survives: this is a state
-- machine, never a DELETE, so gate history, proof files and audit stay intact.
--   none           -> no terminal ever received this pass (no devices linked)
--   provisioned    -> an upsert_visitor operation was queued/applied
--   removal_queued -> validity ended; revoke_visitor queued for every device
--   removed        -> the agent (or an operator) confirmed the slot was freed
-- ---------------------------------------------------------------------------
ALTER TABLE visitor_requests ADD COLUMN device_account_state TEXT NOT NULL DEFAULT 'none'
  CHECK (device_account_state IN ('none','provisioned','removal_queued','removed'));
ALTER TABLE visitor_requests ADD COLUMN device_account_provisioned_at TEXT;
ALTER TABLE visitor_requests ADD COLUMN device_account_removed_at TEXT;
ALTER TABLE visitor_requests ADD COLUMN device_account_removed_reason TEXT;

-- Passes already pushed to hardware become 'provisioned'. Expired ones are then
-- picked up by the first sweep, which frees their slots — the cleanup this
-- feature exists for.
UPDATE visitor_requests
   SET device_account_state = 'provisioned',
       device_account_provisioned_at = (
         SELECT MIN(created_at) FROM visitor_device_operations
          WHERE visitor_request_id = visitor_requests.id AND operation = 'upsert_visitor'
       )
 WHERE EXISTS (
   SELECT 1 FROM visitor_device_operations
    WHERE visitor_request_id = visitor_requests.id AND operation = 'upsert_visitor'
 );

-- The sweep is indexed: it looks for live-state passes whose window has closed.
CREATE INDEX idx_visitors_device_account_sweep ON visitor_requests(device_account_state, valid_until, status);
CREATE INDEX idx_visitors_device_account_state ON visitor_requests(device_account_state, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Bulk people operations are audited through the existing import ledger.
--    `people_upload`, `people_edit` and `people_delete` join the kind list, so
--    the Import centre shows them next to user and card imports.
-- ---------------------------------------------------------------------------
ALTER TABLE import_jobs RENAME TO import_jobs_legacy;
DROP INDEX idx_import_jobs_created;
DROP INDEX idx_import_jobs_kind_created;

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bills','payments','users','properties','ownerships','tenancies','cards','people_upload','people_edit','people_delete')),
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','completed_with_errors','failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  successful_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT REFERENCES stored_files(storage_key),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO import_jobs(id,kind,filename,status,total_rows,successful_rows,error_rows,errors_json,uploaded_by,storage_key,created_at)
SELECT id,kind,filename,status,total_rows,successful_rows,error_rows,errors_json,uploaded_by,storage_key,created_at
FROM import_jobs_legacy;

DROP TABLE import_jobs_legacy;
CREATE INDEX idx_import_jobs_created ON import_jobs(created_at DESC);
CREATE INDEX idx_import_jobs_kind_created ON import_jobs(kind,created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Staff management: shift roster.
--
-- Gate *postings* already exist (security_gate_assignments, migration 0014) and
-- say which terminal an officer may operate. A shift says when they are on duty.
-- Both are needed for coverage reporting, so shifts reference the same people
-- and optionally the same device.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_shifts (
  id TEXT PRIMARY KEY,
  staff_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES hikvision_devices(id) ON DELETE SET NULL,
  shift_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  duty TEXT NOT NULL DEFAULT 'gate' CHECK (duty IN ('gate','patrol','office','cashier','supervisor','standby')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','worked','swapped','cancelled')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_staff_shifts_person ON staff_shifts(staff_user_id, shift_date);
CREATE INDEX idx_staff_shifts_date ON staff_shifts(shift_date, status);
CREATE INDEX idx_staff_shifts_device ON staff_shifts(device_id, shift_date);

-- ---------------------------------------------------------------------------
-- 5. Facility bookings: amenities, rates, approvals and the bill they raise.
-- ---------------------------------------------------------------------------
CREATE TABLE facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  location TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  hourly_rate_minor INTEGER NOT NULL DEFAULT 0 CHECK (hourly_rate_minor >= 0),
  deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0,1)),
  requires_payment INTEGER NOT NULL DEFAULT 0 CHECK (requires_payment IN (0,1)),
  min_notice_hours INTEGER NOT NULL DEFAULT 0 CHECK (min_notice_hours >= 0),
  max_hours_per_booking INTEGER NOT NULL DEFAULT 8 CHECK (max_hours_per_booking > 0),
  rules TEXT,
  photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_facilities_status ON facilities(status, name);

CREATE TABLE facility_bookings (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES users(id),
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  purpose TEXT,
  attendees INTEGER CHECK (attendees IS NULL OR attendees > 0),
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled','completed')),
  estimated_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_minor >= 0),
  deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  bill_id TEXT REFERENCES bills(id) ON DELETE SET NULL,
  payment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required','unpaid','paid','waived')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Double-booking is refused in the API (an overlap is a range predicate, which a
-- unique index cannot express); these indexes make that check and the calendar
-- view cheap.
CREATE INDEX idx_bookings_facility_window ON facility_bookings(facility_id, starts_at, ends_at, status);
CREATE INDEX idx_bookings_requester ON facility_bookings(requester_id, status, starts_at DESC);
CREATE INDEX idx_bookings_status_window ON facility_bookings(status, starts_at);
CREATE INDEX idx_bookings_bill ON facility_bookings(bill_id);

-- ---------------------------------------------------------------------------
-- 6. Emergency contacts: the guard-post directory, editable instead of hardcoded.
-- ---------------------------------------------------------------------------
CREATE TABLE emergency_contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('security','medical','fire','police','utility','management','neighbour','other')),
  role_title TEXT,
  phone TEXT,
  alternate_phone TEXT,
  email TEXT,
  address TEXT,
  available_hours TEXT,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 999),
  visible_to TEXT NOT NULL DEFAULT 'everyone' CHECK (visible_to IN ('everyone','staff','residents')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_emergency_contacts_visible ON emergency_contacts(status, visible_to, priority, name);
CREATE INDEX idx_emergency_contacts_category ON emergency_contacts(category, status);

-- The directory the portal used to hardcode, now editable estate data. Inserted
-- with fixed ids so re-running or upgrading an estate never duplicates them.
INSERT OR IGNORE INTO emergency_contacts(id,name,category,role_title,phone,available_hours,priority,visible_to,status) VALUES
  ('emergency-estate-security','Estate Security Office','security','24/7 response desk',NULL,'24 hours',10,'everyone','active'),
  ('emergency-facility-manager','Facility Manager','management','On-duty manager',NULL,'Office hours',20,'everyone','active'),
  ('emergency-medical','Medical / Ambulance','medical','Emergencies only','112','24 hours',30,'everyone','active'),
  ('emergency-police','Police','police','Emergencies only','112','24 hours',40,'everyone','active'),
  ('emergency-fire','Fire Service','fire','Emergencies only','112','24 hours',50,'everyone','active'),
  ('emergency-utility','Power / Utility Fault','utility','Outage reporting',NULL,'24 hours',60,'everyone','active');

-- ---------------------------------------------------------------------------
-- 7. Information hub and Legal & governance: one published-document library.
--
-- Both surfaces read the same table; `category` separates resident guides and
-- forms from the governance set (by-laws, house rules, privacy, agreements,
-- minutes). Files live in the administrator's private GitHub repository and
-- only the key is stored here, matching every other upload in EstateMate.
-- ---------------------------------------------------------------------------
CREATE TABLE estate_documents (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'guide'
    CHECK (category IN ('guide','form','bylaw','house_rule','privacy','agreement','minutes','policy','other')),
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  file_key TEXT REFERENCES stored_files(storage_key),
  external_url TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  effective_date TEXT,
  audience TEXT NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','residents','staff','managers')),
  requires_acknowledgement INTEGER NOT NULL DEFAULT 0 CHECK (requires_acknowledgement IN (0,1)),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  sort_order INTEGER NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 9999),
  published_at TEXT,
  published_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_library ON estate_documents(status, category, sort_order, title);
CREATE INDEX idx_documents_audience ON estate_documents(audience, status);

CREATE TABLE document_acknowledgements (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES estate_documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_id, user_id)
);
CREATE INDEX idx_document_acks_user ON document_acknowledgements(user_id, acknowledged_at DESC);
CREATE INDEX idx_document_acks_document ON document_acknowledgements(document_id, acknowledged_at DESC);

-- ---------------------------------------------------------------------------
-- 8. Settings for the new behaviour. All administrator-editable.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('employee_id_max_length','32'),
  ('visitor_device_account_policy','automatic'),
  ('visitor_device_account_sweep_minutes','1'),
  ('facility_booking_max_days_ahead','90'),
  ('facility_booking_default_notice_hours','24'),
  ('facility_booking_currency','NGN'),
  ('documents_require_acknowledgement','0'),
  ('emergency_contacts_public_numbers','112');

PRAGMA foreign_key_check;
