# Free hosting options for a multi-estate deployment (2026)

The question this answers: **which free platforms can run Sornix EstateOS for many
estates without hitting the free limits?** Every figure below was read from the
provider's own docs or a dated 2026 source on **2026-10-11**, with the numbers
that changed this year called out. Free tiers move; re-check before committing an
estate to one.

Companion to [`FREE-TIER-CAPACITY-AND-NGN-MONETISATION.md`](FREE-TIER-CAPACITY-AND-NGN-MONETISATION.md),
which covers what one estate costs, why the Cloudflare free plan is a per-estate
plan, and the provisioning/rollover loop.

---

## 1. The rule that decides everything

**Serverless free tiers meter the thing a portfolio multiplies, and VPS-shaped
free tiers do not.**

| Free-tier shape | What is capped | Multiplies with estates? |
|---|---|---|
| Serverless requests (Workers 100k/day, 5 crons/account) | every API call, every poll, every cron | **Yes — badly.** 10 estates = 10× the metered traffic in one budget |
| Serverless rows/ops (D1 100k writes, 5M reads, Queues 10k ops) | every write | Yes |
| **A whole machine** (Oracle, GCP) | CPU, RAM, disk, egress — **not requests** | **No.** 10 estates on one box cost the same quota as one, until the box itself fills |
| Owned hardware (estate mini-PC / Pi) | electricity | No — there is no quota at all |

So "without hitting the free limits" has exactly three honest answers:

1. **Own the account**: every estate on its own free account (the Cloudflare path
   in §4.7 of the companion doc). Free, but capped at five extra accounts per user.
2. **Own the machine**: one free VPS running many estates (§3). No request metering,
   no cron cap, no account cap — the limits are CPU/RAM/disk, which consolidation
   controls.
3. **Own the hardware**: the estate's own mini-PC/Raspberry Pi/office PC runs the
   app (§4). Zero quota, zero recurring cost, and the repo already supports it.

Everything else is a trial wearing a free label.

---

## 2. The platforms, checked (2026-10-11)

| Platform | What is actually free now | Fits this app? | Catch that decides it |
|---|---|---|---|
| **Oracle Cloud Always Free** | **2 Arm OCPU + 12 GB RAM** always-on, **plus 2 × AMD micro VMs** (1/8 OCPU, 1 GB each), **200 GB block storage**, **10 TB/month egress**, 20 GB object storage | **Yes — best fit.** A real machine: no request metering, no cron cap, WebSockets and SQLite are just a process and a file | Card for identity verification; ARM capacity is often "out of capacity"; **allowance was halved June 15 2026** (4/24 → 2/12, enforced Aug 18 2026); idle instances may be reclaimed |
| **Google Cloud Always Free** | 1 non-preemptible **e2-micro** (1 GB RAM) + 30 GB standard disk + **1 GB/month North America egress**, in us-west1/us-central1/us-east1 | Marginally — one estate at most | **1 GB egress/month** is the killer: a portal with agents and residents will exceed it and start paying. 1 GB RAM is tight |
| **Northflank (free Sandbox)** | **2 always-on services, 1 database, 2 cron jobs**, no sleeping | Maybe — one or two estates | Card required even for free. Persistent volumes are priced ($0.15/GB-month) and a free-tier volume is not documented — **verify before trusting SQLite here** |
| **Cloudflare Workers Free** (incumbent) | 100k requests/day, 5 crons/account, 10 D1 databases, 500 MB/DB, 5 GB/account | **Yes — one estate per account** | Per-account, not per-estate (see companion doc §4) |
| **Render (free Hobby)** | 512 MB / 0.1 CPU web services, 750 instance-hours/month | **No** | **Free services cannot attach a persistent disk**, and Render states local files (including a SQLite database) are lost on every redeploy, restart or spin-down; free Postgres expires after 30 days; docs say free instances are not for production |
| **Koyeb** | — | **No** | Free tier removed for new users (Feb 2026); Pro from $29/month |
| **Fly.io** | 2 VM-hours or 7 days trial | **No** | Free allowances retired for new organisations; a minimal always-on machine is ~$2–5/month plus volume |
| **Railway** | $5 one-time trial, then ~$1/month credit | **No** | $1/month does not run a 24/7 service (that is ~$5/month) |
| **Zeabur** | $5/month usage credit, no card | Maybe | Credit-based, and persistent-volume behaviour on the free credit is not documented |
| **AWS / Azure** | Time-limited (12 months / 30-day credits) | **No** | Trials, not always-free; and free-tier compute is the smallest shape only |

