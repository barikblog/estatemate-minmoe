# A public IP and a port forward: what to point them at

You have a public IP, a router you can edit, and an access-control terminal to
add. This page is the decision and the steps. It is a companion to
[`INBOUND-ACCESS-CONTROL.md`](INBOUND-ACCESS-CONTROL.md), which covers the site
whose router **cannot** be edited; everything about the security envelope
(allowlist, shared secret, rate limit, socket identity) lives there and is not
repeated here.

## 1. Decide what sits behind the forward

A port forward is a mapping: *external port → internal address:port*. The whole
question is **what the internal address is**, because that decides whether the
Internet reaches an access decision or an access device.

| Behind the forward | Verdict | Why |
|---|---|---|
| A terminal's ISAPI / admin interface | **Never** | `README.md` forbids it, `npm run inbound:check` reports it as an error, and it publishes an admin login and card data. A terminal has no allowlist, no rate limit and a default password. |
| The **app itself** (self-hosted portal) | **Only with a reverse proxy and TLS** — and prefer a tunnel | Topology B below. Never expose the raw `wrangler dev` port. |
| The agent's **LAN event listener** (a push-only terminal calls in) | **Yes, if the terminal is off-site** | Topology D below — this is the only case that needs a forward, and the repo already enforces the envelope on it. |
| Nothing (no rule at all) | **Best** | The agent dials out for everything; a default install opens no port. |

**The rule that keeps this simple:** terminals are reached *from* the estate, and
the app is reached *from* the terminal, both as outbound connections. Inbound is
the exception, and it is only ever the agent's listener — never a terminal.

## 2. Topology A — recommended: open nothing

```text
Terminal ──ISAPI alertStream (LAN)──▶ Agent ──outbound HTTPS──▶ App (Worker or VPS)
```

- Hikvision MinMoe/ISAPI terminals: the agent holds the `alertStream`; no inbound
  port anywhere, no forward, no listener.
- ZKTeco and push-only firmware: the terminal pushes to the agent's listener on
  the **estate LAN** (Topology C) — still no forward, because both ends are on the
  same network.
- The app being on a public URL changes nothing here: `workers.dev`, a VPS or a
  self-hosted instance are all just an outbound HTTPS destination for the agent.

Do this unless a terminal is genuinely on another network (Topology D).

## 3. Topology B — the app itself is behind the public IP

Use this when you self-host the portal (Docker/`docker-compose.yml`, systemd) and
want residents, managers and agents to reach it from the Internet.

**Do not** forward `8787` to the container. `wrangler dev` is a development
server: no TLS, and its protections are not the ones you want on the Internet.
Put a real proxy in front and expose exactly one port.

```bash
# 1. Only the proxy is reachable from outside. Loopback-bind the app container.
#    docker-compose.yml: replace  "${PORT:-8787}:8787"
#    with "127.0.0.1:${PORT:-8787}:8787"  (do this only on the public-IP host;
#    an estate-LAN install keeps the plain mapping so residents can use it).
```

```caddyfile
# 2. Caddy gets and renews the certificate by itself. Needs a hostname —
#    a dynamic DNS name works (portal.royalpalm.ddns.net). A bare IP cannot get
#    a publicly trusted certificate, and the agent's secret must not travel in
#    clear text: TLS is not optional.
portal.example.com {
	reverse_proxy 127.0.0.1:8787
	# The local cron endpoint (see FREE-HOSTING-OPTIONS.md §3) is host-local.
	@localScheduler path /cdn-cgi/local/* /__scheduled
	respond @localScheduler 404
}
```

```bash
# 3. Forward exactly one port on the router:
#      external 443/tcp → 192.168.88.5:443      (the host running Caddy)
#    Nothing else. No 80 unless you want the HTTP→HTTPS redirect.
# 4. Host firewall: allow 443 from anywhere, and close 8787 to everything but loopback.
sudo nft add rule inet estatemate input tcp dport 8787 ip saddr != 127.0.0.1 drop
```

Then:

