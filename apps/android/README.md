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
| Menu | The portal's grouped, role-aware menu (same groups and role rules as `navGroups` in `apps/web/src/App.tsx`). Lists for visitor passes, cards, terminals, staff, bills, maintenance, facility bookings, notices, documents and emergency contacts, each from its Worker list endpoint. Portal-only tools (residents, settings and imports) say so and point to the web portal. |
| Visitor passes | "New pass" — the portal's create form, field for field: visitor name and phone, the property (automatic when a resident has exactly one, picked when they have several, chosen for the resident by an operator), the estate's validity window from `/api/portal-config`, purpose of visit, visit times, remark, the gate ID-verification switch, the operator-only **preferred gate device** and **person type**, and the resident's **identity/invitation proof** uploads (the same `/api/files` + `proofKeys` flow the portal posts). The issued pass is the portal's own pass — QR code, Code 128 barcode, the Worker's six-digit PIN and unique number, validity window, purpose, remark, visit count and gate scope — rendered by `VisitorPass.kt`, the Android twin of `apps/web/src/pass-export.ts`. It opens right after issuing and again from any row's **View pass**, and can be shared as the portal shares it: 📤 Share image (PNG), 📄 Share PDF (one A4 page), 🖨️ Print. |
| Maintenance | "Report an issue" — the portal's scopes (personal, street, block, zone, estate) with the target named for street, block and zone, the property, and the description of the fault. |
| Facility bookings | "Book a facility" — active facilities with their capacity, hours, notice and fee rules; date plus start and end time, purpose, attendees and contact phone. Your own pending or approved booking can be cancelled from its row, and an operator can cancel any, each behind a confirm step. |
| Account | Name, role, gate, server address, sign out |

Creating these three records is matched field-for-field to the portal's own
forms and to the Worker's POST/PATCH routes, including the naive
`yyyy-MM-ddTHH:mm` datetimes it reads in the estate's timezone. When the Worker
refuses something — an overlapping booking, a window beyond the estate's
maximum, a missing property permission — its own `{ error }` wording is shown in
the form rather than an HTTP status code.

The visitor pass itself is drawn, not composed: `VisitorPass.kt` renders the same
900px card `apps/web/src/pass-export.ts` renders (palette, layout, wording, QR +
Code 128 of the unique number), and that bitmap is both what the dialog shows and
what "Share image"/"Share PDF"/"Print" hand on — PNG through a FileProvider, one
A4 page through `PdfDocument`, print through `PrintHelper`.
`test/client-visitor-pass-parity.test.ts` keeps the two renderers' words, palette
and form fields locked together: change one side without the other and the test
suite fails.

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
