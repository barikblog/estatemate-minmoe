# Visitor device accounts: created on request, deleted at expiry

Introduced in migration `0018_employee_id_bulk_people_visitor_device_lifecycle_modules.sql`;
the account's options (person type, visit times, PIN, validity period) and the
request form's purpose of visit and remark were added in
`0025_visitor_account_options.sql`.

## The problem

Access-control terminals hold a **limited number of person slots**. A
visitor is not a resident: their account must exist on the terminal only while
its pass can actually open a gate — and the slot has to be freed when validity
ends so the terminal doesn't silently fill up with dead visitors.

At the same time, the estate needs the complete evidence story afterwards: who
was invited, when they came, what happened at the gate, any proof uploaded.

EstateMate's answer is a lifecycle that manages **the device slot and the app
record separately**:

- **created automatically** when a resident requests a visitor pass;
- **deleted automatically from every device** as soon as the pass stops being
  valid;
- **the app record lives on forever** — the gate history, proof files and audit
  trail stay intact. The lifecycle is a state machine on the visitor row, never
  a `DELETE`.

## States (`visitor_requests.device_account_state`)

| State | Meaning |
|---|---|
| `none` | No terminal ever received this pass (no device was linked when issued) |
| `provisioned` | An `upsert_visitor` operation went to the estate's terminals |
| `removal_queued` | Validity ended; a `revoke_visitor` has been queued for **every** device |
| `removed` | The agent (or an operator) confirmed the slot was freed |

`device_account_provisioned_at`, `device_account_removed_at` and
`device_account_removed_reason` hold the timestamps and why.

When a pass is created, every enabled terminal (or the one gate an officer
chose) gets the upsert with the composed employee number
(`visitor<credential number>`, letters and digits only, at most 30 characters
under EstateMate's current Employee ID policy; the terminal wire field allows
32). On Hikvision ISAPI terminals, that upsert creates or updates **one PIN-only
`UserInfo` account**:

- issued employee number and visitor name;
- no on-terminal group assignment (`belongGroup: ""`); Hikvision expects numeric group IDs, so the Worker’s `department: "Company"` metadata is not sent as a terminal group;
- enabled finite start/end validity, not a long-term account;
- the **person type the estate chose** as `userType` (see below) and `localUIRight: false`;
- the stored pass PIN as `password` — always **six digits**, validated as 4–8 decimal digits on the wire.

## What the visitor account is: person type, visit times, PIN, validity

Introduced in migration `0025_visitor_account_options.sql`. The request form and
`POST /api/visitors` accept, and the pass stores, four things about the account:

| Option | Values | Where it lands |
|---|---|---|
| **Person type** | `visitor` (default) or `normal` | sent to the terminal as the ISAPI `UserInfo` `userType` |
| **Visit times** | 1–10, default 1 | counted and enforced by EstateMate |
| **PIN** | exactly 6 digits, generated | sent as `password`, printed on the pass |
| **Validity period** | whole days, default 1, maximum 7 | the `Valid` window, in the estate's local time |

**Person type.** `visitor` is what a visitor slot is for, so every pass issued
from now on is filed under it. `normal` stays selectable because firmware varies:
a terminal that refuses the type answers the write with `badJsonContent`, which
would stop the account being created at all — an estate that hits that chooses
`normal` in **Settings → Visitor person type on terminals**, or per pass at the
moment it is issued (Administrator and Manager only). A payload with no
`personType` — one queued before this option existed — keeps the previous
`normal`, and the migration leaves historical passes on `normal` so a
reconciliation rewrites the account the terminal already holds instead of trying
to change a live account's type. Only `visitor` and `normal` are accepted; any
other value is refused before the terminal is contacted. Both bridges (Node and
Android) send it in the JSON body and in the XML fallback.

**Visit times are counted by EstateMate, not the terminal.** No device profile
in `docs/device-profiles/` records a firmware field that counts visits, and an
ISAPI write carrying an undocumented field is refused outright. So the pass
stores how many visits it allows (1–10, default 1) and the gate counts accepted
check-ins: `visits_used` is the number of accepted `in` decisions, the preview
shows what is left, and once the allowance is spent the next *entry* is refused
with "This pass has used all N permitted visits". Check-out is never blocked —
somebody already inside must always be able to leave.

**PIN.** Six digits, generated when the pass is issued, shown on the pass and
typed on the terminal keypad. It is never chosen by the requester, so it cannot
collide with a resident's credential or be guessed from a name.

