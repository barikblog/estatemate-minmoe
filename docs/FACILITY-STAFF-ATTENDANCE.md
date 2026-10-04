# Facility Staff attendance

Facility Staff are a distinct, least-privilege login role for employees whose monthly time records are reviewed by HR. This workflow complements (but does not replace) the existing staff directory and shift roster.

## What this workflow does

- Staff clock themselves in and out from their **Time & attendance** workspace. The Worker stamps each punch; the browser cannot submit or backdate a self punch.
- Staff see only their own clock status, monthly history and totals. They can read estate notices and change their password, but cannot browse the staff directory, other people's attendance, residents, properties, billing, devices or operations.
- Administrators and Managers review the monthly team report, filter by staff member, enter a missing session, correct an existing record and export the summary or session detail to Excel/PDF.
- A staff member may have more than one closed session on a work date (for split shifts), but only one open session at a time.

This is an attendance register, not payroll software. It stores no salary or payroll data, performs no GPS tracking and does not infer paid time from gate activity. A door swipe is contextual evidence only, not proof of a complete shift.

## Role setup

1. Sign in as an Administrator or Manager and open **People → Accounts**.
2. Add an account and choose **Facility staff**. The People CSV import templates also include a `facility_staff` role example.
3. Give the employee a unique Employee ID if it will also be used by an access terminal. As with other people, it is limited to 32 characters. Share the temporary password securely and ask the employee to change it.
4. Do not assign gate postings to a Facility Staff account. Gate Security and Facility Staff are distinct roles even though the database stores both against the legacy `security` role value for compatibility.

The API presents this role as `facility_staff` and persists `is_facility_staff=1`. Manager precedence and the existing `is_manager` compatibility flag remain unchanged. Admins and Managers may create the role; a Manager still cannot create or manage Admin/Manager accounts. If attendance history exists, the account cannot be converted to another role; deactivate it instead so past HR records remain accessible.

## How the record works

The `staff_attendance` table stores one row per clock-in/out session:

- `staff_user_id` — the Facility Staff account;
- `work_date` — the estate-local calendar date on which the session started;
- `clock_in_at` / `clock_out_at` — UTC timestamps;
- `source` — `self`, `manual` or `adjusted`;
- `note` — the required HR reason for a manual entry or correction;
- `created_by` / `updated_by` and timestamps — who recorded or last changed it.

The estate's configured IANA timezone is used for local work dates, HR-entered wall-clock times and display. If the estate timezone is not configured, the existing estate default (`Africa/Lagos`) is used. Dates are displayed as `YYYY-MM-DD`; times use 24-hour `HH:mm` format. For an overnight shift, `work_date` remains the date the shift began.

Self clock-in/out is server-stamped. A self punch cannot be supplied with a timestamp, and the unique partial index `idx_staff_attendance_one_open` prevents concurrent open sessions. The API also validates clock ordering, date validity, future times and overlaps. Manual sessions may last up to 24 hours.

## Monthly HR review and export

Open **Staff & attendance → Monthly attendance** as an Admin or Manager:

1. Select the report month and, if useful, one Facility Staff member.
2. Review the summary (staff, staff-days, sessions, hours and open punches) and session detail (work date, local punches, duration, record type and HR note).
3. Session detail is paginated at 1,000 rows. Select **Load next 1,000 sessions** until all matching rows are loaded before exporting a complete detail report.
4. Use **Export Excel** or **Export PDF** above either table. The summary and session detail are separate exports.
4. Compare the report with the approved duty roster and other HR source records before approving payroll. An open punch remains visibly open and should be reviewed.

The monthly summary is based on recorded sessions, not scheduled shifts. An open session contributes a recorded day/session but zero completed hours until closed. Inactive Facility Staff with historical attendance remain in HR results for their past records.

## Manual entry and correction controls

Admin/Manager manual entries and corrections require a reason of 4–500 characters. The API rejects invalid calendar dates, malformed local times, future records, zero/negative windows, sessions longer than 24 hours, and overlaps with another session for the same employee. Corrections preserve an audit before/after snapshot and set the source to `adjusted`; manual records use `manual`. The reason is stored on the attendance row and in the audit log.

A recommended reason identifies the evidence and approver, for example: “Missed punch verified against the signed duty register by the Facilities Supervisor.” Do not use a generic note such as “fix” or “HR”. Keep the signed register or other source document under the estate's existing HR retention policy; this feature does not store attachments.

## API and migration

- `GET /api/staff/attendance?month=YYYY-MM&staffId=...` — scoped personal view or Admin/Manager report. Omitting the month defaults to the current month in the estate timezone.
- `POST /api/staff/attendance/clock` with `{ "action": "clock_in" | "clock_out" }` — Facility Staff self-service.
- `POST /api/staff/attendance` — Admin/Manager manual entry.
- `PATCH /api/staff/attendance/:id` — Admin/Manager correction.
- `GET /api/staff?role=facility_staff` — Admin/Manager staff selector and directory filter.

Apply migration `0020_facility_staff_attendance.sql` before deploying the application update:

```bash
npm run db:migrate:remote
npm run deploy
```

The migration adds the `is_facility_staff` compatibility flag, the attendance table and indexes, and triggers that restrict attendance rows to Facility Staff accounts. The local migration and route-level test harness can be exercised with:

```bash
npm run db:migrate:local
npx vitest run test/estate-modules.test.ts
```

No remote migration is performed automatically by the application build. Plan the production migration during a suitable maintenance window and verify that the D1 migration completed before enabling the new role for staff.
