# Free-tier capacity, multiple estates, and monetisation in NGN

Answers four questions with numbers taken from this repository's own code and
from Cloudflare's and GitHub's published limits:

1. Can the **Workers Free plan** carry one estate as the app is built today?
2. Can the **free option** serve **multiple estates**, and what has to change?
3. Could **GitHub** host the whole app, with a repository per estate, and does a
   new repository extend a free tier that has been exceeded?
4. What does **monetisation in NGN** require — rail, price ladder, licence gate,
   and Nigerian compliance?

> Every Cloudflare and GitHub figure below is from the account-plan and terms
> pages read on **2026-10-11**; the NGN fee figures are the published 2026 rate
> cards and the Nigerian compliance thresholds are from the NDPC guidance notice
> and the 2026 tax acts. Product and tax numbers are "confirm before quoting to a
> customer" numbers, not legal advice.

---

## 1. Verdicts

| Question | Verdict |
|---|---|
| One estate on Workers Free, as built | **Yes, comfortably.** Machine traffic ≈ **6,000 requests/day** and D1 writes ≈ **5–10 %** of the daily allowance. The binding risk is the **500 MB per-database cap** and the account-wide hard stops, not today's traffic. |
| Multiple estates on **one** free account | **No, not as built.** The free plan allows **5 Cron Triggers per account** and this app uses **2**, so **one free account carries two estates maximum**. Requests, D1 databases, storage and every daily stop are also **per account** — one estate's import can take every other estate's portal down. |
| Multiple estates on the free option, done properly | **Yes — one Cloudflare account per estate.** Each estate gets its own 100k requests/day, its own 2 cron triggers, its own D1, and its own blast radius. Zero infrastructure cost, zero code change, and the whole provisioning loop is automatable — but account creation itself is capped at **5 extra Free accounts per Cloudflare user** (§4.5–4.7), so the free fleet tops out around **5–15 estates**. |
| Monetisation in NGN | **Yes, but two things must be built and one must never be built.** Build: an invoicing/licence layer and a payment rail (bank transfer first, Paystack second). Never build: any enforcement that touches **gate access control**. |

---

## 2. What the free plan actually allows (2026-10-11)

### Workers Free

| Limit | Free | Why it matters here |
|---|---|---|
| Requests | **100,000 / day, per account** | Shared by every Worker, Pages Function and **cron invocation** on the account. Exceeding it returns **Error 1027**. |
| **Cron Triggers** | **5 / account** | The hard multi-estate blocker — see §4. |
| Workers per account | 100 | One Worker per estate is fine up to 100. |
| CPU time | 10 ms / invocation | Comfortable: `/api/*` handlers are query-bound, and waiting on D1 is not CPU. Heavy CSV imports are the ones to watch. |
| Subrequests | 50 / invocation | Fine — the code batches writes with `DB.batch()`. |
| Static assets | **free and unlimited** | `wrangler.jsonc` sets `run_worker_first: ["/api/*"]`, so loading the SPA costs **0** requests. Only API calls and machine traffic count. |
| Memory / Worker size | 128 MB / 64 MiB | Not a constraint. |
| SLA | **none** | Free plan is lowest routing priority with no support contract. |

### D1 Free

| Limit | Free | Why it matters here |
|---|---|---|
| Databases | **10 / account** | One database per estate is possible for 10 estates. |
| Max database size | **500 MB** | The real ceiling for `access_events` on a busy estate. |
| Storage per account | **5 GB** | Fine while proof images live in the private GitHub repo, not D1. |
| Rows read | **5,000,000 / day, per account** | Indexed point lookups are cheap; unindexed list/`OFFSET` scans are the risk. |
| Rows written | **100,000 / day, per account** | ~5–10 % used by a normal estate — but a bulk people import (person + cards + household rows + indexes) can spend several thousand in one burst, and a free D1 stop is account-wide. |
| Behaviour on limit | **Queries stop until 00:00 UTC** (upgrade lifts it) | This is the availability risk that must be designed around, not a warning email. |

### Queues, Durable Objects, KV, R2

| Product | Free allowance |
|---|---|
| Queues | 10,000 operations/day (one event batch ≈ 1 message ≈ 3 operations) |
| Durable Objects | 100,000 requests/day, 13,000 GB-s/day. The live feed uses the **WebSocket Hibernation API** (`acceptWebSocket` + `webSocketMessage`), so an idle socket does not burn duration |
| KV | 100k reads/day, 1k writes/day — **not used** by this app |
| R2 | 10 GB-month, 1M Class A / 10M Class B ops per month, but a bucket needs billing details on the account — which is why this repo deliberately stores files in a private GitHub repo instead |

---

## 3. What one estate spends today (derived from this repo)

Assumptions: one estate, one LAN agent, 4 terminals, ~200 residents,
**~400 gate events/day**, and Remote Network Verification **off** — switching it
on adds the 60-second credential snapshot below (+1,440 requests/day), which is
the number to re-check before enabling it on a busy estate.

### Worker requests per day

| Source | Where | Requests/day |
|---|---|---|
| Agent heartbeat (60 s default) | `isapi-bridge/agent.mjs:63` | 1,440 |
| Agent operation poll (30 s default) | `agent.mjs:62` | 2,880 |
| Credential snapshot refresh (60 s, reader mode) | `agent.mjs:105, 2528` | +1,440 (only when remote verify is on) |
| Event flushes (≤50 events or every 5 s, only while events flow) | `agent.mjs:836` | ~100–300 |
| Per-minute visitor-device sweep | `wrangler.jsonc` `"* * * * *"` | 1,440 |
| Hourly housekeeping cron | `wrangler.jsonc` `"15 * * * *"` | 24 |
| Portal API calls (25 daily users × ~30 calls) | `apps/web` | ~750 |
| Sync logs, operation results, WS upgrade | `index.ts` ISAPI routes | ~100 |
| **Total** | | **≈ 6,000 – 7,500 (≈ 8 % of 100k)** |

