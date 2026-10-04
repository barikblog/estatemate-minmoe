# Hikvision ISAPI Bridge and Windows Agent

This document describes the new ISAPI bridge and Windows agent introduced in migration `0011_hikvision_isapi_sync.sql`.

## Problem

- **Direct HTTP Listening, the Render relay, Hikvision cloud/OpenAPI and the dedicated ISUP gateway were removed** (migration `0013_agent_only_transports.sql`); the agent is the only automatic transport.
- **Manual sync** requires an operator to apply each change in the device UI, then mark it applied in EstateMate.

Many estates already have a Windows PC (CCTV, accounting) on same LAN as devices. They need automatic card provisioning without buying Linux hardware or SDK.

## Solution: ISAPI Bridge + Windows Agent

The ISAPI bridge is a small Node.js agent that runs on the same LAN as Hikvision devices (Windows, Linux, macOS). It:

1. Polls Cloudflare Worker for pending operations:
   - `GET /api/isapi/v1/agents/:id/operations` — card upsert/enable/disable/delete, visitor upsert. Fingerprint operations are **not** in this list: a finger is captured on the terminal, so they are queued as `manual_action_required` operator tasks instead (migration `0015`)
   - Auth: `X-EstateMate-Agent-Key: <secret>` or `Authorization: Bearer <secret>`
2. Applies them via Hikvision ISAPI (HTTP Digest Auth) to the device:
   - `POST /ISAPI/AccessControl/CardInfo/Record?format=json` — add a card
   - `PUT /ISAPI/AccessControl/CardInfo/Modify?format=json` — when the terminal already holds that card number (a duplicate `Record` is an error, so a re-enable or re-issue falls through to `Modify`)
   - `PUT /ISAPI/AccessControl/CardInfo/Delete?format=json` — remove a card; the condition must be wrapped as `{"CardInfoDelCond":{"CardNoList":[{"cardNo":"…"}]}}`
   - `PUT /ISAPI/AccessControl/RemoteControl/door/{n}?format=json` — remote door command (model-dependent)
   - XML fallback: the same bodies with the ISAPI namespace (`xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0"`), tried **only** when the JSON URL itself is unsupported — never after a content rejection
3. Reports result:
   - `POST /api/isapi/v1/agents/:id/operations/:opId/result` with `{kind, status: applied|failed, errorMessage, durationMs}`
4. Heartbeats:
   - `POST /api/isapi/v1/agents/:id/heartbeat` with version/hostname

No SDK required — uses documented ISAPI endpoints available on most K1T, K26xx, K27xx/K28xx when accessed from LAN.

### Card identity guard

Card upsert and re-enable operations must carry the holder's canonical EstateMate `employee_id`, which is bounded to 32 characters by migration `0018` and the terminal's ISAPI limit. Both the Node and Android bridge validate it before making a terminal request. A missing or unsafe value fails closed; the bridge never substitutes the resident's 36-character UUID or a guessed `1` (which could attach the card to another terminal person). ISAPI `ResponseStatus` fields are included in failure diagnostics so a terminal rejection such as `Invalid Content / badParameters / employeeNo` remains actionable. Regression coverage is in `isapi-bridge/agent.card-operations.integration.mjs` and the Android `ProtocolTest`.

### Terminal protocol the card path relies on

Recorded from the terminals these bridges were fixed against; the simulated terminals in both test suites enforce the same rules, so a regression fails the tests rather than the gate.

