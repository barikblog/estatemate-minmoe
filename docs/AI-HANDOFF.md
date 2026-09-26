# AI handoff — EstateMate

Updated: 2026-09-27 (Africa/Lagos) — **Access cards & fingerprints phase (migration `0015_fingerprint_credentials.sql`):** the portal menu is now **Access cards & fingerprints** and lists cards and fingerprints from one endpoint; every person's profile (People and Tenancy & household) has a **Cards & fingerprints** panel where an Administrator or Manager can add either credential. A fingerprint is its own credential with the terminal's finger slot and employee number, and because a finger can only be captured on the terminal, every fingerprint operation is queued `manual_action_required` with instructions and is never handed to the agent. See "Access cards and fingerprints". Previous: **Cloudflare Tunnel remote-access kit (Free plan)** shipped as `86886f7` on PR #25 — `scripts/cloudflared-remote-access.mjs` generates a WARP private-routing config with a `--check` policy validator; ISUP was proven impossible on the free plan (the terminal cannot dial Cloudflare or complete an Access login). Previous: **Terminal presence promotion** (`c6d1ab3`): a heartbeat `stream:'up'` promotes a linked terminal from the `pending` registration default to `online`, `'down'` retires it (including a still-`pending` terminal), and the hourly sweep derives status from proof of life. Previous: **Bridge apps phase deployed to production:** `bridge-apps/` (single-file Windows bridge executable + Android bridge APK) and the agent's EstateMate-device-id resolution are on `main` as `a094d93` (PR #21) and Deploy EstateMate run `36178112448` deployed them successfully; production `GET /api/health` returns `ok: true` and the portal login screen renders. The earlier wording on this line ("not yet deployed") was stale and is corrected here — that phase is live. The merge kept the one `apps/web/src/App.tsx` conflict resolution and the operator-facing portal labels brought in line with the renamed **Device agent** page — see "Bridge apps phase, merged onto the Device-agent portal". Previous: **Device-agent portal cleanup deployed:** PR #17 merged as `6795c0e`; Deploy EstateMate run `36161420893` succeeded and the cache-busted production health check returned `ok: true`. The page is now named **Device agent**, replaces implementation-level connection-pattern and queue copy with a compact on-demand setup guide, points operators to the current single-file Windows bridge and Android bridge release, removes obsolete Node.js/`sc.exe` instructions, trims status tables, and fixes the phone layout so the heading and actions stack instead of forcing horizontal overflow. Setup downloads now match explicit secret rotation and are Administrator-only in both the UI and API; Managers can still connect, disconnect, and monitor terminals. Previous: **Bridge release CI phase** added `.github/workflows/bridge.yml` (Windows agent portable bundle + the project's first real Android compile), fixed the `API_BASE_URL` placeholder and the wrong `sc.exe`/`pkg` install advice. Previous: 2026-09-24 — Portal UX phase (migration `0014`) **deployed to production** via PR #11 (`f4e543d`), Deploy EstateMate run `36074600948`: administrator-published estate gate welcome image on the login screen and dashboard, searchable card-holder picker, and gate-scoped Security login sessions. Previous phase retired every access-device transport except the EstateMate agent; production domain is `https://estatemate.estatemate.workers.dev`



Repository: https://github.com/barikblog/estatemate-minmoe

Production: https://estatemate.estatemate.workers.dev

Run `git log -1 --oneline` and check the latest GitHub Actions run before making changes. This file is intended to remain useful without embedding credentials or assuming that a deployment is still in progress.

## Current implemented scope

