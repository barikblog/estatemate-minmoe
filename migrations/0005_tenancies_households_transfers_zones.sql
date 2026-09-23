-- Property grouping beyond streets.
ALTER TABLE properties ADD COLUMN block TEXT;
ALTER TABLE properties ADD COLUMN zone TEXT;
CREATE INDEX idx_properties_block ON properties(block,unit_number);
CREATE INDEX idx_properties_zone ON properties(zone,street,unit_number);

-- Generalize existing street bill batches without breaking historical rows.
ALTER TABLE bill_batches ADD COLUMN target_type TEXT NOT NULL DEFAULT 'street' CHECK (target_type IN ('street','block','zone'));
ALTER TABLE bill_batches ADD COLUMN target_filter_json TEXT;
UPDATE bill_batches SET target_filter_json=street_filter_json WHERE target_filter_json IS NULL;

-- One active main tenancy is permitted per property. Legal ownership remains separate.
CREATE TABLE property_tenancies (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','ended','cancelled')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  billing_responsibility TEXT NOT NULL DEFAULT 'owner' CHECK (billing_responsibility IN ('owner','tenant')),
  can_manage_visitors INTEGER NOT NULL DEFAULT 1,
  can_manage_maintenance INTEGER NOT NULL DEFAULT 1,
  request_note TEXT,
  review_note TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  ended_by TEXT REFERENCES users(id),
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date IS NULL OR date(end_date)>=date(start_date))
);
CREATE UNIQUE INDEX idx_one_active_tenancy_per_property ON property_tenancies(property_id) WHERE status='active';
CREATE UNIQUE INDEX idx_one_pending_tenancy_per_property ON property_tenancies(property_id) WHERE status='pending';
CREATE INDEX idx_tenancies_tenant ON property_tenancies(tenant_id,status,start_date DESC);
CREATE INDEX idx_tenancies_property_history ON property_tenancies(property_id,created_at DESC);

-- Dependants may be profile-only or linked to an optional resident login.
CREATE TABLE household_members (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  primary_resident_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK (relationship IN ('spouse','child','parent','relative','domestic_staff','caregiver','other')),
  date_of_birth TEXT,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','inactive')),
  can_create_visitors INTEGER NOT NULL DEFAULT 0,
  can_view_bills INTEGER NOT NULL DEFAULT 0,
  request_note TEXT,
  review_note TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  deactivated_by TEXT REFERENCES users(id),
  deactivated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_household_property ON household_members(property_id,status,name);
CREATE INDEX idx_household_primary ON household_members(primary_resident_id,status,created_at DESC);
CREATE UNIQUE INDEX idx_household_linked_user_active ON household_members(linked_user_id) WHERE status='active' AND linked_user_id IS NOT NULL;

ALTER TABLE access_cards ADD COLUMN household_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL;
CREATE INDEX idx_access_cards_household ON access_cards(household_member_id,status);
ALTER TABLE access_events ADD COLUMN household_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL;
CREATE INDEX idx_access_events_household ON access_events(household_member_id,device_timestamp DESC);

-- Ownership transfer requests preserve legal ownership history and can be scheduled.
CREATE TABLE property_transfer_requests (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_owner_id TEXT NOT NULL REFERENCES users(id),
  to_owner_id TEXT NOT NULL REFERENCES users(id),
  effective_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','completed','rejected','cancelled','failed')),
  request_note TEXT,
  review_note TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  completed_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_owner_id != to_owner_id)
);
CREATE UNIQUE INDEX idx_one_open_transfer_per_property ON property_transfer_requests(property_id) WHERE status IN ('pending','scheduled');
CREATE INDEX idx_transfers_owner ON property_transfer_requests(from_owner_id,status,created_at DESC);
CREATE INDEX idx_transfers_due ON property_transfer_requests(status,effective_date);