- **Secrets.** A self-hosted install must run with the generated
  `SESSION_SECRET` / `DEVICE_INGEST_KEY` / `STORAGE_SECRET` from
  `sornix.env` (`npm run setup:platform`), never the placeholders.
- **Agents.** Each estate's `agent-config.json` gets
  `"workerUrl": "https://portal.example.com"` — HTTPS, because the agent secret
  and every card number ride that connection. `npm run inbound:check` errors on
  plain `http` to a non-private address for that reason.
- **CGNAT.** If your ISP puts you behind carrier-grade NAT (address in
  `100.64.0.0/10`, or the WAN IP differs from what the Internet sees), **inbound
  forwarding is impossible** — put the app on a VPS or keep the Cloudflare Worker
  deployment. `inbound:check` warns when it sees a CGNAT address in the config.
- **Portal access control.** The app authenticates its own users (PBKDF2 +
  sessions) and roles. Add Cloudflare in front (proxied DNS) if the domain is on
  Cloudflare — it gives you a free WAF, rate limiting and a way to hide the origin
  IP, so the ISP IP is not the thing under attack.
- **Alternative that needs no forward:** the free Cloudflare Tunnel kit
  (`scripts/cloudflared-remote-access.mjs`) publishes the LAN to enrolled humans
  over WARP with no public hostname. It carries **human** access only — a device
  cannot run WARP or complete an Access login, which is why device traffic never
  uses it.

## 4. Topology C — the app is cloud-hosted, the terminal only pushes

Both ends are on the estate LAN, so there is still no router change:

1. `agent-config.json` — enable one listener and bind it to the agent host's LAN
   address:

```jsonc
{
  "lanEvents": {                       // Hikvision "HTTP Listening" / "Alarm Server"
    "enabled": true,
    "port": 8080,
    "bindAddress": "192.168.88.5",     // the agent host's LAN address, not 0.0.0.0
    "allowedSources": ["192.168.88.0/24"],
    "allowUnknownSources": false,
    "requireTerminalKey": true,
    "terminalKey": "<long random secret>",
    "maxRequestsPerMinute": 600,
    "trustReportedDeviceIp": false
  }
  // or, for a ZKTeco/ADMS terminal:
  // "zktecoPush": { "enabled": true, "port": 8089, "bindAddress": "192.168.88.5",
  //                 "allowedSources": ["192.168.88.0/24"], "requireAgentKey": true,
  //                 "agentKey": "<long random secret>" }
}
```

2. Firewall on the agent host — allow the device VLAN, refuse the rest:

```powershell
netsh advfirewall firewall add rule name="EstateMate LAN events" dir=in action=allow protocol=TCP localport=8080 profile=private remoteip=192.168.88.0/24
netsh advfirewall firewall add rule name="EstateMate LAN events (deny rest)" dir=in action=block protocol=TCP localport=8080
```

3. Terminal side. On most Hikvision firmware: **Configuration → Network →
Advanced Settings → HTTP Listening** (renamed **Alarm Server** on newer builds)
→ *Destination* = the agent host's LAN address, *Port* = `8080`, *URL* = `/`, and
enable notification for access events. The listener accepts `POST` on any path
and answers `405` to a probe. Exact menu wording varies by model and firmware —
confirm on the device, and record it in `docs/device-profiles/` the way the other
models are recorded.

4. Verify: `npm run inbound:check -- --config agent-config.json --devices isapi-devices.json --listen-scan`.

If the terminal also answers ISAPI, use the `alertStream` instead and switch the
listener off — that is the better path (Topology A).

## 5. Topology D — an off-site terminal must push in (this needs the forward)

A gate on another site, a terminal on a 4G router, a device at a second entrance
across the road. Two ways, and the first is better:

### D1 (preferred) — put an agent at that site, forward nothing

The repo runs agents on small hardware: a Raspberry Pi bridge (`pi_bridge`) for a
site with one or more Hikvision terminals, or a dedicated gate controller
(`esp32`, `pi_gate`) for exactly one terminal. Either one dials out, so the remote
site needs **no inbound rule and no public IP at all**, and the connection is
authenticated in one direction only.

