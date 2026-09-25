#!/usr/bin/env node
/**
 * EstateMate Windows Agent portable bundle packer.
 *
 * Stages a self-contained, offline-installable directory for a Windows host that
 * has no Node.js:
 *
 *   <out>/
 *     runtime/node.exe                     official Node.js Windows x64 runtime
 *     agent.mjs                            windows-agent service wrapper (entrypoint)
 *     agent-core.mjs                       isapi-bridge core agent
 *     install-windows.mjs                  config writer + ACL helper
 *     estatemate-isapi-agent.cmd           launcher used by Task Scheduler / NSSM
 *     install-service.ps1                  registers the agent to run at startup
 *     uninstall-service.ps1
 *     agent-config.example.json
 *     isapi-devices.example.json
 *     VERSION                              bundle version + source commit
 *     README.txt                           on-host instructions
 *
 * Layout note: windows-agent/agent.mjs resolves its core as ../isapi-bridge/agent.mjs
 * and falls back to ./agent-core.mjs. The flat layout below uses that fallback, so
 * the wrapper works unmodified from a single install directory.
 *
 * Usage:
 *   node scripts/package-windows-bundle.mjs --out <dir> [--node-version 22.22.2]
 *                                           [--version <v>] [--commit <sha>]
 *   node scripts/package-windows-bundle.mjs --out <dir> --finalize-runtime
 *
 * This script only stages files; it performs no network access and no
 * platform-specific shell-outs. The CI job downloads and checksum-verifies
 * runtime/node.exe after staging, then re-runs with --finalize-runtime to record
 * its hash in VERSION.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const outArg = argValue('out');
if (!outArg) {
  console.error('Usage: node scripts/package-windows-bundle.mjs --out <dir> [--node-version X] [--version V] [--commit SHA]');
  console.error('       node scripts/package-windows-bundle.mjs --out <dir> --finalize-runtime');
  process.exit(1);
}
const outDir = resolve(outArg);
// This script deletes --out before staging, so refuse to point it at anything
// that could contain the repository.
if (repoRoot === outDir || repoRoot.startsWith(outDir + '/') || outDir === resolve('/')) {
  console.error(`Refusing to use ${outDir} as --out: it contains or is the filesystem/repo root.`);
  process.exit(1);
}
const nodeVersion = String(argValue('node-version', '22.22.2')).replace(/^v/, '');
const bundleVersion = String(argValue('version', '0.0.0-dev'));
const commit = String(argValue('commit', 'unknown'));

/** Write text with CRLF line endings — required for .cmd and conventional for .ps1. */
function writeWindowsText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replace(/\r?\n/g, '\r\n'), 'utf8');
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyRepo(relPath, destRel) {
  const src = join(repoRoot, relPath);
  if (!existsSync(src)) {
    console.error(`Missing required source file: ${relPath}`);
    process.exit(1);
  }
  const dest = join(outDir, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return dest;
}

// ------------------------------------------------------------ node runtime ---

// The runtime itself is fetched by the CI job (native Windows tooling), so this
// script performs no network access and no platform-specific shell-outs and can
// be run and tested anywhere.
//
// Order of operations in CI:
//   1. package-windows-bundle.mjs --out bundle          (stages files, wipes --out)
//   2. download + checksum-verify runtime/node.exe      (done by the workflow)
//   3. package-windows-bundle.mjs --out bundle --finalize-runtime
//      (recomputes node.exe sha256 and rewrites VERSION)
const finalizeRuntime = process.argv.includes('--finalize-runtime');
const runtimeDir = join(outDir, 'runtime');
const nodeExe = join(runtimeDir, 'node.exe');
const versionFile = join(outDir, 'VERSION');

function readVersionMeta() {
  try {
    return JSON.parse(readFileSync(versionFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeVersionMeta(meta) {
  writeText(versionFile, JSON.stringify(meta, null, 2) + '\n');
}

if (finalizeRuntime) {
  mkdirSync(runtimeDir, { recursive: true });
  if (!existsSync(nodeExe)) {
    console.error(`--finalize-runtime: ${nodeExe} does not exist. Download and verify it first.`);
    process.exit(1);
  }
  const sha = sha256File(nodeExe);
  writeVersionMeta({
    ...readVersionMeta(),
    nodeVersion,
    nodeExeStaged: true,
    nodeExeSha256: sha,
    nodeExeBytes: statSync(nodeExe).size,
  });
  console.log(`Finalized runtime: node.exe ${statSync(nodeExe).size} bytes sha256 ${sha}`);
  console.log('Bundle runtime finalized OK');
  process.exit(0);
}

// ---------------------------------------------------------------- staging ---

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`Staging EstateMate Windows agent bundle ${bundleVersion} (${commit}) -> ${outDir}`);

// Core agent + Windows wrapper. The wrapper is the entrypoint; the core is the
// documented ./agent-core.mjs fallback so both live in one flat directory.
copyRepo('isapi-bridge/agent.mjs', 'agent-core.mjs');
copyRepo('windows-agent/agent.mjs', 'agent.mjs');
copyRepo('windows-agent/install-windows.mjs', 'install-windows.mjs');
copyRepo('windows-agent/agent-config.example.json', 'agent-config.example.json');
copyRepo('isapi-bridge/isapi-devices.example.json', 'isapi-devices.example.json');
copyRepo('windows-agent/README.md', 'docs/windows-agent-README.md');
copyRepo('isapi-bridge/README.md', 'docs/isapi-bridge-README.md');


// ------------------------------------------------------------- launcher .cmd ---

// %~dp0 is the bundle directory with a trailing separator. Quoted absolute paths
// mean the launcher works from any working directory (Task Scheduler, NSSM, cmd).
writeWindowsText(
  join(outDir, 'estatemate-isapi-agent.cmd'),
  `@echo off
rem EstateMate ISAPI Bridge Agent launcher (bundled Node.js runtime).
rem Usage: estatemate-isapi-agent.cmd [--config path] [--devices path]
setlocal
set "EMROOT=%~dp0"
set "EMNODE=%EMROOT%runtime\\node.exe"
if not exist "%EMNODE%" set "EMNODE=node"
if not exist "%EMROOT%agent-config.json" (
  echo [ERROR] %EMROOT%agent-config.json not found.
  echo         Run install-service.ps1, or copy agent-config.example.json to
  echo         agent-config.json and fill in agentId / agentSecret / workerUrl.
  exit /b 1
)
if not exist "%EMROOT%isapi-devices.json" (
  echo [ERROR] %EMROOT%isapi-devices.json not found.
  echo         Copy isapi-devices.example.json to isapi-devices.json and edit it.
  exit /b 1
)
"%EMNODE%" "%EMROOT%agent.mjs" --config "%EMROOT%agent-config.json" --devices "%EMROOT%isapi-devices.json" %*
endlocal
`,
);

// --------------------------------------------------------- install-service.ps1 ---

writeWindowsText(
  join(outDir, 'install-service.ps1'),
  `# EstateMate ISAPI Bridge Agent - startup registration
# Run as Administrator:  powershell -ExecutionPolicy Bypass -File .\\install-service.ps1
#
# The bundled agent is a console process, not a Service Control Manager binary, so
# "sc.exe create" against it would fail with error 1053. Two supported options:
#   -Nssm        register a real Windows Service through NSSM (recommended if installed)
#   default      register a Scheduled Task running as SYSTEM at startup (no extras needed)

[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\\EstateMate\\ISAPI-Agent',
  [string]$AgentId,
  [string]$AgentSecret,
  [string]$WorkerUrl = 'https://estatemate.estatemate.workers.dev',
  [string]$NssmPath,
  [switch]$Nssm
)

$ErrorActionPreference = 'Stop'
$taskName = 'EstateMateISAPIAgent'
$bundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Installing EstateMate ISAPI Bridge Agent" -ForegroundColor Cyan
Write-Host "  bundle:    $bundleDir"
Write-Host "  installdir: $InstallDir"

if ($InstallDir -ne $bundleDir) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $bundleDir '*') -Destination $InstallDir -Recurse -Force
  Write-Host "Copied bundle to $InstallDir" -ForegroundColor Green
}

$configPath = Join-Path $InstallDir 'agent-config.json'
if ($AgentId -and $AgentSecret) {
  $config = [ordered]@{
    agentId                  = $AgentId
    agentSecret              = $AgentSecret
    workerUrl                = $WorkerUrl
    syncIntervalSeconds      = 30
    heartbeatIntervalSeconds = 60
    eventStream              = $true
    logLevel                 = 'info'
  }
  ($config | ConvertTo-Json -Depth 4) | Set-Content -Path $configPath -Encoding UTF8
  Write-Host "Wrote $configPath" -ForegroundColor Green
} elseif (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $InstallDir 'agent-config.example.json') $configPath
  Write-Warning "Created $configPath from the example - edit it before starting the agent."
}

$devicesPath = Join-Path $InstallDir 'isapi-devices.json'
if (-not (Test-Path $devicesPath)) {
  Copy-Item (Join-Path $InstallDir 'isapi-devices.example.json') $devicesPath
  Write-Warning "Created $devicesPath from the example - EDIT IT with your device ISAPI details."
}

# Restrict the secret-bearing config to Administrators + SYSTEM.
$acl = Get-Acl $configPath
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl','Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\\SYSTEM','FullControl','Allow')))
Set-Acl -Path $configPath -AclObject $acl
Write-Host "Restricted ACL on $configPath" -ForegroundColor Green

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
$launcher = Join-Path $InstallDir 'estatemate-isapi-agent.cmd'

if ($Nssm) {
  $nssm = if ($NssmPath) { $NssmPath } else { (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source }
  if (-not $nssm) { throw 'NSSM requested but nssm.exe was not found. Install NSSM or re-run without -Nssm.' }
  & $nssm install $taskName "$launcher"
  & $nssm set $taskName AppDirectory $InstallDir
  & $nssm set $taskName Start SERVICE_AUTO_START
  & $nssm set $taskName AppStdout (Join-Path $InstallDir 'logs\\agent.log')
  & $nssm set $taskName AppStderr (Join-Path $InstallDir 'logs\\agent.err.log')
  & $nssm set $taskName AppRotateFiles 1
  & $nssm start $taskName
  Write-Host "Registered Windows Service '$taskName' via NSSM." -ForegroundColor Green
} else {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'EstateMate ISAPI Bridge Agent' | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Registered Scheduled Task '$taskName' running as SYSTEM at startup." -ForegroundColor Green
}

Write-Host @'

Next steps:
1. Edit isapi-devices.json with each device's estateMateDeviceId, isapiHost and ISAPI credentials.
2. Check the agent is talking to the Worker:  Get-Content .\\logs\\agent.log -Tail 50
3. Confirm in the portal: ISAPI Bridge -> the agent should show online with a recent last_seen.

Keep ISAPI devices and this host on the same VLAN. Do not port-forward ISAPI.
'@ -ForegroundColor Cyan
`,
);

// ------------------------------------------------------- uninstall-service.ps1 ---

writeWindowsText(
  join(outDir, 'uninstall-service.ps1'),
  `# EstateMate ISAPI Bridge Agent - remove startup registration
# Run as Administrator:  powershell -ExecutionPolicy Bypass -File .\\uninstall-service.ps1

[CmdletBinding()]
param(
  [string]$Name = 'EstateMateISAPIAgent',
  [switch]$RemoveFiles,
  [string]$InstallDir = 'C:\\EstateMate\\ISAPI-Agent'
)

$ErrorActionPreference = 'SilentlyContinue'

if (Get-Service -Name $Name) {
  Stop-Service -Name $Name
  $nssm = (Get-Command nssm.exe).Source
  if ($nssm) { & $nssm remove $Name confirm } else { sc.exe delete $Name }
  Write-Host "Removed Windows Service '$Name'." -ForegroundColor Green
}

if (Get-ScheduledTask -TaskName $Name) {
  Stop-ScheduledTask -TaskName $Name
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Host "Removed Scheduled Task '$Name'." -ForegroundColor Green
}

if ($RemoveFiles) {
  Remove-Item -Path $InstallDir -Recurse -Force
  Write-Host "Deleted $InstallDir (including agent-config.json and logs)." -ForegroundColor Yellow
} else {
  Write-Host "Left $InstallDir in place. Re-run with -RemoveFiles to delete config and logs." -ForegroundColor Yellow
}
`,
);

// ------------------------------------------------------------- VERSION/README ---

writeVersionMeta({
  bundleVersion,
  commit,
  nodeVersion,
  // The workflow adds and verifies runtime/node.exe after staging, then re-runs
  // this script with --finalize-runtime to record its real hash.
  nodeExeStaged: false,
  nodeExeSha256: null,
  builtAt: new Date().toISOString(),
});

writeWindowsText(
  join(outDir, 'README.txt'),
  `EstateMate ISAPI Bridge Agent - Windows portable bundle
=======================================================

Version: ${bundleVersion}
Commit:  ${commit}
Node:    bundled runtime\\node.exe (v${nodeVersion})
         If runtime\\node.exe is absent, install Node.js 22+ and put it on PATH;
         the launcher falls back to a plain "node" command in that case.

This bundle is self-contained: it ships its own Node.js runtime, so the target
host does not need Node.js installed and does not need Internet access beyond
the EstateMate Worker and your Hikvision devices on the LAN.

Install (Administrator PowerShell, from this directory)
-------------------------------------------------------
    powershell -ExecutionPolicy Bypass -File .\\install-service.ps1 ^
      -AgentId <uuid-from-portal> -AgentSecret <secret-from-portal>

That copies the bundle to C:\\EstateMate\\ISAPI-Agent, writes a restricted
agent-config.json, creates isapi-devices.json from the example, and registers
the agent to start automatically as SYSTEM.

Then edit the device mapping:

    notepad C:\\EstateMate\\ISAPI-Agent\\isapi-devices.json

Fill in estateMateDeviceId (from the portal device list), isapiHost,
isapiUsername and isapiPassword for each Hikvision device.

Run in the foreground (debugging)
---------------------------------
    .\\estatemate-isapi-agent.cmd

Files
-----
    estatemate-isapi-agent.cmd   launcher (uses runtime\\node.exe)
    agent.mjs                    Windows wrapper / entrypoint
    agent-core.mjs               ISAPI bridge core agent
    install-service.ps1          register startup task (or -Nssm for a Service)
    uninstall-service.ps1        remove it
    install-windows.mjs          config writer helper (node install-windows.mjs --help)
    agent-config.example.json    agent identity + Worker URL template
    isapi-devices.example.json   device mapping template
    VERSION                      build metadata and node.exe sha256
    docs\\                       full agent documentation

Why a Scheduled Task and not "sc.exe create"?
---------------------------------------------
The agent is a console process; it does not implement the Service Control
Manager handshake, so sc.exe would report error 1053 (service did not respond).
install-service.ps1 therefore registers a SYSTEM Scheduled Task that starts at
boot and restarts on failure. Pass -Nssm if you prefer a real Windows Service
and have NSSM installed.

Uninstall
---------
    powershell -ExecutionPolicy Bypass -File .\\uninstall-service.ps1 -RemoveFiles

Security
--------
    * agent-config.json holds the agent secret; its ACL is restricted to
      Administrators and SYSTEM by the installer.
    * Keep ISAPI devices and this host on the same VLAN. Never port-forward ISAPI.
    * Rotate the agent secret in the portal periodically.
`,
);

// ------------------------------------------------------------------ summary ---

/** Recursive relative file listing (portable — no shelling out to find/ls). */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const staged = listFiles(outDir).sort();

console.log(`\nStaged ${staged.length} file(s):`);
for (const rel of staged) {
  const size = statSync(join(outDir, rel)).size;
  console.log(`  ${rel} (${size} bytes)`);
}
console.log('\nBundle staged OK');
