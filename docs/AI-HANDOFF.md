# AI handoff — EstateMate

Updated: 2026-09-24 (Africa/Lagos)

Repository: https://github.com/barikblog/estatemate-minmoe

Production: https://estatemate.barikblog.workers.dev

Run `git log -1 --oneline` and check the latest GitHub Actions run before making changes. This file is intended to remain useful without embedding credentials or assuming that a deployment is still in progress.

## Current implemented scope

- Cloudflare Worker/Hono backend, D1, Queue, Durable Object live access feed and hourly lifecycle processing.
- React portal and Android/Compose client foundation.
- Multi-property single-owner model, ownership approvals and effective-dated transfers.
- Main tenant model with administrator approval and owner/tenant bill responsibility.
- Dependants/household profiles, optional logins, delegated permissions and named cards.
- Property statements and grouped street/block/zone billing.
- Private GitHub binary storage; no R2.
- General estate notices, historical bill/payment imports and Hikvision access events.
- Visitor passes with QR, Code 128, unique number and PIN; Admin/Security preview before accept/reject.
- Phone-camera and selected-device visitor scans.
- Physical card enrollment by tapping/scanning at a selected saved device.
- Editable, secret-rotatable and soft-deletable access-device inventory.
- Profiles for MinMoe, QR K1T807/K1T502 variants, DS-K1T808MFWX-B, DS-K2600, DS-K2700/K2800 including DS-K2802, and a conservative vendor-neutral option.
- Optional stateless Render Free HTTPS relay Blueprint; it is not an ISUP/TCP server.
- Dedicated Ubuntu ISUP gateway package for a small LAN appliance or off-site host, with machine-authenticated event and operation APIs; the licensed official SDK adapter remains an external required build input.
- Optional proof uploads linked to ownership, transfer, tenancy, household, visitor, maintenance and payment records.
- Administrator-editable portal identity, theme and operational defaults.
- People administration with available-property selection, bulk CSV registration, generated one-time passwords, editing, reset, lifecycle guards and history-preserving deletion.
- Operational Manager category with explicit separation from finance, private storage, global settings and elevated account management.
- Private-storage-backed operational imports for properties, ownerships, tenancies and cards.
- Encrypted Hik-Connect configuration and one-time generated on-site synchronization installer for the official-SDK gateway package.
- Administrator-generated, one-time-download sample logins for every role with automatic 24-hour expiry.
- Initiate-payment flow with POS at office, cash at office and bank transfer; the estate bank account is Administrator-editable and read-only for Residents/Cashiers. Online collection is removed from the portal and rejected by `POST /api/payments`.
- Visitor passes shareable as a locally rendered PNG image or one-page A4 PDF, with a native share sheet where the device supports files.
- Estate-timezone-aware visitor validity windows (`src/datetime.ts`); resident passes default to `gate_scope='both'` and the gate picker is hidden from Residents.
- Show/hide password on sign-in and a `Powered by sornix.com.ng` portal footer.

## Most recent migration

`migrations/0009_visitor_gate_scope_payment_channels.sql`

It adds `visitor_requests.gate_scope` (`both` default, `gate` when an Administrator or Manager attaches one device) and seeds the five `bank_account_*` settings keys used by the payment-channel API. Existing visitor rows keep their history and default to every gate.

The previous migration, `migrations/0008_managers_operations_imports_hikconnect.sql`, adds the Manager role and temporary-account expiry while preserving all existing users and foreign-key relationships; expands import history for common operational CSVs; and adds encrypted Hik-Connect/site-sync metadata to access devices. To avoid rebuilding the heavily referenced `users` parent table, Manager rows use the compatibility representation `role='security', is_manager=1`; authentication and user APIs must continue returning the effective role through `CASE WHEN is_manager=1 THEN 'manager'`. Migrations are append-only after deployment.

## Validation recorded for this phase

- Root and web TypeScript passed (`tsc --noEmit` plus `tsc -b` in `apps/web`).
- 60 Vitest tests passed across 8 files, including new suites that drive the real Worker `fetch` against an in-process SQLite database shaped like D1:
  - `test/visitor-pass-validity.test.ts` reproduces the reported "Pass is outside its validity window" false negative for a pass that is inside the window the resident entered, and pins the fixed behaviour for not-yet-active, expired, checked-out and legacy naive rows;
  - `test/payment-channels.test.ts` pins the three payment options, the absence of `online`, Administrator-only bank-account editing and `gate_scope` defaults;
  - `test/pdf.test.ts` validates the generated PDF structure, xref offsets and the untouched DCTDecode stream;
  - `src/datetime.test.ts` pins estate-timezone parsing, explicit offsets, date-only boundaries and DST handling.