- Cloudflare Worker/Hono backend, D1, Queue, Durable Object live access feed and hourly lifecycle processing.
- React portal and Android/Compose client foundation.
- Multi-property single-owner model, ownership approvals and effective-dated transfers.
- Main tenant model with administrator approval and owner/tenant bill responsibility.
- Dependants/household profiles, optional logins, delegated permissions and named cards and fingerprints.
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
- **Gate-scoped Security sessions**: every Security officer must choose a gate at login. Administrators and Managers may post officers at gates (`security_gate_assignments`), which restricts the choice to those posts; an officer with no posts picks from every active gate device (`selectableGates`). Such a freely chosen session carries an `openGate` JWT claim and ends as soon as the officer is assigned any post, so an administrator can always move him. Only when the estate has no active gate device at all does an officer sign in unscoped (`gateSelectionUnavailable`). The chosen gate scopes their visitor queue, gate activity, device list and device options for the whole session. Shift history is recorded in `security_gate_sessions`.
- **Access cards & fingerprints (migration `0015`)**: one credential register. `fingerprint_credentials` stores a finger as its own credential — person (`resident_id` plus optional `household_member_id`), the terminal's finger slot (`finger_no` 1–10, unique per person), optional `finger_label`, the enrollment device, `employee_no` and the same status/expiry lifecycle as a card. `access_cards.card_uid` is untouched, so a card number is still a card number. The portal menu reads **Access cards & fingerprints** and lists both types from `GET /api/access/credentials`; every person's profile (People for main residents, Tenancy & household for dependants) has a **Cards & fingerprints** panel that adds either credential for Administrators and Managers only. A finger cannot be pushed from the cloud — it is captured on the terminal — so every fingerprint operation (`enroll_fingerprint`, `enable_fingerprint`, `disable_fingerprint`, `delete_fingerprint`) is queued `manual_action_required` with the exact step in `device_operations.manual_instruction` and is never handed to the agent; enrollment is queued for the terminal the operator chose, while suspend/revoke/fee-enforcement tasks go to every terminal. Gate events with no card number are attributed back through `employee_no` (`access_events.fingerprint_id`, resident and household member), and a matching card number stays authoritative when both match. Lifecycle parity with cards: fee-overdue expiry/restore, account deactivation, household-member deactivation, dependant deactivation and tenancy end all suspend or queue removal for fingerprints too.
- **Access-termination guide** on the operator dashboard: the ordered chain for ending access (card, dependant, tenancy/account, visitor passes, terminal, hardware-action confirmation) with deep links to each section.
- **Cloudflare Tunnel remote access (Free plan)**: `scripts/cloudflared-remote-access.mjs` generates a `cloudflared` config with WARP private-network routing plus `SETUP.md`, and `--check` fails a config that would expose a terminal. Human access only — the agent remains the sole automatic transport, so gates keep working when the tunnel is down. See `docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`.
- People administration with available-property selection, bulk CSV registration, generated one-time passwords, editing, reset, lifecycle guards and history-preserving deletion.
- Operational Manager category with explicit separation from finance, private storage, global settings and elevated account management.
- Private-storage-backed operational imports for properties, ownerships, tenancies and cards.
- Encrypted ISAPI device credentials and agent secrets (STORAGE_ENCRYPTION_KEY + DEVICE_INGEST_PEPPER).
- Administrator-generated, one-time-download sample logins for every role with automatic 24-hour expiry.
- Initiate-payment flow with POS at office, cash at office and bank transfer; the estate bank account is Administrator-editable and read-only for Residents/Cashiers. Online collection is removed from the portal and rejected by `POST /api/payments`.
- Visitor passes shareable as a locally rendered PNG image or one-page A4 PDF, with a native share sheet where the device supports files.
- **Derived agent/terminal presence**: agent and device status are computed at read time from proof of life (heartbeat within 3 minutes; live alertStream or forwarded event within 10 minutes) instead of trusting the stored `status`, which used to leave a dead terminal or a stopped agent green until the next hourly cron. The hourly sweep (`expireStalePresence`) persists the same verdict and now handles a NULL `last_seen_at`, which previously compared as NULL and never went offline. The heartbeat carries per-terminal alertStream state (`devices: [{ deviceId, stream: 'up'|'down', lastError }]`): `up` promotes a terminal to `online` straight away (a linked, healthy terminal no longer waits for the first swipe to leave the `pending` registration default) and refreshes its `last_seen_at`, while `down` retires it immediately — including a `pending` terminal, so a gate that never proved itself alive reads `offline` rather than "not seen yet". Deleting an agent or disconnecting a terminal does the same.
- Estate-timezone-aware visitor validity windows (`src/datetime.ts`); resident passes default to `gate_scope='both'` and the gate picker is hidden from Residents.
- Show/hide password on sign-in and a `Powered by sornix.com.ng` portal footer.

## Access cards and fingerprints (2026-09-27)

Requested as: "Change the menu for Access cards to include finger prints. All users profile to include option to include access card and finger print (can only be added by admin/ manager)".

