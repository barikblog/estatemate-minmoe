# AI handoff — EstateMate

Updated: 2026-09-24 (Africa/Lagos) — Portal UX phase (migration `0014`): administrator-published estate gate welcome image on the login screen and dashboard, searchable card-holder picker, and gate-scoped Security login sessions. Previous phase retired every access-device transport except the EstateMate agent; production domain is `https://estatemate.estatemate.workers.dev`



Repository: https://github.com/barikblog/estatemate-minmoe

Production: https://estatemate.estatemate.workers.dev

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
- **Hikvision ISAPI bridge and Windows agent**: `isapi-bridge/` cross-platform Node agent (ISAPI Digest, no SDK) + `windows-agent/` Windows Service wrapper, with portal UI for agent registry, device ISAPI configs, PowerShell/shell installer generation (one-time secret, 24h expiry), heartbeat, operation polling (`isapi_bridge`, `windows_agent`, `isapi_windows_agent` connection patterns), result reporting and sync logs. Agent v1.1.0 also streams real-time device events to the Worker in batches via a persistent ISAPI alertStream connection (see the streaming phase section below).
- Optional proof uploads linked to ownership, transfer, tenancy, household, visitor, maintenance and payment records.
- Administrator-editable portal identity, theme and operational defaults.
- **Estate gate welcome image**: an Administrator uploads a photograph of the estate gate to the private GitHub repository; it is shown behind the welcome text on the login screen (and as a compact banner on phones, where the brand panel is hidden) and on every dashboard hero. Served by the unauthenticated `GET /api/portal-gate-image` because the login screen renders before a session exists; only a file explicitly published under the `portal-branding` category with an image content type can ever be returned.
- **Searchable card-holder picker**: `GET /api/access/card-recipients` returns active main residents and active household members in one list, searchable by name, unit, email or phone, so issuing a card no longer means pasting a raw `residentId`/`householdMemberId`.
- **Gate-scoped Security sessions**: Administrators and Managers post officers at gates (`security_gate_assignments`); an officer with at least one assignment must choose their gate at login, and that choice scopes their visitor queue, gate activity, device list and device options for the whole session. Shift history is recorded in `security_gate_sessions`.
- **Access-termination guide** on the operator dashboard: the ordered chain for ending access (card, dependant, tenancy/account, visitor passes, terminal, hardware-action confirmation) with deep links to each section.
- People administration with available-property selection, bulk CSV registration, generated one-time passwords, editing, reset, lifecycle guards and history-preserving deletion.
- Operational Manager category with explicit separation from finance, private storage, global settings and elevated account management.
- Private-storage-backed operational imports for properties, ownerships, tenancies and cards.
- Encrypted ISAPI device credentials and agent secrets (STORAGE_ENCRYPTION_KEY + DEVICE_INGEST_PEPPER).
- Administrator-generated, one-time-download sample logins for every role with automatic 24-hour expiry.
- Initiate-payment flow with POS at office, cash at office and bank transfer; the estate bank account is Administrator-editable and read-only for Residents/Cashiers. Online collection is removed from the portal and rejected by `POST /api/payments`.
- Visitor passes shareable as a locally rendered PNG image or one-page A4 PDF, with a native share sheet where the device supports files.
- Estate-timezone-aware visitor validity windows (`src/datetime.ts`); resident passes default to `gate_scope='both'` and the gate picker is hidden from Residents.
- Show/hide password on sign-in and a `Powered by sornix.com.ng` portal footer.

## Most recent migration

`migrations/0014_gate_image_and_security_gate_sessions.sql`

It adds the portal UX phase:

- Seeds `portal_gate_image_key`, `portal_gate_image_caption` and `portal_gate_image_enabled` (default `false`). All three are in `PORTAL_SETTING_KEYS`, so they are Administrator-only through `PUT /api/portal-config`; `portal_gate_image_enabled` is validated as a literal `true`/`false` via `BOOLEAN_SETTING_KEYS`. The image bytes stay in the private GitHub repository — D1 keeps only the storage key.
- Creates `security_gate_assignments` (`UNIQUE(security_user_id,device_id)`): which gates an officer may be posted at. Removing an assignment sets `active=0` rather than deleting, and re-assigning reactivates the surviving row.
- Creates `security_gate_sessions`: which gate each officer selected and when the post ended (`replaced`, `assignment_removed`, `device_retired`).
- No existing table was altered, so previously issued sessions and all historical gate data are untouched.

The previous migration, `migrations/0013_agent_only_transports.sql`

It removes every access-device transport except the EstateMate agent:

