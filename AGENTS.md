# EstateMate agent instructions

This file is the starting point for any AI coding agent continuing EstateMate in GitHub or a local checkout.

## Read first

1. `README.md`
2. `docs/AI-HANDOFF.md`
3. `docs/MINMOE-NO-PC.md`
4. `docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md`
5. `docs/PEOPLE-REGISTRATION-AND-IMPORTS.md`
6. `docs/MANAGERS-IMPORTS-HIKCONNECT-SITE-SYNC.md`
7. `docs/EMPLOYEE-ID-AND-BULK-PEOPLE.md`
8. `docs/VISITOR-DEVICE-ACCOUNTS.md`
9. `docs/ESTATE-MODULES.md`
10. Latest migrations in `migrations/`

Run `./scripts/ai-context.sh` to print a safe repository summary.

Retired transports: direct HTTP Listening, the Render free relay, Hikvision cloud/OpenAPI and the dedicated ISUP gateway were removed (migration `0013_agent_only_transports.sql` deleted `bridge/`, `render.yaml` and `isup-gateway/`). Devices previously on those transports were migrated to `manual_sync`; link them to an agent to make them automatic again. Do not recreate those endpoints or packages.

## Architecture

- Cloudflare Worker/Hono API: `src/index.ts`
- Cloudflare D1 migrations: `migrations/*.sql` (append-only; never edit a deployed migration)
- React/Vite portal: `apps/web/`
- Android/Compose client: `apps/android/`
- Access-device event normalisation: `src/hikvision.ts` and `src/hikvision-profiles.ts`
- Private GitHub upload storage: `src/github-storage.ts`
- The only access-device transport: `isapi-bridge/` agent (+ `windows-agent/` Windows Service wrapper)
- Pull-request quality gate (no deploy, no credentials): `.github/workflows/ci.yml`, backed by `scripts/ci-checks.sh` for the PR-relative checks
- Deployment: Cloudflare Workers Builds (`.node-version`, `scripts/cloudflare-builds-deploy.mjs`) or GitHub Actions (`.github/workflows/deploy.yml`), never both — `vars.CLOUDFLARE_BUILDS_AUTHORITATIVE` picks one. Runbook: `docs/CLOUDFLARE-WORKERS-BUILDS.md`. Manual Cloudflare provisioning: `.github/workflows/provision.yml`
- Client artifact builds (Windows agent bundle + Android APK): `.github/workflows/bridge.yml`, on `bridge-*` tags
- Windows install: `bridge-apps/windows/msi/` — the WiX source (`estatemate-bridge.wxs`) and the kit launcher (`Install-EstateMate-Bridge.cmd` + `install-bridge.ps1`), packaged by `scripts/package-bridge-msi.mjs`. The launcher verifies the MSI, logs the install, explains the exit code and falls back to a per-user install (no Windows Installer, no admin) when an MSI cannot complete on a real PC. The MSI also installs the dashboard
- Windows dashboard: `bridge-apps/windows/dashboard/` — `EstateMateBridge.ps1` (WinForms window: status, configuration, service), `Launcher.cs` + `build-dashboard.cmd` (compiles `EstateMateBridge.exe`, a GUI launcher, using a compiler the machine already has), `EstateMateBridge.cmd`. It drives the bridge CLI for everything, so it holds no configuration logic of its own; `EstateMateBridge.exe -SelfTest` is the headless check the Windows runner runs after installing the MSI
- Remote support access (Cloudflare Tunnel / Zero Trust Free): `scripts/cloudflared-remote-access.mjs` (+ `.integration.mjs`), documented in `docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`

## Non-negotiable project rules

