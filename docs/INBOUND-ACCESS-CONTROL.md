# Inbound access control when the router is not yours to change

How to control what reaches an estate from the Internet when the router already
has **inbound Internet access** or a **port-forwarding** rule configured and
**you cannot alter it** — an ISP-managed CPE, a rule a previous installer left
behind, a router whose login belongs to a managing agent, a device in a cabinet
nobody will open.

The short version: you do not need the router. Access control moves to the two
places that are still yours — **the address the rule points at**, and **the
socket that answers**.

```text
Internet ──▶ router rule you cannot edit ──▶ [ layer 1: nothing at that address ]
                                          └─▶ [ layer 2: host firewall         ]
                                          └─▶ [ layer 3: the app decides       ]
                                              allowlist + secret + rate limit
                                              + socket identity, in the agent
```

Everything below is verified by one command, from the estate side:

```bash
npm run inbound:check -- --config isapi-bridge/agent-config.json \
                         --devices isapi-bridge/isapi-devices.json \
                         --listen-scan
```

Exit 0 means nothing here accepts an inbound connection it does not decide on.
Exit 1 prints what to fix. Exit 2 is a usage error. The same contract as
`scripts/cloudflared-remote-access.mjs --check`, so either can gate a review or a
CI step.

## The house rule first

`README.md` is explicit: *"Never port-forward a terminal's ISAPI/admin interface
to the public Internet, and never run the agent anywhere except the device LAN."*
EstateMate is built so that no inbound path is needed:

| Path | Direction | Needs an open port? |
|---|---|---|
| Agent → Worker (heartbeat, events, operations) | outbound HTTPS | no |
| Agent → terminal (ISAPI Digest, alertStream) | outbound HTTP on the LAN | no |
| Administrator → portal / Android app | outbound HTTPS | no |
| Administrator → estate LAN (support) | Cloudflare Tunnel + WARP | no — see `CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md` |
| Terminal → agent (ZKTeco PUSH) | **inbound to the agent host** | yes, if used |
| Terminal → agent (Hikvision HTTP Listening) | **inbound to the agent host** | yes, if used |

Only the last two rows accept a connection, and both are **off by default and
bound to loopback**. A default EstateMate install opens no port at all, which
means a router rule that cannot be deleted forwards traffic to nothing. That is
the recommended posture, and the check above says so out loud when it is true.

The rest of this page is for the sites that cannot have it: a ZKTeco terminal
that only pushes, a terminal whose firmware will not hold an alertStream, or a
rule pointing at something that must keep answering.

## Layer 1 — move the destination, not the rule

A port-forwarding rule is a mapping: *external port → internal address:port*.
If the rule cannot be edited, the internal address still can. This is the single
most effective change available without router access, because it does not
depend on any software behaving well:

- **Re-address the target.** Give the machine or terminal the rule points at a
  different LAN address (or move it to another VLAN/subnet) and the rule dangles:
  it forwards to an address nothing owns. On most routers the rule survives that
  change untouched, and the exposure is gone.
- **Refuse the address.** If the target must keep its address, remove it from the
  interface the rule lands on: bind the service to loopback (`127.0.0.1`) rather
  than `0.0.0.0`, and the forward has no socket to reach.
  `"bindAddress": "127.0.0.1"` is the default in `agent-config.example.json` for
  exactly this reason.
