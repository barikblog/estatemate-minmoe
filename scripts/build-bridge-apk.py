#!/usr/bin/env python3
"""Builds the EstateMate Bridge APK without Gradle.

The bridge app is deliberately plain Java with no AndroidX, Kotlin or native
code, because that is what makes a reproducible build possible on a machine
without Android Studio, an SDK installation or network access to Maven:

    aapt2 compile/link  ->  resources + manifest
    ecj (or javac)      ->  classes
    d8                  ->  classes.dex
    this script         ->  aligned APK archive
    apksigner           ->  a v2-signed, installable APK

Exactly the same steps run in CI, so a locally built APK and the released one
come from the same pipeline. Use `--test` to run the JVM protocol suite
(bridge-apps/android/tools/ProtocolTest.java) against the sources first: it
exercises Digest auth, card operations, the alertStream parsers and the Worker
API against live local HTTP servers, which is the fastest way to know an APK is
worth installing.

Typical local run:

    scripts/build-bridge-apk.py --test \
        --android-jar /tmp/aplat/android-35/android.jar \
        --aapt2 /tmp/aaptjs3/package/bin/x64/linux/aapt2 \
        --d8 /tmp/tools/tools-minapk/tools/d8.jar \
        --apksigner /tmp/tools/tools-minapk/tools/apksigner.jar \
        --ecj /tmp/tools/tools-minapk/tools/ecj-3.45.0.jar \
        --java /tmp/tools/jdk4py/jdk4py/java-runtime/bin/java \
        --keystore /tmp/tools/tools-minapk/tools/debug.keystore

In CI the SDK supplies aapt2/d8/apksigner and `--android-jar` is discovered from
$ANDROID_HOME/platforms/android-35/android.jar.
"""

from __future__ import annotations

import argparse
import binascii
import hashlib
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "bridge-apps" / "android" / "app" / "src" / "main"
TOOLS_DIR = ROOT / "bridge-apps" / "android" / "tools"

DEFAULT_KEYSTORE_ALIAS = "androiddebugkey"
DEFAULT_KEYSTORE_PASSWORD = "android"
DEFAULT_STORE_PASSWORD = "android"


class BuildError(RuntimeError):
    """Anything that stops the build with an operator-readable message."""


def step(message: str) -> None:
    print(f"\n== {message}")


def run(command: list[str], what: str, quiet: bool = False) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stdout or "") + (result.stderr or "")
        raise BuildError(f"{what} failed (exit {result.returncode}):\n{detail.strip()}")
    if not quiet and result.stdout.strip():
        print(result.stdout.strip())
    return result.stdout


# --------------------------------------------------------------------- tools --


def discover_android_jar(explicit: str | None) -> pathlib.Path:
    if explicit:
        path = pathlib.Path(explicit)
        if not path.exists():
            raise BuildError(f"--android-jar not found: {path}")
        return path
    for env in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        home = os.environ.get(env)
        if not home:
            continue
        for level in ("android-35", "android-34", "android-33"):
            candidate = pathlib.Path(home) / "platforms" / level / "android.jar"
            if candidate.exists():
                return candidate
    raise BuildError(
        "no android.jar found: pass --android-jar, or set ANDROID_HOME with platforms/android-35 (in CI the SDK is already installed)"
    )


def discover_build_tool(explicit: str | None, name: str) -> str | None:
    if explicit:
        return explicit
    for env in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        home = os.environ.get(env)
        if not home:
            continue
        build_tools = pathlib.Path(home) / "build-tools"
        if not build_tools.is_dir():
            continue
        for version in sorted((entry.name for entry in build_tools.iterdir()), reverse=True):
            for candidate in (build_tools / version / name, build_tools / version / f"{name}.jar", build_tools / version / f"{name}.bat"):
                if candidate.exists():
                    return str(candidate)
    return None


def discover_java(explicit: str | None) -> str:
    if explicit:
        return explicit
    for candidate in ("java", "java.exe"):
        found = shutil.which(candidate)
        if found:
            return found
    for env in ("JAVA_HOME", "JDK_HOME"):
        home = os.environ.get(env)
        if home and (pathlib.Path(home) / "bin" / "java").exists():
            return str(pathlib.Path(home) / "bin" / "java")
    raise BuildError("no java runtime found: pass --java or set JAVA_HOME")


def java_command(java: str, tool: str, main_class: str | None = None) -> list[str]:
    """Accepts a jar, a jar without a Main-Class header, or an SDK launcher script."""
    path = pathlib.Path(tool)
    if path.suffix == ".jar":
        if main_class:
            return [java, "-cp", str(path), main_class]
        return [java, "-jar", str(path)]
    return [str(path)]


