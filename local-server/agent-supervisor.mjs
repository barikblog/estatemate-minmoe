/**
 * Embedded EstateMate agent supervisor.
 *
 * "Communicates directly with the access controls" happens here. The same
 * production agent the repository ships (`isapi-bridge/agent.mjs`) runs as a
 * child process of the offline server, pointed at the server's loopback
 * address. It is the only thing that talks to the Hikvision terminals:
 *
 *   - one persistent ISAPI `alertStream` connection per terminal for live
 *     gate events (HTTP Digest authentication, exactly as on the cloud path);
 *   - polling the loopback API for queued card/visitor operations and
 *     applying them over ISAPI;
 *   - heartbeats so the portal shows the agent (and its terminals) online.
 *
 * Running it as a supervised child keeps the audited security model intact:
 * device credentials live in a generated config under `<dataDir>/agent/`
 * with owner-only permissions, and the agent code is unmodified. If the
 * estate prefers to run the agent on a different always-on machine instead,
 * set `agent.enabled: false` here and follow isapi-bridge/README.md against
 * `http://<server-lan-ip>:<port>`.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function restrict(path) {
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs differ; the data dir is still local-only */ }
}

export function createAgentSupervisor({ agentScript, agentDir, baseUrl, config = {}, logger = console }) {
  let current = {
    agentId: config.agentId ?? '',
    agentSecret: config.agentSecret ?? '',
    devices: config.devices ?? [],
    syncIntervalSeconds: config.syncIntervalSeconds ?? 30,
    heartbeatIntervalSeconds: config.heartbeatIntervalSeconds ?? 60,
    eventStream: config.eventStream,
    eventFlushCount: config.eventFlushCount,
    eventFlushSeconds: config.eventFlushSeconds,
    eventBufferLimit: config.eventBufferLimit,
    isapiTimeoutMs: config.isapiTimeoutMs,
    maxRetries: config.maxRetries,
    logLevel: config.logLevel,
  };
  let child = null;
  let permanentlyStopped = false;
  let restartTimer = null;
  let restartAttempts = 0;

  const agentConfigPath = join(agentDir, 'agent-config.json');
  const devicesConfigPath = join(agentDir, 'isapi-devices.json');

  function writeAgentFiles() {
    mkdirSync(agentDir, { recursive: true });
    const agentConfig = {
      agentId: current.agentId,
      agentSecret: current.agentSecret,
      // Always the loopback address of this server: the agent never needs to
      // leave the estate LAN, and neither does the portal traffic it relays.
      workerUrl: baseUrl,
      syncIntervalSeconds: current.syncIntervalSeconds ?? 30,
      heartbeatIntervalSeconds: current.heartbeatIntervalSeconds ?? 60,
      eventStream: current.eventStream !== false,
      eventFlushCount: current.eventFlushCount ?? 25,
      eventFlushSeconds: current.eventFlushSeconds ?? 5,
      eventBufferLimit: current.eventBufferLimit ?? 500,
      isapiTimeoutMs: current.isapiTimeoutMs ?? 15000,
      maxRetries: current.maxRetries ?? 3,
      logLevel: current.logLevel ?? 'info',
    };
    writeFileSync(agentConfigPath, JSON.stringify(agentConfig, null, 2));
    restrict(agentConfigPath);
    writeFileSync(devicesConfigPath, JSON.stringify({
      devices: current.devices.map((device) => ({
        estateMateDeviceId: device.estateMateDeviceId ?? '',
        name: device.name ?? device.isapiHost,
        isapiHost: device.isapiHost,
        isapiPort: Number(device.isapiPort ?? 80),
        isapiUsername: device.isapiUsername ?? 'admin',
        isapiPassword: device.isapiPassword ?? '',
        protocol: device.protocol === 'https' ? 'https' : 'http',
        enabled: device.enabled !== false,
        eventStream: device.eventStream !== false,
      })),
    }, null, 2));
    restrict(devicesConfigPath);
  }

  function pipe(stream, level) {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        if (line) logger.log(`[agent:${level}] ${line}`);
      }
    });
    stream.on('end', () => { if (pending.trim()) logger.log(`[agent:${level}] ${pending.trim()}`); });
  }

  function launch() {
    if (permanentlyStopped || child) return;
    writeAgentFiles();
    logger.log(`[agent] starting EstateMate agent ${current.agentId} against ${baseUrl} for ${current.devices.length} terminal(s)`);
    child = spawn(process.execPath, [agentScript, '--config', agentConfigPath, '--devices', devicesConfigPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    pipe(child.stdout, 'info');
    pipe(child.stderr, 'error');
    child.on('error', (error) => {
      logger.error('[agent] could not start', error);
      child = null;
      scheduleRestart();
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (permanentlyStopped) return;
      logger.error(`[agent] exited (code=${code} signal=${signal}); restarting shortly`);
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (permanentlyStopped || restartTimer) return;
    restartAttempts += 1;
    const delay = Math.min(5000 * restartAttempts, 60000);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, delay);
    restartTimer.unref?.();
  }

  async function haltChild() {
    if (!child) return;
    const exiting = new Promise((resolveExit) => { child?.once('exit', resolveExit); });
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } }, 8000);
    killTimer.unref?.();
    await exiting;
    clearTimeout(killTimer);
    child = null;
  }

  return {
    isConfigured() {
      return Boolean(current.agentId && current.agentSecret && current.devices.some((device) => device.isapiHost));
    },
    start() {
      if (permanentlyStopped) throw new Error('Supervisor was stopped and cannot be restarted');
      if (!this.isConfigured()) return false;
      restartAttempts = 0;
      launch();
      return true;
    },
    isRunning() {
      return Boolean(child);
    },
    /**
     * Replaces the agent configuration (id, secret, terminals, intervals)
     * and restarts the child process. Lets an administrator wire the portal
     * first and connect the agent afterwards without restarting the server.
     */
    async update(nextConfig) {
      if (permanentlyStopped) throw new Error('Supervisor was stopped and cannot be restarted');
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      current = { ...current, ...nextConfig };
      await haltChild();
      if (this.isConfigured()) {
        restartAttempts = 0;
        launch();
      }
    },
    async stop() {
      permanentlyStopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      await haltChild();
    },
  };
}
