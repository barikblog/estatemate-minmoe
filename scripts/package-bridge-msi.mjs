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
 * uninstall, a Start Menu entry that opens the dashboard window (the launcher
 * compiled from bridge-apps/windows/dashboard), App Paths (Win+R) and the
 * install directory on the system PATH.
 *
 * The installer is authored in WiX v3 (bridge-apps/windows/msi/estatemate-
 * bridge.wxs), which the GitHub Actions windows-latest runner ships
 * preinstalled, so CI needs no extra tooling. MSI construction only works on
 * Windows; `--dry-run` stages everything and prints the candle/light commands
 * so the packaging logic stays testable on any platform.
 *
 * Alongside the MSI this writes the installer kit: the launcher people
 * double-click (Install-EstateMate-Bridge.cmd), the script behind it
 * (install-bridge.ps1), the checksums the script verifies the MSI against, a
 * one-page READ-ME-FIRST.txt, and all of it zipped as
 * estatemate-bridge-<version>-win-x64-installer-kit.zip. On a real PC an MSI
 * can stop at "Gathering information..." with no message - security software,
 * a policy, a broken Windows Installer, a half-finished download - and the
 * launcher turns that silence into a named cause, a log kept beside the MSI
 * and, when the MSI cannot complete at all, a per-user install that needs
 * neither administrator rights nor Windows Installer. See the script's header
 * for the whole contract.
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
import { createZip } from './lib/zip-write.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_WXS = path.join(repoRoot, 'bridge-apps', 'windows', 'msi', 'estatemate-bridge.wxs');

/** Shipped next to the MSI so a double-click install can explain itself. */
const KIT_SCRIPTS = [
  { source: path.join(repoRoot, 'bridge-apps', 'windows', 'msi', 'Install-EstateMate-Bridge.cmd'), name: 'Install-EstateMate-Bridge.cmd' },
  { source: path.join(repoRoot, 'bridge-apps', 'windows', 'msi', 'install-bridge.ps1'), name: 'install-bridge.ps1' },
];

/**
 * The dashboard that the Start Menu shortcut opens: the window itself (a
 * script, so it stays readable and editable on a support call), a .cmd launcher
 * for people who prefer double-clicking something in Program Files, and the
 * source of the GUI launcher that runs the script with no console window.
 *
 * The launcher is compiled to a Windows GUI executable on the runner by
 * build-dashboard.cmd, which finds a C# compiler the machine already has
 * (Visual Studio's Roslyn, else the one in the .NET Framework directory) and
 * needs no SDK download. --dry-run therefore stages a placeholder launcher and
 * prints the command it would run, and the real build fails loudly if the
 * compiler is missing.
 */
const DASHBOARD_DIR = path.join(repoRoot, 'bridge-apps', 'windows', 'dashboard');
const DASHBOARD_SOURCES = [
  { source: path.join(DASHBOARD_DIR, 'EstateMateBridge.ps1'), name: 'EstateMateBridge.ps1', staged: 'script' },
  { source: path.join(DASHBOARD_DIR, 'EstateMateBridge.cmd'), name: 'EstateMateBridge.cmd', staged: 'launcher' },
];
const DASHBOARD_LAUNCHER_SOURCE = path.join(DASHBOARD_DIR, 'Launcher.cs');
const DASHBOARD_BUILD_SCRIPT = path.join(DASHBOARD_DIR, 'build-dashboard.cmd');

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

Output in --out
  <name>-win-x64.msi              the installer itself
  Install-EstateMate-Bridge.cmd   the launcher people double-click
  install-bridge.ps1              its logic: verify, log, explain, fall back
  SHA256SUMS.txt                  what the launcher verifies the MSI against
  READ-ME-FIRST.txt               one page for the person who unzipped the kit
  <name>-win-x64-installer-kit.zip   everything above, ready to download
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
    // The job log lives on a CDN this project's tooling cannot always fetch,
    // so replay the tool's own diagnostics as check annotations too — that is
    // the one channel that is always readable. WiX error lines look like
    // "estatemate-bridge.wxs(42) : error CNDL0000 : ...".
    const diagnostics = `${result.stdout || ''}\n${result.stderr || ''}`
      .split(/\r?\n/)
      .filter((line) => /error|warning|exception/i.test(line) || /:\s+(CNDL|LGHT|ICE)\d+/.test(line))
      .slice(0, 25);
    for (const line of diagnostics) {
      const escaped = line.slice(0, 900).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.log(`::error title=${path.basename(String(command))}::${escaped}`);
    }
    fail(`${what} failed with exit code ${result.status}`);
  }
}

