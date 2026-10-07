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

See
[`docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](../../docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md)
for the full picture, and
[`isapi-bridge/README.md`](../../isapi-bridge/README.md) for the protocol
documentation.

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

## Installing

Three shapes, same agent:

| | How | Best for |
|---|---|---|
| **Installer kit** (`estatemate-bridge-<version>-win-x64-installer-kit.zip`) | Unzip it and double-click `Install-EstateMate-Bridge.cmd`. | The normal case, and any PC where the MSI has ever refused to finish. |
| **MSI installer** (`estatemate-bridge-<version>-win-x64.msi`) | Double-click it, or `msiexec /i <file>`. Installs to `C:\Program Files\EstateMate Bridge`, adds **Start Menu → EstateMate Bridge**, which opens the dashboard window, and puts `estatemate-bridge` on the PATH and in *Settings → Apps* for upgrades and uninstall. | A PC an administrator manages directly. |
| **Portable exe** (`estatemate-bridge-win-x64.exe`) | Copy it anywhere and run it; no install, no administrator rights. | USB sticks, testing, machines you may not install on. |

If double-clicking the **exe** seemed to do nothing: it is a console tool, not an
installer — the window opens, prints and closes.

The MSI removes that whole problem: **Start Menu → EstateMate Bridge** opens the
dashboard, a normal window (`EstateMateBridge.exe`, a GUI program, so no console
appears at all) with three tabs:

- **Status** — what the bridge is doing, what your last action returned, and the
  live log;
- **Configuration** — the agent id, secret and Worker URL, the portal's
  *Download setup* `.ps1`, the Hikvision terminals as an editable table, and the
  **Terminal clock sync** checkbox (opt-in: the bridge sets a terminal's clock
  back to this PC's when it drifts past the configured threshold);
- **Service** — *Start at boot* / *Remove from boot*, which are `install-service`
  and `uninstall-service` with the elevation prompt handled for you.

Every button runs exactly the commands documented below, so the window and the
console can never disagree about what a valid setup is. The dashboard lives in
`bridge-apps/windows/dashboard/` (`EstateMateBridge.ps1` is the window,
`Launcher.cs` compiles to the no-console `.exe`, `build-dashboard.cmd` finds a
C# compiler the machine already has); it is wired into the MSI by
`scripts/package-bridge-msi.mjs` and self-tested on the Windows runner
(`EstateMateBridge.exe -SelfTest`).

### The installer window says "Gathering information" and then disappears

That is Windows Installer stopping before it installs anything. Nothing is
installed, no error is shown, and the cause is *not* the package — the release
build installs and uninstalls the MSI on a Windows runner every time. On a real
PC the cause is one of:

* antivirus or endpoint security ending `msiexec` (most common with an unsigned
  installer);
* a policy on a managed PC that forbids MSI installs (`1625`);
* the Windows Installer service not running, or a broken installer repository;
* a UAC prompt that was dismissed;
* an MSI that did not finish downloading — the file is 33 MB and a browser that
  resumed an old download can leave it short (`1619`/`1620`).

Run the kit's **Install-EstateMate-Bridge.cmd** instead of the MSI directly. It
verifies the MSI against `SHA256SUMS.txt`, removes the downloaded-from-the-
Internet mark, starts the Windows Installer service if needed, keeps a verbose
`msiexec` log beside the MSI, prints the exit code in plain English, and — when
the MSI still cannot complete — installs the bridge for the current user under
`%LOCALAPPDATA%\Programs\EstateMate Bridge`. That fallback uses no Windows
Installer and needs no administrator rights, so antivirus policy or a broken
installer service cannot stop it.

> The build is unsigned (this project uses no code-signing certificate). If
> Windows shows *"Windows protected your PC"*, choose **More info → Run
> anyway**, or right-click the file → **Properties → Unblock** first; the kit's
> launcher does that for you.

### What the MSI deliberately does *not* do

* It does **not** register the start-at-boot task — that needs the agent
  credentials from the portal first (the `setup` → `check` →
  `install-service` steps below).
* It never touches `%ProgramData%\EstateMate`, so configuration, secrets and
  logs survive every upgrade and uninstall.

## Five-minute setup

1. **Portal** — sign in as Administrator → *Device agent* →
   **Add agent** (name it after the PC, platform `windows`) → copy the
   **Agent ID** and the one-time secret, both shown in the panel that appears
   (and afterwards in the *Agents* table, with **Copy ID** in the row
   actions). Then **Connect terminal** for each terminal, entering its LAN IP,
   port, ISAPI username and password.
2. **Portal** — in the agent row, click **Download setup** and save the
   `.ps1`. It already contains the agent id, secret and Worker URL, so the file is
   the one thing worth carrying to the PC: nothing above has to be retyped, and
   neither does the EstateMate device id — the bridge resolves each terminal from
   the portal by its LAN address.
3. **Estate PC** — install the kit (or the MSI), or copy the portable
   `estatemate-bridge.exe` and the `.ps1` to the PC. With the kit or the MSI
   installed, **Start Menu → EstateMate Bridge** opens the dashboard: pick the
   `.ps1` in *Configuration* (or type the agent id and secret by hand), add each
   Hikvision terminal in the table, press **Save all settings**, press **Run
   check**, then **Start at boot** on the *Service* tab. On a PC that has no
   configuration yet, **double-clicking the portable executable** also works: it
   notices the missing configuration, says so, and starts the setup wizard
   itself. The wizard
   asks for the `.ps1` (paste its path; typing the agent id and secret by hand
   still works), adds each Hikvision terminal with a reachability test while you
   are still on site, and writes both configuration files with administrator-only
   permissions. From PowerShell the same three commands are:

   ```powershell
   .\estatemate-bridge.exe setup            # the wizard; asks for the installer script path
   .\estatemate-bridge.exe check            # Worker + every terminal, one report
   .\estatemate-bridge.exe install-service  # Administrator shell: start at boot
   ```

   The dashboard drives those same commands (headless, never a prompt) — the
   console route stays for support and for anyone who prefers it.

   The wizard only starts itself for a bare double-click: with any option, a
   command, `--no-prompt`, or no console at all (a Scheduled Task, a service, a
   redirected `cmd /c`) the executable behaves exactly as before, so a service is
   never left waiting for an answer. `setup` writes both configuration files, restricts their ACL to
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
`--time-sync-enabled <true|false>`, `--no-prompt`, `--dry-run`, `--quiet`,
`--json`.

`--time-sync-enabled` is the dashboard checkbox on the command line: `setup`
writes it into `agent-config.json` as the `timeSync` block, keeps the
`maxDriftMs` / `checkIntervalMinutes` thresholds the configuration already had,
and leaves clock sync off when nothing says otherwise. The interactive `setup`
wizard asks the same question. Clock sync aligns the terminals' clocks with this
PC; it does not set a terminal's timezone, which must match the estate.

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

`estateMateDeviceId` is optional, and usually best left out: it is the
**EstateMate device ID** on the portal's *Device agent → Connected terminals*
page, and the bridge looks it up by matching `isapiHost` (and
port) against the devices the portal has linked to this agent — `check` prints
`· Main Gate MinMoe → <id>` for every terminal it resolves that way. Set it
explicitly when one address has several terminals behind it. A terminal the
portal has not linked, or a mistyped id, is reported by `check` and refused at
startup rather than silently dropping the events it reads.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `check` says **UNAUTHORIZED (HTTP 401)** | The secret was rotated (each *Download setup* generates a new one). Download a fresh setup file and re-run `setup`. |
| `check` says **UNREACHABLE** | The PC has no Internet, a proxy is in the way, or the Worker URL is wrong. Test with `curl https://<worker>/api/health`. |
| A device shows **HTTP 401** | Wrong ISAPI username/password, or the account is locked on the terminal. |
| A device shows **cannot reach ISAPI** | Wrong IP, wrong VLAN, device offline, or a Windows firewall rule blocking outbound port 80 (rare; outbound is allowed by default). |
| **alertStream did not open** | The terminal refuses a second stream — only one alertStream connection per device is allowed. Close the browser tab or iVMS session that is holding one. |
| Events arrive but the portal shows nothing | The device is not linked to *this* agent in the portal: re-run **Connect terminal**. |
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
