/**
 * Loads the shared ISAPI bridge agent from the runtime directory.
 *
 * `isapi-bridge/agent.mjs` reads its configuration at import time and starts its
 * main loops when imported, unless ESTATEMATE_AGENT_STANDBY is set. Diagnostics
 * commands import it in standby mode; `bridge run` imports it normally so the
 * identical code path the Linux/Windows agents have always used is what runs.
 */
'use strict';

const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

async function loadAgent({ agentEntry, configPath, devicesPath, standby = false, version = null, logger = null }) {
  if (!existsSync(agentEntry)) {
    throw new Error(`Bridge agent sources are missing at ${agentEntry}; reinstall the bridge executable`);
  }
  process.env.AGENT_CONFIG = configPath;
  process.env.DEVICES_FILE = devicesPath;
  // The agent reports this in its heartbeat, so the portal knows which bridge
  // build is behind a terminal without anybody reading a log file.
  if (version) process.env.ESTATEMATE_BRIDGE_VERSION = String(version);
  if (standby) process.env.ESTATEMATE_AGENT_STANDBY = '1';
  else delete process.env.ESTATEMATE_AGENT_STANDBY;

  if (logger) logger.debug(`Loading bridge agent ${agentEntry} (standby: ${standby ? 'yes' : 'no'})`);
  return import(pathToFileURL(agentEntry).href);
}

module.exports = { loadAgent };
