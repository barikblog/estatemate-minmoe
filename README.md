# EstateMate — Cloudflare + Hikvision MinMoe (No On-site PC)

EstateMate is a residential-estate operations platform with a responsive React portal, Kotlin/Compose Android client, and Cloudflare Worker API backed by D1, Queues, Durable Objects, and an administrator-configurable private GitHub upload repository.

All access devices connect to EstateMate through one channel: the **EstateMate agent** (`isapi-bridge/`, wrapped for Windows in `windows-agent/`) running on the estate LAN. The agent holds a persistent Hikvision ISAPI `alertStream` connection per terminal and streams swipe events to the Worker in real time, and it polls the Worker for pending card/visitor operations and applies them over ISAPI (HTTP Digest) — so events are live and fee-linked card enable/disable is automatic. Any always-on small computer on the device LAN works: the existing estate office Windows PC, a spare Android phone on estate Wi-Fi (Termux + Node), or a single-board computer.

> [!IMPORTANT]
> **The agent keeps ISAPI private to the estate VLAN.** Only the agent talks to the terminals, and only the agent's outbound HTTPS reaches Cloudflare. Never port-forward a terminal's ISAPI/admin interface to the public Internet, and never run the agent anywhere except the device LAN. Devices not yet linked to an agent fall back to auditable **manual synchronization**: the Hardware actions queue lists each change for an operator to apply.
>
> Remote access by administrators is the one deliberate exception, and it is **private, not public**: [`docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md) publishes the estate LAN to Zero Trust-enrolled humans over WARP, with no public hostname and no DNS record. The tunnel carries human access only; events and card operations never traverse it, so gates keep working when it is down. A Hikvision terminal cannot dial into a Cloudflare Tunnel on the free plan (public hostnames are HTTP/HTTPS only and a device can neither run WARP nor complete an Access login), which is why ISUP is not a supported transport.

## Repository status

This is a deployable foundation/MVP, not a claim that every screen in the original v2 specification is production-complete.

Included:

- One Cloudflare Worker serving the SPA and `/api/*`.
- D1 schema for users, multi-property ownership and approval requests, streets/properties, billing, historical bill/payment imports, visitors, maintenance, general estate notices, access cards, fingerprint credentials, access events, devices, operations, settings, and audit records.
- LAN-agent event ingestion: the agent streams JSON/XML device events (ISAPI alertStream) to the Worker in batches; retired transports (direct HTTP Listening, Render relay, Hikvision cloud, ISUP gateway) were removed in migration 0013.
- Per-device one-time credentials; editable/soft-deletable device inventory; Queue buffering; D1 event persistence; Durable Object live WebSocket feed.
- Device-tap card enrollment, phone/device visitor-code scanning, QR + Code 128 visitor passes, and preview-before-entry Security decisions.
- **Access cards & fingerprints** as one credential register: cards keep their real card number, fingerprints are their own credential with the terminal's finger slot (1–10) and employee number. Administrators and Managers add either from the person's profile (People, and Tenancy & household for dependants) or from the Access cards & fingerprints page. A finger can only be captured on the terminal itself, so every fingerprint change is queued as an operator task with instructions under Hardware actions, and gate events that carry no card are attributed back to the person through the employee number.
- Hourly facility-fee expiry/reactivation job and hardware-action audit queue.
- Role-aware React portal for Administrator, Manager, Resident, Cashier, and Security. Manager receives operational administration without billing, private-storage or global-settings control.
- People management with available-property selection, validated account creation, CSV bulk registration, 24-hour sample logins, generated one-time passwords, editing, password reset, safe deactivation/reactivation and history-preserving deletion.
- Private-GitHub-backed operational imports for properties, ownerships, tenancies and access cards, in addition to people, bills and payments.
- General estate notices with priority, scheduling, read acknowledgements, and login popups; the former Community posting feature is removed.
- Street-targeted batch billing and audited CSV imports for pre-existing bills and resident payments (500 rows/2 MB per upload).
- Initiate-payment flow with three options — POS payment at office, cash payment at office, and bank transfer against an Administrator-published estate account. Online card collection is deliberately absent because no paid payment provider is used.
- Visitor passes that can be shared as a PNG image or a one-page A4 PDF, rendered entirely in the browser; resident passes default to every gate (entry and exit) and never expose a gate picker.
- Estate-timezone-aware visitor validity windows, so a pass issued for "10:00" local time is not shifted by the Worker's UTC clock.
- Residents can own multiple administrator-approved properties; they can request an existing unowned unit or propose a new property, while each property retains one active owner.
- Rented-apartment workflows with owner nomination or direct administrator assignment, approval dates, one active main tenant, and owner/tenant billing responsibility.
- Approved dependant and household profiles, optional separate logins, delegated visitor/bill permissions, and dependant access cards and fingerprints tied to the main resident.
- Audited immediate or scheduled ownership transfers, downloadable property statements, and grouped street/block/zone billing.
- Kotlin/Compose Android foundation with encrypted token storage, Retrofit/Hilt, Room event cache, role dashboard, and gate history.
- Private GitHub-backed upload/download storage with encrypted-at-rest repository access tokens, supporting proof on ownership/tenancy/household/visitor/maintenance/payment forms, access checks, and a 4 MB per-file limit. Paid R2 storage remains disabled.
- **Cloudflare Tunnel remote access (Free plan)** via `scripts/cloudflared-remote-access.mjs`: generates a `cloudflared` config with WARP private-network routing so administrators and installers reach the estate LAN from anywhere without publishing a terminal to the Internet, plus a `--check` validator that fails a config which would expose one. Remote *human* access only — events and card operations still flow agent-side ([`docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md)).
- Administrator-editable portal identity, theme colours, light/dark mode, support details, visitor defaults and scan timeout.
- PBKDF2-SHA256 passwords and HS256 sessions implemented with Workers Web Crypto.
- Tests for password/JWT code and Hikvision JSON/XML/multipart parsing.

Still model/account dependent:

- Automatic terminal card/person commands in no-PC mode.
- Automatic fingerprint template push: until per-model evidence is recorded in `docs/device-profiles/`, fingerprint enrollment, enable/disable and deletion stay operator tasks.
- Exact MinMoe event minor-code mapping and event payload variants.
- Gemini enrichment, FCM delivery, large GitHub exports, and full accounting/reconciliation UI.
- Android production signing, push configuration, and Play distribution.

See [`docs/MINMOE-NO-PC.md`](docs/MINMOE-NO-PC.md), [`docs/VISITOR-CREDENTIALS-AND-ACCESS-DEVICES.md`](docs/VISITOR-CREDENTIALS-AND-ACCESS-DEVICES.md), and [`isapi-bridge/README.md`](isapi-bridge/README.md) before installing a device. Property workflows are in [`docs/MULTI-PROPERTY-OWNERSHIP.md`](docs/MULTI-PROPERTY-OWNERSHIP.md) and [`docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md`](docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md). Proof uploads and theming are documented in [`docs/PROOF-UPLOADS-AND-PORTAL-CUSTOMISATION.md`](docs/PROOF-UPLOADS-AND-PORTAL-CUSTOMISATION.md). Private upload setup is in [`docs/GITHUB-STORAGE.md`](docs/GITHUB-STORAGE.md), people administration is in [`docs/PEOPLE-REGISTRATION-AND-IMPORTS.md`](docs/PEOPLE-REGISTRATION-AND-IMPORTS.md), and Manager and import behavior is in [`docs/MANAGERS-IMPORTS-HIKCONNECT-SITE-SYNC.md`](docs/MANAGERS-IMPORTS-HIKCONNECT-SITE-SYNC.md). Remote support access is in [`docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](docs/CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md). AI agents should begin with [`AGENTS.md`](AGENTS.md).

## Architecture

```text
Access device ── ISAPI alertStream (LAN) ──▶ EstateMate agent ── outbound HTTPS batches ──┐
React portal / Android ── HTTPS REST ────────────────────────────────────────────────────▶ Cloudflare Worker
                                                   ├── D1
                                                   ├── private GitHub repository API
                                                   ├── access-events Queue
                                                   ├── AccessLiveFeed Durable Object
                                                   └── hourly Cron

Cloud-to-terminal card/visitor action
  ├── Agent mode: Worker operation queue → LAN agent polls → ISAPI Digest (automatic)
  └── Manual mode: audit queue → authorized operator applies on the device
```

## Supported Hikvision series profiles

Device registration now offers profile auto-detection plus an explicit override for ambiguous regional models:

| Profile | Typical model pattern | Device pattern |
|---|---|---|
| MinMoe Value | `DS-K1T3xx` — K1T320/321/331/341/342/343/344 | Standalone terminal |
| MinMoe Pro | `DS-K1T67x` | Standalone terminal |
| MinMoe Ultra | `DS-K1T68x`, explicitly selected Ultra K1T67x | Standalone terminal |
| MinMoe turnstile module | K560/K567 and configured modules | Embedded/turnstile |
| QR K1T807/K1T502 | QR/QRE/CQR variants | QR access terminal |
| K1T8xx | `DS-K1T808MFWX-B` and K1T80x variants | Card/fingerprint/PIN terminal |
| K1T5xx | `DS-K1T5xx` | Access terminal |
| K1A | `DS-K1Axxx` | Attendance/access terminal |
| DS-K2600 | K2601/K2602/K2604 | Multi-door controller |
| DS-K2700/K2800 | K27xx/K28xx including DS-K2802 | Multi-door controller; external reader required |
| Other network access | Explicitly validated non-Hikvision device | Vendor-neutral conservative parser |
| Generic ISAPI | Unknown/unlisted Hikvision models | Conservative fallback |

Each profile carries model patterns, event-field aliases, grant/deny mappings, credential types, expected event formats, and permitted connection patterns. There is exactly one automatic transport — the agent — plus an auditable manual fallback:

- **ISAPI bridge agent (`isapi_bridge`):** cross-platform Node agent on the device LAN; real-time alertStream event streaming plus ISAPI card operations. Recommended default.
- **Windows agent (`windows_agent`) / combined (`isapi_windows_agent`):** the same agent on the estate office Windows PC as a service.
- **Manual synchronization (`manual_sync`):** event/audit platform with operator-applied hardware changes; also the migration target for devices previously on retired transports.

The former direct HTTP Listening, Render free relay, Hikvision cloud/OpenAPI, and dedicated ISUP gateway transports were removed (migration `0013_agent_only_transports.sql`); their history-preserving replacements are documented in `docs/MINMOE-NO-PC.md`.

The generic parser retains unknown values rather than inventing a grant result. Add firmware-specific evidence in `docs/device-profiles/` before marking a combination production-supported.

## Monorepo layout

```text
apps/web/                  React + Vite portal
apps/android/              Android Studio Kotlin/Compose project
isapi-bridge/              The only device transport: cross-platform LAN agent
                           (real-time alertStream events + ISAPI card operations)
windows-agent/             Windows Service wrapper for the ISAPI bridge agent
src/                       Worker/API, parser, auth, Queue and Durable Object
migrations/                Versioned D1 schema
scripts/                    Setup and AI-continuation helpers
docs/                       Device, architecture and deployment guides
AGENTS.md                   Starting instructions for another AI coding agent
wrangler.jsonc              Local/current deployment config
wrangler.template.jsonc     Clean template for another Cloudflare account
```

## Local development

Requirements: Node.js 22+, npm 10+, and a Cloudflare account for remote resource tests.

```bash
cp .dev.vars.example .dev.vars
# Fill JWT_SECRET, BOOTSTRAP_TOKEN, DEVICE_INGEST_PEPPER and STORAGE_ENCRYPTION_KEY.
npm install
npm run build:web
npm run db:migrate:local
npm run dev
```

The Worker is normally available at `http://localhost:8787`. To work on web UI with Vite hot reload in a second terminal:

```bash
npm run dev:web
```

Vite proxies `/api` to port 8787.

### First administrator

After migration and deployment:

```bash
curl -X POST 'https://YOUR_DOMAIN/api/auth/bootstrap' \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Token: YOUR_ONE_TIME_BOOTSTRAP_TOKEN' \
  --data '{"name":"Estate Administrator","email":"admin@example.com","password":"use-a-long-unique-password"}'
```

Rotate/remove `BOOTSTRAP_TOKEN` after the first admin is created. Bootstrap refuses to run once any user exists.

## Cloudflare deployment

Detailed steps are in [`docs/CLOUDFLARE-DEPLOYMENT.md`](docs/CLOUDFLARE-DEPLOYMENT.md).

Summary:

1. Create D1 database `estatemate-db` and replace the placeholder `database_id` in `wrangler.jsonc`.
2. Create queues `estatemate-access-events` and `estatemate-access-events-dlq`.
3. Create a dedicated **private** GitHub repository for uploads.
4. Set Worker secrets:
   - `JWT_SECRET`
   - `BOOTSTRAP_TOKEN`
   - `DEVICE_INGEST_PEPPER`
   - `STORAGE_ENCRYPTION_KEY`
   - optional `GEMINI_API_KEY`
5. Run the D1 migrations and deploy.
6. In **Settings → Private GitHub upload storage**, enter the repository and a fine-grained token limited to that private repository's Contents permission.

```bash
npx wrangler d1 migrations apply estatemate-db --remote
npm run deploy
```

A scoped Cloudflare token needs permissions for Workers Scripts, D1, Queues, account metadata, and Workers routes only if a custom route is used. Never commit Cloudflare, GitHub, or device credentials.

## Access-device setup (agent method)

1. Sign in as an EstateMate administrator.
2. Go to **Access-control devices → Register device** and enter the exact model, firmware, serial, gate, and direction. Keep the default **ISAPI bridge** connection pattern.
3. Under **Device agent**, add the agent that runs on the estate LAN and download its installer (PowerShell for Windows, shell for Linux). The one-time secret is shown once.
4. Install the agent on an always-on computer on the device LAN (office PC, Termux on a spare Android phone, or a small board), and edit `isapi-devices.json` with each terminal's LAN IP, ISAPI port, and administrator credentials.
5. Link each device to the agent in the portal (**Device ISAPI configs**) with its ISAPI host/port/credentials.
6. Present a test card and confirm **last seen** and **Gate activity** update within seconds; issue a test card and confirm it appears on the terminal within the polling interval.

Do not expose ISAPI to the public Internet. Do not configure router port-forwarding to any terminal. Full details: [`isapi-bridge/README.md`](isapi-bridge/README.md).

## Android

Open `apps/android` in Android Studio with JDK 17. Before building, replace this value in `apps/android/app/build.gradle.kts`:

```kotlin
buildConfigField("String", "API_BASE_URL", "\"https://YOUR_WORKER_DOMAIN/\"")
```

Then build with Android Studio or:

```bash
cd apps/android
./gradlew assembleDebug
```

Production builds require your own signing key. Do not commit a keystore or its passwords.

## Security notes

- Device secrets are SHA-256 hashed with a server-side pepper. The plaintext secret is shown once.
- Device request bodies are capped at 2 MB. User files are capped at 4 MB and stored through the GitHub Contents API in a dedicated private repository.
- The GitHub storage token is encrypted with `STORAGE_ENCRYPTION_KEY`, never returned by the API, and should be a fine-grained token limited to the storage repository.
- A resident’s properties, ownership requests, bills, cards, fingerprints, visitors, maintenance requests, files, and access events are scoped server-side.
- Device events are idempotent on `(device_id, vendor_event_id)`.
- Images embedded in multipart device events are not stored in this MVP; only normalized event metadata is retained.
- The Worker returns HTTP 200 quickly after Queue acceptance because many Hikvision devices retry events when acknowledgement is delayed.

## Tests and quality gates

```bash
npm run typecheck
npm test
npm run build
```

## GitHub publication

This directory is Git-ready. To publish after choosing an owner and repository name:

```bash
gh repo create OWNER/estatemate-minmoe --public --source=. --remote=origin --push
```

or create an empty repository in GitHub, then:

```bash
git remote add origin https://github.com/OWNER/estatemate-minmoe.git
git push -u origin main
```

## License

MIT. Confirm that your use of Hikvision ISAPI/ISUP materials, firmware, biometric functions, and any cloud API complies with Hikvision agreements and Nigerian privacy/data-protection requirements.
