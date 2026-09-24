#!/usr/bin/env bash
# PR-relative hygiene checks for EstateMate, run by .github/workflows/ci.yml and
# usable locally before committing. Read-only: nothing here mutates the tree.
#
#   bash scripts/ci-checks.sh              # compares against origin/main
#   BASE_SHA=<sha> bash scripts/ci-checks.sh   # explicit base (used by CI fallback)
#
# Checks: no whitespace damage, append-only D1 migrations, no committed
# credentials or token-shaped secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

# Anchor on the merge base, never a raw base sha. A PR branch can lag behind
# main, and diffing a stale base would blame other people's already-merged
# commits on the branch under review.
base=''
if git rev-parse --verify -q origin/main >/dev/null; then
  base="$(git merge-base origin/main HEAD)"
elif [ -n "${BASE_SHA:-}" ] && git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  base="${BASE_SHA}"
fi

if [ -z "$base" ]; then
  echo 'No comparable base commit (origin/main or BASE_SHA); skipping PR-relative checks.'
  exit 0
fi
echo "Comparing $(git rev-parse --short HEAD) against $(git log -1 --format='%h %s' "$base")"
status=0
fail() { printf '::error::%s\n' "$1"; status=1; }

# 1. Trailing whitespace / conflict markers introduced by this change.
if ! git diff --check "$base" HEAD; then
  fail 'Whitespace or conflict-marker damage in the diff. Run: git diff --check'
fi

# 2. D1 migrations are append-only once deployed.
changed="$(git diff --name-only --diff-filter=MD "$base" HEAD -- migrations)"
if [ -n "$changed" ]; then
  fail 'Deployed D1 migrations are append-only. Restore the files below and add a new numbered migration instead.'
  printf '  - %s\n' ${changed}
fi

# 3. Credentials never belong in the repository; *.example placeholders do.
risky='(^|/)\.dev\.vars(\..*)?$|(^|/)\.env(\..*)?$|\.npmrc$|\.netrc$|(^|/)\.git-credentials$|(^|/)id_(rsa|ecdsa|ed25519|dsa)$|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$|\.keystore$|credentials\.json$|service-account[^/]*\.json$|\.aws/credentials$'
offenders="$(git diff --name-only --diff-filter=ACMRT "$base" HEAD \
  | grep -E "$risky" | grep -vE '\.(example|template|sample)$' || true)"
if [ -n "$offenders" ]; then
  fail 'Credential-bearing files must never be committed. Keep placeholders in a *.example file instead.'
  printf '  - %s\n' ${offenders}
fi

# Real token shapes on added lines only, so existing prose cannot fail the run.
leaks="$(git diff --unified=0 "$base" HEAD \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -nE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|vCP_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  | sed -E 's/[A-Za-z0-9_]{12,}/[REDACTED]/g' | cut -c1-160 || true)"
if [ -n "$leaks" ]; then
  fail 'Added lines look like live credentials. Rotate the value and store it as a secret or an Administrator-entered setting.'
  printf '%s\n' "$leaks"
fi

# 4. Informational: CI has no JDK/Android SDK, so Kotlin is never compiled here.
if [ -n "$(git diff --name-only "$base" HEAD -- apps/android)" ]; then
  printf '::notice::apps/android changed, but neither CI nor this script has a JDK/Android SDK: Kotlin was NOT compiled. Build apps/android locally before merging.\n'
fi

if [ "$status" -eq 0 ]; then
  echo 'PR-relative checks passed: clean diff, append-only migrations, no credential-shaped content.'
fi
exit "$status"
