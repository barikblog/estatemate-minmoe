# Visitor credentials and access-control devices

## Visitor pass formats

Every new visitor pass contains the same numeric credential in three forms:

1. a QR code;
2. a Code 128 barcode;
3. the unique number written below both codes.

A separate six-digit PIN remains available for keypad terminals. Admin and Security users must scan or enter the code, review the visitor, host, property, validity window and status, and then explicitly accept check-in/check-out or reject the attempt. Scanning alone never accepts entry.

The phone camera scanner supports QR and common one-dimensional barcode formats. Manual entry remains available when camera permission is unavailable.

## Sharing a pass as an image or PDF

The pass dialog offers **Share as image** and **Share as PDF**. Both are rendered locally in the browser from the same credential, so no service is called and nothing is uploaded. Where the device supports sharing files, the native share sheet opens (WhatsApp, Mail, Drive and similar); otherwise the file is saved to downloads as `visitor-pass-<unique number>.png` or `.pdf`. The PDF is a single A4 page written by `apps/web/src/pdf.ts`, which embeds the rendered pass as a JPEG.

## Validity window and gate scope

The portal submits wall-clock times with no offset, so the Worker resolves them against the `estate_timezone` setting (default `Africa/Lagos`) and stores absolute UTC instants. Comparing the raw string as UTC shifted every window by the estate's offset and reported live passes as "outside its validity window"; `src/datetime.ts` is the single place that parses these values, and `/api/visitors/scan` now returns the specific blocking reason — not active yet, expired, revoked, or already checked out — instead of one generic message. Legacy rows stored without an offset are still read in the estate timezone.

Residents never choose a gate. Their passes are stored with `gate_scope='both'`, meaning every gate, entry and exit, and the gate picker is not shown to them. Only an Administrator or Manager may attach a pass to one saved device, which stores `gate_scope='gate'`. A visitor who overstays can still be checked out; an ended window blocks check-in only.

## Using an access-control device as a scanner

Admin or Security selects a saved device and starts a short visitor-validation session. EstateMate captures the next credential event uploaded by that device, resolves the credential to a visitor pass, and displays the pass before a decision. The same mechanism lets an administrator issue a physical resident/dependant card:

1. select the holder and access-control device;
2. start card enrollment;
3. tap the card at the selected reader;
4. verify the captured UID;
5. confirm issuance.

A denied unknown-card event is sufficient if the device uploads the card number.

## Model-specific behavior

- **QR-capable MinMoe/K1T models:** use QR only when the exact model and firmware document QR authentication. The credential must be provisioned to the device by a supported command channel or applied from the hardware-action queue.
- **DS-K1T808MFWX-B:** Hikvision documents card, fingerprint and PIN authentication, ISAPI and ISUP 5.0. It does not document an integrated QR camera. Use its keypad/card reader and use the EstateMate phone QR scanner at the gate.
- **DS-K2802:** this is a two-door controller with Wiegand 26/34 reader interfaces, not an optical QR scanner. QR requires a compatible external Wiegand reader. Its older controller transport commonly requires management software/gateway support.
- **DS-K1T807/DS-K1T502 QR variants:** explicitly select or auto-detect the QR profile only for QR/QRE/CQR variants.
- **Other vendors:** select the vendor-neutral profile only after validating real JSON/XML event samples. EstateMate does not assume undocumented field mappings.

Official references:

- https://www.hikvision.com/en/products/Access-Control-Products/FingerPrint-Terminals/Pro-Series/ds-k1t808mfwx-b/
- https://www.hikvision.com/mena-en/products/Access-Control-Products/Controllers/Value-Series/ds-k2802/
- https://www.hikvision.com/content/dam/hikvision/en/support/how-to/how-to-document/access-control/2021-07-05/How-to-Open-the-Door-with-QR-Code-in-MinMoe-Terminal.pdf

## Device connections

### Direct Cloudflare HTTP Listening

Recommended where the actual firmware can upload HTTP/HTTPS events. It is outbound from the device and needs no site PC. It receives events but does not let the Worker initiate ISAPI commands back through the estate router.

### Render free HTTPS relay

`render.yaml` deploys the stateless service under `bridge/`. It forwards compatible HTTPS event uploads to the Cloudflare Worker, which writes normalized events to D1. It stores no data and has no Render database.

Render Free constraints are important:

- it spins down after 15 minutes without inbound traffic;
- waking can take about one minute;
- filesystem changes are ephemeral;
- 750 free instance hours are shared by the workspace each month;
- it exposes HTTP/WebSocket services, not a general-purpose Hikvision ISUP TCP listener.

Therefore the Render relay is optional and is not the sole production path. Keep the direct Worker endpoint recorded as a fallback. It does not make DS-K2802 ISUP remotely manageable.

Deploying the Blueprint:

1. Sign in to Render and create a new Blueprint from the public EstateMate repository.
2. Confirm `estatemate-access-bridge` uses the **Free** plan.
3. Deploy without adding a Render database or persistent disk.
4. Open `/health` on the assigned Render URL.
5. In EstateMate **Settings → Portal identity, theme and recommended defaults**, enter only the HTTPS origin.
6. Select **Render free HTTPS relay** on compatible devices and rotate the device endpoint if necessary.

Official Render free-tier documentation: https://render.com/docs/free

### Dedicated ISUP/TCP gateway appliance

`isup-gateway/` is the separate raw-TCP hosting package. The recommended deployment is a small headless x86_64 Ubuntu appliance on the access-device LAN. It restarts automatically, forwards SDK events to the Worker over outbound HTTPS, polls per-device card/visitor operations, and reports confirmed results. No public ISUP port or Render service is needed. A public Ubuntu VM remains an alternative.

Arduino/ESP32 hardware cannot run the official Hikvision Linux SDK. Raspberry Pi is suitable only when Hikvision provides matching ARM64 SDK libraries. The raw ISUP listener must use the licensed official SDK for the exact SDK version, CPU architecture, model and firmware; a generic TCP socket is not a valid ISUP server.

A free VM may still be reclaimed or unavailable under the provider's free-tier policy; free-only hosting cannot provide an uptime guarantee. See [`../isup-gateway/README.md`](../isup-gateway/README.md) and its SDK adapter contract.

## Cloudflare D1 free-tier safeguards

Event records contain metadata only; images and proof documents are stored in the configured private GitHub repository. Queries use indexed device, card, visitor and timestamp fields, portal lists are paginated, and scan sessions expire quickly.

As of the referenced Cloudflare documentation, Workers Free includes 5 million D1 rows read per day, 100,000 rows written per day, 500 MB per database and 5 GB per account. Administrators should monitor Cloudflare usage and reduce image-heavy device events before limits are reached.

- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