- **JSON is the format.** `CardInfo/Record`, `CardInfo/Modify` and `CardInfo/Delete` are JSON calls (`?format=json`, `Content-Type: application/json`). The XML form is a legacy fallback that is attempted **only** when the JSON URL itself is unsupported — a `404`/`405`/`501`, or a `ResponseStatus` saying `notSupport`, `invalidURL` or `invalidOperation`. Retrying a *content* rejection (`Invalid Content` / `badParameters` / `badJsonFormat`) as XML buries the terminal's real reason; the client reports it instead.
- **A 2xx is not proof.** Some firmware answers HTTP 200 with a `ResponseStatus` whose `statusCode` is not `1` (OK). That is a failure; success is `statusCode == 1` in the body when a body carries one.
- **Duplicate cards are an error.** `POST CardInfo/Record` for a card number the terminal already holds answers `cardNoAlreadyExist`. The bridge treats that as "update in place" and issues `PUT CardInfo/Modify` with the same `CardInfo` body, which is what makes a re-enabled or re-issued card work. If `Modify` answers `cardNoNotExist`, the card is genuinely absent and `Record`'s own reason is reported.
- **Delete conditions are wrapped.** `PUT CardInfo/Delete` accepts `{"CardInfoDelCond":{"CardNoList":[{"cardNo":"…"}]}}` — lower-case `cardNo` inside `CardInfoDelCond`. The bare `{"CardNoList":[{"CardNo":"…"}]}` shape answers `Invalid Format / badJsonFormat` and deletes nothing.
- **Already-absent cards count as removed.** `cardNoNotExist` / `not exist` / `not found` on a delete is success (idempotent), but a terminal that does not implement the call at all (`notSupport`) is **not** — that is a real failure an operator must see.
- **`tempCard` is not a valid card type.** Visitor credentials are written as `normalCard` under the visitor's issued employee number (`visitor-<credential>` only when no employee number was issued and it passes the 32-byte person-ID check). The old `tempCard` XML write was rejected by the terminals.
- **XML bodies carry the namespace**: `<CardInfo xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">`, likewise `<CardInfoDelCond>` and `<RemoteControlDoor>`.
- **Failures are summarised, not truncated.** The reason is read from the `ResponseStatus` fields (`statusString` / `subStatusCode` / `errorMsg`), from JSON or XML, and both attempts are shown when a fallback was legitimately tried — real rejections first, unsupported-URL answers only if there are no rejections.

### Event-stream protocol the agent relies on

Recorded from the terminals and from Hikvision's *Intelligent Security API (General Application) Developer Guide*; the streaming integration checks enforce it, so a regression fails the tests.

- **One persistent GET per terminal.** `GET /ISAPI/Event/notification/alertStream` — the guide (ch. 12.1, endpoint reference §15.3.4) has the device hold the connection open and upload every alarm/event on it. Both bridges answer the Digest challenge once and keep reading; on loss they reconnect with backoff (5 s → 60 s), which is the guide's own instruction ("If the heartbeat receiving timed out or network disconnected, perform the above step repeatedly until reconnected").
- **Framing.** `Content-Type: multipart/mixed; boundary=<frontier>`, one document per part, and each part's `Content-Type` may be `application/xml` **or** `application/json`. Firmware that streams bare JSON objects with no envelope is handled by the brace-depth scanner.
- **The heartbeat is not an event.** The stream carries the keep-alive heartbeat between events: `eventType` **videoloss** with `eventState` **inactive** (a subscription heartbeat is `heartBeat`/`active`). The guide's cadence is ~10 s with a 30 s timeout. A heartbeat counts as stream activity — the agent warns (log only) when a *connected* stream goes silent for 90 s, three windows, because a half-open TCP socket looks alive while the terminal has stopped streaming — and is never forwarded as a gate event. The Worker drops it defensively too, so an older deployed agent cannot file a bogus `videoloss` entry. A real video-loss alarm is `videoloss`/`active` and is kept.
- **ResponseStatus** (appendix A.3): `statusCode` 1 OK, 2 Device Busy, 3 Device Error, 4 Invalid Operation, 5 Invalid Message Format, 6 Invalid Message Content, 7 Reboot Required (9 = Additional Error with a per-item `AdditionalErr.StatusList`). Success is `statusCode == 1` — what `isapiOk`/`accepted` check. The sub-status code names the cause: `notSupport` 0x40000001, `methodNotAllowed` 0x40000004, `invalidOperation` 0x40000006, `badXmlFormat` 0x50000001, `badParameters` 0x60000001, `badXmlContent` 0x60000003.
- **Authentication.** Digest per RFC 2617 with `qop` undefined or `auth`; the first request is deliberately unauthenticated so the terminal issues the challenge, exactly as the guide's example shows (401 + `WWW-Authenticate: Digest …`, then the authenticated request). A 401 that reissues a challenge (stale nonce) is answered **once** more; a 401 without a fresh Digest challenge is an authentication failure and is never repeated blindly, because the guide locks the account once the remaining attempts reach 0. `XML_ResponseStatus_AuthenticationFailed` carries `lockStatus`, `retryTimes` (remaining attempts) and `resLockTime`, which the failure summary reports so an operator sees a lockout forming.
- **Formats.** XML requires the namespace `xmlns="http://www.isapi.org/ver20/XMLSchema"` (older authentication documents use the `std-cgi` namespace, so parsing is namespace-agnostic); JSON uses lower camel case for leaf nodes and upper camel case for containers — the naming rule behind `CardInfoDelCond.CardNoList[].cardNo`. Query JSON with `?format=json`, content type `application/json`; XML as `application/xml; charset="UTF-8"`.
- **Listening mode is documented but unused.** The guide's `/ISAPI/Event/notification/httpHosts` (ch. 12.2) is device→platform push, which EstateMate retired in migration `0013`; the agent is the only transport (see `AGENTS.md`). Do not reintroduce it.

