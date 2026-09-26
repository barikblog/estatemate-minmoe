# EstateMate Bridge for Android

`estatemate-bridge-<version>.apk` turns a phone or tablet on the estate LAN into
the bridge between the Hikvision access-control terminals and the EstateMate
Worker. It is the Android twin of `estatemate-bridge-win-x64.exe`: same agent
key, same Worker endpoints, same ISAPI requests, so the portal shows the estate
online either way.

Install it on the device, paste the credentials from the portal, press **Start**,
and put the device somewhere with power and Wi-Fi. The app keeps the bridge in a
foreground service, restarts it after a reboot, and shows the live log on screen.

## Installing

1. **Portal** — sign in as Administrator → *Device agent* →
   **Add agent** (platform `windows` or `linux`; the agent record is
   platform-neutral) → copy the **Agent ID** and the one-time secret, both shown
   in the panel that appears (and afterwards in the *Agents* table,
   with **Copy ID** in the row actions). Then **Connect terminal** for each
   terminal, entering its LAN IP, port, ISAPI username and password.
2. **Portal** — with the agent row selected, **Download setup** and copy the
   `.ps1`/`.sh` text to the phone (email, chat, USB, anything).
3. **Phone** — install the APK (Allow unknown sources), open **EstateMate
   Bridge**, press **Paste installer** and paste the script: the agent id, the
   secret and the Worker URL are filled in. Then fill the terminals block with
   the same JSON the Windows host uses:

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

   There is nothing else to copy: the app asks the portal which EstateMate device
   is behind that LAN address and fills in the id itself (the log says
   `resolved EstateMate device id for "Main Gate MinMoe" from the portal: …`).
   `estateMateDeviceId` may still be set explicitly — it is the **EstateMate
   device ID** in the portal, the `device_id` column of *Device agent →
   Connected terminals*, with **Copy ID** in the row actions — and a
   device the portal has not linked to this agent is reported by name instead of
   failing later with queued operations.
4. **Phone** — **Save**, then **Test connection** (it reports the Worker, every
   terminal's model and firmware, and any terminal the portal has not linked to
   this agent yet), then **Start bridge**.
5. **Phone** — press **Battery settings** and allow the app to run without
   battery optimisation, otherwise Android suspends the sockets when the screen
   is off for a while and gate events arrive late.

The status line under the title shows the bridge state, the number of forwarded
events and the last error; the log below it is the same history `adb logcat`
receives under the tag `EstateMateBridge`.

## What it does

* holds one persistent `GET /ISAPI/Event/notification/alertStream` connection per
  terminal (multipart or bare-JSON firmware) and forwards events to the Worker in
  batches of up to 50, buffering up to `eventBufferLimit` documents while the
  network is down;
* polls the Worker every `syncIntervalSeconds` for queued operations and applies
  them over ISAPI with HTTP Digest: `upsert_card` / `enable_card` (JSON first,
  XML fallback), `disable_card` / `delete_card` (PUT `CardInfo/Delete`),
  `upsert_visitor` (XML `tempCard`);
* heartbeats every `heartbeatIntervalSeconds` with the same stats payload the
  Windows host sends, so the portal's agent row looks identical — including the
  per-terminal alertStream state (`devices: [{ deviceId, stream, lastError }]`),
  which is what promotes a terminal to **online** as soon as its stream is open
  instead of leaving it on `pending` until the first card is swiped;
* reconnects with a 5 s → 60 s backoff and keeps running across reboots.

The app is deliberately plain Java against the platform APIs only (no Kotlin, no
AndroidX, no native code, no Gradle). That is what makes the APK reproducible
without Android Studio, and it keeps the APK at a few tens of kilobytes.

## Building

```bash
# 1. Protocol tests only (no SDK needed: ecj + any JRE)
python3 scripts/build-bridge-apk.py --only-test \
    --ecj /tmp/tools/tools-minapk/tools/ecj-3.45.0.jar \
    --java /tmp/tools/jdk4py/jdk4py/java-runtime/bin/java

# 2. The APK (SDK tools discovered from ANDROID_HOME, or passed explicitly)
python3 scripts/build-bridge-apk.py --test \
    --out artifacts/android --version-name 0.2.0 --version-code 200 \
    --android-jar "$ANDROID_HOME/platforms/android-35/android.jar" \
    --aapt2 "$ANDROID_HOME/build-tools/35.0.0/aapt2" \
    --d8 "$ANDROID_HOME/build-tools/35.0.0/d8" \
    --apksigner "$ANDROID_HOME/build-tools/35.0.0/apksigner" \
    --keystore <keystore> --keystore-password <pw> \
    --key-alias <alias> --key-password <pw>
```

`--only-test` compiles the Android-free protocol layer plus
[`tools/ProtocolTest.java`](tools/ProtocolTest.java) and runs it against live
local HTTP servers: Digest challenge/response, deviceInfo and card-count parsing
for JSON and XML firmware, the three card operations including the XML fallback,
both alertStream parsers across chunk boundaries, and the whole Worker API. It is
the fastest way to know the protocol still matches the terminals before building
anything.

The build always signs: `.github/workflows/bridge.yml` uses the release keystore
when `ANDROID_KEYSTORE_*` secrets exist and otherwise generates a throwaway debug
key (an unsigned APK cannot be installed at all).

## Troubleshooting

| Symptom | Fix |
|---|---|
| “cannot start: agent secret is missing or too short” | The portal rotates the secret each time you download an installer; paste the newest one. |
| “UNAUTHORIZED (HTTP 401)” in the log | Same cause: a stale secret. |
| A terminal reports “ISAPI username or password rejected (HTTP 401)” | Wrong ISAPI credentials, or the account is locked on the terminal. |
| “cannot reach 192.168.x.x:80” | Wrong VLAN/host, device offline, or the phone is on mobile data instead of the estate Wi-Fi. |
| Events arrive but the portal shows nothing | The terminal is not linked to *this* agent in the portal; run **Test connection**, it names the terminal. |
| The bridge stops overnight | Battery optimisation was not disabled for the app (step 5 above), or the device rebooted with the auto-start box unticked. |
| `adb install` says `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | The APK was built before signing; rebuild with `--apksigner`. |

Logs: the app's Log panel, and `adb logcat -s EstateMateBridge` for the same
lines with timestamps. The configuration the service reads lives in the app's
private directory (`/data/data/com.estatemate.bridge/files/agent-config.json` and
`isapi-devices.json`), so it can be exported from a rooted device or pulled with
`adb shell run-as com.estatemate.bridge cat files/agent-config.json`.
