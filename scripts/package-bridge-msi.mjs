#!/usr/bin/env node
/**
 * Packages the EstateMate bridge executable as an MSI installer.
 *
 *   node scripts/package-bridge-msi.mjs \
 *     --exe dist/bridge/estatemate-bridge-win-x64.exe \
 *     --out dist/bridge-msi --version 0.2.0 --commit <sha>
 *
 * Why an MSI: the single-file executable is a console tool, not an installer —
 * double-clicking it runs `estatemate-bridge run` in a window that flashes and
 * closes, which reads as "the exe is not installing". The MSI gives it a real
 * Windows install story: Program Files, Programs and Features, upgrade and
 * uninstall, Start Menu console shortcuts that stay open, App Paths (Win+R)
 * and the install directory on the system PATH.
 *
 * The installer is authored in WiX v3 (bridge-apps/windows/msi/estatemate-
 * bridge.wxs), which the GitHub Actions windows-latest runner ships
 * preinstalled, so CI needs no extra tooling. MSI construction only works on
 * Windows; `--dry-run` stages everything and prints the candle/light commands
 * so the packaging logic stays testable on any platform.
 *
 * What the MSI deliberately does not do: register the start-at-boot scheduled
 * task (that needs the agent credentials from the portal first) or touch
 * %ProgramData%\EstateMate (configuration, secrets and logs survive
 * uninstall). See the .wxs header comment for the full contract.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_WXS = path.join(repoRoot, 'bridge-apps', 'windows', 'msi', 'estatemate-bridge.wxs');

/** Places candle/light live when they are not on PATH. */
const WIX_INSTALL_DIRS = [
  process.env.WIX ? path.join(process.env.WIX, 'bin') : null,
  'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin',
  'C:\\Program Files (x86)\\WiX Toolset v3.11\\bin',
  'C:\\Program Files (x86)\\WiX Toolset v3.10\\bin',
  'C:\\ProgramData\\chocolatey\\bin',
].filter(Boolean);

/**
 * GitHub renders workflow failure messages only in the job log, which the
 * sandboxed reviewers of this repository cannot always fetch. Surface the
 * message as a check annotation too, so a red run explains itself.
 */