### D2 — forward a port and let the terminal push in

Use this only if you cannot place a device at the remote site:

```text
Remote terminal ──▶ Internet ──▶ router rule (external 8443 → 192.168.88.5:8080)
                                        └─▶ agent listener: allowlist + secret + rate limit
```

1. **Pick a non-obvious external port** (e.g. `8443`, not `80`/`8080`/`443`) and
   forward it to the listener: `external 8443/tcp → 192.168.88.5:8080`.
2. **Pin the terminal's public egress address** in the allowlist:

```jsonc
{
  "lanEvents": {
    "enabled": true, "port": 8080, "bindAddress": "192.168.88.5",
    "allowedSources": ["192.168.88.0/24", "203.0.113.7/32"], // the REMOTE site's public IP
    "requireTerminalKey": true, "terminalKey": "<long random secret>",
    "maxRequestsPerMinute": 600, "trustReportedDeviceIp": false
  }
}
```

3. **Terminal side:** HTTP Listening → *Destination* = your public IP (or DDNS
   name), *Port* = `8443`, *URL* = `/`. ZKTeco: ADMS/"Cloud Server" → server
   address and port, same shape.
4. **Firewall:** allow `8443` only from that public address, drop it from
   everything else — the host firewall is the layer that still works when the
   router rewrites sources (see §“What source filtering cannot do” in
   `INBOUND-ACCESS-CONTROL.md`).
5. **Verify from outside.** A probe from inside the LAN can report "did not
   answer" even when the rule is live (hairpin NAT), so probe from a phone on
   mobile data:

```bash
npm run inbound:check -- --probe <your-public-ip>:8443   # from outside the estate
npm run inbound:check -- --config agent-config.json --devices isapi-devices.json --listen-scan   # on the host
```

### The four things that break D2