- **Model:** a fingerprint is a credential in its own right, not a card number. `fingerprint_credentials` holds the person, the finger slot the terminal stores the template under (1–10, unique per person), an optional label, the enrollment device, `employee_no` (the identity the terminal knows the person by) and the card lifecycle columns (status, expiry, `auto_expired`, deactivation reason, `created_by`). `fingerprint_status_changes` mirrors `card_status_changes`. `access_events.fingerprint_id` was added, and `device_operations` was rebuilt data-preservingly to carry `fingerprint_id` and `manual_instruction` plus the four fingerprint operation kinds.
- **Handler:** `createFingerprintOperations` always writes `manual_action_required` with a `manual_instruction` and never returns anything the agent polls. Enrollment is scoped to the terminal the operator named; a change of state (suspend, revoke, fee expiry/restore) is queued for every active terminal.
- **API:** `GET/POST/PATCH/DELETE /api/access/fingerprints` (Administrator and Manager only — a resident cannot add a credential to a profile), `GET /api/access/credentials` (both types in one shape, `credentialType=card|fingerprint`, `residentId`/`householdMemberId` filters, residents self-scoped) and a `householdMemberId` filter on `GET /api/access/cards`. `/api/access/operations` now returns `credential_kind` (`card`/`fingerprint`/`visitor`), `credential_reference` (a finger reads `finger 3`), `holder_name` and `manual_instruction`; the old `card_uid` field is gone and the Hardware-actions table was updated to match.
- **Attribution:** `consumeAccessEvents` resolves a cardless event through `employee_no` to the fingerprint credential and its resident/household member, with the card number still winning when a document carries both. `POST /api/access/fingerprints` defaults `employee_no` to the EstateMate user id for a main resident and otherwise stores what the operator supplied, so a dependant finger is unattributable until an employee number is set.
- **Lifecycle:** fee-overdue expiry and cleared-fee restoration, account suspension, household-member deactivation and tenancy end all cover fingerprints as well as cards, each queueing the matching terminal task.
- **Tests:** `test/access-fingerprints.test.ts` (12 tests: enrollment and queue shape, device scoping, validation, duplicate slot, role restriction, unified list and filters, hardware-action fields, suspend/reactivate, delete-with-history, cardless event attribution, card-wins precedence, fee expiry/restore).
- **Docs:** README scope and "still model dependent" lines, `AGENTS.md` non-negotiables, this file, `docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md`, `docs/MANAGERS-IMPORTS-HIKCONNECT-SITE-SYNC.md`, `isapi-bridge/README.md`.
- **Not done / still open:** no automated template upload or read-back — deliberate, because no per-model firmware evidence is recorded in `docs/device-profiles/`; a dependant fingerprint stays unattributable on the terminal until its `employee_no` is set.

## Cloudflare Tunnel remote access — Free plan (2026-09-26)

Requested as "use the Free tier of Cloudflare Tunnel (part of Cloudflare Zero Trust) add to Hikvision access control ISUP option to access". Investigation established that the ISUP half cannot be built on the free plan, so the deliverable is the remote-**human**-access half, with the boundary recorded in code and docs.

