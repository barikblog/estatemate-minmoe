# Access-device transport decision — agent-only

## The one transport: the EstateMate agent

Every access device reaches EstateMate through the **EstateMate agent** (`isapi-bridge/agent.mjs`, wrapped as a Windows Service by `windows-agent/`) running on an always-on computer on the device LAN — the estate office Windows PC, a spare Android phone on estate Wi-Fi (Termux + Node 22), or a small single-board computer. The agent provides both directions over ordinary outbound HTTPS to the Cloudflare Worker:

- **Events (real-time):** one persistent `GET /ISAPI/Event/notification/alertStream?format=json` connection per terminal. Events arrive as `multipart/mixed` JSON/XML documents (bare-JSON fallback parser included), are buffered locally, and are flushed in batches (≤50 items or every 5 s) to `POST /api/isapi/v1/agents/:id/events`. Gate activity latency is seconds.
- **Commands (automatic):** the agent polls `GET /api/isapi/v1/agents/:id/operations`, applies card upsert/enable/disable and visitor credentials over ISAPI (HTTP Digest) on the LAN, and reports applied/failed per operation. Facility-fee expiry auto-disable and visitor credential push work with no operator.

Why one transport:

- **One security boundary.** Only the agent touches a terminal's ISAPI interface, and only on the VLAN. Nothing about a terminal is exposed to the Internet, and the agent needs no inbound firewall rule.
- **One thing to monitor.** The agent heartbeats (`isapi_agents.status`, `last_seen_at`); if the LAN host dies, the portal shows the agent offline and devices stop updating — visible within minutes via the heartbeat.
- **Free-tier headroom.** Agent batches collapse into one Queue message (~3 Queue operations) per flush, and the hourly cron prunes old events, so a busy estate stays far inside the Workers Free plan.

Connection patterns in the registry:

| Pattern | Meaning |
|---|---|
| `isapi_bridge` | Cross-platform agent (Linux/Windows/macOS) — recommended default |
| `windows_agent` / `isapi_windows_agent` | The same agent on the estate office Windows PC |
| `manual_sync` | Auditable fallback: events flow only through a linked agent; hardware changes are operator-applied from the Hardware actions queue |

`generic_network_access` (validated non-Hikvision devices) supports `manual_sync` only because its ISAPI dialect is unverified.

## Retired transports (migration `0013_agent_only_transports.sql`)

The following were removed from the product — endpoints, packages, portal options and settings no longer exist. Historical access events and audit rows are preserved; devices that were configured on a retired transport were migrated to `manual_sync` and become automatic again once linked to an agent.

- **Direct HTTP Listening (device → Worker push):** removed. It was event-upload only — no command return channel — and required each terminal to hold outbound HTTPS plus DNS/HTTPS support that varied by firmware. The agent's alertStream streaming replaces it with equal real-time behavior plus commands.
- **Render free HTTPS relay (`bridge/`, `render.yaml`):** removed. It was a stateless forwarding shim for HTTP Listening devices, subject to free-tier sleep/cold starts; with HTTP Listening gone it had no purpose.
- **Hikvision cloud/OpenAPI:** removed. It was never implemented (pending approved API documentation/licensing) and was a second cloud dependency.
- **Dedicated ISUP gateway (`isup-gateway/`, SDK adapter):** removed. It required compiling Hikvision's licensed proprietary SDK for the exact architecture/firmware on a dedicated Ubuntu host — a second, fragile control plane. The agent covers the same bidirectional need over documented ISAPI for terminals that expose it (e.g. DS-K1T808MFWX-B datasheet: "Supports ISAPI and ISUP 5.0"). Record any future cloud/ISUP evidence in `docs/device-profiles/` before proposing a new transport.

Do not recreate these endpoints or packages. If a future requirement genuinely cannot be met by the agent, document the evidence first and add a new migration-backed pattern — do not silently widen the attack surface.

## Required model-validation test

For each terminal model/firmware:

1. Record model, full firmware/build, hardware version, serial (redacted in shared tickets), and region.
2. Confirm ISAPI reachability: `curl --digest -u admin:password http://<device-ip>/ISAPI/System/deviceInfo`.
3. Confirm the alert stream: `curl --digest -u admin:password -H "Accept: multipart/mixed" "http://<device-ip>/ISAPI/Event/notification/alertStream?format=json"` and note the payload shape (multipart vs bare JSON).
4. Create the device record in EstateMate (`isapi_bridge`), link it to the agent, and confirm the stream connects in the agent log.
5. Present a valid card, invalid card, PIN, and a disabled/expired credential; compare Gate activity grant/deny results with the terminal's local event log.
6. Issue a card from the portal; confirm it reaches the terminal within the polling interval. Expire a facility fee and confirm automatic `disable_card`.
7. Verify time zone/NTP so event timestamps match estate time.
8. Document results under `docs/device-profiles/` before production.

## Information still needed

Complete `DEPLOYMENT-QUESTIONNAIRE.md`. The most important missing values are exact model/firmware and GitHub/Cloudflare destination identifiers.
