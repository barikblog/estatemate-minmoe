# EstateMate Hikvision ISAPI Bridge

The ISAPI bridge is a small Node.js agent that runs on the same LAN as Hikvision access devices. It does two things, both over ordinary outbound HTTPS to the Cloudflare Worker:

1. **Applies card/visitor operations** — polls the Worker for pending card/visitor operations (created when facility fees expire, cards are issued, etc.) and applies them to the physical device via Hikvision ISAPI (HTTP Digest).
2. **Streams real-time access events** — holds one persistent `GET /ISAPI/Event/notification/alertStream` connection per device and forwards every swipe/alarm to the Worker in small batches, giving Gate activity latency of a few seconds without relying on the terminal's HTTP Listening push.

It replaced and removed the former transports — direct HTTP Listening, the Render free relay, Hikvision cloud/OpenAPI and the dedicated ISUP SDK gateway (migration `0013_agent_only_transports.sql`). `manual_sync` remains as the auditable fallback for devices not linked to an agent.

ISAPI bridge uses the device's documented ISAPI endpoints (`/ISAPI/AccessControl/CardInfo/...`, `/ISAPI/Event/notification/alertStream`) which are available on most K1T, K26xx, K27xx/K28xx controllers when accessed from the LAN. It does **not** require the proprietary SDK.

