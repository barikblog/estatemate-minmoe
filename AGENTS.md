# EstateMate agent instructions

This file is the starting point for any AI coding agent continuing EstateMate in GitHub or a local checkout.

## Read first

1. `README.md`
2. `docs/AI-HANDOFF.md`
3. `docs/MINMOE-NO-PC.md`
4. `docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md`
5. `docs/PEOPLE-REGISTRATION-AND-IMPORTS.md`
6. `docs/MANAGERS-IMPORTS-HIKCONNECT-SITE-SYNC.md`
7. Latest migrations in `migrations/`

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
- CI deployment: `.github/workflows/deploy.yml`
- Client artifact builds (Windows agent bundle + Android APK): `.github/workflows/bridge.yml`, on `bridge-*` tags
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
- Fingerprints are their own credential (`migrations/0015_fingerprint_credentials.sql`), not a card number. A finger is captured on the terminal, so fingerprint operations are always queued `manual_action_required` with a `manual_instruction` and must never be handed to the agent until per-model evidence exists in `docs/device-profiles/`. Cardless gate events are attributed by the terminal's `employee_no`, and `access_cards.card_uid` stays a real card number.
- Terminal employee numbers (ISAPI `employeeNo`) are issued by EstateMate only (`src/employee-number.ts`, `migrations/0017_tamper_proof_employee_numbers.sql`): nine digits with a Damm check digit, drawn from the CSPRNG, one per person (a main resident or a household member), shared by all of that person's cards and fingers. Never accept one from a caller, never derive one from a user id, never let an agent guess one (no `residentId`/`"1"` fallback — fail the operation instead), and never weaken the database triggers that make a number immutable, permanent and bound to its person. Every card operation carries the holder's number, and the Worker re-stamps it from `employee_numbers` when an agent polls.
- Suspending a person's access means their cards *and* their fingerprints: account deactivation, household-member deactivation, tenancy end and facility-fee enforcement all cover both credential types.
- Never claim a model supports QR, alertStream, ISAPI card APIs or remote commands without model/firmware evidence.
- DS-K1T808MFWX-B is card/fingerprint/PIN oriented; DS-K2802 is a controller and needs a reader.
- Soft-delete access devices so historical events retain referential integrity.

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

Only a push to `main` (or a manual run) ships: the deployed Worker is `estatemate` on the `estatemate` account subdomain, i.e. `https://estatemate.estatemate.workers.dev`, and the hostname comes from the Cloudflare account rather than the repository, so a different account yields `estatemate.<their-subdomain>.workers.dev`. Feature-branch pushes never deploy; their pull requests are validated by `CI`. Push to `main`. GitHub Actions builds and tests first, then applies pending D1 migrations and deploys the Worker/web portal. Check the Actions run and smoke-test `/api/health` plus any changed API. Do not run remote migrations twice manually.

A Cloudflare Builds integration (GitHub App `cloudflare-workers-and-pages`) is also wired to the same `estatemate` Worker service and built `main` on 2026-09-24 alongside the Actions deploy, so production currently has two ship paths. Its build/deploy commands live in the Cloudflare dashboard rather than this repository, which means `wrangler.jsonc` changes are not automatically matched there, and it reports a red check on branches that are not `main`. Verify this before relying on a single source of truth: either keep `deploy.yml` authoritative and disable the Cloudflare build, or move to Cloudflare Builds alone and delete the deploy steps here. Never let both apply migrations.

Update `docs/AI-HANDOFF.md` whenever architecture, deployment state or unfinished work changes.
