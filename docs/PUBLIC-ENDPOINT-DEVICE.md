# Integrating a terminal that is only reachable at `<public-ip>:<port>`

The situation this document exists for, in the words it arrives in:

> "iVMS-4200 reaches the terminal at `102.211.122.35:8000`. That is all I have —
> no LAN address, and the router is not mine to change."

That is a real, supported EstateMate pattern — **a terminal the agent reaches over
an address that is not on your LAN** — but it is opt-in, it is recorded, and it is
not the same thing as "point the agent at the same string iVMS-4200 uses". Two
facts decide which path is even possible:

1. **What protocol answers at that port.** Hikvision terminals speak ISAPI (HTTP/HTTPS on 80/443)
   and a proprietary SDK/"server" protocol (**8000** by default). iVMS-4200 and Hik-Connect
   use the SDK port. EstateMate's agent speaks ISAPI only. So the same address that
   makes iVMS-4200 work very often makes the bridge *not* work.
2. **Whether ISAPI is exposed to the Internet at all.** If it is, and you cannot
   close it, integrating is possible — but only as an acknowledged exposure, never
   as a silent relaxation of the rules in [`README.md`](../README.md) and
   [`PUBLIC-IP-AND-PORT-FORWARDING.md`](PUBLIC-IP-AND-PORT-FORWARDING.md).

