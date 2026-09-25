# EstateMate Bridge (single executable)

`estatemate-bridge-win-x64.exe` is the EstateMate access-device agent packaged as
**one file** for a Windows PC on the same LAN as the Hikvision terminals. It needs
no Node.js installation, no SDK, no installer and no administrator rights to
*run* — only to register it as a start-at-boot task.

It is the same agent the repository ships as `isapi-bridge/agent.mjs`: the
executable embeds that file (plus this host), unpacks it into a per-version
runtime directory and verifies every file against the SHA-256 hashes recorded at
build time. Nothing about the device protocol is reimplemented here.

What it does, on the estate LAN:

* holds a persistent `GET /ISAPI/Event/notification/alertStream` connection to
  each terminal and forwards gate events to the Worker in seconds;
* polls the Worker for queued card/visitor operations and applies them to the
  terminal over ISAPI (HTTP Digest);
* heartbeats every minute so the portal shows the agent as online.

See [`docs/BRIDGE-EXE-AND-APK.md`](../../docs/BRIDGE-EXE-AND-APK.md) for the
full picture, and [`isapi-bridge/README.md`](../../isapi-bridge/README.md) for the
protocol documentation.

## Requirements

| | |
|---|---|
| Host | Windows 10/11 (x64) with an always-on network connection. The estate office PC is fine. |
| Network | Reachability to each terminal's ISAPI port (usually 80) on the LAN, and outbound HTTPS to the Worker. |
| Rights | Any user to run it; Administrator once, to register the scheduled task. |
| Ports | None inbound. The bridge never listens on a port and never accepts a connection. |

> **Security:** keep the terminals and this PC on the same VLAN. Never
> port-forward ISAPI or the device web UI to the Internet. The bridge only ever
> makes *outbound* connections.

## Five-minute setup

1. **Portal** — sign in as Administrator → *ISAPI Bridge & Windows Agent* →
   **Register agent** (name it after the PC, platform `windows`) → copy the
   one-time secret. Then **Link device to agent** for each terminal, entering its
   LAN IP, port, ISAPI username and password.
2. **Portal** — with the agent row selected, click **Download installer** and save
   the `.ps1`. It already contains the agent id, secret and Worker URL.
3. **Estate PC** — copy `estatemate-bridge.exe` and the `.ps1` to the PC, then in
   PowerShell:

   ```powershell
   .\estatemate-bridge.exe setup            # asks for the installer script path
   .\estatemate-bridge.exe check            # Worker + every terminal, one report
   .\estatemate-bridge.exe install-service  # Administrator shell: start at boot
   ```

   `setup` writes both configuration files, restricts their ACL to
   Administrators + SYSTEM and can test each terminal while you are still on
   site. `check` is the pre-flight: it authenticates with the Worker, lists the
   devices the portal believes are linked and probes each terminal over ISAPI
   (device info, card API, alertStream).

That is it. The bridge runs as the `EstateMateBridge` scheduled task, starts at
boot as SYSTEM, restarts up to 10 times after a failure, and logs to
`%ProgramData%\EstateMate\logs\bridge.log`.

## Commands

```
estatemate-bridge.exe run                 start the bridge (default command)
estatemate-bridge.exe check [--json]      configuration + Worker + device pre-flight
estatemate-bridge.exe setup               write configuration (from the portal installer)
estatemate-bridge.exe init [--force]      write example configuration files
estatemate-bridge.exe status [--json]     resolved paths, task state, recent log lines
estatemate-bridge.exe install-service     Scheduled Task (SYSTEM, at boot, restarts on failure)
estatemate-bridge.exe uninstall-service   remove it again
estatemate-bridge.exe version             build + runtime information
estatemate-bridge.exe help
```

Useful options: `--config`, `--devices`, `--data-dir`, `--log-level`,
`--log-file`, `--from-installer <file|->`, `--devices-json <file>`,
`--no-prompt`, `--dry-run`, `--quiet`, `--json`.

## Configuration

