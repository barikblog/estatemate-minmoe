# EstateMate — Offline LAN Edition

The complete EstateMate estate-operations platform (the same React portal and
the same API as the Cloudflare deployment) running as **one always-on process
on your estate LAN, with no Internet dependency**, talking **directly to the
Hikvision access-control terminals** over ISAPI.

```text
Browser (any device on the LAN) ──▶ EstateMate offline server ──▶ D1 → local SQLite file
                                        │                              ▲
                                        ├── live feed WebSocket hub    │
                                        ├── hourly jobs               │
                                        └── embedded EstateMate agent──┘
                                              ISAPI alertStream (HTTP Digest)  ──▶  Hikvision terminals
                                              ISAPI card/visitor commands      ──▶  Hikvision terminals
```

Only the Cloudflare *bindings* are replaced — every line of product code in
`src/index.ts`, every migration, every role check, every audit trail runs
unmodified, so behaviour cannot drift from the cloud deployment:

| Cloud deployment | Offline LAN edition |
|---|---|
| Cloudflare Worker + D1 (SQLite) | Node 22 + a SQLite file under `local-server/data/` |
| Cloudflare Queues | in-process batch delivery to the same queue consumer |
| `AccessLiveFeed` Durable Object | `ws` WebSocket hub, same wire protocol |
| Private GitHub upload repository | local disk under `local-server/data/storage/` (the portal's "storage settings" simply name a folder here) |
| Hourly Cron (minute 15) | an in-process scheduler at minute 15 |
| ISAPI bridge agent on a PC → outbound HTTPS to the Worker | the **same agent** (`isapi-bridge/agent.mjs`), supervised by the server and pointed at its loopback address — it never leaves the LAN |
| Android app over HTTPS | the responsive portal in any LAN browser |

## Requirements

| | |
|---|---|
| Host | An always-on Windows PC on the estate LAN (the estate office PC is fine). Also runs on Linux, macOS and Android/Termux. |
| Software | [Node.js 22 LTS](https://nodejs.org/) (one-time install, online) |
| Network | Reachability to each terminal's ISAPI port (usually 80) on the LAN. No Internet required after setup. |
| Rights | Any user to run; Administrator once, to register the start-at-boot task and firewall rule. |

## Five-minute setup (Windows PC)

**Once, while you still have Internet** (on the estate PC or any other
machine — the finished folder can then be copied to the estate PC and never
needs the Internet again):

```powershell
git clone <this repository> C:\estatemate       # or download and extract a zip
cd C:\estatemate
npm ci                                           # installs dependencies (Internet)
npm run build:web                                # builds the portal (apps/web/dist)
```

**On the estate PC:**

```powershell
cd C:\estatemate
node local-server\server.mjs                     # first boot creates config.json + secrets
```

The first boot prints a one-time **bootstrap token** and the portal URLs
(`http://<pc-lan-ip>:8080`). Then:

1. **Create the Administrator** — open the portal in a browser on the LAN,
   choose *Create the first administrator* and enter the bootstrap token.
2. **Register the terminal** — Administrator → *Access control* → add the
   terminal (model, gate, direction; connection *isapi bridge / EstateMate
   agent*).
3. **Add the agent** — Administrator → *Device agent* → **Add agent** (name it
   after the PC, platform `windows`), and copy the **Agent ID** and one-time
   **secret** it shows.
4. **Connect the terminal** — in the agent panel, **Connect terminal**, giving
   the terminal's LAN IP, port, ISAPI username and password.
5. **Wire the local agent** — stop the server (`Ctrl+C`), open
   `C:\estatemate\local-server\config.json` and fill the `agent` section:

   ```json
   "agent": {
     "enabled": true,
     "agentId": "…paste the Agent ID…",
     "agentSecret": "…paste the one-time secret…",
     "devices": [
       {
         "estateMateDeviceId": "…optional: the device id from the portal…",
         "name": "Main Gate Terminal",
         "isapiHost": "192.168.1.100",
         "isapiPort": 80,
         "isapiUsername": "admin",
         "isapiPassword": "…terminal's ISAPI password…",
         "protocol": "http"
       }
     ]
   }
   ```

   Leave `estateMateDeviceId` empty to resolve the terminal automatically from
   its LAN address. Repeat the block per terminal.

6. **Start again and verify** — `node local-server\server.mjs`. Within a
   minute the *Agents* page shows the agent online and the terminal online
   (an open alertStream is proof of life). Swipe a card: the event appears
   under *Access events* within seconds.

**Start at boot** (Administrator PowerShell, once):

```powershell
powershell -ExecutionPolicy Bypass -File local-server\windows\install-service.ps1
```

This registers a boot scheduled task with an automatic-restart wrapper
(`windows\start-server.cmd`), opens the portal port in Windows Firewall and
starts the server immediately. `uninstall-service.ps1` removes both.

## Configuration reference (`local-server/config.json`)

Created automatically on first boot with generated secrets; every value can be
edited and the server restarted.

| Key | Default | Meaning |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8080` | Bind address. `0.0.0.0` serves the whole LAN. |
| `dataDir` | `data` | Database, uploads, agent config and dead-letter files live here. |
| `appName` | `EstateMate` | Portal name. |
| `allowedOrigins` | `""` | Extra CORS origins (comma-separated). Same-origin (the normal case) always works. |
| `hikvisionMode` | `per-device` | Device profile mode, as in the cloud deploy. |
| `fileStorage` | `local` | `local` keeps all uploads on this machine. `disabled` turns uploads off. |
| `secrets.*` | generated | `jwtSecret`, `bootstrapToken`, `deviceIngestPepper`, `storageEncryptionKey`. **Back these up** — sessions and encrypted device passwords depend on them. |
| `agent.*` | enabled | The embedded agent. `syncIntervalSeconds` (operation polling), `heartbeatIntervalSeconds`, `eventStream`, `devices[]` per terminal. |
| `tls.certFile` / `tls.keyFile` | empty | Optional HTTPS with your own certificate; the embedded agent then uses an internal loopback port automatically. |

CLI flags: `--config <path>`, `--port <n>`, `--host <addr>`, `--no-agent`,
`--import-sql <file>` (one-time import of a `wrangler d1 export` dump into a
fresh database — see *Bringing your cloud data offline* below).

## Where your data lives

Everything is inside `local-server/data/`:

- `estatemate.db` — the SQLite database (users, properties, billing, cards,
  events, audit trail). Same schema as the cloud D1.
- `storage/` — uploaded files (proofs, imports, branding). Same role-based
  access rules as the cloud version.
- `agent/` — the generated agent config (contains device credentials; keep the
  folder private).
- `dlq/` — event batches that failed all delivery retries (should stay empty).

**Backups** (server can keep running):

```powershell
node local-server\backup.mjs              # snapshot of the database
xcopy local-server\data\storage …         # copy uploads for a full backup
```

**Restore**: stop the server, replace `estatemate.db` (and `storage/`),
start again.

## Security model

- The server binds your LAN by design; do **not** port-forward it (or any
  terminal's ISAPI interface) to the Internet. Keep the terminals and this
  server on the same VLAN.
- Sessions are the same signed JWT cookies as the cloud version. Over plain
  HTTP on a trusted LAN this matches how the terminals themselves are
  accessed; set `tls.certFile`/`tls.keyFile` if you want HTTPS.
- Device ISAPI passwords are stored encrypted with `secrets.storageEncryptionKey`,
  exactly as in the cloud version.
- The embedded agent talks only to `127.0.0.1` (the server) and to the
  terminals' LAN addresses — never to the Internet.
- Rotate `secrets.bootstrapToken` (edit `config.json`) once the Administrator
  account exists.

## Bringing your cloud data offline

If you already run the Cloudflare deployment and want the same estate data on
the offline server:

```bash
# On a machine with wrangler, online:
npx wrangler d1 export estatemate-db --remote --output=dump.sql
# Then, on the estate server, into a FRESH data directory:
node local-server/server.mjs --import-sql dump.sql
```

The migration chain is marked as applied automatically. Note that
`storage/` (GitHub-hosted uploads) does not come across with the database —
copy any files you need from the private repository, or download them from
the portal first.

## Differences from the Cloudflare edition

- **Remote access**: the cloud edition offers Cloudflare Tunnel remote access
  for administrators. Offline, the portal is reachable on the LAN (or a VPN
  you operate yourself).
- **Android app**: the Android client expects the public Worker URL; use the
  responsive portal on phones instead.
- **Uploads** stay on the estate server's disk rather than a private GitHub
  repository; the portal's storage-settings screen reflects whatever
  repository name the local store was configured with.
- Node's `node:sqlite` prints an `ExperimentalWarning` on startup; it is the
  same SQLite engine wrapped in a stable-enough built-in API, and everything
  is on one machine with backups.

## Running the agent separately

If you would rather keep the server on one machine and the agent on another
always-on box closer to the terminals, set `"agent": { "enabled": false }` and
follow [`isapi-bridge/README.md`](../isapi-bridge/README.md) with
`workerUrl` set to `http://<server-lan-ip>:8080`. Everything else is
identical.

## Development and tests

```bash
npm run offline          # run the server
npm run offline:backup   # snapshot the database
npm run test:local-server  # integration test: boots the real server + a fake
                           # Hikvision terminal and drives the full loop
                           # (swipe → event persisted + live feed, card issue
                           #  → ISAPI command applied)
```

The server imports `src/index.ts` directly — there is no build step and no
copy of the Worker code. If the product changes, the offline edition changes
with it. Keep it that way: never fork product code into `local-server/`.
