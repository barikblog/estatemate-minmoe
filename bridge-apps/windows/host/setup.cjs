/**
 * `bridge setup` and `bridge init` — getting a working configuration onto the
 * estate PC without asking a technician to hand-edit JSON.
 *
 * Three routes in, all producing the same two files the Node agent reads:
 *   * `--from-installer <file|->`  the script the portal's "Download setup"
 *     button produced (PowerShell or shell) — contains agentId, agentSecret and
 *     workerUrl, so nothing secret has to be retyped. `bridge setup` asks for the
 *     file path interactively, and reads it from stdin with `-` so a technician
 *     can pipe it in:  Get-Content installer.ps1 | .\estatemate-bridge.exe setup --from-installer -
 *   * `--devices-json <file>`      a prepared device list.
 *   * interactive prompts          for everything else.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { loadAgent } = require('./agent-loader.cjs');
const {
  DEFAULT_WORKER_URL,
  exampleAgentConfig,
  exampleDevices,
  isUuid,
  parseInstallerScript,
  validateAgentConfig,
  validateDevicesConfig,
  writeJsonRestricted,
} = require('./config.cjs');
const { listLinkedDevices } = require('./worker.cjs');

function createPrompter(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });

  const ask = (question, { defaultValue = '', validate = null } = {}) =>
    new Promise((resolve) => {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      rl.question(`${question}${suffix}: `, (answer) => {
        const value = String(answer || '').trim() || defaultValue;
        const problem = validate ? validate(value) : null;
        if (problem) {
          output.write(`  ${problem}\n`);
          resolve(ask(question, { defaultValue, validate }));
          return;
        }
        resolve(value);
      });
    });

  /**
   * Masked entry for the agent secret. Raw-mode echo suppression only works on a
   * real terminal; when stdin is a pipe (automation) the answer simply is not
   * echoed anywhere, which is already the case.
   */
  const askMasked = (question) =>
    new Promise((resolve) => {
      const stdin = process.stdin;
      if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
        resolve(ask(question));
        return;
      }
      output.write(`${question}: `);
      let value = '';
      const onData = (chunk) => {
        for (const char of String(chunk)) {
          if (char === '\r' || char === '\n') {
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            output.write('\n');
            resolve(value);
            return;
          }
          if (char === '\u0003') process.exit(130);
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          value += char;
        }
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    });

  const confirm = (question, defaultValue = true) =>
    new Promise((resolve) => {
      rl.question(`${question} [${defaultValue ? 'Y/n' : 'y/N'}]: `, (answer) => {
        const text = String(answer || '').trim().toLowerCase();
        if (!text) resolve(defaultValue);
        else resolve(text === 'y' || text === 'yes');
      });
    });

  return {
    ask,
    askMasked,
    confirm,
    close: () => rl.close(),
    /** True when answers are being typed by a person rather than piped in. */
    interactive: Boolean(input.isTTY),
  };
}

