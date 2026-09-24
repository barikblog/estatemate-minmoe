# EstateMate Build Prompt v3 — Direct MinMoe Internet Mode

This document amends `EstateMate_Build_Prompt_v2` for estates where supported Hikvision MinMoe terminals have Internet access but no PC/server is installed on site.

## Superseding architecture decision

Remove the mandatory on-site Edge Sync Agent from the default architecture. Use two explicitly different channels:

1. **Event channel (implemented):** MinMoe HTTP Listening sends outbound HTTPS event uploads directly to a Cloudflare Worker endpoint. The Worker authenticates the terminal, parses JSON/XML/multipart event notifications, normalizes the metadata, enqueues it, stores it in D1, and broadcasts it through a Durable Object.
2. **Command channel (must be verified per model/firmware):** HTTP Listening cannot be assumed to receive person/card commands. Default to an auditable `manual_action_required` queue. Automatic physical card enforcement may be enabled only through a tested Hikvision cloud/OpenAPI proxy or a dedicated ISUP 5.0 gateway on a small headless Linux appliance (or off-site host). Arduino/ESP32 is not an official-SDK host; use ARM only when Hikvision supplies matching ARM64 libraries. Never expose a terminal’s ISAPI/admin ports publicly.

The app must never display “synced to hardware” merely because D1 card status changed. Store cloud state and per-device operation state separately.

## Updated architecture

```text
Android / React ── HTTPS ──▶ Cloudflare Worker ──▶ D1 / R2
                                    │
MinMoe ── outbound HTTPS POST ──────┤
                                    ├──▶ Queue consumer ──▶ D1
                                    └──▶ Durable Object ──▶ live clients

D1 card status change ──▶ device_operations
  ├── events-only mode: manual_action_required
  ├── approved cloud API mode: sent → applied/failed
  └── dedicated ISUP mode: HTTPS command request → LAN appliance/off-site gateway → terminal
```

## New/changed data requirements

- `hikvision_devices`: model, firmware, serial, gate, direction, integration mode, status, last seen.
- `device_credentials`: one-way hash of a per-terminal listener secret, revocation, last seen.
- `device_operations`: one row per device/card action with `pending`, `manual_action_required`, `sent`, `applied`, or `failed`.
- `access_events`: unique `(device_id, vendor_event_id)` to tolerate terminal retries.
- `access_cards`: cloud status remains authoritative for EstateMate but is not physical proof of enforcement.

## Direct listener endpoint

`POST /api/hikvision/v1/events/:deviceId`

Requirements:

- HTTPS only in production.
- Prefer Basic listener authentication if tested on the firmware; permit a one-time per-device URL token only as a documented compatibility fallback.
- Maximum body 2 MB.
- Accept JSON, XML, and multipart event notifications.
- Discard biometric/image binary parts by default; retain only normalized event metadata.
- Acknowledge promptly with HTTP 200 after Queue acceptance to prevent retries.
- No user session is accepted as device authentication.
- Rate-limit and monitor per device.

## Facility-fee rule update

The hourly job still expires/reactivates cloud card state and creates one device operation for each enabled terminal. In `events-only` mode those operations remain `manual_action_required`. Admin/Security must see a warning that the physical terminal may still grant access until the operation is applied.

Automatic enforcement can be marked complete only after a device-specific acknowledgement or an authorized operator’s explicit confirmation. Log who confirmed it and when.

## Device onboarding

Before production, require exact model and firmware. Validate:

- HTTPS and DNS support in HTTP Listening;
- auth method;
- payload format and minor event codes;
- NTP/time zone;
- offline buffering and retry behavior;
- certificate trust behavior;
- optional ISUP version and approved cloud integration.

Store test results in a versioned device profile. Unknown model/firmware combinations stay in events-only/manual mode.

## Cloudflare packaging update

Prefer **Workers + Static Assets** over a separate Pages Functions layout: one Worker serves the SPA and REST API and owns Queue, D1, R2, Durable Object, and Cron bindings. This reduces duplicated routing/configuration. The Android app calls the same Worker URL.

## Mandatory safety language

Documentation and UI must state:

- Internet connectivity alone does not make the terminal safely reachable by Cloudflare.
- HTTP Listening is one-way unless the exact firmware documentation proves otherwise.
- Public ISAPI/admin port forwarding is unsupported.
- Biometric templates and device admin credentials are never stored in GitHub.
- No-PC automatic command mode is unavailable until a tested command channel is configured.
