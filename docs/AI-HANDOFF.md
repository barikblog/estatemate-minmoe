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

## Most recent migration

`migrations/0007_people_management_imports.sql`

It expands import history to include private-storage-backed user CSV jobs. Migration `0006` contains device inventory metadata/soft deletion, visitor credentials, scan sessions, visitor decisions/device operations, visitor association on gate events, and recommended portal settings. Migrations are append-only after deployment.

## Validation recorded for this phase

- Root and web TypeScript passed.
- 26 Vitest tests plus the ISUP control-plane integration test passed.
- Web production build passed with QR/barcode/camera libraries lazy-loaded.
- Fresh SQLite and local Wrangler D1 migration chains passed through `0007`; a populated `import_jobs` upgrade check preserved existing job/storage-key data and recreated the indexes.
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
  - user-import row-limit and private-storage enforcement.
- The Render relay health endpoint and event forwarding to the Worker passed locally.
- ISUP control-plane relay integration test passed for adapter authentication, event forwarding, operation polling and result forwarding.
- Local Worker machine API E2E passed for wrong-key rejection, header-based device authentication, operation claim/application and event acceptance.
- Production currently remains at commit `ef5765e`; the dedicated-gateway and people-management commits described here are local until they are pushed and their deployment workflow succeeds. Earlier GitHub Actions run `35934290140` applied migration `0006` and passed the recorded production smoke checks.
- Android source from the previous tenancy phase remains uncompiled in this environment because JDK 17 and Android SDK are unavailable.

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
