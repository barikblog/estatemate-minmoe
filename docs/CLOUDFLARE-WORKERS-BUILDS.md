# Cloudflare Workers Builds runbook

How the `estatemate` Worker ships from GitHub, and how to make **Cloudflare
Workers Builds the only ship path** without a window where production has none.

Read this before touching `.github/workflows/deploy.yml`. The short version:
the Cloudflare Git integration is *already connected* to this Worker, it has
been deploying `main` in parallel with GitHub Actions for weeks, and its preview
builds have been red on every non-`main` commit. This document resolves that,
and the resolution is reversible with one repository variable.

---

## 1. What is true today (verified 2026-10-04)

Evidence from the commit check runs on `barikblog/estatemate-minmoe`, app
`cloudflare-workers-and-pages`, check name **`Workers Builds: estatemate`**:

| Commit | Kind | `Workers Builds: estatemate` | `Deploy EstateMate` (Actions) |
| --- | --- | --- | --- |
| `90916e5` | merge to `main` | **success** | success (+ smoke success) |
| `d87e6c6` | docs-only, PR branch | **failure** | CI success |
| `8a150df` | merge to `main` | **success** | success |
| `44bd8b4` | feature, PR branch | **failure** | CI success |
| `607e874` | merge to `main` | **success** | success |
| `4466722`, `8c8a7b8`, `5699d08` | PR branch | **failure** | CI success |

So:

1. **Two systems ship production.** Every merge to `main` is built *and
   deployed* twice — once by `deploy.yml`, once by Cloudflare. Both were green
   on `main` tip `90916e5`. This is the "two ship paths" `AGENTS.md` warns
   about, and it is not hypothetical.
2. **The integration is live and its production builds work.** Each successful
   check carries a Version ID, so Cloudflare really is publishing versions of
   the `estatemate` Worker, not just linting it.
3. **Every non-`main` build fails**, including a commit that changed only
   Markdown. A docs-only commit cannot break a bundle, so the failure is not
   about application code: it is the **preview build** path.
4. The red check is not a required check, so it has never blocked a merge — it
   has just been noise that hides real signal.

### Most likely cause of the red preview builds

Stated as a hypothesis, because the build log lives in the Cloudflare dashboard
and was unreachable from the environment that verified the table above. Open the
**Details** link on any red `Workers Builds: estatemate` check to confirm in one
read.

The default Preview command is `npx wrangler preview`, and Worker Previews
create **branch-isolated** resources. This Worker binds a D1 database, two
queues (producer + consumer, one with a dead-letter queue) and a Durable Object.
The API token Cloudflare auto-generates for Workers Builds grants:

- Account: Account Settings (read), Workers Scripts (edit), Workers KV (edit), Workers R2 (edit)
- Zone: Workers Routes (edit)
- User: User Details (read), Memberships (read)

**It has no D1 scope and no Queues scope.** A production `wrangler deploy` only
*references* existing resource IDs, so it succeeds; a preview that has to
*create* an isolated D1 database and queues is refused. That is consistent with
everything in the table: production green, every preview red, code-independent.

The same missing D1 scope is why migrations cannot be assumed to work in a
build — see §2.

---

## 2. What this repository now owns

Cloudflare's build settings live in the dashboard, which is how `AGENTS.md`
came to record that "wrangler.jsonc changes are not automatically matched
there". The deploy *logic* is now back in the repository:

- **`scripts/cloudflare-builds-deploy.mjs`** (`npm run deploy:cloudflare`) —
  the ordered ship sequence: assert the portal build exists → `wrangler d1
  migrations apply estatemate-db --remote` → `wrangler deploy`. `wrangler
  deploy` alone never applies D1 migrations, so a schema change merged to
  `main` would otherwise publish code that queries columns production does not
  have. Order matters and both steps must happen in the same build.
  It refuses to run without credentials, refuses to deploy when a migration
  fails, never prints a secret, and translates a D1 permission refusal into the
  exact token scope to add.
