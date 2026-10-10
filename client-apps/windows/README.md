# EstateMate desktop app (Windows)

`estatemate-client-<version>.msi` is the Windows app for residents, staff and
administrators. It opens the EstateMate portal in its own window, with a Start
Menu and a Desktop shortcut and the same sign-in as the website.

## Install

1. Double-click `estatemate-client-<version>.msi`.
2. Open **EstateMate** from the Start Menu or the Desktop.
3. Sign in with your portal email and password.

It installs for the signed-in user only, so no administrator rights are needed.
Files go to `%LOCALAPPDATA%\Programs\EstateMate`. The app window keeps its own
browser profile under `%LOCALAPPDATA%\EstateMate\Window`. Uninstalling removes
the program and the shortcuts, but leaves that profile in place.

## How it works

- `EstateMate.vbs` opens the portal address from `estatemate-url.txt` with
  Microsoft Edge (installed with Windows 10 and 11), then Google Chrome, using
  `--app` so the window has no address bar. If neither is found, it opens the
  default browser instead.
- The portal address is baked in at build time (default: the production Worker
  URL in `.github/workflows/bridge.yml`). Change it with `--url` when building.

## Build

```bash
node scripts/package-client-msi.mjs --out artifacts/client --version 0.4.6 --commit "$(git rev-parse HEAD)"
```

The MSI is built on Windows with the WiX Toolset v3 (`candle` and `light`). On
other systems use `--dry-run` to stage the payload and print the WiX commands.
The `client-msi` job in `.github/workflows/bridge.yml` builds the MSI on
`windows-latest`, installs and uninstalls it, and publishes it on `bridge-*`
tags.

Note: the app is an app-style window around the web portal, not a separate
native client. Browser updates and portal updates apply without reinstalling.
