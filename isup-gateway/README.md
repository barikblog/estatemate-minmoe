# EstateMate always-on Hikvision ISUP/TCP gateway

This package replaces the **transport role** of the optional Render HTTPS relay when a device requires genuine public raw TCP and two-way commands. It does not try to keep Render Free awake. Render enforces idle spin-down outside the application and publicly routes HTTP/WebSocket rather than arbitrary ISUP TCP.

## Selected hosting pattern

Use a small, public **x86_64 Ubuntu VM** because official Hikvision Linux SDK packages are commonly architecture-specific. An OCI Always Free-eligible AMD micro VM can be attempted when capacity is available and the SDK fits its memory. Use Ampere A1 only when the supplied SDK explicitly includes ARM64 libraries.

No provider can be made reliable by a script beyond its service terms. OCI documents possible reclamation of under-utilized Always Free compute, so this is the closest free-only option, not an uptime guarantee. Do not generate artificial load to evade reclamation. Keep the configuration backed up and monitor the real device connection.

For production gates that require guaranteed uptime, a supported paid VM or Hikvision-hosted/partner gateway is required.

## Architecture

```text
Hikvision terminal/controller
    │ ISUP registration/alarm TCP (typically configured ports 7660/7332)
    ▼
Official Hikvision Linux ISUP SDK adapter on Ubuntu
    │ authenticated loopback HTTP
    ▼
EstateMate gateway control plane (this directory)
    │ authenticated HTTPS using the EstateMate per-device secret
    ▼
Cloudflare Worker + D1 operation/event system of record
```

The native SDK adapter owns raw TCP, registration, ISUP-key authentication, sessions, alarms and hardware commands. `server.mjs` is deliberately only a loopback control plane; it cannot replace the proprietary protocol implementation.

## What is implemented

- Dockerized, restart-always Node 22 control plane bound to `127.0.0.1:8788`.
- Allow-listed mapping from SDK device IDs to EstateMate device UUIDs/secrets.
- Authenticated event forwarding without putting the EstateMate device secret in a URL.
- Authenticated polling and result reporting for card and visitor operations.
- Worker machine endpoints with idempotent operation IDs and retry of stale `sent` operations.
- Ubuntu installer, restrictive file permissions, systemd restart policy and firewall guidance.
- A precise adapter contract for the official SDK.

## What must be supplied

Hikvision's proprietary SDK is not redistributable from this public repository. Obtain the matching Linux ISUP SDK from Hikvision's Technology Partner Portal/distributor and provide:

1. the licensed SDK archive and sample code;
2. CPU architecture (`amd64` or `arm64`);
3. exact SDK version;
4. every terminal/controller model and firmware version;
5. supported command APIs for person/card/QR/PIN provisioning.

Then compile `/opt/hikvision-isup/bin/estatemate-isup-adapter` against `SDK-ADAPTER-CONTRACT.md`. Until that native executable exists, opening TCP port 7660 alone does **not** create a functioning ISUP server.

## Installation

### 1. Prepare the VM

- Choose Ubuntu 22.04 or 24.04 with a public static/reserved IP.
- Point a DNS-only hostname at it if desired. Do not place ISUP ports behind Cloudflare's normal HTTP proxy.
- At the cloud firewall/security-list layer, allow SSH only from your administration IP.
- Allow the configured ISUP registration and alarm TCP ports only from the estate's known public addresses where possible.
- Do not expose port `8788`; it must remain loopback-only.

### 2. Install host files

From a clone of this repository:

```bash
sudo ./isup-gateway/install-ubuntu.sh install
```

The installer creates a random local adapter secret. It never creates fake traffic or an external keep-alive.

### 3. Add the access device in EstateMate

In **Access → Devices**, choose the exact model/profile and select **Off-site ISUP gateway**. Copy the returned device UUID and one-time secret into:

```text
/etc/estatemate/isup-devices.json
```

Use `isup-devices.example.json` as the schema and keep the real file mode at `0600`.

Create `/etc/estatemate/isup-adapter.json` from `isup-adapter.example.json`. Give each terminal a unique SDK device ID, matching `localDeviceId`, and strong ISUP key. This file is readable by the native adapter but contains no EstateMate API secret.

### 4. Install the official SDK adapter

Place the compiled wrapper and licensed libraries at:

```text
/opt/hikvision-isup/bin/estatemate-isup-adapter
/opt/hikvision-isup/lib/
```

Read `SDK-ADAPTER-CONTRACT.md`. The service will refuse to start if the executable or real device mapping is absent.

### 5. Start and inspect

```bash
sudo ./isup-gateway/install-ubuntu.sh start
sudo ./isup-gateway/install-ubuntu.sh status
```

Also open the same TCP ports in the provider's network security list. A host firewall rule alone is not enough on OCI and most cloud platforms.

### 6. Configure each Hikvision device

Use the model/firmware manual to set Platform Access to ISUP, the exact supported protocol version, the VM's public IP/DNS name, registration port, unique device ID and a strong per-device ISUP key. Do not reuse the EstateMate API secret as the Hikvision ISUP key.

Confirm registration/authentication/heartbeat first. Then test event delivery, disabled visitor provisioning, card upsert/disable and reconnect behavior at a non-production door before using the gateway on a live gate.

## Security and safety rules

- A credential scan remains **preview-only** in EstateMate until Admin/Security accepts or rejects it.
- Do not map scan events directly to a remote-open command.
- Reject unknown SDK device IDs and invalid ISUP keys.
- Keep SDK libraries, EstateMate device secrets and ISUP keys outside Git.
- Restrict ingress, patch the VM and monitor adapter/systemd logs without logging credentials.
- Acknowledge an operation as `applied` only after the SDK/device confirms it.
- Back up `/etc/estatemate` securely; do not put it in the source archive.

## Render remains optional

`bridge/` and `render.yaml` remain available for HTTPS event forwarding from hardware that supports HTTP Listening. They are not used for raw ISUP/TCP, and this repository intentionally contains no self-ping mechanism to evade Render Free limits.