- **Free-tier facts that decide the design:** Tunnel is free/unlimited; Zero Trust is free up to **50 users** where a seat is consumed by an authenticating *human* (devices consume none); public hostnames proxy **HTTP/HTTPS only** (arbitrary TCP needs a `cloudflared`/WARP client on the connecting side, or paid Spectrum); 24 h log retention; no SLA.
- **Why ISUP cannot cross it:** ISUP/EHome is the device dialling raw TCP (7660, plus 8003/8004) with an EHome key. A K1T terminal cannot run `cloudflared`/WARP and cannot satisfy a Cloudflare Access login, so no free path exists from device to Cloudflare. Terminating ISUP would require a LAN host running a Hikvision SDK adapter — the `isup-gateway/` transport retired in migration `0013_agent_only_transports.sql` — for terminals the agent already serves bidirectionally over documented ISAPI. The operator scoped ISUP out on that basis.
- **Shipped:** `scripts/cloudflared-remote-access.mjs` generates `cloudflared-config.yml` (WARP routing enabled, catch-all ingress, nothing published), `setup-routes.sh`/`.ps1`, and a `SETUP.md` carrying the dashboard steps, seat arithmetic, WARP Split-Tunnels step and rollback. `--check <config>` validates an existing config (exit 0 clean, 1 policy violation, 2 usage error). `--json` prints the plan.
- **Policy guards, tested:** refuses `--lan 0.0.0.0/0`; warns on home-LAN collisions (`192.168.1.0/24` et al.) and routes broader than /16; notes terminals outside the routed range; refuses public hostnames unless **both** `--domain` and `--allow-public-hostnames` are given; `--check` errors on a missing `warp-routing`, on any unapproved public hostname, and on `tcp://` behind a public hostname.
- **Tests:** `test/cloudflare-tunnel.test.ts` (23 tests, policy + rendering + inspector) and `scripts/cloudflared-remote-access.integration.mjs` (real filesystem: kit written, device passwords never echoed into artifacts, exit codes), wired as `npm run test:cloudflared-kit` inside `npm test`. `tsconfig.json` gained `allowJs` so the vitest suite can import the `.mjs` generator with inferred types; `bridge.yml` syntax-checks the generator and lists both new files as PR triggers.
- **Docs:** new `docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`; README IMPORTANT block + included list + docs index; `AGENTS.md` non-negotiable (tunnel is human access only, never automatic); `MINMOE-NO-PC.md` decision record; `package.json` scripts `tunnel:plan` and `test:cloudflared-kit`.
- **Not done / still open:** no live Cloudflare account was touched, so the generated config was never run against a real tunnel; public hostnames remain documented-but-opt-in because the operator has no zone on Cloudflare and README forbids publishing terminal admin interfaces.

## Terminal presence fix — a healthy terminal no longer stays `pending` (2026-09-26)

A terminal whose bridge was plainly online still showed **pending** on *Device agent → Connected terminals* (`device_status`) and *Access-control devices → Status*. Cause: `hikvision_devices.status` defaults to `pending` (`migrations/0001_initial.sql`) and the only statement that ever wrote `online` was event ingestion in `handleIsapiAgentEvents`. The heartbeat's per-terminal report was consumed one-way — `stream: 'down'` retired a terminal, `stream: 'up'` was ignored — so a linked terminal that had not yet been used stayed `pending`, and a terminal that never proved it was alive could not leave `pending` even when its stream was reported `down`.

- `markTerminalStreamUp` (new, `src/index.ts`) treats an open alertStream as proof of life: `status='online'`, `last_seen_at` refreshed on every report, and one `isapi_sync_logs` row (`event_stream`/`success`) per transition, not per heartbeat. `markTerminalStreamDown` now retires `status IN ('pending','online')`, so an unproven terminal with a dead stream reads `offline` instead of `pending`. Both share `TERMINAL_AGENT_LINK_SQL` (`isapi_agent_id` or `isapi_device_configs`), so an agent that does not serve a terminal can neither promote nor retire it.
- The heartbeat response adds `terminalsOnline` beside `terminalsOffline`.
- Portal (`apps/web/src/App.tsx`): the Device-agent presence hint states the new rule, and the device table's `last_seen_at` column is labelled **Last seen** because a live stream now advances it.
- Android bridge parity (`bridge-apps/android`): `BridgeRuntime` tracks per-terminal stream state, `StreamTask` records up/down (HTTP error, close, exception), and `WorkerClient.heartbeat(...)` sends `devices`. Previously only the Node agents reported this, so a tablet-hosted bridge could never promote a terminal by holding its stream. **The Java was not compiled in the sandbox** (no JDK/Android SDK): `bridge.yml` compiles the android-free protocol layer and runs `ProtocolTest` (which now asserts the stream-state payload) plus the APK build.
- Tests: `test/agent-presence.test.ts` went from 9 to 12 tests — stream-`up` promotion, unproven terminal with `down` stream → `offline`, fall-back to `offline` when a live terminal stops reporting, and an unlinked agent failing to promote.

## Bridge release CI phase (2026-09-25)

`.github/workflows/bridge.yml` (**Build EstateMate Bridge**) builds the two client
artifacts that ship outside the Worker. It needs no Cloudflare credentials and
cannot deploy; `deploy.yml` remains the only production path. Triggers: `bridge-*`
tags, `workflow_dispatch`, and pull requests touching `isapi-bridge/**`,
`windows-agent/**`, `apps/android/**`, the two new `scripts/`, or the workflow itself.

