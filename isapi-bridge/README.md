# EstateMate Hikvision ISAPI Bridge

The ISAPI bridge is a small Node.js agent that runs on the same LAN as Hikvision access devices. It does two things, both over ordinary outbound HTTPS to the Cloudflare Worker:

1. **Applies card, person, fingerprint and visitor operations** — polls the Worker for pending operations (created when a card is issued, a person is edited, a facility fee expires, an operator captures a fingerprint, etc.) and applies them to the physical device via Hikvision ISAPI (HTTP Digest). Since bridge `0.3.0` the same poll also carries the *person record* every credential belongs to, and the **fingerprint templates** themselves.
2. **Streams real-time access events** — holds one persistent `GET /ISAPI/Event/notification/alertStream` connection per device and forwards every swipe/alarm to the Worker in small batches, giving Gate activity latency of a few seconds without relying on the terminal's HTTP Listening push.

It replaced and removed the former transports — direct HTTP Listening, the Render free relay, Hikvision cloud/OpenAPI and the dedicated ISUP SDK gateway (migration `0013_agent_only_transports.sql`). `manual_sync` remains as the auditable fallback for devices not linked to an agent.

ISAPI bridge uses the device's documented ISAPI endpoints (`/ISAPI/AccessControl/CardInfo/...`, `/ISAPI/Event/notification/alertStream`) which are available on most K1T, K26xx, K27xx/K28xx controllers when accessed from the LAN. It does **not** require the proprietary SDK.