### D1 per day

| Source | Estimate |
|---|---|
| `access_events` INSERT: 400 events × (1 row + 10 index rows) | ~4,400 rows written |
| Scan-session and device-touch updates | ~1,000 |
| Cron writes (facility-fee expire/restore, visitor lifecycle, presence) | ~200–2,000 |
| Portal writes (bills, imports, notices) | bursty; a 500-row bill import ≈ 500–1,500 |
| **Total** | **≈ 7,000 – 10,000 rows written (≈ 10 % of 100k)** |
| Rows read | dominated by cron scans and list endpoints; indexed by design — measure `meta.rows_read` before trusting it |

### Storage

`access_events` is the only table that grows without bound. At ~400 events/day a
row plus its indexes costs roughly 0.5–1 KB, so:

| Retention (`access_event_retention_days`) | Rows | Approx. size |
|---|---|---|
| **365 (current default)** | 146,000 | **75–150 MB** — safe at 400 events/day, **over 500 MB** on a 2,000-event/day estate |
| 180 | 72,000 | 36–72 MB |
| **90 (recommended default)** | 36,000 | **18–36 MB** |

`pruneAccessEvents` (`src/index.ts:7599`) deletes at most 500 rows per hourly run
(12,000/day), which is enough to hold a 90-day window but **not** to shrink a
365-day backlog quickly. **Change the default and/or lower existing estates'
retention before onboarding a busy site.**

### Verdict for one estate

Free is the right plan for a single estate. The design already protects the one
thing that must not break: **the gate keeps working when the cloud does not.**
Remote Network Verification decides on the LAN from a cached credential snapshot,
the agent buffers events, and the queue is on the estate side — so an Error 1027
or a D1 daily stop costs the portal and the reports, not the gate.

**Watch list for a single estate on free**

1. **500 MB database.** Export/purge `access_events` (and set retention to 90 days).
2. **D1 daily stop is silent until it happens** — you cannot buy headroom mid-day on free. Reduce `syncIntervalSeconds`' *only* if you are under pressure; the polling floor is 5 s.
3. **365-day retention default** is the one setting that is wrong for free.
4. **Keep files in GitHub storage** (`FILE_STORAGE_MODE=github-private-configurable`) — images in D1 would blow 500 MB in weeks.
5. **No SLA.** Do not sell an uptime promise on a free deployment.

---

## 4. Multiple estates on the free option

### 4.1 Why one free account cannot host a portfolio

| Constraint | Free | Cost per estate | Estates before the wall |
|---|---|---|---|
| **Cron Triggers** | **5 / account** | 2 (hourly + per-minute visitor sweep) | **2** ← binds first |
| Requests | 100,000 / day per account | ~6,000–7,500 | ~13 (plan for 8; keep headroom) |
| D1 databases | 10 / account | 1 | 10 |
| D1 storage | 5 GB / account | 20–40 MB/year at 90-day retention | far beyond 10 |
| D1 rows written | 100,000 / day per account | ~7,000–10,000 | ~10 |
| Queues | 10,000 ops/day per account | ~450 | ~20 |
| **Failure domain** | account-wide | — | one estate's import/abuse stops **every** estate's portal |

So the honest headline: **the free plan is a per-estate plan, not a platform plan.**
Two estates fit one account; beyond that the crons, then the daily request
budget, then the shared failure domain decide for you.

### 4.2 If you must exceed two estates on one account (cron workaround)

The 5-cron cap is per **account**, not per Worker, so it can be bypassed without
paying: keep **one dispatcher Worker** in the account holding the two cron
triggers, and have it POST to a secret-guarded `/api/internal/scheduled` route on
each estate Worker (Service Bindings work inside one account and are cheaper than
public fetch). Cost: one extra request per estate per tick — the per-minute
sweep becomes 1,440 × *N* requests/day, so 10 estates spend ~14 % of the daily
budget just on the visitor sweep. That is arithmetic you can manage at 3–5
estates and should not manage at 20.

### 4.3 The three shapes, compared

| | **A. One account per estate** (recommended for free) | **B. One paid account, one Worker per estate** | **C. True multi-tenant, one Worker + `estate_id`** |
|---|---|---|---|
| Cost | **₦0** per estate | $5/month account minimum + overages | $5/month + overages, cheapest per estate at scale |
| Isolation | total (own account, own D1, own quota) | Worker-level; **quota stops are account-wide** | shared everything; needs a per-estate quota/abuse model |
| Code change | **none** | none (billing/licence layer only) | large: `estate_id` across 40+ tables, 168 routes, the global `settings` table, every cron job |
| Ceiling | ~1 estate per account as built, 2 with the dispatcher, ~8–10 with an alarm scheduler; **5 extra free accounts per user** (§4.5) | ~50+ estates before cost matters; 250 cron triggers | no hard ceiling; soft ceiling is one D1's 500 MB/10 GB |
| Data ownership story | strongest ("the estate owns its deployment") | estate data in your account | estate data in your account, interleaved |
| Operational load | you deploy N times (`npm run setup:platform` + `wrangler deploy`) | one deploy, N configs | one deploy |
| Best for | the free tier | paid/managed estates | a central platform with self-serve signup |

