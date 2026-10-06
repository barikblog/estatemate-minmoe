# Employee ID (32-character rule) and bulk people operations

Introduced in migration `0018_employee_id_bulk_people_visitor_device_lifecycle_modules.sql`.

## Why the Employee ID exists

A MinMoe/ISAPI terminal identifies a person by `employeeNo` / `employeeNoString`.
Three facts follow from that:

1. **The field is bounded at 32 characters.** A longer value is rejected by the
   terminal — silently on some firmware, which is the worst failure mode: the
   person simply never opens the gate and nothing explains why. Before this
   change, the portal defaulted a fingerprint's employee number to the raw
   EstateMate UUID id — 36 characters, so *always* over the limit.
2. **Terminals hold a limited number of person records.** Who occupies a slot is
   data the portal has to manage deliberately (see
   [VISITOR-DEVICE-ACCOUNTS.md](VISITOR-DEVICE-ACCOUNTS.md)).
3. **One human should be one identity.** Cards and fingerprints for the same
   person must carry the same employee number, or a cardless gate event cannot
   be attributed back to the right person.

## The rule

> An Employee ID is **letters and digits only** and may never exceed **32
> characters** — that is what a terminal accepts as an
> employeeNo/employeeNoString.

Enforced four times, deliberately:

- **Portal validation** (`src/employee-id.ts`): rejected with a sentence an
  operator can act on (`Employee ID may only contain letters and numbers`,
  `Employee ID must not exceed 32 characters`).
- **Schema CHECK** on `users.employee_id` and `household_members.employee_id`
  (`length(employee_id) BETWEEN 1 AND 32`), from migration 0018.
- **Triggers** on `users.employee_id`, `household_members.employee_id` and
  `fingerprint_credentials.employee_no` (migration 0022), refusing any
  non-alphanumeric or over-long insert or update to those columns.
- **API**: every route that accepts or composes an employee number — person
  create/edit, fingerprint issue, card issue, visitor provisioning — validates
  and/or composes with the cap (`deviceEmployeeNo()` shrinks the *prefix*, never
  the unique identifier) and the charset.

Separators (`. _ - /`), spaces, `&`, `<`, `>`, quotes and commas are rejected
rather than rewritten, because an identifier that arrives mangled on the
terminal is worse than one the portal refused. Estates provisioned before
migration 0022 had stored values normalised by stripping those separators
(collisions gain 8 characters of the person's own id); run **Resynchronise
everyone** after deploying so the terminals store the new identities. A
terminal that stored the old shape still frees the slot on removal, because the
bridges accept the legacy shape on delete paths only.

## Who gets one, and how

- Every person — an **account** (`users`) or a **household dependant**
  (`household_members`) — gets an Employee ID at creation.
- **Supplied values win** (after validation and a uniqueness check that spans
  *both* tables: a dependant and an account must not share one identity).
- **Otherwise it is generated**: the person's UUID without hyphens is exactly 32
  hex characters, and the same value is reused for their next credential, so the
  identity is stable.
- Rows predating migration 0018 are backfilled the same way; any row whose id is
  not UUID-shaped is assigned on first use by `ensurePersonEmployeeId`.
- Editing an Employee ID does **not** push itself to hardware — terminals are
  told by a resynchronisation (below), and the bulk-edit response and the People
  page say so explicitly.

## Bulk people toolkit

People → **Bulk tools** (admin/manager). All four verbs work on the whole person
register — login accounts *and* dependants — because both hold credentials on
the same terminals.

### Upload — `POST /api/people/bulk-upload`

One CSV, archived against an import job (`people_upload`). Columns:

| Column | Meaning |
|---|---|
| `person_type` | `account` or `dependant` (required) |
| `name` | required |
| `email` | required for accounts |
| `role` | required for accounts |
| `employee_id` | optional, letters and digits, max 32 chars |
| `unit_number` | optional, residents only (vacant unit) |
| `status` | `active` (default) or `inactive` |
| `relationship` | required for dependants |
| `primary_resident_email` / `primary_resident_employee_id` | which household the dependant joins (one of them required) |
| `phone`, `date_of_birth`, `can_create_visitors`, `can_view_bills` | optional |

Limits: 500 rows per CSV. At most **25 new login accounts per upload** — each
one needs a PBKDF2-SHA256 hash (100 000 iterations), which is deliberately
strong and expensive inside a Worker's CPU budget; dependant rows are not
counted. Temporary passwords and generated Employee IDs are returned once in the
response and never stored.

### Edit — `POST /api/people/bulk-edit`

CSV matched by `employee_id` (email is a fallback). Only columns present in the
file change. `new_employee_id` re-points a terminal identity and is validated
against both tables; deactivating a person suspends their cards and
fingerprints the same way the single-record routes do.

### Delete — `POST /api/people/bulk-delete`

JSON `{ "confirm": "DELETE_PEOPLE", "employeeIds": [...] }` (or a `people` array
of `{ id, personType, email, employeeId }` references). It's the existing safe
soft delete, repeated: account deactivated or dependant deactivated, every
credential suspended and queued for removal, billing/access/audit history
preserved. Self-deletion, manager-deleting-admins, last-active-admin and
property/tenancy blockers all apply per row and appear in the row errors.

### Resynchronise — `POST /api/people/bulk-resync`

JSON `{ "scope": "all" }` or `{ "scope": "people", "employeeIds": [...] }`.
Re-queues every credential of the selected people against every enabled
terminal:

- **active cards** → `upsert_card` with the person's current Employee ID;
- **inactive cards** → `disable_card` (hardware stops matching the portal);
- **fingerprints** → the person record plus a template per finger, or an
  operator task. Where the terminal's bridge advertises the `fingerprint`
  capability the resync re-sends the stored template through the agent; where it
  does not (or the terminal refuses the call), the finger stays an operator task
  naming the slot and the employee number, exactly as before.

Open commands are reused, not duplicated — pressing resynchronise twice fills
nothing new into the Hardware actions queue.

`scope: "all"` only touches people who actually hold a credential.

## Import ledger

All four operations write `import_jobs` rows (kinds `people_upload`,
`people_edit`, `people_delete`, all recorded in the Import centre history), and
all are audit-logged. Managers may use the toolkit but cannot create,
elevate, or delete administrator/manager accounts — the same
`canManageAccount` rule the single-record routes enforce.
