#!/usr/bin/env node
// Builds the EstateMate desktop app MSI (client-apps/windows).
//
//   node scripts/package-client-msi.mjs --out artifacts/client --version 0.4.6 \
//        [--url https://estatemate.estatemate.workers.dev/] [--commit <sha>]
//
// Stages the launcher, the portal address and the README, then runs the WiX
// Toolset v3 candle and light. Runs for real only on Windows (CI builds it on
// windows-latest). --dry-run stages everything and prints the WiX commands, so
// the packaging can be checked on Linux.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const appDir = path.join(root, 'client-apps', 'windows');
export const DEFAULT_PORTAL_URL = 'https://estatemate.estatemate.workers.dev/';

const WIX_INSTALL_DIRS = [
  process.env.WIX ? path.join(process.env.WIX, 'bin') : null,
  'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin',
  'C:\\Program Files (x86)\\WiX Toolset v3.11\\bin',
  'C:\\Program Files (x86)\\WiX Toolset v3.10\\bin',
  'C:\\ProgramData\\chocolatey\\bin',
].filter(Boolean);

function fail(message) {
  console.error(`package-client-msi: ${message}`);
  if (process.env.GITHUB_ACTIONS) {
    const escaped = String(message).slice(0, 900).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=package-client-msi::${escaped}`);
  }
  process.exit(1);
}

/** Accepts only a plain https URL with no spaces or quotes (it lands in a VBScript string). */
export function validatePortalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:') throw new Error('the portal address must use https://');
  if (/[\s"'<>]/.test(value)) throw new Error('the portal address must not contain spaces or quotes');
  return url.toString();
}

/** Only a plain x.y.z version: it becomes the MSI ProductVersion. */
export function validateVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`--version must be x.y.z, got "${value}"`);
  return value;
}

export function parseArgs(argv) {
  const flags = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--out') flags.out = next();
    else if (arg === '--version') flags.version = next();
    else if (arg === '--url') flags.url = next();
    else if (arg === '--commit') flags.commit = next();
    else if (arg === '--candle') flags.candle = next();
    else if (arg === '--light') flags.light = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!flags.out) throw new Error('--out is required');
  if (!flags.version) throw new Error('--version is required');
  validateVersion(flags.version);
  flags.url = validatePortalUrl(flags.url ?? DEFAULT_PORTAL_URL);
  return flags;
}

function discoverTool(name, explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const exe = `${name}.exe`;
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (onPath.status === 0) {
    const found = String(onPath.stdout || '')
      .split(/\r?\n/)
      .find((candidate) => candidate && fs.existsSync(candidate.trim()));
    if (found) return found.trim();
  }
  for (const dir of WIX_INSTALL_DIRS) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Writes the staged payload and returns the paths the WiX sources need. */
export function stagePayload(stageDir, { url, commit, version }) {
  fs.mkdirSync(stageDir, { recursive: true });
  const launcher = path.join(stageDir, 'EstateMate.vbs');
  const urlFile = path.join(stageDir, 'estatemate-url.txt');
  const readme = path.join(stageDir, 'README.txt');
  fs.copyFileSync(path.join(appDir, 'EstateMate.vbs'), launcher);
  fs.writeFileSync(urlFile, `${url}\r\n`, 'utf8');
  fs.writeFileSync(
    readme,
    [
      `EstateMate desktop app ${version}`,
      '',
      'Open EstateMate from the Start Menu or the Desktop, then sign in with your portal email and password.',
      `Portal address: ${url}`,
      'The app runs in its own window using Microsoft Edge (or Google Chrome).',
      `Built from commit ${commit || 'unknown'}.`,
      '',
    ].join('\r\n'),
    'utf8',
  );
  return { launcher, urlFile, readme };
}

function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }

  const out = path.resolve(flags.out);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'estatemate-client-msi-'));
  const payload = stagePayload(stage, { url: flags.url, commit: flags.commit, version: flags.version });
  const wxs = path.join(appDir, 'estatemate-client.wxs');
  const obj = path.join(stage, 'estatemate-client.wixobj');
  const msi = path.join(out, `estatemate-client-${flags.version}.msi`);

  const candleArgs = [
    '-arch', 'x86',
    `-dVersion=${flags.version}`,
    `-dLauncherSource=${payload.launcher}`,
    `-dUrlSource=${payload.urlFile}`,
    `-dReadmeSource=${payload.readme}`,
    wxs,
    '-out', obj,
  ];
  const lightArgs = [obj, '-out', msi];

  if (flags.dryRun) {
    fs.mkdirSync(out, { recursive: true });
    console.log(`[dry-run] staged payload in ${stage}`);
    console.log(`  candle ${candleArgs.join(' ')}`);
    console.log(`  light ${lightArgs.join(' ')}`);
    console.log(`[dry-run] portal address: ${flags.url}`);
    return;
  }

  if (process.platform !== 'win32') {
    fail('the MSI is built on Windows with the WiX Toolset v3 (use --dry-run elsewhere)');
  }
  const candle = discoverTool('candle', flags.candle);
  if (!candle) fail('candle.exe not found: install the WiX Toolset v3 or set WIX');
  const light = discoverTool('light', flags.light);
  if (!light) fail('light.exe not found: install the WiX Toolset v3 or set WIX');

  fs.mkdirSync(out, { recursive: true });
  for (const [tool, args] of [[candle, candleArgs], [light, lightArgs]]) {
    const result = spawnSync(tool, args, { encoding: 'utf8' });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (output) process.stdout.write(`${output}\n`);
    if (result.error || result.status !== 0) {
      const diagnostics = output
        .split(/\r?\n/)
        .filter((line) => /error|warning|exception|CNDL|LGHT|ICE/i.test(line))
        .slice(-12);
      const reason = result.error ? result.error.message : `exit code ${result.status}`;
      fail(`${path.basename(tool)} failed (${reason})${diagnostics.length ? `: ${diagnostics.join(' | ')}` : ''}`);
    }
  }
  console.log(`built ${msi}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
