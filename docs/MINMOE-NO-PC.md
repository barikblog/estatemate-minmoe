# Hikvision MinMoe no-PC integration decision

## What direct HTTP Listening solves

On supported MinMoe firmware, **HTTP Listening** (also called HTTP Host, Alarm Server, or event alarm upload) lets the terminal initiate an outbound HTTP/HTTPS request whenever an event occurs. This works through ordinary estate NAT and does not require inbound router ports or a computer on the terminal LAN.

EstateMate accepts:

- direct JSON event bodies;
- direct XML `EventNotificationAlert` bodies;
- `multipart/mixed` events containing JSON/XML metadata plus an image part;
- access card number, person name, device time, event type, direction, and granted/denied inference where those values exist.

The Worker acknowledges accepted messages and puts normalized events on a Queue. The consumer stores them in D1 and publishes them to live Admin/Security WebSockets.

## What it does not solve

HTTP Listening is normally one-way. Cloudflare receives event uploads, but cannot call a MinMoe terminal behind NAT. A terminal connected to the Internet does not automatically become remotely addressable.

Consequences in `http-listener-events-only` mode:

- Facility-fee rules change the authoritative cloud card status.
- EstateMate creates one hardware operation per terminal.
- The portal clearly labels the operation `manual_action_required`.
- An authorized operator applies the card enable/disable in the terminal UI, iVMS-4200 during a maintenance visit, or another approved management channel and marks the operation applied.
- Until that action reaches the terminal, its local authorization list can still grant access. Do not represent cloud status as physical enforcement until sync is confirmed.

## Ways to obtain automatic bidirectional control without an on-site PC

Choose only after the exact model and firmware are known.

### 1. Approved Hikvision cloud/OpenAPI proxy

Some commercial Hikvision platforms can proxy device management through an outbound device connection. This is the preferred no-site-PC option when the account/product exposes documented person/card APIs. It requires platform credentials, product licensing/region availability, and model verification.

### 2. Off-site ISUP 5.0 gateway

Many MinMoe models can register outward to an ISUP server. The gateway runs on an Internet VM/container, not at the estate. It can provide a return command channel, but ISUP uses proprietary TCP/UDP services and often Hikvision SDK/licensing. The EstateMate app can remain on Cloudflare while the gateway exposes a narrow mutually-authenticated HTTPS API to it.

This is not the same as deploying everything to standard Cloudflare Workers. Do not claim support until an end-to-end card add/disable test passes on the actual firmware.

### 3. Public ISAPI/port forwarding — rejected

Do not expose the terminal’s web/ISAPI/server ports to the Internet. Risks include credential attacks, outdated terminal firmware, biometric/person database exposure, and a direct path to door controls.

### 4. Manual audited actions

This repository’s safe default. It has no extra infrastructure and keeps events live, but physical card changes are not immediate.

## Required model-validation test

For each terminal model/firmware:

1. Record model, full firmware/build, hardware version, serial (redacted in shared tickets), and region.
2. Screenshot **Network → Platform Access** and **HTTP Listening** settings.
3. Confirm HTTPS listener support, DNS hostname support, URL length, authentication options, payload format, and certificate validation.
4. Create a dedicated test device record in EstateMate.
5. Use the terminal’s Test function and capture the Worker log.
6. Present a valid card, invalid card, face, PIN, and denied/expired credential.
7. Compare event minor/sub-event codes with the terminal UI event log.
8. Verify time zone and NTP.
9. Disconnect Internet, trigger events, reconnect, and determine whether firmware retries buffered events.
10. Test duplicate delivery and verify D1 idempotency.
11. Confirm whether ISUP or a Hikvision cloud platform can perform person/card operations remotely.
12. Document results under `docs/device-profiles/MODEL-FIRMWARE.md` before production.

## Information still needed

Complete `DEPLOYMENT-QUESTIONNAIRE.md`. The most important missing values are exact model/firmware and GitHub/Cloudflare destination identifiers.
