# Hikvision SDK helper (`EstateMateHikSdk`)

This folder builds the one program that talks to a terminal on **Hikvision's
SDK/"server" port** — 8000 by default, the port **iVMS-4200 and Hik-Connect
speak**. It links Hikvision's own **Device Network SDK (HCNetSDK)**; EstateMate
does not reimplement that binary protocol, and nothing here pretends to.

```
EstateMate agent ──JSON lines over stdin/stdout──▶ EstateMateHikSdk
                                                        │ HCNetSDK (yours)
                                                        ▼ device SDK port 8000
```

When the agent has this helper, a terminal that is *only* reachable at
`<public-ip>:8000` gives live gate events and door control through the same
path iVMS-4200 uses.

The full procedure is in **`docs/HIKVISION-SDK-TRANSPORT.md`**, with the
public-endpoint rules in **`docs/PUBLIC-ENDPOINT-DEVICE.md`** (in a Windows agent
bundle, both are under the bundle's `docs\` folder; in this repository they are
under `docs/`). Those are written as paths, not links, on purpose: this folder is
shipped both in the repository and inside the portable bundle, where the relative
depth differs.

---

## 1. Get Hikvision's Device Network SDK (it is not in this repository)

The SDK is **proprietary and not redistributable**, so it is not committed here
and never will be. Download it yourself from Hikvision, free but with
registration:

- <https://www.hikvision.com/en/support/download/sdk/> — "Device Network SDK",
  **Windows 64-bit** (`EN-HCNetSDKV*_win64_*`) or **Linux 64-bit**
  (`EN-HCNetSDKV*_linux64_*`), matching the machine the agent runs on.

Copy next to the built helper:

| Platform | Files to copy | Notes |
|---|---|---|
| Windows | `HCNetSDK.dll`, the whole **`HCNetSDKCom`** folder, `libcrypto-*.dll`, `libssl-*.dll`, `hlog.dll`, `hpr.dll`, `zlib1.dll` (whatever the SDK's `lib`/`bin` folder contains) | The DLLs load each other; a missing one is the usual cause of "the vendor library could not be loaded". |
| Linux | `libhcnetsdk.so`, the SDK's `HCNetSDKCom/` folder and the other `.so` files beside it | The agent needs read/execute access to them. |

Keep the whole folder together, and keep it out of Git (`*.dll`, `*.so` are
already ignored by the repository's conventions — if you find one staged,
remove it).

## 2. Build it

**Windows** — nothing to install; uses the C# compiler Windows already has
(the same one the dashboard launcher uses):

```bat
build-hcnetsdk-helper.cmd
rem → build\EstateMateHikSdk.exe
```

**Linux / macOS** — needs the .NET SDK:

```bash
./build-hcnetsdk-helper.sh
# → build/EstateMateHikSdk
```

There is no macOS vendor library, so a Mac can build this but cannot run it
against a terminal.

## 3. Prove it works before the agent uses it

```bat
build\EstateMateHikSdk.exe --selftest 102.211.122.35:8000 admin "the-password"
```

The self-test prints, in order:

1. **which vendor library it loaded** and which exports that build has — so an
   SDK version missing `NET_DVR_ControlGateway` or the alarm callback says so
   *before* anything is configured;
2. **whether login works**, with Hikvision's own error number and wording if it
   does not (`error 1` = wrong password, `error 41` = wrong address/port or the
   device is unreachable, `error 46` = the account is locked after repeated
   failures);
3. **what the login reply carries** — serial number, channel count, device type;
4. **15 seconds of live events** ("swipe a card now"), with the vendor's
   `major`/`minor` numbers and the card number when it can be read
   confidently — an event whose payload this build cannot decode is printed as
   `[unmapped]` with the raw bytes instead of a guessed card number.

`--version` prints the helper and protocol versions. `--selftest` is the only
mode a person reads; every other mode writes JSON lines to stdout and words to
stderr, because that channel belongs to the agent.

## 4. Point the agent at it

`agent-config.json`:

```json
"hikSdk": {
  "enabled": true,
  "helperPath": "C:\\EstateMate\\hcnetsdk\\EstateMateHikSdk.exe",
  "eventStream": true,
  "reconnectSeconds": 30
}
```

`helperPath` may be omitted when the helper sits next to the agent in a folder
called `hcnetsdk-helper`. `helperArgs` exists for running it through an
interpreter (`"helperArgs": ["/opt/estatemate/hcnetsdk/EstateMateHikSdk.dll"]`
with `helperPath: "dotnet"`).

`isapi-devices.json` — the device entry, exactly as iVMS-4200 is configured:

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

The `publicEndpoint` block is required when `sdkHost` is a public address: the
agent refuses to start without it. It is the same acknowledgement
`docs/PUBLIC-ENDPOINT-DEVICE.md` describes for an ISAPI endpoint, refused for the
same reason. On a LAN address, leave it out.

Then:

```bash
npm run inbound:check -- --config <agent-config.json> --devices <isapi-devices.json>
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000   # what answers there, before anything is dialled
```

## 5. What this transport can and cannot do

| Capability | SDK transport | Why |
|---|---|---|
| Live access events | **yes** (when the build exports the alarm callback) | `NET_DVR_SetDVRMessageCallBack_V50` + `NET_DVR_SetupAlarmChan_V41` |
| Door control (`remote_open`, `remote_close`, `remote_always_open`, `remote_always_close`, `remote_resume`) | **yes** (when the build exports `NET_DVR_ControlGateway`), with the device's own error code reported verbatim | the vendor's gate-control call |
| Terminal clock read/set | **yes** (when the build exports the time-config calls) | `NET_DVR_GetDVRConfig`/`NET_DVR_SetDVRConfig` |
| Card writes, person records, fingerprints | **no — never** | HCNetSDK has no card-record API; iVMS-4200 provisions cards over HTTP/ISAPI itself. These operations stay operator tasks in **Hardware actions**; give the terminal an ISAPI path if you need them automatic. |
| Event verdict (`granted`/`denied`) from the vendor's minor code | **not yet** | No minor-code table is verified against a terminal in this repository (same open item as the MinMoe minor-code mapping in the top-level README). Events are filed with their numbers, marked `unmapped`, and the raw payload is kept — a feed, not a guess. |

## 6. If something does not work

| Symptom | Cause and fix |
|---|---|
| `the vendor library could not be loaded` | The DLL/SO is not next to the helper, or a dependent file is missing (on Windows this is usually the `HCNetSDKCom` folder). Copy the whole SDK folder beside the exe and run `--selftest` again. |
| `error 41` on login | Address or port wrong, or the rule does not reach the terminal. Confirm what answers: `npm run terminal:endpoint -- --endpoint <host>:<port>`. |
| `error 1` on login with the right password | An account problem — check the account is allowed remote access, and whether repeated failures locked it (`error 46`). Hikvision's own tools show the same numbers. |
| Login works but no events | The build may not export the alarm callback (the self-test says so), or event notification is switched off on the terminal, or nothing is being swiped. |
| Door commands fail with `error 23` | This firmware does not accept that gate-control call — keep door control in iVMS-4200 or at the terminal. The refusal is recorded verbatim, never assumed applied. |
| A card number looks wrong in gate history | It cannot: the helper only reports a card number that is 1-32 characters of `0-9A-F`, and marks the event `unmapped` otherwise. If you see an event with no card number, the payload layout of your SDK version differs — `--selftest` prints the raw bytes so the offsets can be checked against your `HCNetSDK.h`. |

## 7. Honest status of this code

- The **stdio protocol** is exercised in this repository's CI
  (`npm run test:hik-sdk`) against `scripts/hcnetsdk-simulator.mjs`, which is the
  executable reference for what this helper must print.
- The **P/Invoke declarations** were written against Hikvision's `HCNetSDK.h`
  (V6.1.x, Windows and Linux 64-bit) with the compiler's default packing. They
  have **not** been run in this repository's CI, because that needs the vendor
  library and a physical terminal. That is what `--selftest` is for, and why
  every uncertain read degrades to `unmapped` rather than a wrong value.
- Out-buffers (device info, alarm parameters) carry a deliberate reserve: a
  struct larger than the vendor's is harmless, a smaller one is memory
  corruption.
- Nothing here holds a licence key or bypasses anything: it is Hikvision's own
  SDK, used the way iVMS-4200 uses it.
