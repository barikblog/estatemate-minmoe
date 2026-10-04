# ZKTeco PUSH (ADMS) — transport capability record

**Not a device profile in the sense this folder usually means.** The convention in
[`README.md`](./README.md) is one file per *tested model and firmware build*. This
file records the **transport** EstateMate speaks to ZKTeco-class terminals over,
because the constraints that matter here come from the protocol and from EstateMate's
own identity rules, not from one board revision. Per-model files (e.g.
`SpeedFace-V5L-RFID_ZAM180-Ver1.1.17.md`) still need writing, and each one must
record what this file cannot: which of the below its firmware actually honours.

| | |
| --- | --- |
| Transport | ZKTeco **PUSH** protocol — vendor titles: *Attendance PUSH Communication Protocol* / *Security PUSH Communication Protocol*; on a terminal it is **ADMS**, "Cloud Server", "Cloud Sync" or "iClock Proxy" |
| EstateMate code | `isapi-bridge/zkteco-push.mjs` (codec), `isapi-bridge/zkteco-push-server.mjs` (listener + operations), wired in `isapi-bridge/agent.mjs` |
| Introduced | bridge `0.4.0`, 2026-10-04 |
| EstateMate hardware status | **No physical ZKTeco terminal has been driven by this code.** Everything below is either vendor-documented or implementation-confirmed by others. See [Verification](#verification--read-this-first). |
| Profile key | `zkteco_push` (`src/hikvision-profiles.ts`) — event normalisation only; it never authorises a write |

## Verification — read this first

Three different claims are kept apart on purpose:

1. **Documented by the vendor.** The ZKTeco *Security PUSH Communication Protocol*
   (PUSH protocol 3.1.2, doc v2.3, January 2021) describes the endpoints, the
   registration parameter list and the command formats quoted below.
2. **Confirmed on real firmware by others.** The endpoint set, the `C:<id>:<command>`
   wire format, the `Return=` codes and two firmware-level refusals are recorded as
   verified on **SpeedFace-V5L-RFID** and **ZAM180-NF (Ver 1.1.17)** by
   [`s0x90/zkteco-adms`](https://github.com/s0x90/zkteco-adms), and the same
   request/response shapes are reimplemented independently by
   [`skylinebiz/adms`](https://github.com/skylinebiz/adms) (which notes eSSL
   firmware speaks the same protocol) and
   [`msaied/zkteco`](https://root.packagist.org/packages/msaied/zkteco).
3. **Tested by EstateMate.** Only the protocol-level behaviour in CI:
   `npm run test:isapi-bridge` executes
   [`isapi-bridge/zkteco-push.integration.mjs`](../../isapi-bridge/zkteco-push.integration.mjs)
   (14 checks against a simulated terminal over a real socket) and
   [`isapi-bridge/agent.zkteco-push.integration.mjs`](../../isapi-bridge/agent.zkteco-push.integration.mjs)
   (9 checks against the agent's own configuration, binding, capability
   advertisement, event buffer and operation dispatcher). A simulated terminal
   proves the bridge speaks the specification. It proves nothing about a board.

`msaied/zkteco` states the residual risk plainly, and it applies to this bridge
too: the **write** path of this protocol "rides on best-effort wire layouts that
have not yet been pinned against real hardware". First bench session, see
[Bench checklist](#bench-checklist-for-the-next-engineer).

## What the transport is

Plain HTTP with ASCII bodies, in which **the terminal initiates every request**,
including the ones carrying a command from the server. Vendor doc §2, "Features":
*"All actions, such as data upload and command delivered by the server, are all
initiated by the client."* There is no inbound port on the terminal and no
terminal-side API to poll. The bridge is a server; the terminal is a client that
decides when it calls.

```
GET  /iclock/cdata?SN=<serial>&pushver=3.1.2&options=all   §7.1 initial interaction
POST /iclock/registry?SN=<serial>                          §7.4 device parameters
POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=9999     §10 uploads
GET  /iclock/getrequest?SN=<serial>                        §11.1 cached commands
POST /iclock/devicecmd?SN=<serial>&Return=0&ID=<n>&CMD=…  §10.4 command result
```

### Initial interaction (§7.1)

`GET /iclock/cdata?…&options=all` on the **first** contact is answered `OK` when
the serial is unknown — which is the terminal's cue to register. Once registered
the same request must return the registry code and the configuration, or the
terminal falls back to its own defaults:

```
registry=ok
RegistryCode=<up to 32 bytes>       ServerVersion / ServerName / PushProtVer
ErrorDelay=30                        RequestDelay=5
TransInterval=1                      TransTables=User Transaction
Realtime=1                           SessionID=<hex>   TimeoutSec=10
```

`Realtime=1` is set deliberately: the documented default uploads on a
**2-minute** interval, which turns a gate event into an attendance record.
`RequestDelay=5` bounds how long a queued command waits before the terminal picks
it up, and it is why an operation on a sleeping terminal reads as *queued* rather
than *failed*.

### Registration (§7.4)

`POST /iclock/registry?SN=…` with a comma-separated `key=value` body. Keys may be
`~`-prefixed (optional, sent only when the firmware sets it); EstateMate strips the
tilde, as the field-confirmed implementations do. Parameters EstateMate reads:
`DeviceType` (`acc` / `att`), `DeviceName`, `MachineType`, `FirmVer`,
`PushVersion`, `MAC`, `IPAddress`, `LockCount`, `ReaderCount`, `~MaxUserCount`,
`~MaxAttLogCount`, `~MaxUserFingerCount`, **`StringPinFunOn`** (below), plus
`IsSupportQRcode` / `QRCodeEnable` for a future pass.

```
DeviceType=acc,~DeviceName=SpeedFace-V5L-RFID[TI],FirmVer=ZAM180-Ver1.1.17,PushVersion=3.1.2,StringPinFunOn=0,~MaxUserCount=3000,LockCount=1
```

## The numeric-PIN rule

**Rule.** A ZKTeco terminal's person key is its **User ID** (`PIN`), and by default
that is **digits only, no leading zero**. The terminal declares whether it can hold
a string User ID in the registration parameter `StringPinFunOn` — vendor doc §7.4:
*"Specify whether to support the string-type user ID."* A terminal that does not
report `1` is treated as numeric-only, **including the case where it says nothing
at all** (an absent flag is not read as permission; a gate that opens for the wrong
person is worse than a refused write).

Corroborated by ZKTeco's own platform docs: ZKBioSecurity's personnel parameters say
*"The Personnel No. contains only numbers by default but may also include letters"*
and instruct the installer to *"check whether the current device supports the
maximum length and whether letters can be used in personnel ID"*. A model manual is
sharper still: *"By default, the device supports 1 to 14 digits of User ID."* Note
that last clause — **14 digits is common, and 32 is not a promise**. Where a
terminal reports a width (`MaxPinWidth`/`PIN2Width`), that width wins over
EstateMate's 32-character cap.

**Why this is not a detail.** EstateMate's Employee ID is `1–32` characters of
`[A-Za-z0-9._-/]` (`src/employee-id.ts`) and **defaults to the person's UUID minus
hyphens — 32 hex characters, i.e. full of letters**. That shape is built for
Hikvision ISAPI, where it is exactly right. Handed to a `StringPinFunOn=0`
terminal it is a value the device cannot store. The three tempting responses are
all wrong:

| Temptation | Why it is refused |
| --- | --- |
| Truncate to 32 → pad/strip to fit | Two residents collapse onto one User ID; the second one's card opens the gate for the first |
| Hash the ID into digits | The terminal's number no longer matches anything in the portal, so a cardless event cannot be attributed and an operator cannot read the device's own screen and find the person |
| Write `1` and hope | The exact bug PR #38 exists to prevent |

**So the bridge refuses, and names the fix** — `validateTerminalPin()` in
`zkteco-push.mjs`, reachable from the operation dispatcher so no operation can
bypass it:

> this terminal only accepts a numeric User ID (StringPinFunOn=0), and the
> EstateMate Employee ID "a1b2c3d4e5f6…" contains letters. Set a numeric Employee
> ID for this person, or enable alphanumeric User IDs on the terminal if its
> firmware supports them

Operator action: **People → Edit → Employee ID**, set digits, re-sync. Or enable
the terminal's alphanumeric User ID option where the model has it. Attribution
then works unchanged: the ATTLOG `PIN` equals the person's Employee ID, exactly as
`employee_no` does on the Hikvision path.

**Accepted consequence, recorded so nobody re-litigates it:** visitor credentials
composed as `visitor-<n>` (`deviceEmployeeNo('visitor', …)`) are **never storable**
on a numeric-only terminal, so visitor card issuance to a ZKTeco gate fails with the
message above rather than half-working. The follow-up is a per-device numeric alias
map, which needs a D1 migration and a Worker-side change — not an agent-side
substitution — and is deliberately out of scope for 0.4.0.

## Commands the bridge sends

| Operation | Command | Notes |
| --- | --- | --- |
| `upsert_person`, `upsert_card`, `enable_card`, `upsert_visitor` | `DATA UPDATE USERINFO PIN=…\tName=…\tPri=0\tCard=…\tGrp=1\tTZ=0000000100000000\tVerify=0\tEnable=1` | §12.1.1. A card **rides on the person record**; there is no separate card table to write. `TZ` 1 is the always-granted schedule: a person with no TZ entry is a person who cannot open a door at 03:00. `Enable=0` is how a suspended person is written. |
| `delete_person` | `DATA DELETE USERINFO PIN=…` | §12.1.2: *"including fingerprint template, face template and user photo"* — the delete is **not** card-scoped, which is the reason for the row below it |
| `disable_card`, `delete_card`, `revoke_visitor` | **refused** | No card-only delete exists in this protocol. Issuing the person delete to "remove one card" would strip that resident's fingers and face as collateral damage, so the task stays queued with that explanation instead |
| `upload_fingerprint`, `capture_fingerprint`, `delete_fingerprint_device` | **refused** | Templates are documented (`FINGERTMP`) but this bridge neither reads a reader nor delivers an unverified template; the terminal's own menu stays the way in |
| `remote_*` door commands | **refused** | `CONTROL BOARD` is documented and unproven here. Per `AGENTS.md`, a gate command is not shipped against a model this folder cannot vouch for |

Three wire-format refusals that come from field reports, not from taste:

- **`USER ADD` / `USER DEL` are not used.** They appear in some ADMS datasheets and
  real firmware answers **`-1002`** (invalid syntax).
- **`DATA DEL USERINFO` is not used.** Truncating the verb also fails; `DELETE` is
  written in full.
- **Identity fields are never rewritten.** A `Name` carrying a tab or a line break
  would open a second record — or a second command — so the write is refused
  outright (`PushFieldError`) rather than sanitised into a name the portal no longer
  shows.

`Return=` handling: `0` → applied. `-1` → not supported / no data. `-2` → file
operation failed. `-1002` → terminal refused to parse it. `-1004` → this table or
feature is not on this model. Anything else is reported with the code, and
**delivered-but-unanswered is reported as still queued**, never as applied: a
terminal that fetched a command and died is not a success.

## Events in

`table=ATTLOG` arrives as one record per line, either `key=value` pairs separated
by tabs or the positional form `PIN\tTime\tStatus\tVerifyMode\tWorkCode` (§10.2).
EstateMate accepts both shapes because both are seen in the field. Each record is
turned into the access-event document the Worker already normalises, keeping `PIN`
as `employeeNoString` so cardless events stay attributable, and `Status` /
`WorkCode` are preserved raw on the record so a later firmware pass can decode
event codes without inventing them.

**Time zone behaviour.** The terminal sends local wall-clock (`2026-10-04
08:15:00`) and the protocol's time-zone handling (`MachineTZFunOn`, `TimeZone=` in
the configuration response) is **not** honoured by this bridge yet: EstateMate reads
the timestamp in the **bridge host's** zone and stores UTC. A bridge on the estate's
zone is correct; a bridge in UTC serving a +01:00 gate slides every event by an
hour. Recorded here because it is invisible until somebody reconciles a gate feed
against a paper book. `IsTempDevice`-style expiry dates and `DateFmtFunOn` are
likewise not decoded.

**Certificate behaviour:** none to speak of — this is HTTP, not HTTPS, and no
payload is encrypted. The protocol's optional key-exchange steps (§7.2/§7.3,
"Exchange Public Keys"/"Exchange Factors") and `authKey` are **not implemented**.
That is safe only under the existing rule: keep the bridge and the terminals on one
LAN, never publish the listener, never route it through the Cloudflare Tunnel.

## Offline behaviour

There is nothing to retry against: the bridge cannot reach out. A terminal that is
offline shows up as (a) no `getrequest` poll, and (b) the agent's own heartbeat
`unmappedUploads`/`commandsUnconfirmed` counters, and (c) commands accumulating in
the per-serial queue up to 200, after which the bridge **refuses to queue more**
with an explicit message rather than dropping the oldest. On return, the terminal
drains its backlog in order. There is no per-terminal online/offline probe from the
bridge side — the bridge is passive, so "when did this gate last call in"
(`lastSeenAt`) is the only liveness signal the transport itself provides.

## The Android-bridge deviation

**`AGENTS.md` requires: "Keep the Node and Android bridge implementations
equivalent." This capability deliberately breaks that rule, and the break is
recorded here rather than left as a silent gap.**

`bridge-apps/android` is client-only by construction. Its own header describes the
design: *"a foreground service that runs the same three loops … heartbeat … poll
the Worker … hold one alertStream per terminal"*, a foreground service *"because
Android otherwise suspends the sockets when the screen locks"*, plus a partial wake
lock because *"without it Doze freezes the process"*. There is no
`ServerSocket`/listener anywhere in the app (the only `HttpServer` in that tree is
`tools/ProtocolTest.java`, a test double). The PUSH transport needs the exact
opposite: a **long-lived inbound listener an access terminal dials**.

Consequences, stated as decisions:

1. The ADMS listener ships on the **Node agent only** (`isapi-bridge`, and with it
   `windows-agent` and the MSI, since the Windows service re-exports `agent.mjs`).
2. The Android bridge **does not** gain ZKTeco support in 0.4.0. It does not
   advertise `person` for a PUSH terminal it cannot serve, because it cannot serve
   one.
3. An estate whose only bridge is an Android tablet **cannot use a ZKTeco gate**.
   The device profile is not the place a silent misconfiguration should end up, so
   this is a documentation answer today and should become a **portal/validation
   answer** in the follow-up: when a device carries the `zkteco_push` profile, the
   agent-linking UI should require a Node/Windows agent and say why.
4. Keeping them equivalent later means either (a) a foreground-service listener on
   Android, which fights OEM battery managers and still requires the terminal to
   route to a DHCP'd phone, or (b) an ADMS **relay** the phone polls. (b) is the
   honest design; it is also a protocol change and must not be invented from a
   phone. Do not close this item by copying the Node file into Kotlin.

## Windows deployment gap (found while wiring this up)

The bridge previously made only outbound connections, so **nothing in the
installer opens a listening port**, and Windows Defender Firewall will drop
terminal → bridge by default. A bench test will see a terminal stuck at
"connecting" with a healthy-looking bridge. Until the MSI owns this, the required
step on the bridge host is:

```
netsh advfirewall firewall add rule name="EstateMate ZKTeco PUSH" dir=in action=allow protocol=TCP localport=8089
```

Scope for the next session: add the rule to `install-bridge.ps1` **only** when
`zktecoPush.enabled` is true, and make `bridge check` (the dashboard's self-test)
report the listener's bind address and whether a test request reaches it.

## Bench checklist for the next engineer

Nothing here can be settled from the specification. Each answer belongs in a
per-model file in this folder, not in this one:

1. Does the model register at all against a LAN bridge, and does it accept
   `registry=ok` + configuration without a `RegistryCode` it recognises?
2. `StringPinFunOn` — is it actually reported, and what does `MaxPinWidth` say?
   14 digits is documented as a common default; EstateMate assumes nothing wider.
3. Does `DATA UPDATE USERINFO … Card=` make the terminal open the door for that
   card **on the model in hand**, and does `Enable=0` hold?
4. What does the firmware answer for a card-only removal — is there any way to
   drop a card without the person delete (`-1004` vs a real alternative)?
5. `Realtime=1` — is a punch pushed within a second, or is `TransInterval` obeyed
   anyway?
6. Time: does the terminal obey the `Date` header (§7.1 calls it out as the
   synchronisation mechanism), and how far off does an unadjusted clock drift?
7. After 40+ hours of polling, does the connection leak, and does the bridge's
   `lastSeenAt` remain usable as liveness?
8. Does the queue-overflow refusal (200) survive a terminal that returns after a
   long outage without duplicating applied commands?

## Sources

- ZKTeco, *PUSH SDK — Security PUSH Communication Protocol*, PUSH protocol 3.1.2,
  doc v2.3, January 2021 — §2 Features, §4–§5, §7.1, §7.4, §9–§11.1, §12.1.1,
  §12.1.2, Appendix 2/3/13. Archived copy consulted:
  <https://pdfcoffee.com/securitypushcommunicationprotocol-pdf-free.html>
- ZKTeco, *Attendance PUSH Communication Protocol*, 2020-03-25 — `DATA
  UPDATE/DELETE/QUERY USERINFO`, `FINGERTMP`, `BIOPHOTO` field lists.
- [`s0x90/zkteco-adms`](https://github.com/s0x90/zkteco-adms) — endpoint set,
  `C:<id>:<command>` format, `Return=` meanings, and the `-1002` refusals of
  `USER ADD` / `DATA DEL`, confirmed on SpeedFace-V5L-RFID and ZAM180-NF
  Ver 1.1.17.
- [`skylinebiz/adms`](https://github.com/skylinebiz/adms) — Node/TS ADMS server;
  eSSL shares the protocol; atomic `ATTLOG` batch handling.
- [`msaied/zkteco`](https://root.packagist.org/packages/msaied/zkteco) — PHP
  implementation; the "write path not pinned against real hardware" caveat.
- ZKBioSecurity V5000 2.0.0 user manual — personnel ID length/letters are
  device-dependent.
- A ZKTeco *G4[QR]* model manual — "By default, the device supports 1 to 14 digits
  of User ID"; default TCP COMM port 4370 for the **pull** protocol (which this
  bridge does not implement: no `standalonecomm`, no 4370 socket).