Jobs: `validate` (agent `node --check`, the ISAPI integration test, migration-prefix
uniqueness, and an ubuntu dry-run of the packer) → then in parallel
`windows-agent-bundle` (`windows-latest`) and `android-apk` (`ubuntu-latest`) →
`publish-release` (tag builds only, needs all three).

**Windows: a portable bundle, not a compiled `.exe`.** `scripts/package-windows-bundle.mjs`
stages `agent.mjs` (the `windows-agent/` wrapper) beside `agent-core.mjs` (the
`isapi-bridge/` core) in one flat directory, which is the wrapper's own documented
fallback, so it runs unmodified. The CI job then downloads Node.js `22.22.2` win-x64,
verifies it against the published `SHASUMS256.txt` **and** its Authenticode signature
before extracting only `node.exe` into `runtime/`, and re-runs the packer with
`--finalize-runtime` to record the hash in `VERSION`. Verified locally: the staged flat
bundle starts, resolves `agent-core.mjs`, parses config, and shuts down cleanly on
SIGTERM (what a service stop relies on); the launcher refuses to start with no
`agent-config.json`.

**`sc.exe create` was wrong and is no longer advised.** The agent is a console process
with no SCM handshake, so `sc.exe create ... start= auto` fails with error 1053. The
bundle's `install-service.ps1` registers a SYSTEM **Scheduled Task** at startup instead,
or a real service via `-Nssm`. `windows-agent/README.md` and the portal's generated
`.ps1` in `src/index.ts` were both corrected — the latter also pointed at a
`/api/isapi/agent-binary` endpoint that does not exist and installed to a fixed path
away from the bundle; it now installs to `$PSScriptRoot`. The `pkg`/`nexe` advice was
removed (the original `pkg` is archived and predates Node 22).

**Android is compiled here for the first time.** Previous phases record that Kotlin
changes were never built because no working environment had a JDK or Android SDK; this
sandbox had none either (no root, and `services.gradle.org`/`dl.google.com` are
unreachable), so the Gradle changes are still **uncompiled locally** — the workflow is
the first real build. `apps/android/app/build.gradle.kts` now takes `-PapiBaseUrl`,
`-PappVersionName` and `-PappVersionCode`, because `API_BASE_URL` was hardcoded to
`https://REPLACE_WITH_WORKER_DOMAIN/` and every APK built before now pointed at a host
that does not exist. It defaults to production, so a plain `assembleDebug` works.
`versionCode` is `major*10000 + minor*100 + patch`, and the non-tag fallback is 10 (not
1) so a dev build cannot collide with a real `bridge-0.0.1`.

`scripts/verify-android-apk.py` gates the result: it reads the generated `BuildConfig`
back out of the APK (falling back to a `.dex`/`.arsc` scan) and fails if the intended
base URL is absent or the placeholder survives. Tested against eight fabricated APKs —
good, placeholder, wrong URL, binary-only variants, empty and truncated — and each
failure mode returns non-zero. Note it deliberately requires the trailing slash.

**Signing is optional and never silently wrong.** `ANDROID_KEYSTORE_BASE64` /
`ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` enable a
signed release; absent them the build warns and **no** release APK is published, since
AGP would emit an uninstallable `app-release-unsigned.apk`. Likewise `WIN_CRT_PFX_BASE64`
/ `WIN_CRT_PFX_PASSWORD` (+ optional `WIN_CRT_TIMESTAMP_URL` var, defaulting to
`http://timestamp.digicert.com`) drive `signtool`, and the outcome is recorded in the
bundle's `SIGNING.txt` so the release notes report signing truthfully. **None of these
secrets are set yet**, so the first release will be unsigned.

Not yet done: no `bridge-*` tag has been pushed, so `windows-latest` and the Android
SDK path have not executed on a real runner. The four `pwsh` steps could not be
syntax-checked locally (no PowerShell in the sandbox) — only the 15 bash steps were
verified with `bash -n`, plus a here-string/brace/`param()` checker run over both
generated PowerShell scripts with negative controls.