For off-site support access to the terminals and this host, see [`../docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](../docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md): a Cloudflare Tunnel on the Zero Trust Free plan routes the estate LAN to enrolled admins over WARP, publishing nothing. The agent never uses that tunnel, and an access device cannot dial into one.

> **Security:** Keep ISAPI devices and this bridge on the same VLAN. Never expose ISAPI (port 80/443) to the Internet. The bridge config contains secrets — restrict file permissions to Administrators / 0600.

## Architecture

```
Cloudflare Worker (D1, Queue)
  ├── POST /api/isapi/v1/agents/:id/heartbeat
  ├── GET  /api/isapi/v1/agents/:id/operations  (pending card/visitor ops)
  ├── POST /api/isapi/v1/agents/:id/operations/:opId/result
  └── POST /api/isapi/v1/agents/:id/events      (batched alertStream events)

ISAPI Bridge Agent (Node.js, LAN)
  ├── polls operations every 30s
  ├── applies via ISAPI Digest to device (http://device-ip/ISAPI/...)
  ├── holds GET /ISAPI/Event/notification/alertStream per device (real-time)
  ├── buffers events; flushes up to 50 per request or every 5s
  └── reports applied/failed + sync logs

Hikvision Device (LAN)
  ├── ISAPI: /ISAPI/AccessControl/CardInfo/Record, Delete, etc.
  └── ISAPI: /ISAPI/Event/notification/alertStream (persistent event stream)
```

## Real-time event streaming

Event streaming is **enabled by default** for every enabled device in `isapi-devices.json`. Disable globally with `"eventStream": false` in `agent-config.json`, or per device in the devices file. The portal can also kill it server-side: **Settings → `agent_event_stream_enabled` = `false`** (the Worker then answers `409` and the agent keeps buffering with backoff).

How it works:

- The agent answers the device's Digest (or Basic) challenge once, then keeps the alertStream connection open.
- Events arrive as `multipart/mixed` parts (JSON or XML documents). Firmware that streams bare JSON objects is handled by a brace-depth scanner fallback.
- Documents are buffered and flushed to `POST /api/isapi/v1/agents/:id/events` — up to 50 items per request, or every `eventFlushSeconds` (default 5 s), whichever comes first. The Worker normalizes each document with the same pipeline as direct device posts (profile aliases, granted/denied inference, idempotency on `(device_id, vendor_event_id)`), updates device last-seen, and queues the batch as **one** Queue message so the Cloudflare Workers Free plan Queues allowance (10,000 operations/day ≈ one message ≈ 3 operations) is preserved even on busy estates.
- On connection loss the agent reconnects with 5 s → 60 s exponential backoff. A local buffer (default 500 events) rides out Worker outages; on overflow the oldest documents are dropped with a warning.
- Each stream loop's state travels with the heartbeat (`devices: [{ deviceId, stream: 'up'|'down', lastError }]`). The Worker marks the terminal **online** as soon as the stream is `up` — so a linked terminal no longer sits on the `pending` registration default until someone happens to swipe a card — and marks it **offline** immediately on `down`, without waiting for the hourly sweep.

Config knobs (`agent-config.json`):

| Key | Default | Meaning |
|---|---|---|
| `eventStream` | `true` | Master switch for event streaming |
| `eventFlushCount` | `25` | Buffer size that triggers an immediate flush (max 50) |
| `eventFlushSeconds` | `5` | Maximum seconds an event waits in the buffer |
| `eventBufferLimit` | `500` | Local buffer cap before oldest events are dropped |
| `alertStreamPath` | `/ISAPI/Event/notification/alertStream?format=json` | Override for unusual firmware |

Per-device `"eventStream": false` in `isapi-devices.json` disables streaming for that terminal only.


## Setup

### 1. Register agent in EstateMate portal

1. Sign in as Administrator → **Device agent** → **Add agent**.
2. Enter name (e.g., "Estate Office Windows PC"), platform (windows/linux), hostname.
3. Copy the one-time secret and agent ID.
4. Click **Download setup** to get a PowerShell (Windows) or shell (Linux) script that contains the secret and writes the config.

### 2. Install on Windows (recommended) or Linux

#### Windows

- Run the downloaded `.ps1` as Administrator (it creates `C:\EstateMate\ISAPI-Agent\agent-config.json` with restricted ACL).
- Edit `C:\EstateMate\ISAPI-Agent\isapi-devices.json` with your device LAN IPs and ISAPI credentials (admin / device password).
- Download the agent binary (this repo's `agent.mjs` or a compiled executable) to `C:\EstateMate\ISAPI-Agent\estatemate-isapi-agent.exe`.
- Install as service:
  ```powershell
  sc.exe create EstateMateISAPIAgent binPath= "C:\EstateMate\ISAPI-Agent\estatemate-isapi-agent.exe --config C:\EstateMate\ISAPI-Agent\agent-config.json" start= auto
  sc.exe description EstateMateISAPIAgent "EstateMate ISAPI Bridge - Syncs access cards via ISAPI"
  sc.exe start EstateMateISAPIAgent
  ```

#### Linux / macOS

- Run the downloaded `.sh` script (creates `/opt/estatemate/isapi-agent/agent-config.json` 0600).
- Edit `/opt/estatemate/isapi-agent/isapi-devices.json`.
- `npm install` (Node 22+) and run `node agent.mjs --config /opt/estatemate/isapi-agent/agent-config.json`.
- For systemd, create a small unit that runs `node agent.mjs --config /opt/estatemate/isapi-agent/agent-config.json` with `Restart=always`.

### 3. Link devices to agent

In portal → **Device agent** → **Connected terminals** (use **Connect terminal** to add one):

- Select Hikvision device (must have connection pattern `isapi_bridge`, `windows_agent`, or `isapi_windows_agent`).
- Select agent.
- Enter ISAPI host (LAN IP, e.g., 192.168.1.100), port (80), username (admin), password (device admin password), protocol (http/https).
- Enable sync.

Or use **Access-control devices** → edit device → set connection pattern to `isapi_bridge` and then link.

### 4. Test

- Issue a test card in portal → **Access cards** → create.
- Check **Hardware actions** — status should be `pending` (not `manual_action_required`) when device uses ISAPI pattern.
- On agent host, check logs: `C:\EstateMate\ISAPI-Agent\logs\` or journalctl.
- After ~30s, operation should be claimed and applied via ISAPI, then status becomes `applied`.
- Verify on device web UI: Access Control → Card Management → card exists.

### 5. ISAPI endpoint reference (model dependent)

- `POST /ISAPI/AccessControl/CardInfo/Record?format=json` — add/update card
- `PUT /ISAPI/AccessControl/CardInfo/Delete?format=json` — delete card
- `GET /ISAPI/AccessControl/CardInfo/Record?format=json` — list cards
- Some firmware uses XML: `/ISAPI/AccessControl/CardInfo/Record` with `Content-Type: application/xml`.

Test manually:
```bash
curl -i http://192.168.1.100/ISAPI/System/deviceInfo --digest -u admin:password
```

## Troubleshooting

- **401 Unauthorized**: Check ISAPI username/password, device allows digest auth, IP not blocked.
- **No operations**: Device not linked to agent, or connection pattern still `manual_sync`. Set it to `isapi_bridge` / `windows_agent` and link it.
- **Operation stuck in sent**: Agent not reporting result. Check agent logs, network to Cloudflare, secret.
- **Card not opening door**: Card added but not assigned to access group / door. Some models require separate Person + Card + Access Group linking. This bridge currently does simple card add; for full person management, extend `applyCardOperation` to create Person first (`/ISAPI/AccessControl/UserInfo/Record`).

## Extending for full Person/Access Group

Hikvision's newer ISAPI requires:
1. Create Person (`/ISAPI/AccessControl/UserInfo/Record` with employeeNo)
2. Create Card linked to Person (`/ISAPI/AccessControl/CardInfo/Record`)
3. Assign to Access Group / Door (`/ISAPI/AccessControl/UserRight/...`)

Update `agent.mjs` `applyCardOperation` to implement those steps for your firmware.

## License

MIT. Ensure compliance with Hikvision ISAPI usage and local data-protection laws.
