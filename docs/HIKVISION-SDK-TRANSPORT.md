# The Hikvision SDK transport — a terminal that only answers on port 8000

Port **8000** on a Hikvision device is the **SDK / "server" port**: the port
**iVMS-4200, Hik-Connect and Hikvision's batch tools** use. It is a proprietary
binary protocol, not HTTP, so it is **not ISAPI** and no amount of configuration
makes EstateMate's ISAPI client speak it.

This document describes the transport that reaches a terminal there: the agent
drives **Hikvision's own Device Network SDK (HCNetSDK)** — the same library
iVMS-4200 loads — through a small helper process, and reaches the terminal over
the address iVMS-4200 uses. That makes the estate's live case work:

> "`102.211.122.35:8000` is what iVMS-4200 uses. The terminal's LAN address is
> unknown and the router is not mine to change."

- Decide whether the SDK path is the right one: §1.
- Understand what the vendor transport can and cannot do: §2.
- Set it up, step by step: §3.
- The exposure question (a public `ip:port` is still an exposure): §4.
- Verify it, from the agent and from the terminal: §5.
- Failure modes, and the honest limits: §6, §7.
- Why this is *not* the retired ISUP gateway: §8.

Related: [`Hikvision SDK helper`](../bridge-apps/windows/hcnetsdk/README.md) (the
build and the vendor SDK download), [`PUBLIC-ENDPOINT-DEVICE.md`](PUBLIC-ENDPOINT-DEVICE.md)
(the acknowledgement a public address requires — ISAPI or SDK),
[`PUBLIC-IP-AND-PORT-FORWARDING.md`](PUBLIC-IP-AND-PORT-FORWARDING.md) §6
(finding the terminal's LAN address), [`ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](ISAPI-BRIDGE-AND-WINDOWS-AGENT.md)
(the normal transport).

---

## 1. First, decide whether you are on the SDK path at all

Run the probe against the address iVMS-4200 uses. It answers this before anything
is installed:

```bash
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000
```

| What it says | What it means | What to do |
|---|---|---|
| `isapi` | Something on that address answers HTTP/ISAPI | You do **not** need this transport: use the ISAPI path in [`PUBLIC-ENDPOINT-DEVICE.md`](PUBLIC-ENDPOINT-DEVICE.md) — it needs no vendor library. |
| `sdk_port` | TCP accepts and nothing resembling HTTP comes back: Hikvision's SDK protocol | This is the transport for it. Continue with §3. |
| `web_ui` | The rule reaches the terminal's **web** interface instead | Different finding: the web admin surface is published. Read §4 before anything else. |
| `closed` / `http_other` | Nothing (from here), or something that is not this terminal | Re-run from outside the estate (mobile data) — router NAT often refuses its own WAN address — and confirm the address with whoever configured iVMS-4200. |

The same probe is the honest answer to "can EstateMate reach what iVMS-4200
reaches?" — and it is cheap to re-run when the rule changes.

## 2. What the SDK transport can and cannot do

| Capability | Over the SDK port | Notes |
|---|---|---|
| Live access events (card swipes, door events) | **yes**, when the vendor build exports the alarm callback | Events are normalised into the same document an ISAPI alertStream produces, so gate history flows through one pipeline |
| Door control — `remote_open`, `remote_close`, `remote_always_open`, `remote_always_close`, `remote_resume` | **yes**, when the vendor build exports the gate-control call | The device's own error code is recorded verbatim; a refusal is never presented as applied |
| Terminal clock read/set | **yes**, when the vendor build exports the time-config calls | Used by the clock-sync feature |
| Device identity (serial, channels, device type) | **yes** (from the login reply) | Model and firmware strings come from a separate configuration read the helper does not decode yet — iVMS-4200 shows them |
| **Card writes, person records, fingerprints** | **never** | HCNetSDK has no card-record API. iVMS-4200 provisions cards over HTTP/ISAPI itself. With no ISAPI path these stay operator tasks in **Hardware actions** |
| **A verdict decoded from the vendor's event code** | **not yet** | No minor-code table is verified against a terminal in this repository (the same open item as the MinMoe minor-code mapping). Events are filed with their numbers, marked `unmapped`, and the raw payload is kept: a feed, not a guess |

That last row matters more than it looks. A gate history that says `granted` for
an event whose code nobody has verified is worse than one that says "here is the
card, here is the code, nobody has taught this build what it means yet". The
mapping table lives in `isapi-bridge/hik-sdk-transport.mjs`
(`SDK_MINOR_DESCRIPTIONS`) and is empty on purpose; when a code is verified
against a real terminal, adding it there is the whole change.

## 3. Setting it up

### 3.1 Build the helper (once per machine)

The helper links Hikvision's SDK, which is proprietary and **not** in this
repository. Download the Device Network SDK from <https://www.hikvision.com/en/support/download/sdk/>
(free, with registration) and copy its files next to the helper, then build:

```bat
rem Windows — uses the compiler Windows already has, nothing to install
bridge-apps\windows\hcnetsdk\build-hcnetsdk-helper.cmd
```

```bash
# Linux (needs the .NET SDK)
bridge-apps/windows/hcnetsdk/build-hcnetsdk-helper.sh
```

Full file list, licence note and build details:
[`bridge-apps/windows/hcnetsdk/README.md`](../bridge-apps/windows/hcnetsdk/README.md).

### 3.2 Prove it before the agent depends on it

```bat
build\EstateMateHikSdk.exe --selftest 102.211.122.35:8000 admin "the-password"
```

The self-test reports which library loaded, which functions that build exports,
whether login works, what the login reply carries, and 15 seconds of live events
(swipe a card). This is the step that turns "it should work" into "it works on
this machine, against this terminal".

### 3.3 Tell the agent

`agent-config.json`:

```json
"hikSdk": {
  "enabled": true,
  "helperPath": "C:\\EstateMate\\hcnetsdk\\EstateMateHikSdk.exe",
  "eventStream": true,
  "reconnectSeconds": 30
}
```

`isapi-devices.json` — the device, configured exactly as iVMS-4200 is:

```json
{
  "estateMateDeviceId": "55555555-5555-4555-8555-555555555555",
  "name": "Main Gate (SDK)",
  "transport": "hik_sdk",
  "sdkHost": "102.211.122.35",
  "sdkPort": 8000,
  "sdkUsername": "admin",
  "sdkPassword": "<device admin password>",
  "enabled": true,
  "publicEndpoint": {
    "acknowledged": true,
    "acknowledgedBy": "your name",
    "acknowledgedAt": "2026-10-11T09:00:00Z",
    "note": "contractor rule on the ISP router; the SDK port is the only path to this terminal"
  }
}
```

Notes that save installs:

- `sdkPort` defaults to **8000**; set it when the router publishes the SDK port on
  a different outside port.
- `publicEndpoint` is **required** when `sdkHost` is a public address — the agent
  refuses to start otherwise (§4). On a LAN address, leave it out.
- **Give it `estateMateDeviceId`** (from *Device agent → Connected terminals*), or
  record the terminal in the portal at the **same host and SDK port**. There is no
  ISAPI address to match on, so that is the only pair the agent will bind to; it
  refuses to start rather than guess, which is deliberate — one public address can
  front several terminals, and guessing puts one gate's events on another
  terminal's history.
- An `isapiHost`/`isapiPort` already in the file is used as the fallback endpoint,
  so a device entry that was written for ISAPI does not need its address repeated.
  `isapiHost` is never treated as an SDK address: port 8000 is not port 80.
- `transport: "hik_sdk"` is per device: one estate can serve cards over ISAPI on
  the LAN and events over the SDK for the gate whose rule nobody can remove.
- No Worker change and no migration: the terminal keeps its connection pattern
  (`isapi_bridge`, `windows_agent`, …) and the agent chooses the transport from
  the devices file.

### 3.4 What the Windows host tooling does with it

`bridge check`, `bridge setup` and the dashboard read the same devices file, and
none of them can speak the SDK protocol — that is the helper's job. So:

- `bridge check` lists an SDK terminal as **`[SKIP]`** with its real address,
  `hik_sdk://<host>:<port>` (never a made-up `http://:80`), and the command that
  does verify it (`EstateMateHikSdk.exe --selftest …`). A skipped terminal is not
  counted as verified: the summary says so instead of printing "all checks passed".
- **A missing or mismatched `estateMateDeviceId` is an error**, exactly as it is in
  the agent, because the bridge would refuse to start on it.
- `setup` and the dashboard's "Save all settings" **preserve the whole `hikSdk`
  block** and the device file's SDK entries; the wizard never asks about them, and
  it must not silently switch a working gate back to ISAPI (`setup.cjs`).

## 4. A public `ip:port` is still an exposure

Pointing the agent at `102.211.122.35:8000` does not make that rule safe, and
this transport does not pretend otherwise. The rules are the same ones
[`PUBLIC-ENDPOINT-DEVICE.md`](PUBLIC-ENDPOINT-DEVICE.md) sets for ISAPI, applied
to the SDK address:

- **The terminal answers for itself.** No allowlist, shared secret or rate limit
  on the agent host limits who reaches `102.211.122.35:8000`.
- **The SDK protocol is not TLS.** Hikvision's library protects the password with
  its own challenge/response during login, but card numbers, person names and
  events travel in the vendor's binary framing over a network nobody in this
  deployment controls.
- **The terminal's admin surface is one rule away.** The web interface usually
  sits on the same device; if the rule is `8000 → 8000` the admin page may be
  published too, and `npm run terminal:endpoint -- --endpoint <host>:80` will say.
- **Uptime now depends on somebody else's router.** If the rule changes, the
  terminal goes offline and gate history stops being live.

What the acknowledgement does:

| Without `publicEndpoint` | With it |
|---|---|
| `agent.mjs` **exits** (`status 1`) and prints the LAN-first remedy, the probe command and the block to add. Nothing dials the terminal. | The agent starts, logs the risks at every start, and reports them on the heartbeat (`sdkTransport`). |
| `npm run inbound:check` reports an **error**. | A **named warning** ("acknowledged by … does not remove the risk" + the risk list). The report keeps `publicEndpoint`. |

Harden the terminal while you are there: unique admin password, platform access
(HiDDNS/Hik-Connect), UPnP and device-side NAT switched **off**, and an agent on
the terminal's LAN as the exit plan (SADP finds its address —
[`PUBLIC-IP-AND-PORT-FORWARDING.md`](PUBLIC-IP-AND-PORT-FORWARDING.md) §6).

