#!/usr/bin/env python3
"""Verify a built EstateMate Android APK.

Checks that the Worker base URL really reached BuildConfig, that the old
placeholder host is gone, and that the APK identity matches what CI intended.

Usage:
    python3 scripts/verify-android-apk.py APK --api-base-url URL \
        [--version-name NAME] [--build-tools DIR]

Exits non-zero with a clear message on any failure, so CI can treat it as a gate.
"""

import argparse
import os
import shutil
import subprocess
import sys
import zipfile

PLACEHOLDER = "REPLACE_WITH_WORKER_DOMAIN"


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    raise SystemExit(1)


def read_buildconfig(apk_path: str):
    """Return generated BuildConfig source if it is packaged, else None."""
    with zipfile.ZipFile(apk_path) as zf:
        for name in zf.namelist():
            if name.endswith("BuildConfig.java"):
                return zf.read(name).decode("utf-8", "replace")
    return None


def scan_binaries(apk_path: str) -> bytes:
    """Concatenate the compiled payload, used when sources are not packaged."""
    blob = b""
    with zipfile.ZipFile(apk_path) as zf:
        for name in zf.namelist():
            if name.endswith((".dex", ".arsc")):
                blob += zf.read(name)
    return blob


def find_aapt2(build_tools: str | None) -> str | None:
    if build_tools:
        candidate = os.path.join(build_tools, "aapt2")
        if os.path.exists(candidate):
            return candidate
    android_home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not android_home:
        return None
    root = os.path.join(android_home, "build-tools")
    if not os.path.isdir(root):
        return None
    # Prefer the highest installed version.
    for version in sorted(os.listdir(root), reverse=True):
        candidate = os.path.join(root, version, "aapt2")
        if os.path.exists(candidate):
            return candidate
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk")
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--version-name")
    parser.add_argument("--build-tools", help="directory containing aapt2")
    args = parser.parse_args()

    if not os.path.isfile(args.apk):
        fail(f"APK not found: {args.apk}")
    size = os.path.getsize(args.apk)
    print(f"Verifying {args.apk} ({size} bytes)")
    if size < 1024:
        fail(f"APK is implausibly small ({size} bytes)")

    want_url = args.api_base_url
    if PLACEHOLDER in want_url:
        fail(f"--api-base-url still contains the {PLACEHOLDER} placeholder")
    if not want_url.endswith("/"):
        # Retrofit resolves relative paths against this, so the slash matters.
        print(f"::warning::API base URL {want_url!r} has no trailing slash")

    source = read_buildconfig(args.apk)
    if source is not None:
        # Echo only the identity-bearing lines; the full generated file is noise.
        interesting = [
            line.strip()
            for line in source.splitlines()
            if any(k in line for k in ("API_BASE_URL", "APPLICATION_ID", "VERSION_NAME", "BUILD_TYPE"))
        ]
        print("--- generated BuildConfig (identity fields) ---")
        for line in interesting:
            print(f"  {line}")
        if f'"{want_url}"' not in source:
            fail(f"API_BASE_URL {want_url!r} not found in packaged BuildConfig.java")
        if PLACEHOLDER in source:
            fail(f"packaged BuildConfig.java still contains {PLACEHOLDER}")
        print(f"BuildConfig contains API_BASE_URL {want_url!r}")
    else:
        blob = scan_binaries(args.apk)
        if not blob:
            fail("APK contains no .dex/.arsc payload and no BuildConfig source")
        if want_url.encode() not in blob:
            fail(f"API base URL {want_url!r} not found in the compiled APK payload")
        if PLACEHOLDER.encode() in blob:
            fail(f"compiled APK payload still contains {PLACEHOLDER}")
        print(f"compiled payload contains {want_url!r} and no placeholder")

    aapt2 = find_aapt2(args.build_tools)
    if aapt2:
        try:
            out = subprocess.run(
                [aapt2, "dump", "badging", args.apk],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            print(f"::warning::could not run aapt2: {exc}")
        else:
            for line in out.stdout.splitlines():
                if line.startswith(("package:", "application-label:", "sdkVersion:", "targetSdkVersion:")):
                    print(line)
            if args.version_name and f"versionName='{args.version_name}'" not in out.stdout:
                fail(f"expected versionName '{args.version_name}' not reported by aapt2")
    else:
        print("::warning::aapt2 not found; skipped badging/versionName assertions")

    print("APK verification OK")


if __name__ == "__main__":
    main()
