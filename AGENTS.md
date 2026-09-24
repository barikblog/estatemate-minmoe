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
- CI deployment: `.github/workflows/deploy.yml`

## Non-negotiable project rules

- No paid service is required. Do not add R2 or another paid dependency.
- Files go to the administrator-configured private GitHub repository; D1 stores metadata only.
- Never commit tokens, passwords, device secrets or production exports.
- Manager is an operational role only: it must not gain billing/payment, private-storage, global-settings, Administrator/Manager account-control or ingest-secret rotation permissions.
- Each property has one active legal owner. Tenancy never changes ownership.
- Preserve ownership, tenancy, billing, card, visitor and access-event history.
- Default visitor gate policy is preview first, then Admin/Security accepts or rejects.
- Direct HTTP Listening, the Render relay, and the ISAPI bridge agent's alertStream streaming are event-upload paths, not command channels.
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

Android requires JDK 17 and an Android SDK. If unavailable, state clearly that Kotlin changes were not compiled.

## Deployment workflow

Push to `main`. GitHub Actions applies pending D1 migrations and deploys the Worker/web portal. Check the Actions run and smoke-test `/api/health` plus any changed API. Do not run remote migrations twice manually.

Update `docs/AI-HANDOFF.md` whenever architecture, deployment state or unfinished work changes.
