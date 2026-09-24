# Details required for GitHub publication and Cloudflare deployment

Please reply with this template. Do **not** put device admin passwords, permanent Cloudflare Global API keys, biometric data, or resident data in the reply.

## 1. Hikvision hardware

- Exact MinMoe model(s):
- Quantity of each model:
- Full firmware version/build for each:
- Gate and direction for each terminal:
- HTTP Listening screen supports HTTPS: yes / no
- It accepts a DNS hostname: yes / no / unknown
- Listener authentication options: none / Basic / Digest / username+password / unknown
- Payload option shown: JSON / XML / both / unknown
- Platform Access also offers ISUP 5.0: yes / no / unknown
- Upload screenshots of Device Information, HTTP Listening, and Platform Access (redact serial/public IP/secrets if preferred):

## 2. GitHub

- GitHub username or organization:
- Repository name (default `estatemate-minmoe`):
- Public repository confirmed: yes / no
- Default branch (default `main`):
- License (default MIT):
- Will you provide a fine-grained temporary token, or add the repository yourself: token / self-create

For a fine-grained token, restrict it to the destination repository with **Contents: Read and write** and **Metadata: Read**. Delete/revoke it after the first push.

## 3. Cloudflare destination

- Cloudflare Account ID:
- Worker name (default `estatemate`):
- Existing custom domain, if any:
- Cloudflare zone/domain, if routing a custom hostname:
- Existing D1 name or use `estatemate-db`:
- Existing R2 bucket or use `estatemate-private`:
- Data location preference, if configured:
- Is R2 enabled on the account: yes / no / unknown

Provide a temporary scoped API token only when ready to deploy. Required scope is described in `CLOUDFLARE-DEPLOYMENT.md`. Revoke it after deployment if it is not being placed in GitHub Actions secrets.

## 4. Branding and Android

- Estate/app display name (default EstateMate):
- Android application ID (default `com.estatemate.app`):
- Logo file:
- Primary/accent colors if different:
- Minimum Android version/devices used by staff:
- Android distribution: direct APK / managed devices / Play Store

## 5. Business rules

- Facility-fee grace period in days (default 7):
- Currency (default NGN):
- Estate time zone (default Africa/Lagos):
- Approximate resident count:
- Expected daily gate events:
- Are card IDs decimal, hexadecimal, or mixed:
- Does one resident need multiple cards: yes / no
- Visitor pass approval required: yes / no

## 6. Automatic hardware enforcement decision

Choose one:

- `events-only`: deploy now with audited manual terminal changes.
- `Hikvision cloud/OpenAPI`: provide the product name, region, approved API documentation, AppKey/AppSecret via a secret channel, and test tenant.
- `dedicated ISUP gateway`: approve a small headless x86_64 Ubuntu appliance on the estate LAN (recommended) or an Internet VM, and provide licensing/SDK details. Raspberry Pi requires vendor ARM64 libraries; Arduino/ESP32 is not a supported SDK host.
- `investigate`: complete model/firmware validation first; do not enable fee-linked physical enforcement yet.
