#!/usr/bin/env node
/**
 * Builds the EstateMate bridge executable — a Node.js single executable
 * application (SEA) that needs no Node.js installation on the estate PC.
 *
 *   node scripts/package-bridge-exe.mjs \
 *     --out dist/bridge --target win-x64 --version 0.2.0 --commit <sha> \
 *     --node-version 22.22.2 --download
 *
 * What goes inside: the reviewed `isapi-bridge/agent.mjs` plus the host files in
 * `bridge-apps/windows/host/`, embedded as SEA assets together with a manifest of
 * their SHA-256 hashes. At runtime the entry point unpacks them into a
 * per-version runtime directory and verifies each file against that manifest, so
 * the executable runs the same agent source the repository tests.
 *
 * The SEA blob must be produced by a Node.js build of exactly the version being
 * wrapped (the blob carries a V8 snapshot). This script therefore never uses
 * whatever `node` happens to be on PATH: it takes an explicit blob generator, or
 * downloads a build-host runtime of the same version alongside the target one.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFromTarGz, extractFromZip } from './lib/archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

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

const SEA_RESOURCE = 'NODE_SEA_BLOB';
const DEFAULT_NODE_VERSION = '22.22.2';

const TARGETS = {
  'win-x64': { platform: 'win32', arch: 'x64', nodePlatform: 'win', nodeArch: 'x64', extension: '.exe', archive: 'zip' },
  'win-arm64': { platform: 'win32', arch: 'arm64', nodePlatform: 'win', nodeArch: 'arm64', extension: '.exe', archive: 'zip' },
  'linux-x64': { platform: 'linux', arch: 'x64', nodePlatform: 'linux', nodeArch: 'x64', extension: '', archive: 'tar.xz' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', nodePlatform: 'linux', nodeArch: 'arm64', extension: '', archive: 'tar.xz' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', nodePlatform: 'darwin', nodeArch: 'x64', extension: '', archive: 'tar.gz' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', nodePlatform: 'darwin', nodeArch: 'arm64', extension: '', archive: 'tar.gz' },
};

function usage(exitCode = 0) {
  const text = `Usage: node scripts/package-bridge-exe.mjs --out <dir> --target <target> [options]

Required
  --out <dir>              where the executable, SHA256SUMS.txt and BUILD-INFO.json land
  --target <target>        one of ${Object.keys(TARGETS).join(', ')}

Runtime selection (one of)
  --node-binary <file>     the Node.js binary to wrap (must match --node-version)
  --download               download the official Node.js runtime from nodejs.org
                           for the target and, for blob generation, a build-host
                           runtime of the same version (verified against
                           SHASUMS256.txt)
  --node-from-npm          take the official Node.js binary from the
                           node-<platform>-<arch> npm package, verified against
                           the registry's sha512 integrity value (use this where
                           nodejs.org is unreachable)

Options
  --blob-node <file>       Node.js binary used to generate the SEA blob; must be
                           exactly the same version as the target runtime
  --node-version <v>       version to download (default ${DEFAULT_NODE_VERSION})
  --version <v>            bridge version recorded in build-info.json (default 0.0.0-dev)
  --commit <sha>           commit recorded in build-info.json
  --name <file name>       output file name (default estatemate-bridge-<target><ext>)
  --keep-build-dir         leave the staging directory behind for inspection
  --only-blob              stop after writing sea-prep.blob (debugging)
  --quiet                  only print the summary line
`;
  process.stdout.write(text);
  process.exit(exitCode);
}

const BOOLEAN_FLAGS = new Set(['download', 'node-from-npm', 'keep-build-dir', 'only-blob', 'quiet', 'help']);

function parseArgs(argv) {
  const args = { flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split(/=(.*)/s);
    const takesValue = !BOOLEAN_FLAGS.has(rawName);
    if (!takesValue) {
      args.flags[rawName] = true;
      continue;
    }
    const value = inline !== undefined ? inline : argv[index + 1];
    if (value === undefined) throw new Error(`--${rawName} needs a value`);
    if (inline === undefined) index += 1;
    args.flags[rawName] = value;
  }
  return args.flags;
}

function run(command, args, { cwd = repoRoot, allowFailure = false, capture = true, allowSpawnFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
  if (result.error) {
    if (allowSpawnFailure) return { status: null, stdout: '', stderr: result.error.message, error: result.error };
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  return destination;
}

/** Fetch and verify an official Node.js runtime archive. */
async function fetchNodeRuntime({ version, nodePlatform, nodeArch, archive, cacheDir, shaSums }) {
  const base = `node-v${version}-${nodePlatform}-${nodeArch}`;
  const fileName = `${base}.${archive}`;
  const archivePath = path.join(cacheDir, fileName);
  if (!fs.existsSync(archivePath)) await download(`https://nodejs.org/dist/v${version}/${fileName}`, archivePath);

  const expected = shaSums.get(fileName);
  if (!expected) throw new Error(`${fileName} is not listed in SHASUMS256.txt — refusing an unverified download`);
  const actual = fileSha256(archivePath);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);

  const binaryName = nodePlatform === 'win' ? 'node.exe' : 'node';
  const extractDir = path.join(cacheDir, `${base}.extracted`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  const binary = path.join(extractDir, base, binaryName);
  if (archive === 'zip') {
    // Windows only, and therefore never handed to `tar`: Git Bash's GNU tar reads
    // the drive letter of C:\...\node.zip as a remote host and refuses.
    extractFromZip(archivePath, `${base}/${binaryName}`, binary);
  } else if (archive === 'tar.gz') {
    extractFromTarGz(archivePath, `${base}/${binaryName}`, binary);
  } else {
    // tar.xz has no in-process reader in Node; every target that uses it is a
    // Unix host, where `tar -xJf` is a local path with no colon in it.
    run('tar', ['-xJf', archivePath, '-C', extractDir]);
  }
  if (!fs.existsSync(binary)) throw new Error(`archive ${fileName} did not contain ${binaryName}`);
  return { binary, archivePath, sha256: actual, fileName };
}

