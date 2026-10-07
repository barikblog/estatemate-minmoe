# Hikvision ISAPI Bridge and Windows Agent

This document describes the new ISAPI bridge and Windows agent introduced in migration `0011_hikvision_isapi_sync.sql`.

## Problem

- **Direct HTTP Listening, the Render relay, Hikvision cloud/OpenAPI and the dedicated ISUP gateway were removed** (migration `0013_agent_only_transports.sql`); the agent is the only automatic transport.
- **Manual sync** requires an operator to apply each change in the device UI, then mark it applied in EstateMate.

Many estates already have a Windows PC (CCTV, accounting) on same LAN as devices. They need automatic card provisioning without buying Linux hardware or SDK.

## Solution: ISAPI Bridge + Windows Agent

The ISAPI bridge is a small Node.js agent that runs on the same LAN as Hikvision devices (Windows, Linux, macOS). It:

1. Polls Cloudflare Worker for pending operations:
   - `GET /api/isapi/v1/agents/:id/operations` — card upsert/enable/disable/delete, visitor upsert, **person** upsert/delete, **fingerprint** template upload/delete, **fingerprint capture**, door commands
   - The Worker hands out a kind only when the heartbeat advertises the matching capability (see *Capabilities* below). A pre-`0.3.0` bridge advertises nothing and keeps receiving cards, visitors and doors; person/fingerprint work is queued as `manual_action_required` operator tasks instead
   - A `capture_fingerprint` item is the one that carries the request only; an `upload_fingerprint` item carries the transient Base64 template (`fingerData`) for the claiming agent alone
   - Auth: `X-EstateMate-Agent-Key: <secret>` or `Authorization: Bearer <secret>`
2. Applies them via Hikvision ISAPI (HTTP Digest Auth) to the device:
   - `POST /ISAPI/AccessControl/CardInfo/Record?format=json` — add a resident/dependant card; visitors do not use `CardInfo`
   - `PUT /ISAPI/AccessControl/CardInfo/Modify?format=json` — when the terminal already holds that card number (a duplicate `Record` is an error, so a re-enable or re-issue falls through to `Modify`)
   - `PUT /ISAPI/AccessControl/CardInfo/Delete?format=json` — remove a resident/dependant card; the condition must be wrapped as `{"CardInfoDelCond":{"CardNoList":[{"cardNo":"…"}]}}`
   - `POST /ISAPI/AccessControl/UserInfo/Record?format=json`, `PUT …/UserInfo/Modify`, `PUT …/UserInfo/SetUp` — write a permanent resident/dependant person with `doorRight` + `RightPlan`, or a finite PIN-only visitor account containing only the terminal-editor fields
   - `PUT /ISAPI/AccessControl/UserInfoDetail/Delete?format=json` (fallback `PUT …/UserInfo/Delete`) — remove the person account; visitor expiry uses this without any separate card deletion
   - `POST /ISAPI/AccessControl/FingerPrint/SetUp?format=json` — write or delete one finger template (slot 1–10)
   - `POST /ISAPI/AccessControl/CaptureFingerPrint?format=json` — arm the terminal's own reader and read a live finger
   - `PUT /ISAPI/AccessControl/RemoteControl/door/{n}?format=json` — remote door command (model-dependent)
   - XML fallback: the same bodies with the ISAPI namespace (`xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0"`), tried **only** when the JSON URL itself is unsupported — never after a content rejection
3. Reports result:
   - `POST /api/isapi/v1/agents/:id/operations/:opId/result` with `{kind, status: applied|failed, errorMessage, durationMs, result?}` — a capture reports `result.templateData` (Base64), `result.fingerNo` and `result.quality`
4. Heartbeats:
   - `POST /api/isapi/v1/agents/:id/heartbeat` with version/hostname and `capabilities: ['card','door','person','fingerprint']`
5. Probes capabilities:
   - `GET /ISAPI/AccessControl/CaptureFingerPrint/capabilities` and `GET /ISAPI/AccessControl/FingerPrintCfg/capabilities` (JPEG/person equivalents where relevant) decide what is advertised. The probe is cached for **10 minutes** and refreshed in the background — it is never awaited by the heartbeat, because a terminal holding a long-lived alertStream can block the probe and stop the heartbeat with it

No SDK required — uses documented ISAPI endpoints available on most K1T, K26xx, K27xx/K28xx when accessed from LAN.

### Card identity guard

Card upsert and re-enable operations carry the holder's canonical EstateMate `employee_id`. New or changed IDs are limited to 30 alphanumeric characters by the Worker and migration `0024`; the terminal wire limit remains 32. Both bridges validate the supplied value before making a terminal request and retain compatibility for historical 31–32-character IDs already stored on hardware. A missing or unsafe value fails closed; the bridge never substitutes the resident's 36-character UUID or a guessed `1` (which could attach the card to another terminal person). ISAPI `ResponseStatus` fields are included in failure diagnostics so a terminal rejection such as `Invalid Content / badParameters / employeeNo` remains actionable. Regression coverage is in `isapi-bridge/agent.card-operations.integration.mjs` and the Android `ProtocolTest`.