## 5. Verifying it

```bash
# What answers on the address, before anything is dialled
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000

# The posture: public endpoint acknowledged? helper installed? (see §6 for the heartbeat)
npm run inbound:check -- --config <agent-config.json> --devices <isapi-devices.json>

# From outside the estate (phone on mobile data): what the world can reach
npm run inbound:check -- --probe 102.211.122.35:8000
```

On the Windows gate PC, `bridge check` adds the same terminal to its report —
`[SKIP] … hik_sdk://102.211.122.35:8000` and the helper's self-test command —
because the bridge executable carries no SDK client of its own.

Then, on the agent host, the log and the heartbeat:

```
Hikvision SDK transport: helper 1.0.0 on windows-x64, SDK V6.1.9.48, events on, door on, clock on,
  cards/people never (HCNetSDK has no card-record API — those stay operator tasks)
Hikvision SDK session for Main Gate (SDK): serial DS-K1T341CMFWX20250101AAWR123456789 · channels 1
SDK event from Main Gate (SDK): major=5 minor=75 card=******5671
```

On the portal's side the heartbeat now carries:

```json
"sdkTransport": {
  "enabled": true, "helperInstalled": true, "sdkVersion": "V6.1.9.48",
  "events": true, "door": true, "clock": true, "sessions": 1,
  "devices": [{ "name": "Main Gate (SDK)", "host": "102.211.122.35", "port": 8000, "session": true }],
  "eventsReceived": 12, "doorCommands": 1, "restarts": 1, "lastError": null
}
```

