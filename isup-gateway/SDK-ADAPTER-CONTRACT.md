# Official Hikvision ISUP SDK adapter contract

The proprietary Hikvision Linux ISUP SDK and its redistributable native libraries are **not** committed to this public repository. Obtain the correct SDK from Hikvision's Technology Partner Portal or your distributor, confirm its licence, architecture and supported firmware, and compile a small native executable named `estatemate-isup-adapter`.

The native executable owns the public raw-TCP listeners. The Node control plane binds only to loopback and connects the adapter to EstateMate over authenticated HTTPS.

## Required executable interface

The systemd unit starts:

```text
/opt/hikvision-isup/bin/estatemate-isup-adapter \
  --bind 0.0.0.0 \
  --registration-port 7660 \
  --alarm-port 7332 \
  --control-url http://127.0.0.1:8788 \
  --device-config /etc/estatemate/isup-adapter.json
```

The executable must load its official SDK libraries from `/opt/hikvision-isup/lib`, keep the SDK registration and alarm listeners active, reconnect/restart safely, and shut the SDK down cleanly on SIGTERM.

Do not implement ISUP by treating it as arbitrary JSON over TCP. Device registration, ISUP-key authentication, session keys, alarms and command responses must be handled with the official SDK callbacks and structures for the exact SDK release.

## Local control-plane authentication

Read `ADAPTER_SHARED_SECRET` from `/etc/estatemate/isup-gateway.env`. Every request below must include:

```http
Authorization: Bearer <ADAPTER_SHARED_SECRET>
```

The control API is reachable only on `127.0.0.1:8788`.

## Device identity mapping

When the SDK reports a device ID, map it to a `localDeviceId` using `/etc/estatemate/isup-adapter.json`. This adapter-readable file contains only SDK device IDs, local IDs and ISUP keys; it does not contain EstateMate API secrets. `/etc/estatemate/isup-devices.json` is read only by the control-plane container. The `localDeviceId` sets in both files must match.

Reject registrations that are absent from the adapter allow-list or whose configured ISUP key fails SDK authentication. Never put an ISUP key, EstateMate device secret or resident credential in logs.

## Forwarding events

Convert an SDK alarm/access event into the SDK's documented JSON or XML event representation accepted by EstateMate, then send:

```http
POST /v1/adapter/events/<localDeviceId>
Content-Type: application/json
Authorization: Bearer <adapter secret>

{...documented Hikvision access event...}
```

A `200` response means EstateMate accepted the event for queue processing. Retry transient `429` and `5xx` responses with exponential backoff and a bounded local queue. Do not fabricate a granted event or mark a visitor accepted from the SDK callback alone.

## Fetching commands

Poll while the SDK session is online:

```http
GET /v1/adapter/operations/<localDeviceId>?limit=20
Authorization: Bearer <adapter secret>
```

Each item has:

```json
{
  "id": "operation UUID",
  "kind": "card or visitor",
  "operation": "upsert_card, enable_card, disable_card, delete_card, upsert_visitor or revoke_visitor",
  "payload": {},
  "attempt": 1,
  "createdAt": "ISO timestamp"
}
```

Use the operation UUID as an idempotency key. Apply only operations supported by the connected model and firmware. A visitor `upsert_visitor` with `enabled: false` must be provisioned as disabled/pending security approval; it must not unlock a door merely because the credential is presented.

## Reporting command results

After the official SDK confirms completion or failure:

```http
POST /v1/adapter/operations/<localDeviceId>/<operationId>/result
Content-Type: application/json
Authorization: Bearer <adapter secret>

{"kind":"card","status":"applied"}
```

or:

```json
{"kind":"visitor","status":"failed","errorMessage":"sanitized SDK error without secrets"}
```

Never report `applied` when the SDK merely accepted a request into a local queue. Wait for the SDK/device response defined by the selected command API.

## Command mapping checklist

The native implementation must be completed against the supplied SDK headers and samples:

- initialise CMS/device-gateway and alarm components;
- register callbacks for online, offline, authentication, session key and alarm events;
- validate the configured device ID and ISUP key;
- map card/person APIs for card upsert, enable, disable and delete;
- map temporary visitor/person/card or QR/PIN APIs only where the hardware profile supports them;
- preserve validity windows and disabled/pending state;
- normalize SDK errors and confirm results;
- test reconnects, duplicate operation IDs and process restarts.

Because Hikvision changes structures and capabilities across SDK and firmware releases, writing these calls without the exact SDK package would be unsafe. Upload the licensed Linux SDK archive and model/firmware list before completing this native file.
