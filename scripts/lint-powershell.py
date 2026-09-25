#!/usr/bin/env python3
"""Structural lint for PowerShell that cannot be run locally.

GitHub Actions runs `pwsh` steps, but a Linux dev/CI sandbox usually has no
PowerShell, so a syntax error there is only discovered by burning a runner. This
catches the mistakes that are easy to make when PowerShell is embedded in a YAML
block scalar:

  * a here-string whose closing delimiter is indented (YAML indentation makes
    `"@` / `'@` land off column 0, which PowerShell rejects)
  * an unterminated here-string
  * unbalanced braces or parentheses
  * `param()` appearing after a real statement (only top-of-script is legal)
  * unresolved `${{ }}` Actions expressions left inside a `run` body

Usage:
    python3 scripts/lint-powershell.py FILE [FILE...]
    python3 scripts/lint-powershell.py --workflow WORKFLOW.yml

Exit code is non-zero if any file fails.
"""

import argparse
import re
import sys

HERE_OPEN = re.compile(r"@['\"]\s*$")
HERE_CLOSE_DQ = '"@'
HERE_CLOSE_SQ = "'@"


def strip_noise(line: str) -> str:
    """Remove comments and string literals so bracket counting is meaningful."""
    out = []
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if ch == "'":
            i += 1
            while i < n and line[i] != "'":
                i += 1
            i += 1
            out.append("''")
            continue
        if ch == '"':
            i += 1
            while i < n and line[i] != '"':
                if line[i] == '`':
                    i += 1
                i += 1
            i += 1
            out.append('""')
            continue
        if ch == '#':
            break
        out.append(ch)
        i += 1
    return ''.join(out)


def lint(text: str, label: str):
    errors = []
    lines = text.replace('\r\n', '\n').split('\n')

    here_delim = None
    seen_stmt = False
    code_lines = []

    for lineno, raw in enumerate(lines, 1):
        if here_delim is not None:
            # Closing delimiter must be at column 0, optionally followed by
            # punctuation/parameters but never preceded by whitespace.
            if raw.startswith(here_delim):
                here_delim = None
            elif raw.strip().startswith(here_delim):
                errors.append(
                    f"line {lineno}: here-string closer {here_delim!r} is indented; "
                    f"PowerShell requires it at column 0"
                )
                here_delim = None
            continue

        m = HERE_OPEN.search(raw)
        stripped = raw.strip()
        if m and not stripped.startswith('#'):
            here_delim = HERE_CLOSE_SQ if m.group(0).startswith("@'") else HERE_CLOSE_DQ
            continue

        if not stripped or stripped.startswith('#'):
            continue

        if re.match(r'param\s*\(', stripped):
            if seen_stmt:
                errors.append(
                    f"line {lineno}: param() appears mid-script "
                    f"(it must be the first statement, after any [attributes])"
                )
            seen_stmt = True
            # Still count this line's brackets: `param(` opens the block whose
            # closing `)` may sit several lines below.
            code_lines.append(strip_noise(raw))
            continue

        # [CmdletBinding()] / [Parameter(...)] legally precede param(). Only treat
        # a bare attribute as skippable *before* param() is seen: afterwards a
        # line like `[string]$InstallDir = 'C:\x'` is a real declaration whose
        # brackets must still be counted.
        if not seen_stmt and re.match(r'\[[A-Za-z]+(\([^)]*\))?\]\s*$', stripped):
            continue

        seen_stmt = True
        code_lines.append(strip_noise(raw))

    if here_delim is not None:
        errors.append(f"unterminated here-string opened with {here_delim[::-1]!r}")

    code = '\n'.join(code_lines)
    for opener, closer in (('{', '}'), ('(', ')'), ('[', ']')):
        o, c = code.count(opener), code.count(closer)
        if o != c:
            errors.append(f"unbalanced {opener}{closer}: {o} open vs {c} close")

    if '${{' in text or re.search(r'\$\{\{[^}]*\}\}', text):
        for lineno, raw in enumerate(lines, 1):
            if '${{' in raw:
                errors.append(f"line {lineno}: unresolved Actions expression in shell body: {raw.strip()[:90]}")

    status = 'FAIL' if errors else 'OK  '
    print(f"{status} {label}")
    for e in errors:
        print(f"      {e}")
    return not errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--workflow', action='append', default=[],
                    help='extract and lint every shell: pwsh step in an Actions workflow')
    args = ap.parse_args()

    ok = True
    for path in args.files:
        with open(path, encoding='utf-8') as fh:
            ok &= lint(fh.read(), path)

    for wf in args.workflow:
        try:
            import yaml  # type: ignore
        except ImportError:
            print(f"::warning::PyYAML unavailable; cannot extract pwsh steps from {wf}", file=sys.stderr)
            ok = False
            continue
        with open(wf, encoding='utf-8') as fh:
            doc = yaml.safe_load(fh)
        for job_name, job in (doc.get('jobs') or {}).items():
            for idx, step in enumerate(job.get('steps') or []):
                if step.get('shell') not in ('pwsh', 'powershell') or not step.get('run'):
                    continue
                label = f"{wf} :: {job_name}#{idx} {step.get('name', 'run')}"
                ok &= lint(step['run'], label)

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
