# App artifacts and product naming

The product is **Sornix EstateOS** (formerly EstateMate). Everything a person
*downloads* is now named for the product. Everything a machine has *already
stored* on an estate's PC, phone or Worker keeps its original name, because a
rename there is not a rename at all — it is a new install, a broken upgrade or a
service that no longer starts.

This page is the contract. Read it before changing an artifact name, and change
the table here in the same pull request.

## What the release publishes now

Every artifact below comes from `.github/workflows/bridge.yml` on a `bridge-*`
tag.

| Family | File (current) | Was | Built by |
|---|---|---|---|
| Android client (residents, staff, admin) | `sornix-estateos-android-<ref>-debug.apk`, and `-release.apk` when the keystore secrets are set | `estatemate-android-<ref>-debug.apk` | `apps/android` (Gradle), collected in the `android-apk` job |
| Windows desktop app | `sornix-estateos-desktop-<version>.msi` | `estatemate-client-<version>.msi` | `scripts/package-client-msi.mjs` + `client-apps/windows/estatemate-client.wxs` |
| Android bridge APK (the on-site phone/tablet agent) | `sornix-estateos-bridge-<version>.apk` | `estatemate-bridge-<version>.apk` | `scripts/build-bridge-apk.py` |
| Windows bridge executable (portable) | `sornix-estateos-bridge-win-x64.exe` | `estatemate-bridge-win-x64.exe` | `scripts/package-bridge-exe.mjs` |
| Windows bridge MSI | `sornix-estateos-bridge-<version>-win-x64.msi` | `estatemate-bridge-<version>-win-x64.msi` | `scripts/package-bridge-msi.mjs` + `bridge-apps/windows/msi/estatemate-bridge.wxs` |
| Windows installer kit | `sornix-estateos-bridge-<version>-win-x64-installer-kit.zip` | `estatemate-bridge-<version>-win-x64-installer-kit.zip` | `scripts/package-bridge-msi.mjs` |
| Windows agent bundle (Node runtime + agent) | `sornix-estateos-isapi-agent-win-x64-<ref>.zip` | `estatemate-isapi-agent-win-x64-<ref>.zip` | `windows-agent-bundle` job |
| Agent setup script from the portal | `sornix-estateos-isapi-agent-<id8>.ps1` / `.sh` / `.pi.sh` | `estatemate-isapi-agent-<id8>.*` | `src/index.ts` (`Content-Disposition`), linked by `apps/web/src/App.tsx` |

## What deliberately keeps the EstateMate name

These are install contracts, not marketing. An estate that already runs the
bridge upgrades in place, and every command printed in this repository, in the
dashboard and in support scripts keeps working.

| Kept | Where it lives | Why |
|---|---|---|
| `estatemate-bridge.exe`, `C:\Program Files\EstateMate Bridge`, PATH + App Paths entry, boot task/service name, `EstateMateBridge.exe`/`.ps1`/`.cmd` dashboard, Start Menu **EstateMate Bridge** | `bridge-apps/windows/msi/estatemate-bridge.wxs`, `scripts/package-bridge-msi.mjs`, `scripts/package-bridge-exe.mjs` | The MSI's upgrade path, the registry key paths, the service identity and the documented commands all name it. Renaming would orphan a running agent. |
| `%ProgramData%\EstateMate` (agent config, device credentials, logs) | agent runtime | Configuration must survive an upgrade; a new path means re-setup on site. |
| `estatemate-isapi-agent.cmd`, the `estatemate-isapi-agent` systemd unit (`src/pi-bridge-setup.ts`) | shipped agent hosts | Same reason: a systemd unit name is a published contract on the estate's Pi. |
| Android bridge application id `com.estatemate.bridge`, launcher label **EstateMate Bridge**, Java package, class names | `bridge-apps/android/**` | Android treats a new application id as a different app: the operator would have to uninstall and re-pair the phone. |
| Android client application id `com.estatemate.app`, Kotlin package `com.estatemate.app.*`, database `estatemate.db`, encrypted prefs `estatemate_session` | `apps/android/app/**` | Same reason, plus the session and cached gate history must survive an update. The **visible** name is Sornix EstateOS (`res/values/strings.xml`). |
| Desktop app launcher `EstateMate.vbs`, portal address file `estatemate-url.txt`, browser profile `%LOCALAPPDATA%\EstateMate\Window` | `client-apps/windows/**` | The VBScript reads those names; the profile keeps the signed-in session across the rebrand. The **installed product name, folder and shortcuts** are Sornix EstateOS. |
| Worker name, D1 database `estatemate-db`, hostname `estatemate.estatemate.workers.dev`, GitHub repository slug | `wrangler.jsonc`, `.github/workflows/deploy.yml` | Deploying under a new Worker name creates a *second* deployment with an empty database. This is infrastructure identity. |

## The rule for the next rename

1. **Filenames follow the product.** If a person downloads it, it is named
   `sornix-estateos-*`.
2. **Installed identity does not move without a migration.** Application ids,
   install folders, registry keys, service/task/unit names, config and profile
   paths and the Worker name change only with a tested upgrade path — otherwise
   the estate re-installs by hand on site.
3. **User-visible strings follow the product** (`strings.xml`,
   `AndroidManifest.xml` label, WiX `Product`/`Feature` names, shortcut names,
   installer messages).
4. **Never ship both spellings of a download.** The kit's `install-bridge.ps1`
   accepts either MSI filename because kits are copied between people, but the
   release itself publishes one name per file.
5. **The docs are part of the change.** Update this table, `README.md`,
   `bridge-apps/*/README.md`, `windows-agent/README.md` and
   `docs/VERIFY-PIN-ONLY-VISITOR-ON-TERMINAL.md` in the same commit.

## Verifying a release carries the new names

```bash
# the two client artifacts (built by CI, listed in the release)
gh release view bridge-0.4.12 --json assets --jq '.assets[].name'
```

CI asserts the identity of what it builds, so a wrong label cannot reach a
release page:

* `scripts/verify-android-apk.py --app-label "Sornix EstateOS"
  --application-id com.estatemate.app` fails the Android job if the APK is
  labelled anything else, or if the Worker URL did not reach `BuildConfig`.
* `apps/android/tools/make-launcher-icons.py --check` fails the build when an
  icon the generator produces is missing, wrongly sized, or a leftover from a
  previous brand (`--strict`, which also compares pixels, runs as a warning
  because FreeType builds hint glyphs slightly differently).
* The MSI installation step in `.github/workflows/bridge.yml` installs the
  desktop app and looks for the **Sornix EstateOS** shortcuts in the Start Menu
  and on the Desktop before uninstalling it again.