Both files are ordinary JSON; they are the same files the Linux/macOS agent
reads. They live in `%ProgramData%\EstateMate\` (or next to the executable, or
wherever `--config`/`--data-dir` says).

`agent-config.json`

| Key | Meaning |
|---|---|
| `agentId` | UUID of the agent registered in the portal |
| `agentSecret` | one-time secret from the portal (32 characters) |
| `workerUrl` | Worker base URL, e.g. `https://estatemate.estatemate.workers.dev` |
| `syncIntervalSeconds` | how often to poll for queued operations (default 30, minimum 5) |
| `heartbeatIntervalSeconds` | portal liveness interval (default 60, minimum 15) |
| `eventStream` | `false` disables real-time gate events globally |
| `eventFlushCount` / `eventFlushSeconds` | batching thresholds (25 events / 5 s) |
| `eventBufferLimit` | events buffered while the Worker is unreachable (500) |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` |
| `isapiTimeoutMs` | per-request device timeout (15000) |

`isapi-devices.json`

```json
{
  "devices": [
    {
      "estateMateDeviceId": "11111111-1111-4111-8111-111111111111",
      "name": "Main Gate MinMoe",
      "isapiHost": "192.168.1.100",
      "isapiPort": 80,
      "isapiUsername": "admin",
      "isapiPassword": "device-admin-password",
      "protocol": "http",
      "enabled": true,
      "eventStream": true
    }
  ]
}
```

`estateMateDeviceId` is the id shown on the portal's *Access-control devices*
page — operations queued for that device are matched by it, so a mismatch shows
up as operations that stay queued. `check` reports both directions of that
mismatch.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `check` says **UNAUTHORIZED (HTTP 401)** | The secret was rotated (each *Download installer* generates a new one). Download a fresh installer and re-run `setup`. |
| `check` says **UNREACHABLE** | The PC has no Internet, a proxy is in the way, or the Worker URL is wrong. Test with `curl https://<worker>/api/health`. |
| A device shows **HTTP 401** | Wrong ISAPI username/password, or the account is locked on the terminal. |
| A device shows **cannot reach ISAPI** | Wrong IP, wrong VLAN, device offline, or a Windows firewall rule blocking outbound port 80 (rare; outbound is allowed by default). |
| **alertStream did not open** | The terminal refuses a second stream — only one alertStream connection per device is allowed. Close the browser tab or iVMS session that is holding one. |
| Events arrive but the portal shows nothing | The device is not linked to *this* agent in the portal: re-run **Link device to agent**. |
| `install-service` says **Access is denied** | Run it from an Administrator PowerShell. |
| Task exists but nothing happens after reboot | `schtasks /Query /TN EstateMateBridge /V /FO LIST`, then read `%ProgramData%\EstateMate\logs\bridge.log`. |

Logs: `<data-dir>\logs\bridge.log` (rotated at 5 MB to `bridge.log.1`).
`status` prints the tail of it.

## Verifying the download

Every release ships `SHA256SUMS.txt` and `BUILD-INFO.json`. The build info lists
the Node.js runtime that was wrapped, the SHA-256 of the executable and of the
SEA blob, and the SHA-256 of every file embedded inside the executable — so an
operator can confirm with `certutil -hashfile estatemate-bridge-win-x64.exe SHA256`
that the artifact is the one the repository's CI produced, and that the agent
source inside it is the reviewed one.

## Building it yourself

```bash
# From the repository root. Uses the official Node.js runtime (SHASUMS verified)
# and postject to inject the SEA blob.
node scripts/package-bridge-exe.mjs \
  --out dist/bridge --target win-x64 --version 0.2.0 \
  --node-version 22.22.2 --download

# Networks that cannot reach nodejs.org: same official binaries from the npm
# registry, verified against the registry's sha512 integrity value.
node scripts/package-bridge-exe.mjs \
  --out dist/bridge --target win-x64 --version 0.2.0 \
  --node-version 22.22.2 --node-from-npm

# Prove the artifact works before shipping it (fake Worker + fake terminal,
# Digest challenge, alertStream, queued card operation):
node scripts/bridge-exe-smoke-test.mjs --exe dist/bridge/estatemate-bridge-win-x64.exe
```

Targets: `win-x64`, `win-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64` — the same host supports Linux and macOS estates.

HTTPS terminals with self-signed certificates are **not** trusted: use `http` on
the isolated device VLAN (recommended, and what the portal documentation
assumes), or import the terminal's CA into the Windows trust store.
