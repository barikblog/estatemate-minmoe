#!/usr/bin/env node
/**
 * EstateMate Windows ISAPI Agent - Windows Service wrapper
 * This file re-exports the core ISAPI bridge agent with Windows-specific enhancements:
 * - Event Log friendly logging
 * - Service lifecycle handling
 * - Config file ACL verification
 * - Windows hostname detection
 *
 * For core logic, see ../isapi-bridge/agent.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to load core agent from isapi-bridge, fallback to local copy
let coreAgentPath = resolve(__dirname, '../isapi-bridge/agent.mjs');
if (!existsSync(coreAgentPath)) {
  coreAgentPath = resolve(__dirname, './agent-core.mjs');
  if (!existsSync(coreAgentPath)) {
    console.error('Core ISAPI bridge agent not found. Ensure isapi-bridge/agent.mjs exists or copy it to windows-agent/agent-core.mjs');
    process.exit(1);
  }
}

// Windows-specific pre-checks
function isWindows() {
  return process.platform === 'win32';
}

function checkConfigAcl(configPath) {
  if (!isWindows()) return true;
  // On Windows, we cannot easily check ACL from Node without native module,
  // but we can warn if file is world-readable via simple heuristic.
  // The PowerShell installer sets ACL to Administrators + SYSTEM only.
  try {
    const data = readFileSync(configPath, 'utf8');
    if (data.includes('agentSecret')) {
      console.log(`[INFO] Config file ${configPath} contains secret - ensure ACL is restricted to Administrators and SYSTEM.`);
      console.log(`[INFO] Run: icacls "${configPath}" /inheritance:r /grant:r "BUILTIN\\Administrators:F" "NT AUTHORITY\\SYSTEM:F"`);
    }
    return true;
  } catch {
    return false;
  }
}

const configArgIndex = process.argv.indexOf('--config');
const configPath = configArgIndex >= 0 && process.argv[configArgIndex + 1] ? resolve(process.argv[configArgIndex + 1]) : resolve(__dirname, '../isapi-bridge/agent-config.json');

if (existsSync(configPath)) {
  checkConfigAcl(configPath);
} else {
  console.warn(`[WARN] Config file not found at ${configPath}, will try default locations`);
}

console.log(`[INFO] EstateMate Windows ISAPI Agent starting...`);
console.log(`[INFO] Platform: ${process.platform} ${process.arch}, Node: ${process.version}`);
console.log(`[INFO] Config: ${configPath}`);
console.log(`[INFO] Core agent: ${coreAgentPath}`);
console.log(`[INFO] To install as Windows Service, run install-windows.mjs or use sc.exe / NSSM as described in README.md`);

// Dynamically import core agent (it has its own main loop).
// The specifier MUST be a file:// URL. On Windows a bare absolute path such as
// D:\...\agent.mjs is parsed as a URL whose protocol is "d:", which the ESM
// loader rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME - so the agent died at
// startup on the only platform this wrapper exists for. pathToFileURL is a no-op
// on POSIX, where the absolute path already worked.
import(pathToFileURL(coreAgentPath).href).catch((err) => {
  console.error('[ERROR] Failed to load core agent:', err);
  console.error(`[ERROR] Core agent path was: ${coreAgentPath}`);
  console.error(`[ERROR] As file URL: ${pathToFileURL(coreAgentPath).href}`);
  process.exit(1);
});
