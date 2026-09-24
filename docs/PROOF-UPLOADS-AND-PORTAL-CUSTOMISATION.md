# Proof uploads and portal customisation

## Supporting proof

Forms can upload up to five supporting JPEG, PNG, WebP or PDF files, with a 4 MB maximum per file. Supported workflows include:

- ownership requests;
- legal ownership transfers;
- tenancy nomination/assignment;
- dependant and household-member approval;
- visitor requests;
- maintenance requests;
- payment submissions.

Files are written to the administrator-configured private GitHub repository. Cloudflare D1 stores only encrypted configuration and file metadata linking each upload to its workflow record. Administrators can open proof from approval/history tables. Residents can access evidence they uploaded themselves.

Uploading proof is optional at platform level because estate rules differ. The portal labels recommended evidence at the relevant form. Administrators should reject an approval when their estate policy requires evidence and it is missing or unclear.

## Portal customisation

Administrators can edit the following under **Settings**:

- portal and estate name;
- short logo mark;
- tagline and welcome text;
- light, dark or device theme;
- primary, accent, navigation and surface colours;
- compact, comfortable or rounded corners;
- support email and phone;
- estate timezone and currency;
- default visitor duration;
- visitor decision policy;
- visitor pass format;
- card/device scan timeout;
- optional Render bridge URL.

Recommended options are selected by default:

- light theme;
- EstateMate blue and green colours;
- comfortable corners;
- Africa/Lagos timezone;
- NGN currency;
- eight-hour visitor duration;
- QR + Code 128 + PIN credentials;
- Security preview and explicit approval;
- five-minute card/device scan session.

The public login page reads only presentation settings. Storage tokens, device secrets and operational credentials are never returned by the public portal-configuration endpoint.

## Estate gate welcome image

An Administrator can publish a photograph of the estate gate that welcomes people to the portal. It appears:

- behind the welcome text on the **login screen** (on phones and small tablets, where the login brand panel is hidden, it appears as a compact banner above the sign-in card);
- behind the **dashboard hero** for every signed-in role.

Configure it under **Settings → Estate gate welcome image**: choose a JPEG, PNG or WebP photograph (maximum 4 MB), add an optional caption, and tick *Show the gate image on the login page and dashboards*. A dark scrim is applied automatically so the welcome text stays readable over any photograph. Removing the image restores the standard gradient; the uploaded file itself stays in the private repository.

The photograph is stored in the administrator-configured private GitHub repository under the `portal-branding` category, and D1 stores only three settings: `portal_gate_image_key`, `portal_gate_image_caption` and `portal_gate_image_enabled`. All three are administrator-only.

### Why one portal file is readable without signing in

`GET /api/portal-gate-image` is the only unauthenticated file route, and it exists because the login screen has to render the gate photograph *before* anyone has a session. What it can return is deliberately narrow:

- the image must be enabled and named by `portal_gate_image_key`;
- the stored file must be `status='active'`;
- its category must be exactly `portal-branding`;
- its content type must be `image/jpeg`, `image/png` or `image/webp`.

Anything else answers `404` before any fetch happens. Visitor ID proofs, payment receipts, import files and every other category stay behind the authenticated `/api/files/*` route with its existing role checks, and are never reachable through this endpoint. Storage tokens are still never exposed.

## Security gate posts

Administrators and Managers post each Security officer at the gates they may work, under **Settings → Security gate assignments**.

Once an officer has at least one assignment, signing in asks them which gate they are working, and that choice scopes the whole session:

- their **visitor queue** shows passes issued for every gate plus passes attached to their own gate;
- **gate activity** shows only events from their gate;
- **access-control devices** lists only their gate;
- scanning a pass issued for a different gate is refused and recorded.

The selected gate appears as a chip in the top bar, and an officer can move to another of their assigned posts from there without signing in again. Removing an assignment, or retiring the device, ends any live session at that post: the officer is asked to sign in and select again.

An officer with **no** assignment still signs in normally and sees every gate, with a dashboard notice asking an administrator to assign their post. This avoids locking anyone out before posts are configured.

Gate selection applies to the `security` role only. Administrators, Managers, Cashiers and Residents are never asked, and a Manager account is never mistaken for a Security officer.

Shift history — which officer selected which gate, when it started and why it ended — is recorded and available through `GET /api/security/gate-sessions`. Officers see only their own shifts.