## Presence: how online/offline is decided

- **Agent** — online while it heartbeats; offline after **3 minutes** without one (3 missed default heartbeats).
- **Terminal** — goes **online** as soon as the agent reports its alertStream as `up` (proof the agent authenticated to the terminal and the terminal is streaming) or when the terminal forwards an event, whichever comes first. It reads offline after **10 minutes** with neither, or **immediately** when its agent reports the alertStream as `down` (unreachable, auth failure, stream closed) or when the agent shuts down.
- Every read derives the status from those windows — the stored `status` column is only a cache the hourly cron refreshes, so the portal can never show a stale green. A row with a NULL `last_seen_at` has never proved it was alive and reads as offline.
- A freshly registered terminal shows the schema default **`pending`** until a bridge reports its stream `up` (or an event arrives for it). A terminal that was never proven alive and whose stream is reported `down` is retired to `offline` rather than left on `pending`, so a broken gate is never mistaken for "not seen yet". Link the terminal to an agent, and run a bridge with event streaming enabled, for either transition to happen.
- Deleting an agent, or disconnecting a terminal from one, retires the affected terminals at once.

A healthy agent host can still be holding a dead terminal, which is why per-terminal stream state travels with the heartbeat: the estate PC staying up never keeps an unreachable gate looking online.

## Reaching the estate from off-site

The agent needs no inbound access, but administrators and installers sometimes do.
[`CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md) covers the
Cloudflare Tunnel kit (Zero Trust Free plan) that publishes the estate LAN to
enrolled admins over WARP private-network routing — no public hostname, no DNS
record. It carries human access only: events and card operations stay agent-side, so
gate operation never depends on the tunnel. A device cannot dial into a free tunnel,
which is why ISUP is not a supported transport.

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

- `POST /api/isapi/v1/agents/:id/heartbeat` — agent heartbeat, updates last_seen_at, last_ip, version. Body may include `devices: [{ deviceId, stream: 'up'|'down', lastError? }]`; a `down` entry retires that terminal immediately (and writes one `event_stream` sync log per transition) instead of waiting for the hourly sweep. The agent sends this on every heartbeat and again while shutting down.
- `GET /api/isapi/v1/agents/:id/devices` — list devices assigned to agent
- `GET /api/isapi/v1/agents/:id/operations?limit=20` — poll pending operations (claims them as sent)
- `POST /api/isapi/v1/agents/:id/operations/:opId/result` — report applied/failed
- `POST /api/isapi/v1/agents/:id/sync-logs` — manual log entry
- `POST /api/isapi/v1/agents/:id/events` — **batched real-time event documents** captured from the device's ISAPI alertStream. Body `{ items: [{ deviceId, contentType?, document }] }`, max 50 items / 2 MB per request. Each document (JSON or XML string) goes through the same normalization pipeline as direct device posts; the whole batch is queued as one Queue message. Guarded by the `agent_event_stream_enabled` setting (`409` when disabled). Devices must be linked to the calling agent (`hikvision_devices.isapi_agent_id` or `isapi_device_configs`).

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

## Real-time event streaming (agent 1.1.0)

The agent now covers the event half of the problem as well as the command half. One persistent
`GET /ISAPI/Event/notification/alertStream?format=json` connection is held per device; documents
are buffered client-side and flushed as batched `POST /api/isapi/v1/agents/:id/events` requests
(up to 50 items, or every 5 s). This is an **event-upload** path like HTTP Listening — it carries
no commands — but it keeps Gate activity real-time (seconds, not polling intervals) on terminals
whose firmware lacks HTTP Listening push, which is why the DS-K1T808MFWX-B
(see [`device-profiles/DS-K1T808MFWX-B.md`](device-profiles/DS-K1T808MFWX-B.md)) can run fully
automatic with only this agent on the LAN.

Free-tier behaviour:

- One batch = one Queue message = ~3 Queue operations (Workers Free: 10,000/day). At a busy
  3,000 events/day this is roughly 200–600 operations/day, well inside the allowance.
- The hourly cron prunes `access_events` and `isapi_sync_logs` older than
  `access_event_retention_days` (default 365, minimum 30) in indexed 500-row batches to stay
  inside the 500 MB free D1 limit.
- The consumer accepts both single-event messages and `{ batch: [...] }` messages, and a
  live-feed Durable Object outage no longer requeues persisted events.

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
