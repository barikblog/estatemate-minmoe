# Bridge apps

Two host apps that put the EstateMate access-device transport on the estate LAN,
so the terminals never have to be reachable from the Internet:

| | Windows | Android |
|---|---|---|
| File | `estatemate-bridge-win-x64.exe` | `estatemate-bridge-<version>.apk` |
| Runs on | the estate PC in the office | a phone or tablet left on site |
| Sources | [`windows/`](windows/) | [`android/`](android/) |
| Agent code | the repository's `isapi-bridge/agent.mjs`, embedded and hash-verified | the same protocol, ported to Java (`app/src/main/java/`) |
| Build | `node scripts/package-bridge-exe.mjs --target win-x64 …` | `python3 scripts/build-bridge-apk.py --test …` |
| Verify | `node scripts/bridge-exe-smoke-test.mjs --exe <exe>` | `python3 scripts/build-bridge-apk.py --only-test` |

Built files are published as release assets by
[`.github/workflows/bridge.yml`](../.github/workflows/bridge.yml) on `bridge-*`
tags (`bridge-exe`, `bridge-apk`, plus the older `windows-agent-bundle` and the
EstateMate client APK). When the files were built locally they sit in
`artifacts/windows/` and `artifacts/android/`, which is not committed to git.

Both hosts speak to the Worker with the same agent key and the same three
endpoints, so the portal cannot tell them apart:

* `POST /api/isapi/v1/agents/:id/heartbeat` — the portal shows the agent online;
* `GET  /api/isapi/v1/agents/:id/operations` + `POST …/operations/:opId/result` —
  queued card/visitor changes are applied to the terminal over ISAPI;
* `POST /api/isapi/v1/agents/:id/events` — gate events from the terminal's
  alertStream, forwarded in batches.

## Which one to use

* **A PC is available and can stay switched on** → the Windows executable. It is
  a single file, installs itself as a start-at-boot task, and its `check` command
  tells you what is wrong before you leave site.
* **No PC, but a spare phone/tablet and power** → the Android APK. It runs the
  bridge in a foreground service, restarts after a reboot, and shows the live log
  on screen. Ask to be exempted from battery optimisation, or Android will
  suspend the sockets after a while.

Only one bridge should be running per agent at a time: two hosts polling for the
same operations would race on the terminal. Register a second agent in the portal
if you want a second device as a standby.

## Configuration

Both hosts use the same two documents, so a device list exported from one can be
pasted into the other:

* `agent-config.json` — `agentId`, `agentSecret`, `workerUrl` and the intervals;
* `isapi-devices.json` — one entry per terminal: `name`, `isapiHost`,
  `isapiPort`, `isapiUsername`, `isapiPassword`, `protocol`, `enabled`,
  `eventStream`, and optionally `estateMateDeviceId`.

`estateMateDeviceId` is the portal's key for a terminal and both hosts resolve it
automatically: leave it out and the bridge matches the terminal by its LAN
address against the devices linked to this agent, logging
`resolved EstateMate device id for "<name>" from the portal: <uuid>`. That is the
whole reason the installer script is the recommended way to configure a host —
an agent id is a UUID nobody should be copying by hand, and with this the only
per-terminal facts anyone needs are ones printed on the terminal itself.

The portal's **Download installer** script contains the first three values; both
hosts can read it (`estatemate-bridge.exe setup --from-installer …` on Windows,
“Paste installer” in the Android app).

## Security notes

* Terminals speak plain HTTP with ISAPI Digest authentication: keep them on an
  isolated VLAN and never port-forward their web/ISAPI ports.
* Files and settings hold the agent secret and the device passwords. On Windows
  `setup` restricts the configuration to Administrators + SYSTEM; on Android they
  live in the app's private storage.
* The bridge only makes outbound connections and never listens on a port.
