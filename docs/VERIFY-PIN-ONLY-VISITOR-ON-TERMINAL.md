# On-site check: PIN-only visitor accounts (bridge 0.4.1+)

This is the bench checklist for the change in **PR #49** (`5ef5080`), first
shipped in [`bridge-0.4.1`](https://github.com/barikblog/estatemate-minmoe/releases/tag/bridge-0.4.1).
It is written to be run by a human standing next to a terminal, with the bridge
host in front of them.

> **Status when this file was written: unverified on hardware.** Every claim in
> the change is CI-verified — Node bridge integration tests, the 117-check
> Android JVM protocol suite, and the Windows bundle/MSI/exe smoke tests are all
> green — but **no physical terminal has been provisioned by this code**. Until
> the checklist below is completed and its result recorded in
> `docs/AI-HANDOFF.md` and the matching `docs/device-profiles/*.md`, treat the
> PIN-only visitor flow as promising and unproven.

## What changed, in one paragraph

A visitor used to be provisioned on the terminal as a **card** record
(`CardInfo`, card type `normalCard`). Real terminals rejected that body with
`Invalid Content` / `badJsonContent` / `employeeNo`. From 0.4.1 a visitor is a
**finite `UserInfo` account and nothing else**: employee number, name,
unassigned group (`belongGroup: ""`), `userType: normal`,
`localUIRight: false`, an enabled start/end validity window, and the pass PIN
as `password` (4–8 digits; the portal always generates 6). Hikvision
`belongGroup` takes numeric group IDs, not a department label; the initial
implementation's `Company` value caused real terminals to reject the account
with `badJsonContent / belongGroup` and has been corrected in both bridges.
Both the Node and Android bridge stopped writing visitor `CardInfo`, fingerprint,
face, door-right and right-plan records. `revoke_visitor` deletes the **person**
account (`UserInfoDetail/Delete`, `UserInfo/Delete` fallback) instead of a card,
which is what frees the terminal slot.

## Before you go on site

- [ ] The estate's terminal model and firmware, and its profile file in
      `docs/device-profiles/` (create one from `README.md` in that folder if the
      model has none).
- [ ] The bridge host: **Windows PC** on the device LAN, or an **Android
      phone/tablet** on the estate Wi-Fi. Pick one — do not run two agents
      against the same terminal.
- [ ] Portal access as **Administrator** (agent registration and setup download
      are Administrator-only).
- [ ] Each terminal's LAN IP, ISAPI port (usually 80) and an ISAPI
      administrator username/password.
- [ ] One real visitor phone number, so you can issue a genuine pass and read
      its PIN.

Download the release assets from
<https://github.com/barikblog/estatemate-minmoe/releases/tag/bridge-0.4.1>:

| Asset | Use |
|---|---|
| `estatemate-bridge-0.4.1-win-x64-installer-kit.zip` | **Recommended Windows install.** Unzip, double-click `Install-EstateMate-Bridge.cmd`. |
| `estatemate-bridge-0.4.1-win-x64.msi` | All-users Windows installer; adds *Start Menu → EstateMate Bridge* (the dashboard). |
| `estatemate-bridge-win-x64.exe` | Portable single file — no install, no Node.js. |
| `estatemate-bridge-0.4.1.apk` | Android bridge. |
| `estatemate-isapi-agent-win-x64-bridge-0.4.1.zip` | Self-contained Windows agent bundle (ships its own Node.js). |

Verify the download against the matching `SHA256SUMS.txt` before running it.

## 1. Register the agent in the portal

1. Sign in as Administrator → **Device agent** → **Add agent**. Name it after
   the host; the agent record is platform-neutral (`windows`/`linux` both work).
2. Copy the **Agent ID** and the one-time secret. They are shown once, and stay
   available in the row afterwards via **Copy ID**.
3. **Connect terminal** for each terminal: LAN IP, port, ISAPI username,
   password.
4. In the agent row, **Download setup**. The `.ps1`/`.sh` already carries the
   agent id, secret and Worker URL, so nothing has to be retyped on the host.

## 2. Install on the bridge host

### Windows

Pick one route. The installer kit is the one to prefer: it verifies the MSI
against its checksum, keeps a verbose log, explains its exit codes in English,
and falls back to a per-user install under
`%LOCALAPPDATA%\Programs\EstateMate Bridge` when Windows Installer is blocked.

```powershell
# Portable / already-installed case (no Administrator needed to run):
.\estatemate-bridge.exe setup            # point it at the downloaded .ps1
.\estatemate-bridge.exe check            # Worker + every terminal, one report
.\estatemate-bridge.exe install-service  # Administrator shell: start at boot
```

`check` is the pre-flight and the one command worth photographing: it
authenticates with the Worker, lists the devices the portal believes are linked,
and probes each terminal over ISAPI (device info, card API, alertStream). If a
terminal fails here, stop — nothing downstream will work either.

### Android

1. Install `estatemate-bridge-0.4.1.apk` (allow unknown sources for the
   installer).
2. Open **EstateMate Bridge** → **Paste installer** → paste the setup script
   text (agent id, secret, Worker URL fill in).
3. Fill the terminals block with the same JSON the Windows host uses
   (`isapiHost`, `isapiPort`, `isapiUsername`, `isapiPassword`, `protocol`,
   `enabled`, `eventStream`). The app asks the portal which EstateMate device
   sits behind that LAN address and fills the device id itself — look for
   `resolved EstateMate device id for … from the portal` in the log.
4. Press **Start**, then leave the device on power and Wi-Fi. The bridge runs in
   a foreground service and restarts after a reboot.

## 3. Confirm the host is actually running 0.4.1

This is the step people skip, and the whole check is worthless without it.

- Windows: `estatemate-bridge.exe version`, or **Status** in the dashboard.
- Android: the app's about/version line.
- Portal → **Device agent**: the agent row shows the version reported on the
  heartbeat (`0.4.1`) and **online** status, and its terminals should read
  **online**.

An agent still reporting `0.4.0` or earlier does **not** have this fix: it will
keep sending the old `CardInfo` body for visitors and keep getting
`Invalid Content` back.

## 4. The verification

Run this with a real pass, at one gate, with the terminal in front of you.

### 4a. Provisioning

1. Portal → **Visitors** → issue a pass (any resident, for the gate whose
   terminal is linked to this agent). Note the **6-digit PIN** and the
   credential number on the pass.
2. Within one poll interval (default `syncIntervalSeconds: 30`) the queued
   `upsert_visitor` should be claimed by the agent and applied.
   - **Pass:** **Hardware actions** has *no* new row for this operation (it was
     delivered by the agent, not left as an operator task), and the Visitors
     page device-account strip / `GET /api/visitors/device-accounts` shows
     `device_account_state: provisioned`.
   - **Fail:** the operation is in **Hardware actions** with the terminal's own
     error text, or the row sits `pending` because the agent is offline.

### 4b. What the terminal now holds

On the terminal's own menu (or its web client), find the person record for
employee number **`visitor<credential number>`** (passes issued before the alphanumeric-only rule show the legacy `visitor-<credential number>` shape) and confirm:

- [ ] name = the visitor's name;
- [ ] group is blank/unassigned (`belongGroup: ""`); `Company` is not a valid ISAPI group ID;
- [ ] user type = **normal** (not administrator);
- [ ] validity start/end match the pass window (finite, not long-term);
- [ ] local UI right = off;
- [ ] a password/PIN is set;
- [ ] **Card: Not added. Fingerprint: Not added. Face: Not added.**

The last line is the point of the change and is expected, not a defect: the
visitor is now an account, not a card.

### 4c. The PIN at the keypad

1. Enter the pass PIN on the terminal keypad and confirm with the key this model
   uses (commonly `#`; **check the model's profile file** — do not assume).
2. **Pass:** the terminal authenticates the visitor.
3. Enter a wrong PIN (e.g. `000000`): it must be **denied**.

Record which of the two happened, and the exact terminal wording.

### 4d. Expiry releases the slot

1. Wait for the pass window to close (for a bench test, issue a 1-hour pass).
   The per-minute cron queues `revoke_visitor` for **every** enabled terminal;
   the agent applies it on its next poll.
2. **Pass:** the person record is gone from the terminal, the pass reads
   `device_account_state: removed`, and the same PIN from 4c is now **denied**.
3. **Fail:** a **Hardware actions** row appears, or the record survives — see
   below.

## 5. The open question this check must answer

Write the answer down before you call this done:

> **Does a PIN-only visitor account actually open the door?**

`0.4.1` deliberately sends **no `doorRight` and no `RightPlan`** for a visitor.
For *residents* the bridge always sends them, because its own code comment
records that a person stored without them "exists but is authorised for
nothing — the card is recorded, the door does not open." That reasoning was
never re-tested for the visitor case. So the plausible outcomes are:

- the terminal accepts the account **and** a valid PIN opens the door
  (some firmware applies a default right to a normal user); or
- the account is created and the PIN authenticates, but **no door opens**,
  because nothing granted this person a door.

If it is the second, the fix is a Worker/agent change to send door rights for
visitors too — **not** an on-site workaround, and not something to paper over by
re-adding a card record. Record the outcome in `docs/AI-HANDOFF.md` and in the
model's `docs/device-profiles/` file.

## 6. When it fails

| Symptom | Meaning | Where to look |
|---|---|---|
| `visitor PIN must contain 4 to 8 digits` | the operation payload carried no usable PIN | Worker → operation payload; the pass row's `pin` column |
| `visitor validUntil must be after validFrom` | pass window is empty or inverted | the pass's validity columns |
| `Invalid Content` / `badJsonContent` | the terminal rejected a `UserInfo` field; `badJsonContent / belongGroup` specifically means an invalid group value (the bridge must send `""`, not `Company`) | bridge log; the operation result quotes the terminal's `statusString`, `subStatusCode` and `errorMsg` |
| `notSupport` on all three JSON URLs, then XML also refused | firmware does not implement `UserInfo/Record` at all | the model's device profile; fall back to the terminal's own menu until evidence exists |
| Operation stays `pending` | the agent is not polling | portal agent row (offline after 3 minutes without a heartbeat) |
| A **Hardware actions** row instead | no live agent linked to that terminal | link the device to an agent, or apply the instruction by hand |

Windows log: `%ProgramData%\EstateMate\logs\bridge.log` (set
`logLevel: debug` in `agent-config.json` and re-run `check` to capture full
ISAPI bodies). Android: the on-screen live log.

Never port-forward ISAPI to reach the terminal for this. If you need remote
access to the estate LAN, use the Cloudflare Tunnel kit in
[`CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md) —
remote *human* access only, never an event or card path.

## 7. Record the result

- [ ] Append the outcome to the `bridge-0.4.1` section of `docs/AI-HANDOFF.md`
      and flip it from "CI-verified only" to what the terminal actually did.
- [ ] Add the firmware evidence to the model's `docs/device-profiles/*.md`
      (including whether the PIN opens the door).
- [ ] If a model behaves differently, say so there rather than changing the
      bridge: the rule in `AGENTS.md` is that no model is marked
      production-supported without per-model evidence.
