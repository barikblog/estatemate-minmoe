# EstateMate — Offline Server for Android

The complete EstateMate estate-operations platform — the same React portal, the
same API, the same database, the same live feed, the same embedded ISAPI agent —
running as **one installable APK on a phone or tablet**, with no Internet
dependency and no PC on the estate.

The device becomes the estate's server. Every other phone, tablet or laptop on
the estate Wi-Fi opens `http://<device-ip>:8080/` in a plain browser; the
terminal events come in over ISAPI directly from the Hikvision access-control
hardware on the device VLAN.

```text
Browsers on the LAN ──HTTP──▶ WebServer (pure Java, port 8080)
                               │
                               ├── /api/*  ──▶ JsEngine: a hidden WebView running the
                               │               repository's actual Worker (src/index.ts,
                               │               bundled by esbuild) against:
                               │                 · SQLite (android.database.sqlite)
                               │                 · the file store in app-private storage
                               │                 · LiveFeedHub (WebSocket hub)
                               ├── anything else ──▶ StaticFiles: the React portal
                               │                      straight from APK assets
                               └── upgrades ──▶ Worker auth probe ──▶ LiveFeedHub
                                                        ({"type":"ready"} … batches)

Hikvision terminals ──ISAPI alertStream──▶ OfflineAgent (the bridge app's production
                        (HTTP Digest)       classes, pointed at this device's loopback)
```

Like the [Node offline LAN edition](../../local-server/README.md) and the cloud
deployment, only the *platform bindings* are replaced. Every line of product
code in `src/index.ts`, every migration, every role check, every audit trail
runs **unmodified** — it is bundled as-is by `scripts/bundle-offline-server.mjs`,
exactly what `bridge-apps/android-offline/server/adapter.test.mjs` proves
end-to-end against a mock Android bridge before every build:

| Cloud deployment | This APK |
|---|---|
| Cloudflare Worker + D1 | the Worker code in a WebView engine + `android.database.sqlite` (same `d1Exec` protocol as `local-server/d1.mjs`) |
| Cloudflare Queues | in-memory buffer; Java nudges `drainQueue()` (WebView timers are throttled in the background, Java timers are not) |
| `AccessLiveFeed` Durable Object | `LiveFeedHub`, a hand-rolled WebSocket hub, same wire protocol |
| Private GitHub storage | `NativeBridge.fileStore()` in the app's private directory, behind the same `api.github.com` REST slice |
| Hourly Cron (`15 * * * *`) | a Java timer at minute 15 calling `tickCron()` |
| ISAPI bridge agent on a PC | the bridge APK's own agent classes (`IsapiClient`, `AlertStreamReader`, `WorkerClient`, `BridgeConfig`), pointed at `http://127.0.0.1:8080` |

## Why a WebView?

