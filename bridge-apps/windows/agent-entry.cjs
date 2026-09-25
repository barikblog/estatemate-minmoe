#!/usr/bin/env node
/**
 * EstateMate Bridge — single-executable entry point.
 *
 * This file is the `main` of the Node.js single executable (SEA) that ships as
 * `estatemate-bridge-win-x64.exe`. It is deliberately tiny and dependency-free:
 * it unpacks the embedded bridge sources next to nothing else, then hands over
 * to `host/cli.cjs`.
 *
 * Why unpack instead of bundling? `isapi-bridge/agent.mjs` is the single
 * implementation of the access-device protocol, and it is ESM. Node's SEA can
 * only `require()` embedded modules, so bundling the agent would mean shipping a
 * transformed copy of the very file the tests and the portal documentation
 * describe. Instead the compiled sources are embedded as assets and written to a
 * per-version runtime directory, so what executes is byte-for-byte the reviewed
 * `agent.mjs` — auditable with a text editor on the estate PC.
 *
 * Only files that came out of the SEA blob are written there, and each one is
 * verified against the SHA-256 recorded at build time, so a tampered runtime
 * directory is repaired on the next start.
 */
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

function seaAsset(key, encoding) {
  // `node:sea` only exists in a SEA build; requiring it lazily keeps this file
  // syntax-checkable (and lintable) with a stock Node.js.
  // eslint-disable-next-line global-require
  return require('node:sea').getAsset(key, encoding);
}

function assetKeys() {
  // eslint-disable-next-line global-require
  const sea = require('node:sea');
  if (typeof sea.getAssetKeys === 'function') return sea.getAssetKeys();
  return JSON.parse(sea.getAsset('build-info.json', 'utf8')).assets.map((a) => a.path);
}

function runtimeRoot(version) {
  const candidates = [];
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.ProgramData || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(base, 'EstateMateBridge', 'runtime', version));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'EstateMateBridge', 'runtime', version));
  } else {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    candidates.push(path.join(base, 'estatemate-bridge', 'runtime', version));
  }
  // Last resort: a temp directory. Never the executable's own directory, which
  // may be a read-only Program Files install or a network share.
  candidates.push(path.join(os.tmpdir(), 'estatemate-bridge', `runtime-${version}`));

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('No writable runtime directory available for the bridge sources');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function unpack(runtimeDir, buildInfo) {
  const expected = new Map((buildInfo.assets || []).map((a) => [a.path, a.sha256]));
  let written = 0;
  for (const key of assetKeys()) {
    const body = Buffer.from(seaAsset(key, 'utf8'));
    const digest = sha256(body);
    const wanted = expected.get(key);
    if (wanted && wanted !== digest) {
      throw new Error(`Embedded asset ${key} does not match the hash recorded at build time`);
    }
    const dest = path.join(runtimeDir, key);
    try {
      if (fs.readFileSync(dest).equals(body)) continue; // already current
    } catch {
      // missing or unreadable: fall through and write it
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    written += 1;
  }
  return written;
}

function readBuildInfo() {
  try {
    // Inside the executable the manifest is an embedded asset, so a stray file
    // next to the .exe can never change the recorded hashes.
    return JSON.parse(seaAsset('build-info.json', 'utf8'));
  } catch {
    // Development mode: plain `node bridge-apps/windows/agent-entry.cjs`.
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
  }
}

async function main() {
  const buildInfo = readBuildInfo();

  const runtimeDir = runtimeRoot(buildInfo.version);
  const unpacked = unpack(runtimeDir, buildInfo);

  const requireFromRuntime = createRequire(pathToFileURL(path.join(runtimeDir, 'estatemate-bridge.cjs')).href);
  const { runCli } = requireFromRuntime('./host/cli.cjs');

  return runCli({
    version: buildInfo.version,
    commit: buildInfo.commit,
    builtAt: buildInfo.builtAt,
    target: buildInfo.target,
    seaRuntime: buildInfo.nodeRuntime || null,
    nodeVersion: process.version,
    exePath: process.execPath,
    runtimeDir,
    unpackedAssets: unpacked,
  });
}

Promise.resolve()
  .then(() => main())
  .then((exitCode) => {
    if (typeof exitCode === 'number') process.exit(exitCode);
  })
  .catch((error) => {
    process.stderr.write(`[FATAL] ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
