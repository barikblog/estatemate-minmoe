# Estate modules: People, workforce attendance, bookings, emergency contacts, documents

These modules are live with real tables, routes and permission rules. The original
estate collections use migration
`0018_employee_id_bulk_people_visitor_device_lifecycle_modules.sql`; dedicated
Facility Staff accounts and attendance use
`0020_facility_staff_attendance.sql`.

Navigation is consolidated to match how the workflows relate: **People** has
Accounts and Household members tabs; **Property & tenancy** stays a separate
occupation/ownership workflow; **Documents & governance** has Guides & forms and
Legal & governance collection tabs. Facility Staff receive a separate limited
Time & attendance workspace.

The permission model mirrors the rest of the portal:

- residents open **My household** to see their own household and submit new members for approval, and can request bookings;
- Facility Staff can see and record only their own attendance and read estate
  notices; they cannot access the staff directory, property, resident, billing,
  device or other attendance APIs;
- **Managers** run estate operations (staff, facilities, emergencies, documents,
  attendance review and approval decisions) but stay operational-only — no billing
  control, no global settings, no private storage control;
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
- New household members: **People → Household members** (single) or **People → Accounts → Bulk tools** (CSV).
- Every dependant gets their own 32-char Employee ID at creation — see
  [EMPLOYEE-ID-AND-BULK-PEOPLE.md](EMPLOYEE-ID-AND-BULK-PEOPLE.md).

## Staff management (`GET /api/staff`, `…/api/staff/shifts`)

Lists every non-resident account — administrators, managers, cashiers, security,
and Facility Staff — with role, Employee ID, phone, **gate postings** (from
`security_gate_assignments`), count and next scheduled shift, and audit
footprint (`audit_log` count + last action, so accountability has one table).

The **shift roster** (table `staff_shifts`) complements gate postings: a posting
says *which terminal* an officer may operate; a shift says *when* they're on
duty. Duties: gate, patrol, office, cashier, supervisor, standby. Optional gate
link (the same `hikvision_devices` posts). Operators create/edit; mark
worked/cancelled/swapped; delete only future *scheduled* shifts — past shifts
stay as history. All changes audit-logged (`staff_shift` entity).

## Facility Staff attendance (`staff_attendance`)

A Facility Staff account is a dedicated least-privilege role, stored compatibly
as Security plus `is_facility_staff=1`. The API exposes it as `facility_staff`;
it is not a gate Security account and does not receive gate assignment controls.
Administrators and Managers can create/import these accounts from People.

- Staff clock themselves in and out. The Worker stamps UTC instants; the work
  date and displayed times use the estate's configured IANA timezone.
- One open session per staff member is enforced both in the API and with a
  partial unique index. Multiple closed sessions in one work date are allowed.
- Staff can read only their own records. An API-level allow-list also blocks
  attempts to open other modules, even if a menu is bypassed.
- Admin/Manager monthly reports include staff summaries, sessions, work dates,
  duration, open punches, and account status. The table exports to Excel/PDF.
  HR may enter a missing session or correct a punch; entries require a reason,
  reject future/overlapping times, record the editor and are written to the audit
  log. Accounts with attendance history cannot be converted to another role;
  deactivate them instead to retain HR history.
- Gate events are contextual evidence only. A gate swipe does not prove a full
  shift or determine paid time. Payroll/salary data and GPS tracking are outside
  this workflow.

See [FACILITY-STAFF-ATTENDANCE.md](FACILITY-STAFF-ATTENDANCE.md) for operation,
reporting and migration details.

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

## Documents & governance (`estate_documents`)

One menu item and one library, separated by internal collection tabs and
`category`:

- **Guides & forms** (`set=info`): resident guides, forms, other resident documents.
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
| `employee_id_max_length` | `32` | Documented constant for migrations and operators (enforced in code + schema) |
| `visitor_device_account_policy` | `automatic` | The expiry-release policy in force |
| `visitor_device_account_sweep_minutes` | `1` | How often the cron releases slots |
| `facility_booking_max_days_ahead` | `90` | How far ahead bookings open |
| `facility_booking_default_notice_hours` | `24` | Default minimum notice |
| `facility_booking_currency` | `NGN` | Currency for facility rates |
| `documents_require_acknowledgement` | `0` | Default for new documents |
| `emergency_contacts_public_numbers` | `112` | National emergency numbers |
