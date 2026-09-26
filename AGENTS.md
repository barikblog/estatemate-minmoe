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
- Cloudflare Tunnel is **remote human access only** (`scripts/cloudflared-remote-access.mjs`, `docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`). It publishes the estate LAN to Zero Trust-enrolled admins over WARP private-network routing. Never let it carry events, card operations or any other automatic path: an access device cannot run WARP or complete an Access login, the free plan publishes HTTP/HTTPS only, and a public terminal hostname is exactly what the README forbids. A hostname is emitted only with both `--domain` and `--allow-public-hostnames`, and every one must sit behind an Access policy. Gate operation must never depend on the tunnel.
- The agent's alertStream streaming is an event-upload path; card/visitor commands always flow agent-side via operation polling and ISAPI Digest.
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

Android requires JDK 17 and an Android SDK. If unavailable, state clearly that Kotlin changes were not compiled locally — `.github/workflows/bridge.yml` (`Build EstateMate Bridge`) is the path that does compile them: it runs on a pull request touching `apps/android/**` and on every `bridge-*` tag.

## Deployment workflow

Push to `main`. GitHub Actions applies pending D1 migrations and deploys the Worker/web portal. Check the Actions run and smoke-test `/api/health` plus any changed API. Do not run remote migrations twice manually.

Update `docs/AI-HANDOFF.md` whenever architecture, deployment state or unfinished work changes.
