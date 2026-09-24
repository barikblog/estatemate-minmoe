#!/usr/bin/env node
/**
 * EstateMate Windows Agent Installer (Node.js version)
 * Alternative to PowerShell installer - creates config and service via sc.exe
 *
 * Usage:
 *   node install-windows.mjs --agentId <uuid> --agentSecret <secret> --workerUrl https://...
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase()] || fallback;
}

const agentId = arg('agentId') || arg('agent-id');
const agentSecret = arg('agentSecret') || arg('agent-secret');
const workerUrl = arg('workerUrl', 'https://estatemate.barikblog.workers.dev');
const installDir = arg('installDir', 'C:\\EstateMate\\ISAPI-Agent');

if (!agentId || !agentSecret) {
  console.error('Usage: node install-windows.mjs --agentId <uuid> --agentSecret <secret> [--workerUrl https://...] [--installDir C:\\EstateMate\\ISAPI-Agent]');
  process.exit(1);
}

console.log(`Installing EstateMate Windows ISAPI Agent to ${installDir}`);
console.log(`Agent ID: ${agentId}`);
console.log(`Worker URL: ${workerUrl}`);

mkdirSync(installDir, { recursive: true });

const configPath = resolve(installDir, 'agent-config.json');
const config = {
  agentId,
  agentSecret,
  workerUrl,
  syncIntervalSeconds: 30,
  heartbeatIntervalSeconds: 60,
  logLevel: 'info',
};

writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
console.log(`Config written to ${configPath}`);

if (process.platform === 'win32') {
  try {
    console.log('Setting restrictive ACL (Administrators + SYSTEM only)...');
    execSync(`icacls "${configPath}" /inheritance:r /grant:r "BUILTIN\\Administrators:F" "NT AUTHORITY\\SYSTEM:F"`, { stdio: 'inherit' });
    console.log('ACL set');
  } catch (err) {
    console.warn('Failed to set ACL, please set manually:', err.message);
  }

  const devicesPath = resolve(installDir, 'isapi-devices.json');
  if (!existsSync(devicesPath)) {
    const example = {
      devices: [
        {
          estateMateDeviceId: 'REPLACE_WITH_DEVICE_UUID_FROM_PORTAL',
          name: 'Main Gate',
          isapiHost: '192.168.1.100',
          isapiPort: 80,
          isapiUsername: 'admin',
          isapiPassword: 'device-password',
          protocol: 'http',
        },
      ],
    };
    writeFileSync(devicesPath, JSON.stringify(example, null, 2), 'utf8');
    console.log(`Example devices file created at ${devicesPath} - EDIT IT!`);
  }

  console.log(`
Next steps:
1. Edit ${devicesPath} with your Hikvision device ISAPI details.
2. Ensure Node.js 22+ is installed: https://nodejs.org
3. Copy agent.mjs and ../isapi-bridge/agent.mjs to ${installDir}
4. Install service:
   sc.exe create EstateMateISAPIAgent binPath= "\\"${process.execPath}\\" \\"${installDir}\\agent.mjs\\" --config \\"${configPath}\\"" start= auto
   sc.exe description EstateMateISAPIAgent "EstateMate ISAPI Bridge - Syncs access cards via ISAPI"
   sc.exe start EstateMateISAPIAgent
5. Check logs and portal for online status.
`);
} else {
  console.log(`Non-Windows platform detected (${process.platform}), skipping ACL and service installation.`);
  console.log(`Config at ${configPath}, edit isapi-devices.json and run: node agent.mjs --config ${configPath}`);
}