For off-site support access to the terminals and this host, see [`../docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](../docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md): a Cloudflare Tunnel on the Zero Trust Free plan routes the estate LAN to enrolled admins over WARP, publishing nothing. The agent never uses that tunnel, and an access device cannot dial into one.

> **Security:** Keep ISAPI devices and this bridge on the same VLAN. Never expose ISAPI (port 80/443) to the Internet. The bridge config contains secrets — restrict file permissions to Administrators / 0600.

## Architecture

```
Cloudflare Worker (D1, Queue)
  ├── POST /api/isapi/v1/agents/:id/heartbeat
  ├── GET  /api/isapi/v1/agents/:id/operations  (card / person / fingerprint / visitor / door ops,
  │                                              with the transient fingerprint template when one is needed)
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
- The stream also carries the terminal's keep-alive heartbeat (`eventType` **videoloss** with `eventState` **inactive**, per Hikvision's general-application ISAPI guide). It is counted as stream activity — a *connected* stream that goes silent for 90 s is logged, because a half-open TCP socket looks alive — but never forwarded as a gate event; the Worker drops it defensively as well, so an older agent cannot file a bogus `videoloss` entry. The rules are in [`../docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](../docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md#event-stream-protocol-the-agent-relies-on).
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


## People and fingerprints (bridge 0.3.0+)

A terminal stores a card *against a person*: the ISAPI employee number. Field
reports (and Hikvision's own integrators) are consistent that a person added
without `doorRight`/`RightPlan` exists and is authorised for nothing — the card
is recorded, the authentication succeeds, the door does not open. So the bridge
writes the person first, then the credentials:

| Operation | What the bridge sends |
|---|---|
| `upsert_person` | `POST /ISAPI/AccessControl/UserInfo/Record?format=json` with `{UserInfo:{employeeNo,name,userType,Valid,doorRight,RightPlan,localUIRight,gender}}`. A terminal that already holds the employee number answers a rejection, so the bridge falls through to `PUT …/UserInfo/Modify?format=json` and then `PUT …/UserInfo/SetUp?format=json`. XML is used only when the JSON URL is unsupported. |
| `delete_person` | `PUT /ISAPI/AccessControl/UserInfoDetail/Delete?format=json` — the person **and** their cards, fingerprints and permissions. Falls back to the narrower `PUT …/UserInfo/Delete?format=json` when the firmware does not implement the detail call. |
| `upload_fingerprint` | `POST /ISAPI/AccessControl/FingerPrint/SetUp?format=json` with `{FingerPrintCfg:{employeeNo,enableCardReader:[1],fingerPrintID,fingerType:"normalFP",fingerData,checkEmployeeNo}}`. `fingerData` is the Base64 template read from another terminal; it arrives with the operation and is never written to the bridge log or to disk. |
| `delete_fingerprint_device` | The same call with `deleteFingerPrint: true`. The terminal answers success even when the slot was already empty. |
| `capture_fingerprint` | `POST /ISAPI/AccessControl/CaptureFingerPrint?format=json` with `{CaptureFingerPrintCond:{fingerNo}}`. The terminal arms its own reader; while nobody is touching the glass it answers "no fingerprint", so the bridge re-arms every 5 s (up to ~100 s) and keeps its heartbeat fresh in between. When the finger is read it returns the Base64 template, which is reported back to the Worker. |

`doorRight` and `RightPlan` are always sent, with the door numbers of the
terminal's access points (door 1 when the estate has not recorded any). Without
them the person is stored and cannot open anything — that is the bug this
behaviour exists to prevent.

### Capabilities

Every heartbeat advertises what this bridge can actually do, probed against the
terminals it serves:

```json
{ "capabilities": ["card", "door", "person", "fingerprint"] }
```

The Worker only hands a bridge the work it advertises. A bridge that sends
nothing (every build before 0.3.0) keeps receiving card, visitor and door
commands exactly as before, and person/fingerprint work is queued for an
operator instead of failing silently on a terminal that cannot take it. The
probe is cached for ten minutes and runs in the background — it can never delay
the heartbeat. `card` and `door` are always claimed: those endpoints have been on
every terminal EstateMate has been tested against.

### What the firmware has to support

- Person records: `UserInfo/Record`, `Modify`, `SetUp`, `Delete` and
  `UserInfoDetail/Delete` on K1T/K26xx/K27xx/K28xx controllers. A missing URL is
  detected (`404`/`405`/`501` or `notSupport`/`invalidURL`/`invalidOperation`) and
  the portal keeps the manual instruction instead of showing a failed command.
- Fingerprint **capture** (`CaptureFingerPrint`) and **write**
  (`FingerPrint/SetUp`) are documented on the access-control terminals, but the
  firmware that implements them varies. The bridge probes
  `/ISAPI/AccessControl/CaptureFingerPrint/capabilities` and
  `/ISAPI/AccessControl/FingerPrintCfg/capabilities` before advertising
  `fingerprint`, and a terminal that refuses the call is reported with the
  terminal's own words. The portal then says so and queues the manual enrolment
  (slot + employee number) — it never pretends the finger was captured.

Knobs (environment, mainly for testing): `ESTATEMATE_CAPTURE_RETRY_MS`
(default `5000`) and `ESTATEMATE_CAPTURE_MAX_MS` (default `100000`).

## ZKTeco terminals on the PUSH (ADMS) transport (bridge 0.4.0+)

A ZKTeco access terminal does not answer ISAPI, and — more importantly — it does
not answer *inbound* anything. Its "PUSH" protocol (vendor name: *Attendance /
Security PUSH Communication Protocol*; on the terminal's menu it is **ADMS**,
"Cloud Server", "Cloud Sync" or "iClock Proxy") is plain HTTP that **the terminal
initiates**, for every request in both directions. The bridge therefore hosts a
listener and the terminal calls it:

| The terminal does | The bridge answers |
| --- | --- |
| `GET /iclock/cdata?SN=..&pushver=..&options=all` | `OK` (register yourself) or `registry=ok` + configuration |
| `POST /iclock/registry?SN=..` | `OK`, and the terminal's own parameters are remembered |
| `POST /iclock/cdata?SN=..&table=ATTLOG` | `OK`, and the punch is queued as a gate event |
| `GET /iclock/getrequest?SN=..` | `C:<id>:DATA UPDATE USERINFO PIN=..` — or `OK` when idle |
| `POST /iclock/devicecmd?SN=..&Return=0&ID=..` | `OK`, and the queued operation is finally **applied** |

Consequences that shape how you use it:

- **A command cannot be forced out.** Work is queued and travels on the
  terminal's next poll (`RequestDelay`, which this bridge sets to 5 s). A bridge
  that is up and a terminal that is asleep look the same until it calls in, so an
  unconfirmed write is reported as *queued*, never as applied.
- **Applied means `Return=0`.** Anything else is carried back to the portal with
  the terminal's own meaning attached (`-1002` is "your syntax was wrong",
  `-1004` is "this model has no such table") — not a timeout, and not a shrug.
- **`Realtime=1`** is set in the configuration the bridge returns, so a punch
  travels when it happens instead of on the protocol's two-minute default.

### Enable it

```jsonc
// agent-config.json
{
  "zktecoPush": {
    "enabled": true,
    "port": 8089,               // 0 lets the OS choose, which is what the tests do
    "bindAddress": "192.168.1.20", // loopback default: see the security note
    "ackTimeoutSeconds": 180,
    "requireAgentKey": false,
    "agentKey": ""
  }
}
```

```jsonc
// isapi-devices.json — a PUSH terminal has no host, because nothing dials it
{
  "estateMateDeviceId": "33333333-3333-4333-a333-333333333333",
  "name": "Palmerie Gate ZKTeco",
  "transport": "zkteco_push",
  "pushSerial": "0123456789"     // optional: the SN= the terminal reports
}
```

Then in the terminal's own menu, point **Comm > Cloud Server / ADMS** at
`http://<bridge address>:<port>` with no path (the bridge serves `/iclock/…`
itself), and set **TransInterval** low or leave real-time on. On a bridge bound to
loopback, that means the terminal and the bridge are on one host — which is fine
for a Raspberry-Pi-on-the-gate setup and useless otherwise.