### First runner feedback (run 36126444022, PR #14)

The first PR run gave two real failures, both now fixed:

- **`android-actions/setup-android@v3` is broken upstream** and was removed. It
  unconditionally runs `sdkmanager tools`, a legacy package Google removed from the SDK
  repository, so it exits 1 in ~13s before the build starts. This is not specific to
  this repo — the same failure is being fixed across many projects right now. The job
  now locates the runner's preinstalled SDK (`$ANDROID_HOME`, probing
  `cmdline-tools/latest/bin/sdkmanager`, then `tools/bin`, then a `find` fallback) and
  installs `platform-tools`, `platforms;android-35` and `build-tools;35.0.0` itself.
  `actions/setup-java` was bumped v4 → v5 for the same class of reason (v4 is
  announced deprecated).
- **The Windows smoke test was wrong, not the bundle.** Steps 4–6 passed, meaning the
  Node runtime download, `SHASUMS256.txt` verification, Authenticode check, extraction,
  packer and `--finalize-runtime` all work on a real runner. The smoke test asserted the
  core agent logged its startup banner, but it was seeded with `{ "devices": [] }` and
  `isapi-bridge/agent.mjs` exits 1 with "No enabled devices in devices file" *before*
  that banner. Reproduced locally, and the fixture now carries one enabled device
  pointing at an unroutable host. The step was also rewritten to test the positive path
  (agent genuinely starts and resolves `agent-core.mjs`) rather than only refusal, to
  use absolute paths, and to stop merging a native command's stderr into the success
  stream, which pwsh can turn into a terminating error.

Two PowerShell bugs were caught locally by the new linter before they reached a runner:
an indented here-string closer (YAML block indentation makes column-0 `"@`/`'@`
impossible, so the devices fixture now uses `ConvertTo-Json` instead) — and the linter
itself needed two fixes after a positive control exposed false positives, so it is
validated against both negative and positive controls. It is wired into the `validate`
job so future edits are caught on ubuntu in seconds.

### Two real product bugs the first Windows/Android runs found (run 36128679749)

These are defects in shipped code, not CI problems. Neither could have been found
without a real `windows-latest` runner and a real Kotlin compile.

**1. `windows-agent/agent.mjs` could never start on Windows.** It resolved an absolute
core-agent path and passed it straight to `import(coreAgentPath)`. On Windows, Node's
ESM loader parses `D:\a\...\agent.mjs` as a URL with protocol `d:` and throws
`ERR_UNSUPPORTED_ESM_URL_SCHEME`. The wrapper caught it, logged
`[ERROR] Failed to load core agent` and called `process.exit(1)` — so the Windows
Service wrapper, the entire reason `windows-agent/` exists, exited immediately on the
only platform it targets. Fixed with `import(pathToFileURL(coreAgentPath).href)`, which
is a no-op on POSIX where the bare path already worked. The error branch now also
prints the path and its file URL, since a silent exit-1 there cost a full release cycle
to diagnose.

Note this was masked in review because the failure only occurs on Windows: every
previous agent environment was Linux, where the same line works fine.

**2. `apps/android` `MainActivity.kt` did not compile.** Line 17 imported
`androidx.compose.foundation.layout.weight`, which is not a public top-level symbol —
the only thing by that name is `val RowColumnParentData?.weight`, which is `internal`.
Kotlin rejects it: *"Cannot access 'val RowColumnParentData?.weight: Float': it is
internal in file."* The import was also shadowing the `RowScope`/`ColumnScope` member
extension that all four `Modifier.weight(1f)` call sites actually need. Removed the
import; the call sites were already correct inside their `Row`/`Column` scopes. This is
the concrete cost of the handoff's repeated "None of this Kotlin was compiled".

Also silenced a Room warning: `AppDatabase` had `exportSchema = true` with no
`room.schemaLocation`, which warns on every build. It is a single-entity offline cache
with no migration history to preserve, so `exportSchema` is now `false`.

The diagnostics added for this are worth keeping: because the Actions log archive is not
retrievable from a sandbox (results-receiver, `*.blob.core.windows.net` and
`pipelines.actions.githubusercontent.com` all refuse connections, and the jobs API
exposes no step summary), the Android job re-emits Kotlin `e:`/`w:` lines, the failing
task and the raw log tail as `::error` annotations, and the Windows smoke test dumps both
launcher streams the same way. Annotations *are* readable through the check-runs API, so
that is the channel a future agent will have.

