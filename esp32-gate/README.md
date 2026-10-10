# EstateMate ESP32 gate controller

An ESP32 that **is** the gate. It reads a Wiegand card reader or keypad, checks the card against its own copy of the estate's credentials, pulses the door relay, and reports each decision to EstateMate. It needs no PC.

It signs in as a **dedicated EstateMate device agent** and uses the same agent protocol as the Windows, Linux and Android bridges. That keeps it within the project's single automatic transport (`AGENTS.md`): it is not a new device-to-Cloudflare path, and it never contacts a Hikvision terminal.

| File | What it is |
| --- | --- |
| `EstateMateGate/EstateMateGate.ino` | The sketch. This is the canonical source: the portal serves this exact file (via the generated `src/esp32-gate-sketch.ts`), and the host tests compile it. |
| `host-test/` | Arduino/ESP32 stand-ins plus a scripted fake Worker, so the real sketch compiles and runs under `g++` with AddressSanitizer and UBSan (`npm run test:esp32-gate`). |
| `host-test/fixtures/` | The event documents the sketch sends. `test/esp32-gate.test.ts` posts the same files to the Worker, so both sides are checked against one contract. |

## Setting one up

1. **Device agent → Add agent**, and set **Runs on** to **ESP32 gate controller**. Each gate gets its own agent. Never share one with a bridge: downloading the config replaces the agent's secret.
2. **Terminals & devices → Register device**: add the gate. Any model name works, for example `ESP32 Wiegand controller`.
3. **Device agent → Connect terminal**: choose that terminal and the ESP32 agent. **Any LAN address will do, and you can leave the password empty: the sketch never dials it.** Linking is what gives the gate its EstateMate device ID. Without it, the config download contains an `#error` that explains this, and no secret is rotated. One ESP32 agent serves exactly one terminal, and the portal refuses a second link.
4. On the agent row, choose **Download ESP32 sketch** (no secret; Managers can download it too) and **Download ESP32 config** (`secrets.h`, Administrator-only; rotates the agent secret).
5. Put both files in one folder named `EstateMateGate`. In `secrets.h`, enter the Wi-Fi name and password and set `ESTATEMATE_WIFI_CONFIGURED` to `1`. The sketch refuses to compile until you do.
6. In the Arduino IDE 2, install the **esp32 by Espressif Systems** core (2.0.x or 3.x) and the **ArduinoJson** library (7.x). Select your board and upload. The agent shows **online** within a minute.

`secrets.h` contains the agent secret. Keep it on the computer that flashes the board, and keep it out of Git and shared drives. Downloading the config again rotates the secret, and any board flashed with the old file stops being accepted.

## Wiring (defaults; override any of them in `secrets.h`)

| Signal | GPIO | Notes |
| --- | --- | --- |
| Wiegand D0 / D1 | 26 / 27 | Most readers drive 5 V, so use a level shifter or a resistor divider. |
| Door relay | 25 | Active HIGH (`ESTATEMATE_RELAY_ACTIVE_HIGH`). Pulsed for `ESTATEMATE_DOOR_OPEN_MS` (3000 ms). |
| Exit button | 33 → GND | Internal pull-up. `-1` disables it. |
| Reader LED / beeper | off | `ESTATEMATE_READER_LED_PIN` / `ESTATEMATE_READER_BUZZER_PIN`, active low. |

Supported Wiegand frames: 26- and 34-bit cards with parity checking, other lengths from 26 to 64 bits read as raw data, and keypads in 4-bit or 8-bit burst mode (`*` clears, `#` submits). The decimal number the reader produces is the card number. Leading zeroes are ignored when matching, so a reader's `1234` matches a card stored as `0000001234`. The serial monitor (115200 baud) prints every card it reads, so you can compare it with the number in the portal.

## How it decides

- **Cards** are checked against a local snapshot of the estate's active cards from `credential-snapshot`. The first refresh downloads the full snapshot, streaming it to flash page by page and swapping it in only after the last page arrives. Later refreshes are deltas, sent every 2 minutes and whenever a card operation arrives. A delta is applied only once all of it has arrived, and its removals take revoked cards out. The snapshot is saved to flash, so after a restart the gate works straight away, even offline.
  - A controller that has never loaded a snapshot denies every card (`cache_not_ready`).
  - A failed refresh keeps the previous snapshot.
  - Cards with an expiry need a set clock (NTP). Without one they are denied with `clock_not_set`. Cards without an expiry work regardless.
  - Capacity is 8,000 cards on a plain ESP32 and 100,000 on a PSRAM board. If a full snapshot is larger than that, it is refused with an explicit error in the heartbeat rather than loaded partially.
- **Visitor PINs** arrive as the normal `upsert_visitor` / `revoke_visitor` operations and are stored on the board. A PIN opens the door only inside its validity window. The typed PIN never leaves the controller: events name the visitor's employee number only. Five wrong PINs within a minute lock the keypad for a minute (`too_many_attempts`). Visit counts stay an EstateMate-side rule, as they are for terminals.
- **Portal door commands** (Remote door control) are carried out on the relay: momentary open, close, remain open, remain closed and resume. The door mode survives a restart. *Remain closed* refuses cards and PINs.
- **The exit button always opens the door, in every mode**, for life safety.
- **Person and fingerprint work** is not advertised in the heartbeat, so the Worker never routes it here. Anything unexpected is answered with a clear failure, never silently dropped.

## What the portal sees

- **Heartbeat** (every 60 s): the terminal is reported as `stream: up` (the controller *is* the gate), and the snapshot health and last decision use the same `remoteVerify` shape the Remote Network Verification panel reads.
- **Events**: each card, PIN and exit-button event is sent as an `AccessControllerEvent` document with the controller's verdict attached (`remoteVerification.decision/reason/doorResult`). Gate activity therefore shows who was let in, who was refused and why. Up to 64 events are buffered while offline; the newest are kept and dropped ones are counted.

## Changing the sketch

Edit `EstateMateGate/EstateMateGate.ino`, then run:

```bash
npm run build:esp32-sketch   # regenerates src/esp32-gate-sketch.ts
npm run test:esp32-gate      # host compile + tests (needs g++; fetches ArduinoJson 7.4.2)
npx vitest run test/esp32-gate.test.ts
```

`test/esp32-gate.test.ts` fails if `src/esp32-gate-sketch.ts` drifts from the sketch. If you change the event document, update `host-test/fixtures/` as well; both test suites read those files.

**Not verified on hardware in this repository.** The sketch is compiled and exercised on the host against stand-in Arduino APIs. Nothing here has been compiled with the Xtensa toolchain or run on a board. Flash it to a bench ESP32 with a reader and relay before trusting a gate to it.
