# Sornix EstateOS — Brand Identity & Multi-Platform Installation Guide

## 1. Sornix Brand Identity & Name Options

The platform is branded **Sornix EstateOS** (short mark **`SE`**) across the web portal, HTML metadata, visitor passes, worker configuration, and database defaults.

Administrators can switch to any of these Sornix brand names at any time under **Settings → Portal identity, theme and recommended defaults**:

| Brand Name | Short Mark | Positioning |
| --- | --- | --- |
| **Sornix EstateOS** *(Applied Default)* | `SE` | All-in-one operating system for residential estates, gated communities, and commercial parks |
| **SornixGate** | `SG` | Security-first and gate-access-focused positioning |
| **Sornix EstateMate** | `SE` | Continuity branding for existing EstateMate deployments under the Sornix parent brand |
| **Sornix Crest** | `SC` | Executive positioning for gated communities and waterfront estates |
| **Sornix Haven** | `SH` | Warm, resident-focused community living and household management positioning |

---

## 2. Multi-Platform Installation & White-Label Provisioning

**Sornix EstateOS** includes a zero-dependency provisioning CLI (`scripts/setup-platform.mjs`) plus ready-to-run `Dockerfile` and `docker-compose.yml` manifests for deploying across cloud and on-premise platforms.

### Verify Platform Readiness

```bash
npm run setup:platform -- --check
```

### Generate a Pre-Branded Deployment Bundle

```bash
npm run package:white-label -- \
  --portal "Sornix EstateOS" \
  --estate "Royal Palm Estate" \
  --short "RP" \
  --currency "NGN" \
  --timezone "Africa/Lagos" \
  --out-dir ./customer-royal-palm
```

This creates:
- `customer-manifest.json` — Deployment metadata and platform quick-start commands
- `branding.sql` — SQL settings seed for the estate name, currency, and timezone
- `deploy-cloudflare.sh` — One-command Cloudflare Workers + D1 deployment script
- `sornix.env` — Pre-generated cryptographic secrets (`SESSION_SECRET`, `DEVICE_INGEST_KEY`, `STORAGE_SECRET`) for Docker/VPS
- `sornix-estateos.service` — Production Linux `systemd` service unit

### Platform Option A: Cloudflare Workers + D1 (Serverless Edge)
```bash
npm ci
npm run build:web
npx wrangler d1 create sornix-estate-db
npx wrangler d1 migrations apply estatemate-db --remote
npm run deploy
```

### Platform Option B: Docker / Coolify / Portainer / Railway / Render / Fly.io
Run the full stack backed by a persistent `/data` SQLite D1 volume with one command:
```bash
docker compose up -d --build
```
The portal is immediately available on `http://localhost:8787` with all SQLite migrations automatically applied to the `sornix_d1_data` volume.

### Platform Option C: Ubuntu / Debian / Raspberry Pi On-Premise Server
Copy the generated `sornix-estateos.service` into `/etc/systemd/system/` to run Sornix EstateOS directly on an estate gatehouse mini-PC or Raspberry Pi 4/5 alongside the local hardware bridge.
