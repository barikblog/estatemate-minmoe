#!/usr/bin/env python3
"""Builds the EstateMate Offline Server APK without Gradle.

The offline server app is the same idea as the bridge app — plain Java, no
AndroidX, no Kotlin, no native code — so it reuses build-bridge-apk.py's
machinery (aapt2/d8/apksigner discovery, alignment, v2 signing, verification)
and adds the two things that make this APK the estate's server:

    node scripts/bundle-offline-server.mjs
        bundles the repository's actual Worker (src/index.ts + the Android
        adapter) into assets/server/{boot.html,server-bundle.js}
    npm run build:web
        the portal SPA this script stages into assets/portal (run it first)

Assets are added with `aapt2 link -A`, the shared migration chain goes into
assets/migrations, and the result is an installable APK in which one phone or
tablet serves the whole estate LAN.

Use `--test` to run the JVM suite (WebServer, LiveFeedHub, StaticFiles,
SqlSplit) against the sources first — exactly like the bridge APK's
ProtocolTest — and `--only-test` to stop there.

Typical local run (see bridge-apps/android-offline/README.md for the full
tool-chain story):

    scripts/build-offline-apk.py --test \
        --android-jar /tmp/aplat/android-35/android.jar \
        --aapt2 /tmp/aaptjs3/package/bin/x64/linux/aapt2 \
        --d8 /tmp/tools/tools-minapk/tools/d8.jar \
        --apksigner /tmp/tools/tools-minapk/tools/apksigner.jar \
        --ecj /tmp/tools/tools-minapk/tools/ecj-3.45.0.jar \
        --java /tmp/tools/jdk4py/jdk4py/java-runtime/bin/java \
        --keystore /tmp/tools/tools-minapk/tools/debug.keystore

In CI the SDK supplies aapt2/d8/apksigner, Node builds the bundle and the
portal, and `--android-jar` is discovered from $ANDROID_HOME.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import pathlib
import re
import shutil
import sys
import tempfile
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

APP_DIR = ROOT / "bridge-apps" / "android-offline" / "app" / "src" / "main"
TOOLS_DIR = ROOT / "bridge-apps" / "android-offline" / "tools"
BRIDGE_JAVA = ROOT / "bridge-apps" / "android" / "app" / "src" / "main" / "java" / "com" / "estatemate" / "bridge"
BUNDLE_SCRIPT = HERE / "bundle-offline-server.mjs"

# The bridge classes the embedded offline agent reuses verbatim: ISAPI Digest
# auth, the alertStream parsers and the Worker API client. Compiling exactly
# these keeps unrelated bridge UI classes out of the APK.
AGENT_BRIDGE_SOURCES = [
    "AlertStreamReader.java",
    "BridgeConfig.java",
    "BridgeLog.java",
    "Device.java",
    "Digest.java",
    "IsapiClient.java",
    "Json.java",
    "WorkerClient.java",
]

# Files that cannot compile or run on a plain JVM (they need android.*).
ANDROID_ONLY = {
    "BootReceiver.java",
    "Db.java",
    "JsEngine.java",
    "MainActivity.java",
    "NativeBridge.java",
    "OfflineService.java",
    "OfflineAgent.java",
    "ServerLog.java",
    "ServerPrefs.java",
}


def load_bridge_builder():
    """build-bridge-apk.py has a dash in its name, so it is imported by path."""
    spec = importlib.util.spec_from_file_location("build_bridge_apk", HERE / "build-bridge-apk.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def stage_assets(build_dir: pathlib.Path, skip_bundle: bool) -> pathlib.Path:
    """Assembles the asset tree aapt2 packs with -A."""
    assets = build_dir / "assets"
    portal_source = ROOT / "apps" / "web" / "dist"
    if not portal_source.is_dir() or not (portal_source / "index.html").exists():
        raise_build_error(
            "the web portal is not built: run `npm run build:web` first "
            "(StaticFiles answers 503 without it)"
        )
    (assets / "portal").mkdir(parents=True, exist_ok=True)
    shutil.copytree(portal_source, assets / "portal", dirs_exist_ok=True)

    if skip_bundle:
        step("Skipping the server bundle (--skip-bundle; assets/server must already exist)")
    else:
        step("Bundling the estate engine (node scripts/bundle-offline-server.mjs)")
        bundle_out = build_dir / "server-bundle"
        bundle_out.mkdir(parents=True, exist_ok=True)
        run(["node", str(BUNDLE_SCRIPT), "--out", str(bundle_out)], "bundle the server")
        (assets / "server").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundle_out / "server-bundle.js", assets / "server" / "server-bundle.js")
        shutil.copyfile(bundle_out / "boot.html", assets / "server" / "boot.html")

    for required in (("server", "boot.html"), ("server", "server-bundle.js")):
        if not (assets / required[0] / required[1]).exists():
            raise_build_error(f"assets/{required[0]}/{required[1]} is missing: the engine cannot boot")

    (assets / "migrations").mkdir(parents=True, exist_ok=True)
    migrations = sorted((ROOT / "migrations").glob("*.sql"))
    if not migrations:
        raise_build_error("no migrations found in migrations/")
    for migration in migrations:
        shutil.copyfile(migration, assets / "migrations" / migration.name)
    return assets


def raise_build_error(message: str):
    raise BUILD.BuildError(message)


# Filled in once the bridge module is loaded (keeps helper signatures simple).
BUILD = None
step = None
run = None


def main() -> int:
    global BUILD, step, run
    BUILD = load_bridge_builder()
    step, run = BUILD.step, BUILD.run

    parser = argparse.ArgumentParser(description="Build the EstateMate Offline Server APK without Gradle")
    parser.add_argument("--out", default=str(ROOT / "dist" / "android-offline"), help="directory for the APK and its checksum file")
    parser.add_argument("--name", default=None, help="APK file name (default estatemate-offline-server-<version>.apk)")
    parser.add_argument("--version-name", default="0.1.0")
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
    parser.add_argument("--keystore-password", default=os.environ.get("ANDROID_KEYSTORE_PASSWORD", BUILD.DEFAULT_KEYSTORE_PASSWORD))
    parser.add_argument("--key-alias", default=os.environ.get("ANDROID_KEY_ALIAS", BUILD.DEFAULT_KEYSTORE_ALIAS))
    parser.add_argument("--key-password", default=os.environ.get("ANDROID_KEY_PASSWORD", BUILD.DEFAULT_STORE_PASSWORD))
    parser.add_argument("--test", action="store_true", help="run the JVM server tests before building")
    parser.add_argument("--only-test", action="store_true", help="run the JVM server tests and stop")
    parser.add_argument("--skip-bundle", action="store_true", help="do not rebuild the JS engine bundle (CI caches it separately)")
    parser.add_argument("--keep-build-dir", action="store_true")
    args = parser.parse_args()

    args.java = BUILD.discover_java(args.java)
    args.android_jar = BUILD.discover_android_jar(args.android_jar)
    args.aapt2 = args.aapt2 or BUILD.discover_build_tool(None, "aapt2")
    args.d8 = args.d8 or BUILD.discover_build_tool(None, "d8")
    args.apksigner = args.apksigner or BUILD.discover_build_tool(None, "apksigner")
    if not args.aapt2:
        raise BUILD.BuildError("aapt2 not found: pass --aapt2 or set ANDROID_HOME")

    app_sources = sorted(str(path) for path in (APP_DIR / "java").rglob("*.java"))
    test_sources = sorted(str(path) for path in TOOLS_DIR.rglob("*.java"))
    pure_sources = [path for path in app_sources if pathlib.Path(path).name not in ANDROID_ONLY]
    bridge_sources = [str(BRIDGE_JAVA / name) for name in AGENT_BRIDGE_SOURCES]
    for path in bridge_sources:
        if not pathlib.Path(path).exists():
            raise BUILD.BuildError(f"expected bridge source is missing: {path}")

    if args.test or args.only_test:
        step("Running the JVM offline-server tests")
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "classes"
            out.mkdir(parents=True, exist_ok=True)
            BUILD.compile_java(args, pure_sources + test_sources, None, out, args.java_home)
            run([args.java, "-cp", str(out), "com.estatemate.offline.OfflineServerTest"], "offline server tests")
        if args.only_test:
            return 0

    version_name = args.version_name
    apk_name = args.name or f"estatemate-offline-server-{version_name}.apk"
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    build_dir = pathlib.Path(tempfile.mkdtemp(prefix="estatemate-offline-apk-"))
    try:
        assets = stage_assets(build_dir, args.skip_bundle)

        step(f"Building resources (aapt2 compile/link, minSdk {args.min_sdk}, targetSdk {args.target_sdk})")
        res_zip = build_dir / "resources.zip"
        res_dir = APP_DIR / "res"
        compiled = False
        if res_dir.is_dir():
            run([args.aapt2, "compile", "--dir", str(res_dir), "-o", str(res_zip)], "aapt2 compile")
            compiled = True
        base_apk = build_dir / "base.apk"
        java_gen = build_dir / "gen"
        # aapt2's flags do not reliably override a manifest that states its own
        # version, so stamp a copy — the same dance build-bridge-apk.py does.
        manifest_copy = build_dir / "AndroidManifest.xml"
        text = (APP_DIR / "AndroidManifest.xml").read_text(encoding="utf-8")
        text = re.sub(r'android:versionCode="[^"]*"', f'android:versionCode="{args.version_code}"', text)
        text = re.sub(r'android:versionName="[^"]*"', f'android:versionName="{version_name}"', text)
        manifest_copy.write_text(text, encoding="utf-8")
        link = [args.aapt2, "link", "-o", str(base_apk), "-I", str(args.android_jar),
                "--manifest", str(manifest_copy),
                "-A", str(assets),
                "--java", str(java_gen),
                "--min-sdk-version", str(args.min_sdk), "--target-sdk-version", str(args.target_sdk),
                "--version-code", str(args.version_code), "--version-name", version_name]
        if compiled:
            link.append(str(res_zip))
        run(link, "aapt2 link")

        generated = sorted(str(path) for path in java_gen.rglob("*.java"))
        classes_dir = build_dir / "classes"
        BUILD.compile_java(args, app_sources + bridge_sources + generated, args.android_jar, classes_dir, args.java_home)
        class_files = sorted(str(path) for path in classes_dir.rglob("*.class"))
        if not class_files:
            raise BUILD.BuildError("no class files were produced")

        step(f"Dexing {len(class_files)} class file(s) with d8")
        if not args.d8:
            raise BUILD.BuildError("d8 not found: pass --d8 or set ANDROID_HOME")
        dex_dir = build_dir / "dex"
        dex_dir.mkdir(parents=True, exist_ok=True)
        run(BUILD.java_command(args.java, args.d8, "com.android.tools.r8.D8")
            + ["--release", "--min-api", str(args.min_sdk), "--lib", str(args.android_jar),
               "--output", str(dex_dir)] + class_files, "d8")

        step("Packaging and aligning the APK")
        entries = BUILD.read_entries(base_apk)
        entries.append(("classes.dex", (dex_dir / "classes.dex").read_bytes(), False))
        unsigned = build_dir / "unsigned.apk"
        BUILD.write_aligned_apk(entries, unsigned)

        problems = BUILD.verify_apk(unsigned)
        if problems:
            raise BUILD.BuildError("the packaged APK failed its structural checks:\n  " + "\n  ".join(problems))
        # The assets must actually be inside: an APK that boots to 503 is a
        # support case, so fail the build loudly instead.
        with zipfile.ZipFile(unsigned) as archive:
            names = set(archive.namelist())
        for required in ("assets/portal/index.html", "assets/server/boot.html",
                         "assets/server/server-bundle.js", "assets/migrations/0001_initial.sql"):
            if required not in names:
                raise BUILD.BuildError(f"{required} is missing from the APK")

        apk_path = out_dir / apk_name
        if not args.apksigner:
            if not os.environ.get("CI"):
                raise BUILD.BuildError("apksigner not found: pass --apksigner or set ANDROID_HOME")
            shutil.copyfile(unsigned, apk_path)
            print("warning: apksigner is unavailable, so the APK is UNSIGNED")
        else:
            step("Signing the APK (APK Signature Scheme v2)")
            keystore = args.keystore
            if not keystore:
                raise BUILD.BuildError("no keystore: pass --keystore (or set ANDROID_KEYSTORE_BASE64 in CI and decode it first)")
            sign = BUILD.java_command(args.java, args.apksigner) + [
                "sign", "--ks", keystore, "--ks-key-alias", args.key_alias,
                "--ks-pass", f"pass:{args.keystore_password}", "--key-pass", f"pass:{args.key_password}",
                "--min-sdk-version", str(args.min_sdk), "--v1-signing-enabled", "false", "--v2-signing-enabled", "true",
                "--out", str(apk_path), str(unsigned),
            ]
            run(sign, "apksigner sign")
            verify = BUILD.java_command(args.java, args.apksigner) + ["verify", "--min-sdk-version", str(args.min_sdk), "--print-certs", str(apk_path)]
            output = run(verify, "apksigner verify", quiet=True)
            for line in output.strip().splitlines()[:6]:
                print("   " + line)

        problems = BUILD.verify_apk(apk_path)
        if problems:
            raise BUILD.BuildError("the signed APK failed its structural checks:\n  " + "\n  ".join(problems))

        digest = hashlib.sha256(apk_path.read_bytes()).hexdigest()
        (out_dir / "SHA256SUMS.txt").write_text(f"{digest}  {apk_name}\n", encoding="utf-8")

        size_mb = apk_path.stat().st_size / (1024 * 1024)
        step("Done")
        print(f"  {apk_name}  {size_mb:.1f} MB  sha256 {digest[:16]}…")
        print(f"  version {version_name} ({args.version_code}), minSdk {args.min_sdk}, targetSdk {args.target_sdk}")
        print(f"  portal, engine bundle and {len(migrations_glob())} migrations bundled as assets")
        print(f"  signed with {args.key_alias}")
        print(f"  install with: adb install -r {apk_path}")
        return 0
    finally:
        if args.keep_build_dir:
            print(f"  build directory kept at {build_dir}")
        else:
            shutil.rmtree(build_dir, ignore_errors=True)


def migrations_glob():
    return sorted((ROOT / "migrations").glob("*.sql"))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        name = type(error).__name__
        print(f"\nbuild-offline-apk: {error}" if name == "BuildError" else f"\nbuild-offline-apk: {name}: {error}",
              file=sys.stderr)
        sys.exit(1)
