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
  * (workflow steps only) a captured `$LASTEXITCODE` that is never cleared, which
    makes the step fail *after* its own last statement has already succeeded

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

# GitHub's built-in pwsh/powershell shell does not merely run the script: it appends
#
#     if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }
#
# (actions/runner, ScriptHandlerHelpers.FixUpScriptContents). So a step's verdict is
# the exit code of the last *native* command it ran, even when the script's own final
# statement succeeded and every assertion passed. The `& tool; $code = $LASTEXITCODE`
# idiom - capturing an exit code in order to tolerate it - leaves that value in place,
# and if nothing afterwards runs a native command to overwrite it, the epilogue fails
# the step. Run 36129354448 died exactly this way: a "smoke tests passed" notice and
# "Process completed with exit code 1." as adjacent annotations.
#
# The reset must be `$global:LASTEXITCODE = ...`. An unqualified assignment creates a
# shadowing script-scope variable and leaves the global one, which is what the
# epilogue reads, untouched.
LASTEXITCODE_CAPTURE = re.compile(
    r'\$(?!LASTEXITCODE\b)[A-Za-z_][A-Za-z0-9_]*\s*=\s*\$LASTEXITCODE\b')
LASTEXITCODE_CLEARED = re.compile(r'\$global:LASTEXITCODE\s*=')


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


def lint(text: str, label: str, extra_errors=None):
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

    errors.extend(extra_errors or [])

    status = 'FAIL' if errors else 'OK  '
    print(f"{status} {label}")
    for e in errors:
        print(f"      {e}")
    return not errors


def lint_lastexitcode(text: str):
    """Return errors for a captured `$LASTEXITCODE` that is never cleared.

    Only applied to Actions steps: the `exit $LASTEXITCODE` epilogue is added by the
    runner, so a standalone .ps1 executed with `pwsh -File` has no such epilogue and
    a stale value there is harmless.
    """
    # strip_noise blanks comments and string literals, so neither the comment
    # explaining this rule nor a log message mentioning $LASTEXITCODE can trigger or
    # satisfy it.
    clean = [strip_noise(l) for l in text.replace('\r\n', '\n').split('\n')]

    last_capture = None
    for lineno, body in enumerate(clean, 1):
        if LASTEXITCODE_CAPTURE.search(body):
            last_capture = lineno

    if last_capture is None:
        return []
    if any(LASTEXITCODE_CLEARED.search(body) for body in clean[last_capture - 1:]):
        return []

    return [
        "line %d: captures $LASTEXITCODE into another variable but never clears "
        "$global:LASTEXITCODE. Actions appends `if ((Test-Path -LiteralPath "
        "variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }` to every pwsh step, so a "
        "deliberately tolerated exit code fails this step after its own last "
        "statement succeeded. Add `$global:LASTEXITCODE = 0` once the exit code has "
        "been consumed." % last_capture
    ]


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
                ok &= lint(step['run'], label,
                           extra_errors=lint_lastexitcode(step['run']))

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