- **`.node-version` = `22`** — the Workers Builds image defaults to Node
  **24.18.0** and preinstalls 22.23.2. CI and `package.json` (`engines: >=22`)
  are on 22, so the file pins the build image to the version the tests actually
  pass on. A file beats a dashboard variable here: it is reviewable and it
  travels with the branch.
- **`.github/workflows/deploy.yml`** — still named `Deploy EstateMate`
  (`smoke.yml` triggers on that name), but its deploy job is gated on
  `vars.CLOUDFLARE_BUILDS_AUTHORITATIVE != 'true'`. Unset, it behaves exactly
  as before. Set to `true`, it ships nothing and applies no migrations, and a
  `delegated-to-cloudflare-builds` job says so in the run summary.
- **`.github/workflows/provision.yml`** — manual only. Ensures
  `STORAGE_ENCRYPTION_KEY` exists (creating, never rotating) and lists pending
  remote migrations. These two operations do not belong in a per-push deploy:
  `wrangler secret put` publishes a new Worker version and would race whichever
  system is shipping.
- **`.github/workflows/smoke.yml`** — verifies whichever path shipped. In
  Builds-authoritative mode it triggers on the push to `main` and first waits
  for this commit's `Workers Builds: estatemate` check to succeed, so it tests
  the *new* deployment instead of reporting a green about the old one. If
  Cloudflare registers no build at all (excluded by watch paths, or the
  integration disconnected) it warns and skips rather than failing on a commit
  that shipped nothing.

---

## 3. Dashboard settings to apply

**Workers & Pages → `estatemate` → Settings → Build**

| Setting | Value | Why |
| --- | --- | --- |
| Git account / repository | `barikblog` / `estatemate-minmoe` | already connected |
| Git branch (production) | `main` | only `main` ships |
| **Enable Preview Builds** | **off** | see §4 |
| Root directory | *(empty — repository root)* | `wrangler.jsonc` is at the root |
| **Build command** | `npm run build` | typecheck + tests + `build:web`, so `apps/web/dist` exists and a direct push to `main` cannot deploy untested code |
| **Deploy command** | `npm run deploy:cloudflare` | migrations **then** deploy, in that order |
| Preview command | *(unused once previews are off)* | — |
| **API token** | a **custom** token, *not* the auto-generated one | must include **Account → D1: Edit**; see §5 |

Build variables: none required. `.node-version` handles Node. The image already
runs `npm clean-install` before the Build command; set `SKIP_DEPENDENCY_INSTALL`
only if you want to own the install step yourself.

**Build watch paths** (Settings → Build → Build watch paths) — optional, saves
builds on commits that cannot affect the Worker bundle. Excludes are evaluated
first and fail open, which is the safe direction:

- Include: `*`
- Exclude: `docs/*`, `apps/android/*`, `bridge-apps/*`, `hikvision-tunnel-worker/*`, `windows-agent/*`, `isapi-bridge/*`, `*.md`, `*.zip`

Do **not** exclude `migrations/*`, `src/*`, `apps/web/*`, `wrangler.jsonc`,
`package.json`, `package-lock.json`, `tsconfig.json` or `scripts/*`.

---

## 4. Why preview builds should be off

- They are red today and have been for weeks, which trains everyone to ignore a
  Cloudflare check — the opposite of what a check is for.
- Making them pass means creating branch-isolated D1 databases, queues and a
  Durable Object per branch. For an app whose whole state is one production D1,
  and whose cron consumers would then run per preview, that is cost and
  cross-talk risk in exchange for a URL nobody needs.
- The value previews would add is already covered: `.github/workflows/ci.yml`
  runs a credential-free `wrangler deploy --dry-run` on every PR targeting
  `main`, which bundles the Worker and resolves every binding. A PR that would
  fail to deploy already fails CI.

Turning previews off also removes the red check entirely — no build, no check.
If per-branch URLs are wanted later, that is a separate decision needing a token
with D1 and Queues edit and a considered answer on isolated crons.

---

## 5. The API token is the crux

