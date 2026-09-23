# EstateMate — Cloudflare + Hikvision MinMoe (No On-site PC)

EstateMate is a residential-estate operations platform with a responsive React portal, Kotlin/Compose Android client, and Cloudflare Worker API backed by D1, Queues, Durable Objects, and an administrator-configurable private GitHub upload repository.

This repository replaces the original on-site Edge Sync Agent with direct **Hikvision HTTP Listening** event upload. A supported MinMoe terminal sends access events over outbound HTTPS to the Worker, so no PC is required at the estate for event collection.

> [!IMPORTANT]
> **HTTP Listening is an event-upload channel, not a bidirectional device-management channel.** It can deliver card/face/access events to EstateMate, but it normally cannot receive add/enable/disable-card commands from Cloudflare. The platform therefore records required card changes in a visible, auditable **Hardware actions** queue. Fully automatic fee-linked card disable/enable without an on-site agent requires one model-specific command path: an approved Hikvision cloud/OpenAPI proxy, an ISUP 5.0 gateway hosted off-site, or a verified firmware capability that polls a command endpoint. Do not expose ISAPI or the terminal admin interface directly to the public Internet.

## Repository status

This is a deployable foundation/MVP, not a claim that every screen in the original v2 specification is production-complete.

Included:

- One Cloudflare Worker serving the SPA and `/api/*`.
- D1 schema for users, multi-property ownership and approval requests, streets/properties, billing, historical bill/payment imports, visitors, maintenance, general estate notices, access cards, access events, devices, operations, settings, and audit records.
- Direct MinMoe JSON/XML/multipart HTTP Listening ingestion.
- Per-device one-time credentials; Queue buffering; D1 event persistence; Durable Object live WebSocket feed.
- Hourly facility-fee expiry/reactivation job and hardware-action audit queue.
- Role-aware React portal for Administrator, Resident, Cashier, and Security.
- General estate notices with priority, scheduling, read acknowledgements, and login popups; the former Community posting feature is removed.
- Street-targeted batch billing and audited CSV imports for pre-existing bills and resident payments (500 rows/2 MB per upload).
- Residents can own multiple administrator-approved properties; they can request an existing unowned unit or propose a new property, while each property retains one active owner.
- Rented-apartment workflows with owner nomination or direct administrator assignment, approval dates, one active main tenant, and owner/tenant billing responsibility.
- Approved dependant and household profiles, optional separate logins, delegated visitor/bill permissions, and dependant access cards tied to the main resident.
- Audited immediate or scheduled ownership transfers, downloadable property statements, and grouped street/block/zone billing.
- Kotlin/Compose Android foundation with encrypted token storage, Retrofit/Hilt, Room event cache, role dashboard, and gate history.
- Private GitHub-backed upload/download storage with encrypted-at-rest repository access tokens, administrator-editable settings, access checks, and a 4 MB per-file limit. Paid R2 storage remains disabled.
- PBKDF2-SHA256 passwords and HS256 sessions implemented with Workers Web Crypto.
- Tests for password/JWT code and Hikvision JSON/XML/multipart parsing.

Still model/account dependent:

- Automatic terminal card/person commands in no-PC mode.
- Exact MinMoe event minor-code mapping and event payload variants.
- Gemini enrichment, FCM delivery, large GitHub exports, and full accounting/reconciliation UI.
- Android production signing, push configuration, and Play distribution.

See [`docs/MINMOE-NO-PC.md`](docs/MINMOE-NO-PC.md) before installing a terminal. Property workflows are documented in [`docs/MULTI-PROPERTY-OWNERSHIP.md`](docs/MULTI-PROPERTY-OWNERSHIP.md) and [`docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md`](docs/TENANTS-DEPENDANTS-AND-TRANSFERS.md). Private upload setup is in [`docs/GITHUB-STORAGE.md`](docs/GITHUB-STORAGE.md).

## Architecture

```text
MinMoe terminal ── outbound HTTPS event POST ──┐
                                                │
React portal / Android ── HTTPS REST ──────────▶ Cloudflare Worker
                                                   ├── D1
                                                   ├── private GitHub repository API
                                                   ├── access-events Queue
                                                   ├── AccessLiveFeed Durable Object
                                                   └── hourly Cron

Cloud-to-terminal card action
  └── HTTP Listening mode: audit queue → authorized operator applies on device
      Future verified mode: Hikvision cloud/OpenAPI or off-site ISUP command bridge
```

## Supported Hikvision series profiles

Device registration now offers profile auto-detection plus an explicit override for ambiguous regional models:

| Profile | Typical model pattern | Device pattern |
|---|---|---|
| MinMoe Value | `DS-K1T3xx` — K1T320/321/331/341/342/343/344 | Standalone terminal |
| MinMoe Pro | `DS-K1T67x` | Standalone terminal |
| MinMoe Ultra | `DS-K1T68x`, explicitly selected Ultra K1T67x | Standalone terminal |
| MinMoe turnstile module | K560/K567 and configured modules | Embedded/turnstile |
| K1T5xx | `DS-K1T5xx` | Access terminal |
| K1A | `DS-K1Axxx` | Attendance/access terminal |
| DS-K2600 | K2601/K2602/K2604 | Multi-door controller |
| DS-K2700/K2800 | K27xx/K28xx | Multi-door controller |
| Generic ISAPI | Unknown/unlisted models | Conservative fallback |

Each profile carries model patterns, event-field aliases, grant/deny mappings, credential types, expected event formats, and permitted connection patterns. The selectable connection patterns are:

- **Direct HTTP Listening:** outbound event upload, no assumed return command channel.
- **Hikvision cloud/OpenAPI:** pending adapter; enable only with approved API documentation and credentials.
- **Off-site ISUP gateway:** bidirectional option hosted away from the estate, not on-site.
- **Manual synchronization:** event/audit platform with operator-applied hardware changes.

The generic parser retains unknown values rather than inventing a grant result. Add firmware-specific evidence in `docs/device-profiles/` before marking a combination production-supported.

## Monorepo layout

```text
apps/web/                  React + Vite portal
apps/android/              Android Studio Kotlin/Compose project
src/                       Worker/API, parser, auth, Queue and Durable Object
migrations/                Versioned D1 schema
scripts/                    Setup helpers
docs/                       Device, architecture and deployment guides
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

## MinMoe setup

1. Sign in as an EstateMate administrator.
2. Go to **MinMoe devices → Register device** and enter the exact model, firmware, serial, gate, and direction.
3. Copy the endpoint and one-time secret.
4. In the terminal web interface, find **Network → Network Service/Advanced → HTTP Listening** (wording varies).
5. Choose **HTTPS**, enter the Worker hostname, port `443`, and URL/path shown by EstateMate.
6. If the firmware supports listener authentication, use the displayed username and secret. If it cannot send Basic auth, the generated endpoint includes a per-device key as a compatibility fallback.
7. Run the terminal’s listener test. Present a test card and confirm **last seen** and **Gate activity** update.

Do not use HTTP over the public Internet. Do not configure router port-forwarding to the MinMoe terminal.

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
- Query-string device keys are provided only because some terminal firmware lacks listener authentication. They are protected in transit by HTTPS but can appear in logs; Basic authentication is preferred where tested.
- Device request bodies are capped at 2 MB. User files are capped at 4 MB and stored through the GitHub Contents API in a dedicated private repository.
- The GitHub storage token is encrypted with `STORAGE_ENCRYPTION_KEY`, never returned by the API, and should be a fine-grained token limited to the storage repository.
- A resident’s properties, ownership requests, bills, cards, visitors, maintenance requests, files, and access events are scoped server-side.
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
