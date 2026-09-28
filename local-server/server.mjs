#!/usr/bin/env node
/**
 * EstateMate — Offline LAN Server (Windows/Linux/macOS, Node 22+)
 *
 * Runs the *entire* EstateMate application — the same Hono Worker code that
 * is deployed to Cloudflare (`src/index.ts`) plus the built React portal —
 * as one always-on process on the estate LAN, with zero Internet
 * dependency:
 *
 *   Cloudflare D1              → Node SQLite file (<dataDir>/estatemate.db)
 *   Cloudflare Queues          → in-process batch delivery to the Worker's
 *                                own queue consumer
 *   AccessLiveFeed Durable Obj → `ws` WebSocket hub (same wire protocol)
 *   Private GitHub file store  → local disk under <dataDir>/storage/
 *   Hourly Cron                → an in-process scheduler at minute 15
 *   Cloudflare Tunnel/agent    → the embedded EstateMate agent, which holds
 *                                ISAPI alertStream connections to each
 *                                Hikvision terminal and applies card and
 *                                visitor operations over ISAPI Digest auth
 *
 * Only the Cloudflare *bindings* are replaced; every line of product code,
 * every role check, every audit trail and every migration runs unmodified,
 * so behaviour cannot drift from the cloud deployment.
 *
 * Start:            node local-server/server.mjs
 * Configuration:    local-server/config.json (created on first boot)
 * Portal:           http://<this-machine-lan-ip>:<port>
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { applyMigrations, createD1Database, openSqliteDatabase } from './d1.mjs';
import { createAssetServer } from './assets.mjs';
import { createAccessEventsQueue } from './queue.mjs';
import { LiveFeedHub, createLiveFeedNamespace } from './live-feed.mjs';
import { installLocalGitHubStorage, seedLocalStorageSettings } from './github-vfs.mjs';
import { createAgentSupervisor } from './agent-supervisor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 8080,
  dataDir: 'data',
  appName: 'EstateMate',
  allowedOrigins: '',
  hikvisionMode: 'per-device',
  fileStorage: 'local',
  secrets: {},
  agent: { enabled: true, agentId: '', agentSecret: '', devices: [] },
  tls: {},
};

const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024; // files 4 MB, CSV 2 MB, event batches 2 MB — headroom included.

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object') {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function normaliseLogger(quiet) {
  if (!quiet) return console;
  const silent = () => {};
  return { log: silent, info: silent, warn: silent, error: console.error, trace: silent, debug: silent };
}

function readConfigFile(configPath) {
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function writeConfigFile(configPath, config) {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  try { chmodSync(configPath, 0o600); } catch { /* Windows: the folder ACL is the boundary */ }
}

/**
 * Loads config from `configPath` (creating it from defaults with generated
 * secrets on first boot), then applies `overrides`. Secrets are generated
 * when missing so a fresh install is immediately usable; they are persisted
 * to the config file when one is in use.
 */
function loadConfiguration({ configPath, overrides = {}, logger }) {
  const fileConfig = configPath ? readConfigFile(configPath) : null;
  const config = deepMerge(DEFAULT_CONFIG, { ...(fileConfig ?? {}) });
  const merged = deepMerge(config, overrides);

  const secrets = { ...(merged.secrets ?? {}) };
  let generated = false;
  for (const key of ['jwtSecret', 'deviceIngestPepper', 'storageEncryptionKey']) {
    if (!secrets[key]) { secrets[key] = randomHex(32); generated = true; }
  }
  if (!secrets.bootstrapToken) { secrets.bootstrapToken = randomHex(16); generated = true; }
  merged.secrets = secrets;

  if (generated && configPath) {
    if (fileConfig === null) {
      logger.log(`First boot: created configuration ${configPath} with generated secrets.`);
      logger.log(`The first-run Administrator token is: ${secrets.bootstrapToken}`);
      logger.log('Record it, then open the portal and create the Administrator account.');
    } else {
      logger.log('Generated missing secrets and saved them to the configuration file.');
    }
    writeConfigFile(configPath, merged);
  } else if (generated) {
    logger.warn('Secrets were generated in memory only (no config file in use).');
  }
  return merged;
}

/** Reads and buffers a request body, enforcing the size cap. */
function readRequestBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        rejectBody(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

function nodeHeadersToWeb(headers) {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) webHeaders.append(key, String(item));
    else webHeaders.append(key, String(value));
  }
  return webHeaders;
}

