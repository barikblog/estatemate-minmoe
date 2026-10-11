# Sornix EstateOS — Android client

The app residents, staff and administrators install on a phone: a Kotlin/Compose
client for the same Worker API the web portal uses. It is not the bridge (that is
`bridge-apps/android`, the app that talks to the Hikvision terminals) — this is
the app a person signs into.

* Installable artifact: `sornix-estateos-android-<version>-debug.apk`, built and
  published by `.github/workflows/bridge.yml` (`android-apk` job) on `bridge-*`
  tags (tag `bridge-0.5.0` → `sornix-estateos-android-0.5.0-debug.apk`). A signed `-release.apk` is produced when the `ANDROID_KEYSTORE_*`
  secrets are configured.
* Application id `com.estatemate.app` and the Kotlin package are deliberately
  unchanged, so an installed copy updates in place. The name under the icon is
  **Sornix EstateOS**. See [`docs/APP-ARTIFACTS-AND-NAMING.md`](../../docs/APP-ARTIFACTS-AND-NAMING.md).
* The Worker URL is baked into `BuildConfig.API_BASE_URL` at build time
  (`-PapiBaseUrl=…`, default the production Worker). The Account screen shows
  the address the build actually carries, which is the first thing support asks
  for.

## What works today

| Area | Screens |
|---|---|
| Sign-in | Email + password, encrypted token storage (Keystore-backed `EncryptedSharedPreferences`), session restore, expiry returns to sign-in with an explanation |
| Security officers | Gate selection when the officer is posted at more than one gate (`/api/auth/select-gate`), the chosen gate shown under the app name, gate-scoped gate activity |
| Overview | Role-aware dashboard cards (bills, visitors, cards, residents, maintenance, gate events, grace window), the latest estate notice with its acknowledgement state |
| Properties | Owned/rented properties, request an unowned unit, propose a new one, ownership approvals, tenancy nomination/approval/end, dependants and household approvals |
| Gate activity | Recent access events from the local Room cache, refreshed from `/api/access/events` |
| Account | Name, role, gate, server address, sign out |

Offline: the last fetched gate events stay readable (Room). Everything else
needs the network, and says so.

## Build

```bash
cd apps/android
./gradlew assembleDebug                     # needs JDK 17 + Android SDK 35
./gradlew -PapiBaseUrl=https://<worker>/ assembleDebug
```

Or let CI do it: push a `bridge-*` tag, or run the **Build EstateMate Bridge**
workflow manually and download the `android-apk` artifact.

The launcher icons are committed PNGs generated from one script, so the mark is
reproducible:

```bash
python3 apps/android/tools/make-launcher-icons.py           # regenerate
python3 apps/android/tools/make-launcher-icons.py --check   # CI gate: complete, sized, no stale icon
python3 apps/android/tools/make-launcher-icons.py --strict  # also require your machine's pixels
```

`--check` is the CI gate and stays green on any machine: it verifies every icon
the generator produces is committed, correctly sized and the right colour mode,
and that no leftover icon from a previous brand is lying around. `--strict` adds
pixel equality with *your* rasteriser (FreeType builds hint glyphs slightly
differently), so run it locally after changing the mark or the palette — CI runs
it too, but reports a mismatch as a warning rather than failing the build.

## Verify a built APK

```bash
python3 scripts/verify-android-apk.py app/build/outputs/apk/debug/app-debug.apk \
  --api-base-url https://estatemate.estatemate.workers.dev/ \
  --app-label "Sornix EstateOS" \
  --application-id com.estatemate.app \
  --build-tools "$ANDROID_HOME/build-tools/35.0.0"
```

It fails when the Worker URL did not reach `BuildConfig`, when the placeholder
host is still packaged, or when the app is labelled something other than the
product name.

## Release signing

`assembleRelease` signs only when **all** of `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` are
present; otherwise the Gradle build warns and produces `app-release-unsigned.apk`,
which the workflow deliberately does **not** publish. In CI the keystore arrives
as the base64 secret `ANDROID_KEYSTORE_BASE64`. Until a keystore is configured,
ship the debug APK: it is installable (debug-signed) and is what the release page
points people at.

Create the release keystore once and keep it — Android updates only install over
an app signed by the same key:

```bash
keytool -genkeypair -v -keystore release.jks -alias estatemate \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 release.jks   # -> the ANDROID_KEYSTORE_BASE64 repository secret
```

Then add `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` as repository secrets; the next
`bridge-*` tag publishes a signed `-release.apk` alongside the debug one. Never
commit the keystore (`.jks`/`.keystore` files are rejected by
`scripts/ci-checks.sh`).