- No paid service is required. Do not add R2 or another paid dependency.
- Files go to the administrator-configured private GitHub repository; D1 stores metadata only.
- Never commit tokens, passwords, device secrets or production exports.
- Manager is an operational role only: it must not gain billing/payment, private-storage, global-settings, Administrator/Manager account-control or ingest-secret rotation permissions.
- Each property has one active legal owner. Tenancy never changes ownership.
- Preserve ownership, tenancy, billing, card, visitor and access-event history.
- Default visitor gate policy is preview first, then Admin/Security accepts or rejects.
- There is exactly one automatic device transport: the EstateMate agent (`isapi_bridge`/`windows_agent`/`isapi_windows_agent`). Do not reintroduce direct device-to-Cloudflare paths (HTTP Listening, Render relay, cloud/OpenAPI, ISUP gateway were removed in migration 0013).
- Cloudflare Tunnel is **remote human access only** (`scripts/cloudflared-remote-access.mjs`, `docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`). It publishes the estate LAN to Zero Trust-enrolled admins over WARP private-network routing. Never let it carry events, card operations, door commands or any other automatic path: an access device cannot run WARP or complete an Access login, the free plan publishes HTTP/HTTPS only, and a public terminal hostname is exactly what the README forbids. A hostname is emitted only with both `--domain` and `--allow-public-hostnames`, and every one must sit behind an Access policy. Gate operation must never depend on the tunnel. Access control remote door commands stay on the agent queue; do not claim a terminal model honours remote door open unless `docs/device-profiles/` records it.
- The agent's alertStream streaming is an event-upload path; card/visitor commands always flow agent-side via operation polling and ISAPI Digest.
- Fingerprints are their own credential (`migrations/0015_fingerprint_credentials.sql`), not a card number. A finger is read on the terminal's own sensor, so capture and template delivery are **capability-gated**: the bridge probes the terminal and advertises `person`/`fingerprint` on its heartbeat, and the Worker hands it that work only when it does. A terminal whose firmware refuses `CaptureFingerPrint`/`FingerPrint/SetUp` keeps the `manual_action_required` task with a `manual_instruction` — never drop the work instead of queueing it. The person record (with `doorRight`/`RightPlan`) is written **before** the credential that names it. Cardless gate events are attributed by the terminal's `employee_no`, and `access_cards.card_uid` stays a real card number.
- The LAN bridge must write cards only with the person's EstateMate `employee_id` (1–32 terminal-safe characters). If it is missing/invalid, refuse the write—never substitute a resident UUID or guessed `1`; retain the terminal's `ResponseStatus` reason in failed-operation diagnostics. Keep the Node and Android bridge implementations equivalent.
- Suspending a person's access means their cards *and* their fingerprints: account deactivation, household-member deactivation, tenancy end and facility-fee enforcement all cover both credential types.
- Never claim a model supports QR, alertStream, ISAPI card APIs or remote commands without model/firmware evidence.
- DS-K1T808MFWX-B is card/fingerprint/PIN oriented; DS-K2802 is a controller and needs a reader.
- Soft-delete access devices so historical events retain referential integrity.
- **Employee IDs are never longer than 32 characters** (the ISAPI employeeNo limit). They live on the *person* (`users.employee_id`, `household_members.employee_id`), are unique across both tables, and every place that accepts or composes one validates with `src/employee-id.ts` — never the raw 36-char UUID.
- **A visitor pass is never deleted by the device-account lifecycle.** The lifecycle only advances `visitor_requests.device_account_state` (none → provisioned → removal_queued → removed) and manages the terminal slot; the row, gate history, and audit persist. A `checked_in` pass is never status-flipped by the sweep — an overstaying visitor physically inside the estate must stay checkable-out.
- **Two cron schedules exist** (`wrangler.jsonc`): the hourly housekeeping job and a per-minute one that runs *only* the bounded visitor-slot release. Keep the minute job cheap — never add property/billing/pruning work to it.

## Required validation before commit

```bash
npm ci
npm run typecheck
npm test
npm run build:web
git diff --check
python3 - <<'PY'
import pathlib, sqlite3
con=sqlite3.connect(':memory:')
for migration in sorted(pathlib.Path('migrations').glob('*.sql')):
    con.executescript(migration.read_text())
print('migration chain OK')
PY
```

`bash scripts/ci-checks.sh` reruns the PR-relative gates locally: whitespace/conflict-marker damage, edits or deletions of already-deployed migrations, and committed credential files or token-shaped secrets on added lines. `.github/workflows/ci.yml` runs the same commands plus a credential-free `wrangler deploy --dry-run` on every pull request targeting `main`.

Android requires JDK 17 and an Android SDK. If unavailable, state clearly that Kotlin changes were not compiled locally — `.github/workflows/bridge.yml` (`Build EstateMate Bridge`) is the path that does compile them: it runs on a pull request touching `apps/android/**` and on every `bridge-*` tag.

## Deployment workflow

Only a push to `main` (or a manual run) ships: the deployed Worker is `estatemate` on the `estatemate` account subdomain, i.e. `https://estatemate.estatemate.workers.dev`, and the hostname comes from the Cloudflare account rather than the repository, so a different account yields `estatemate.<their-subdomain>.workers.dev`. Feature-branch pushes never deploy; their pull requests are validated by `CI`. Push to `main`. Whichever path is active builds and tests first, then applies pending D1 migrations, then deploys the Worker/web portal — in that order, because `wrangler deploy` never applies migrations and would otherwise publish code that queries columns production does not have. Check the run and smoke-test `/api/health` plus any changed API. Do not run remote migrations twice manually.

**Exactly one ship path is active**, selected by the repository variable `CLOUDFLARE_BUILDS_AUTHORITATIVE` (Settings → Secrets and variables → Actions → Variables), which both `.github/workflows/deploy.yml` and `.github/workflows/smoke.yml` read:

- **unset / not `true`** — GitHub Actions ships: `deploy.yml` builds, ensures the encryption secret, applies D1 migrations and deploys. This is the default and the historical behaviour.
- **`true`** — Cloudflare Workers Builds ships: `deploy.yml` deploys nothing and applies no migrations (it runs a `delegated-to-cloudflare-builds` job that says so), Cloudflare runs Build command `npm run build` then Deploy command `npm run deploy:cloudflare`, and `smoke.yml` waits for this commit's `Workers Builds: estatemate` check before testing, so it never reports a green about the previous deployment. Rollback is deleting the variable — no code change.

The Cloudflare Git integration (GitHub App `cloudflare-workers-and-pages`, check `Workers Builds: estatemate`) is already connected to this Worker and was deploying `main` in parallel with Actions, so production had two ship paths; its preview builds were red on every non-`main` commit, including docs-only ones, most likely because the auto-generated build token has no D1 or Queues scope. **Never let both apply migrations.** `docs/CLOUDFLARE-WORKERS-BUILDS.md` carries the verified evidence, the dashboard settings, the token scopes, the cutover order and the bridge's separate status — read it before changing either workflow.

Update `docs/AI-HANDOFF.md` whenever architecture, deployment state or unfinished work changes.