### The 2026 changes that invalidate older advice

- **Oracle halved its Arm allowance** on **June 15, 2026**: 4 OCPU / 24 GB →
  **2 OCPU / 12 GB**, enforced from **August 18, 2026** (excess instances are
  terminated). Any guide still quoting 24 GB is out of date.
- **Koyeb's free tier is gone** for new accounts, and **Fly.io's** went in 2024.
- **Render's free tier cannot persist a database file** — the single fact that
  rules it out for this app.
- AWS's twelve-month free compute path has also been narrowed for new accounts;
  verify before planning around it.

---

## 3. The recommended free portfolio host: one Oracle Cloud Always Free VM

A single **2 OCPU / 12 GB** Ampere VM is the only genuinely free, permanent,
always-on machine left, and it is enough for a whole portfolio because nothing
about this app needs a machine per request.

### Capacity maths

The app's runtime per estate is one Node/workerd process serving the API + SPA and
writing to one SQLite file (`wrangler dev --local --persist-to /data`, exactly what
`Dockerfile` and `docker-compose.yml` already do):

| Per estate (measured pattern) | Value |
|---|---|
| Resident memory | ~120–250 MB RSS |
| CPU | requests are query-bound; latency matters more than throughput |
| Disk | 10–50 MB/year of data at 90-day event retention |
| Network | ~6,000–7,500 requests/day from the agent + portal (not metered here) |

| Box | Estates with headroom | Notes |
|---|---|---|
| **1 × Arm VM (2 OCPU / 12 GB)** | **~15–25** | ~200 MB/estate + Caddy + backups; leave 2 GB for the OS |
| **1 × AMD micro (1 GB)** | 1–3 | 1 GB RAM is the binding constraint, not CPU |
| **All three free VMs** | ~20–30 plus two satellites | Put the heaviest estates on the Arm box |

Compare that with the same machine metered: 20 estates ≈ 130k requests/day, which
would blow Cloudflare's free 100k budget, while on a VM it costs nothing extra.

### What makes it work with this repo, unchanged

```bash
# on the VM, once per estate
git clone https://github.com/<org>/estatemate-minmoe /opt/sornix/royal-palm
cd /opt/sornix/royal-palm && docker compose up -d --build   # port 8788, 8789, …
# Caddy in front: royal-palm.example.com → localhost:8788 (automatic TLS)
```

- `Dockerfile` already applies migrations to a persistent `/data` volume and serves
  API + SPA from one container.
- The estate's own agent keeps pointing at `https://royal-palm.example.com`, so the
  bridge, ESP32 gate and Pi gate need **no changes**.
- Durable-object behaviour is emulated locally, so the live feed works as a
  WebSocket to the same origin.

### The one real gap: schedules do not run in the local/self-hosted path

`wrangler dev --local` **never fires cron triggers** — there is no scheduler in
local mode. Today that means the two jobs in `src/index.ts` (hourly housekeeping:
property lifecycle, facility-fee enforcement, presence expiry, retention pruning,
visitor sync; and the per-minute visitor-slot release) **do not run on the Docker
or systemd path**. The fix is small and uses Wrangler's own test hook:

```bash
# start with the scheduler endpoint enabled
npx wrangler dev --local --ip 0.0.0.0 --port 8787 --persist-to /data --test-scheduled

# drive it from systemd timers (or host cron)
curl -s "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=15+*+*+*+*"   # hourly
curl -s "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"    # per-minute
```

Older Wrangler builds expose the same endpoint as `/__scheduled`; both accept the
`cron=` parameter so the handler can branch on `event.cron`. Two systemd timer units
(or a two-line crontab) replace Cloudflare's cron triggers, and a VPS has no
five-trigger cap. **This is the change to make before recommending the self-hosted
path for anything that depends on facility-fee expiry or visitor-slot release.**

Two safety notes when you do it:

- **Keep the scheduler endpoint private.** It is a local control surface, not an
  API: run the timers on the host against loopback, and have the reverse proxy
  refuse `/cdn-cgi/local/*` (and `/__scheduled`) from the Internet. Do not expose a
  cron trigger to anyone who can type a URL.
- **Prove it fired.** Log the timer's `curl` exit status, or have the job write a
  heartbeat row, because a silent scheduler is exactly the failure the current
  Docker image has today.

### Two operational rules for the free VM