**Recommended split**

- **Free tier → shape A.** One estate, one Cloudflare account (the estate's own, or
  the estate committee's). It is genuinely free forever, it matches this
  repository's posture that the estate owns its data, and it keeps every free-tier
  hard stop inside one estate's boundaries. New estates are placed and provisioned
  by the control-plane loop in §4.7, which creates accounts until the user's
  five-account budget runs out and then says so.
- **Paid/managed tier → shape B**, on one account you own, still one Worker and one
  D1 **per estate**. $5/month covers the first one; the economies only appear later.
- **Shape C only if** you decide self-serve signup matters more than isolation.
  Do not start there: it makes the free tier *more* expensive to run, not less.

### 4.4 What to build for multi-estate (in order)

1. **A control plane, not a rewrite.** A tiny `estates/registry.json` (or a
   `sornix-control` repo) holding, per estate: Worker name, D1 id, agent ids,
   retention days, licence status, contact. Drive `setup:platform` from it so a
   new estate is one command. §4.7 gives the shape and the loop.
2. **Capacity guardrail** (`docs` + a script): read `meta.rows_read/rows_written`
   from the cron and store the daily high-water mark in `settings`, then surface a
   "Free-plan headroom" card to the Administrator. Alert owners at 80 % of
   requests, 4M rows read, 80k rows written. In the control plane this same data
   drives placement and rollover.
3. **Retention default → 90 days** (`migrations/0012…` sets 365; new estates should
   ship with 90 and a portal control).
4. **Deployment docs per estate** in the style of `MULTI-PLATFORM-INSTALLATION.md`.
5. **Alarm-based scheduling** (only if the free fleet needs more than two estates
   per account): move the per-minute visitor sweep onto a Durable Object alarm
   before touching anything else — it is the single change that raises an
   account's free capacity from 2 to ~8–10 estates.

### 4.5 Automatic provisioning: what an API can create, and what it cannot

"Auto-create a new repo when the free tier is exceeded" splits into two very
different halves. **A GitHub repository stores no estate data and runs no code** —
it is the private upload bucket (`docs/GITHUB-STORAGE.md`), and GitHub's API will
happily create as many as you want (content-creation limits are 80 requests/minute
and 500/hour, so even automated creation is fine). The limits that decide whether
an estate fits are **Cloudflare account quotas and cron triggers**, so what has to
be created or cycled is a whole **deployment — and, with the free plan, a whole
account**.

| Resource | Creatable by API? | Cap that matters | How |
|---|---|---|---|
| **Cloudflare account** | **Yes, self-serve** | **5 additional Free accounts per Cloudflare user** | `POST /accounts` with `{"name":…,"type":"standard","standalone":true}` and exactly one `Idempotency-Key` header, using a **user-owned** token with *User Details Read* (account-owned tokens cannot create accounts). Eligibility: the user must be ≥ **7 days** old and Super Administrator on an existing account. Errors are explicit: user too new, not Super Admin, limit reached, temporarily unavailable, key reused for a different request, user suspended |
| Worker + SPA assets | Yes | 100 Workers / account | `wrangler deploy` (what `deploy-cloudflare.sh` from `setup:platform` already does), or the upload API |
| D1 database | Yes | 10 / account, 500 MB each | `POST /accounts/{account_id}/d1/database`; schema via `wrangler d1 migrations apply … --remote` or the import API. `primary_location_hint` (wnam/enam/weur/eeur/apac/oc — no African region) pins where the estate's data primary lives, which is worth recording for the NDPA transfer note in §6.7 |
| Queues + consumer + DLQ | Yes | per-account operations | create queue, consumer, dead-letter queue, then bind |
| Worker secrets | Yes | 64 vars / Worker | per-estate `SESSION_SECRET`, `DEVICE_INGEST_KEY`, `STORAGE_SECRET` — `scripts/setup-platform.mjs` already generates them |
| Branding, currency, timezone | Yes | — | the `branding.sql` seed the installer already emits |
| Private storage repo + fine-grained token | Yes | GitHub content limits (80/min, 500/hour) | create repo, push an initial commit, store the token encrypted in `github_storage_settings` |
| **Cron triggers** | **No** | **5 / account — not raisable** | This is why placement, not size, is the constraint |
| **Per-account requests, D1 rows, storage, Queues ops** | **No** | 100k requests, 100k writes, 5M reads, 5 GB, 10k ops — per day, per account | Only redistributable: move an estate to another account |

So the full automation loop is real, but its ceiling is an **account creation
budget, not a technical one**.

### 4.6 Making an account cron-free (so it holds more than two estates)

The cron cap is the blocker, and it can be designed around: **before a Worker
needs its own cron trigger, the same schedule can be driven by Durable Object
alarms.** `AccessLiveFeed` is already a Durable Object; a per-estate "scheduler"
object would `setAlarm(now + 60_000)` and re-arm itself in the handler, which gives
per-minute precision with **0 cron triggers**. It also moves work between
allowances rather than around them: a **cron invocation counts as a Worker
request** (so today's sweep spends 1,440 of each estate's Worker budget each day),
while an **alarm invocation counts only against Durable Objects** (free plan:
100,000 requests/day account-wide, shared with the live feed). Ten estates
sweeping every minute spend ~14,400 of the DO allowance — acceptable — and stop
spending 14,400 of the Workers allowance.

| Scheduling method | Cost | Free-plan ceiling per account |
|---|---|---|
| Cron triggers (today) | 2 of 5 | **2 estates** |
| Cron + dispatcher fan-out | 2 of 5 | ~5–8 estates, each paying one request per tick |
| **Durable Object alarm scheduler** | 0 of 5 | **~8–10 estates**, bounded by requests/D1, not crons |
| Alarm scheduler + tuned heartbeat/poll intervals\* | 0 of 5 | ~10–12 estates |

\* `heartbeatIntervalSeconds` and `syncIntervalSeconds` have floors of 15 s and 5 s
in `isapi-bridge/agent.mjs`; at 60 s/30 s the pair costs 4,320 requests/day per
estate, which is what caps an account at ~10 estates inside 100k requests/day.

### 4.7 The reference design: a capacity-aware placement and rollover loop

The app should not create accounts by itself from inside a single estate's
deployment — a control plane (your laptop, CI, or a `sornix-control` repo) does it,
and the registry it writes is the single source of truth.

```json
// estates/registry.json — one row per estate, no secrets (token refs only, never tokens)
[
  {
    "slug": "royal-palm",
    "estateName": "Royal Palm Estate",
    "cloudflare": { "accountRef": "acct-1", "workerName": "royal-palm-portal",
                    "d1": "royal-palm-db", "d1LocationHint": "weur" },
    "storageRepo": "sornix-storage-royal-palm",
    "retentionDays": 90,
    "licence": { "plan": "managed", "expiresAt": "2027-09-30", "status": "active" },
    "budget": { "estatesPerAccount": 8, "sweep": "durable_object_alarm" }
  }
]
```

The loop, each step of which maps to a row in §4.5's table:

1. **Intake** — a new estate arrives with its branding and its own Cloudflare user
   token (or, for free tier, its own account: preferred, because the estate then
   owns its data).
2. **Place** — the planner reads the registry and picks the account with room:
   reuses an account only if `estates_on_account < estatesPerAccount` **and** the
   daily request estimate still fits at 80 % of 100k. Otherwise it creates an
   account (`POST /accounts`, `standalone: true`, fresh `Idempotency-Key`) — and
   stops when the user's five-account budget is exhausted, reporting "free
   accounts exhausted: register the estate's own account, or move to a paid
   account" instead of silently failing.
3. **Provision** — D1, worker, queue + DLQ, secrets, migrations, branding, the
   storage repo, and the agent credentials, then write the registry row.
4. **Observe** — the hourly job (or a control-plane cron) records each estate's
   `meta.rows_read/rows_written`, request count and database size into the
   registry; the portal shows the fleet's free-plan headroom.
5. **Roll over** — the estate that crosses a threshold is *moved*, not split: a
   new account is created (or an existing one with room chosen), the Worker and
   D1 are deployed there, the D1 export (`POST …/export`) is imported into the new
   database, agents are re-pointed by rotating their secret and rewriting
   `agent-config.json` (`agentId` is stable), and the old deployment is kept
   read-only for a release cycle before deletion. **Gate operation survives the
   move**: the agent keeps polling its configured URL, so re-pointing must be done
   during a low-traffic window and the old Worker kept live until the new one
   answers `/api/health`.
6. **Bill** — the licence row from §6.5 keys off the same `slug`, so provisioning
   and monetisation share one record.

**Where this scheme honestly ends**

| Limit | Number |
|---|---|
| Accounts you can self-create | **5 extra** (6 total) — documented, and the API enforces it |
| Estates on free, as built (2 crons each) | **12** |
| Estates on free, with the DO alarm scheduler and tuned intervals | **~50 mathematically**, **5–15 realistically** (support, NDPA paperwork, no SLA, and the blast radius of one suspended user) |
| Beyond that | **Workers Paid, $5/month**: one account, 250 cron triggers, 50,000 D1 databases, 10 GB per database, no daily stop. At ~5 estates this is cheaper than the operational cost of rolling accounts |

Two cautions that are not technical:

- **The accounts the API creates are owned by *your* Cloudflare user.** Several
  estates then share one owner, one billing identity and one abuse/suspension
  blast radius — weaker for the "the estate owns its data" story in §6.7 than the
  estate registering its own account. For the free tier, having the estate create
  the account and hand you a scoped token is both more honest and more defensible.
- **Do not farm accounts** with plus-addressed emails or extra users to get past
  the documented five. That is the evasion Cloudflare's eligibility rules and the
  `Your user is suspended` error path exist to catch, and getting a user suspended
  takes every estate under it down at once. When the sixth free account is the
  only thing standing between you and the next estate, the right move is the
  $5/month paid account — which is also the point at which the licence layer in
  §6.5 starts paying for itself.

---

## 5. Could GitHub host the whole app? (repo-per-estate, reassessed)

Short answer: **GitHub can hold the parts it already holds — code, releases, proof
files, backups, CI — and it will give you a repository per estate without limit. It
cannot host the API, the database, the realtime feed or the schedules, and its
terms say not to try.** A repository per estate automates *storage*, not capacity,
because the limits a busy estate hits are **per GitHub user, not per repository**.

### 5.1 Layer by layer

| Layer | In this repo | On GitHub? | Why |
|---|---|---|---|
| React SPA | `apps/web/dist` | **Yes — Pages** | Static hosting only. Free Pages means a **public** repo (private-repo Pages needs Pro, $4/month); 1 GB published site, 100 GB/month soft bandwidth, 10 builds/hour. It also buys nothing: `wrangler.jsonc` serves the SPA with `run_worker_first: ["/api/*"]` and **static asset requests are already free and unlimited** on Workers |
| API | `src/index.ts` — Hono, 168 routes, PBKDF2 + HS256 sessions | **No** | Pages runs no server-side code, and a workflow cannot answer an HTTP request — there is no synchronous endpoint anywhere in GitHub |
| Database | D1 — SQL, indexes, `DB.batch()` | **No** | Repository files are not a database: no queries, no indexes, no transactions, every write is a commit |
| Realtime | `AccessLiveFeed` Durable Object (WebSocket) | **No** | Nothing in GitHub holds a socket |
| Schedules | 2 cron triggers (hourly + per-minute) | **No** | Actions cron minimum is **5 minutes** (15 recommended), delayed **10–60 minutes** under load, and disabled after **60 days** of repository inactivity. The per-minute visitor sweep cannot live here: 288 runs/day at one billed minute each is 8,640 of the 2,000 free private-repo minutes per month |
| Event queue | `ACCESS_EVENTS` + DLQ | **No** | No queue primitive |
| File storage | proofs, gate images, exports → private repo | **Yes — already** | `github_storage_settings` + `stored_files`, 4 MB/file. This is the design |
| Release artifacts | bridge exe, Android APK | **Yes — already** | `bridge-apps/`, published from `bridge-*` tags; releases have no total-size or bandwidth limit |
| CI/CD | `.github/workflows/*` | **Yes — already** | Build, test, migrate, deploy |

### 5.2 Why "write each estate into its own repo" cannot replace the database

- **The rate limits are per user, not per repository.** Authenticated REST is
  **5,000 requests/hour** and content creation is **80/minute and 500/hour for the
  whole account**. Creating another repository — or twenty — adds no budget at
  all. It is the same trap as Cloudflare's five-account cap, one layer down.
- **Reads are stale.** `raw.githubusercontent.com` is CDN-cached, so a card change,
  a visitor provisioning or a Security preview written as a commit arrives minutes
  later, and Remote Network Verification's snapshot refresh would be reading a
  cache.
- **Writes collide.** Git has no transactions and no batch: two terminals
  uploading at once means a `409` and a retry loop, where `DB.batch()` today is a
  single atomic call.
- **Size.** Files over 50 MiB warn and over 100 MiB are blocked; repositories are
  recommended to stay under **1 GB** (5 GB strongly recommended). The 500 MB D1
  ceiling you would be escaping becomes a repository whose history is one commit
  per gate event, with no index and no query planner.
- **The audit story gets worse.** `access_events` with five time-ordered indexes
  and a retention job is queryable; commit history is immutable and unqueryable.

### 5.3 The terms are explicit, not just the engineering

GitHub's *Terms for Additional Products and Features* (Actions) prohibit using
Actions for:

> "The provision of a stand-alone or integrated application or service offering
> the Actions product or service, or any elements of the Actions product or
> service, for commercial purposes"; "Any activity that places a burden on our
> servers, where that burden is disproportionate to the benefits provided to users
> (for example, don't use Actions as a content delivery network or as part of a
> serverless application, but a low benefit Action could be ok if it's also low
> burden)"; and, on GitHub-hosted runners, "any other activity unrelated to the
> production, testing, deployment, or publication of the software project
> associated with the repository where GitHub Actions are used."

The stated consequences are terminated jobs, restricted Actions, **disabled
repositories** and **suspended accounts**. Running estates' gate backends on
Actions is a commercial serverless application; the day that is flagged, every
estate under that GitHub user goes dark together — the same concentration risk as
rolling Cloudflare accounts, except here it is written down as prohibited rather
than merely capped.

### 5.4 What a repository per estate *is* genuinely good for

- **Unlimited private repositories on Free** where Cloudflare gives five extra
  accounts: as a *bucket*, repository-per-estate scales without a cap. Automate it
  with `POST /user/repos` plus a fine-grained token (Contents: read and write)
  stored encrypted in `github_storage_settings` — the table, the encryption and the
  4 MB upload path already exist, so this is a small change, not a new
  architecture.
- **Nightly D1 export into the estate's repository** as offsite backup: the
  `exports` table already records `github_path` and `github_url`. One commit per
  estate per day costs nothing and gives real versioned history of the estate's
  data.
- Keep the **product** repository public and every **estate** repository private:
  with Pages out of the picture no estate data ever needs a public repo.

### 5.5 Verdict

| Goal | Possible on GitHub alone? | What to do instead |
|---|---|---|
| Host the SPA on Pages | Yes | Only if an estate wants a Pages URL; it saves **no** free-tier headroom because static assets are already free |
| Replace the API + D1 + Durable Objects + Queues | **No** | Stays on Cloudflare (free) or the container path (`Dockerfile`, `docker-compose.yml`, `setup:platform`) |
| Replace cron triggers with Actions cron | Partly — 5-minute granularity | A 30-minute housekeeping ping fits (1,440 runs ÷ 2,000 minutes); the per-minute sweep never does. Use the Durable Object alarm instead (§4.6) |
| Auto-create a repo per estate for storage | **Yes** | Do it — unlimited, automatable, half-built already |
| Auto-create a repo *to extend free-tier limits* | **No** | The limits that bind (500 content-creations/hour **per user**, no compute, no database, no queue) do not move with a new repository. Capacity comes from runtime accounts, not repos (§4.5–4.7) |
| Leave Cloudflare for a container host | Yes, but not free | Free container tiers sleep or lack the persistent volume the SQLite path needs; a small VPS (~$4–6/month) is the honest self-host. "Sleeps when idle" is disqualifying because the agent polls every 30 s |

**Bottom line:** keep the split that already exists — **GitHub** for code, CI,
releases, proof storage and backups; **Cloudflare** for the runtime, data, realtime
and schedules — and automate repository-per-estate as *storage* while the estate
count is governed by runtime accounts (§4.7).

Which free *runtime* platforms can carry a portfolio without metering every
request — Oracle Cloud Always Free (2 Arm OCPU / 12 GB, ~15–25 estates per VM),
Google Cloud's e2-micro, Northflank's Sandbox, and why Render/Koyeb/Fly.io/Railway
do not fit — is surveyed with capacity maths in
[`FREE-HOSTING-OPTIONS.md`](FREE-HOSTING-OPTIONS.md).

---

## 6. Monetisation in NGN

### 6.1 What exists today, and what is missing

Today the app is **deliberately non-commercial**: no subscription, no licence, no
plan concept, and **no online card collection** — bills are settled by POS, cash
or bank transfer and *recorded* by a Cashier
(`docs/BILLING-IMPORTS.md`, `INITIATE_PAYMENT_CHANNELS` in `src/index.ts`). That
is estate revenue. **SaaS revenue is a separate thing and does not exist yet.**

Monetisation needs exactly three layers:

| Layer | Status | Notes |
|---|---|---|
| 1. A price/tier model | missing | §6.3 |
| 2. A payment rail in NGN | missing | §6.4 — bank transfer needs no provider; Paystack needs CAC |
| 3. A licence that the software checks | missing | §6.5 — must never touch access control |

### 6.2 Free option vs paid option (what a free tier can afford to give away)

In shape A the free tier costs you **₦0 in infrastructure**, so the free tier is
limited by *product value*, not by quota. A free tier that is honestly free and
still leaves room to sell:

| | Free (self-hosted, shape A) | Managed (shape B/D) |
|---|---|---|
| Estate | 1 estate, 1 Cloudflare account (theirs) | 1 estate, your account |
| Residents / units | unlimited | unlimited |
| Terminals / agents | up to 2 devices | unlimited |
| Modules | Core: people, access, visitors, billing, notices | + Staff, Facility bookings, Documents, modules, white-label |
| Retention | 90 days of gate history | 365 days + exports |
| Support | community / docs only | SLA, onboarding, migration, phone |
| Licence | none (perpetual) | annual/monthly licence, expiry + grace |

Never ration: **gate access decisions, emergency contacts, and data export.** A
lapsed estate must be able to take its data out; a lapsed estate's residents must
still be able to walk through their gate.

### 6.3 Price ladder (anchors, not advice)

Two structures are used in Nigerian estates: **flat per estate** and **per unit**
(which mirrors how service charge is collected, so it wins committees over).

| Tier | Suggested anchor | Why |
|---|---|---|
| Free | ₦0 | One estate, self-hosted |
| Managed | **₦15,000–₦25,000 / month** per estate, or **₦150,000–₦250,000 / year** prepaid (~2 months free) | Covers your $5 account fee, support, updates |
| Per-unit variant | **₦100–₦250 / unit / month** | 200 units × ₦150 = ₦30,000/month, lands in the Managed band |
| Growth | **₦40,000–₦60,000 / month** | Multi-gate, multi-street, modules, extra agents |
| Add-ons | Onboarding/migration **₦50,000–₦150,000** one-off; white-label; SMS/notice credits; on-site installation | Margin without raising the base price |

**Design rules learned from the Paystack rate card (§6.4):**

- **Never raise a recurring charge below ₦2,500.** The ₦100 flat fee is waived
  below ₦2,500 and then bites: a ₦2,500 charge costs ₦137.50 (**5.5 %**), a
  ₦5,000 charge costs ₦175 (3.5 %), ₦10,000 → ₦250 (2.5 %), ₦20,000 → ₦400 (2 %),
  and ₦150,000+ hits the ₦2,000 cap (≤1.33 %).
- **Push annual prepay.** Twelve monthly ₦15,000 charges cost 12 × ₦325 = **₦3,900**
  in fees; one ₦180,000 annual charge costs **₦2,000** (the cap). Annual prepay is
  ~₦1,900 cheaper, is collected once, and dodges the biggest Nigerian card problem
  — **failing recurring card charges**.
- Prices in **whole naira** ending in 000/500; quote VAT-inclusive or state
  "+7.5 % VAT" explicitly (see §6.7).

### 6.4 Payment rails in NGN

| Rail | Cost | Requirements | When to use |
|---|---|---|---|
| **Bank transfer + admin records the payment** (zero integration) | **₦0** | none | The first 5–20 estates, and every estate that insists on paying by transfer anyway |
| **Paystack** | Local: **1.5 % + ₦100, capped ₦2,000**; ₦100 waived under ₦2,500; international cards 3.9 % + ₦100. Settlement **T+1** | Starter tier: **BVN + personal account + ID**, ₦2m lifetime cap. Registered: **CAC (BN or RC) + corporate account + TIN** | Default rail: cards, transfer, USSD, DVAs, Subscriptions/Plans API, webhooks |
| **Flutterwave** | Local ≈ **1.4 % + 0.6 % platform fee** (~2 %), international ≈ 4.8 % | CAC + corporate account | Diaspora payers, multi-country estates |
| Monnify / OPay / Interswitch | Comparable; OPay ≈ 1.5 % capped ₦2,000 | CAC | Alternatives; Interswitch for enterprise/committee procurement |

**Recommended order:** ship the **bank-transfer + audited-payment** flow first (it
is ~90 % of the code you need anyway, zero fee, and matches how Nigerian estates
already pay), then add **Paystack Checkout + webhook** for the estates that want to
pay by card, and keep a **Paystack dedicated virtual account (DVA)** per estate so
renewals arrive as transfers that reconcile themselves. Verify DVA availability on
your merchant tier.

**Rate maths for the bands above**

| Charge | Paystack fee | Effective | Net |
|---|---|---|---|
| ₦2,500 | ₦137.50 | 5.50 % | ₦2,362.50 |
| ₦5,000 | ₦175 | 3.50 % | ₦4,825 |
| ₦15,000 | ₦325 | 2.17 % | ₦14,675 |
| ₦30,000 | ₦550 | 1.83 % | ₦29,450 |
| ₦180,000 | ₦2,000 (cap) | 1.11 % | ₦178,000 |

### 6.5 The licence gate (and the one thing it must never do)

Enforcement belongs in **one place**: a licence record the Worker verifies
offline, refreshed by cron. It must be structurally impossible for licensing to
decide a gate.

**Claims** (Ed25519-signed JSON, public key embedded in the Worker — Workers Web
Crypto already implements the session crypto in `src/security.ts`):

```json
{
  "v": 1, "estate": "<estate slug>", "plan": "managed",
  "units": 250, "terminals": 6, "modules": ["staff","facility_booking","documents"],
  "iat": "2026-10-01T00:00:00Z", "exp": "2027-09-30T23:59:59Z", "grace_days": 30
}
```

**Storage and flows**

- `licences(id, estate_ref, plan, units, terminals, modules_json, licence_json, signature, issued_at, expires_at, grace_days, last_verified_at, status)` and `saas_invoices(...)`, `saas_payments(...)` — a new migration, mirroring the audited-payment shape the app already uses for `payments`.
- **Bank transfer flow:** Administrator opens **Plan & billing** → the portal issues an NGN invoice (estate name, period, amount, operator account, reference) → estate pays → operator/Cashier marks it paid with proof upload (the existing `stored_files` GitHub path) → a new signed licence is issued and pasted/applied in one click.
- **Paystack flow:** `POST /api/billing/checkout` → Paystack `/transaction/initialize` with `amount` in kobo, `reference` = invoice id → redirect to `authorization_url` → `charge.success` webhook, verified by **HMAC-SHA512 of the raw body against `x-paystack-signature`**, then a server-side `/transaction/verify/:reference` before marking paid → new licence issued.
- **Self-hosted estates (shape A):** keep a small **licence issuer** (one Worker on your account) with a per-estate activation token; the estate's Worker fetches or accepts the signed licence, verifies the signature locally, and caches it. Nothing about gate operation ever calls the issuer.
- **Cron:** re-verify daily; write `licence_status` into `settings` and show a banner at `exp - 60 / -30 / -7` days.
- **Offline grace:** minimum 14–30 days without a successful check. A licence-server outage must never lock an estate out — the same reasoning as "a failed credential sync keeps the previous snapshot".
- **Expiry behaviour:** portal becomes **read-only for Administrators beyond export**, with a persistent renewal banner; Managers/Residents keep normal read access; **cards, fingerprints, visitor passes, remote verification, device operations and the agent are untouched.**

**Gate these in tiers:** devices/agents count, modules, manager accounts,
retention length, exports/API, white-label, multi-property beyond N.

**Never gate:** gate access decisions, emergency contacts/notices, a
resident's own data, and data export.

**Second revenue line (optional, decide deliberately).** Paystack supports split
payments via subaccounts, so you could switch estate bill collection to online
payments with the estate as the settlement account and a small platform fee to
you. That contradicts the current deliberate "no paid payment provider" stance
(`README.md`), needs each estate's own onboarding, and must be a separate,
opt-in module — do not sneak it in under billing.

### 6.6 Failure modes to design against

| Failure | Consequence | Mitigation |
|---|---|---|
| Paystack auto-renew fails (expired card, bank decline) | revenue leak, angry admin | annual prepay + DVA transfer + dunning notices at -30/-14/-3 days |
| Free-plan Error 1027 / D1 daily stop | portal dark for the estate | agent-side operation is unaffected; queue drains later; capacity guardrail alerts first |
| Licence server down | renewals blocked, no lockout | signed licence + offline grace; issuer is stateless |
| Chargeback/dispute | Paystack holds funds | verified webhook + reference discipline + audited invoice trail |
| Estate disputes "I paid" | support load | payment reference on the invoice, webhook record, audited `saas_payments` |

### 6.7 Nigerian compliance checklist

- **NDPC registration.** A vendor processing residents' personal data (names, phone
  numbers, gate images) for more than **200 data subjects in six months** is a
  **data controller/processor of major importance** and must register with the
  NDPC; the guidance notice's **Ordinary-High Level** fee is **₦10,000/year** (UHL
  ₦250,000). Confirm your tier with the NDPC's Guidance Notice. Community-based
  associations are among the exempt categories, but **a commercial vendor is not
  one**. Practical extras: a written processor agreement with each estate
  (NDPA s.29), a DPO/contact, breach notification inside **72 hours** from
  awareness, and a record of the **cross-border transfer** basis — Cloudflare's
  global network and the private GitHub repository mean estate data leaves
  Nigeria, and s.41 requires that transfer to be documented and justified.