let workerModulePromise = null;

/**
 * Imports the shared Worker (`src/index.ts`) exactly once per process. The
 * ts-resolve hook is registered first so the TypeScript source with its
 * extensionless relative imports loads natively — no build step, no fork of
 * the product code.
 */
function importWorker() {
  if (!workerModulePromise) {
    workerModulePromise = (async () => {
      const { register } = await import('node:module');
      register(pathToFileURL(join(__dirname, 'ts-resolve.mjs')).href);
      const mod = await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.ts')).href);
      return mod.default;
    })();
  }
  return workerModulePromise;
}

/**
 * Boots the complete offline server. Used by the CLI below and by the
 * integration test; returns handles for supervision and inspection.
 */
export async function startServer(options = {}) {
  const logger = normaliseLogger(options.quiet);
  const configPath = options.configPath ? resolve(options.configPath) : null;
  const config = loadConfiguration({ configPath, overrides: options.config ?? {}, logger });

  if (options.importSql) {
    importSqlDump(config, options.importSql, logger);
  }

  const dataDir = isAbsolute(String(config.dataDir)) ? config.dataDir : resolve(__dirname, config.dataDir);
  for (const dir of [dataDir, join(dataDir, 'agent'), join(dataDir, 'storage'), join(dataDir, 'dlq')]) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = openSqliteDatabase(join(dataDir, 'estatemate.db'));
  const migrationInfo = applyMigrations(sqlite, join(REPO_ROOT, 'migrations'));
  logger.log(`[db] ${join(dataDir, 'estatemate.db')} — ${migrationInfo.applied ? `${migrationInfo.applied} migration(s) applied, ` : ''}${migrationInfo.total} in the chain`);

  const d1 = createD1Database(sqlite);

  // Local file storage: intercept api.github.com before the Worker loads.
  let storageInterceptor = null;
  if (config.fileStorage === 'local') {
    storageInterceptor = installLocalGitHubStorage({ rootDir: join(dataDir, 'storage'), logger });
    const seeded = await seedLocalStorageSettings(d1, { encryptionSecret: config.secrets.storageEncryptionKey });
    if (seeded) logger.log('[storage] local file storage initialised (uploads stay on this machine)');
  }

  const worker = await importWorker();

  const hub = new LiveFeedHub();
  const liveFeedNamespace = createLiveFeedNamespace(hub);
  const env = {
    DB: d1,
    LIVE_FEED: liveFeedNamespace,
    ACCESS_EVENTS: null, // wired below
    ASSETS: { fetch: () => new Response(null, { status: 404 }) },
    APP_NAME: config.appName,
    ALLOWED_ORIGINS: config.allowedOrigins ?? '',
    HIKVISION_MODE: config.hikvisionMode,
    FILE_STORAGE_MODE: config.fileStorage === 'local' ? 'github-private-configurable' : (config.fileStorage ?? 'disabled'),
    JWT_SECRET: config.secrets.jwtSecret,
    BOOTSTRAP_TOKEN: config.secrets.bootstrapToken,
    DEVICE_INGEST_PEPPER: config.secrets.deviceIngestPepper,
    STORAGE_ENCRYPTION_KEY: config.secrets.storageEncryptionKey,
  };

  const pendingWaitUntil = new Set();
  const executionCtx = {
    waitUntil(promise) {
      const tracked = Promise.resolve(promise).catch((error) => logger.error('[waitUntil] background task failed', error));
      pendingWaitUntil.add(tracked);
      tracked.finally(() => pendingWaitUntil.delete(tracked));
      return tracked;
    },
    passThroughOnException() { /* advisory in Workers; nothing to do offline */ },
  };

  const queue = createAccessEventsQueue({
    getWorker: () => worker,
    getEnv: () => env,
    dlqDir: join(dataDir, 'dlq'),
    logger,
  });
  env.ACCESS_EVENTS = queue;

  const assetServer = createAssetServer(join(REPO_ROOT, 'apps', 'web', 'dist'));

  let stopped = false;

  async function dispatch(request) {
    const assetResponse = assetServer(request);
    if (assetResponse) return assetResponse;
    return worker.fetch(request, env, executionCtx);
  }

  async function handleNodeRequest(req, res) {
    const startedAt = Date.now();
    try {
      const host = req.headers.host ?? 'localhost';
      const url = `http://${host}${req.url ?? '/'}`;
      const method = req.method ?? 'GET';
      const headers = nodeHeadersToWeb(req.headers);
      let body;
      if (method !== 'GET' && method !== 'HEAD') {
        body = new Uint8Array(await readRequestBody(req, MAX_REQUEST_BODY_BYTES));
        if (!body.byteLength) body = undefined;
      }
      const request = new Request(url, { method, headers, body, redirect: 'manual' });
      const response = await dispatch(request);
      await writeNodeResponse(res, req, response);
      logger.log(`[http] ${method} ${new URL(url).pathname} ${response.status} ${Date.now() - startedAt}ms`);
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: statusCode === 413 ? 'Payload too large' : 'Internal server error' }));
      } else {
        res.destroy(error);
      }
      logger.error('[http] request failed', error);
    }
  }

  async function writeNodeResponse(res, req, response) {
    const headers = {};
    for (const [key, value] of response.headers) {
      // Length and framing are recomputed from the buffered body below; undici
      // can hold a doubled Content-Length when the Worker set one explicitly.
      const name = key.toLowerCase();
      if (name === 'content-length' || name === 'transfer-encoding') continue;
      headers[key] = value;
    }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const bodyless = response.status === 204 || response.status === 304 || req.method === 'HEAD';
    let body = null;
    if (!bodyless && response.body) {
      body = Buffer.from(await response.arrayBuffer());
      headers['Content-Length'] = String(body.byteLength);
    }
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    res.writeHead(response.status, headers);
    res.end(body ?? undefined);
  }

  // WebSocket upgrades never reach the Worker through Node's HTTP layer, so
  // they are authorised by replaying the request without the Upgrade header:
  // the live-feed route answers 400 ("upgrade required") *after* its auth
  // middleware, so 400 means the session and role were accepted.
  async function handleUpgrade(req, socket, head) {
    try {
      const host = req.headers.host ?? 'localhost';
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname !== '/api/access/events/stream') {
        socket.destroy();
        return;
      }
      const headers = nodeHeadersToWeb(req.headers);
      headers.delete('upgrade');
      headers.delete('connection');
      const probe = new Request(`http://${host}${url.pathname}`, { method: 'GET', headers });
      const verdict = await worker.fetch(probe, env, executionCtx);
      if (verdict.status !== 400) {
        socket.write(`HTTP/1.1 ${verdict.status} ${verdict.statusText || 'Denied'}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      hub.handleUpgrade(req, socket, head);
    } catch (error) {
      logger.error('[ws] upgrade failed', error);
      socket.destroy();
    }
  }

  let server;
  const tlsEnabled = Boolean(config.tls?.certFile && config.tls?.keyFile);
  if (tlsEnabled) {
    server = createHttpsServer({
      cert: readFileSync(resolve(config.tls.certFile)),
      key: readFileSync(resolve(config.tls.keyFile)),
    }, handleNodeRequest);
  } else {
    server = createHttpServer(handleNodeRequest);
  }
  server.on('upgrade', handleUpgrade);
  server.requestTimeout = 0; // gate consoles keep connections open; streaming uploads are small.
  server.keepAliveTimeout = 65000;

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(Number(config.port ?? 8080), config.host ?? '0.0.0.0', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : Number(config.port);

  // With TLS on the public port, the embedded agent still speaks plain HTTP
  // on loopback (it cannot verify a self-signed estate certificate), so a
  // second listener bound to 127.0.0.1 carries only agent traffic.
  let loopbackServer = null;
  let agentBaseUrl = `http://127.0.0.1:${port}`;
  if (tlsEnabled) {
    const loopbackPort = Number(config.tls?.loopbackPort ?? port + 1);
    loopbackServer = createHttpServer(handleNodeRequest);
    loopbackServer.on('upgrade', handleUpgrade);
    await new Promise((resolveListen, rejectListen) => {
      loopbackServer.once('error', rejectListen);
      loopbackServer.listen(loopbackPort, '127.0.0.1', resolveListen);
    });
    agentBaseUrl = `http://127.0.0.1:${loopbackPort}`;
  }

  // Hourly maintenance, aligned to minute 15 like the deployed cron.
  const cronTimer = setInterval(() => {
    const now = new Date();
    if (now.getMinutes() !== 15) return;
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (cronTimer._lastKey === key) return;
    cronTimer._lastKey = key;
    worker.scheduled({ cron: '15 * * * *', scheduledTime: Date.now() }, env, executionCtx)
      .catch((error) => logger.error('[cron] hourly job failed', error));
  }, 30 * 1000);
  cronTimer.unref?.();

  const supervisor = createAgentSupervisor({
    agentScript: join(REPO_ROOT, 'isapi-bridge', 'agent.mjs'),
    agentDir: join(dataDir, 'agent'),
    baseUrl: agentBaseUrl,
    config: { ...(config.agent ?? {}) },
    logger,
  });
  const agentWanted = options.runAgent !== false && config.agent?.enabled !== false;
  if (agentWanted) {
    if (supervisor.isConfigured()) supervisor.start();
    else logger.warn('[agent] enabled but not configured yet: set agent.agentId/agentSecret and a terminal in config.json (see local-server/README.md)');
  }

  async function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(cronTimer);
    await supervisor.stop().catch(() => undefined);
    await queue.drain(5000).catch(() => undefined);
    await Promise.allSettled([...pendingWaitUntil]);
    hub.close();
    storageInterceptor?.uninstall();
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    server.closeAllConnections?.();
    if (loopbackServer) {
      await new Promise((resolveClose) => loopbackServer.close(() => resolveClose()));
      loopbackServer.closeAllConnections?.();
    }
    sqlite.close();
  }

  return {
    server,
    port,
    host: config.host,
    baseUrl: agentBaseUrl,
    config,
    configPath,
    dataDir,
    env,
    d1,
    sqlite,
    agent: supervisor,
    queue,
    hub,
    close,
    /** Read-only helper for scripts/tests. */
    all(sql, ...params) {
      return sqlite.prepare(sql).all(...params).map((row) => ({ ...row }));
    },
  };
}

/**
 * One-off import of a D1 export (`wrangler d1 export --remote` output) into
 * a brand-new database, so cloud data can be brought onto the estate server
 * before going offline. Must run before the server owns the file. Migration
 * bookkeeping is backfilled so the server does not try to re-apply the
 * chain over imported tables.
 */
function importSqlDump(config, dumpPath, logger) {
  const dataDir = isAbsolute(String(config.dataDir)) ? config.dataDir : resolve(__dirname, config.dataDir);
  const dbPath = join(dataDir, 'estatemate.db');
  if (existsSync(dbPath)) {
    throw new Error(`Refusing to import over an existing database: ${dbPath}. Move it away first (or point dataDir at a fresh directory).`);
  }
  mkdirSync(dataDir, { recursive: true });
  const dump = readFileSync(resolve(dumpPath), 'utf8');
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec(dump);
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
         name TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    const insert = sqlite.prepare('INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)');
    for (const name of readdirSync(join(REPO_ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      insert.run(name);
    }
  } catch (error) {
    try { sqlite.close(); } catch { /* never opened fully */ }
    throw new Error(`D1 import failed: ${error.message}`);
  }
  sqlite.close();
  logger.log(`[db] imported ${dumpPath} into ${dbPath} and marked the migration chain as applied`);
}

function lanAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}

async function main() {
  const args = process.argv.slice(2);
  const argValue = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
  };
  const configPath = argValue('config') ?? join(__dirname, 'config.json');
  const overrides = {};
  const portOverride = argValue('port');
  if (portOverride) overrides.port = Number(portOverride);
  const hostOverride = argValue('host');
  if (hostOverride) overrides.host = hostOverride;

  const handle = await startServer({
    configPath,
    config: overrides,
    importSql: argValue('import-sql'),
    runAgent: !args.includes('--no-agent'),
  });

  const scheme = handle.config.tls?.certFile ? 'https' : 'http';
  console.log('');
  console.log(`  ${handle.config.appName} — offline estate server`);
  console.log(`  Database      ${join(handle.dataDir, 'estatemate.db')}`);
  console.log(`  File storage  ${handle.config.fileStorage === 'local' ? `${join(handle.dataDir, 'storage')} (local disk)` : handle.config.fileStorage}`);
  console.log(`  Portal        ${scheme}://localhost:${handle.port}`);
  for (const address of lanAddresses()) {
    console.log(`  Portal        ${scheme}://${address}:${handle.port}   (share this on the estate LAN)`);
  }
  console.log(`  Agent         ${handle.agent.isRunning() ? 'running — direct ISAPI to the terminals' : 'not running (configure agent in config.json)'}`);
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — stopping the agent, flushing events and closing the database...`);
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error('Fatal:', error);
    process.exit(1);
  });
}
