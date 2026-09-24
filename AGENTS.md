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

## Architecture

- Cloudflare Worker/Hono API: `src/index.ts`
- Cloudflare D1 migrations: `migrations/*.sql` (append-only; never edit a deployed migration)
- React/Vite portal: `apps/web/`
- Android/Compose client: `apps/android/`
- Access-device event normalisation: `src/hikvision.ts` and `src/hikvision-profiles.ts`
- Private GitHub upload storage: `src/github-storage.ts`
- Optional stateless Render HTTPS relay: `bridge/` and `render.yaml`
- Dedicated local-appliance/off-site official-SDK ISUP gateway package: `isup-gateway/`
- Pull-request quality gate (no deploy, no credentials): `.github/workflows/ci.yml`, backed by `scripts/ci-checks.sh` for the PR-relative checks
- CI deployment: `.github/workflows/deploy.yml`

## Non-negotiable project rules

- No paid service is required. Do not add R2 or another paid dependency.
- Files go to the administrator-configured private GitHub repository; D1 stores metadata only.
- Never commit tokens, passwords, device secrets or production exports.
- Manager is an operational role only: it must not gain billing/payment, private-storage, global-settings, Administrator/Manager account-control or ingest-secret rotation permissions.
- Each property has one active legal owner. Tenancy never changes ownership.
- Preserve ownership, tenancy, billing, card, visitor and access-event history.
- Default visitor gate policy is preview first, then Admin/Security accepts or rejects.
- Direct HTTP Listening and the Render relay are event-upload paths, not command channels.
- Render Free cannot be made into public raw ISUP/TCP by a keep-alive script; use `isup-gateway/` on a small LAN appliance or another eligible TCP-capable host.
- The ISUP host/control package is not a functioning protocol engine until compiled with the licensed official SDK for the exact architecture/model/firmware.
- Never claim a model supports QR, HTTP Listening, ISUP or remote commands without model/firmware evidence.
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

Android requires JDK 17 and an Android SDK. If unavailable, state clearly that Kotlin changes were not compiled. CI has neither.

## Deployment workflow

Only a push to `main` (or a manual run) ships: the deployed Worker is `estatemate` on the `estatemate` account subdomain, i.e. `https://estatemate.estatemate.workers.dev`, and the hostname comes from the Cloudflare account rather than the repository, so a different account yields `estatemate.<their-subdomain>.workers.dev`. Feature-branch pushes never deploy; their pull requests are validated by `CI`. Push to `main`. GitHub Actions builds and tests first, then applies pending D1 migrations and deploys the Worker/web portal. Check the Actions run and smoke-test `/api/health` plus any changed API. Do not run remote migrations twice manually.

A Cloudflare Builds integration (GitHub App `cloudflare-workers-and-pages`) is also wired to the same `estatemate` Worker service and built `main` on 2026-09-24 alongside the Actions deploy, so production currently has two ship paths. Its build/deploy commands live in the Cloudflare dashboard rather than this repository, which means `wrangler.jsonc` changes are not automatically matched there, and it reports a red check on branches that are not `main`. Verify this before relying on a single source of truth: either keep `deploy.yml` authoritative and disable the Cloudflare build, or move to Cloudflare Builds alone and delete the deploy steps here. Never let both apply migrations.

Update `docs/AI-HANDOFF.md` whenever architecture, deployment state or unfinished work changes.