- Repoints devices still on `direct_http_listener`, `render_http_bridge`, `hikvision_cloud_openapi` or `offsite_isup_gateway` to `manual_sync` + `integration_mode='manual'` (history preserved; they become automatic again once linked to an agent).
- Deletes the `render_bridge_url` setting row.
- Code/package removals in the same phase: `bridge/`, `render.yaml`, `isup-gateway/` deleted; Worker endpoints `/api/hikvision/v1/events/:id`, `/api/hikvision/v1/operations/*`, `/api/access/devices/:id/site-sync-installer` and `/api/access/devices/:id/rotate-secret` removed; connection-pattern registry reduced to `isapi_bridge`/`windows_agent`/`isapi_windows_agent`/`manual_sync` (`generic_network_access` is manual-only); Hik-Connect device fields removed from the device create/patch APIs and portal UI; profiles no longer expose `httpListener`; device registration no longer creates `device_credentials` rows (per-device ingest secrets are gone — agents authenticate with their own secret).

The previous migration, `migrations/0012_agent_event_stream_retention.sql`

It enables real-time agent event streaming and free-tier retention:

- Seeds `agent_event_stream_enabled` (default `true`) — the master kill switch for agent event ingestion; when `false`, `POST /api/isapi/v1/agents/:id/events` answers `409`.
- Seeds `access_event_retention_days` (default `365`) — the hourly cron (`pruneAccessEvents` in `src/index.ts`) deletes `access_events` (by ISO `device_timestamp`) and `isapi_sync_logs` older than this in indexed 500-row batches, keeping a busy estate inside the 500 MB D1 free-tier database limit. Values below 30 are refused.

The previous migration, `migrations/0011_hikvision_isapi_sync.sql`, added the ISAPI bridge and Windows agent registry/configs/logs/installers (detailed below).

## Portal UX phase (2026-09-24)

Four operator-facing changes, all behind migration `0014`. No existing table was altered.

### 1. Estate gate welcome image (login page and dashboard)

- Administrator uploads a JPEG/PNG/WebP through **Settings → Estate gate welcome image**. The portal posts it to `POST /api/files` with `X-File-Category: portal-branding`, then saves the returned storage key plus caption and visibility flag through `PUT /api/portal-config`.
- `GET /api/portal-gate-image` streams the configured image **without authentication**. This is deliberate and unavoidable: the login screen renders before any session exists, so a gate photograph behind the welcome text cannot sit behind `requireAuth`. The exposure is bounded by *what can be published*, not by who asks — `downloadPortalBrandingImage` in `src/github-storage.ts` returns `null` unless the row is `status='active'`, `category='portal-branding'` **and** has an image content type. Visitor proofs, imports and every other category remain behind the authenticated `/api/files/*` route and are never reachable this way.
- Rendered with an inline dark scrim (`gateImageStyle` in `App.tsx`) so welcome text stays legible over any photograph. On screens ≤850px the brand panel is hidden by existing layout, so the image moves to `.mobile-gate-banner` at the top of the sign-in card.
- When no image is enabled the route answers `404` and the portal falls back to the original gradient — nothing renders broken.

### 2. Searchable card-holder picker

`GET /api/access/card-recipients?search=` (Administrator/Manager only) returns one merged, name-sorted list of active main residents and active household members. Residents match on name, email, phone and the unit numbers they own or rent; dependants match on their own name and phone, their primary resident's name, and the unit. Each item carries `kind: 'resident' | 'household_member'` so `PersonPicker` submits `residentId` or `householdMemberId` to the existing `POST /api/access/cards` and `POST /api/access/card-scan-sessions` contracts, which were already correct — only the UI was raw-id entry.

### 3. Gate-scoped Security sessions

Two-step handshake, because a session cookie must not exist before the officer states their post:

1. `POST /api/auth/login` verifies the password. For `role='security'` with at least one active assignment it returns `requiresGateSelection: true`, the `gates` list and a **5-minute `selectionToken`** (`signJwt` with `pendingGate: true`), and sets **no** cookie.
2. `POST /api/auth/select-gate` verifies the officer really is assigned to that device, then issues the real 12-hour session with a `gate` claim and opens a `security_gate_sessions` row.

`requireAuth` rejects any `pendingGate` token outright, so a selection token can never be used as a session. It also re-checks the assignment on every request: if an administrator removes the post or retires the device mid-shift, the officer gets `401` and must select again rather than continuing to act at a gate they no longer cover.

