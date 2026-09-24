# DS-K1T808MFWX-B — Pro Fingerprint Terminal profile evidence

Status: **datasheet-supported, on-site firmware verification still required before production.**

## Verified from the official datasheet (2024-04-24 revision)

Source: Hikvision DS-K1T808MFWX-B datasheet (`assets.hikvision.com`, April 2024) and product page.

| Capability | Datasheet evidence |
|---|---|
| Protocol support | "Supports ISAPI and ISUP 5.0 protocols" |
| Authentication | Card (M1), fingerprint (optical, 1:1 and 1:N), PIN |
| Capacity | 3,000 cards, 3,000 fingerprints, 100,000 local events |
| Network | 1 × RJ-45 10/100, Wi-Fi (AP mode) |
| Door wiring | Lock control, exit button, door contact, TAMPER, RS-485, Wiegand W26/W34 |
| Configuration | PC web client and mobile web client |
| Power | 12 VDC, ≤ 6 W (battery-in-bracket supported) |

Datasheet caveats: no integrated QR camera (card/fingerprint/PIN only), and **HTTP Listening
push is not named in the datasheet**. ISAPI support is documented, which is what the
`isapi_bridge` / `windows_agent` / `isapi_windows_agent` connection patterns use.

## Recommended EstateMate configuration

**Primary pattern: `isapi_bridge` (or `windows_agent` on a Windows LAN host).**

```
DS-K1T808MFWX-B ── alertStream (persistent ISAPI HTTP) ──▶ ISAPI bridge agent ── outbound HTTPS ──▶ Cloudflare Worker
                   ◀── card add/enable/disable (ISAPI Digest, agent polls Worker ops) ──
```

- **Events (real-time):** agent holds `GET /ISAPI/Event/notification/alertStream?format=json`,
  batches documents to `POST /api/isapi/v1/agents/:id/events`. Seconds-level Gate activity.
- **Commands (seconds–minutes):** agent polls `GET /api/isapi/v1/agents/:id/operations`, applies
  card upsert/enable/disable via `/ISAPI/AccessControl/CardInfo/*` with Digest auth, reports
  results. Facility-fee expiry auto-disable works automatically.
- **Fallback event path:** if the agent host is down, configure the terminal's HTTP Listening
  (Network → Advanced → HTTP Listening) to the Worker per-device endpoint — firmware permitting.
- **Removed alternative:** the dedicated ISUP gateway transport (which could have used the
  datasheet-documented ISUP 5.0 from an off-site host) was retired with migration
  `0013_agent_only_transports.sql`; the agent is the supported path.

## On-site verification checklist (before production)

1. Record exact model, full firmware/build, hardware version, serial, region.
2. Screenshot **Network → Platform Access** and **Network → Advanced → HTTP Listening**.
3. `curl --digest -u admin:password http://<device-ip>/ISAPI/System/deviceInfo` — confirm ISAPI reachable.
4. `curl --digest -u admin:password -H "Accept: multipart/mixed" http://<device-ip>/ISAPI/Event/notification/alertStream?format=json` — confirm the stream connects and observe the payload format (multipart vs bare JSON).
5. Register the device in EstateMate with `isapi_bridge`, link to the agent, tap a valid card, invalid card, wrong PIN and a disabled card; compare Gate activity (result granted/denied) with the terminal's local event log.
6. Issue a card from the portal; confirm it reaches the terminal within the polling interval; then expire a facility fee and confirm automatic `disable_card`.
7. Check time zone/NTP so `dateTime` in events matches estate time.
8. Record results in this file before marking the model production-supported.