function annotateError(error) {
  if (!process.env.GITHUB_ACTIONS) return;
  const message = String((error && error.message) || error).replace(/[\r\n]+/g, ' | ').slice(0, 3000);
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error::${escaped}`);
}

function usage() {
  const text = `Usage: node scripts/package-bridge-msi.mjs --exe <file> [options]

Required
  --exe <file>            the built bridge executable to install
                          (the win-x64 output of scripts/package-bridge-exe.mjs)

Options
  --out <dir>             where the MSI, SHA256SUMS.txt and BUILD-INFO.json land
                          (default dist/bridge-msi)
  --version <x.y.z>       MSI ProductVersion; must be numeric, each part < 65536
                          (default 0.2.0)
  --commit <sha>          commit recorded in BUILD-INFO.json
  --wxs <file>            WiX source (default bridge-apps/windows/msi/estatemate-bridge.wxs)
  --candle <file>         explicit candle.exe (else discovered: PATH, %WIX%\\bin,
                          the standard "WiX Toolset v3.x" install dirs, chocolatey)
  --light <file>          explicit light.exe (same discovery)
  --dry-run               stage the payload and print the candle/light commands
                          without running them (works on any platform)
  --keep-build-dir        leave the staging directory behind for inspection
  --quiet                 only print the summary line
`;
  process.stdout.write(text);
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    } else if (flag === '--dry-run') {
      flags.dryRun = true;
    } else if (flag === '--keep-build-dir') {
      flags.keepBuildDir = true;
    } else if (flag === '--quiet') {
      flags.quiet = true;
    } else if (flag.startsWith('--')) {
      const name = flag.slice(2);
      if (next === undefined || next.startsWith('--')) {
        fail(`--${name} needs a value`);
      }
      flags[name] = next;
      index += 1;
    } else {
      flags._.push(flag);
    }
  }
  return flags;
}

function fail(message) {
  console.error(`package-bridge-msi: ${message}`);
  annotateError(message);
  process.exit(1);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Finds candle.exe / light.exe the way a stock Windows runner exposes them. */
function discoverTool(name, explicit) {
  if (explicit) {
    if (!isFile(explicit)) fail(`--${name.toLowerCase()} not found: ${explicit}`);
    return path.resolve(explicit);
  }
  const onPath = spawnSync('where', [`${name}.exe`], { encoding: 'utf8', shell: true });
  if (onPath.status === 0) {
    const found = String(onPath.stdout || '').split(/\r?\n/).find((line) => line && isFile(line.trim()));
    if (found) return found.trim();
  }
  for (const dir of WIX_INSTALL_DIRS) {
    const candidate = path.join(dir, `${name}.exe`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function run(command, args, what) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    fail(`${what} failed with exit code ${result.status}`);
  }
}

/** MSI ProductVersion: numeric major.minor[.build], each field < 65536. */
function validateVersion(version) {
  const match = /^(\d{1,5})\.(\d{1,5})(?:\.(\d{1,5}))?$/.exec(String(version || ''));
  if (!match) {
    fail(`--version "${version}" is not a valid MSI ProductVersion: use plain numbers like 0.2.0 (no pre-release tags; each part < 65536)`);
  }
  const [major, minor, build] = [Number(match[1]), Number(match[2]), Number(match[3] || '0')];
  if (major > 65535 || minor > 65535 || build > 65535) {
    fail(`--version "${version}" has a field above 65535; Windows Installer cannot represent it`);
  }
  return `${major}.${minor}.${build}`;
}

/** The README installed next to the executable: the whole setup story in one screen. */
function readmeText(version) {
  return [
    'EstateMate Bridge',
    '=================',
    '',
    `Installed version ${version}. This is the estate access-device agent: it`,
    'streams gate events from the Hikvision terminals to the EstateMate server',
    'and applies card/visitor operations over ISAPI. It runs on this PC only; it',
    'never listens on a port.',
    '',
    'Five-minute setup',
    '-----------------',
    '1. On the EstateMate portal (Administrator): Device agent -> Add agent,',
    '   then Connect terminal for each terminal. Use "Download setup" and carry',
    '   the .ps1 to this PC - it already contains the agent id and secret.',
    '2. Start Menu -> EstateMate Bridge -> "EstateMate Bridge Console" (or open',
    '   any PowerShell; estatemate-bridge is on the PATH) and run:',
    '',
    '       estatemate-bridge setup',
    '       estatemate-bridge check',
    '',
    '3. When the check passes, from an ADMINISTRATOR console:',
    '',
    '       estatemate-bridge install-service',
    '',
    '   That registers the start-at-boot task. The service keeps running after',
    '   you log off; check it any time with "Service status" in the Start Menu.',
    '',
    'Where things live',
    '-----------------',
    '  Program:        C:\\Program Files\\EstateMate Bridge (managed by Windows)',
    '  Configuration:  %ProgramData%\\EstateMate (agent + terminal credentials)',
    '  Logs:           %ProgramData%\\EstateMate\\logs',
    '',
    'Configuration and logs are deliberately NOT removed when you uninstall, so',
    'an upgrade (or reinstall) keeps the estate running without re-setup.',
    '',
    'Uninstall: Settings -> Apps -> EstateMate Bridge. To also remove the boot',
    'task first, run:  estatemate-bridge uninstall-service',
    '',
    'This build is unsigned (no code-signing certificate is used by this',
    'project). If Windows shows "Windows protected your PC" for the MSI, click',
    'More info -> Run anyway, or unblock the file first: right-click the MSI,',
    'Properties -> Unblock.',
    '',
  ].join('\r\n');
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const exePath = flags.exe ? path.resolve(flags.exe) : null;
  if (!exePath || !isFile(exePath)) {
    fail(`--exe must point at the built bridge executable${exePath ? ` (not found: ${exePath})` : ''}`);
  }
  const version = validateVersion(flags.version || '0.2.0');
  const wxsPath = path.resolve(flags.wxs || DEFAULT_WXS);
  if (!isFile(wxsPath)) fail(`WiX source not found: ${wxsPath}`);
  const outDir = path.resolve(flags.out || path.join('dist', 'bridge-msi'));
  fs.mkdirSync(outDir, { recursive: true });

  // ---- stage the payload -------------------------------------------------
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estatemate-bridge-msi-'));
  try {
    const stagedExe = path.join(buildDir, 'estatemate-bridge.exe');
    fs.copyFileSync(exePath, stagedExe);
    const stagedReadme = path.join(buildDir, 'README.txt');
    fs.writeFileSync(stagedReadme, readmeText(version), 'utf8');

    const msiName = `estatemate-bridge-${version}-win-x64.msi`;
    const msiPath = path.join(outDir, msiName);
    const wixobjPath = path.join(buildDir, 'estatemate-bridge.wixobj');

    const candleArgs = [
      '-nologo', '-arch', 'x64',
      `-dVersion=${version}`,
      `-dExeSource=${stagedExe}`,
      `-dReadmeSource=${stagedReadme}`,
      '-out', wixobjPath,
      wxsPath,
    ];
    // ICE43 wants non-advertised shortcuts to have an HKCU keypath; ours are
    // per-machine shortcuts next to a per-machine executable, so that per-user
    // repair nuance does not apply. Every other ICE still validates the MSI.
    const lightArgs = ['-nologo', '-sice:ICE43', wixobjPath, '-out', msiPath];

    if (flags.dryRun) {
      console.log('[dry-run] staged payload:');
      console.log(`  exe    : ${stagedExe} (${fs.statSync(stagedExe).size} bytes)`);
      console.log(`  readme : ${stagedReadme} (${fs.statSync(stagedReadme).size} bytes)`);
      console.log('\n[dry-run] would run:');
      console.log(`  candle ${candleArgs.join(' ')}`);
      console.log(`  light  ${lightArgs.join(' ')}`);
      console.log(`\n[dry-run] output would be ${msiPath}`);
      return;
    }

    if (process.platform !== 'win32') {
      fail('MSI construction needs candle/light from the WiX Toolset, which runs on Windows (use --dry-run elsewhere; CI builds the MSI on windows-latest)');
    }
    const candle = discoverTool('candle', flags.candle);
    const light = discoverTool('light', flags.light);
    if (!candle) {
      fail('candle.exe not found: pass --candle, install the WiX Toolset v3, or set WIX (the GitHub Actions windows-latest runner ships it preinstalled)');
    }
    if (!light) {
      fail('light.exe not found: pass --light, install the WiX Toolset v3, or set WIX (the GitHub Actions windows-latest runner ships it preinstalled)');
    }

    console.log(`Compiling the installer with ${candle}`);
    run(candle, candleArgs, 'candle');
    console.log(`Linking ${msiName} with ${light}`);
    run(light, lightArgs, 'light');

    if (!isFile(msiPath) || fs.statSync(msiPath).size < 10_000) {
      fail(`light reported success but ${msiPath} is missing or implausibly small`);
    }

    // ---- checksums + build info -------------------------------------------
    const msiSha = sha256(msiPath);
    fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${msiSha}  ${msiName}\n`);
    fs.writeFileSync(
      path.join(outDir, 'BUILD-INFO.json'),
      `${JSON.stringify(
        {
          product: 'estatemate-bridge-msi',
          version,
          upgradeCode: 'BE4C3E0B-927B-471E-92DE-A0BFAEF4C266',
          platform: 'win-x64',
          commit: flags.commit || null,
          source: { exe: path.basename(exePath), exeSha256: sha256(exePath) },
          wix: { candle: path.basename(candle), light: path.basename(light) },
        },
        null,
        2,
      )}\n`,
    );

    const sizeMb = fs.statSync(msiPath).size / (1024 * 1024);
    if (!flags.quiet) {
      console.log('');
      console.log(`MSI ready: ${msiPath}`);
      console.log(`  ${msiName}  ${sizeMb.toFixed(1)} MB  sha256 ${msiSha.slice(0, 16)}…`);
      console.log('  installs to C:\\Program Files\\EstateMate Bridge (per-machine, x64)');
      console.log('  Start Menu shortcuts + App Paths + PATH; no service registration (see README.txt)');
    } else {
      console.log(`${msiName}  ${sizeMb.toFixed(1)} MB  sha256 ${msiSha.slice(0, 16)}…`);
    }
  } finally {
    if (flags.keepBuildDir) {
      console.log(`  staging directory kept at ${buildDir}`);
    } else {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  fail(error && error.stack ? error.stack : error);
}
