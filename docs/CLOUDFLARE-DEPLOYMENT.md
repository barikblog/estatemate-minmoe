# Cloudflare deployment runbook

## Prerequisites

- Cloudflare Account ID.
- Scoped Cloudflare API token; do not use a Global API Key.
- Node.js 22+ and npm 10+.
- R2 enabled on the account.
- A chosen Worker name and optional custom domain.

Suggested token permissions:

- Account / Workers Scripts: Edit
- Account / D1: Edit
- Account / Workers R2 Storage: Edit
- Account / Queues: Edit
- Account / Account Settings: Read
- Zone / Workers Routes: Edit only when attaching a route to an existing zone

Cloudflare’s dashboard labels can change. Start with the narrowest available account/resource scope and add only the permission Wrangler reports missing.

## 1. Authenticate without saving a token in the repository

For one terminal session:

```bash
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export CLOUDFLARE_API_TOKEN='temporary-scoped-token'
```

Do not add these exports to a tracked shell script.

## 2. Create resources

```bash
npx wrangler d1 create estatemate-db
npx wrangler r2 bucket create estatemate-private
npx wrangler queues create estatemate-access-events
npx wrangler queues create estatemate-access-events-dlq
```

Copy the D1 UUID into `wrangler.jsonc` at `d1_databases[0].database_id`. Change names in the config if existing resources are being reused.

## 3. Generate and set secrets

Generate three independent random values:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # BOOTSTRAP_TOKEN
openssl rand -base64 48   # DEVICE_INGEST_PEPPER
```

Set each without putting it on the command line:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put DEVICE_INGEST_PEPPER
```

Optional:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_TOKEN
```

`GITHUB_OWNER` and `GITHUB_REPO` can be non-secret Worker vars when export support is enabled.

## 4. Migrate and deploy

```bash
npm ci
npm run build
npx wrangler d1 migrations apply estatemate-db --remote
npx wrangler deploy
```

Save the resulting `workers.dev` URL. Run:

```bash
curl https://YOUR_WORKER_DOMAIN/api/health
```

Expected: JSON with `"ok": true`.

## 5. Create the first administrator

Use the one-time `BOOTSTRAP_TOKEN` as documented in the root README. Then rotate it:

```bash
npx wrangler secret put BOOTSTRAP_TOKEN
```

Bootstrap also blocks itself after the first user exists.

## 6. Custom domain (optional)

Attach the Worker through the Cloudflare dashboard or add a route/custom-domain configuration after confirming the zone. TLS must remain enabled. Add the web origin to `ALLOWED_ORIGINS` only if clients are hosted on another origin.

## 7. Register a terminal

Use the portal’s **MinMoe devices** screen. The generated endpoint includes a one-time credential. Store it in the terminal and an approved password vault; it cannot be recovered from D1.

## 8. GitHub Actions deployment

The included workflow expects repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow builds, tests, applies D1 migrations, and deploys after a push to `main`. Use a long-lived, narrowly scoped token only if automatic deployments are desired. Otherwise omit repository secrets and deploy manually.

## Rollback

List deployments and roll back the Worker code with Wrangler or the dashboard. D1 migrations are forward-only; take an export before destructive schema changes.

```bash
npx wrangler deployments list
npx wrangler rollback
npx wrangler d1 export estatemate-db --remote --output backup.sql
```

Never put D1 exports containing resident, payment, visitor, access, or biometric-linked data in a public GitHub repository.