### Card-number rule

Physical card numbers are text containing ASCII digits only; they are never parsed as integers or normalized, so leading zeroes survive. The manual form, scan completion, CSV import, API and database triggers enforce this on new cards, and both bridge implementations refuse nondigit card upserts/re-enables before sending an ISAPI write. Card labels remain free text. Deletion stays permissive so legacy nondigit card records can still be removed; a visitor is a PIN-only `UserInfo` account and is not a physical card.

When an operation fails, both bridges include the operation's failure reason in their local log as well as reporting it to the Worker. Non-card operations such as `upsert_visitor` log `card=n/a` rather than looking like a missing card.

### Terminal protocol the card path relies on

Recorded from the terminals these bridges were fixed against; the simulated terminals in both test suites enforce the same rules, so a regression fails the tests rather than the gate.

- **JSON is the format.** `CardInfo/Record`, `CardInfo/Modify` and `CardInfo/Delete` are JSON calls (`?format=json`, `Content-Type: application/json`). The XML form is a legacy fallback that is attempted **only** when the JSON URL itself is unsupported — a `404`/`405`/`501`, or a `ResponseStatus` saying `notSupport`, `invalidURL` or `invalidOperation`. Retrying a *content* rejection (`Invalid Content` / `badParameters` / `badJsonFormat`) as XML buries the terminal's real reason; the client reports it instead.
- **A 2xx is not proof.** Some firmware answers HTTP 200 with a `ResponseStatus` whose `statusCode` is not `1` (OK). That is a failure; success is `statusCode == 1` in the body when a body carries one.
- **Duplicate cards are an error.** `POST CardInfo/Record` for a card number the terminal already holds answers `cardNoAlreadyExist`. The bridge treats that as "update in place" and issues `PUT CardInfo/Modify` with the same `CardInfo` body, which is what makes a re-enabled or re-issued card work. If `Modify` answers `cardNoNotExist`, the card is genuinely absent and `Record`'s own reason is reported.
- **Delete conditions are wrapped.** `PUT CardInfo/Delete` accepts `{"CardInfoDelCond":{"CardNoList":[{"cardNo":"…"}]}}` — lower-case `cardNo` inside `CardInfoDelCond`. The bare `{"CardNoList":[{"CardNo":"…"}]}` shape answers `Invalid Format / badJsonFormat` and deletes nothing.
- **Already-absent records count as removed.** `cardNoNotExist`, `employeeNoNotExist`, `not exist` or `not found` on the corresponding delete is success (idempotent), but a terminal that does not implement the call at all (`notSupport`) is **not** — that is a real failure an operator must see.
- **Visitors are PIN-only `UserInfo` accounts.** Both Hikvision bridges send only issued employee number, name, `belongGroup: "Company"`, `userType: "normal"`, enabled finite validity stated in the estate's local time (`YYYY-MM-DDTHH:mm:ss`, `timeType: "local"`, no `Z` — the zone travels with the operation), `localUIRight: false`, and the 4-to-8-digit PIN as `password`. They send no `CardInfo`, fingerprint, face, `doorRight` or `RightPlan`, so the terminal UI keeps Card/Fingerprint as “Not added.” Revocation deletes the person account.
- **A visitor `Modify` is gated on the terminal's own answer.** `Modify` is attempted only when `Record` reports the employee number already exists (`employeeNoAlreadyExist`). Any other content rejection is reported with the terminal's own reason — a `Modify` follow-up would only answer `employeeNoNotExist` (the account was never created) and bury the real one. Both bridges follow the same rule.
- **PIN length fails closed.** Any PIN other than exactly 4–8 decimal digits is rejected before a terminal request. The Worker places the pass's stored PIN in initial and reconciled operations.
- **XML bodies carry the namespace**: `<CardInfo xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">`, likewise `<UserInfo>`, delete conditions and `<RemoteControlDoor>`.
- **Failures are summarised, not truncated.** The reason is read from the `ResponseStatus` fields (`statusString` / `subStatusCode` / `errorMsg`), from JSON or XML, and both attempts are shown when a fallback was legitimately tried — real rejections first, unsupported-URL answers only if there are no rejections.

### Person and fingerprint protocol the agent relies on

Grouped with the card rules above and enforced by the simulated terminal in
`isapi-bridge/agent.person-fingerprint.integration.mjs` (ten checks in `npm test`).