/**
 * The npm registry republishes the official Node.js binaries as
 * `node-<platform>-<arch>` packages. Their tarball hash is published as
 * `dist.integrity` (sha512, subresource-integrity format), which this verifies
 * before extracting — the same guarantee as checking SHASUMS256.txt, from a
 * registry that is reachable on networks where nodejs.org is blocked.
 */
async function fetchNodeFromNpm({ version, nodePlatform, nodeArch, cacheDir }) {
  const packageName = `node-${nodePlatform}-${nodeArch}`;
  const metaResponse = await fetch(`https://registry.npmjs.org/${packageName}/${version}`);
  if (!metaResponse.ok) throw new Error(`no npm package ${packageName}@${version} (HTTP ${metaResponse.status})`);
  const meta = await metaResponse.json();
  const integrity = meta?.dist?.integrity;
  const tarballUrl = meta?.dist?.tarball;
  if (!integrity || !tarballUrl) throw new Error(`${packageName}@${version} publishes no dist.integrity/tarball`);

  const archivePath = path.join(cacheDir, `${packageName}-${version}.tgz`);
  if (!fs.existsSync(archivePath)) await download(tarballUrl, archivePath);
  const actual = `sha512-${createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64')}`;
  if (actual !== integrity) throw new Error(`integrity mismatch for ${packageName}@${version}: registry ${integrity}, downloaded ${actual}`);

  const extractDir = path.join(cacheDir, `${packageName}-${version}.extracted`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  const binaryName = nodePlatform === 'win' ? 'node.exe' : 'node';
  const binary = path.join(extractDir, 'package', 'bin', binaryName);
  extractFromTarGz(archivePath, `package/bin/${binaryName}`, binary);
  return { binary, archivePath, sha256: fileSha256(archivePath), fileName: path.basename(archivePath), integrity };
}

const POSTJECT_VERSION = '1.0.0-alpha.6';

/**
 * postject is the tool Node's own documentation uses to inject the SEA blob.
 * Its `dist/api.js` needs no dependencies (only the CLI pulls in commander), so
 * the tarball is fetched once, integrity-checked against the registry's sha512
 * and imported directly. That avoids `npx` entirely: on Windows a .cmd shim
 * cannot be spawned without a shell since Node's 2024 EINVAL hardening, and a
 * build step that only works on two of three platforms is a trap.
 */
/**
 * Remove the Authenticode certificate table from a PE file.
 *
 * Embedding a resource changes the bytes of the executable, so the signature
 * that upstream Node.js ships is invalid the moment the blob goes in — postject
 * says so itself ("The signature seems corrupted!"). Node's own SEA
 * documentation therefore advises removing the signature before injecting and
 * re-signing afterwards. We cannot re-sign without a code-signing certificate,
 * so the honest state to ship is a plainly unsigned binary rather than one that
 * carries a certificate that no longer verifies.
 */
function stripAuthenticodeSignature(pePath) {
  const buffer = fs.readFileSync(pePath);
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return false; // not a PE (MZ)
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 0x18 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return false;
  const optionalHeader = peOffset + 0x18;
  const magic = buffer.readUInt16LE(optionalHeader);
  const directories = optionalHeader + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1);
  if (directories < 0 || directories + 5 * 8 > buffer.length) return false;

  const entry = directories + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const offset = buffer.readUInt32LE(entry);
  const size = buffer.readUInt32LE(entry + 4);
  if (!size) return false;

  buffer.writeUInt32LE(0, entry);
  buffer.writeUInt32LE(0, entry + 4);
  const trailingSignature = offset + size === buffer.length;
  fs.writeFileSync(pePath, trailingSignature ? buffer.subarray(0, offset) : buffer);
  return trailingSignature ? 'removed' : 'detached';
}