`gateScope(c)` returns the claim for Security and `null` for everyone else, and is applied to `/api/access/events` (the claim *overrides* any client `deviceId` filter, so it can narrow but never widen), `/api/visitors` (passes with `gate_scope='both'` plus passes attached to their own device), `/api/access/devices`, `/api/access/device-options`, and `/api/visitors/scan` (a pass issued for another gate is refused `403` and recorded as an `invalid` scan).

**Deliberate fallback:** a Security account with *no* assignments still signs in unscoped and sees every gate, with a dashboard notice asking for an assignment. Forcing selection with nothing to select would have locked every existing officer out at deployment. Administrators and Managers are unaffected — `is_manager=1` accounts map to `manager`, never to the security gate check.

Officers switch posts mid-shift from the gate chip in the topbar (`SwitchGateDialog`), which reuses `select-gate` with their existing session instead of a password.

### 4. Access-termination guide

`TERMINATION_STEPS` in `App.tsx` renders a collapsible six-step chain on the operator dashboard: card → dependant → tenancy/account → visitor passes → terminal → hardware-action confirmation. Each step deep-links to the section that performs it. It is guidance only, no new API. The final step exists because terminating in EstateMate does not by itself stop a physical card — the queued `disable_card`/`revoke_card` device operation must actually be applied.

### Portal UX validation record (2026-09-24)

- `npm run typecheck`, `npm test` (105 tests: 81 existing + 24 new in `test/portal-ux.test.ts`) and `npm run build:web` all pass; `git diff --check` clean; the 0001→0014 migration chain replays against in-memory SQLite.
- Verified locally against `wrangler dev --local` with all 14 migrations applied: security login returns `requiresGateSelection` with no cookie and no token; the selection token is rejected as a session (`401`); selecting a gate issues a scoped session echoed by `/api/auth/me`; the scoped device list, device options and event list contain only that gate; a client `deviceId` filter cannot widen it; an unassigned device is refused `403`; and an Administrator login stays unscoped across both gates.
- `card-recipients` returned both a resident (`Owns A-01`) and a dependant (`Dependant (child) of Rita Resident`) from one query.
- **Not verified end-to-end:** the gate image bytes themselves. `downloadPortalBrandingImage` fetches from GitHub, which needs configured private storage plus a token; this environment has neither, so only the negative paths were exercised (non-branding category, non-image content type, unset/disabled key → all `404` before any network call). Upload and display against a real private repository should be smoke-tested after deployment.
- Android/Kotlin **was** touched and **was not compiled**: this environment has no JDK, Gradle or Android SDK (`java` is absent), so the Kotlin edits are reviewed by inspection only and must be compiled before any Android release.

### Unfinished work

- **Android has no gate-picker UI.** The data layer now handles the new login contract: `LoginResponse.token` is nullable, `POST /api/auth/select-gate` is wired up, an officer posted at exactly one gate is scoped automatically, and an officer with several posts gets a `GateSelectionRequired` error naming their gates and pointing them at the web portal. Still missing: a Compose screen to choose between multiple posts, so a multi-gate officer cannot sign in on Android yet. **None of this Kotlin was compiled.**
- The gate image has no automatic pruning: replacing it leaves the previous file in the private repository (only the D1 pointer moves).
- `GET /api/security/gate-sessions` (shift history) has an endpoint and test coverage but no portal screen yet.

## Agent event streaming phase (2026-09-24)

Extends `isapi-bridge/agent.mjs` to v1.1.0 and the Worker so a Hikvision terminal with documented ISAPI (e.g. **DS-K1T808MFWX-B**, whose datasheet states "Supports ISAPI and ISUP 5.0") runs fully real-time and automatic on the Cloudflare Workers Free plan:

- **Agent:** one persistent `GET /ISAPI/Event/notification/alertStream?format=json` connection per device (Digest/Basic challenge supported, 5 s → 60 s reconnect backoff). Incremental `multipart/mixed` parser plus a brace-depth bare-JSON fallback feed a bounded buffer (default 500) flushed to the Worker in batches (≤ 50 items or every 5 s; `eventFlush*`/`eventBufferLimit`/`alertStreamPath`/`eventStream` config knobs). Graceful shutdown flushes the buffer. Module exports parsers/main with an `ESTATEMATE_AGENT_STANDBY=1` guard so the Windows service wrapper keeps auto-starting.
- **Worker:** new machine endpoint `POST /api/isapi/v1/agents/:id/events` (`handleIsapiAgentEvents`) authenticates the agent, enforces the kill switch, verifies each device links to the calling agent (`hikvision_devices.isapi_agent_id` or `isapi_device_configs`), normalizes documents via the standard pipeline, touches device last-seen, and queues the batch as ONE message.
- **Queue batching:** `AccessEventQueuePayload` (in `src/types.ts`) is `NormalizedAccessEvent | { batch: NormalizedAccessEvent[] }`; `flattenQueuePayload` lets the consumer accept both single-event and batched messages. Direct device posts with multiple multipart documents also batch into one message. One batch ≈ one Queue message ≈ 3 Queue operations (free tier: 10,000/day), so ~3,000 events/day costs ~200–600 operations instead of ~9,000.
- **Consumer resilience:** a live-feed Durable Object failure no longer requeues already-persisted events (broadcast is best-effort with error logging).
- **Free tier retention:** `pruneAccessEvents` runs in the hourly `scheduled` handler alongside property lifecycle and facility-fee jobs.
- **Tests:** `test/agent-event-stream.test.ts` (9 tests) covers auth, agent-scoped device checks, batch normalization, one-message batching, legacy single-event consumer shape, multipart direct-post batching, kill switch, 413 batch cap and retention pruning; `test/harness.ts` now records queue sends and live-feed broadcasts. `isapi-bridge/agent.integration.mjs` (wired into `npm run test:isapi-bridge` inside `npm test`) unit-checks both stream parsers and streams a fake terminal end-to-end into a fake Worker.
- **Docs:** `docs/device-profiles/DS-K1T808MFWX-B.md` records the datasheet evidence and the on-site verification checklist; `docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`, `isapi-bridge/README.md` and both example configs document streaming; `AGENTS.md` names alertStream an event-upload path.

### Production deployment (2026-09-24)

- PR #9 merged to `main` (`3d9f08e`); Deploy EstateMate run `36019689067` succeeded — migrations `0012_agent_event_stream_retention.sql` and `0013_agent_only_transports.sql` applied to D1 `estatemate-db`, Worker + web assets deployed.
- Post-deploy smoke tests: `GET /api/health` → `{"ok":true,...}`; `GET /api/hikvision/v1/events/:id` now falls through to session auth (old raw device-ingest dispatch gone); `GET /api/isapi/v1/agents/:id/events` returns 405 (new machine handler live); SPA sign-in renders at `https://estatemate.estatemate.workers.dev`.
- Operator follow-up: re-link any device showing `manual_sync` in **ISAPI Bridge & Windows Agent** (LAN ISAPI host/credentials + agent) to restore real-time events and automatic card operations. Per-device ingest endpoints/secrets no longer exist.

### Agent-only transport phase (2026-09-24, after streaming)

- Removed all non-agent transports per `migrations/0013_agent_only_transports.sql`: deleted `bridge/`, `render.yaml`, `isup-gateway/`; removed device ingest + ISUP gateway operation endpoints, site-sync installer, device secret rotation and per-device credential creation; reduced connection patterns to agent patterns + `manual_sync`; dropped Hik-Connect fields and Render relay URL from APIs and portal UI; updated README/AGENTS/MINMOE-NO-PC/VISITOR-CREDENTIALS/MANAGERS/QUESTIONNAIRE/device-profile docs.
- Validation: `npm run typecheck`, 81 vitest tests (11 files), `npm run test:isapi-bridge`, `npm run build:web`, migration chain through 0013, `git diff --check` all passed. Removed the retired-transport vitest case with the endpoint; web app device panel rewritten for agent-only registration.

### Streaming-phase validation record (2026-09-24)

- Root and web TypeScript passed (`npm run typecheck`).
- 82 Vitest tests passed across 11 files, including new suite `test/agent-event-stream.test.ts` (9 tests).
- `npm run test:isup-gateway` passed; new `npm run test:isapi-bridge` passed (agent syntax, both stream parsers, fake-terminal end-to-end streaming with one batched flush).
- `npm run build:web` passed cleanly.
- Migration chain validated via Python sqlite3 through 0012.
- `git diff --check` clean.
- Not executed here: no real DS-K1T808MFWX-B hardware in the sandbox — the on-site verification checklist in `docs/device-profiles/DS-K1T808MFWX-B.md` must be completed before production cutover, and deployment happens on the next push to `main`.

## Migration 0011 — ISAPI bridge and Windows agent (previous phase)