Everything above works only if the build's token can edit D1. Two options:

1. **Custom token (recommended).** My Profile → API Tokens → Create Token, with
   the scopes `docs/CLOUDFLARE-DEPLOYMENT.md` already lists:
   Account → Workers Scripts: Edit, Account → D1: Edit, Account → Queues: Edit,
   Account → Account Settings: Read. Then select it under Settings → Build →
   API token.
2. **Leave migrations in GitHub Actions** and let Cloudflare only deploy. This
   reintroduces the ordering race — Cloudflare can publish new code before
   Actions applies the schema it needs — so it is not recommended, and it is
   exactly what `AGENTS.md` forbids with "never let both apply migrations".

If the token is wrong, `scripts/cloudflare-builds-deploy.mjs` fails at the
migration step, does **not** deploy, and prints the scope to add. A failed build
leaves the previous version active.

---

## 6. Cutover order

Do these in order. Until step 4, GitHub Actions is still the ship path, so there
is never a push to `main` with no way to deploy.

1. Create the custom API token (§5) and select it in Settings → Build.
2. Set Build command `npm run build`, Deploy command `npm run deploy:cloudflare`,
   Root directory empty, production branch `main`.
3. Turn **Enable Preview Builds** off. Optionally set the watch paths.
4. Merge this branch to `main`. That push still ships through Actions (the
   variable is unset) *and* through Cloudflare — the last parallel deploy.
   Confirm the `Workers Builds: estatemate` check on that commit is **green**
   and that `Production smoke test` passed.
5. Flip the switch: Settings → Secrets and variables → Actions → Variables →
   New repository variable `CLOUDFLARE_BUILDS_AUTHORITATIVE` = `true`.
6. Trigger a build from the dashboard (or merge anything) and confirm:
   - `Workers Builds: estatemate` green;
   - `Deploy EstateMate` ran the `delegated-to-cloudflare-builds` job and
     deployed nothing;
   - `Production smoke test` waited for the Cloudflare check and then passed.
7. Update `docs/AI-HANDOFF.md` to record that the cutover happened and when.

**Rollback:** delete the `CLOUDFLARE_BUILDS_AUTHORITATIVE` repository variable
and re-run `Deploy EstateMate`. Actions ships again immediately; no code change
and no dashboard change required. Both paths apply migrations idempotently
(wrangler records applied migrations), so switching back and forth is safe.

---

## 7. The Hikvision tunnel bridge is a separate Worker

`hikvision-tunnel-worker/` is its own deployment (`hikvision-tunnel-bridge`)
with its own D1 database, shipped by `.github/workflows/deploy-bridge.yml`. It
is **not** connected to Workers Builds, and this runbook does not change it.
Status as of 2026-10-04:

- Last deployed 7 days ago (run `36300703128`, success); the run before it
  failed with curl exit 22 on `/health`, which is the known "a brand-new
  `workers.dev` subdomain 404s briefly" case the workflow now polls for.
- It deployed **with no credentials at all** — its own annotations report that
  `HIK_USER`, `HIK_PASS`, `API_TOKEN`, `CF_ACCESS_CLIENT_ID` and
  `CF_ACCESS_CLIENT_SECRET` are all unset as repository secrets, and the
  workflow warns "bridge deployed with incomplete credentials". The Worker
  answers `/health` with `ok:true` and `tunnelConfigured:true`, but it cannot
  talk to a terminal and rejects its authenticated endpoints. It is inert.
- Its `wrangler.toml` carries a placeholder `database_id`
  (`00000000-0000-0000-0000-000000000000`) that the workflow patches at run
  time, and every wrangler call there must pass `--config wrangler.toml`
  because wrangler 4 otherwise walks up and finds the root `wrangler.jsonc`. So
  do not point Workers Builds at that directory without first committing a real
  `database_id`.
- It only triggers on `hikvision-tunnel-worker/**`, which is why the recent
  ZKTeco PUSH work in `isapi-bridge/` did not redeploy it.