- **Taxes (2026 reforms, confirm with an adviser).** Under the Nigeria Tax Act
  2025, small companies (turnover ≤ ₦100m and fixed assets ≤ ₦250m) are **exempt
  from CIT and the 4 % development levy**, and VAT registration/collection
  thresholds were raised — sources disagree between ₦25m/₦50m/₦100m for VAT, so
  confirm before quoting a VAT-inclusive price. Until you reach the threshold,
  quote prices inclusive and say so. Register with **FIRS** for TIN early: Paystack
  needs it for a registered business.
- **Payments.** Starter tier (BVN + personal account + ID, ₦2m cap) is enough to
  take the first customers; move to CAC + corporate account before the cap and
  before signing an estate that wants a corporate invoice.
- **Contracts.** Annual terms, data-processing annex, retention period, and an
  explicit "the estate is the data controller, we are the processor" clause.

---

## 7. Change list (repo-ready, in priority order)

| # | Change | Where | Effort |
|---|---|---|---|
| 1 | Default `access_event_retention_days` to **90** for new deployments; add an Administrator control with a size estimate | `migrations/0012_…`, portal Settings | hours |
| 2 | Free-plan **capacity card**: cron writes `meta.rows_read/rows_written` plus request counts into `settings`, portal shows headroom and alerts at 80 % | `src/index.ts` hourly job | days |
| 3 | **Plan & billing** page: plan, usage, invoice list, bank-transfer instructions, proof upload, audited "mark paid" | portal + API | ~1 week |
| 4 | **Licence module**: Ed25519 verify, `licences`/`saas_invoices`/`saas_payments` migration, banner, read-only-after-grace (access control untouched) | `src/licence.ts` + migration | ~1 week |
| 5 | **Paystack integration**: checkout init, HMAC-verified webhook, verify, DVA/reference reconciliation, licence issuance | `src/billing.ts` | ~1–2 weeks |
| 6 | **Estate registry + placement planner** (`estates/registry.json` → capacity-aware pick of account/deployment, refuses past the free-account budget with a clear message) | `scripts/` | ~1 week |
| 7 | **Provisioning executor**: account → D1 → migrations → queue/DLQ → worker/assets → secrets → branding → storage repo, then write the registry row; `--dry-run` first | `scripts/` | ~1–2 weeks |
| 8 | **Rollover**: D1 export/import, agent re-point during a low-traffic window, old deployment read-only for a release cycle | `scripts/` + docs | ~1 week |
| 9 | **Alarm-based scheduler** (free fleet > 2 estates per account) | `src/live-feed.ts` or a new DO | ~3–5 days |
| 10 | **Per-estate storage repo automation + nightly D1 export backup** (`POST /user/repos`, fine-grained token encrypted in `github_storage_settings`, export → repo) | `src/github-storage.ts`, `scripts/` | ~3–5 days |
| 11 | Docs: per-estate runbook, free-plan guardrails, NDPA annex, NGN price sheet | `docs/` | days |
| 12 | *(Only if self-serve is the strategy)* `estate_id` multi-tenancy | migrations + `src/index.ts` (168 routes, 40+ tables) | **weeks** |