async function ensurePostject(cacheDir) {
  const extractDir = path.join(cacheDir, `postject-${POSTJECT_VERSION}.extracted`);
  const apiPath = path.join(extractDir, 'package', 'dist', 'api.js');
  if (fs.existsSync(apiPath)) return apiPath;

  const metaResponse = await fetch(`https://registry.npmjs.org/postject/${POSTJECT_VERSION}`);
  if (!metaResponse.ok) throw new Error(`cannot fetch postject ${POSTJECT_VERSION} from the npm registry (HTTP ${metaResponse.status})`);
  const meta = await metaResponse.json();
  const tarballUrl = meta?.dist?.tarball;
  const integrity = meta?.dist?.integrity;
  if (!tarballUrl) throw new Error(`the npm registry published no tarball for postject ${POSTJECT_VERSION}`);

  const archivePath = path.join(cacheDir, `postject-${POSTJECT_VERSION}.tgz`);
  if (!fs.existsSync(archivePath)) await download(tarballUrl, archivePath);
  if (integrity) {
    const actual = `sha512-${createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64')}`;
    if (actual !== integrity) throw new Error(`integrity mismatch for postject ${POSTJECT_VERSION}: registry ${integrity}, downloaded ${actual}`);
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
  extractFromTarGz(archivePath, 'package/dist/api.js', apiPath);
  if (!fs.existsSync(apiPath)) throw new Error(`postject ${POSTJECT_VERSION} did not contain dist/api.js`);
  return apiPath;
}

async function shaSumsFor(version, cacheDir) {
  const file = path.join(cacheDir, `SHASUMS256-${version}.txt`);
  if (!fs.existsSync(file)) await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, file);
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64})\s+(.+?)\s*$/.exec(line);
    if (match) map.set(match[2], match[1]);
  }
  return map;
}

