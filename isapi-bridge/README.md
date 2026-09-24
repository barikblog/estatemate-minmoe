# EstateMate Hikvision ISAPI Bridge

The ISAPI bridge is a small Node.js agent that runs on the same LAN as Hikvision access devices. It polls the Cloudflare Worker for pending card/visitor operations (created when facility fees expire, cards are issued, etc.) and applies them to the physical device via Hikvision ISAPI (HTTP Digest).

It is an alternative to:
- **Direct HTTP Listening** (event upload only, no command return path)
- **Dedicated ISUP gateway** (requires official Hikvision SDK, Linux appliance)
- **Manual sync** (operator applies from hardware-action queue)

ISAPI bridge uses the device's documented ISAPI endpoints (`/ISAPI/AccessControl/CardInfo/...`) which are available on most K1T, K26xx, K27xx/K28xx controllers when accessed from the LAN. It does **not** require the proprietary SDK.

> **Security:** Keep ISAPI devices and this bridge on the same VLAN. Never expose ISAPI (port 80/443) to the Internet. The bridge config contains secrets — restrict file permissions to Administrators / 0600.

## Architecture

```
Cloudflare Worker (D1, Queue)
  ├── POST /api/isapi/v1/agents/:id/heartbeat
  ├── GET  /api/isapi/v1/agents/:id/operations  (pending card/visitor ops)
  └── POST /api/isapi/v1/agents/:id/operations/:opId/result

ISAPI Bridge Agent (Node.js, LAN)
  ├── polls operations every 30s
  ├── applies via ISAPI Digest to device (http://device-ip/ISAPI/...)
  └── reports applied/failed + sync logs

Hikvision Device (LAN)
  └── ISAPI: /ISAPI/AccessControl/CardInfo/Record, Delete, etc.
```

## Setup

### 1. Register agent in EstateMate portal

1. Sign in as Administrator → **ISAPI Bridge & Windows Agent** (new section) → **Register agent**.
2. Enter name (e.g., "Estate Office Windows PC"), platform (windows/linux), hostname.
3. Copy the one-time secret and agent ID.
4. Click **Download installer** to get a PowerShell (Windows) or shell (Linux) script that contains the secret and writes the config.

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
- For systemd, create a service similar to `isup-gateway/estatemate-isup-adapter.service`.

### 3. Link devices to agent

In portal → **ISAPI Bridge & Windows Agent** → **Device ISAPI Configs** → **Link device**:

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
- **No operations**: Device not linked to agent, or connection pattern still `manual_sync` / `direct_http_listener`. Change to `isapi_bridge` / `windows_agent`.
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