- **Put the terminals on their own VLAN.** The rule reaches one subnet. Access
  devices on a subnet it does not name are unreachable from it, and the agent
  host routes between them. This is the same boundary `README.md` asks for ("keep
  ISAPI private to the estate VLAN") and it also survives a future router.

If the rule points at a **terminal's own ISAPI or admin interface**, nothing on
the agent host can help — the terminal answers for itself. Re-address the
terminal (above), or disable the device-side features that invited the rule:
HiDDNS / "inbound Internet access", UPnP and the device's own port-mapping
switch, all on the terminal's network page. Then change its admin password and
check the rule no longer lands anywhere.

## Layer 2 — the host firewall

The agent host's own firewall is not the router's, and it is yours. It is the
place to allow the device VLAN and refuse everything else on the listener's port,
which covers a rule that masquerades traffic as well as one that does not.

Windows (the estate office PC, or the bridge installed as a service):

```powershell
# Allow the device VLAN only, on the private profile.
netsh advfirewall firewall add rule name="EstateMate LAN events" dir=in action=allow protocol=TCP localport=8080 profile=private remoteip=192.168.88.0/24
# Everything else to that port is refused by the block rule.
netsh advfirewall firewall add rule name="EstateMate LAN events (deny rest)" dir=in action=block protocol=TCP localport=8080
```

Linux (the Pi bridge, or any always-on small computer):

```bash
sudo nft add table inet estatemate
sudo nft add chain inet estatemate input '{ type filter hook input priority 0; policy accept; }'
sudo nft add rule  inet estatemate input tcp dport 8080 ip saddr 192.168.88.0/24 accept
sudo nft add rule  inet estatemate input tcp dport 8080 counter drop
```

macOS: `pfctl` with the same shape (`pass in proto tcp from 192.168.88.0/16 to any port 8080`,
then `block in proto tcp to any port 8080`).

Keep the rule **on the port the listener actually uses**, and check afterwards
with `npm run inbound:check -- --listen-scan`, which reads the host's own
listening sockets (`ss`/`netstat`) and reports a wildcard listener on a port the
configuration names.

## Layer 3 — the app decides who gets in

This is the part EstateMate implements, in
[`isapi-bridge/network-access-control.mjs`](../isapi-bridge/network-access-control.mjs),
used by both listeners. It needs no router access and no firewall access, and it
is what the checker verifies.

Four controls, applied in this order to every inbound request:

1. **Source-address allowlist.** Only addresses that match are served; everything
   else gets `403` before its body is read. Entries are address literals
   (`192.168.88.11`) or ranges (`192.168.88.0/24`, `fd00::/8`). A hostname is
   refused as an entry — resolving a name at decision time hands the policy to
   DNS — and a `/0` is refused because "allow everything" is a switch
   (`allowUnknownSources`), not a range, so choosing it is a logged act.
2. **The allowlist is derived, so it is on by default.** Every terminal in
   `isapi-devices.json` that has an address becomes a rule. An installer does not
   have to remember to write one, and an existing install gets deny-by-default
   the moment it upgrades. When a terminal is named by hostname the derivation is
   incomplete, and the agent keeps the list **advisory** and says which terminal
   it could not allow — refusing the estate's own gates because of a devices-file
   typo is a worse failure than an open LAN listener.
3. **Shared secret**, compared in constant time, layered on the allowlist rather
   than instead of it (`requireTerminalKey`/`terminalKey` for the LAN listener,
   `requireAgentKey`/`agentKey` for PUSH, where firmwares send `&Key=`).
4. **Per-source rate limit** — 600 requests/minute per source by default,
   `maxRequestsPerMinute` to change it — so a forwarded port cannot be used to
   bury the bridge, and with it the gates, in forged uploads.

And one rule that is not a setting:

5. **Identity is the socket, never the body.** An event document contains an
   `ipAddress` field written by whoever sent it. The agent maps an upload to a
   terminal by the address the connection arrived from, and a body that names a
   different terminal is logged and counted, not believed. This matters because
   with **Remote Network Verification** switched on, an accepted event is a door
   decision: a forwarded port plus a body that names a real terminal and a real
   card number is an unlocked gate. `"trustReportedDeviceIp": true` exists only
   for a site whose terminals genuinely push through a relay that rewrites source
   addresses, and the checker reports it as an error on any reachable listener.

### Configuration

`agent-config.json` — both listener blocks take the same keys:

```jsonc
{
  "lanEvents": {
    "enabled": true,
    "port": 8080,
    "bindAddress": "192.168.88.5",     // loopback unless a terminal must reach it
    "allowedSources": ["192.168.88.0/24"], // plus every terminal's own address
    "allowUnknownSources": false,      // true = the list is advisory only
    "maxRequestsPerMinute": 600,       // 0 switches the limit off (reported)
    "requireTerminalKey": true,
    "terminalKey": "a-long-random-secret",
    "trustReportedDeviceIp": false     // never true unless a relay rewrites sources
  },
  "zktecoPush": {
    "enabled": true,
    "port": 8089,
    "bindAddress": "192.168.88.5",
    // PUSH terminals dial in and have no address in the devices file, so nothing
    // can be derived for this listener: write the device VLAN explicitly.
    "allowedSources": ["192.168.88.0/24"],
    "requireAgentKey": true,
    "agentKey": "a-long-random-secret",
    "maxRequestsPerMinute": 600
  }
}
```

At startup the agent logs the policy it resolved, in one line per listener:

```text
LAN event listener: allowing 3 source rule(s): 192.168.88.0/24, 192.168.88.11/32, 192.168.88.12/32; shared secret required; rate limit 600/min per source
```

Refusals are logged with the source, counted (`deniedSource`, `deniedSecret`,
`throttled`), and the last few are carried on the heartbeat's `stats.inbound`
with the source and path — never a request body, because a body can carry a card
number. A denied connection is otherwise invisible: the caller's log says
"server unreachable" and the estate's log says nothing at all.

On Windows, `EstateMateBridge.exe check` prints the same policy in its report:

```text
  Inbound         LAN event listener on 0.0.0.0:8080 — reachable beyond this PC, NO source allowlist enforced
  WARN  LAN event listener listens on 0.0.0.0:8080, reachable beyond this PC, and enforces no source allowlist …
```

`setup` and the dashboard's "Save all settings" carry the listener blocks forward
untouched, the same way they preserve the clock-sync thresholds: re-running the
wizard must never reset an allowlist an administrator wrote.

## Verifying it, from both sides

```bash
# 1. The estate side: config, devices, host sockets.
npm run inbound:check -- --listen-scan

# 2. Is the rule actually live? Probe the address it points at.
npm run inbound:check -- --probe 203.0.113.9:8080 --probe 203.0.113.9:80

# 3. JSON, for a review or a CI step.
npm run inbound:check -- --json
```

What the checker reports:

| Finding | Severity | Why |
|---|---|---|
| A listener beyond loopback with no enforced allowlist | error | anything that can reach the port is accepted, including whatever the router forwards inward |
| …and Remote Network Verification is on | error | a forged upload naming a real card opens a gate |
| `trustReportedDeviceIp` on a reachable listener | error | the body, not the socket, decides which terminal spoke |
| A terminal configured at a public address | error | a device on the Internet; no host setting fixes that |
| Plain `http` to a non-private terminal address | error | Digest credentials and card numbers cross in the clear |
| A secret required but not configured | error | the listener refuses every terminal, including the estate's own |
| `allowUnknownSources` on a reachable listener | warning | the list is advisory, which is the same as none |
| A terminal named by hostname | warning | it cannot be allowlisted automatically |
| A terminal in 100.64.0.0/10 (CGNAT) | warning | other people share that source range |
| No shared secret, or the rate limit switched off | warning | the allowlist is carrying the whole load |
| `agent-config.json`/`isapi-devices.json` not 0600 | warning | they hold the agent secret and every admin password |
| Both listeners off | note | the recommended posture — a forward has nothing to reach |

### The one caveat that matters

`--probe` run **from inside the LAN** can report "did not answer" even when the
forward is live, because many routers do not loop hairpin NAT back to the inside.
The checker prints that caveat with every refusal rather than claiming the port
is closed. The authoritative probe is the same command from outside the estate —
a phone on mobile data with Termux, or any host on another network.

## What source filtering cannot do

A router that **masquerades (SNATs) inbound traffic** presents every Internet
caller as the router's own LAN address, which is usually inside the allowlisted
range. Source filtering then degrades to "anything the router forwards", which is
why the layers are stacked rather than interchangeable:

- the **host firewall** (layer 2) can restrict by *interface* and by port, not
  only by source;
- the **shared secret** still has to be presented, and a scanner will not have it;
- the **rate limit** keeps a forwarded port from being used as a flood;
- **layer 1** — nothing at the destination address — is the only layer that does
  not care what the router does to the packet on the way in.

If you can only do one thing, do layer 1. If you can only do one thing *in this
repository*, run `npm run inbound:check` and fix every error it prints.

## Human remote access is a different problem

Reaching the estate LAN to administer a terminal is solved by the tunnel kit, and
it needs no inbound rule either: `scripts/cloudflared-remote-access.mjs`
publishes the estate subnet to Zero Trust-enrolled humans over WARP, with no
public hostname, no DNS record and no listener. See
[`CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md). The
tunnel carries human access only — never events, card operations or door
commands — so gates keep working when it is down.

Do not solve inbound access by publishing a terminal's hostname through a tunnel
or a DDNS service. That is the exposure `README.md` forbids, it puts the
terminal's admin interface (and the credentials typed into it) on the public
Internet, and Cloudflare terminates TLS at the edge for a public hostname, so
that traffic is readable there.

## Related

- [`CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md) — private remote access for administrators
- [`REMOTE-NETWORK-VERIFICATION.md`](REMOTE-NETWORK-VERIFICATION.md) — why an accepted event can be a door decision
- [`ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](ISAPI-BRIDGE-AND-WINDOWS-AGENT.md) — installing the agent, and the firewall rule an operator needs
- [`../isapi-bridge/README.md`](../isapi-bridge/README.md) — the agent, its listeners and their transports
