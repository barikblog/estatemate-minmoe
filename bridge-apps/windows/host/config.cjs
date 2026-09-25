/**
 * Configuration discovery, validation and file hardening for the bridge
 * executable.
 *
 * The bridge reads exactly the same two files the Node agent reads, so a
 * configuration created by the portal's PowerShell installer, by `bridge setup`
 * or by hand in Notepad all work identically:
 *
 *   agent-config.json    agentId, agentSecret, workerUrl, intervals, logLevel
 *   isapi-devices.json   the Hikvision terminals this host can reach on the LAN
 *
 * Search order (first existing file wins; the last entry is where a new file is
 * created):
 *
 *   1. `--config` / `--devices` on the command line
 *   2. $ESTATEMATE_CONFIG / $AGENT_CONFIG / $CONFIG  (devices: $ESTATEMATE_DEVICES / $DEVICES_FILE)
 *   3. the platform data directory  (%ProgramData%\EstateMate, /etc/estatemate,
 *      ~/Library/Application Support/EstateMate)
 *   4. next to the executable (portable installs on a USB stick or C:\Tools)
 *   5. the platform data directory again, as the creation target
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_WORKER_URL = 'https://estatemate.estatemate.workers.dev';
const CONFIG_FILE_NAME = 'agent-config.json';
const DEVICES_FILE_NAME = 'isapi-devices.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isWindows() {
  return process.platform === 'win32';
}

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return null;
}

function platformDataDir(env = process.env) {
  if (isWindows()) {
    const base = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(base, 'EstateMate');
  }
  if (process.platform === 'darwin') {
    return path.join('/Library', 'Application Support', 'EstateMate');
  }
  return path.join('/etc', 'estatemate');
}

function userFallbackDir(env = process.env) {
  const home = env.HOME || os.homedir();
  if (isWindows()) {
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'EstateMate');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'EstateMate');
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'estatemate');
}

function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the directory the bridge stores configuration in. Falls back to the
 * per-user directory and finally to the executable's own folder, so an operator
 * who is not an administrator can still run the bridge from a folder they own.
 */
function resolveDataDir({ exePath, env = process.env, explicitDir = null }) {
  const candidates = [];
  if (explicitDir) candidates.push(path.resolve(explicitDir));
  if (env.ESTATEMATE_DATA_DIR) candidates.push(path.resolve(env.ESTATEMATE_DATA_DIR));
  candidates.push(platformDataDir(env));
  candidates.push(userFallbackDir(env));
  candidates.push(path.dirname(exePath));

  for (const candidate of candidates) {
    if (isDirWritable(candidate)) return { dir: candidate, writable: true };
  }
  const temp = path.join(os.tmpdir(), 'estatemate');
  fs.mkdirSync(temp, { recursive: true });
  return { dir: temp, writable: true };
}

function pickFile({ explicit, envNames, fileName, dataDir, exeDir, env }) {
  if (explicit) return { path: path.resolve(explicit), source: 'argument' };
  const fromEnv = firstEnv(env, envNames);
  if (fromEnv) return { path: path.resolve(fromEnv), source: 'environment' };
  const inDataDir = path.join(dataDir, fileName);
  if (fs.existsSync(inDataDir)) return { path: inDataDir, source: 'data-directory' };
  const besideExe = path.join(exeDir, fileName);
  if (fs.existsSync(besideExe)) return { path: besideExe, source: 'executable-directory' };
  return { path: inDataDir, source: 'data-directory (new file)' };
}