- **Idle reclamation.** Oracle may reclaim an Always Free instance when CPU
  (95th percentile), network, *and* memory all stay below 20 % for seven days. A
  single quiet estate on a 12 GB box can look idle. Keep a baseline (several
  estates per box, a monitoring agent, nightly backup work), watch the metrics, and
  keep the estate's data backed up off-box regardless.
- **Backups are the price of free.** Nightly `wrangler d1 export` of each estate's
  SQLite file, committed to that estate's private GitHub repo (the `exports` table
  already records `github_path`/`github_url`), so a reclaimed VM is an
  inconvenience, not a data loss. This is also where GitHub genuinely belongs
  (see §5 of the companion doc).

---

## 4. The zero-quota option: run it on hardware the estate already owns

The repo's own README argues that a small always-on computer on the estate LAN is
enough for the agent; the same computer can host the portal too, and then **no
cloud quota exists at all**:

| Host | Runs | Cost |
|---|---|---|
| The gatehouse/office Windows PC | Agent (+ portal via Docker Desktop or WSL2) | ₦0 extra |
| Raspberry Pi 4/5 (4–8 GB) | Portal (Docker) + agent, systemd units, `docs/MULTI-PLATFORM-INSTALLATION.md` Option C | ~₦70–120k once |
| Mini-PC (N100, 8–16 GB) | Same, more headroom for several streets | ~₦150–250k once |

Trade-offs to state plainly: no offsite copy unless a backup job pushes to GitHub
(nightly export again), and no public URL unless a Cloudflare Tunnel
(`scripts/cloudflared-remote-access.mjs`, human access only) is added. Both are
already in this repo. For an estate that is cost-sensitive and has a compliant
always-on device, this beats every cloud free tier on limits, because it has none.

---

## 5. Recommendation

| Situation | Use | Why |
|---|---|---|
| 1–2 estates, least effort | **Cloudflare Workers Free, one account per estate** | Zero cost, zero ops, the repo's native path |
| 3–25 estates on a budget | **Oracle Cloud Always Free VM(s)** with Docker Compose + Caddy, one container and one SQLite file per estate, systemd timers for schedules | No request metering, no cron cap, no account cap; the only free tier where a portfolio does not multiply a quota |
| Fewer than ~5 estates that must stay free *and* be simplest | Cloudflare free accounts (up to 5 extra per user) | Avoid standing up a VM for two estates |
| Beyond free, or when the estate demands isolation and offsite backup | Cloudflare **Workers Paid** ($5/month/account, 250 crons, no daily stop) or a **$4–6/month VPS** | The moment a licence is being sold (₦15k–₦25k/month), $5 of hosting is not the constraint — reliability, backups and support are |
| Estate with a compliant always-on device | Self-host on that device | No quota at all; add GitHub-export backups and the tunnel for remote access |

**Do not** put a paying estate on Render's free tier, Koyeb, Fly.io, or a
credit-based free plan: the failure modes (no persistent disk, expiry, credit
exhaustion) all land on the estate's data or uptime, and none of them is worth the
few dollars saved.

---

## 6. Sources

- Oracle Cloud Free Tier changes (2 OCPU / 12 GB Arm, AMD micros and 200 GB
  unchanged, enforcement from 2026-08-18):
  https://www.cnelecar.com/blog/oracle-always-free-arm-limits-cut-2026/ ·
  https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/
- Oracle idle-reclamation policy (CPU/network/memory 95th percentile < 20 % over
  seven days): https://en.inithtml.com/resources/oracle-cloud-free-tier-review-after-real-world-use-truly-free-but-is-it-worth-it/
- Google Compute Engine Always Free (1 e2-micro, 30 GB, 1 GB North America egress):
  https://cloud.google.com/products/compute ·
  https://agentdeals.dev/vendor/google-compute-engine
- Northflank free Sandbox (2 services, 1 database, 2 cron jobs, always-on; card
  required): https://freetier.co/directory/products/northflank
- Render free-tier conditions (no persistent disks on free services, local files
  lost, 30-day Postgres expiry, "not for production"):
  https://render.com/docs/free · https://bex.co/blog/2026/09/23/render-free-postgres-30-day-expiry
- Fly.io free allowances retired / Koyeb free tier removed for new users:
  https://www.saaspricepulse.com/blog/flyio-free-tier-2026 ·
  https://toolfreebie.com/koyeb-free-tier-alternatives/
- Wrangler local cron endpoint (`wrangler dev --test-scheduled`, cron query
  parameter): https://developers.cloudflare.com/workers/examples/cron-trigger/