`pushSerial` is optional and deliberately not required: the terminal tells the
bridge its serial when it registers, and an estate with **one** PUSH gate gets it
bound automatically (the log says so). With two or more unbound gates nothing is
guessed — a serial is never attached to whichever entry happens to come first,
because that is how a resident ends up with a card on the wrong door. Write
`pushSerial` on each entry and the ambiguity is gone.

### The numeric-PIN rule (read this before blaming the bridge)

A ZKTeco terminal identifies a person by **User ID** (`PIN`). Most firmware stores
*digits only*: the terminal declares whether it can hold a string User ID at
registration, in the parameter `StringPinFunOn` (§7.4: "Specify whether to support
the string-type user ID"). EstateMate's Employee ID, by contrast, defaults to the last 30 hex characters
of the person's UUID, i.e. it can still contain **letters**.

So for a numeric-only terminal the bridge **refuses the write** and says why,
naming the fix:

> this terminal only accepts a numeric User ID (StringPinFunOn=0), and the
> EstateMate Employee ID "a1b2c3d4…" contains letters. Set a numeric Employee ID
> for this person, or enable alphanumeric User IDs on the terminal if its firmware
> supports them

Refusing is the whole point. Truncating, hashing or substituting would file a
person under a number that belongs to somebody else at the gate — the failure this
project already refuses for card numbers — and a gate that opens for the wrong
resident is not a bug an operator can diagnose from a log. **Fix it in the
portal**: give the resident a numeric Employee ID (People → Edit → Employee ID),
or turn on the terminal's alphanumeric User ID option if that model has it, then
sync again.

### What this transport does and does not do

| Work | Over PUSH, today |
| --- | --- |
| Gate events (card/PIN punch, `table=ATTLOG`) | **Yes** — attributed by the terminal's User ID |
| Add / update a person (`DATA UPDATE USERINFO`) | **Yes**, once `Return=0` |
| Issue or update a card | **Yes** — a card rides on the person record |
| Remove a person (`DATA DELETE USERINFO`) | **Yes** — and it takes their templates with it |
| Revoke **one card** while keeping the person | **No.** The protocol has no card-only delete; the person delete would strip their fingerprints and face too, so the task stays queued with that explanation |
| Fingerprint capture / template delivery | **No** — the terminal's own reader and menu remain the way |
| Remote open/close | **No** — `CONTROL BOARD` is documented but unproven here, and EstateMate does not ship an unproven gate command |
| Visitor slots with a `visitor…` Employee ID | **No**, on a numeric-PIN terminal — same rule as above |

### Security

The protocol authenticates a terminal to a server with nothing but a serial
number, so this listener is LAN-only by default (`bindAddress: 127.0.0.1`).
Binding `0.0.0.0` is supported for a real gate on another host and logs a warning
every start; the rules in `AGENTS.md` still apply — never publish it, never put
it behind the Cloudflare Tunnel, and treat the agent host as part of the
access-control trust boundary. `requireAgentKey` + `agentKey` adds a shared
secret that the bridge checks on `Key=` for firmwares that send it. A serial no
configured device claims gets `OK` (so the terminal stops retrying in a loop) and
**no commands at all**, and every upload it tried to make is counted in the
heartbeat as `unmappedUploads` so the gap is visible from the portal.

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

- Issue a test card in portal → **Access cards & fingerprints** → create. A card operation is claimed by the agent, and so is the person record it belongs to; a fingerprint is claimed only when the terminal's bridge advertises the `fingerprint` capability, and otherwise appears as an operator task.
- Check **Hardware actions** — status should be `pending` (not `manual_action_required`) when device uses ISAPI pattern.
- On agent host, check logs: `C:\EstateMate\ISAPI-Agent\logs\` or journalctl.
- After ~30s, operation should be claimed and applied via ISAPI, then status becomes `applied`.
- Verify on device web UI: Access Control → Card Management → card exists.

### 5. ISAPI endpoint reference (model dependent)

The card path is JSON-first, and the terminal's answer decides whether a fallback
is worth trying — see
[`../docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](../docs/ISAPI-BRIDGE-AND-WINDOWS-AGENT.md#terminal-protocol-the-card-path-relies-on)
for the behaviour the agent depends on.

- `POST /ISAPI/AccessControl/UserInfo/Record?format=json` — create the PIN-only visitor account with employee ID, name, Company department, `userType: "normal"`, enabled finite `Valid`, `localUIRight: false` and a 4-to-8-digit `password`.
- `PUT /ISAPI/AccessControl/UserInfo/Modify?format=json` — update an existing visitor account. Attempted only when `Record` reports the employee number already exists (`employeeNoAlreadyExist`); any other content rejection is reported with the terminal's own reason, never as a misleading `employeeNoNotExist` follow-up. `UserInfo/SetUp` is the combined add/edit compatibility path.
- `PUT /ISAPI/AccessControl/UserInfoDetail/Delete?format=json` — delete the expired/revoked visitor account (`UserInfo/Delete` fallback).
- `POST /ISAPI/AccessControl/CardInfo/Record?format=json` — add a resident/dependant card. Visitor provisioning does not call a `CardInfo` endpoint.
- `PUT /ISAPI/AccessControl/CardInfo/Modify?format=json` — update a card the terminal already holds (a duplicate `Record` is an error, so re-enable/re-issue lands here)
- `PUT /ISAPI/AccessControl/CardInfo/Delete?format=json` — delete a resident/dependant card; the body must be `{"CardInfoDelCond":{"CardNoList":[{"cardNo":"…"}]}}`. A bare `{"CardNoList":[{"CardNo":"…"}]}` is answered `Invalid Format / badJsonFormat`.
- `GET /ISAPI/AccessControl/CardInfo/Record?format=json` — list cards
- `GET /ISAPI/System/time/Get?format=json` — read the terminal's system time (clock sync only; JSON-first with the XML URL fallback).
- `PUT /ISAPI/System/time/Set?format=json` — set the terminal's system time to the bridge host's wall clock, body `{"time":{"date":"YYYY-MM-DD","time":"HH:MM:SS","timeType":"local"}}`.
- Some firmware implements only the XML form: the same URLs without `?format=json` and with the ISAPI namespace on the corresponding root element (`UserInfo`, `CardInfo`, `time`, or the delete condition). The agent tries XML **only** when the JSON URL is unsupported (404/405/501 or `notSupport`/`invalidURL`/`invalidOperation`), never after a content rejection.
- A 2xx is not proof of success: some firmware answers 200 with a `ResponseStatus` whose `statusCode` is not 1 (OK). Success is `statusCode == 1`.

Test manually:
```bash
curl -i http://192.168.1.100/ISAPI/System/deviceInfo --digest -u admin:password
curl -i -X PUT --digest -u admin:password \
  -H 'Content-Type: application/json' \
  'http://192.168.1.100/ISAPI/AccessControl/CardInfo/Delete?format=json' \
  -d '{"CardInfoDelCond":{"CardNoList":[{"cardNo":"10000001"}]}}'
```

## Troubleshooting

- **401 Unauthorized**: Check ISAPI username/password, device allows digest auth, IP not blocked.
- **No operations**: Device not linked to agent, or connection pattern still `manual_sync`. Set it to `isapi_bridge` / `windows_agent` and link it.
- **Operation stuck in sent**: Agent not reporting result. Check agent logs, network to Cloudflare, secret.
- **Visitor PIN rejected**: Verify the `UserInfo` validity window, normal-user access configured on the terminal, and the 4-to-8-digit PIN. EstateMate deliberately does not send visitor door-plan or card fields.
- **Card not opening door**: the resident/dependant card is on the terminal but the *person* is not, so the employee number has no door rights. Since bridge 0.3.0 the person record is written first (`UserInfo/Record` with `doorRight`/`RightPlan`) and the portal's **Person sync** page shows which terminal still says `missing` for that person. On a terminal with no linked bridge (or a pre-0.3.0 bridge) the same page lists the work as an operator task.
- **Fingerprint capture says the terminal cannot do it**: the firmware refused `CaptureFingerPrint`. Open **Hardware actions** and enrol the finger on the terminal's own menu in the slot the task names; the portal records it and sends it to the other terminals the next time a template is held.

## Visitor PIN-account lifecycle

The Hikvision path sends one `UserInfo` record containing only the terminal-editor
fields: EstateMate's issued employee number, visitor name, department `Company`,
normal-user/non-administrator settings, enabled finite start/end validity, and the
4-to-8-digit visitor PIN in `password`. No visitor `CardInfo`, fingerprint, face,
door-right or right-plan field is sent. At expiry or manual revocation, the bridge
deletes the `UserInfo` account so the person slot is available again.

The validity window is stated in the **estate's local time** — `YYYY-MM-DDTHH:mm:ss`
with `timeType: "local"`, no `Z` — using the timezone the Worker sends with every
visitor operation (new and reconciled alike), so the window the terminal enforces
against its own clock is the window the portal shows. A payload without a readable
zone (an operation queued by an older Worker) keeps the UTC form. The Android bridge
sends the same window and follows the same error rules.

## Terminal clock sync (opt-in)

A terminal enforces everything time-sensitive with its **own clock**: a visitor's
finite pass window is checked against the terminal's hardware at the moment of the
swipe, and gate events carry the terminal's timestamp. A terminal that drifts hours
from the estate rejects a live visitor pass early, honours a dead one late, and
files its gate history at the wrong moment — none of it visible from the portal,
because nothing was asking the terminal what time it thought it was.

With `"timeSync": { "enabled": true }` the bridge:

1. reads each terminal's system time (`/ISAPI/System/time/Get`) at startup and
   every `checkIntervalMinutes` (default 15, minimum 1);
2. measures the offset against the **bridge host's clock** — the reference every
   other decision on the estate LAN already trusts;
3. when the offset exceeds `maxDriftMs` (default 30 000, minimum 5 000), sets the
   terminal's clock back to the bridge's wall clock (`/ISAPI/System/time/Set`,
   `timeType: "local"`), then re-reads to confirm and reports the confirmed drift;
4. carries the per-terminal state on the heartbeat, where the Worker stores it on
   the device row and the portal's **Access control devices → Terminal clocks**
   shows the reported time, the drift, the last check and the last sync.

Two operational assumptions, stated rather than hidden:

- **The bridge host is the reference.** If the office PC's own time is wrong, set
  the PC's time — this feature makes the terminals agree with the estate, it does
  not make the estate right.
- **The terminal's timezone must match the bridge host's.** The sync aligns wall
  clocks. A terminal configured to a different zone shows up as a constant offset
  in the portal and belongs re-zoned at the terminal, not "corrected" into a wrong
  wall clock by the bridge.

A failed read keeps the last good reading plus the error (a terminal that just
went down must not erase the last known clock from the portal). Off by default:
no `timeSync` key means no clock traffic at all, and a heartbeat without a clock
entry leaves the stored value alone, so every existing estate behaves exactly as
before.

Turning it on is an estate decision, and every writer agrees on what "on" means:
the Windows dashboard's **Configuration** tab has a **Terminal clock sync**
checkbox, the interactive `setup` wizard asks, and the CLI accepts
`--time-sync-enabled=true|false` — the checkbox and the flag both reach
`agent-config.json` through the one writer, `setup`, which preserves the
`maxDriftMs` / `checkIntervalMinutes` thresholds the configuration already had.
A fresh setup defaults to off.

> **Android bridge:** the Android bridge does not run the clock check — it records
> the deviation in `../bridge-apps/android/README.md` rather than porting a
> background clock loop to the service. A terminal served only by an Android
> bridge simply never reports a clock, which the portal shows as "no report yet".

## License

MIT. Ensure compliance with Hikvision ISAPI usage and local data-protection laws.