function resolvePaths({ exePath, env = process.env, config = null, devices = null, dataDir = null }) {
  const exeDir = path.dirname(path.resolve(exePath));
  const resolvedDataDir = resolveDataDir({ exePath, env, explicitDir: dataDir });
  const configPick = pickFile({
    explicit: config,
    envNames: ['ESTATEMATE_CONFIG', 'AGENT_CONFIG', 'CONFIG'],
    fileName: CONFIG_FILE_NAME,
    dataDir: resolvedDataDir.dir,
    exeDir,
    env,
  });
  const devicesPick = pickFile({
    explicit: devices,
    envNames: ['ESTATEMATE_DEVICES', 'DEVICES_FILE'],
    fileName: DEVICES_FILE_NAME,
    dataDir: resolvedDataDir.dir,
    exeDir,
    env,
  });

  const logDir = isDirWritable(path.join(resolvedDataDir.dir, 'logs'))
    ? path.join(resolvedDataDir.dir, 'logs')
    : path.join(os.tmpdir(), 'estatemate-logs');

  return {
    exePath: path.resolve(exePath),
    exeDir,
    dataDir: resolvedDataDir.dir,
    logDir,
    configPath: configPick.path,
    configSource: configPick.source,
    devicesPath: devicesPick.path,
    devicesSource: devicesPick.source,
  };
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function writeJsonRestricted(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return hardenFilePermissions(file);
}

/**
 * The config file holds the agent secret. On Windows restrict it to
 * Administrators + SYSTEM (the ACL the portal's PowerShell installer applies);
 * elsewhere 0600.
 */
function hardenFilePermissions(file) {
  if (!isWindows()) {
    try {
      fs.chmodSync(file, 0o600);
      return { ok: true, detail: 'chmod 0600' };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }
  const result = spawnSync(
    'icacls',
    [file, '/inheritance:r', '/grant:r', 'BUILTIN\\Administrators:F', 'NT AUTHORITY\\SYSTEM:F'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: (result.stderr || result.stdout || '').trim() || `icacls exited ${result.status}` };
  return { ok: true, detail: 'icacls restricted to Administrators + SYSTEM' };
}

function maskSecret(secret) {
  const text = String(secret || '');
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}…${text.slice(-4)} (${text.length} chars)`;
}

function exampleAgentConfig({ workerUrl = DEFAULT_WORKER_URL } = {}) {
  return {
    agentId: '00000000-0000-4000-a000-000000000000',
    agentSecret: 'replace-with-agent-secret-from-portal',
    workerUrl,
    syncIntervalSeconds: 30,
    heartbeatIntervalSeconds: 60,
    eventStream: true,
    eventFlushCount: 25,
    eventFlushSeconds: 5,
    eventBufferLimit: 500,
    logLevel: 'info',
    isapiTimeoutMs: 15000,
  };
}

function exampleDevices() {
  return {
    devices: [
      {
        estateMateDeviceId: '11111111-1111-4111-8111-111111111111',
        name: 'Main Gate MinMoe',
        isapiHost: '192.168.1.100',
        isapiPort: 80,
        isapiUsername: 'admin',
        isapiPassword: 'device-admin-password',
        protocol: 'http',
        enabled: true,
        eventStream: true,
      },
    ],
  };
}

function validateAgentConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== 'object') {
    errors.push('agent-config.json must contain a JSON object');
    return { errors, warnings };
  }
  const agentId = String(config.agentId || '').trim();
  if (!agentId) errors.push('agentId is missing — register the bridge in the portal (ISAPI Bridge & Windows Agent → Register agent)');
  else if (!isUuid(agentId)) errors.push(`agentId "${agentId}" is not a UUID`);

  const secret = String(config.agentSecret || '').trim();
  if (!secret) errors.push('agentSecret is missing — download the installer or rotate the secret in the portal');
  else if (secret.length < 16) errors.push('agentSecret is shorter than 16 characters; the portal never issues secrets that short');
  else if (/^replace-with/i.test(secret)) errors.push('agentSecret is still the example placeholder');

  const workerUrl = String(config.workerUrl || '').trim();
  if (!workerUrl) warnings.push(`workerUrl is missing; the agent will fall back to ${DEFAULT_WORKER_URL}`);
  else {
    let parsed = null;
    try {
      parsed = new URL(workerUrl);
    } catch {
      errors.push(`workerUrl "${workerUrl}" is not a valid URL`);
    }
    if (parsed && parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) {
      warnings.push(`workerUrl uses ${parsed.protocol}// — the Worker should be reached over HTTPS outside the local machine`);
    }
  }

  if (config.eventStream === false) warnings.push('eventStream is disabled: gate activity will not appear in real time');
  const sync = Number(config.syncIntervalSeconds ?? 30);
  if (!Number.isFinite(sync) || sync < 5) warnings.push('syncIntervalSeconds below 5s is raised to 5s by the agent');
  const heartbeat = Number(config.heartbeatIntervalSeconds ?? 60);
  if (!Number.isFinite(heartbeat) || heartbeat < 15) warnings.push('heartbeatIntervalSeconds below 15s is raised to 15s by the agent');
  if (config.logLevel && !['debug', 'info', 'warn', 'error'].includes(String(config.logLevel))) {
    warnings.push(`logLevel "${config.logLevel}" is not one of debug|info|warn|error; the agent falls back to info`);
  }
  return { errors, warnings };
}

