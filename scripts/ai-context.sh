#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
printf '\n== EstateMate AI continuation context ==\n'
printf 'Repository: https://github.com/barikblog/estatemate-minmoe\n'
printf 'Live portal: https://estatemate.barikblog.workers.dev\n'
printf '\n-- branch and working tree --\n'
git branch --show-current
git status --short
printf '\n-- recent commits --\n'
git log --oneline -8
printf '\n-- latest migrations --\n'
find migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort | tail -8
printf '\n-- important continuation files --\n'
printf '%s\n' AGENTS.md docs/AI-HANDOFF.md README.md src/index.ts src/hikvision-profiles.ts apps/web/src/App.tsx render.yaml
printf '\n-- tracked files changed by the current branch versus origin/main --\n'
git fetch --quiet origin main 2>/dev/null || true
git diff --stat origin/main...HEAD 2>/dev/null || true
printf '\nRead AGENTS.md and docs/AI-HANDOFF.md before editing. Never print or commit secrets.\n'