Related reading: [`PUBLIC-IP-AND-PORT-FORWARDING.md`](PUBLIC-IP-AND-PORT-FORWARDING.md)
§6 (the already-published terminal, incl. finding the LAN address with SADP),
[`INBOUND-ACCESS-CONTROL.md`](INBOUND-ACCESS-CONTROL.md) (the agent's own listener),
[`ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](ISAPI-BRIDGE-AND-WINDOWS-AGENT.md) (the protocol the card path relies on).

---

## 1. Step one: find out what actually answers

Do not configure anything yet. Ask the endpoint what it is:

```bash
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000
# with credentials, when the endpoint asks for them:
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000 --username admin --password '<device admin password>'
# and for a TLS endpoint (prints the certificate fingerprint too):
npm run terminal:endpoint -- --endpoint 102.211.122.35:8443 --tls
```

The script is `scripts/terminal-endpoint.mjs`. It opens a TCP connection, then asks
for `/ISAPI/System/deviceInfo?format=json` — first anonymously, then answering one
HTTP **Digest** challenge exactly as the bridge does. Nothing it sends is a
credential unless you pass `--username`/`--password`, and a Digest response is
calculated per request, never stored or logged.

One result per run, and each one leads somewhere different:

| Verdict | What answered | What to do |
|---|---|---|
| `isapi` | ISAPI, and your credentials worked | Integrate over this endpoint — §3. Re-run without credentials first if you have none; the device block (model, serial, firmware) is only printed on an authenticated answer. |
| `isapi_auth_needed` | ISAPI, and it wants credentials | Re-run with `--username`/`--password`. If the password is unknown, reset it at the terminal (physical access, or SADP on the LAN) — never by guessing, firmware may lock the account. |
| `isapi_auth_failed` | ISAPI is there, the credentials are wrong | Confirm the account. ISAPI needs the device admin or a user with remote-access rights. |
| `web_ui` | The terminal's *web* login page | This is the browser interface, not the API. If it does not also answer `/ISAPI/System/deviceInfo` (the probe already asked), the API is elsewhere — or disabled on this rule. |
| `sdk_port` | TCP accepted, nothing resembling HTTP came back | **The iVMS-4200 signature**: this is the SDK/"server" port, a binary protocol — not ISAPI. EstateMate reaches it with the SDK transport — §4. |
| `http_other` | Some other HTTP server | The address may point at a DVR/NVR, or something else shares the rule. Confirm with whoever configured iVMS-4200. |
| `closed` | Nothing accepted the connection — *from here* | If you ran it inside the estate's LAN, the router may not hairpin NAT. Re-run it from outside (a phone on mobile data) before concluding the port is closed. |

Exit codes follow the other checkers: `0` integrable, `1` findings or not
integrable, `2` usage error. `--json` gives the whole report for a script.

> **A `closed` result from a LAN-side probe proves nothing.** Router NAT often
> refuses a LAN host that dials the WAN address. The only trustworthy probe is
> from outside the network — the same rule as `npm run inbound:check -- --probe`.

---

## 2. What "integrating a public endpoint" costs you

An address on the Internet does not become safe because EstateMate talks to it.
What is actually true of `http://102.211.122.35:8000`:

- **The terminal answers for itself.** No allowlist, shared secret or rate limit
  anywhere in this repository limits who reaches it. Those controls live on the
  *agent's* listener, and the agent has no listener for terminals — it is an
  outbound client.
- **The admin interface is on the same address.** Whatever iVMS-4200 reaches, a
  scanner reaches too. A firmware default password or a reused one is a gate
  opening.
- **Over plain `http`, every ISAPI Digest response and every card number crosses a
  network nobody in this deployment controls.** Digest protects the password from
  being replayed in the clear; it does not protect the card list, the person
  records, or the events that flow afterwards.
- **Your uptime now depends on somebody else's router rule.** If that rule is
  changed, the terminal goes offline and gate history stops being live. The
  portal will show it (`devices[].stream = down`, device offline) but nothing
  here can restore a rule you do not control.
- **A public address may move.** Unless the ISP guarantees it, assume DHCP: the
  address can change and the bridge will keep dialling the old one.

None of that is a reason to pretend the exposure is not there. It is a reason for
the decision to be **written down, visible in the report, and revisited**.

---

## 3. Path B — integrate over an exposed ISAPI endpoint (opt-in)

Use this when the probe says `isapi` and there is genuinely no LAN path. Every
step is here; skipping step 3 fails closed with an explanation rather than
starting.

### 3.1 Prove the interface end to end, then read the entry out of the probe

```bash
npm run terminal:endpoint -- \
  --endpoint 102.211.122.35:8443 \
  --username admin --password '<device admin password>' \
  --tls \
  --name "Main Gate (public endpoint)" \
  --device-id <the terminal's device id from the portal> \
  --acknowledge --acknowledged-by "your name" --reason "contractor rule on the ISP router; no LAN path"
```

The report prints the exact `isapi-devices.json` entry to paste. On a public
address it also prints the residual risks and, without `--acknowledge`, tells you
the agent will refuse the entry.

### 3.2 The entry, and the one field that matters

```json
{
  "estateMateDeviceId": "44444444-4444-4444-8444-444444444444",
  "name": "Main Gate (public endpoint)",
  "isapiHost": "102.211.122.35",
  "isapiPort": 8443,
  "isapiUsername": "admin",
  "isapiPassword": "<device admin password>",
  "protocol": "https",
  "enabled": true,
  "eventStream": true,
  "publicEndpoint": {
    "acknowledged": true,
    "acknowledgedBy": "your name",
    "acknowledgedAt": "2026-10-11T09:00:00Z",
    "note": "contractor rule on the ISP router; no LAN path to the terminal"
  }
}
```

- `publicEndpoint.acknowledged` must be exactly `true`. `"yes"`, `1` and a block
  without the key are all *not* an acknowledgement.
- `acknowledgedBy`, `acknowledgedAt` and `note` are free text and are copied into
  the agent's log line, the exposure report and the heartbeat — write them for the
  person who reviews this in six months.
- The block is only meaningful on a device whose `isapiHost` is a **public address
  literal**. A hostname is never judged (DNS decides later, and a name that
  resolves privately today can resolve publicly tomorrow), and a private address
  needs no acknowledgement.
- Per-device, never per-file: one acknowledged endpoint does not bless a second.

### 3.3 What each component does with it

| Component | Without the block | With the block |
|---|---|---|
| `agent.mjs` | **Refuses to start** (`exit 1`) and prints the LAN-first remedy, the probe command, and the exact block to add. Nothing dials the terminal. | Starts. Logs one `warn` per public endpoint at every start with the address, who accepted it, and the residual risks. Reports it on the heartbeat (`publicEndpoints`, and `publicEndpoint: true` on that device's entry) so the portal and support can see the posture. |
| `npm run inbound:check` | **Error**: a terminal on the Internet is the exposure `README.md` forbids. | **Warning**, naming who acknowledged it and the same risk list. The report carries `devices[].publicEndpoint`. Never silent. |
| `scripts/terminal-endpoint.mjs` | Tells you the agent will refuse it, and refuses to `--emit` one. | Prints the entry with the block filled in (and `--emit` writes it). |

Nothing else changes: the agent still makes no inbound connections, and no
listener, allowlist or firewall rule is touched by any of this.

### 3.4 Verify, from outside

```bash
npm run inbound:check -- \
  --config <agent-config.json> --devices <isapi-devices.json>
```

Expect: **no error** for that device, one warning naming the acknowledgement, and
exit code 0. From a phone on mobile data (not the estate Wi-Fi), confirm what the
public address really exposes:

```bash
npm run inbound:check -- --probe 102.211.122.35:8000 --probe 102.211.122.35:8443
```

If a browser opens a login page on the ISAPI port too, the terminal's web
interface is public as well — that is the finding to act on next, not the bridge.

### 3.5 Harden the terminal, whether or not you integrate

- Unique admin password, on the device, not one shared across estates.
- Switch **off** Platform Access / HiDDNS / Hik-Connect, UPnP and device-side NAT —
  these are additional inbound paths that do not go through the rule you know about.
- Prefer `https` for this device (`"protocol": "https"`). The probe prints the
  certificate's SHA-256 fingerprint and whether it is self-signed; the agent does
  **not** pin it, so the host must trust the terminal's certificate — Node: point
  `NODE_EXTRA_CA_CERTS` at the terminal's PEM; the packaged Windows bridge reads
  the Windows trust store. If neither is possible, do not fall back to `http` over
  the Internet: an acknowledged `http` endpoint is reported as a warning for a
  reason.
- If the rule can be closed at all, close it — §5.

---

## 4. When the probe says `sdk_port` — the port iVMS-4200 actually speaks

`102.211.122.35:8000` reaching the terminal in iVMS-4200 is the **SDK/"server"
port** (Hikvision's table: HTTP 80 for the browser, RTSP 554, server/SDK **8000**
for iVMS-4200 and Hik-Connect). The probe reports `sdk_port` when TCP accepts and
no HTTP ever comes back, because that port waits for a binary handshake and a
vendor library — not for `GET /ISAPI/...`.

Since round 7 the bridge can speak it, through the agent's **SDK transport**
([`HIKVISION-SDK-TRANSPORT.md`](HIKVISION-SDK-TRANSPORT.md)): a helper process
next to the agent loads **the site's own copy of Hikvision's `HCNetSDK`** — the
same library iVMS-4200 loads — and the agent gets live events, door control and
the terminal clock from it. Card and person writes stay operator tasks: HCNetSDK
has no card-record API.

Three options, and the order still matters:

**A. Find the LAN address and put an agent on that LAN — the supported posture.**
The LAN address is not lost just because iVMS-4200 was added by WAN address:
SADP (free, on the terminal's LAN) lists IPv4/port/gateway; iVMS-4200 →
*Device Management → Remote Configuration → Network → Basic Settings → TCP/IP*
shows the device's own IPv4 even when it was added by WAN address; the terminal's
own Network menu shows it too. Then run an agent on that LAN, register the LAN
address in `isapi-devices.json`, and keep the WAN address for iVMS-4200 only.
No vendor SDK, no helper install, no exposure.
[`PUBLIC-IP-AND-PORT-FORWARDING.md` §6](PUBLIC-IP-AND-PORT-FORWARDING.md) walks
this through for the already-published terminal.

**B. Integrate over the SDK port — the transport that exists for this case.** Use
it when the rule is the only path that will ever exist, exactly as for ISAPI —
build the helper, prove it with `--selftest`, enable `"hikSdk"`, and record the
acknowledgement (the same block as §3, on the same device entry):

```jsonc
{
  "estateMateDeviceId": "<from the portal>",
  "name": "Main Gate (SDK)",
  "transport": "hik_sdk",
  "sdkHost": "102.211.122.35",
  "sdkPort": 8000,
  "sdkUsername": "admin",
  "sdkPassword": "<device admin password>",
  "enabled": true,
  "publicEndpoint": { "acknowledged": true, "acknowledgedBy": "…", "acknowledgedAt": "…", "note": "…" }
}
```

```bash
npm run terminal:endpoint -- --endpoint 102.211.122.35:8000 \
  --name "Main Gate (SDK)" --device-id <portal device id> \
  --acknowledge --acknowledged-by "your name" --reason "contractor rule; no LAN path"

# build it beside the agent, then prove login + events before configuring anything
bridge-apps\windows\hcnetsdk\build-hcnetsdk-helper.cmd
build\EstateMateHikSdk.exe --selftest 102.211.122.35:8000 admin '<device admin password>'
```

Two things to know before choosing B:

- **The acknowledgement is the same rule, not a lighter one.** Without the block
  the agent refuses to start, `inbound:check` reports an error, and
  `terminal:endpoint --emit` refuses to write the entry. With it, the address is
  logged at every start, reported on the heartbeat (`publicEndpoints`, plus
  `publicEndpoint: true` on that device) and surfaced as a named warning by
  `inbound:check` — with the SDK-specific risk spelled out: the vendor library
  protects the password with its own challenge/response, but **card numbers and
  events travel in Hikvision's binary framing over a network nobody here
  controls**, and the SDK protocol is not TLS.
- **Read [`HIKVISION-SDK-TRANSPORT.md`](HIKVISION-SDK-TRANSPORT.md) §2 before
  promising anything.** What this transport can do depends on what the site's
  vendor build exports (the helper asks the library, and the capability is
  reported honestly: no alarm callback means no live events, and it says so).
  Card writes, person records and fingerprints are **never** available over it.

**C. Stay on manual synchronization until A or B exists.** The terminal remains a
device in the portal with connection pattern `manual_sync`: card and visitor
changes appear in **Hardware actions** as operator tasks, gate history is imported
by file/import rather than live, and nothing depends on the public rule. Losing
live events is a smaller cost than a gate that stops working when somebody else's
router rule changes, and it is the honest interim while the helper is being built
or the LAN address found. See
[`MINMOE-NO-PC.md`](MINMOE-NO-PC.md) and
[`VISITOR-CREDENTIALS-AND-ACCESS-DEVICES.md`](VISITOR-CREDENTIALS-AND-ACCESS-DEVICES.md).

What has **not** changed: this is not a second service. The helper is spawned by
the agent, dials the terminal, opens no port, and holds no credentials of its own —
the retired ISUP gateway was a separate control plane and stays retired
([`HIKVISION-SDK-TRANSPORT.md` §8](HIKVISION-SDK-TRANSPORT.md)).

---

## 5. The exit plan (write it down now, not during an incident)

The acknowledgement buys integration **today**. The standing rule is unchanged: a
terminal's own admin surface does not belong on the Internet. Aim at one of:

1. **An agent on the terminal's LAN** (a Pi/ESP32-class host at the site) —
   preferred; [`FREE-HOSTING-OPTIONS.md`](FREE-HOSTING-OPTIONS.md) §4 covers the
   hardware.
2. **A tunnel to the site**, so the terminal is reachable without a public rule —
   [`CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md`](CLOUDFLARE-TUNNEL-REMOTE-ACCESS.md).
3. **The rule closed** (change the outside port, disable the forward, or re-address
   the terminal with SADP so the rule points nowhere) — then remote iVMS-4200 gets
   the tunnel kit instead of a raw port.

Review the entry whenever the agent config is reviewed. If the note is no longer
true — the LAN became reachable, the rule was removed — delete `publicEndpoint`,
move `isapiHost` to the LAN address, and let `inbound:check` go quiet again.

---

## 6. Quick reference

```bash
# What actually answers at the address iVMS-4200 uses?
npm run terminal:endpoint -- --endpoint <public-ip>:<port> [--username admin --password '<pw>'] [--tls] [--json]
# Emit the entry, with the acknowledgement when the endpoint is public:
npm run terminal:endpoint -- --endpoint <public-ip>:<port> --acknowledge --acknowledged-by "<name>" --reason "<why>" --emit isapi-devices.json

# Emit the entry to paste, with the acknowledgement on a public address:
npm run terminal:endpoint -- --endpoint <public-ip>:<port> --tls --name "<label>" \
  --device-id <uuid> --acknowledge --acknowledged-by "<name>" --reason "<why>"

# Posture check: a public endpoint without the block is an error; with it, a named warning.
npm run inbound:check -- --config <agent-config.json> --devices <isapi-devices.json>

# From outside the network (mobile data), what the world can reach:
npm run inbound:check -- --probe <public-ip>:<port>
```

| Question | Answer |
|---|---|
| Can the agent use `102.211.122.35:8000` the way iVMS-4200 does? | Yes, when the probe says `sdk_port`: that is the SDK transport (§4) — the helper links the site's own `HCNetSDK`, exactly what iVMS-4200 does. Events, door control and the clock work; card/person writes do not exist in that API. |
| Does adding `publicEndpoint` make the terminal safe? | No. It records who accepted the exposure and keeps it visible in the agent log, the heartbeat and `inbound:check`. |
| Will the agent start anyway with a public address? | No — it exits with instructions. Nothing is dialled until the block is there. |
| Is `http` allowed with the block? | It starts, but the checker warns: the acknowledgement covers the address, not the cleartext. Prefer `https` on a public endpoint. |
| Can I point `isapiHost` at a hostname (e.g. DynDNS)? | The agent will not judge a hostname — the checker warns instead of erroring. Prefer the literal address so the posture is auditable; a name that resolves privately today can resolve publicly tomorrow. |
| Does this change anything about my inbound rules? | No. The agent still opens no port for terminals; your rules and `inbound:check` behave exactly as before. |

## 7. Sources

- Hikvision port roles and the SDK/server port 8000 (iVMS-4200, Hik-Connect), plus LAN-address discovery via SADP, iVMS-4200 Remote Configuration, and the terminal's own menu — captured in [`PUBLIC-IP-AND-PORT-FORWARDING.md`](PUBLIC-IP-AND-PORT-FORWARDING.md) §6.
- ISAPI Digest authentication and `/ISAPI/System/deviceInfo` behaviour the probe depends on — the same interface the bridge uses; see [`isapi-bridge/README.md`](../isapi-bridge/README.md) and [`ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](ISAPI-BRIDGE-AND-WINDOWS-AGENT.md).
- Table-testing note: every `203.0.113.x` and `198.51.100.x` address in the examples and tests is TEST-NET (RFC 5737) and never routable.
