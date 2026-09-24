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

There is exactly one automatic transport: the **EstateMate agent** (`isapi-bridge/`) on the device LAN. The agent holds a persistent ISAPI `alertStream` per terminal (real-time events), flushes them to the Worker in batches, polls pending card/visitor operations, and applies them over ISAPI Digest. Devices not linked to an agent fall back to auditable `manual_sync` (operator applies changes from the Hardware actions queue).

The former transports — direct Cloudflare HTTP Listening, the Render free HTTPS relay (`bridge/`, `render.yaml`), Hikvision cloud/OpenAPI, and the dedicated ISUP/TCP gateway appliance (`isup-gateway/`) — were removed in migration `0013_agent_only_transports.sql`. See [`MINMOE-NO-PC.md`](MINMOE-NO-PC.md) for the decision record and [`../isapi-bridge/README.md`](../isapi-bridge/README.md) for setup.

Keep ISAPI private to the estate VLAN: never port-forward a terminal, and run the agent only on the device LAN.

## Cloudflare D1 free-tier safeguards

Event records contain metadata only; images and proof documents are stored in the configured private GitHub repository. Queries use indexed device, card, visitor and timestamp fields, portal lists are paginated, and scan sessions expire quickly.

As of the referenced Cloudflare documentation, Workers Free includes 5 million D1 rows read per day, 100,000 rows written per day, 500 MB per database and 5 GB per account. Administrators should monitor Cloudflare usage and reduce image-heavy device events before limits are reached.

- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
