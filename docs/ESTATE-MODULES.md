# Estate modules: dependants, staff, bookings, emergency contacts, documents

The six modules added to the menu in the grouped-navigation phase are live with
real tables, routes and permission rules (migration
`0018_employee_id_bulk_people_visitor_device_lifecycle_modules.sql`).

The permission model mirrors the rest of the portal:

- residents see their own household and request bookings;
- **Managers** run estate operations (staff, facilities, emergencies, documents,
  approval decisions) but stay operational-only — no billing control, no global
  settings, no private storage control;
- **Admin/Cashier** own anything that raises or waives money;
- **Admin** owns global settings.

## Dependants manager (`GET /api/dependants`)

One cross-household roster with each dependant's **live access picture**: active
and total cards, active and total fingerprints, gate-event count, last gate use,
main resident, unit, status. Filters: status, relationship, free-text search
(name, phone, email, Employee ID or main resident). Summary strip: total, active,
pending, domestic staff & caregivers, with-logins.

- Resident: sees only their own household (primary account or a dependant whose
  linked login is them).
- Cashier: read-only roster.
- Approve / reject / deactivate from the roster (existing household routes);
  deactivated dependants keep their record — only the credentials stop.
- New dependants: Tenancy & household (single) or **People → Bulk tools** (CSV).
- Every dependant gets their own 30-char Employee ID at creation — see
  [EMPLOYEE-ID-AND-BULK-PEOPLE.md](EMPLOYEE-ID-AND-BULK-PEOPLE.md).

## Staff management (`GET /api/staff`, `…/api/staff/shifts`)

Lists every non-resident account — administrators, managers, cashiers, security —
with role, Employee ID, phone, **gate postings** (from
`security_gate_assignments`), count and next scheduled shift, and audit
footprint (`audit_log` count + last action, so accountability has one table).

The **shift roster** (table `staff_shifts`) complements gate postings: a posting
says *which terminal* an officer may operate; a shift says *when* they're on
duty. Duties: gate, patrol, office, cashier, supervisor, standby. Optional gate
link (the same `hikvision_devices` posts). Operators create/edit; mark
worked/cancelled/swapped; delete only future *scheduled* shifts — past shifts
stay as history. All changes audit-logged (`staff_shift` entity).

## Facility bookings (`facilities`, `facility_bookings`)

- Admin/Manager define **facilities**: name, location, capacity, hourly rate and
  refundable deposit (minor units), approval on/off, payment on/off, minimum
  notice hours, max hours per booking, rules. Retire (soft) instead of delete
  when booking history exists.
- Resident/Admin/Manager **requests** a booking with a window, purpose,
  attendees and contact phone. Validation: readable datetimes in the estate
  timezone, end after start, within max-hours and notice limits, attendees
  within capacity, booking window bounded by `facility_booking_max_days_ahead`
  setting, and **no double-booking** — a pending or approved booking owns its
  window (range overlap enforced in the API, since no SQL unique index can
  express it).
- Approval queue for operators; auto-approve when the facility allows it.
- **Billing**: approving a paid booking raises an ordinary `bills` row
  (`bill_type='facility_booking'`, fee + deposit, due +7 days) on the requester —
  cashiers clear it in the existing payment flow, so no new payment path exists.
  Cancelling voids an unpaid bill. Waive-fee is Admin/Cashier only — the same
  billing ownership line as the rest of the platform.
- The calendar is readable by any signed-in role (occupancy isn't secret);
  residents listing their own requests via `mine=1` (and residents are always
  scoped to their own anyway).

## Emergency contacts (`emergency_contacts`)

The guard-post directory as estate data instead of hard-coded UI: name, category
(security, medical, fire, police, utility, management, neighbour, other), role
label, phone, alternate phone, email, address, available hours, visibility
(everyone / staff / residents), priority ordering. Migration seeds the six
national/estate defaults (with fixed ids so upgrades never duplicate).
Admin/Manager create, edit, hide/show and delete; directory renders with
tap-to-call on mobile. Staff-only numbers never render for residents — Security
counts as staff.

## Information hub & Legal/governance (`estate_documents`)

One library behind both menu pages, separated by `category`:

- **Information hub** (`set=info`): guides, forms, other resident documents.
- **Legal & governance** (`set=legal`): by-laws, house rules, privacy/data
  notices, residents' agreements, meeting minutes, policies.

A document may carry **text**, an uploaded **file** (private GitHub storage, the
same path as other uploads) or an **external link** — at least one is required.
Version, effective date, sort order, audience (everyone / residents / staff /
managers), draft/published/archived status.

Drafts render only for Admin/Manager; audience filtering applies per role.
Archive-instead-of-delete when read acknowledgements exist.

**Read acknowledgements** (`document_acknowledgements`): when a document
requires it, a reader clicks Acknowledge; tracking is per person, idempotent,
and operators can list who has read it (name, role, when).

## Settings added

| Key | Default | Meaning |
|---|---|---|
| `employee_id_max_length` | `30` | Current application limit for new or changed IDs; historical terminal IDs may be up to 32 |
| `visitor_device_account_policy` | `automatic` | The expiry-release policy in force |
| `visitor_device_account_sweep_minutes` | `1` | How often the cron releases slots |
| `facility_booking_max_days_ahead` | `90` | How far ahead bookings open |
| `facility_booking_default_notice_hours` | `24` | Default minimum notice |
| `facility_booking_currency` | `NGN` | Currency for facility rates |
| `documents_require_acknowledgement` | `0` | Default for new documents |
| `emergency_contacts_public_numbers` | `112` | National emergency numbers |