| Problem | Effect | Fix |
|---|---|---|
| **Dynamic public IP** (yours or the remote site's) | the allowlist entry or the terminal's destination goes stale | static IP from the ISP, or DDNS for *your* side; a DDNS **name cannot** be an `allowedSources` entry (the policy refuses hostnames — resolving a name at decision time hands the decision to DNS), so the remote side needs a static IP or a tunnel |
| **CGNAT** at the remote site (`100.64.0.0/10`) | you cannot forward in either direction | D1: put an agent there, or a site-to-site VPN |
| **A router that SNATs inbound traffic** | every Internet caller appears to come from the router itself, which is usually inside the allowlisted range | stack the layers: host firewall by interface/port, the shared secret (a scanner does not have it), the rate limit, and prefer D1 |
| **A silent terminal** | events stop and nothing complains | watch `stats.inbound` on the heartbeat: refusals are counted (`deniedSource`, `deniedSecret`, `throttled`) with source and path |

**Better than D2 when you control both routers:** a site-to-site WireGuard (or
Tailscale) link. The remote terminal's traffic then arrives from a stable private
address, encrypted, and no port is published to the Internet at all — put the
tunnel range in `allowedSources` and keep `trustReportedDeviceIp` off.

## 6. When the terminal is already published (the iVMS-4200 case)

The most common version of this problem is not a forward *you* chose: someone
installed a Hikvision terminal, pointed **iVMS-4200** at it over the WAN, and the
router holds a rule like `external 8000 → terminal:8000`. Two facts about that
setup decide everything:

- **Port 8000 is the Hikvision SDK / "server" port** — the one iVMS-4200, Hik-Connect
  and the batch tools use. It is **not** HTTP/ISAPI. The agent can speak it, but only
  through the opt-in SDK transport, which drives a helper holding **the site's own
  copy of Hikvision's `HCNetSDK`** — a real install step, not a config tweak
  ([`HIKVISION-SDK-TRANSPORT.md`](HIKVISION-SDK-TRANSPORT.md)); see "what EstateMate
  needs", below.
- **The terminal is therefore reachable from the Internet.** Port 8000 answers
  Hikvision's private protocol, so a browser shows nothing, but dedicated
  Hikvision scanners and credential tools speak exactly that protocol, and
  unpatched firmware has real history. Treat the device as public until proven
  otherwise.

### What EstateMate needs instead

The agent speaks **ISAPI over HTTP Digest** (`/ISAPI/System/deviceInfo`,
`/ISAPI/Event/notification/alertStream`) **from the device's own LAN**. It is not
the SDK protocol, the agent must not run anywhere but the device LAN, and a device
registered at a public address is an error in `npm run inbound:check`. So by default
the public IP and port are not an integration path — they are a finding to close.
There is one deliberate exception, for a site where the LAN genuinely cannot be
reached and the rule cannot be removed: an **acknowledged public endpoint**
([`PUBLIC-ENDPOINT-DEVICE.md`](PUBLIC-ENDPOINT-DEVICE.md)) — opt-in per device in
`isapi-devices.json`, refused by the agent until it is written down, and never
silent in the exposure report. It changes what the *report* says, never who else
can reach the terminal.

If the rule is on the terminal's **SDK port** — the iVMS-4200 case, where no HTTP
is published at all — the same acknowledgement applies to `sdkHost`, and the
agent reaches the terminal with the SDK transport instead of ISAPI. That is the
only way to get live events from a terminal whose LAN address nobody can find,
and [`PUBLIC-ENDPOINT-DEVICE.md` §4](PUBLIC-ENDPOINT-DEVICE.md) walks through
choosing it against the LAN-first alternative.

### Finding the terminal's LAN address without the router

Four ways, none of which needs router access:

1. **SADP** (Hikvision's free Windows search tool), run on any PC plugged into the
   same LAN. It lists every Hikvision device with **IPv4 address, port, gateway,
   MAC, firmware and activation state** — this is the canonical answer, and it also
   shows the device's HTTP port so you know what to put in `isapiPort`.
2. **iVMS-4200 itself**, if the device is already added: *Device Management* →
   select the device → **Remote Configuration** → *Network* → *Basic Settings* →
   *TCP/IP*. The IPv4 address, mask and gateway are shown even when the device was
   added by WAN address.
3. **The terminal's own screen** (MinMoe K1T3xx/K1T6xx): *Menu → System/Configuration
   → Network → TCP/IP* (or *Network → Basic Settings*). A guard or manager can read
   it out over the phone.
4. **From the device list's own entry:** a device added by LAN address shows it in
   iVMS-4200; one added by WAN address still exposes the local IP when you open its
   network settings.

Then prove ISAPI from a PC on that LAN (this is the repo's own acceptance test):

```bash
curl -i --digest -u admin:<password> http://<lan-ip>/ISAPI/System/deviceInfo
curl -N --digest -u admin:<password> "http://<lan-ip>/ISAPI/Event/notification/alertStream?format=json"   # Ctrl-C after the first event
```

Register the device in `isapi-devices.json` (or the portal) with the **LAN**
address — never `102.211.122.35` — and link it to an agent on that LAN:

```jsonc
{
  "estateMateDeviceId": "<id from the portal>",
  "name": "Main Gate MinMoe",
  "isapiHost": "192.168.88.11",   // the LAN address SADP/iVMS-4200 reported
  "isapiPort": 80,
  "isapiUsername": "admin",
  "isapiPassword": "<device admin password>",
  "protocol": "http",
  "enabled": true,
  "eventStream": true
}
```

If nobody can place an always-on agent on that LAN (a Pi bridge, or the office PC
running the Windows bridge), the device stays on the auditable **manual
synchronization** fallback: gate events are not live, and card/visitor changes
appear in Hardware actions as operator tasks. That is a supported state, not a
failure.

### Closing the exposure without the router

In the order that costs least and works regardless of what the router does:

1. **Change the terminal's admin password** to a long, unique one — it is on the
   Internet right now, and this is the only control that survives every other
   mistake. Hikvision enforces 8–16 characters using at least two character
   classes; use all four.
2. **Turn off the device-side features that invite or recreate a rule:** *Platform
   Access / HiDDNS*, *UPnP*, and the terminal's own NAT/port-mapping switches
   (Configuration → Network). A rule created by UPnP keeps coming back; one whose
   device-side enabler is off does not.
3. **Re-address the terminal (layer 1 in `INBOUND-ACCESS-CONTROL.md`).** Give the
   device a different static LAN address (SADP can set it, with the admin
   password). The existing `8000` rule now points at an address nothing owns — the
   exposure is gone, no router change was needed. Do this only when you no longer
   need iVMS-4200 from outside.
4. **Replace remote iVMS-4200 access with the tunnel kit.** Enrol the operator PC
   in WARP (`scripts/cloudflared-remote-access.mjs`) and point iVMS-4200 at the
   terminal's **LAN** address over the private network. Human access then needs no
   public port at all — which is the same boundary the agent lives inside.
5. **Confirm what is exposed, from outside.** Run this from a phone on mobile data,
   not from inside the estate (hairpin NAT lies):

```bash
npm run inbound:check -- --probe 102.211.122.35:8000 --probe 102.211.122.35:80
```

```bash
# Optional: what, exactly, is answering on 8000? If a login page renders, the rule
# is reaching the device's HTTP port instead of its SDK port — a worse finding.
curl -i --max-time 5 http://102.211.122.35:8000/

# The same question with a verdict, a device block when ISAPI answers, and the exact
# isapi-devices.json entry to paste (docs/PUBLIC-ENDPOINT-DEVICE.md):
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000 --json
```

6. **Assume the public address can change.** Many Nigerian broadband and mobile
   allocations are dynamic, so never let a workflow depend on the printed IP — let
   the agent reach out, and check the address only for the exposure itself.

## 7. Quick verification checklist

```bash
# 1. What does this host actually listen on, and is any of it reachable beyond the box?
npm run inbound:check -- --config agent-config.json --devices isapi-devices.json --listen-scan

# 2. Is the rule live? Run from OUTSIDE the estate.
npm run inbound:check -- --probe <public-ip>:<external-port>

# 3. Machine-readable, for a review or CI.
npm run inbound:check -- --json
```

Exit `0` means nothing here accepts an inbound connection it does not decide on;
`1` prints what to fix; `2` is a usage error.

## 8. The short version

- Terminals: **never** behind a forward, never on a public address, never through
  the tunnel.
- The app: behind TLS and a proxy at most; a tunnel or the free Worker deployment
  is better than a forward.
- The only listener worth forwarding is the agent's, and only because a push-only
  terminal is off-site. Prefer putting a small agent at that site (D1).
- If a terminal is already reachable through a rule you did not create (iVMS-4200
  over a WAN address on port 8000), find its **LAN** address with SADP, iVMS-4200's
  remote configuration or its own menu, link it to an agent on that LAN, and close
  the exposure by password, device-side remote-feature switches, and re-addressing
  the terminal (§6). Never register the public address as the device — unless the
  LAN genuinely cannot be reached, in which case register it *deliberately*, with an
  acknowledgement the agent and the checker both require
  ([`PUBLIC-ENDPOINT-DEVICE.md`](PUBLIC-ENDPOINT-DEVICE.md)), and write the exit plan
  into the device's `note`.
- Whatever you do, run `npm run inbound:check` from both sides and fix every
  error it prints, and remember the repo rule: **gate operation must never depend
  on the inbound rule** — the agent and the bridge keep working when the forward
  changes or disappears.

## Related

- [`PUBLIC-ENDPOINT-DEVICE.md`](PUBLIC-ENDPOINT-DEVICE.md) — integrating a terminal that is only reachable at a public `ip:port`, and the acknowledgement that opt-in requires
- [`INBOUND-ACCESS-CONTROL.md`](INBOUND-ACCESS-CONTROL.md) — the envelope, and the site whose router cannot be edited
- [`CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md) — private remote access for humans
- [`ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](ISAPI-BRIDGE-AND-WINDOWS-AGENT.md) — installing the agent
- [`FREE-HOSTING-OPTIONS.md`](FREE-HOSTING-OPTIONS.md) — where to put a self-hosted app
- [`../isapi-bridge/README.md`](../isapi-bridge/README.md) — the listeners, their transports and their ports