def compile_java(args, sources: list[str], platform_jar: pathlib.Path | None, out_dir: pathlib.Path, java_home: str | None) -> None:
    """Compiles with the platform javac when present, otherwise with ecj.

    `platform_jar` is the android.jar the app targets; pass None to compile the
    protocol layer against the JVM's own classes (the `--test` path).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    javac = None
    if java_home:
        candidate = pathlib.Path(java_home) / "bin" / ("javac.exe" if os.name == "nt" else "javac")
        if candidate.exists():
            javac = str(candidate)
    if javac is None:
        javac = shutil.which("javac")
    platform = [] if platform_jar is None else ["-bootclasspath", str(platform_jar), "-classpath", str(platform_jar)]
    if javac:
        step(f"Compiling {len(sources)} Java file(s) with javac")
        run([javac, "-source", "8", "-target", "8", "-nowarn", "-proc:none"] + platform + ["-d", str(out_dir)] + sources, "javac")
        return
    if not args.ecj:
        raise BuildError("javac is not available: pass --ecj <ecj.jar> (or a JDK with javac)")
    step(f"Compiling {len(sources)} Java file(s) with ecj")
    run([args.java, "-jar", args.ecj, "-source", "1.8", "-target", "1.8", "-nowarn", "-proc:none"] + platform
        + ["-d", str(out_dir)] + sources, "ecj")


# ------------------------------------------------------------------ zip work --


def write_aligned_apk(entries: list[tuple[str, bytes, bool]], target: pathlib.Path) -> None:
    """Writes an APK archive, aligning every stored entry to 4 bytes.

    Android 11+ refuses to install an APK whose resources.arsc is compressed or
    not 4-byte aligned, and zipalign is a build-tools binary this script cannot
    always assume. Padding the local (and central) extra field is exactly what
    zipalign does, so the resulting archive is the same shape.
    """

    def local_header(name: bytes, method: int, crc: int, compressed: int, uncompressed: int, extra: bytes) -> bytes:
        return struct.pack(
            "<IHHHHHIIIHH",
            0x04034B50,
            20,
            0,
            method,
            0x21,  # 1980-01-01, matching aapt2's own timestamps
            0,
            crc & 0xFFFFFFFF,
            compressed,
            uncompressed,
            len(name),
            len(extra),
        ) + name + extra

    central: list[bytes] = []
    blob = bytearray()
    for name, data, stored in entries:
        name_bytes = name.encode("utf-8")
        if stored:
            payload = data
            method = 0
        else:
            # ZIP stores a raw DEFLATE stream, not a zlib stream: no header, no
            # adler32 trailer. Using zlib.compress() here produces an archive that
            # looks fine in Python but cannot be inflated by apksigner or Android.
            compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
            payload = compressor.compress(data) + compressor.flush()
            method = 8
        crc = binascii.crc32(data) & 0xFFFFFFFF

        extra = b""
        offset = len(blob)
        header_size = 30 + len(name_bytes)
        if stored:
            padding = (4 - ((offset + header_size + len(extra)) % 4)) % 4
            extra = b"\x00" * padding  # zipalign-style padding in the extra field
        blob += local_header(name_bytes, method, crc, len(payload), len(data), extra)
        data_offset = len(blob)
        if stored and data_offset % 4 != 0:
            raise BuildError(f"internal error: {name} is not 4-byte aligned")
        blob += payload

        central.append(
            struct.pack(
                "<IHHHHHHIIIHHHHHII",
                0x02014B50,
                20,
                20,
                0,
                method,
                0x21,
                0,
                crc,
                len(payload),
                len(data),
                len(name_bytes),
                len(extra),
                0,
                0,
                0,
                0,
                offset,
            )
            + name_bytes
            + extra
        )

    central_offset = len(blob)
    for record in central:
        blob += record
    central_size = len(blob) - central_offset
    blob += struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        len(entries),
        len(entries),
        central_size,
        central_offset,
        0,
    )
    target.write_bytes(bytes(blob))


def read_entries(apk: pathlib.Path) -> list[tuple[str, bytes, bool]]:
    entries: list[tuple[str, bytes, bool]] = []
    with zipfile.ZipFile(apk) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            stored = info.compress_type == zipfile.ZIP_STORED
            entries.append((info.filename, archive.read(info), stored))
    return entries


def verify_apk(apk: pathlib.Path) -> list[str]:
    """Structural checks Android performs before it will install the APK."""
    problems: list[str] = []
    with zipfile.ZipFile(apk) as archive:
        names = set(archive.namelist())
        if "AndroidManifest.xml" not in names:
            problems.append("AndroidManifest.xml is missing")
        if "resources.arsc" not in names:
            problems.append("resources.arsc is missing")
        if "classes.dex" not in names:
            problems.append("classes.dex is missing")
        info = archive.getinfo("resources.arsc") if "resources.arsc" in names else None
        if info is not None and info.compress_type != zipfile.ZIP_STORED:
            problems.append("resources.arsc must be stored uncompressed")
        data = apk.read_bytes()
        if info is not None:
            with archive.open("resources.arsc"):
                pass
        # The data offset of every stored entry has to be 4-byte aligned.
        for info in archive.infolist():
            if info.compress_type != zipfile.ZIP_STORED:
                continue
            offset = info.header_offset + 30 + len(info.filename.encode("utf-8")) + len(info.extra)
            if offset % 4 != 0:
                problems.append(f"{info.filename} is not 4-byte aligned (offset {offset})")
        if len(data) < 1024:
            problems.append("the APK is implausibly small")
    return problems


# ---------------------------------------------------------------------- main --


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the EstateMate Bridge APK without Gradle")
    parser.add_argument("--out", default=str(ROOT / "dist" / "android"), help="directory for the APK and its checksum file")
    parser.add_argument("--name", default=None, help="APK file name (default estatemate-bridge-<version>.apk)")
    parser.add_argument("--version-name", default="0.2.0")
    parser.add_argument("--version-code", type=int, default=1)
    parser.add_argument("--min-sdk", type=int, default=26)
    parser.add_argument("--target-sdk", type=int, default=34)
    parser.add_argument("--android-jar", default=None)
    parser.add_argument("--aapt2", default=None)
    parser.add_argument("--d8", default=None)
    parser.add_argument("--apksigner", default=None)
    parser.add_argument("--ecj", default=None)
    parser.add_argument("--java", default=None)
    parser.add_argument("--java-home", default=os.environ.get("JAVA_HOME"))
    parser.add_argument("--keystore", default=None)
    parser.add_argument("--keystore-password", default=os.environ.get("ANDROID_KEYSTORE_PASSWORD", DEFAULT_KEYSTORE_PASSWORD))
    parser.add_argument("--key-alias", default=os.environ.get("ANDROID_KEY_ALIAS", DEFAULT_KEYSTORE_ALIAS))
    parser.add_argument("--key-password", default=os.environ.get("ANDROID_KEY_PASSWORD", DEFAULT_STORE_PASSWORD))
    parser.add_argument("--test", action="store_true", help="run the JVM protocol tests before building")
    parser.add_argument("--only-test", action="store_true", help="run the protocol tests and stop")
    parser.add_argument("--keep-build-dir", action="store_true")
    args = parser.parse_args()

    args.java = discover_java(args.java)
    args.android_jar = discover_android_jar(args.android_jar)
    args.aapt2 = args.aapt2 or discover_build_tool(None, "aapt2")
    args.d8 = args.d8 or discover_build_tool(None, "d8")
    args.apksigner = args.apksigner or discover_build_tool(None, "apksigner")
    if not args.aapt2:
        raise BuildError("aapt2 not found: pass --aapt2 or set ANDROID_HOME")

    protocol_sources = sorted(str(path) for path in (APP_DIR / "java").rglob("*.java"))
    test_sources = sorted(str(path) for path in TOOLS_DIR.rglob("*.java"))
    # The android-free protocol layer is what the JVM tests can compile and run.
    pure_sources = [path for path in protocol_sources if not any(
        marker in path for marker in ("BridgeService.java", "BootReceiver.java", "BridgePrefs.java", "MainActivity.java")
    )]

    if args.test or args.only_test:
        step("Running the JVM protocol tests")
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "classes"
            out.mkdir(parents=True, exist_ok=True)
            compile_java(args, pure_sources + test_sources, None, out, args.java_home)
            run([args.java, "-cp", str(out), "com.estatemate.bridge.ProtocolTest"], "protocol tests")
        if args.only_test:
            return 0

    version_name = args.version_name
    apk_name = args.name or f"estatemate-bridge-{version_name}.apk"
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    build_dir = pathlib.Path(tempfile.mkdtemp(prefix="estatemate-bridge-apk-"))
    try:
        step(f"Building resources (aapt2 compile/link, minSdk {args.min_sdk}, targetSdk {args.target_sdk})")
        res_zip = build_dir / "resources.zip"
        res_dir = APP_DIR / "res"
        compiled = False
        if res_dir.is_dir():
            run([args.aapt2, "compile", "--dir", str(res_dir), "-o", str(res_zip)], "aapt2 compile")
            compiled = True
        base_apk = build_dir / "base.apk"
        java_gen = build_dir / "gen"
        manifest = APP_DIR / "AndroidManifest.xml"
        # aapt2's --version-code/--version-name do not reliably override a manifest
        # that states its own values (the manifest wins), so stamp a copy instead:
        # CI derives the version from the tag and the APK must carry it.
        manifest_copy = build_dir / "AndroidManifest.xml"
        text = manifest.read_text(encoding="utf-8")
        text = re.sub(r'android:versionCode="[^"]*"', f'android:versionCode="{args.version_code}"', text)
        text = re.sub(r'android:versionName="[^"]*"', f'android:versionName="{version_name}"', text)
        manifest_copy.write_text(text, encoding="utf-8")
        link = [args.aapt2, "link", "-o", str(base_apk), "-I", str(args.android_jar),
                "--manifest", str(manifest_copy),
                "--java", str(java_gen),
                "--min-sdk-version", str(args.min_sdk), "--target-sdk-version", str(args.target_sdk),
                "--version-code", str(args.version_code), "--version-name", version_name]
        if compiled:
            # Compiled resources are positional inputs; -R would mean "overlay".
            link.append(str(res_zip))
        run(link, "aapt2 link")

        generated = sorted(str(path) for path in java_gen.rglob("*.java"))
        classes_dir = build_dir / "classes"
        compile_java(args, protocol_sources + generated, args.android_jar, classes_dir, args.java_home)
        class_files = sorted(str(path) for path in classes_dir.rglob("*.class"))
        if not class_files:
            raise BuildError("no class files were produced")

        step(f"Dexing {len(class_files)} class file(s) with d8")
        if not args.d8:
            raise BuildError("d8 not found: pass --d8 or set ANDROID_HOME")
        dex_dir = build_dir / "dex"
        dex_dir.mkdir(parents=True, exist_ok=True)
        run(java_command(args.java, args.d8, "com.android.tools.r8.D8") + ["--release", "--min-api", str(args.min_sdk),
                                                "--lib", str(args.android_jar), "--output", str(dex_dir)] + class_files, "d8")

        step("Packaging and aligning the APK")
        entries = read_entries(base_apk)
        entries.append(("classes.dex", (dex_dir / "classes.dex").read_bytes(), False))
        unsigned = build_dir / "unsigned.apk"
        write_aligned_apk(entries, unsigned)

        problems = verify_apk(unsigned)
        if problems:
            raise BuildError("the packaged APK failed its structural checks:\n  " + "\n  ".join(problems))

        apk_path = out_dir / apk_name
        if not args.apksigner:
            if not os.environ.get("CI"):
                raise BuildError("apksigner not found: pass --apksigner or set ANDROID_HOME")
            shutil.copyfile(unsigned, apk_path)
            print("warning: apksigner is unavailable, so the APK is UNSIGNED")
        else:
            step("Signing the APK (APK Signature Scheme v2)")
            keystore = args.keystore
            if not keystore:
                raise BuildError("no keystore: pass --keystore (or set ANDROID_KEYSTORE_BASE64 in CI and decode it first)")
            sign = java_command(args.java, args.apksigner) + [
                "sign", "--ks", keystore, "--ks-key-alias", args.key_alias,
                "--ks-pass", f"pass:{args.keystore_password}", "--key-pass", f"pass:{args.key_password}",
                "--min-sdk-version", str(args.min_sdk), "--v1-signing-enabled", "false", "--v2-signing-enabled", "true",
                "--out", str(apk_path), str(unsigned),
            ]
            run(sign, "apksigner sign")
            verify = java_command(args.java, args.apksigner) + ["verify", "--min-sdk-version", str(args.min_sdk), "--print-certs", str(apk_path)]
            output = run(verify, "apksigner verify", quiet=True)
            for line in output.strip().splitlines()[:6]:
                print("   " + line)

        problems = verify_apk(apk_path)
        if problems:
            raise BuildError("the signed APK failed its structural checks:\n  " + "\n  ".join(problems))

        digest = hashlib.sha256(apk_path.read_bytes()).hexdigest()
        (out_dir / "SHA256SUMS.txt").write_text(f"{digest}  {apk_name}\n", encoding="utf-8")

        size_mb = apk_path.stat().st_size / (1024 * 1024)
        step("Done")
        print(f"  {apk_name}  {size_mb:.1f} MB  sha256 {digest[:16]}…")
        print(f"  version {version_name} ({args.version_code}), minSdk {args.min_sdk}, targetSdk {args.target_sdk}")
        print(f"  signed with {args.key_alias}")
        print(f"  install with: adb install -r {apk_path}")
        return 0
    finally:
        if args.keep_build_dir:
            print(f"  build directory kept at {build_dir}")
        else:
            shutil.rmtree(build_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as error:
        print(f"\nbuild-bridge-apk: {error}", file=sys.stderr)
        sys.exit(1)