Not to be built: any licensing hook inside `device_operations`, `remote_verify`,
visitor passes, or card/fingerprint state; card collection of estate bills under
the current no-provider design; per-estate promises of uptime on the free plan.

---

## 8. Sources

- Cloudflare Workers limits (requests/day, cron triggers per account, static
  assets, subrequests): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing (free vs standard, what counts as a request,
  cron example): https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare D1 limits (10 databases and 500 MB free, 5 GB/account):
  https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare D1 pricing and the "queries stop when the daily limit is hit"
  FAQ: https://developers.cloudflare.com/d1/platform/pricing/
- Paystack Nigeria transaction fees and compliance requirements:
  https://support.paystack.com/en/articles/2123970 ·
  https://paystack.com/blog/product/paystack-starter-businesses
- NDPC Guidance Notice on Registration of Data Controllers and Processors of
  Major Importance (200 data subjects / six months; OHL ₦10,000):
  https://ndpc.gov.ng/wp-content/uploads/2025/07/Updated-Guidance-Notice-on-Registtration-2024.pdf
- Nigeria Tax Act 2025 small-company thresholds and 2026 exemptions:
  https://fiscalreforms.ng/ (confirm the VAT threshold with an adviser)
- Cloudflare account creation (5 additional Free accounts, 7-day user age,
  Super Administrator role, `standalone: true`, `Idempotency-Key`, user-owned
  token with User Details Read):
  https://developers.cloudflare.com/fundamentals/account/create-account/
- Cloudflare D1 create-database API (`POST /accounts/{account_id}/d1/database`,
  `primary_location_hint`):
  https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/
- Workers for Platforms pricing ($25/month, 20M requests, 1,000 scripts) and the
  free-tier unavailability of dispatch namespaces:
  https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/ ·
  https://developers.cloudflare.com/use-cases/saas/
- GitHub REST API rate limits (80 content-generating requests/minute, 500/hour):
  https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub Terms for Additional Products and Features — Actions may not be used for
  commercial service provision or "as part of a serverless application", with
  repository-disablement and account-suspension consequences:
  https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- GitHub Pages usage limits and the paid-plan requirement for private-repo Pages:
  https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- GitHub Actions billing and scheduled-workflow limits (2,000 free private-repo
  minutes/month, 5-minute cron minimum, delays, 60-day inactivity disable):
  https://docs.github.com/en/billing/concepts/product-billing/github-actions ·
  https://docs.github.com/en/actions/reference/events-that-trigger-workflows#schedule
- GitHub file and repository size limits (50 MiB warn, 100 MiB block, 1 GB/5 GB
  repository guidance):
  https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
