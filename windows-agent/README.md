# EstateMate Windows ISAPI Agent

This is the **Windows Service** implementation of the Hikvision ISAPI Bridge. It is designed to run on a Windows PC or Windows Server on the same LAN as Hikvision access-control devices.

- Polls Cloudflare Worker (`/api/isapi/v1/agents/:id/operations`) for pending card/visitor operations.
- Applies them via Hikvision ISAPI (HTTP Digest) to devices on LAN.
- Reports results and heartbeats.
- Runs as Windows Service (`EstateMateISAPIAgent`) with auto-restart.

It reuses the core logic from `../isapi-bridge/agent.mjs` but adds Windows-specific service installation, restricted ACL config, Event Log integration, and PowerShell installer generation.

## Why Windows agent?

Many estates already have a Windows PC for CCTV (iVMS-4200) or accounting. This agent allows them to:

- No separate Linux appliance is needed; the office PC already on the CCTV/accounting LAN does the job.
- Use existing Windows machine as ISAPI bridge.
- Keep ISAPI traffic on LAN (no port forwarding).
- Get automatic card disable/enable when facility fees expire.

## Quick start (Administrator)

1. **Portal:** Register agent in EstateMate → **ISAPI Bridge & Windows Agent** → **Register agent** → platform `windows` → copy the one-time secret → **Download installer** (`.ps1`).

2. **Windows host:** download `estatemate-isapi-agent-win-x64-<version>.zip` from the
   [repository releases](https://github.com/barikblog/estatemate-minmoe/releases) and unzip it to
   `C:\EstateMate\ISAPI-Agent`. The bundle includes its own Node.js runtime, so the host
   needs no Node.js install.

3. **Run the portal installer** (Administrator PowerShell, from the unzipped directory):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\estatemate-isapi-agent-xxxx.ps1
   ```
   It writes `agent-config.json` with the agent id/secret (ACL restricted to
   Administrators + SYSTEM) and creates `isapi-devices.json` from the example.

4. **Edit device mapping:**
   ```powershell
   notepad C:\EstateMate\ISAPI-Agent\isapi-devices.json
   # Fill estateMateDeviceId (from portal device list), isapiHost (192.168.1.x), isapiUsername, isapiPassword
   ```

5. **Register to start automatically:**
   ```powershell
   cd C:\EstateMate\ISAPI-Agent
   powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -InstallDir "C:\EstateMate\ISAPI-Agent"
   ```
   That registers a SYSTEM Scheduled Task which starts at boot and restarts on failure.
   Prefer a real Windows Service? Add `-Nssm` (requires [NSSM](https://nssm.cc/)):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -InstallDir "C:\EstateMate\ISAPI-Agent" -Nssm
   ```

   > **Do not** `sc.exe create` the agent directly. It is a console process, not an SCM
   > binary, so the service would fail to start with **error 1053**. Use
   > `install-service.ps1`, which handles both options.

6. **Verify:**
   ```powershell
   Get-ScheduledTask EstateMateISAPIAgent | Format-List TaskName,State   # or: Get-Service EstateMateISAPIAgent (NSSM)
   Get-Content C:\EstateMate\ISAPI-Agent\logs\agent.log -Tail 50
   # Or check portal: ISAPI Bridge → agent should show online, last_seen recent
   ```

7. **Remove:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\uninstall-service.ps1 -RemoveFiles
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

## Packaging for estates without Node.js

Use the portable bundle produced by the `Build EstateMate Bridge` workflow
(`.github/workflows/bridge.yml`), published on every `bridge-*` tag as
`estatemate-isapi-agent-win-x64-<version>.zip`.

The bundle ships the **official Node.js Windows x64 runtime** alongside the agent,
so the target PC needs no Node.js install and no Internet access beyond the
EstateMate Worker and the devices on its LAN:

```
runtime\node.exe                  Node.js 22 (sha256 + Authenticode verified in CI)
agent.mjs                         Windows wrapper / entrypoint
agent-core.mjs                    ISAPI bridge core agent
estatemate-isapi-agent.cmd        launcher (uses runtime\node.exe)
install-service.ps1               register startup task, or -Nssm for a Service
uninstall-service.ps1
agent-config.example.json
isapi-devices.example.json
VERSION                           build metadata incl. node.exe sha256
```

Build it locally with:

```bash
node scripts/package-windows-bundle.mjs --out bundle --version 1.0.0
# then place a verified runtime/node.exe in bundle/runtime/ and run:
node scripts/package-windows-bundle.mjs --out bundle --finalize-runtime
```

Install on the estate PC (Administrator PowerShell, from the unzipped bundle):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-service.ps1 `
  -AgentId <uuid-from-portal> -AgentSecret <secret-from-portal>
```

### Why not `sc.exe create` / a compiled `.exe`?

The agent is a **console process**; it does not implement the Service Control
Manager handshake, so `sc.exe create ... start= auto` reports error 1053
("service did not respond"). `install-service.ps1` therefore registers a SYSTEM
**Scheduled Task** that starts at boot and restarts on failure — no extra tools
required. Pass `-Nssm` to register a real Windows Service named
`EstateMateISAPIAgent` if you have [NSSM](https://nssm.cc/) installed.

Compiling to a single `.exe` with `pkg` or `nexe` is **not** the supported path:
the original `pkg` package is archived and does not support Node 22, and a
compiled binary would still not speak SCM, so it would not solve the service
problem either.

### Code signing

Set `WIN_CRT_PFX_BASE64` (base64 of the `.pfx`) and `WIN_CRT_PFX_PASSWORD` as
repository secrets and the workflow Authenticode-signs `runtime\node.exe` with
`signtool`, timestamping against `WIN_CRT_TIMESTAMP_URL` (defaults to
`http://timestamp.digicert.com`). Without them the bundle is **unsigned** and
SmartScreen will warn estates on first run; the job emits a warning rather than
failing, and records the status in `SIGNING.txt` inside the bundle.

## License

MIT. Ensure Hikvision ISAPI usage complies with Hikvision agreements and Nigerian data-protection requirements.
