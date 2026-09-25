/**
 * Keeping the bridge running without an operator: a Windows Scheduled Task that
 * starts at boot and restarts on failure, or a systemd unit on Linux.
 *
 * Why a Scheduled Task rather than `sc.exe create`? A Node.js single executable
 * is a console process: the Service Control Manager starts it, waits 30 seconds
 * for a ServiceMain handshake that never comes, and fails with error 1053. The
 * project's own portal installer reached the same conclusion and registers a
 * startup task for exactly this reason.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TASK_NAME = 'EstateMateBridge';
const SYSTEMD_UNIT_NAME = 'estatemate-bridge.service';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function taskXml({ taskName, exePath, args, workingDirectory }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>EstateMate Hikvision ISAPI bridge: streams access events to the Worker and applies queued card operations over ISAPI on the estate LAN.</Description>
    <URI>\\${xmlEscape(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT20S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exePath)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function systemdUnit({ exePath, args, workingDirectory, user = null }) {
  return `[Unit]
Description=EstateMate Hikvision ISAPI bridge
Documentation=https://github.com/barikblog/estatemate-minmoe/blob/main/docs/BRIDGE-EXE-AND-APK.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workingDirectory}
ExecStart=${exePath} ${args}
Restart=always
RestartSec=10
${user ? `User=${user}\n` : ''}# The bridge writes its own rolling log; journald keeps stdout as a second copy.

[Install]
WantedBy=multi-user.target
`;
}

function buildRunArguments(ctx) {
  return `run --config "${ctx.paths.configPath}" --devices "${ctx.paths.devicesPath}"`;
}

function run(command, args, { logger, dryRun }) {
  if (dryRun) {
    logger.raw(`  [dry-run] ${command} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '', dryRun: true };
  }
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? result.error.message : null,
  };
}

function installWindowsService({ ctx, logger, options }) {
  const taskName = options.taskName || DEFAULT_TASK_NAME;
  const xml = taskXml({
    taskName,
    exePath: ctx.exePath,
    args: buildRunArguments(ctx),
    workingDirectory: ctx.paths.exeDir,
  });
  const xmlPath = path.join(os.tmpdir(), `${taskName}-task.xml`);
  if (!options.dryRun) {
    // schtasks expects UTF-16 with a BOM for /XML.
    fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from('\uFEFF', 'utf16le'), Buffer.from(xml, 'utf16le')]));
  }
  logger.raw(`  task definition: ${xmlPath}`);

  const create = run('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'], { logger, dryRun: options.dryRun });
  if (create.error) {
    logger.error(`schtasks could not be executed: ${create.error}`);
    return 1;
  }
  if (create.status !== 0) {
    const detail = `${create.stderr} ${create.stdout}`.trim();
    logger.error(`schtasks /Create failed: ${detail}`);
    if (/access is denied|denied/i.test(detail)) logger.error('Run this from an elevated (Administrator) PowerShell or Command Prompt.');
    return 1;
  }
  logger.info(`Scheduled task "${taskName}" registered: starts at boot as SYSTEM, restarts up to 10 times after failure.`);

  const start = run('schtasks', ['/Run', '/TN', taskName], { logger, dryRun: options.dryRun });
  if (start.status === 0) logger.info(`Started "${taskName}".`);
  else logger.warn(`Could not start the task now (${`${start.stderr} ${start.stdout}`.trim()}); it will start at the next boot.`);

  logger.raw('');
  logger.raw('  Verify the task:');
  logger.raw(`    schtasks /Query /TN "${taskName}" /V /FO LIST`);
  logger.raw(`    "${path.basename(ctx.exePath)}" check`);
  return 0;
}

function uninstallWindowsService({ ctx, logger, options }) {
  const taskName = options.taskName || DEFAULT_TASK_NAME;
  run('schtasks', ['/End', '/TN', taskName], { logger, dryRun: options.dryRun });
  const del = run('schtasks', ['/Delete', '/TN', taskName, '/F'], { logger, dryRun: options.dryRun });
  if (del.status === 0) {
    logger.info(`Scheduled task "${taskName}" removed.`);
    return 0;
  }
  const detail = `${del.stderr} ${del.stdout}`.trim();
  if (/cannot find|not exist/i.test(detail)) {
    logger.warn(`No scheduled task named "${taskName}" was registered on this machine.`);
    return 0;
  }
  logger.error(`schtasks /Delete failed: ${detail}`);
  return 1;
}

function installLinuxService({ ctx, logger, options }) {
  const unitPath = path.join('/etc/systemd/system', SYSTEMD_UNIT_NAME);
  const unit = systemdUnit({
    exePath: ctx.exePath,
    args: buildRunArguments(ctx),
    workingDirectory: ctx.paths.exeDir,
    user: options.user || null,
  });
  if (options.dryRun) {
    logger.raw(`  [dry-run] would write ${unitPath}:`);
    logger.raw(unit);
    return 0;
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    logger.raw('  Installing a system service needs root. Run the same command with sudo, or write the unit yourself:');
    logger.raw('');
    logger.raw(unit);
    return 1;
  }
  fs.writeFileSync(unitPath, unit, { mode: 0o644 });
  logger.info(`Wrote ${unitPath}`);
  const reload = run('systemctl', ['daemon-reload'], { logger, dryRun: false });
  if (reload.status !== 0) logger.warn(`systemctl daemon-reload: ${`${reload.stderr} ${reload.stdout}`.trim()}`);
  const enable = run('systemctl', ['enable', '--now', 'estatemate-bridge'], { logger, dryRun: false });
  if (enable.status !== 0) {
    logger.error(`systemctl enable --now failed: ${`${enable.stderr} ${enable.stdout}`.trim()}`);
    return 1;
  }
  logger.info('Service "estatemate-bridge" enabled and started (restarts on failure every 10s).');
  return 0;
}

function uninstallLinuxService({ ctx, logger, options }) {
  const unitPath = path.join('/etc/systemd/system', SYSTEMD_UNIT_NAME);
  if (options.dryRun) {
    logger.raw(`  [dry-run] systemctl disable --now estatemate-bridge && rm ${unitPath}`);
    return 0;
  }
  run('systemctl', ['disable', '--now', 'estatemate-bridge'], { logger, dryRun: false });
  try {
    fs.rmSync(unitPath, { force: true });
    logger.info(`Removed ${unitPath}`);
  } catch (error) {
    logger.error(`Could not remove ${unitPath}: ${error.message}`);
    return 1;
  }
  run('systemctl', ['daemon-reload'], { logger, dryRun: false });
  return 0;
}

function printMacLaunchdInstructions({ ctx, logger }) {
  const label = 'com.estatemate.bridge';
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  logger.raw('  macOS: create a launch agent so the bridge starts with the user session.');
  logger.raw(`  Write this to ${plistPath}, then run: launchctl load -w "${plistPath}"`);
  logger.raw('');
  logger.raw(`  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${ctx.exePath}</string>
      <string>run</string>
      <string>--config</string><string>${ctx.paths.configPath}</string>
      <string>--devices</string><string>${ctx.paths.devicesPath}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
  </dict></plist>`);
  return 0;
}

function installService({ ctx, logger, options }) {
  if (process.platform === 'win32') return installWindowsService({ ctx, logger, options });
  if (process.platform === 'linux') return installLinuxService({ ctx, logger, options });
  return printMacLaunchdInstructions({ ctx, logger });
}

function uninstallService({ ctx, logger, options }) {
  if (process.platform === 'win32') return uninstallWindowsService({ ctx, logger, options });
  if (process.platform === 'linux') return uninstallLinuxService({ ctx, logger, options });
  logger.raw('  macOS: remove the launch agent with: launchctl unload -w ~/Library/LaunchAgents/com.estatemate.bridge.plist');
  return 0;
}

function serviceState({ options = {} }) {
  const taskName = options.taskName || DEFAULT_TASK_NAME;
  if (process.platform === 'win32') {
    const query = spawnSync('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'], { encoding: 'utf8', windowsHide: true });
    if (query.status !== 0) return { supported: true, installed: false, detail: 'no scheduled task registered' };
    const text = query.stdout || '';
    const pick = (label) => new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() || null;
    return {
      supported: true,
      installed: true,
      name: taskName,
      status: pick('Status'),
      lastRun: pick('Last Run Time'),
      lastResult: pick('Last Result'),
      nextRun: pick('Next Run Time'),
    };
  }
  if (process.platform === 'linux') {
    const active = spawnSync('systemctl', ['is-active', 'estatemate-bridge'], { encoding: 'utf8', windowsHide: true });
    const enabled = spawnSync('systemctl', ['is-enabled', 'estatemate-bridge'], { encoding: 'utf8', windowsHide: true });
    const unitExists = fs.existsSync(path.join('/etc/systemd/system', SYSTEMD_UNIT_NAME));
    if (!unitExists && active.status !== 0) return { supported: true, installed: false, detail: 'no systemd unit registered' };
    return {
      supported: true,
      installed: true,
      name: 'estatemate-bridge.service',
      status: (active.stdout || '').trim() || null,
      enabled: (enabled.stdout || '').trim() || null,
    };
  }
  return { supported: false, installed: false, detail: 'check launchctl list manually on macOS' };
}

module.exports = {
  DEFAULT_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  buildRunArguments,
  installService,
  serviceState,
  systemdUnit,
  taskXml,
  uninstallService,
};