## Bridge apps phase, merged onto the Device-agent portal (2026-09-25)

`bridge-apps/` is now part of the repository: the two hosts that put the
access-device transport on the estate LAN, so a terminal never has to be
reachable from the Internet. `bridge-apps/windows/` + `scripts/package-bridge-exe.mjs`
build `estatemate-bridge-win-x64.exe` (a Node SEA single file that embeds
`isapi-bridge/agent.mjs` as a SHA-256-verified asset; `setup`, `check --json`,
`run`, `install-service`, and cross-builds for `linux-*`/`darwin-*`).
`bridge-apps/android/` + `scripts/build-bridge-apk.py` build the same bridge as a
~41 KB APK with no Gradle, Kotlin or AndroidX — aapt2 + ecj/javac + d8 +
apksigner — as a foreground service. Both speak the same three Worker endpoints
with the same agent key, so the portal cannot tell them apart. Read
`bridge-apps/README.md` before installing either one.

The agent also learned to resolve each terminal's EstateMate device id itself: a
device entry may carry only its LAN address, and `isapi-bridge/agent.mjs` looks
the id up among the devices the portal has linked to that agent. A terminal the
portal has not linked exits 1 with a message naming the terminal, its address and
the devices that are linked. `isapi-bridge/agent.resolution.integration.mjs`
proves both halves and runs as part of `npm test` (`npm run test:isapi-bridge`).

### The merge conflict this required, and how it was resolved

This work was cut from `8a4b85e`, before PR #17 renamed and simplified the same
portal page, so `apps/web/src/App.tsx` conflicted in the `IsapiBridge` component
— the only conflicting file. The resolution keeps **both** intents:

* main's page wins on structure and copy: the title **Device agent**, the
  collapsible setup guide, the trimmed tables, and Administrator-only
  **Download setup** / **Rotate secret** / **Delete** (matching
  `POST /api/isapi/agents/:id/installer` being `requireRoles('admin')`).
* this branch's contribution is folded in: an `Agent ID` and an
  `EstateMate device ID` column rendered as monospace identifiers, a **Copy ID**
  row action on both tables, and **Copy ID** / **Copy secret** / **Copy both**
  with a notice in the credentials panel. `rotateAgent` keeps
  `{ ...row, ...(await api(...)) }` so rotating a secret no longer blanks the
  agent's name and ID.

Both sides had also rewritten the operator-facing strings that say where to
click, and this branch's version named a page that no longer exists. They now
say **Device agent → Add agent**, **Connect terminal**, **Download setup**,
**Agents** and **Connected terminals** — in the two apps' runtime messages, their
READMEs, `isapi-bridge/README.md`, the root `README.md` and the `manual_sync`
warning the Worker returns when a device is registered. Two tests assert that
message text, so they were renamed in lockstep.

### Validation record (2026-09-25)

`npm ci`, `npm run typecheck`, `npm test` (108 vitest tests + the ISAPI bridge
integration and device-id-resolution scripts, which run the real
`isapi-bridge/agent.mjs` in a child process), `npm run build:web`,
`git diff --check` and the migration-chain check (14 migrations) all pass.
`node --check` passes on every `.mjs`/`.cjs` file the merge touches.

**Not compiled locally: the Java.** This sandbox has no JDK
(`command -v javac java ecj` finds nothing), so `bridge-apps/android/**` and the
`ProtocolTest.java` assertion rename are unverified here. `.github/workflows/bridge.yml`
is the path that compiles them: `bridge-apk` runs `scripts/build-bridge-apk.py --test`
(the 66-check protocol gate) before every APK build, and `bridge-exe` smoke-tests
the built executable against a fake Worker and a fake Digest terminal.

### Production deployment (2026-09-25)

- PR #21 merged to `main` as `a094d93`; **Deploy EstateMate run `36178112448`
  succeeded** (job `deploy`, 39 s, all steps green: `npm run build`,
  `Ensure private-storage encryption secret`, `Apply D1 migrations`,
  `Deploy Worker and web assets`). No migration was pending, so
  `0014_gate_image_and_security_gate_sessions.sql` remains the latest schema on
  D1 `estatemate-db`.
