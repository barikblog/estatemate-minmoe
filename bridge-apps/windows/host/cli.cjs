/**
 * Command line surface of the EstateMate bridge executable.
 *
 *   estatemate-bridge.exe run                start the bridge (default)
 *   estatemate-bridge.exe check              configuration + Worker + device pre-flight
 *   estatemate-bridge.exe setup              write the config from the portal installer
 *   estatemate-bridge.exe init               write example config files
 *   estatemate-bridge.exe status             paths, service state, recent log lines
 *   estatemate-bridge.exe install-service    always-on: Scheduled Task / systemd unit
 *   estatemate-bridge.exe uninstall-service  remove it again
 *   estatemate-bridge.exe version            build + runtime information
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadAgent } = require('./agent-loader.cjs');
const { createLogger } = require('./logger.cjs');
const {
  DEFAULT_WORKER_URL,
  maskSecret,
  readJson,
  resolvePaths,
  validateAgentConfig,
  validateDevicesConfig,
} = require('./config.cjs');
const { runCheck } = require('./diagnostics.cjs');
const { installService, serviceState, uninstallService } = require('./service.cjs');
const { runInit, runSetup } = require('./setup.cjs');

const COMMANDS = new Set([
  'run',
  'check',
  'status',
  'setup',
  'init',
  'install-service',
  'uninstall-service',
  'version',
  'help',
]);

const FLAG_SPEC = {
  config: 'value',
  devices: 'value',
  'data-dir': 'value',
  'log-level': 'value',
  'log-file': 'value',
  'from-installer': 'value',
  'devices-json': 'value',
  'task-name': 'value',
  user: 'value',
  quiet: 'bool',
  json: 'bool',
  force: 'bool',
  'no-prompt': 'bool',
  'no-verify': 'bool',
  'dry-run': 'bool',
  help: 'bool',
  version: 'bool',
};

const HELP = `EstateMate Bridge — Hikvision ISAPI bridge for the estate LAN

Usage
  estatemate-bridge.exe [command] [options]

Commands (default: run)
  run                 Start the bridge: heartbeat, card-operation polling and
                      real-time alertStream events from every configured device.
  check               Pre-flight: validate the config, authenticate against the
                      Worker, then probe each terminal over ISAPI.
  setup               Write agent-config.json/isapi-devices.json, optionally from
                      the portal's "Download installer" script.
  init                Write example configuration files without prompting.
  status              Show resolved paths, scheduled-task state and recent logs.
  install-service     Keep it running: Windows Scheduled Task (SYSTEM, at boot,
                      restart on failure) or a systemd unit on Linux.
  uninstall-service   Remove that registration.
  version             Build, runtime and platform information.
  help                This text.

Options
  --config <file>          agent-config.json (default: %ProgramData%\\EstateMate)
  --devices <file>         isapi-devices.json
  --data-dir <dir>         directory for configuration and logs
  --log-level <level>      debug | info | warn | error
  --log-file <file>        default: <data-dir>\\logs\\bridge.log
  --from-installer <file>  portal installer script; "-" reads stdin
  --devices-json <file>    device list to import during setup; "-" reads stdin
  --no-prompt              never ask questions (setup/init only)
  --no-verify              skip the Worker call during setup
  --task-name <name>       Scheduled Task name (default: EstateMateBridge)
  --user <name>            run the Linux systemd unit as this user
  --dry-run                print service commands instead of running them
  --json                   machine-readable output (check, status)
  --force                  overwrite existing files (init)
  --quiet                  log to file only

Examples
  estatemate-bridge.exe setup --from-installer .\\installer.ps1
  estatemate-bridge.exe check --json
  estatemate-bridge.exe install-service
`;

function parseArgs(argv) {
  const result = { command: null, flags: {}, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h') {
      result.flags.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      if (!result.command) result.command = token;
      else result.errors.push(`unexpected argument "${token}"`);
      continue;
    }
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s);
    const name = rawName;
    const spec = FLAG_SPEC[name];
    if (!spec) {
      result.errors.push(`unknown option "--${name}"`);
      continue;
    }
    if (spec === 'bool') {
      result.flags[name] = inlineValue === undefined ? true : !/^(false|0|no)$/i.test(inlineValue);
      continue;
    }
    if (inlineValue !== undefined) {
      result.flags[name] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith('--') && next !== '-')) {
      result.errors.push(`option "--${name}" needs a value`);
      continue;
    }
    result.flags[name] = next;
    index += 1;
  }
  if (!result.command) result.command = result.flags.version ? 'version' : result.flags.help ? 'help' : 'run';
  if (!COMMANDS.has(result.command)) result.errors.push(`unknown command "${result.command}"`);
  return result;
}

function readJsonSafe(file, label, logger) {
  if (!fs.existsSync(file)) return { exists: false, value: null };
  try {
    return { exists: true, value: readJson(file) };
  } catch (error) {
    logger.error(`${label} is not valid JSON: ${error.message}`);
    return { exists: true, value: null, parseError: error.message };
  }
}

function buildContext({ meta, paths, logger }) {
  const configRead = readJsonSafe(paths.configPath, 'agent-config.json', logger);
  const devicesRead = readJsonSafe(paths.devicesPath, 'isapi-devices.json', logger);
  const configValidation = configRead.value
    ? validateAgentConfig(configRead.value)
    : { errors: configRead.exists ? ['agent-config.json could not be parsed'] : [`no agent-config.json at ${paths.configPath}`], warnings: [] };
  const devicesValidation = devicesRead.value
    ? validateDevicesConfig(devicesRead.value)
    : { errors: [], warnings: [], devices: [] };
  return {
    version: meta.version,
    commit: meta.commit,
    builtAt: meta.builtAt,
    target: meta.target,
    exePath: meta.exePath,
    nodeVersion: meta.nodeVersion,
    runtimeDir: meta.runtimeDir,
    agentEntry: path.join(meta.runtimeDir, 'agent', 'agent.mjs'),
    paths,
    config: configRead.value,
    devicesFile: devicesRead.value,
    configExists: configRead.exists,
    devicesExists: devicesRead.exists,
    configValidation,
    devicesValidation,
    logger,
  };
}

function banner(ctx, logger) {
  const config = ctx.config || {};
  logger.raw('');
  logger.raw(`EstateMate Bridge ${ctx.version}${ctx.commit ? ` (${String(ctx.commit).slice(0, 8)})` : ''} — Hikvision ISAPI bridge`);
  logger.raw(`  runtime    node ${ctx.nodeVersion} · ${process.platform} ${process.arch}${ctx.target ? ` · built for ${ctx.target}` : ''}`);
  logger.raw(`  executable ${ctx.exePath}`);
  logger.raw(`  config     ${ctx.paths.configPath} [${ctx.paths.configSource}]`);
  logger.raw(`  devices    ${ctx.paths.devicesPath} [${ctx.paths.devicesSource}]`);
  if (config.agentId) logger.raw(`  agent      ${String(config.agentId).trim()} · secret ${maskSecret(config.agentSecret)}`);
  if (config.workerUrl) logger.raw(`  worker     ${String(config.workerUrl).trim()}`);
  logger.raw('');
}

async function commandRun({ ctx, logger }) {
  const { errors, warnings } = ctx.configValidation;
  if (errors.length) {
    logger.error('The bridge cannot start until the configuration is fixed:');
    for (const error of errors) logger.error(`  - ${error}`);
    logger.raw(`  Run "${path.basename(ctx.exePath)} setup" to create it, or "check" for a full report.`);
    return 2;
  }
  for (const warning of warnings) logger.warn(warning);
  for (const warning of ctx.devicesValidation.warnings) logger.warn(warning);

  banner(ctx, logger);

  const agent = await loadAgent({
    agentEntry: ctx.agentEntry,
    configPath: ctx.paths.configPath,
    devicesPath: ctx.paths.devicesPath,
    standby: false,
    logger,
  });

  logger.info('Bridge running. Press Ctrl+C to stop.');
  const uptimeTimer = setInterval(() => {
    const stats = agent.eventStats || { forwarded: 0, dropped: 0 };
    const pending = Array.isArray(agent.pendingEvents) ? agent.pendingEvents.length : 0;
    logger.info(`Still running — events forwarded ${stats.forwarded}, dropped ${stats.dropped}, buffered ${pending}`);
  }, 30 * 60 * 1000);
  uptimeTimer.unref();

  const shutdown = () => {
    logger.info('Stopping the bridge.');
    logger.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the CLI alive: the agent owns its own timers, but returning would let
  // the entry point exit before the first heartbeat in some shells.
  return new Promise(() => {});
}

function commandStatus({ ctx, logger, json }) {
  const state = serviceState({ options: { taskName: ctx.paths.taskName } });
  const report = {
    version: ctx.version,
    commit: ctx.commit,
    builtAt: ctx.builtAt,
    target: ctx.target,
    node: ctx.nodeVersion,
    platform: `${process.platform} ${process.arch}`,
    exePath: ctx.exePath,
    runtimeDir: ctx.runtimeDir,
    dataDir: ctx.paths.dataDir,
    config: {
      path: ctx.paths.configPath,
      source: ctx.paths.configSource,
      exists: ctx.configExists,
      valid: ctx.configValidation.errors.length === 0,
      errors: ctx.configValidation.errors,
      warnings: ctx.configValidation.warnings,
      agentId: ctx.config ? String(ctx.config.agentId || '') : null,
      agentSecretMasked: ctx.config ? maskSecret(ctx.config.agentSecret) : null,
      workerUrl: ctx.config ? String(ctx.config.workerUrl || '') || DEFAULT_WORKER_URL : null,
      syncIntervalSeconds: ctx.config ? Number(ctx.config.syncIntervalSeconds || 30) : null,
      eventStream: ctx.config ? ctx.config.eventStream !== false : null,
    },
    devicesFile: {
      path: ctx.paths.devicesPath,
      source: ctx.paths.devicesSource,
      exists: ctx.devicesExists,
      count: (ctx.devicesValidation.devices || []).length,
      warnings: ctx.devicesValidation.warnings,
      errors: ctx.devicesValidation.errors,
    },
    logFile: logger.filePath,
    service: state,
    recentLog: logger.tail(12),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  banner(ctx, logger);
  logger.raw(`  config     ${ctx.configExists ? (report.config.valid ? 'present and valid' : 'present but INVALID') : 'missing'}`);
  logger.raw(`  devices    ${ctx.devicesExists ? `${report.devicesFile.count} configured` : 'missing (no terminals yet)'}`);
  logger.raw(`  service    ${state.installed ? `${state.name}: ${state.status || 'registered'}${state.lastResult ? ` (last result ${state.lastResult})` : ''}` : `not installed — ${state.detail || 'run install-service'}`}`);
  logger.raw(`  log file   ${logger.filePath || '(console only)'}`);
  for (const error of report.config.errors) logger.raw(`  ERROR      ${error}`);
  for (const warning of report.config.warnings) logger.raw(`  WARN       ${warning}`);
  if (report.recentLog.length) {
    logger.raw('');
    logger.raw('  Recent log lines:');
    for (const line of report.recentLog) logger.raw(`    ${line}`);
  }
  logger.raw('');
  return 0;
}

function commandVersion({ ctx, logger, json }) {
  const info = {
    name: 'estatemate-bridge',
    version: ctx.version,
    commit: ctx.commit,
    builtAt: ctx.builtAt,
    target: ctx.target,
    node: ctx.nodeVersion,
    platform: `${process.platform} ${process.arch}`,
    exePath: ctx.exePath,
    runtimeDir: ctx.runtimeDir,
    agentEntry: ctx.agentEntry,
  };
  if (json) process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  else {
    logger.raw(`EstateMate Bridge ${info.version}${info.commit ? ` (${info.commit})` : ''}`);
    logger.raw(`  built      ${info.builtAt || 'unknown'} for ${info.target || info.platform}`);
    logger.raw(`  runtime    node ${info.node} on ${info.platform}`);
    logger.raw(`  executable ${info.exePath}`);
    logger.raw(`  sources    ${path.dirname(info.agentEntry)} (unpacked from the executable)`);
  }
  return 0;
}

async function runCli(meta) {
  const parsed = parseArgs(process.argv.slice(2));
  const { flags, command } = parsed;

  if (parsed.errors.length) {
    for (const error of parsed.errors) process.stderr.write(`error: ${error}\n`);
    process.stderr.write('\nRun "estatemate-bridge.exe help" for usage.\n');
    return 2;
  }
  if (command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const paths = resolvePaths({
    exePath: meta.exePath,
    env: process.env,
    config: flags.config || null,
    devices: flags.devices || null,
    dataDir: flags['data-dir'] || null,
  });
  paths.taskName = flags['task-name'] || undefined;

  const logger = createLogger({
    level: flags['log-level'] || 'info',
    file: flags['log-file'] || path.join(paths.logDir, 'bridge.log'),
    console: !flags.quiet,
  });

  // `version` must work no matter what the configuration says.
  if (command === 'version') {
    const code = commandVersion({
      ctx: { ...meta, paths, agentEntry: path.join(meta.runtimeDir, 'agent', 'agent.mjs') },
      logger,
      json: Boolean(flags.json),
    });
    logger.close();
    return code;
  }

  const ctx = buildContext({ meta, paths, logger });
  if (!flags['log-level'] && ctx.config && ctx.config.logLevel) logger.setLevel(String(ctx.config.logLevel));

  let code = 0;
  switch (command) {
    case 'run':
      logger.installConsoleMirror();
      code = await commandRun({ ctx, logger });
      break;
    case 'check':
      code = await runCheck({ ctx, logger, json: Boolean(flags.json) });
      break;
    case 'status':
      code = commandStatus({ ctx, logger, json: Boolean(flags.json) });
      break;
    case 'setup':
      code = await runSetup({
        ctx,
        logger,
        options: {
          fromInstaller: flags['from-installer'] || null,
          devicesJson: flags['devices-json'] || null,
          prompt: !flags['no-prompt'],
          verify: !flags['no-verify'],
          force: Boolean(flags.force),
        },
      });
      break;
    case 'init':
      code = runInit({ ctx, logger, options: { force: Boolean(flags.force) } });
      break;
    case 'install-service':
      code = installService({
        ctx,
        logger,
        options: { taskName: flags['task-name'] || undefined, user: flags.user || null, dryRun: Boolean(flags['dry-run']) },
      });
      break;
    case 'uninstall-service':
      code = uninstallService({
        ctx,
        logger,
        options: { taskName: flags['task-name'] || undefined, dryRun: Boolean(flags['dry-run']) },
      });
      break;
    default:
      process.stderr.write(`error: unknown command "${command}"\n`);
      code = 2;
      break;
  }

  if (code !== undefined && typeof code === 'number') {
    process.exitCode = code;
    logger.close();
    if (command !== 'run') {
      // fetch() keeps pooled sockets around; without this a one-shot command can
      // sit idle for as long as the peer holds the connection. The timer is
      // unref'd, so a clean event loop still exits immediately with exitCode.
      const guard = setTimeout(() => process.exit(code), 2000);
      guard.unref();
    }
  }
  return code;
}

module.exports = {
  COMMANDS,
  FLAG_SPEC,
  HELP,
  buildContext,
  commandRun,
  commandStatus,
  commandVersion,
  parseArgs,
  runCli,
};
