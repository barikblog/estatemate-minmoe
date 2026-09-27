# hikvision-tunnel-worker

A standalone, wrangler-compatible **Cloudflare Worker** that bridges a public web
app (Cloudflare Pages) with a local **Hikvision access-control terminal** which
is exposed securely through a **Cloudflare Tunnel** (e.g. `https://mydomain.com`),
backed by a **Cloudflare D1** database.

```
                    ┌─────────────────────────────  Cloudflare edge  ─────────────────────────────┐
  Pages frontend ──▶│  hikvision-tunnel-bridge Worker            Cloudflare Tunnel (cloudflared)  │──▶ Hikvision terminal
  (browser)         │   ├─ POST /pull-logs  ── ISAPI Digest ──▶ /ISAPI/AccessControl/AcsEvent     │    (ISAPI on the LAN)
  cron (*/5)     ──▶│   ├─ scheduled()      ── pull events ──▶ D1 `access_logs`                   │
                    │   └─ POST /sync-user  ── ISAPI Digest ──▶ /ISAPI/AccessControl/UserInfo/…   │
                    └─────────────────────────────── D1: access_logs · device_users · device_status ┘
```

Two operations:

| | Operation | Trigger | Device endpoint | D1 table |
|---|---|---|---|---|
| **1** | **PULL** access logs into D1 | cron `*/5 * * * *` or `POST /pull-logs` | `GET /ISAPI/AccessControl/AcsEvent?format=json` | `access_logs` (UPSERT, idempotent) |
| **2** | **POST** users to the device | `POST /sync-user` (body **or** queued D1 rows) | `POST /ISAPI/AccessControl/UserInfo/Record?format.json`* | `device_users` (staging) |

\* `…/UserInfo/Record?format=json` — automatic `PUT` fallback for firmware that rejects `POST`.

> **⚠️ Architecture note (read first).** The EstateMate repository's `AGENTS.md`
> documents the Cloudflare Tunnel as *remote human access only* and the local
> `isapi-bridge` agent as the *sole automatic transport* for the main product.
> This worker is a **standalone, separately deployed** component that you
> explicitly requested; it does not touch the main `src/index.ts` Worker, its
> migrations, or the agent. If you deploy it, treat its hostname as a machine
> endpoint: **the tunnel hostname MUST sit behind a Cloudflare Access
> application** (service token — supported natively via
> `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`, see below) and the terminal
> keeps its own Digest credentials. Never publish the terminal without both.

## Files

| File | Purpose |
|---|---|
| `index.ts` | The complete Worker (cron `scheduled()` + `fetch` router, Digest/Basic auth, D1 upserts). |
| `index.test.ts` | Unit tests: RFC 1321 MD5 vectors, RFC 2617 Digest vector, AcsEvent parsing, strict `UserInfo` shape. |
| `wrangler.toml` | Wrangler config: D1 binding, cron trigger, non-secret vars. |
| `schema.sql` | D1 DDL (`access_logs`, `device_users`, `device_status`). Also created lazily at runtime. |
| `.dev.vars.example` | Local secrets template for `wrangler dev`. |
| `tsconfig.json` | Standalone type-check config (root `npm run typecheck` does not include this folder). |

## Setup

> **Note:** this monorepo contains the main app's `wrangler.jsonc` at the root. Wrangler 4's auto-detection walks up the directory tree and will pick that file, so **always pass `--config wrangler.toml`** when running wrangler from this folder.

```bash
cd hikvision-tunnel-worker

# 1. Create the D1 database and paste its id into wrangler.toml
npx wrangler --config wrangler.toml d1 create hikvision-bridge-db

# 2. Create the tables (remote and/or local)
npx wrangler --config wrangler.toml d1 execute hikvision-bridge-db --remote --file schema.sql
npx wrangler --config wrangler.toml d1 execute hikvision-bridge-db --local  --file schema.sql

# 3. Point TUNNEL_URL at your tunnel origin (wrangler.toml [vars]) and set secrets
npx wrangler --config wrangler.toml secret put HIK_USER              # Hikvision ISAPI username
npx wrangler --config wrangler.toml secret put HIK_PASS              # Hikvision ISAPI password
npx wrangler --config wrangler.toml secret put API_TOKEN             # bearer token for the Pages frontend
# Optional — only if the tunnel hostname is behind a Cloudflare Access app:
npx wrangler --config wrangler.toml secret put CF_ACCESS_CLIENT_ID
npx wrangler --config wrangler.toml secret put CF_ACCESS_CLIENT_SECRET

# 4. Deploy
npx wrangler --config wrangler.toml deploy
```