- Post-deploy smoke test from the deploying sandbox: `curl` to
  `*.workers.dev` is blocked there (`SSL_ERROR_SYSCALL`, exit 35), so the check
  ran through the HTTP page fetcher instead —
  `GET https://estatemate.estatemate.workers.dev/api/health` returned
  `{"ok":true,"app":"EstateMate","hikvisionMode":"per-device","fileStorage":"github-private"}`
  and `GET /` rendered the configured login screen ("Dantata Estate").
- **Not verified from the sandbox:** the served portal asset hashes (the fetcher
  returns extracted text, not raw `index.html`) and the Cloudflare build logs,
  which were unreachable (`results-receiver.actions.githubusercontent.com`
  returns EOF here). The Actions run conclusion and the live health check are the
  evidence of a successful deploy.
- The Java in `bridge-apps/` was still not compiled in the sandbox; the
  **Build EstateMate Bridge** workflow remains the only path that compiles it.

## Most recent migration

`migrations/0015_fingerprint_credentials.sql`

It adds the fingerprint credential register:

- `fingerprint_credentials`: `resident_id` (always the main resident), optional `household_member_id`, `employee_no`, `finger_no` (CHECK 1–10), `finger_label`, `enrolled_device_id`, `status`/`expires_at`/`auto_expired`/`deactivated_*`, `created_by`. A unique index on `(resident_id, COALESCE(household_member_id,''), finger_no)` stops the same slot being recorded twice for one person while still allowing a new record after a revocation.
- `fingerprint_status_changes`: the audit trail for enrollment, suspension, expiry/restore and deletion.
- `access_events.fingerprint_id`: which finger opened the gate, so a cardless event is attributable.
- `device_operations` is **rebuilt data-preservingly** (SQLite cannot widen a CHECK constraint): every 0011 column is carried over and `fingerprint_id` plus `manual_instruction` are added, with `enroll_fingerprint`/`enable_fingerprint`/`disable_fingerprint`/`delete_fingerprint` allowed alongside the existing card and visitor kinds.
- No existing card or event row is altered, and replaying the chain verifies the pre-0015 operation rows survive the rebuild.

The previous migration, `migrations/0014_gate_image_and_security_gate_sessions.sql`

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

### Production deployment (2026-09-24, portal UX phase)

- PR #11 merged to `main` (`f4e543d`); Deploy EstateMate run `36074600948` **succeeded**. All eleven job steps are green, including `npm run build` (typecheck + 105 vitest tests + `build:web` in CI), `Apply D1 migrations` (`0014_gate_image_and_security_gate_sessions.sql` applied to D1 `estatemate-db`) and `Deploy Worker and web assets`.
- **Post-deploy HTTP smoke test is still owed.** The deploying environment had no TLS egress to `*.workers.dev`, so `GET /api/health` and the changed APIs could not be exercised against production from there. Verify from a normal browser/curl: `GET /api/health`; `GET /api/portal-config` now returns `portal_gate_image_key`/`portal_gate_image_caption`/`portal_gate_image_enabled`; `GET /api/portal-gate-image` answers `404` until an image is published; `GET /api/access/card-recipients` and `GET /api/security/gate-assignments` respond for an Administrator; and a Security officer with an assignment is offered gate selection at sign-in.
- The gate image cannot be verified until private GitHub storage is configured in production (**Settings → Private GitHub upload storage**), because the upload path depends on it.
- Operator follow-up: post each Security officer at their gates under **Settings → Security gate assignments**. Until an officer has at least one assignment they sign in unscoped and see every gate, by design.

### Pre-existing failure: Cloudflare Workers Builds

The `Workers Builds: estatemate` commit check has been **red since `e550d64`** and is still red on `05060b8` and `f4e543d` — that is, it fails on commits that deployed to production successfully through GitHub Actions. It is not a required check and does not block merges. The authoritative deploy path is `.github/workflows/deploy.yml`, which is green. Root cause was not established: the build logs live in the Cloudflare dashboard, which was unreachable from the environment that recorded this. Treat this check as noise until someone reads the Cloudflare build log, but do not assume a red Workers Build means production is broken — and do not "fix" a deploy by changing the Actions workflow because of it.

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
