# Private GitHub upload storage

EstateMate uses a dedicated private GitHub repository for upload storage so paid R2 activation is not required.

## Security model

- The storage repository must be private. EstateMate rejects a public repository during configuration.
- Use a fine-grained personal access token restricted to only the storage repository.
- Required repository permission: **Contents — Read and write**.
- The token is encrypted with AES-GCM using the Worker's `STORAGE_ENCRYPTION_KEY` secret before being saved in D1. Existing deployments temporarily fall back to `JWT_SECRET` when the dedicated key is absent; an independent key is strongly recommended.
- The API reports only whether a token is configured; it never returns the token.
- Re-entering a token replaces the encrypted credential. Leaving the field blank retains the current token.
- Downloads are proxied through authenticated EstateMate routes; residents may retrieve only files they uploaded, while authorized staff retain operational access.

Do not use the public EstateMate source repository for resident uploads. Git history is not an appropriate place for public personal, financial, or ownership records.

## Setup

1. Create a dedicated private GitHub repository, such as `estatemate-private-storage`.
2. Set a strong independent Worker secret:

   ```bash
   openssl rand -base64 48 | npx wrangler secret put STORAGE_ENCRYPTION_KEY
   ```

3. Deploy migration `0004_multi_property_ownership_github_storage.sql` and the current Worker.
4. Sign in as an administrator and open **Settings → Private GitHub upload storage**.
5. Enter the owner, repository, branch, base folder, and fine-grained access token.
6. Enable uploads and click **Verify and save storage**.

EstateMate calls the GitHub repository API before enabling the configuration and rejects inaccessible or public repositories.

## Upload behavior

- Accepted generic file types: JPEG, PNG, WebP, PDF, and CSV.
- Maximum generic file size: 4 MB.
- Billing and bulk-user CSV imports retain their original source file in the private repository and expose an authenticated **Download source** action in import history. User-import source files never contain generated passwords.
- Ownership, transfer, tenancy, household, visitor, maintenance and payment forms accept up to five proof files and link them to the submitted record for authorized review.
- Files are stored below the configured base folder, grouped by category and UTC date.
- D1 stores file metadata, ownership, GitHub path, Git object identifier, content type, size, and links to related records.
- Upload and settings changes are recorded in EstateMate's audit log.

## Operational limitations

GitHub is source control, not an object-storage service. This design is suitable for the requested small-volume, free-only deployment, but administrators should monitor repository size and API-rate usage. Do not use it for video, large archives, continuous camera media, or high-frequency device images.

When storage volume grows, migrate to a purpose-built private object store. Keep the EstateMate `storage_key` abstraction so application records do not depend directly on a GitHub URL.

## Token rotation

1. Create a replacement fine-grained token.
2. Save it in EstateMate Settings and confirm verification succeeds.
3. Revoke the old token in GitHub.
4. Download a recent stored file through EstateMate to verify read access.

Adding or rotating `STORAGE_ENCRYPTION_KEY` requires re-entering the GitHub token because existing encrypted values cannot be decrypted with the new key. If production initially used the `JWT_SECRET` fallback, set the dedicated secret and immediately save the repository token again in EstateMate Settings.