**Validity period.** A pass defaults to **1 day** and may not outlive the estate
maximum, **7 days** until an administrator changes it. Both live in **Settings**
(`visitor_default_validity_days`, `visitor_max_validity_days`, 1–30 days) and the
maximum is enforced for everybody — resident, Security, Manager and
Administrator alike — so a longer pass is an explicit, audited settings change
rather than a quiet exception at the gate. A maximum below the estate default is
refused, because it would make the default impossible to request.

## Purpose of visit and remark

The request form also captures **purpose of visit** (family/social, delivery,
service & repair, business, domestic staff, event, or *other* with the reason
typed in) and a free-text **remark** from the host. Both are stored on the pass,
shown on the printed pass, shown to the officer in the gate preview, listed in
the visitor table and included in its Excel/PDF export. Neither is ever sent to
a terminal — they are for the estate's record, not the hardware.

The upsert also carries the **estate's timezone**, and the bridge states the
validity window in that zone's local time (`YYYY-MM-DDTHH:mm:ss` with
`timeType: "local"`, no `Z`), so the window the terminal enforces against its own
clock is the window the portal shows. New and reconciled operations both carry it.

No visitor `CardInfo`, fingerprint, face, door-right or right-plan data is sent.
The response tells the resident plainly that the account is created now and
deleted from all devices automatically when validity ends, while the record is
kept.

The upsert follows the same delivery rule as the revocation: a device whose
connection pattern is agent-capable gets the operation as `pending` **only when
a live agent is actually linked to it**. A terminal that is agent-capable on
paper but has no linked agent gets a `manual_action_required` Hardware-actions
task instead — otherwise the operation would sit as `pending` forever, a command
nothing will ever pick up, while the pass's state still recorded the slot as
held.

Reconciliation (the hourly pass over active passes, and the manual **Sync
active passes**) also **refreshes a stale, unclaimed operation in place**: a row
still `pending` — never picked up by an agent — whose payload predates a change
(such as the estate timezone travelling with the pass) gets the current payload
written back, so the next poll applies the current account instead of the old
one. `sent` rows are left for the agent's own result, and `applied` rows are
done.

## How deletion happens

`releaseExpiredVisitorDeviceAccounts(env)`:

1. **Ages out unused passes** whose window has closed (`active` → `expired`).
   A `checked_in` pass is deliberately *not* flipped: that person is physically
   inside the estate — changing the status would stop a guard checking them
   out. Their credential is still released from the terminals, and checkout
   from the portal keeps working (that path accepts an expired-but-was-inside
   pass explicitly).
2. **Queues `revoke_visitor` for every enabled terminal**, not just the ones the
   pass was sent to: an every-gate pass reached all of them, and an operator may
   have linked another terminal since. On Hikvision, the operation deletes the
   `UserInfo` account and frees its person slot; it does not issue a `CardInfo`
   delete. Existing revocations are reused and only failed ones retried, so the
   sweep is safe to run constantly.
3. Terminals linked to a live agent get it as `pending`; the rest become
   **Hardware actions** for an operator, exactly like every other manual device
   task on this platform.
4. Once *every* revocation is applied, the pass becomes `removed` with a
   timestamp.

### When it runs

- **Every minute** via a dedicated cron trigger (`* * * * *` in
  `wrangler.jsonc`) that does nothing else, so it stays inside the free plan's
  cron CPU budget. Cloudflare's cron granularity is one minute — that's how close
  to the actual expiry automatic deletion happens.
- **Hourly** with the rest of estate housekeeping, as a catch-up if a cron
  invocation is delayed.
- **Opportunistically** whenever passes are listed or scanned at a gate —
  because a cron can be delayed, and a guard scanning a just-expired pass is
  exactly the moment the slot matters.
- **Manually**: the Visitors page has **Release expired accounts** for an
  operator who suspects a terminal is holding a dead visitor and wants the slot
  freed and the queue visible now.

After the queue, the agent applies the deletion on the estate LAN at its next
poll (seconds); a device with no linked agent stays an operator task.

## Status surface

`GET /api/visitors/device-accounts` powers the operator strip on the Visitors
page: slots held on terminals, awaiting release, removal in flight, operator
removals left and fully released — plus the last 50 account changes with their
timestamps. `/api/visitors` now runs the sweep before answering so the list and
these numbers are fresh.

## What is *not* touched

- The `visitor_requests` row itself: never deleted by this feature.
- The pass's gate events, scans, proof files and audit entries.
- An installed bridge agent needs `revoke_visitor` support (present since the
  Access control remote phase); a terminal whose agent predates that receives
  the deletion as a `manual_action_required` operator task instead.
