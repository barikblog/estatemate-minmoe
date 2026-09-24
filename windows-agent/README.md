# EstateMate Windows ISAPI Agent

This is the **Windows Service** implementation of the Hikvision ISAPI Bridge. It is designed to run on a Windows PC or Windows Server on the same LAN as Hikvision access-control devices.

- Polls Cloudflare Worker (`/api/isapi/v1/agents/:id/operations`) for pending card/visitor operations.
- Applies them via Hikvision ISAPI (HTTP Digest) to devices on LAN.
- Reports results and heartbeats.
- Runs as Windows Service (`EstateMateISAPIAgent`) with auto-restart.

It reuses the core logic from `../isapi-bridge/agent.mjs` but adds Windows-specific service installation, restricted ACL config, Event Log integration, and PowerShell installer generation.

## Why Windows agent?

Many estates already have a Windows PC for CCTV (iVMS-4200) or accounting. This agent allows them to:

- Avoid buying a Linux appliance for ISUP SDK.
- Use existing Windows machine as ISAPI bridge.
- Keep ISAPI traffic on LAN (no port forwarding).
- Get automatic card disable/enable when facility fees expire.

## Quick start (Administrator)

1. **Portal:** Register agent in EstateMate → **ISAPI Bridge & Windows Agent** → **Register agent** → platform `windows` → copy secret → **Download installer** (`.ps1`).

2. **Windows host (as Administrator):**
   ```powershell
   # Run downloaded installer, e.g.:
   powershell -ExecutionPolicy Bypass -File .\estatemate-isapi-agent-xxxx.ps1
   # It creates C:\EstateMate\ISAPI-Agent\agent-config.json (restricted) and example isapi-devices.json
   ```

3. **Edit device mapping:**
   ```powershell
   notepad C:\EstateMate\ISAPI-Agent\isapi-devices.json
   # Fill estateMateDeviceId (from portal device list), isapiHost (192.168.1.x), isapiUsername, isapiPassword
   ```

4. **Install service:**
   ```powershell
   cd C:\EstateMate\ISAPI-Agent
   # Option A: using sc.exe (built-in)
   sc.exe create EstateMateISAPIAgent binPath= "C:\Program Files\nodejs\node.exe C:\EstateMate\ISAPI-Agent\agent.mjs --config C:\EstateMate\ISAPI-Agent\agent-config.json" start= auto
   sc.exe description EstateMateISAPIAgent "EstateMate ISAPI Bridge - Syncs access cards via ISAPI"
   sc.exe start EstateMateISAPIAgent

   # Option B: using NSSM (if installed)
   nssm install EstateMateISAPIAgent "C:\Program Files\nodejs\node.exe" "C:\EstateMate\ISAPI-Agent\agent.mjs --config C:\EstateMate\ISAPI-Agent\agent-config.json"
   nssm set EstateMateISAPIAgent AppDirectory C:\EstateMate\ISAPI-Agent
   nssm set EstateMateISAPIAgent Start SERVICE_AUTO_START
   nssm start EstateMateISAPIAgent
   ```

5. **Verify:**
   ```powershell
   Get-Service EstateMateISAPIAgent
   Get-Content C:\EstateMate\ISAPI-Agent\logs\agent.log -Tail 50
   # Or check portal: ISAPI Bridge → agent should show online, last_seen recent
   ```

## Configuration files

- `C:\EstateMate\ISAPI-Agent\agent-config.json` (0600 equivalent ACL - Administrators + SYSTEM only):
  ```json
  {
    "agentId": "uuid-from-portal",
    "agentSecret": "one-time-secret",
    "workerUrl": "https://estatemate.estatemate.workers.dev",
    "syncIntervalSeconds": 30,
    "heartbeatIntervalSeconds": 60
  }
  ```

- `C:\EstateMate\ISAPI-Agent\isapi-devices.json`:
  ```json
  {
    "devices": [
      {
        "estateMateDeviceId": "device-uuid",
        "name": "Main Gate",
        "isapiHost": "192.168.1.100",
        "isapiPort": 80,
        "isapiUsername": "admin",
        "isapiPassword": "device-password",
        "protocol": "http"
      }
    ]
  }
  ```

## Security checklist

- [ ] Config file ACL restricted (installer does this).
- [ ] ISAPI devices on same VLAN, no Internet port forwarding.
- [ ] Windows Firewall allows agent outbound HTTPS to Cloudflare, but blocks inbound.
- [ ] Device admin password is strong and not reused.
- [ ] Agent secret rotated periodically via portal.
- [ ] Logs do not contain card UIDs in plaintext (debug only).

## Troubleshooting

- **Service fails to start:** Check `agent-config.json` exists and is valid JSON, Node.js installed, path correct.
- **401 from Cloudflare:** Secret mismatch. Rotate secret in portal and re-run installer.
- **401 from Hikvision device:** Wrong ISAPI username/password, or digest auth disabled. Test with curl: `curl --digest -u admin:pass http://192.168.1.100/ISAPI/System/deviceInfo`.
- **Operations stuck pending:** Agent not polling. Check service running, internet to Cloudflare, agent linked to device in portal.
- **Card added but door not opening:** Need to assign card to access group / door. Extend agent to create Person + Card + UserRight.

## Development

The Windows agent shares core with `isapi-bridge/agent.mjs`. To run in foreground for debugging:

```powershell
node agent.mjs --config C:\EstateMate\ISAPI-Agent\agent-config.json --devices C:\EstateMate\ISAPI-Agent\isapi-devices.json
```

## Packaging as executable

For estates without Node.js, compile with `pkg` or `nexe`:

```bash
npm install -g pkg
pkg agent.mjs --targets node22-win-x64 --output estatemate-isapi-agent.exe
```

Then distribute `estatemate-isapi-agent.exe` with installer.

## License

MIT. Ensure Hikvision ISAPI usage complies with Hikvision agreements and Nigerian data-protection requirements.