function readInstallerSource(source) {
  if (!source) return null;
  if (source === '-') return fs.readFileSync(0, 'utf8');
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`installer script not found: ${resolved}`);
  if (fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} is a directory, not the installer script`);
  return fs.readFileSync(resolved, 'utf8');
}

async function promptForDevice(prompter, logger) {
  logger.raw('');
  logger.raw('  Adding a Hikvision terminal.');
  logger.raw('  The EstateMate device id comes from the portal: Access-control devices → device row → id.');
  logger.raw('');
  const estateMateDeviceId = await prompter.ask('  EstateMate device id (UUID, blank to stop)', {
    validate: (value) => (value && !isUuid(value) ? `"${value}" is not a UUID` : null),
  });
  if (!estateMateDeviceId) return null;
  const name = await prompter.ask('  Friendly name', { defaultValue: 'Access terminal' });
  const isapiHost = await prompter.ask('  ISAPI host (LAN IP of the terminal)', {
    validate: (value) => (value ? null : 'the terminal LAN address is required'),
  });
  const isapiPort = Number(
    await prompter.ask('  ISAPI port', {
      defaultValue: '80',
      validate: (value) => (/^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536 ? null : 'enter a TCP port'),
    }),
  );
  const isapiUsername = await prompter.ask('  ISAPI username', { defaultValue: 'admin' });
  const isapiPassword = await prompter.ask('  ISAPI password');
  const protocol = await prompter.ask('  Protocol (http/https)', {
    defaultValue: 'http',
    validate: (value) => (['http', 'https'].includes(value.toLowerCase()) ? null : 'http or https'),
  });
  const eventStream = await prompter.confirm('  Stream gate events from this terminal in real time?', true);
  return {
    estateMateDeviceId,
    name,
    isapiHost,
    isapiPort,
    isapiUsername,
    isapiPassword,
    protocol: protocol.toLowerCase(),
    enabled: true,
    eventStream,
  };
}

/** Optional, but the fastest way to find a wrong password while still on site. */
async function testDevice(entry, ctx, logger) {
  try {
    const agent = await loadAgent({
      agentEntry: ctx.agentEntry,
      configPath: ctx.paths.configPath,
      devicesPath: ctx.paths.devicesPath,
      standby: true,
      logger,
    });
    const device = {
      estateMateDeviceId: entry.estateMateDeviceId,
      name: entry.name,
      isapiHost: entry.isapiHost,
      isapiPort: Number(entry.isapiPort || 80),
      isapiUsername: entry.isapiUsername || 'admin',
      isapiPassword: entry.isapiPassword || '',
      protocol: entry.protocol === 'https' ? 'https' : 'http',
    };
    const info = await agent.isapiRequest(device, 'GET', '/ISAPI/System/deviceInfo?format=json', null, false);
    if (info.status >= 200 && info.status < 300) {
      const model =
        /<model>([^<]*)<\/model>/i.exec(info.body || '')?.[1] ||
        /"model"\s*:\s*"([^"]+)"/i.exec(info.body || '')?.[1] ||
        'unknown model';
      logger.raw(`  reachable: HTTP ${info.status} — ${model}`);
      return true;
    }
    logger.raw(`  NOT reachable: HTTP ${info.status} ${String(info.body || '').slice(0, 160).trim()}`);
    return false;
  } catch (error) {
    logger.raw(`  NOT reachable: ${(error && error.message) || error}`);
    return false;
  }
}

async function acquireIdentity({ ctx, logger, options, prompter }) {
  let installerText = null;
  if (options.fromInstaller) {
    installerText = readInstallerSource(options.fromInstaller);
    logger.info(`Read installer script ${options.fromInstaller === '-' ? 'from stdin' : options.fromInstaller}`);
  } else if (prompter) {
    logger.raw('');
    logger.raw('EstateMate Bridge setup');
    logger.raw('----------------------');
    logger.raw('The portal generates the agent id and secret: Device agent →');
    logger.raw('Add agent → Download setup. Point this wizard at that file to avoid');
    logger.raw('retyping the secret.');
    logger.raw('');
    const installerPath = (await prompter.ask('  Installer script path (blank to type the values by hand)')) || '';
    if (installerPath) installerText = readInstallerSource(installerPath);
  }

  if (installerText) {
    const parsed = parseInstallerScript(installerText);
    if (!parsed.ok) {
      logger.error(`Installer script rejected: ${parsed.reason}`);
      return null;
    }
    logger.info(`Installer script accepted: agent ${parsed.agentId}${parsed.workerUrl ? `, worker ${parsed.workerUrl}` : ''}`);
    return parsed;
  }

  if (!prompter) {
    logger.error('No installer script supplied and prompts are unavailable. Pass --from-installer <file|-> and --devices-json <file>.');
    return null;
  }

  const workerUrl = await prompter.ask('Worker URL', { defaultValue: DEFAULT_WORKER_URL });
  const agentId = await prompter.ask('Agent id (UUID shown when the agent was registered)', {
    validate: (value) => (isUuid(value) ? null : `"${value}" is not a UUID`),
  });
  const agentSecret = await prompter.askMasked('Agent secret (shown once by the portal)');
  if (String(agentSecret).length < 16) {
    logger.error('The agent secret is at least 16 characters long. Setup aborted.');
    return null;
  }
  return { agentId, agentSecret, workerUrl, installerKey: null };
}

async function runSetup({ ctx, logger, options }) {
  const { paths, version } = ctx;
  const usePrompts = options.prompt !== false;
  const prompter = usePrompts ? createPrompter() : null;

  try {
    const identity = await acquireIdentity({ ctx, logger, options, prompter });
    if (!identity) return 2;

    const workerUrl = String(identity.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
    const config = {
      agentId: identity.agentId,
      agentSecret: identity.agentSecret,
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
    if (identity.installerKey) config.installerKey = identity.installerKey;

    const configValidation = validateAgentConfig(config);
    if (configValidation.errors.length) {
      for (const error of configValidation.errors) logger.error(error);
      return 2;
    }

    // Write the config before the device loop: if the technician stops half way,
    // the secret is already on disk and the bridge can run with the terminals
    // they had time to add.
    const configHardening = writeJsonRestricted(paths.configPath, config);
    logger.info(`Wrote ${paths.configPath} (${configHardening.ok ? configHardening.detail : `permission hardening failed: ${configHardening.detail}`})`);

    if (options.verify !== false) {
      const probe = await listLinkedDevices({ workerUrl, agentId: config.agentId, agentSecret: config.agentSecret });
      if (probe.status === 200) {
        const count = Array.isArray(probe.json?.items) ? probe.json.items.length : 0;
        logger.info(`The Worker accepted the agent secret (HTTP 200, ${count} device(s) already linked to it)`);
      } else if (probe.networkError) {
        logger.warn(`Could not reach the Worker (${probe.text}). Setup continues; run "check" again once the site has Internet.`);
      } else if (probe.status === 401) {
        logger.warn('The Worker rejected the agent secret (HTTP 401). If the secret was rotated, download a fresh installer and run setup again.');
      } else {
        logger.warn(`Worker check returned HTTP ${probe.status}: ${String(probe.json?.error || probe.text || '').slice(0, 200)}`);
      }
    }

    let devicesFile;
    if (options.devicesJson) {
      const raw = options.devicesJson === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(options.devicesJson), 'utf8');
      devicesFile = JSON.parse(raw);
      const validation = validateDevicesConfig(devicesFile);
      for (const warning of validation.warnings) logger.warn(warning);
      if (validation.errors.length) {
        for (const error of validation.errors) logger.error(error);
        return 2;
      }
    } else {
      devicesFile = { devices: [] };
      if (prompter) {
        let more = await prompter.confirm('Add a Hikvision terminal now?', true);
        while (more) {
          // eslint-disable-next-line no-await-in-loop -- one terminal at a time on purpose
          const device = await promptForDevice(prompter, logger);
          if (!device) break;
          // eslint-disable-next-line no-await-in-loop -- sequential probe
          if (await prompter.confirm('  Test this terminal from this PC now?', true)) await testDevice(device, ctx, logger);
          devicesFile.devices.push(device);
          // eslint-disable-next-line no-await-in-loop -- prompt loop
          more = await prompter.confirm('Add another terminal?', false);
        }
      } else {
        logger.warn('Prompts are disabled: isapi-devices.json was written empty. Add terminals with --devices-json or edit the file.');
      }
    }

    const devicesHardening = writeJsonRestricted(paths.devicesPath, devicesFile);
    logger.info(`Wrote ${paths.devicesPath} with ${devicesFile.devices.length} device(s)${devicesHardening.ok ? ` (${devicesHardening.detail})` : ''}`);

    const validation = validateDevicesConfig(devicesFile);
    for (const warning of validation.warnings) logger.warn(warning);

    const exe = path.basename(ctx.exePath);
    logger.raw('');
    logger.raw(`Setup complete (bridge ${version}).`);
    logger.raw('');
    logger.raw('Next steps:');
    logger.raw(`  1. Verify:    "${exe}" check`);
    logger.raw(`  2. Run:       "${exe}" run`);
    logger.raw(`  3. Always on: "${exe}" install-service    (from an Administrator shell)`);
    logger.raw(`  Log file:     ${logger.filePath || '(console only)'}`);
    logger.raw('');
    return 0;
  } finally {
    prompter?.close();
  }
}

function runInit({ ctx, logger, options }) {
  const { paths } = ctx;
  const created = [];
  const skipped = [];

  const write = (file, value, label) => {
    if (fs.existsSync(file) && !options.force) {
      skipped.push(`${file} (already exists — pass --force to overwrite)`);
      return;
    }
    const result = writeJsonRestricted(file, value);
    created.push(`${file} (${result.ok ? result.detail : 'permissions unchanged'}) — ${label}`);
  };

  write(paths.configPath, ctx.config && ctx.config.agentId ? ctx.config : exampleAgentConfig(), 'config');
  write(paths.devicesPath, ctx.devicesFile && Array.isArray(ctx.devicesFile.devices) ? ctx.devicesFile : exampleDevices(), 'device list');

  for (const line of created) logger.raw(`  created  ${line}`);
  for (const line of skipped) logger.raw(`  kept     ${line}`);
  logger.raw('');
  if (!created.length) {
    logger.raw('Nothing written. Edit the existing files, or re-run with --force to replace them with templates.');
  } else {
    logger.raw(`Edit both files (or run "${path.basename(ctx.exePath)} setup"), then: "${path.basename(ctx.exePath)} check"`);
  }
  return 0;
}

module.exports = { createPrompter, runInit, runSetup };