And the capability list the Worker stores is honest about the transport: an
SDK-only bridge advertises **`door`** (when the build exports the call) and never
**`card`**, **`person`** or **`fingerprint`** — so card work becomes an operator
task instead of an operation that can never be applied.

## 6. Failure modes, and what they look like

| Symptom | Cause | Fix |
|---|---|---|
| `bridge check` shows `[SKIP]` | Normal: the terminal is on the SDK transport and the bridge executable cannot speak it | Verify with the helper's `--selftest`; `bridge check` is not the tool for this terminal |
| `Terminal "…" has no EstateMate device id and the portal does not list it` | No `estateMateDeviceId`, and no portal row at that host **and** port | Paste the id from *Device agent → Connected terminals*, or record the terminal in the portal at `<sdkHost>:<sdkPort>` |
| `Hikvision SDK helper (…) is not installed` | Nothing at the configured/bundled path | Build it (§3.1), or set `hikSdk.helperPath`. The agent keeps serving its ISAPI terminals meanwhile. |
| `hikSdk is enabled but no device uses it` | Config and devices file disagree | Add `"transport": "hik_sdk"` to the device, or switch `hikSdk` off. |
| `N device(s) are on the Hikvision SDK transport but hikSdk is disabled` | The device can never be reached in this configuration | Enable `hikSdk` and install the helper. |
| `the vendor library could not be loaded` | The HCNetSDK files are missing or incomplete (usually the `HCNetSDKCom` folder on Windows) | Copy the SDK's files next to the helper (its README lists them). |
| `NET_DVR_Login_V40 failed: error 41` | Wrong address/port, or the rule does not reach the terminal | `npm run terminal:endpoint -- --endpoint <host>:<port>`. |
| `… error 1` / `… error 46` | Wrong password / the account is locked | Fix the account at the terminal; do not brute-force — firmware locks it. |
| `Live events unavailable for …` | This SDK build does not export the alarm callback | The helper says so in `--selftest` and in `capabilityReport`; use ISAPI for events, or a build that exports the callback. |
| Operations refused: *"this terminal is on the Hikvision SDK transport, which cannot apply …"* | Card/person work over the SDK | Expected (§2). Give the terminal an ISAPI path, or keep it as an operator task. |
| A helper that keeps restarting | Vendor library crash or a pulled network | The heartbeat's `sdkTransport.restarts` counts it; the agent re-logs in with backoff and never wedges the sync loop. |

