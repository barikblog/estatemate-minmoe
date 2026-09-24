# Hikvision ISAPI Bridge and Windows Agent

This document describes the new ISAPI bridge and Windows agent introduced in migration `0011_hikvision_isapi_sync.sql`.

## Problem

- **Direct HTTP Listening** is event-upload only on most Hikvision firmware. Card add/disable commands cannot be sent back through the estate router.
- **ISUP gateway** (`isup-gateway/`) requires official Hikvision SDK compiled for exact architecture/firmware and a Linux appliance.
- **Manual sync** requires operator to apply each change in iVMS-4200 or device UI, then mark applied in EstateMate.

Many estates already have a Windows PC (CCTV, accounting) on same LAN as devices. They need automatic card provisioning without buying Linux hardware or SDK.

## Solution: ISAPI Bridge + Windows Agent

The ISAPI bridge is a small Node.js agent that runs on the same LAN as Hikvision devices (Windows, Linux, macOS). It:

1. Polls Cloudflare Worker for pending operations:
   - `GET /api/isapi/v1/agents/:id/operations` — card upsert/enable/disable/delete, visitor upsert
   - Auth: `X-EstateMate-Agent-Key: <secret>` or `Authorization: Bearer <secret>`
2. Applies them via Hikvision ISAPI (HTTP Digest Auth) to the device:
   - `POST /ISAPI/AccessControl/CardInfo/Record?format=json`
   - `PUT /ISAPI/AccessControl/CardInfo/Delete?format=json`
   - XML fallback: `/ISAPI/AccessControl/CardInfo/Record`
3. Reports result:
   - `POST /api/isapi/v1/agents/:id/operations/:opId/result` with `{kind, status: applied|failed, errorMessage, durationMs}`
4. Heartbeats:
   - `POST /api/isapi/v1/agents/:id/heartbeat` with version/hostname

No SDK required — uses documented ISAPI endpoints available on most K1T, K26xx, K27xx/K28xx when accessed from LAN.

## Database schema (0011)

- `isapi_agents` — registry of bridge agents (Windows/Linux). Fields: id, name, hostname, platform, version, status, secret_hash, last_seen_at, last_ip.
- `isapi_device_configs` — per-device ISAPI connection: device_id (FK hikvision_devices), agent_id (FK isapi_agents), isapi_host (LAN IP), isapi_port, isapi_username, isapi_password_ciphertext/iv (encrypted with STORAGE_ENCRYPTION_KEY), protocol http/https, sync_enabled, last_sync_at/status/error.
- `isapi_sync_logs` — audit of each sync attempt: device_id, agent_id, operation_id, operation_type, status (started/success/failed), message, duration_ms.
- `isapi_agent_installers` — one-time installer keys (24h expiry) for PowerShell/shell installers.
- Extended `hikvision_devices`: isapi_agent_id, isapi_sync_enabled, last_isapi_sync_at/status, isapi_host/port/username/password_ciphertext/iv/protocol.
- Extended `device_operations` and `visitor_device_operations`: agent_id, isapi_synced_at, sync_source (isup_gateway, isapi_bridge, windows_agent, manual).

Indexes added for agent status, device lookups, and sync logs.

## Backend endpoints

### User-authenticated (Admin/Manager)

- `GET /api/isapi/agents` — list agents with linked device count and pending ops
- `POST /api/isapi/agents` — create agent, returns one-time secret
- `GET /api/isapi/agents/:id` — agent details + configs + logs
- `PATCH /api/isapi/agents/:id` — update name/hostname/platform/version/status
- `DELETE /api/isapi/agents/:id` — soft-delete, unlink devices
- `POST /api/isapi/agents/:id/rotate-secret` — rotate secret
- `POST /api/isapi/agents/:id/installer` — generate PowerShell (.ps1) for Windows or shell (.sh) for Linux, contains new secret + installer key, 24h expiry

- `GET /api/isapi/device-configs` — list all ISAPI configs
- `POST /api/isapi/device-configs` — upsert config: deviceId, agentId, isapiHost, isapiPort, isapiUsername, isapiPassword (encrypted), protocol, syncEnabled
- `GET /api/isapi/device-configs/:deviceId` — config for one device
- `PATCH /api/isapi/device-configs/:id` — update
- `DELETE /api/isapi/device-configs/:id` — remove

- `GET /api/isapi/sync-logs?deviceId=&agentId=` — paginated logs

### Machine-authenticated (agent → Cloudflare)