- **Permanent person before credential.** A resident/dependant card or finger names
  an ISAPI `employeeNo` that must already exist on the terminal. Record for an
  unknown person is refused, so the bridge writes that permanent person first and
  only then the card or template. EstateMate's canonical `employee_id` (new values ≤30 characters, migration `0024`) is that number. Historical values may remain up to the terminal's 32-character limit. Visitors are the PIN-only account
  exception above and have no card or fingerprint operation.
- **`doorRight` and `RightPlan` are mandatory for permanent people.** A permanent
  person stored without them exists on the terminal and is authorised for
  nothing. The resident/dependant path therefore sends both, with the terminal's
  door numbers (door 1 by default), plus `Valid` and `userType: normal`. The
  visitor payload deliberately mirrors its finite account editor and omits them.
- **`Record` is not idempotent.** A terminal that already holds the employee
  number answers a rejection; the bridge falls through to `UserInfo/Modify` and
  then `UserInfo/SetUp`, which is what makes a rename or a re-sync work.
- **Removal cascades.** `UserInfoDetail/Delete` removes the person **and** their
  cards, fingerprints and permissions. Firmware that does not implement it
  (`notSupport`/`invalidOperation`) is retried once as `UserInfo/Delete`, which
  removes the person record alone.
- **Fingerprint templates are one slot at a time.**
  `FingerPrint/SetUp` writes `{FingerPrintCfg:{employeeNo, fingerPrintID,
  fingerType:'normalFP', fingerData, enableCardReader:[1]}}`; deleting uses the
  same call with `deleteFingerPrint: true`, and firmware answers success even
  when the slot was already empty. The template is Base64 in the body — never in
  a URL, a log line or a portal response.
- **Capture is armed, not polled.**
  `CaptureFingerPrint` takes `{CaptureFingerPrintCond:{fingerNo}}` and returns the
  template once the finger is read; while nobody touches the glass the terminal
  answers "no fingerprint". The bridge re-arms every 5 s for up to ~100 s
  (`ESTATEMATE_CAPTURE_RETRY_MS` / `ESTATEMATE_CAPTURE_MAX_MS`) and keeps
  heartbeating in between, so the terminal does not decide the operator walked
  away. A firmware that refuses the call is reported in the terminal's own words
  and the portal keeps the manual enrolment task.
- **Capabilities gate the work, not the willingness.**
  `agentCan(device, capability)`: a device with no agent never takes automated
  work; an agent advertising nothing is legacy and takes `card`/`visitor`/`door`
  only; otherwise exactly what it advertises. Every fingerprint either reaches a
  terminal as a template or — where the template cannot be taken — becomes an
  `enroll_fingerprint` task naming the slot and the employee number. Nothing is
  silently dropped.

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

## Terminal clock sync (opt-in, migration 0021)

A terminal enforces everything time-sensitive with its own clock. A visitor's pass
is a finite `UserInfo` window: the terminal compares the swipe moment against
`beginTime`/`endTime` on its own hardware. Gate events carry the terminal's
timestamp, and Remote Network Verification decides against the bridge's clock.
A terminal hours off the estate therefore rejects a live visitor pass early,
honours a dead one late, and files its history at the wrong moment — none of it
visible from the database, because nothing was ever asking the terminal what
time it thought it was.

`"timeSync": { "enabled": true }` in `agent-config.json` (off by default) makes
the bridge, at startup and every `checkIntervalMinutes` (default 15):

1. **Read** the terminal's system time (`GET /ISAPI/System/time/Get`, JSON-first
   with the XML URL fallback like every other write).
2. **Measure** the offset against the bridge host's clock. The host is the
   reference on purpose: it sits on the estate LAN and is the clock every other
   decision on that LAN already trusts. If the host's own time is wrong, fix the
   host — this feature aligns the terminals with the estate, it does not make
   the estate right.
3. **Set** the clock back (`PUT /ISAPI/System/time/Set` with
   `timeType: "local"`) only when the offset exceeds `maxDriftMs` (default
   30 000 ms, minimum 5 000), then **re-read to confirm** — the Set answer is
   not proof the clock moved — and report the confirmed drift.
4. **Report** the per-terminal state (`terminalTime`, `driftMs`,
   `lastCheckedAt`, `lastSyncAt`, `syncs`, `lastError`) on the heartbeat.

The Worker stores the state on the device row (`hikvision_devices.device_clock`,
migration 0021) with the same scoping as every other heartbeat write: a device
that is not linked to the reporting agent is untouched, and a heartbeat without
a clock entry leaves the stored value alone — a bridge built before this feature
(or with it switched off) keeps the row exactly as it was. The portal's
**Access control devices** page shows it in the **Terminal clocks** section: the
time the terminal thinks it is, how far that is from the bridge, the last check
and the last sync. It is a status surface, never read back as an input to a
decision.