- `isapi_agents` — registry of Windows/Linux bridge agents: id, name, hostname, platform (windows/linux/darwin/other), version, status (pending/online/offline/disabled), secret_hash, last_seen_at, last_ip, created_by.
- `isapi_device_configs` — per-device ISAPI mapping: device_id (FK hikvision_devices), agent_id (FK isapi_agents), isapi_host (LAN IP), isapi_port, isapi_username, isapi_password_ciphertext/iv (encrypted with STORAGE_ENCRYPTION_KEY), protocol http/https, sync_enabled, last_sync_at/status/error.
- `isapi_sync_logs` — audit of sync attempts: device_id, agent_id, operation_id, operation_type, status (started/success/failed/pending), message, duration_ms.
- `isapi_agent_installers` — one-time installer keys (24h expiry) for PowerShell/shell installers that contain new secret + installer key.
- Extends `hikvision_devices` with isapi_agent_id, isapi_sync_enabled, last_isapi_sync_at/status, isapi_host/port/username/password_ciphertext/iv/protocol.
- Extends `device_operations` and `visitor_device_operations` with agent_id, isapi_synced_at, sync_source (isup_gateway, isapi_bridge, windows_agent, manual).
- Seeds settings: isapi_bridge_enabled, windows_agent_enabled, isapi_default_port, isapi_sync_interval_seconds, isapi_retry_interval_seconds.
- New connection patterns supported: `isapi_bridge`, `windows_agent`, `isapi_windows_agent` (all treated as pending, not manual_action_required).

The previous migration, `migrations/0010_maintenance_billing_and_verification.sql`, adds maintenance scope (personal/street/block/zone/estate), status workflow (in_progress, needs_verification), charging fields, gate ID verification for visitors, and bill_batches audience targeting.

### 0011 validation record

- Root and web TypeScript passed (`tsc --noEmit` plus `tsc -b` in `apps/web`).
- 73 Vitest tests passed across 10 files, including new suite `test/isapi-bridge.test.ts` (6 tests):
  - Creates ISAPI agent and returns one-time secret, lists agents
  - Rejects agent creation without name
  - Creates device ISAPI config linked to agent, verifies device has isapi_agent_id and isapi_host
  - Agent can heartbeat, poll operations (pending), report applied, creates isapi_sync_logs and updates device_operations status to applied
  - Supports new connection patterns isapi_bridge, windows_agent, isapi_windows_agent in profile registry
  - Device creation with isapi_bridge sets visitor operation status to pending (not manual)
- `npm run build:web` passed cleanly (416 modules, 358kB + 412kB chunks).
- Migration chain validated via Python sqlite3 through 0011.
- Cloudflare deployment run `35991657930` succeeded on `main`, successfully applying migration `0011_hikvision_isapi_sync.sql` to Cloudflare D1 `estatemate-db` and deploying Worker + web assets to production `https://estatemate.estatemate.workers.dev`.
- Production health check attempted (DNS not resolvable from sandbox, but GitHub Actions deploy succeeded with 42s build).
- **Production domain corrected.** The live Worker is `https://estatemate.estatemate.workers.dev` (account `workers.dev` subdomain `estatemate`, Worker name `estatemate`). Verified externally: `GET /api/health` returns `{"ok":true,...}`, the SPA sign-in page renders, and served asset hashes (`index-CNQVCKox.js`, `pass-export-GRQJmxO5.js`) match the local `main` build. The previously documented `estatemate.barikblog.workers.dev` hostname never resolved and has been replaced in `docs/`, `scripts/ai-context.sh`, `render.yaml`, `bridge/server.mjs`, `isup-gateway/`, `isapi-bridge/` and `windows-agent/` defaults.
- Frontend UI: new section **ISAPI Bridge & Windows Agent** with agent registration, device linking, installer download (PowerShell .ps1 for Windows, shell .sh for Linux), sync logs, and quick reference; updated **Access-control devices** form to include isapi_bridge/windows_agent/isapi_windows_agent and shows isapi_agent_name, isapi_host, last_isapi_sync_status, queued ops.
- Backend: new endpoints `/api/isapi/agents`, `/api/isapi/device-configs`, `/api/isapi/sync-logs`, `/api/isapi/agents/:id/installer`, `/api/isapi/agents/:id/rotate-secret` plus machine endpoints `/api/isapi/v1/agents/:id/heartbeat`, `/devices`, `/operations`, `/operations/:id/result`, `/sync-logs` with X-EstateMate-Agent-Key / Bearer auth.
- Windows agent: `windows-agent/` with service wrapper, Node installer, README; `isapi-bridge/` with cross-platform Node agent implementing ISAPI Digest, operation polling, result reporting, and example configs.
- Docs: `docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md` details architecture, schema, endpoints, security, and installation.
- Not executed here: browser canvas path in `apps/web/src/pass-export.ts` (share-as-image/PDF) — verified by build/typecheck/PDF tests.

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
- GitHub Actions run `35973010739` built commit `a19681c` (PR #1), applied migration `0009`, and deployed successfully to Cloudflare production at `https://estatemate.estatemate.workers.dev`.
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