function validateDevicesConfig(devicesFile) {
  const errors = [];
  const warnings = [];
  const devices = [];
  if (!devicesFile || typeof devicesFile !== 'object' || !Array.isArray(devicesFile.devices)) {
    errors.push('isapi-devices.json must be an object with a "devices" array');
    return { errors, warnings, devices };
  }
  if (!devicesFile.devices.length) warnings.push('isapi-devices.json lists no devices: events cannot stream and queued operations cannot be applied');

  const seen = new Set();
  devicesFile.devices.forEach((entry, index) => {
    const label = `devices[${index}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label} is not an object`);
      return;
    }
    const id = String(entry.estateMateDeviceId || '').trim();
    const host = String(entry.isapiHost || '').trim();
    // The EstateMate device id is optional: it is a UUID that lives in the
    // portal, so a terminal may be configured by LAN address alone and the
    // agent looks the id up from its own linked devices at startup. A malformed
    // one is dropped rather than fatal for the same reason — the portal match
    // is authoritative, and it is reported by `check`.
    if (id && !isUuid(id)) warnings.push(`${label} estateMateDeviceId "${id}" is not a UUID and will be replaced by the portal match at startup`);
    if (!id) warnings.push(`${label} (${entry.name || host || 'unnamed'}) has no estateMateDeviceId; it is resolved from the portal by LAN address at startup`);
    if (!host) errors.push(`${label} (${id || 'unnamed'}) has no isapiHost`);
    if (id && seen.has(id)) warnings.push(`${label} repeats estateMateDeviceId ${id}; the later entry wins`);
    if (id) seen.add(id);
    const port = Number(entry.isapiPort ?? 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${label} isapiPort "${entry.isapiPort}" is not a valid TCP port`);
    if (!String(entry.isapiUsername || '').trim()) warnings.push(`${label} has no isapiUsername; the device default is usually admin`);
    if (!String(entry.isapiPassword || '')) warnings.push(`${label} has no isapiPassword; ISAPI authentication will fail`);
    if (entry.protocol && !['http', 'https'].includes(String(entry.protocol))) errors.push(`${label} protocol "${entry.protocol}" must be http or https`);
    if (entry.enabled === false) warnings.push(`${label} (${entry.name || host}) is disabled and will be skipped`);
  });

  return { errors, warnings, devices: devicesFile.devices };
}

/**
 * The portal's "Download installer" button produces a PowerShell (or shell)
 * script that already contains agentId, agentSecret and workerUrl. Estate
 * technicians have that file in hand, so `bridge setup` accepts its text
 * directly and never makes them retype a 32-character secret.
 */
function parseInstallerScript(text) {
  const body = String(text || '');
  const grab = (patterns) => {
    for (const pattern of patterns) {
      const match = pattern.exec(body);
      if (match && match[1]) return match[1].trim();
    }
    return null;
  };
  const agentId = grab([
    /^\s*\$agentId\s*=\s*"([^"]+)"/im,
    /^\s*AGENT_ID\s*=\s*"([^"]+)"/im,
    /^\s*agentId\s*[:=]\s*"([^"]+)"/im,
  ]);
  const agentSecret = grab([
    /^\s*\$agentSecret\s*=\s*"([^"]+)"/im,
    /^\s*AGENT_SECRET\s*=\s*"([^"]+)"/im,
    /^\s*agentSecret\s*[:=]\s*"([^"]+)"/im,
  ]);
  const installerKey = grab([
    /^\s*\$installerKey\s*=\s*"([^"]+)"/im,
    /^\s*INSTALLER_KEY\s*=\s*"([^"]+)"/im,
  ]);
  const workerUrl = grab([
    /^\s*\$workerUrl\s*=\s*"([^"]+)"/im,
    /^\s*WORKER_URL\s*=\s*"([^"]+)"/im,
    /^\s*workerUrl\s*[:=]\s*"([^"]+)"/im,
  ]);
  if (!agentId && !agentSecret) {
    return { ok: false, reason: 'no agentId/agentSecret found — paste the file the portal generated with "Download installer"' };
  }
  if (!agentSecret) return { ok: false, reason: 'the installer text contains no agentSecret — the portal secret is shown only once, so generate a fresh installer' };
  return { ok: true, agentId, agentSecret, installerKey, workerUrl };
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_WORKER_URL,
  DEVICES_FILE_NAME,
  exampleAgentConfig,
  exampleDevices,
  hardenFilePermissions,
  isUuid,
  maskSecret,
  parseInstallerScript,
  platformDataDir,
  readJson,
  resolvePaths,
  userFallbackDir,
  validateAgentConfig,
  validateDevicesConfig,
  writeJsonRestricted,
};