Android has no Node.js, but its WebView is a complete Chromium: ES2021,
`fetch`, `Request`/`Response`, and WebCrypto (PBKDF2, HMAC, AES-GCM — the
Worker's whole security layer). The engine page is served from APK assets at
`https://localhost/` through `shouldInterceptRequest`: nothing leaves the
device, and an https origin on localhost is a **secure context**, which is what
makes `crypto.subtle` available.

## Setup

1. **Install the APK** (`adb install -r estatemate-offline-server-*.apk`, or
   side-load it) on an always-on device that stays on the estate Wi-Fi.
2. **Disable battery optimisation** for the app (Android Settings → Apps →
   EstateMate Server → Battery → Unrestricted). Without this Android will
   sleep the server overnight. Tick *Start the server when the device boots*
   in the app.
3. **Start the server** from the app and note the address it prints, e.g.
   `http://192.168.1.50:8080/`.
4. **Create the Administrator account**: the app shows the first-run
   *Administrator token*; open the portal on any LAN device (or *Open the
   portal on this device*) and use it once with the bootstrap flow, exactly
   like the Node offline edition. Then rotate it in the portal.
5. **Link the terminals**: in the portal, note the embedded agent's **Agent
   ID** and **Agent Secret** (the portal's agent screen), paste both into the
   app, and list the terminals as JSON, e.g.

   ```json
   [
     {"name": "Main gate", "isapiHost": "192.168.1.64", "isapiPort": 80,
      "isapiUsername": "admin", "isapiPassword": "terminal-password"}
   ]
   ```

   Save, restart the server, and the agent resolves each terminal's EstateMate
   device id from the portal (matching on LAN address, like the Windows
   bridge), opens one ISAPI `alertStream` per terminal with HTTP Digest, and
   starts forwarding events into the estate's own SQLite database.

## What runs where

| Piece | File |
|---|---|
| HTTP server (keep-alive, chunked bodies, 100-continue, upgrade hand-off) | `app/src/main/java/com/estatemate/offline/WebServer.java` |
| WebSocket hub (live feed) | `…/LiveFeedHub.java` |
| The estate engine (Worker in a WebView) | `…/JsEngine.java` + `server/adapter.js` |
| `Native` bridge object the engine calls | `…/NativeBridge.java` |
| SQLite + shared migrations + `d1Exec` protocol | `…/Db.java` (+ `SqlSplit.java` for the comment/quote-aware statement splitter) |
| Portal assets, ETags, SPA fallback | `…/StaticFiles.java` |
| The embedded ISAPI agent | `…/OfflineAgent.java` (reuses `bridge-apps/android/…/bridge/*`) |
| Foreground service, timers, wiring | `…/OfflineService.java` |
| Operator UI (status, token, agent config, log) | `…/MainActivity.java` |
| JVM test suite (HTTP + WebSocket + splitter) | `tools/OfflineServerTest.java` |
| JS↔Java protocol contract test (full user flow) | `server/adapter.test.mjs` |

## Building

```bash
# Prerequisites: npm ci (esbuild), the web portal built, and an Android SDK.
npm ci
npm run build:web

# 1. Engine contract test only (no SDK needed): builds the real bundle and
#    drives it through the estate's whole user flow over a mock bridge.
npm run test:offline-adapter

# 2. The APK (SDK tools discovered from ANDROID_HOME, or passed explicitly;
#    mirrors scripts/build-bridge-apk.py, including --test for the JVM suite)
python3 scripts/build-offline-apk.py --test \
    --out dist/android-offline --version-name 0.1.0 --version-code 10 \
    --android-jar "$ANDROID_HOME/platforms/android-35/android.jar" \
    --aapt2 "$ANDROID_HOME/build-tools/35.0.0/aapt2" \
    --d8 "$ANDROID_HOME/build-tools/35.0.0/d8" \
    --apksigner "$ANDROID_HOME/build-tools/35.0.0/apksigner" \
    --keystore <keystore> --keystore-password <pw> \
    --key-alias <alias> --key-password <pw>
```

CI builds it in `.github/workflows/bridge.yml` (job `offline-server-apk`, also
triggered by `offline-*` tags): Node 22 installs dependencies and runs the
adapter contract test, the portal is built, the JVM suite runs with the JDK the
runner supplies, and the APK is signed with the release keystore when the
`ANDROID_KEYSTORE_*` secrets exist — otherwise a throwaway debug key, exactly
like the bridge APK.

The APK embeds three asset groups (fail-fast checks enforce all of them):
`assets/portal/` (the built SPA), `assets/server/` (`boot.html` +
`server-bundle.js`), and `assets/migrations/` (the shared migration chain,
applied on first boot into the app's private SQLite database).

## Backups

The estate's data lives in the app's private storage
(`/data/data/com.estatemate.offline/`): `estatemate.db` plus `files/storage/`.
Use the portal's own backup/restore endpoints, or `adb backup` is not
available for this app (backup is disabled on purpose — the database holds the
estate's credentials); prefer the portal's export, or copy the database with
`adb root` on a debug device.

## Security notes

- **Cleartext traffic is enabled on purpose**: terminals speak HTTP on the
  isolated device VLAN, and the embedded agent talks to this device's own
  server over loopback HTTP. Keep the estate LAN private; never forward
  terminal ports or the server port to the Internet.
- All secrets (JWT signing, device ingest pepper, storage encryption, the
  first-run bootstrap token) are generated on-device with `SecureRandom` and
  never leave the device.
- The engine WebView loads only from APK assets (`https://localhost/`, served
  by `shouldInterceptRequest`); file and content access are disabled.
- Auth is the Worker's own: same password hashing, same JWTs, same audit
  trail, same agent keys as the cloud deployment.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Portal answers 503 "engine is still starting" | First boot compiles the bundle; wait a few seconds. If it persists, check the log panel — the renderer may have died and restarted. |
| "the web portal is not bundled" | The APK was built without `npm run build:web`; rebuild. |
| Agent says "not configured yet" | Agent ID, Agent Secret or the terminals JSON is empty; fill all three and restart the server. |
| "event stream error … HTTP 401" | Wrong ISAPI username/password, or the account is locked on the terminal. |
| Events arrive but the portal shows nothing | The terminal is not linked to this agent in the portal; check the device config screen. |
| Server stops overnight | Battery optimisation was not disabled (step 2 above). |
| Other devices cannot open the portal | The phone is on mobile data instead of the estate Wi-Fi, or the port was changed after start (restart the server). |

Logs: the app's log panel, and `adb logcat -s EstateMateOffline` for the same
lines.