/** A workflow command needs `%`, CR and LF escaped or the message truncates. */
function escapeAnnotation(text) {
  return String(text).slice(0, 900).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Runs a build helper and, when it fails or leaves no artifact behind, replays
 * its own output as check annotations — the job log archive is not fetchable
 * from this project's dev sandbox, annotations always are. `env` is the
 * quotation-proof way to hand a path to a .cmd: no argument means no quoting.
 */
function runCaptured(command, args, what, artifacts = [], env = undefined) {
  const result = spawnSync(command, args, { encoding: 'utf8', env });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (output) process.stdout.write(`${output}\n`);
  const missing = artifacts.filter((file) => !isFile(file));
  if (result.error || result.status !== 0 || missing.length) {
    const lines = output.split(/\r?\n/).filter(Boolean).slice(-12);
    for (const line of lines) console.log(`::error title=${what}::${escapeAnnotation(line)}`);
    if (missing.length) {
      console.log(`::error title=${what}::${escapeAnnotation(`${what} left no ${missing.join(', ')}`)}`);
    }
    const reason = result.error
      ? result.error.message
      : `exit code ${result.status}${missing.length ? `, no ${missing.join(', ')}` : ''}`;
    fail(`${what} did not produce its output (${reason})${lines.length ? `; last line: ${lines[lines.length - 1]}` : ''}`);
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
    '',
    'Everything happens in one window: Start Menu -> EstateMate Bridge.',
    '',
    '1. Configuration tab. In the EstateMate portal (Administrator) go to',
    '   Device agent -> Add agent, choose "Download setup" and save the .ps1 it',
    '   gives you (it already contains the agent id and secret). In the',
    '   dashboard press Browse and pick that file. If you would rather type the',
    '   values, the same tab takes the agent id, the secret and the Worker URL.',
    '',
    '2. Still on Configuration: add every Hikvision terminal on this LAN (name,',
    '   address, ISAPI user and password, and the device id the portal shows).',
    '   Then press "Save all settings".',
    '',
    '3. Status tab: press "Run check". It authenticates with the EstateMate',
    '   server and probes every terminal, and tells you what did not answer.',
    '',
    '4. Service tab: press "Start at boot". Windows asks for administrator',
    '   rights; after that the bridge keeps running through logoff and reboot.',
    '',
    'Prefer a command line? The same four steps are',
    '',
    '       estatemate-bridge setup',
    '       estatemate-bridge check',
    '       estatemate-bridge install-service      (Administrator console)',
    '',
    'and `estatemate-bridge status --json` prints everything support will ask you',
    'for. The dashboard drives exactly those commands.',
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
    'If the install did not finish',
    '------------------------------',
    'An installer window that says "Gathering information" and then disappears',
    'means something on this PC stopped Windows Installer before it could finish:',
    'antivirus or endpoint security, a policy on a managed machine, a Windows',
    'Installer service that is not running, or an MSI that did not download',
    'completely. Nothing is installed in that case, and Windows shows no error.',
    '',
    'The release also carries an installer kit',
    '(estatemate-bridge-<version>-win-x64-installer-kit.zip). Unzip it and',
    'double-click Install-EstateMate-Bridge.cmd: it verifies this MSI against its',
    'checksum, keeps a verbose log, says in plain English what the exit code',
    'means, and - if the MSI still cannot complete - installs the bridge for the',
    'current user under %LOCALAPPDATA%\\Programs\\EstateMate Bridge without using',
    'Windows Installer at all and without needing administrator rights.',
    '',
    'This build is unsigned (no code-signing certificate is used by this',
    'project). If Windows shows "Windows protected your PC" for the MSI, click',
    'More info -> Run anyway, or unblock the file first: right-click the MSI,',
    'Properties -> Unblock.',
    '',
  ].join('\r\n');
}

/** One page for the person who unzipped the kit, before they double-click anything. */
function kitReadmeText(version) {
  return [
    `EstateMate Bridge ${version} - Windows installer kit`,
    '==================================================',
    '',
    'DOUBLE-CLICK:  Install-EstateMate-Bridge.cmd',
    '',
    'That is the whole instruction. It installs the MSI in this folder, and it',
    'prints exactly what went wrong if Windows will not let the MSI finish -',
    'including the case where the installer window says "Gathering information"',
    'and then disappears with nothing installed.',
    '',
    'After installing, the Start Menu entry "EstateMate Bridge" opens a normal',
    'window: type in the agent and terminal details, press "Run check", press',
    '"Start at boot". Nothing to type into a console.',
    '',
    'Why a script and not just the MSI:',
    '  * it checks the MSI against SHA256SUMS.txt, so a download that stopped',
    '    half-way says so instead of failing silently;',
    '  * it removes the "downloaded from the Internet" mark that SmartScreen and',
    '    some antivirus products refuse;',
    '  * it starts the Windows Installer service if it is not running, checks',
    '    free disk space, and asks for administrator rights only when needed;',
    '  * it writes a verbose installer log beside the MSI and explains the exit',
    '    code in plain English;',
    '  * if the MSI still cannot complete - antivirus, a policy on a managed PC,',
    '    a broken Windows Installer, a refused elevation prompt - it installs',
    '    the bridge for the current user instead, under',
    '%LOCALAPPDATA%\\Programs\\EstateMate Bridge, using no Windows Installer',
    '    and needing no administrator rights at all.',
    '',
    'Files in this kit',
    '  Install-EstateMate-Bridge.cmd   double-click this',
    '  install-bridge.ps1              what it runs (readable - it is a script)',
    `  ${kitNameFor(version)}   the MSI it installs`,
    '  dashboard/                      the dashboard window (used by the no-installer',
    '                                  per-user install; the MSI installs its own copy)',
    '  SHA256SUMS.txt                  checksums the script verifies',
    '',
    'Prefer no installer at all? The release also carries',
    'estatemate-bridge-win-x64.exe - one file, no install, no administrator',
    'rights, no Windows Installer. Copy it anywhere and run it.',
    '',
    'The build is unsigned (this project uses no code-signing certificate).',
    '',
  ].join('\r\n');
}

function kitNameFor(version) {
  return `estatemate-bridge-${version}-win-x64-installer-kit.zip`;
}

/**
 * Everything that lands in the output directory: the MSI, the launcher and its
 * script beside it, the checksums install-bridge.ps1 verifies the MSI against,
 * a one-page READ-ME-FIRST.txt and the zip a person actually downloads.
 *
 * Returns the MSI's sha256. Called by the real build and by --dry-run (with a
 * placeholder MSI), so this code cannot rot unnoticed on a platform without
 * WiX: --dry-run produces a real kit from a fake MSI and every reference in
 * here is exercised.
 */
function writeOutputs({ outDir, msiPath, msiName, version, commit, exePath, wix, dashboard = null, dashboardFiles = [] }) {
  const kitFiles = [{ name: msiName, path: msiPath }];
  for (const script of KIT_SCRIPTS) {
    const destination = path.join(outDir, script.name);
    fs.copyFileSync(script.source, destination);
    kitFiles.push({ name: script.name, path: destination });
  }

  // The kit carries the dashboard too (in dashboard/), so the per-user install
  // that uses no Windows Installer is not the one shape that still opens a
  // console window. Under --dry-run the launcher here is the placeholder.
  const dashboardDirectory = path.join(outDir, 'dashboard');
  for (const file of dashboardFiles) {
    fs.mkdirSync(dashboardDirectory, { recursive: true });
    const destination = path.join(dashboardDirectory, path.basename(file));
    fs.copyFileSync(file, destination);
    kitFiles.push({ name: `dashboard/${path.basename(file)}`, path: destination });
  }

  // install-bridge.ps1 reads this to verify the MSI before trusting it.
  const sums = kitFiles.map((file) => `${sha256(file.path)}  ${file.name}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sums}\n`);

  const kitReadme = path.join(outDir, 'READ-ME-FIRST.txt');
  fs.writeFileSync(kitReadme, kitReadmeText(version), 'utf8');

  const kitName = kitNameFor(version);
  const kitPath = path.join(outDir, kitName);
  const zipEntries = [
    ...kitFiles.map((file) => ({ name: file.name, path: file.path })),
    { name: 'SHA256SUMS.txt', path: path.join(outDir, 'SHA256SUMS.txt') },
    { name: 'READ-ME-FIRST.txt', path: kitReadme },
  ];
  fs.writeFileSync(kitPath, createZip(zipEntries));

  fs.writeFileSync(
    path.join(outDir, 'BUILD-INFO.json'),
    `${JSON.stringify(
      {
        product: 'estatemate-bridge-msi',
        version,
        upgradeCode: 'BE4C3E0B-927B-471E-92DE-A0BFAEF4C266',
        platform: 'win-x64',
        commit,
        source: { exe: path.basename(exePath), exeSha256: sha256(exePath) },
        dashboard,
        wix,
        kit: {
          name: kitName,
          sha256: sha256(kitPath),
          files: zipEntries.map((entry) => entry.name),
        },
      },
      null,
      2,
    )}\n`,
  );

  return { msiSha: sha256(msiPath), kitPath, kitName };
}

/** The last thing the build prints: what landed where, and how big it is. */
function printSummary({ msiPath, msiName, msiSha, kitPath, kitName, quiet, dryRun = false, dryOut, outDir }) {
  const sizeMb = fs.statSync(msiPath).size / (1024 * 1024);
  if (quiet) {
    console.log(`${msiName}  ${sizeMb.toFixed(1)} MB  sha256 ${msiSha.slice(0, 16)}…`);
    console.log(`${kitName}  sha256 ${sha256(kitPath).slice(0, 16)}…`);
    return;
  }
  console.log('');
  if (dryRun) {
    console.log(`[dry-run] assembled a real kit around a placeholder MSI in ${dryOut}:`);
    for (const file of fs.readdirSync(dryOut).sort()) console.log(`  ${file}`);
    console.log(`[dry-run] --out ${outDir} would receive exactly those files once candle and light`);
    console.log('[dry-run] have run; the MSI itself is not built here.');
    return;
  }
  console.log(`MSI ready: ${msiPath}`);
  console.log(`  ${msiName}  ${sizeMb.toFixed(1)} MB  sha256 ${msiSha.slice(0, 16)}…`);
  console.log('  installs to C:\\Program Files\\EstateMate Bridge (per-machine, x64)');
  console.log('  Start Menu "EstateMate Bridge" opens the dashboard (a window, no console)');
  console.log('  App Paths + PATH still work for the command line; no service registration (see README.txt)');
  console.log(`Installer kit ready: ${kitPath}`);
  console.log('  double-click Install-EstateMate-Bridge.cmd inside the kit: it verifies the');
  console.log('  download, logs the install, explains a failure, and falls back to a per-user');
  console.log('  install (no administrator rights, no Windows Installer) when the MSI cannot finish');
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

    // Fail here, not in CI after the MSI has been linked: the kit is only
    // complete when all of it is present.
    for (const script of KIT_SCRIPTS) {
      if (!isFile(script.source)) fail(`installer kit file missing: ${script.source}`);
    }
    for (const source of [...DASHBOARD_SOURCES, { source: DASHBOARD_LAUNCHER_SOURCE }, { source: DASHBOARD_BUILD_SCRIPT }]) {
      if (!isFile(source.source)) fail(`dashboard file missing: ${source.source}`);
    }

    // ---- the dashboard the Start Menu shortcut opens ------------------------
    const stagedDashboard = {
      exe: path.join(buildDir, 'EstateMateBridge.exe'),
      script: path.join(buildDir, 'EstateMateBridge.ps1'),
      launcher: path.join(buildDir, 'EstateMateBridge.cmd'),
    };
    for (const source of DASHBOARD_SOURCES) {
      fs.copyFileSync(source.source, stagedDashboard[source.staged]);
    }
    if (flags.dryRun) {
      fs.writeFileSync(stagedDashboard.exe, 'placeholder: build-dashboard.cmd was not run\n', 'utf8');
    } else {
      console.log('Compiling the dashboard launcher (no console window)');
      runCaptured(
        'cmd',
        ['/c', DASHBOARD_BUILD_SCRIPT],
        'build-dashboard.cmd',
        [stagedDashboard.exe],
        { ...process.env, ESTATEMATE_DASHBOARD_OUT: stagedDashboard.exe },
      );
      if (fs.statSync(stagedDashboard.exe).size < 4096) {
        fail(`the compiled dashboard launcher is implausibly small (${fs.statSync(stagedDashboard.exe).size} bytes)`);
      }
      if (fs.readFileSync(stagedDashboard.exe).subarray(0, 2).toString('latin1') !== 'MZ') {
        fail('the compiled dashboard launcher is not a Windows executable (no MZ header)');
      }
    }

    const dashboardInfo = {
      launcher: 'EstateMateBridge.exe',
      launcherSha256: sha256(stagedDashboard.exe),
      script: 'EstateMateBridge.ps1',
      compiled: !flags.dryRun,
    };

    const msiName = `estatemate-bridge-${version}-win-x64.msi`;
    const msiPath = path.join(outDir, msiName);
    const wixobjPath = path.join(buildDir, 'estatemate-bridge.wixobj');

    const candleArgs = [
      '-nologo', '-arch', 'x64',
      `-dVersion=${version}`,
      `-dExeSource=${stagedExe}`,
      `-dReadmeSource=${stagedReadme}`,
      `-dDashboardExeSource=${stagedDashboard.exe}`,
      `-dDashboardScriptSource=${stagedDashboard.script}`,
      `-dDashboardLauncherSource=${stagedDashboard.launcher}`,
      '-out', wixobjPath,
      wxsPath,
    ];
    // ICE43 wants non-advertised shortcuts to have an HKCU keypath; ours are
    // per-machine shortcuts next to a per-machine executable, so that per-user
    // repair nuance does not apply.
    // ICE57 flags the same shortcut components as "per-user data with a
    // per-machine keypath"; at install time (ALLUSERS=1) the Program Menu
    // resolves to the all-users profile and Windows Installer handles it
    // correctly. Both ICEs are heuristic lints for mixed per-user installs,
    // which this deliberately is not. Every other ICE still validates the MSI.
    const lightArgs = ['-nologo', '-sice:ICE43', '-sice:ICE57', wixobjPath, '-out', msiPath];

    if (flags.dryRun) {
      console.log('[dry-run] staged payload:');
      console.log(`  exe    : ${stagedExe} (${fs.statSync(stagedExe).size} bytes)`);
      console.log(`  readme : ${stagedReadme} (${fs.statSync(stagedReadme).size} bytes)`);
      for (const script of KIT_SCRIPTS) {
        console.log(`  kit    : ${script.source} (${fs.statSync(script.source).size} bytes)`);
      }
      for (const source of DASHBOARD_SOURCES) {
        console.log(`  dashboard: ${source.name} (${fs.statSync(source.source).size} bytes)`);
      }
      console.log('\n[dry-run] would run:');
      console.log(`  cmd /c "${DASHBOARD_BUILD_SCRIPT}" "${buildDir}"   # -> EstateMateBridge.exe`);
      console.log(`  candle ${candleArgs.join(' ')}`);
      console.log(`  light  ${lightArgs.join(' ')}`);

      // Assemble the whole output tree against a placeholder MSI, in a
      // throwaway directory: the packaging code (checksums, READ-ME-FIRST, the
      // zip, BUILD-INFO) then gets exercised on every platform instead of only
      // where candle and light exist. What it cannot prove is the MSI itself.
      const dryOut = fs.mkdtempSync(path.join(os.tmpdir(), 'estatemate-bridge-msi-dry-'));
      const placeholder = path.join(dryOut, msiName);
      fs.writeFileSync(placeholder, 'placeholder: candle and light were not run\n', 'utf8');
      const output = writeOutputs({
        outDir: dryOut,
        msiPath: placeholder,
        msiName,
        version,
        commit: flags.commit || null,
        exePath,
        wix: { candle: 'candle.exe (not run)', light: 'light.exe (not run)' },
        dashboard: dashboardInfo,
        dashboardFiles: [stagedDashboard.exe, stagedDashboard.script, stagedDashboard.launcher],
      });
      printSummary({
        ...output,
        msiPath: placeholder,
        msiName,
        quiet: false,
        dryRun: true,
        dryOut,
        outDir,
      });
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

    const output = writeOutputs({
      outDir,
      msiPath,
      msiName,
      version,
      commit: flags.commit || null,
      exePath,
      wix: { candle: path.basename(candle), light: path.basename(light) },
      dashboard: dashboardInfo,
      dashboardFiles: [stagedDashboard.exe, stagedDashboard.script, stagedDashboard.launcher],
    });
    printSummary({ ...output, msiPath, msiName, quiet: flags.quiet });
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