## 7. The honest limits of this transport

- The helper needs **Hikvision's vendor library**, per architecture, downloaded by
  the operator. That is a real installation step, which is exactly why this
  transport is **off by default** and why nothing else in the repository depends
  on it.
- The P/Invoke declarations were written against Hikvision's `HCNetSDK.h`
  (V6.1.x, 64-bit) and are **not exercised in this repository's CI** — that needs
  the vendor library and a physical terminal. What *is* exercised in CI is the
  protocol the helper speaks, against `scripts/hcnetsdk-simulator.mjs`, and every
  claim the helper makes about itself (which exports exist, what a build cannot
  do).
- Anything the helper cannot read confidently is reported as `unmapped` with the
  raw payload, never as a value that might be wrong. The employee number is
  deliberately not decoded yet: its offset moves between SDK builds, and a wrong
  employee number would mis-attribute a gate event.
- A part of what iVMS-4200 does (card enrolment) is **not** available here at all,
  because the vendor library does not offer it. This transport is for events and
  door control, not for provisioning.

## 8. Why this is not the retired ISUP gateway

Migration `0013_agent_only_transports.sql` removed a dedicated `isup-gateway/`
(SDK adapter) because it was a **second control plane**: a separate Ubuntu host
compiling Hikvision's licensed SDK for one architecture and firmware, exposed as
its own service, with the device or the platform talking to it.

This transport is deliberately not that, and the differences are the design:

| Retired `isup-gateway` | This transport |
|---|---|
| A separate service/host to install, secure and monitor | A helper process the **agent** spawns and supervises, on the machine that already runs the bridge |
| Its own network path and inbound surface | No listener at all: the agent dials the terminal, exactly like the ISAPI client |
| Another place device credentials live | Credentials stay in `isapi-devices.json`, next to every other device |
| Deployed by default as a capability of the product | **Off by default** (`hikSdk.enabled`), and every capability it advertises is probed from the vendor build at run time |
| Could only do what one compiled adapter exposed | Falls back to ISAPI, and to operator tasks for card/person work, instead of pretending |

The rule it obeys is the repository's own: **the agent is the only automatic
transport**. A device never dials into this, and no new inbound path exists —
which is also why it needs no Worker change and no migration.

## 9. Sources

- **Port 8000 is the SDK/"server" port** used by iVMS-4200 and Hik-Connect, and
  iVMS-4200 reaches devices through `HCNetSDK.dll` over that port: the port tables
  in [`PUBLIC-IP-AND-PORT-FORWARDING.md`](PUBLIC-IP-AND-PORT-FORWARDING.md) §6,
  which also cites the published firmware analyses of a Hikvision intercom's
  ports and the vendor's own `HCNetSDK` linkage.
- **HCNetSDK is proprietary and not redistributable**, and must be downloaded from
  Hikvision per platform: Hikvision's Device Network SDK download page, and the
  independent wrappers that document the same constraint (e.g. `hikconnect-go`,
  `hik-connect-proxy-viewer` READMEs — "supply your own copy; none are
  redistributed here").
- **SDK entry points used here** — `NET_DVR_Init`, `NET_DVR_SetConnectTime`,
  `NET_DVR_SetReconnect`, `NET_DVR_Login_V40`, `NET_DVR_Logout`,
  `NET_DVR_SetDVRMessageCallBack_V50`, `NET_DVR_SetupAlarmChan_V41`,
  `NET_DVR_CloseAlarmChan_V30`, `NET_DVR_ControlGateway`, `NET_DVR_GetDVRConfig`,
  `NET_DVR_SetDVRConfig`, `NET_DVR_GetLastError` — Hikvision's
  *Device Network SDK Programming Manual* and `HCNetSDK.h` (Windows
  `HCNetSDK.dll` / Linux `libhcnetsdk.so`).
- **The retirement decision this transport has to answer to**:
  [`MINMOE-NO-PC.md`](MINMOE-NO-PC.md) and `migrations/0013_agent_only_transports.sql`.
- **What is verified in this repository, and how**: `npm run test:hik-sdk` runs
  `scripts/hcnetsdk-simulator.mjs` — a helper that speaks the JSON-lines protocol
  without any vendor library — through the real transport, the real agent and the
  Windows host's `check`; the C# helper itself and the P/Invoke bindings are
  reviewed and self-tested on the machine, not compiled in CI (§7).
