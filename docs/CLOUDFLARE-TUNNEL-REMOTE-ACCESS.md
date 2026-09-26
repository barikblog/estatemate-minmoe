# Cloudflare Tunnel remote access (Free plan)

How to reach an estate's gate terminals, its agent host and its LAN services from
anywhere **without opening a port, buying anything, or putting a terminal on the
public Internet** — and why that last part is not negotiable.

Generate the kit:

```bash
node scripts/cloudflared-remote-access.mjs \
  --team <your-zero-trust-team> \
  --tunnel estatemate-lan \
  --lan 192.168.88.0/24 \
  --devices isapi-devices.json \
  --out cloudflared/

node scripts/cloudflared-remote-access.mjs --check cloudflared/cloudflared-config.yml
```

`--check` exits 0 when a config is a compliant private-network config, 1 when it
would expose a terminal, and 2 on a usage error, so it can gate a review or a CI
step. `npm run tunnel:plan -- --lan <cidr> ...` runs the same generator.

The generated `SETUP.md` carries the dashboard steps, the seat arithmetic and the
rollback; this page is the reasoning behind it.

## The one-minute version

- Cloudflare Tunnel is free (unlimited tunnels, unmetered bandwidth).
- Zero Trust Access is free for up to 50 users, but **a user is a human who
  authenticates — access devices consume no seats**.
- Free-plan **public hostnames are HTTP/HTTPS only**. Arbitrary TCP needs a client
  (`cloudflared`/WARP) on the connecting side or paid Spectrum.
- A Hikvision terminal cannot run either client, so **a terminal can never dial
  into a Cloudflare Tunnel**. ISUP (port 7660) cannot cross it from the device side.
- Therefore this kit wires **WARP private-network routing**: the estate subnet is
  published to *enrolled admins*, not to the Internet. No public hostname, no DNS
  record, no listener.

## Why private-network routing is the default

`README.md` sets the rule: *"Never port-forward a terminal's ISAPI/admin interface
to the public Internet, and never run the agent anywhere except the device LAN."*
A tunnel that publishes `gate1.example.com` → `http://192.168.88.11` is a
port-forward with Cloudflare in front, and it puts the terminal's admin UI (and the
ISAPI credentials typed into it) on the public Internet — plus Cloudflare terminates
TLS, so that traffic is readable at the edge.

WARP private-network routing keeps the promise:

| | WARP private network (default) | Public hostname (opt-in) |
|---|---|---|
| Public DNS name | none | yes, resolvable by anyone |
| Internet-reachable listener | none | Cloudflare edge, gated by Access |
| Client install | Cloudflare One Client (free) | none — any browser |
| Works for SSH/RDP/ISUP-ish raw TCP | yes | not on the free plan |
| Traffic visible to Cloudflare | no (WireGuard, end-to-end to the tunnel host) | yes, terminated at the edge |
| Seat cost | 1 per authenticating human | 1 per authenticating human |

The generator refuses to emit a public hostname unless you pass **both**
`--domain <zone>` and `--allow-public-hostnames`. Two flags is a deliberate speed
bump: it records a considered exception instead of making exposure the default.

If you do opt in, protect every hostname with a Cloudflare Access policy
(one-time-PIN to an allow-list of admin emails is enough, and needs no identity
provider) and prefer a read-only device account to the terminal's `admin` login.
`--check` reports a `tcp://` service behind a public hostname as an error, because
the free plan cannot proxy it.

## Setup order (the part that trips people up)

1. **Create the tunnel** in **Zero Trust → Networks → Tunnels**, on the host that
   already runs the EstateMate agent. One host, one always-on machine — the tunnel
   adds no new hardware requirement.
2. **Install `cloudflared` as a service** (`winget install --id Cloudflare.cloudflared`
   then `cloudflared.exe service install <TOKEN>`, or `sudo cloudflared service install <TOKEN>`).
3. **Publish the private network**: dashboard **Private Network** tab for a
   token-managed tunnel, or `cloudflared tunnel route ip add 192.168.88.0/24 <tunnel>`
   for a locally managed one.
4. **Remove the estate range from Split Tunnels.** WARP excludes private ranges by
   default, so the route above is invisible until you delete it from the Exclude
   list (or switch to Include mode). Then sign out and back in on the client.
   This is the step that makes people think the tunnel is broken.
5. **Enroll the humans** in **Settings → WARP Client → Device enrollment
   permissions** (Allow policy on admin emails; one-time PIN needs no IdP) and set
   the team domain `<team>.cloudflareaccess.com` in the client.
6. **Verify**: `cloudflared tunnel info <tunnel>` shows edge connections, and a
   terminal answers at `http://192.168.88.11` just as it does on site.

## Free-plan limits that actually matter

| Limit | Free | Consequence for an estate |
|---|---|---|
| Zero Trust users | 50 | A seat is consumed by authentication, not by a device. 4 admins = 4 seats |
| Log retention | 24 hours | Do not treat Cloudflare logs as the audit trail — `access_events` and `isapi_sync_logs` are |
| Support / SLA | Community, no SLA | **Never route access control through the tunnel.** If Cloudflare or your home ISP is down, cards must still open gates |
| Physical locations | 3 | Irrelevant here (no Gateway locations needed) |
| Public hostnames | HTTP/HTTPS only | Raw TCP (SSH/RDP/ISUP) needs a client, or paid Spectrum |
| Sign-up | Payment details may be requested | The free plan stays $0; no paid product is required by this kit |

## What this kit deliberately does not do

- **No ISUP.** ISUP/EHome is the device dialling a raw TCP platform (7660, with
  8003/8004 for streams) and authenticating with an EHome key. A K1T terminal
  cannot run `cloudflared` or WARP, cannot present a Cloudflare Access identity,
  and the free plan publishes no raw TCP — so there is no free path from a terminal
  to Cloudflare. ISUP could only terminate on a LAN host running a Hikvision SDK
  adapter, which is the `isup-gateway/` transport retired in migration
  `0013_agent_only_transports.sql`; the agent already covers the same terminals
  bidirectionally over documented ISAPI. See `MINMOE-NO-PC.md` for the decision
  record and `device-profiles/` for the per-model evidence requirement.
- **No device → cloud event push.** A terminal cannot authenticate to an
  Access-protected hostname, and an unauthenticated listener would be the retired
  HTTP Listening transport. The agent already uploads events in batches.
- **No Worker → terminal commands through the tunnel.** Workers cannot join a WARP
  private network. Reaching a terminal from the Worker would require a public
  hostname plus a service token — the exposure `README.md` forbids. Commands stay
  agent-side via operation polling, which is also why card operations keep working
  when the tunnel is down.
- **Nothing on the access path.** Events and card operations never traverse the
  tunnel, so gate operation does not depend on Cloudflare, WARP, or your home
  Internet connection.

## Operating notes

- Treat the enrolled admin list as privileged access: an enrolled device can reach
  every terminal and service on the routed subnet. Keep the team small, revoke
  seats when someone leaves, and keep terminal passwords out of chat.
- The tunnel host is the same machine as the agent. If it is off, remote access is
  gone but gates still work; the portal shows the agent offline within 3 minutes.
- Renumber the estate LAN away from `192.168.0.0/24` / `192.168.1.0/24` if you can:
  WARP routes by destination IP, so an admin sitting behind one of those ranges
  loses local access while connected. The generator warns when it sees this.
- Rollback: delete the IP routes (`cloudflared tunnel route ip delete <cidr>`),
  `cloudflared service uninstall`, delete the tunnel, then remove the enrolled
  identities. The agent never used the tunnel, so nothing else changes.