Two assumptions are operational, not technical, and are enforced by convention:
the bridge host's clock is correct, and each terminal's timezone matches the
host's. The sync aligns wall clocks; a terminal in a different timezone shows up
as a constant offset in the portal and belongs re-zoned at the terminal. A failed
read keeps the last good reading plus the error, so a terminal that just went
down never erases the last known clock from the portal.

The switch itself is an estate decision with one meaning everywhere: the Windows
dashboard's **Configuration** tab has a **Terminal clock sync** checkbox, the
interactive `setup` wizard asks, and the CLI accepts `--time-sync-enabled=true|false`.
All three reach `agent-config.json` through the single writer (`setup`), which
preserves the `maxDriftMs` / `checkIntervalMinutes` thresholds the configuration
already had; a fresh setup defaults to off.

**Android deviation, recorded:** the Android bridge does not run the clock check
(see `bridge-apps/android/README.md`). A terminal served only by an Android
bridge never reports a clock, and the portal shows "no report yet" for it — the
same recorded-deviation treatment the LAN event listener has.

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

Migration `0019_person_sync_and_fingerprint_capture.sql` adds the person half:

- `device_operations` rebuilt once more to carry `user_id`, `household_member_id`,
  `capture_id` and `result_json`, with the operation CHECK widened for
  `upsert_person`, `delete_person`, `upload_fingerprint`,
  `delete_fingerprint_device` and `capture_fingerprint`.
- `isapi_agents.capabilities` — what each bridge advertised on its last probe.
- `fingerprint_captures` — `pending|captured|failed|cancelled|expired`, the
  Base64 `template_data`, `expires_at` (180 s to distribute it, 86 400 s hard
  cap) and the person/finger/employee the capture belongs to.
- `device_person_state` — synced/pending/missing/manual/removed, one row per
  person and terminal, derived by `refreshDevicePersonState` from the operation
  rows rather than asserted per operation.

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
- `GET /api/isapi/v1/agents/:id/operations?limit=20` — poll pending operations (claims them as sent). Items are `card`, `visitor`, `person`, `fingerprint` and `door` kinds; a `fingerprint` item is either `upload_fingerprint` (carrying the transient `fingerData` for this agent only), `delete_fingerprint_device` or `capture_fingerprint` (carrying `fingerNo`). Only kinds the heartbeat's `capabilities` allow are returned
- `POST /api/isapi/v1/agents/:id/operations/:opId/result` — report applied/failed; a capture result may carry `{result:{templateData, fingerNo, quality}}`, which the Worker stores as the credential's template
- `POST /api/isapi/v1/agents/:id/heartbeat` — (listed above) now also carries `capabilities`
- `POST /api/isapi/v1/agents/:id/sync-logs` — manual log entry
- `POST /api/isapi/v1/agents/:id/events` — **batched real-time event documents** captured from the device's ISAPI alertStream. Body `{ items: [{ deviceId, contentType?, document }] }`, max 50 items / 2 MB per request. Each document (JSON or XML string) goes through the same normalization pipeline as direct device posts; the whole batch is queued as one Queue message. Guarded by the `agent_event_stream_enabled` setting (`409` when disabled). Devices must be linked to the calling agent (`hikvision_devices.isapi_agent_id` or `isapi_device_configs`).

Legacy compatibility endpoints also available: `/api/isapi/v1/operations/:agentId`.

All machine endpoints accept:
- `X-EstateMate-Agent-Key: <secret>`
- `Authorization: Bearer <secret>`
- Basic auth with secret as password

## Frontend UI

New section **Person sync** (admin/manager/security read; sync and removal are
admin/manager) in portal:

- **Totals strip** — people, terminals, in step, waiting, manual, missing.
- **Terminal cards** — one per terminal with the agent gate, advertised
  capabilities and the synced/pending/manual/missing counts.
- **People table** — every person with their state on each terminal, *Sync now*
  (one person or the whole estate, optionally with credentials) and **Remove from
  devices** (person + credentials, or the whole terminal copy).
- **Fingerprint capture** is started from the person's **Cards & fingerprints**
  panel or from the Cards page: choose the terminal, choose the finger slot, and
  the panel reports *waiting for a finger*, *captured*, the terminal's refusal
  text, and where the template was sent.

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

The agent now covers the event half of the problem as well as the command half (the
capability-probed person/fingerprint half arrived with bridge `0.3.0`; the two
releases are independent — streaming needs no capability and is always on). One persistent
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

- Access-group / door-right *API* provisioning (`/ISAPI/AccessControl/UserRight/...`) beyond the `doorRight`/`RightPlan` fields the person body already carries
- Face template provisioning via ISAPI
- Card/fingerprint read-back (`FingerPrintUpload` and `CardInfo/Search`) to prove a template is really on a terminal instead of trusting the apply result
- Bulk card sync status dashboard
- Agent binary releases (pkg/nexe) for estates without Node.js