- `POST /api/isapi/v1/agents/:id/heartbeat` — agent heartbeat, updates last_seen_at, last_ip, version
- `GET /api/isapi/v1/agents/:id/devices` — list devices assigned to agent
- `GET /api/isapi/v1/agents/:id/operations?limit=20` — poll pending operations (claims them as sent)
- `POST /api/isapi/v1/agents/:id/operations/:opId/result` — report applied/failed
- `POST /api/isapi/v1/agents/:id/sync-logs` — manual log entry

Legacy compatibility endpoints also available: `/api/isapi/v1/operations/:agentId`.

All machine endpoints accept:
- `X-EstateMate-Agent-Key: <secret>`
- `Authorization: Bearer <secret>`
- Basic auth with secret as password

## Frontend UI

New section **ISAPI Bridge & Windows Agent** (admin/manager only) in portal:

- **Register agent** form: name, hostname, platform, version → returns secret (shown once)
- **Link device to agent** form: select device (from `/api/access/device-options`), agent, ISAPI host (LAN IP), port, username, password, protocol, sync enabled
- **Registered agents** table: name, hostname, platform, status, last heartbeat, last IP, linked devices, pending ops. Actions: Download installer, Rotate secret, Delete.
- **Device configs** table: device, gate, connection pattern, ISAPI host/port/user/protocol, sync enabled, agent name/status, last sync, status, error. Action: Remove.
- **Sync logs** table: time, device, agent, operation type, status, message, duration.
- **Quick reference** panel with Windows installation steps.

Also updated **Access-control devices** form:
- Connection pattern now includes `isapi_bridge`, `windows_agent`, `isapi_windows_agent`.
- Table shows ISAPI agent name, ISAPI host, ISAPI sync status, queued ops.

## Windows agent implementation

- `isapi-bridge/agent.mjs` — cross-platform core agent (Node 22+). Polls operations, applies via ISAPI Digest, reports results.
- `windows-agent/agent.mjs` — Windows wrapper that loads core agent, checks config ACL, logs Windows-specific info.
- `windows-agent/install-windows.mjs` — Node installer that creates `C:\EstateMate\ISAPI-Agent\agent-config.json` with restricted ACL and example devices file.
- Installer generation in Worker: PowerShell script for Windows, shell script for Linux, both contain agentId, agentSecret, installerKey, workerUrl, and set restrictive permissions.

### Security

- Config file ACL: Administrators + SYSTEM only (PowerShell `icacls /inheritance:r /grant:r ...`).
- ISAPI password encrypted at rest with `STORAGE_ENCRYPTION_KEY` (AES-GCM via `encryptSecret`/`decryptSecret`).
- No ISAPI port forwarding to Internet — keep on VLAN.
- Agent secret hashed with `DEVICE_INGEST_PEPPER` + SHA256 (same as device secrets).
- Sync logs preserve audit trail, never log card UIDs in plaintext beyond debug.

## Connection pattern logic

Updated `isPendingPattern` to include:
- `hikvision_cloud_openapi`
- `offsite_isup_gateway`
- `isapi_bridge`
- `windows_agent`
- `isapi_windows_agent`

When device uses these patterns, `createDeviceOperations` and visitor creation set status `pending` (agent will poll) instead of `manual_action_required`.

## Testing locally

```bash
npm ci
npm run typecheck
npm test
npm run build:web
# Test migration chain
python3 - <<'PY'
import pathlib, sqlite3
con=sqlite3.connect(':memory:')
for migration in sorted(pathlib.Path('migrations').glob('*.sql')):
    con.executescript(migration.read_text())
print('migration chain OK')
PY
```

- Create agent via API, link device, run `node isapi-bridge/agent.mjs --config agent-config.json --devices isapi-devices.json` and verify operations flow.

## Production deployment

Push to `main` triggers GitHub Actions:
- `wrangler d1 migrations apply estatemate-db --remote` applies `0011_hikvision_isapi_sync.sql`
- `wrangler deploy` deploys Worker + web assets

Verify:
- `https://YOUR_DOMAIN/api/health` → ok
- Portal → ISAPI Bridge & Windows Agent → list agents (empty initially)
- Register test agent, check secret returned once
- Link device, download installer, install on Windows host

## Future improvements

- Full Person + Card + Access Group linking for models requiring it (`/ISAPI/AccessControl/UserInfo/Record`, `/ISAPI/AccessControl/UserRight/...`)
- Face template provisioning via ISAPI
- Bulk card sync status dashboard
- Agent binary releases (pkg/nexe) for estates without Node.js