### Cloudflare Tunnel reference

Your `cloudflared` ingress already routes the public hostname to the terminal
(see `docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md` for the repository's kit):

```yaml
ingress:
  - hostname: mydomain.com
    service: http://192.168.1.50        # Hikvision terminal LAN address (:80)
  - service: http_status:404
```

Recommended hardening for this worker's hostname:

```bash
# Put the hostname behind Cloudflare Access (service token for machine access)
# then grant the worker's service token permission to reach it — the worker
# sends CF-Access-Client-Id / CF-Access-Client-Secret automatically when set.
npx wrangler --config wrangler.toml secret put CF_ACCESS_CLIENT_ID
npx wrangler --config wrangler.toml secret put CF_ACCESS_CLIENT_SECRET
```

On the terminal itself: enable Digest authentication for ISAPI (default),
use a dedicated (non-default) admin account, and keep NTP time in sync so
Digest nonces validate.

## API reference

All endpoints except `GET /` and `GET /health` require
`Authorization: Bearer $API_TOKEN` once `API_TOKEN` is configured
(recommended; also accepted as `X-Api-Token`).

### `POST /pull-logs` — Operation 1 on demand

```bash
curl -X POST https://hikvision-tunnel-bridge.<account>.dev/pull-logs \
  -H "Authorization: Bearer $API_TOKEN"
# 200 {"ok":true,"mode":"get","fetched":7,"persisted":7}
# 502 {"ok":false,"mode":"get","fetched":0,"persisted":0,"error":"…"}
```

The same pull runs automatically from the cron trigger (`*/5 * * * *`).
Events are upserted on a deterministic `event_id`
(`hik_<sha256(time|employee|card|door|monitorIndex)>`), so overlapping
poll windows never create duplicates. If the firmware rejects `GET`, the
worker transparently falls back to a `POST` event search with
`HIK_EVENT_LOOKBACK_MINUTES` (default 10) as the window.

### `GET /access-logs?limit=50` — read back D1

```bash
curl https://hikvision-tunnel-bridge.<account>.dev/access-logs?limit=20 \
  -H "Authorization: Bearer $API_TOKEN"
# {"logs":[{"event_id":"hik_…","employee_no":"1001","card_no":"654321",
#           "event_time":"2026-09-27T08:30:00+01:00","door_no":"1","synced_at":"…"}]}
```

### `POST /sync-user` — Operation 2

Three accepted shapes:

```bash
# a) one user in the body
curl -X POST https://hikvision-tunnel-bridge.<account>.dev/sync-user \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"employeeNo":"1001","name":"Jane Doe","cardNo":"654321","doorNo":1}'

# b) several users
curl -X POST …/sync-user -H 'Content-Type: application/json' \
  -d '{"users":[{"employeeNo":"1002","name":"Ali Musa","cardNo":"778811"}]}'

# c) empty body → push every D1 device_users row whose sync_status != 'synced'
curl -X POST …/sync-user -H "Authorization: Bearer $API_TOKEN"
```

Response (`200` when every push succeeded, `502` when any failed):

```json
{
  "ok": true, "source": "body", "synced": 1, "failed": 0,
  "results": [{ "employeeNo": "1001", "ok": true, "statusCode": 1, "statusString": "OK" }]
}
```

Rows pushed from D1 are marked `synced`/`failed` in `device_users`
(`failed` rows keep `last_error` and are retried on the next empty-body call).

### `GET /sync-user`, `GET /health`

* `GET /sync-user` — the D1 queue that still needs pushing.
* `GET /health` — configuration flags + last pull status (unauthenticated liveness probe).

## Deployment via CI (recommended)

`.github/workflows/deploy-bridge.yml` (**Deploy Hikvision tunnel bridge**) deploys
this Worker with the repository's existing `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` Actions secrets:

1. **Merge to `main`** (with changes under `hikvision-tunnel-worker/`) provisions (or reuses) the D1
   database, patches `database_id` in the runner, applies `schema.sql`, deploys the
   Worker, pushes whichever of `HIK_USER`, `HIK_PASS`, `API_TOKEN`,
   `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` exist as repository secrets, and
   smoke-tests `GET /health` on the new `*.workers.dev` URL.
2. **Configuration inputs** (highest wins): workflow-dispatch `tunnel_url` →
   repository variable `BRIDGE_TUNNEL_URL` → `wrangler.toml` `[vars]`.
3. **Repository secrets to set** (Settings → Secrets and variables → Actions), then
   re-run the workflow: `HIK_USER`, `HIK_PASS`, `API_TOKEN` (plus the Access pair if
   used). Until they exist the Worker deploys but reports
   `"deviceAuthConfigured":false` and every device call fails closed with a 401/502.

## Cloudflare Pages integration

The Pages frontend only needs the worker URL and the token (keep the token in a
Pages secret or server-side proxy, never in public `VITE_*` vars if the repo is
public):

```ts
const BRIDGE = 'https://hikvision-tunnel-bridge.<account>.dev';
const TOKEN = /* injected server-side */ '';

// Operation 1 — pull now
await fetch(`${BRIDGE}/pull-logs`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
});

// Read access logs for a table UI
const { logs } = await (await fetch(`${BRIDGE}/access-logs?limit=100`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})).json();

// Operation 2 — push a new employee
const report = await (await fetch(`${BRIDGE}/sync-user`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ employeeNo: '1001', name: 'Jane Doe', cardNo: '654321' }),
})).json();
```

Cross-origin calls are handled: set `PAGES_ORIGIN` (var) to your Pages origin
to allow-list it (`*` or unset reflects any origin — safe only because the data
endpoints require the bearer token). Alternative: attach a custom route /
Workers custom domain on the same site and skip CORS entirely.

## Local development

```bash
cp .dev.vars.example .dev.vars       # then edit values (gitignored by the repo)
npx wrangler --config wrangler.toml d1 execute hikvision-bridge-db --local --file schema.sql
npx wrangler --config wrangler.toml dev                     # http://localhost:8787
```

Type-check and test this worker:

```bash
npx tsc --noEmit -p hikvision-tunnel-worker/tsconfig.json
npx vitest run hikvision-tunnel-worker/index.test.ts
```

## Environment variables

| Name | Secret? | Required | Meaning |
|---|---|---|---|
| `TUNNEL_URL` | no (var) | ✅ | Tunnel origin, e.g. `https://mydomain.com` |
| `HIK_USER` | ✅ | ✅ | ISAPI username |
| `HIK_PASS` | ✅ | ✅ | ISAPI password |
| `HIK_AUTH_MODE` | no | — | `digest` (default) or `basic` (pre-emptive) |
| `HIK_EVENT_LOOKBACK_MINUTES` | no | — | POST-search window, default `10` |
| `API_TOKEN` | ✅ | recommended | Bearer token guarding the data endpoints |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | ✅ | with Access | Cloudflare Access service token |
| `PAGES_ORIGIN` | no | — | CORS allow-list for the Pages frontend |

## Security checklist

- [ ] Tunnel hostname sits behind a Cloudflare Access app (service token).
- [ ] Terminal uses Digest auth with a dedicated, non-default account + NTP.
- [ ] `API_TOKEN` set; Pages consumes it from a secret, not public bundle vars.
- [ ] `HIK_USER`/`HIK_PASS` stored as `wrangler secret`, never in git.
- [ ] D1 database id in `wrangler.toml` is your own (`wrangler d1 create`).
- [ ] Rate/abuse: cron interval and `MAX_EVENT_BATCH`/`MAX_SYNC_USERS` caps are conservative.
