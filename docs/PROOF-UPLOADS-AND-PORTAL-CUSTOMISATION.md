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