function collectAssets() {
  const assets = [
    ['agent/agent.mjs', path.join(repoRoot, 'isapi-bridge/agent.mjs')],
    ['host/agent-loader.cjs', path.join(repoRoot, 'bridge-apps/windows/host/agent-loader.cjs')],
    ['host/cli.cjs', path.join(repoRoot, 'bridge-apps/windows/host/cli.cjs')],
    ['host/config.cjs', path.join(repoRoot, 'bridge-apps/windows/host/config.cjs')],
    ['host/diagnostics.cjs', path.join(repoRoot, 'bridge-apps/windows/host/diagnostics.cjs')],
    ['host/logger.cjs', path.join(repoRoot, 'bridge-apps/windows/host/logger.cjs')],
    ['host/service.cjs', path.join(repoRoot, 'bridge-apps/windows/host/service.cjs')],
    ['host/setup.cjs', path.join(repoRoot, 'bridge-apps/windows/host/setup.cjs')],
    ['host/worker.cjs', path.join(repoRoot, 'bridge-apps/windows/host/worker.cjs')],
    ['README.md', path.join(repoRoot, 'bridge-apps/windows/README.md')],
    ['LICENSE', path.join(repoRoot, 'LICENSE')],
  ];
  const missing = assets.filter(([, source]) => !fs.existsSync(source)).map(([, source]) => source);
  if (missing.length) throw new Error(`missing source files:\n  ${missing.join('\n  ')}`);
  return assets.map(([key, source]) => ({ key, source }));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage(0);

  const outDir = flags.out ? path.resolve(flags.out) : null;
  if (!outDir) {
    usage(1);
    throw new Error('--out is required');
  }
  const targetName = flags.target || null;
  if (!targetName || !TARGETS[targetName]) {
    usage(1);
    throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
  }
  const target = TARGETS[targetName];
  const version = flags.version || '0.0.0-dev';
  const commit = flags.commit || process.env.GITHUB_SHA || null;
  const nodeVersion = flags['node-version'] || null;
  const quiet = Boolean(flags.quiet);
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  const cacheDir = path.join(os.tmpdir(), 'estatemate-node-runtime-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  let targetBinary = flags['node-binary'] ? path.resolve(flags['node-binary']) : null;
  let blobNode = flags['blob-node'] ? path.resolve(flags['blob-node']) : null;
  let runtimeMeta = null;

  if (!targetBinary && !flags.download && !flags['node-from-npm']) {
    usage(1);
    throw new Error('one of --node-binary, --download or --node-from-npm is required');
  }
  if (targetBinary && !fs.existsSync(targetBinary)) throw new Error(`--node-binary not found: ${targetBinary}`);

  if (!targetBinary) {
    const wanted = nodeVersion || DEFAULT_NODE_VERSION;
    const fromNpm = Boolean(flags['node-from-npm']);
    const source = fromNpm ? 'the npm registry' : 'nodejs.org';
    log(`Fetching the official Node.js v${wanted} runtime for ${targetName} from ${source} …`);
    const fetched = fromNpm
      ? await fetchNodeFromNpm({ version: wanted, nodePlatform: target.nodePlatform, nodeArch: target.nodeArch, cacheDir })
      : await fetchNodeRuntime({
          version: wanted,
          nodePlatform: target.nodePlatform,
          nodeArch: target.nodeArch,
          archive: target.archive,
          cacheDir,
          shaSums: await shaSumsFor(wanted, cacheDir),
        });
    targetBinary = fetched.binary;
    runtimeMeta = { version: wanted, fileName: fetched.fileName, sha256: fetched.sha256, source: fromNpm ? 'npm' : 'nodejs.org' };

    if (!blobNode) {
      const hostPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
      const hostArch = process.arch;
      if (hostPlatform === target.nodePlatform && hostArch === target.nodeArch) {
        blobNode = targetBinary;
      } else {
        log(`Fetching the same version for the build host (${hostPlatform}-${hostArch}) to generate the SEA blob …`);
        const hostFetched = fromNpm
          ? await fetchNodeFromNpm({ version: wanted, nodePlatform: hostPlatform, nodeArch: hostArch, cacheDir })
          : await fetchNodeRuntime({
              version: wanted,
              nodePlatform: hostPlatform,
              nodeArch: hostArch,
              archive: hostPlatform === 'win' ? 'zip' : hostPlatform === 'darwin' ? 'tar.gz' : 'tar.xz',
              cacheDir,
              shaSums: await shaSumsFor(wanted, cacheDir),
            });
        blobNode = hostFetched.binary;
      }
    }
  }

  if (!blobNode) {
    // No explicit generator: only safe if the local node is the exact version.
    const local = process.version;
    if (runtimeMeta && local === `v${runtimeMeta.version}`) {
      blobNode = process.execPath;
    } else {
      throw new Error(
        `--blob-node is required: the local Node.js is ${local}` +
          (runtimeMeta ? ` but the runtime being wrapped is v${runtimeMeta.version}` : '') +
          '. The SEA blob must come from the same version (pass --blob-node, or use --download).',
      );
    }
  }

  const blobVersion = run(blobNode, ['--version']).stdout.trim();
  // A cross-compiled target cannot be executed here: on Linux `node.exe` is not
  // runnable at all, and the resulting EACCES/ENOEXEC is expected, not a build
  // failure. The version recorded in the build info comes from the runtime we
  // fetched or from the explicit --node-version.
  const targetProbe = run(targetBinary, ['--version'], { allowFailure: true, allowSpawnFailure: true });
  const targetVersion = targetProbe.stdout?.trim() || (target.platform === process.platform ? null : null);
  if (runtimeMeta && blobVersion !== `v${runtimeMeta.version}`) {
    throw new Error(`--blob-node reports ${blobVersion} but the runtime being wrapped is v${runtimeMeta.version}`);
  }
  log(`Runtime:    ${targetBinary}${targetVersion ? ` (${targetVersion})` : ''}`);
  log(`Blob node:  ${blobNode} (${blobVersion})`);

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estatemate-bridge-exe-'));
  fs.mkdirSync(path.join(buildDir, 'assets'), { recursive: true });

  const assets = collectAssets();
  const manifest = [];
  for (const asset of assets) {
    const body = fs.readFileSync(asset.source);
    const dest = path.join(buildDir, 'assets', asset.key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    manifest.push({ path: asset.key, bytes: body.length, sha256: sha256(body) });
  }

  const buildInfo = {
    name: 'estatemate-bridge',
    version,
    commit,
    builtAt: new Date().toISOString(),
    target: targetName,
    targetPlatform: target.platform,
    targetArch: target.arch,
    nodeRuntime: runtimeMeta ? `v${runtimeMeta.version}` : targetVersion || blobVersion,
    nodeRuntimeSource: runtimeMeta ? runtimeMeta.source : 'provided',
    blobNode: blobVersion,
    assets: manifest,
  };
  const buildInfoPath = path.join(buildDir, 'assets', 'build-info.json');
  fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  manifest.push({ path: 'build-info.json', bytes: fs.statSync(buildInfoPath).size, sha256: fileSha256(buildInfoPath) });

  const seaConfigPath = path.join(buildDir, 'sea-config.json');
  const seaConfig = {
    main: path.join(repoRoot, 'bridge-apps/windows/agent-entry.cjs'),
    output: path.join(buildDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: Object.fromEntries(manifest.map((entry) => [entry.path, path.join(buildDir, 'assets', entry.path)])),
  };
  fs.writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`);

  log(`Generating the SEA blob with ${blobVersion} (${manifest.length} embedded files) …`);
  run(blobNode, ['--experimental-sea-config', seaConfigPath], { cwd: buildDir });
  const blobPath = seaConfig.output;
  if (!fs.existsSync(blobPath)) throw new Error('the SEA blob was not produced');
  const blobSize = fs.statSync(blobPath).size;

  if (flags['only-blob']) {
    log(`Blob written to ${blobPath} (${formatBytes(blobSize)}); build directory ${buildDir}`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const exeName = flags.name || `estatemate-bridge-${targetName}${target.extension}`;
  const exePath = path.join(outDir, exeName);
  fs.copyFileSync(targetBinary, exePath);
  if (target.platform === 'win32') {
    const stripped = stripAuthenticodeSignature(exePath);
    if (stripped) {
      log(`Removed the upstream Authenticode signature (${stripped}); the executable is unsigned — publish its SHA-256 with it.`);
    }
  }

  // postject flips the sentinel fuse and appends the resource, exactly as Node's
  // own documentation instructs. Run in-process: the same code the CLI wraps,
  // with no shell and no package-manager shim in the way.
  log('Injecting the blob …');
  const postjectApi = await ensurePostject(cacheDir);
  const { inject } = createRequire(import.meta.url)(postjectApi);
  const injectOptions = { sentinelFuse: SEA_FUSE };
  if (target.platform === 'darwin') injectOptions.machoSegmentName = 'NODE_SEA';
  await inject(exePath, SEA_RESOURCE, fs.readFileSync(blobPath), injectOptions);
  const injected = fs.readFileSync(exePath);
  if (!injected.includes(Buffer.from(SEA_RESOURCE))) throw new Error('the injected executable does not contain the SEA blob resource name');

  const artifactSha = fileSha256(exePath);
  const artifactBytes = fs.statSync(exePath).size;
  const buildInfoOut = {
    ...buildInfo,
    artifact: exeName,
    artifactBytes,
    artifactSha256: artifactSha,
    blobBytes: blobSize,
    blobSha256: fileSha256(blobPath),
  };

  // Verify the artifact natively when it is built for this platform.
  const nativeTarget = target.platform === process.platform && target.arch === process.arch;
  let smoke = { ran: false, reason: 'cross-compiled artifact; run smoke tests on the target platform' };
  if (nativeTarget) {
    const versionCheck = run(exePath, ['--version'], { allowFailure: true });
    if (versionCheck.status !== 0) {
      throw new Error(`the built executable failed to run:\n${versionCheck.stdout || ''}${versionCheck.stderr || ''}`);
    }
    const helpCheck = run(exePath, ['--help'], { allowFailure: true });
    if (helpCheck.status !== 0 || !/EstateMate Bridge/.test(helpCheck.stdout || '')) {
      throw new Error(`the built executable did not print its help text:\n${helpCheck.stdout || ''}${helpCheck.stderr || ''}`);
    }
    smoke = { ran: true, versionOutput: versionCheck.stdout.trim().split('\n')[0], helpOk: true };
  }

  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${artifactSha}  ${exeName}\n`);
  fs.writeFileSync(path.join(outDir, 'BUILD-INFO.json'), `${JSON.stringify(buildInfoOut, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'README.txt'), fs.readFileSync(path.join(repoRoot, 'bridge-apps/windows/README.md'), 'utf8'));

  if (!flags['keep-build-dir']) fs.rmSync(buildDir, { recursive: true, force: true });

  console.log(`${exeName}  ${formatBytes(artifactBytes)}  sha256 ${artifactSha.slice(0, 16)}…  (node ${buildInfo.nodeRuntime}, ${manifest.length} embedded files)`);
  if (smoke.ran) console.log(`  smoke: ${smoke.versionOutput}; --help OK`);
  else console.log(`  smoke: skipped (${smoke.reason})`);
  return 0;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`package-bridge-exe: ${error.message}`);
    annotateError(error);
    process.exit(1);
  });