- A PDF produced by the real `imageToPdfBlob` was independently parsed with `pypdf`: 1 page, A4 MediaBox, correct title/producer, embedded JPEG recovered byte-for-byte.
- `npm run build:web` passed; `pass-export` stays a lazy chunk (6.12 kB) so the QR/barcode/PDF export code is out of the initial bundle.
- `wrangler d1 migrations apply --local` applied `0001`–`0009` cleanly, and the fresh-SQLite chain check confirmed `visitor_requests.gate_scope` defaults to `both` plus the five `bank_account_*` settings keys.
- Local live API E2E against `wrangler dev`: a resident-issued Lagos wall-clock pass stored as `2026-09-24T07:12:23.000Z` scanned as `valid=true`; expired and not-yet-active passes returned specific estate-time reasons; Security accepted the previewed pass; `/api/payment-channels` returned POS/cash/bank transfer with `editable=false` for a Resident, a Security-role bank edit was rejected with 403, and an Administrator edit was then readable by the Resident.
- Android remains uncompiled in this environment because JDK 17 and the Android SDK are unavailable.
- Not executed here: the browser canvas path in `apps/web/src/pass-export.ts` (`renderVisitorPassCanvas`, `sharePassFile`). No headless browser could be installed in this sandbox, so the share-as-image/PDF buttons are verified by production build, typecheck and the PDF-writer tests rather than by clicking them in a browser.
- GitHub Actions run `35973010739` built commit `a19681c`, applied migration `0009_visitor_gate_scope_payment_channels.sql`, deployed the Worker and portal assets successfully to Cloudflare production.

### Earlier phase

- Root and web TypeScript passed.
- 31 Vitest tests plus the ISUP control-plane integration test passed.
- Web production build passed with QR/barcode/camera libraries lazy-loaded.
- Fresh SQLite and local Wrangler D1 migration chains passed through `0008`; a populated upgrade check preserved existing users, ownership, billing, import storage keys and foreign-key integrity.
- Local API E2E passed:
  - DS-K1T808MFWX-B and DS-K2802 profile auto-detection;
  - device edit, secret rotation and soft deletion;
  - visitor creation with a 12-digit credential;
  - selected-device visitor scan and Security preview/acceptance;
  - selected-device physical-card enrollment;
  - portal-theme update;
  - visitor/card hardware-action queues;
  - proof metadata linking and reviewer listing;
  - people creation with available-property assignment, editing, generated password reset, ownership lifecycle guards, card suspension, reactivation and history-preserving deletion;
  - user-import row-limit and private-storage enforcement;
  - Manager login/role filtering, permitted operational actions and denial of elevated-account, finance, storage, settings and ingest-secret access;
  - encrypted Hik-Connect persistence without list/audit disclosure;
  - generated no-cache site-sync installer, machine authentication and prior-key invalidation;
  - all five 24-hour sample-login categories and one-time credential response;
  - operational import schema validation and private-storage enforcement.
- The Render relay health endpoint and event forwarding to the Worker passed locally.
- ISUP control-plane relay integration test passed for adapter authentication, event forwarding, operation polling and result forwarding.
- Local Worker machine API E2E passed for wrong-key rejection, header-based device authentication, operation claim/application and event acceptance.
- GitHub Actions run `35963135145` built commit `35c5d35`, applied migration `0008`, deployed successfully, and passed production health plus Manager/Import Centre/Hik-Connect/site-sync bundle smoke checks.
- Android Manager visibility logic was updated, but Android remains uncompiled in this environment because JDK 17 and Android SDK are unavailable.

## Important hardware truth

- Direct HTTP Listening is outbound event ingestion only unless the exact firmware documents a command return path.
- Render Free can relay HTTP events but sleeps after inactivity and cannot accept arbitrary Hikvision ISUP TCP traffic. Do not add self-pinging to evade this limit.
- `isup-gateway/` should run on a small x86_64 Ubuntu LAN appliance (or public TCP host) with a native adapter compiled from the licensed official Hikvision SDK; Arduino/ESP32 is unsuitable, and Raspberry Pi requires vendor ARM64 libraries.
- DS-K1T808MFWX-B documents card/fingerprint/PIN rather than an integrated QR reader.
- DS-K2802 is a controller. QR requires a compatible attached reader.
- QR access at a terminal requires both QR-capable hardware and credential provisioning. The EstateMate phone scanner works independently of terminal QR support.

## Safe continuation process

1. Read `/AGENTS.md`.
2. Run `./scripts/ai-context.sh`.
3. Pull `main` and inspect the latest Actions run.
4. Add a new migration rather than editing a deployed one.
5. Keep secrets out of prompts, commits and logs.
6. Run all quality gates listed in `AGENTS.md`.
7. Push to `main`, wait for migration/deployment success, smoke-test production, and update this handoff when consequential state changes.

## Deliberately not automated

Full remote card/person command delivery remains model/account dependent. The hardware-action queue is authoritative until an approved Hikvision cloud API or genuinely compatible dedicated ISUP command gateway is configured. Do not mark queued actions applied merely because an HTTP event listener or Render relay exists.
