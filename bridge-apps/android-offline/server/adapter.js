/**
 * EstateMate Offline — Android engine adapter.
 *
 * This file is the only new JavaScript in the offline APK, and it contains no
 * product logic: it bundles the unmodified Cloudflare Worker (`src/index.ts`)
 * and gives it the Cloudflare bindings an Android phone can provide, through
 * one small native bridge:
 *
 *   D1                       → native.d1Exec({op,sql,params}) → Java SQLiteDatabase
 *   Queues                   → in-memory buffer; Java calls drainQueue() back
 *                              through evaluateJavascript (JS timers are
 *                              throttled in backgrounded WebViews, Java timers
 *                              are not)
 *   AccessLiveFeed D.O.      → native.liveBroadcast(text) → the Java WebSocket hub
 *   Private GitHub storage   → the api.github.com REST slice served by
 *                              native.fileStore() from the app's private dir
 *   Hourly Cron              → Java calls tickCron() at minute 15
 *   Static portal            → served by Java straight from APK assets
 *
 * Every request the phones' browsers make still flows through the real Worker
 * code — same auth, same audit trail, same migrations — exactly like the
 * Node offline server in local-server/ and the Cloudflare deployment.
 *
 * The module is environment-agnostic so the exact bundled artifact can be
 * tested in Node (see adapter.test.mjs): in the APK it self-boots against the
 * injected `Native` interface; the test boots it against a mock.
 */
import worker from '../../../src/index.ts';

export const ADAPTER_VERSION = '1.0.0';
const MAX_EVENT_BATCH = 50;

// ---------------------------------------------------------------- base64 ---

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, Math.min(index + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ------------------------------------------------------------- D1 over Native

function createD1OverNative(native, log) {
  function exec(operation) {
    let parsed;
    try {
      parsed = JSON.parse(native.d1Exec(JSON.stringify(operation)));
    } catch (error) {
      throw new Error(`D1 bridge call failed: ${error?.message ?? error}`);
    }
    if (parsed && parsed.error) throw new Error(`D1 error: ${parsed.error}`);
    return parsed;
  }

  class PreparedStatement {
    constructor(sql, params) {
      this.sql = sql;
      this.params = params;
    }

    bind(...params) {
      return new PreparedStatement(this.sql, params);
    }

    first() {
      const result = exec({ op: 'first', sql: this.sql, params: this.params });
      return result.row ?? null;
    }

    all() {
      const result = exec({ op: 'all', sql: this.sql, params: this.params });
      return {
        results: result.rows ?? [],
        success: true,
        meta: { changes: (result.rows ?? []).length, last_row_id: null },
      };
    }

    run() {
      const result = exec({ op: 'run', sql: this.sql, params: this.params });
      return {
        success: true,
        meta: { changes: Number(result.changes ?? 0), last_row_id: Number(result.lastRowId ?? 0) },
      };
    }
  }

  return {
    prepare(sql) {
      return new PreparedStatement(sql, []);
    },
    async batch(statements) {
      const result = exec({
        op: 'batch',
        statements: statements.map((statement) => ({ sql: statement.sql, params: statement.params })),
      });
      return (result.results ?? []).map((item) => ({
        success: true,
        meta: { changes: Number(item.changes ?? 0), last_row_id: Number(item.lastRowId ?? 0) },
      }));
    },
    async exec() {
      throw new Error('exec() is not used by the Worker; migrations run on the Java side');
    },
    withSession() {
      throw new Error('sessions are not used by the Worker');
    },
    _log: log,
  };
}

// -------------------------------------------------------------- queue shim ---

function createAccessEventsQueue({ getWorker, getEnv, native, log }) {
  const buffer = [];
  let draining = false;

  function makeBatch(messages) {
    return {
      queue: 'estatemate-access-events',
      messages: messages.map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts,
        body: message.body,
        ack() { message.acked = true; },
        retry() { message.retried = true; },
      })),
      ackAll() { for (const message of messages) message.acked = true; },
      retryAll() { for (const message of messages) message.retried = true; },
    };
  }

  async function deadLetter(messages, error) {
    try {
      native.fileStore(JSON.stringify({
        op: 'dlq',
        name: `dlq-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`,
        json: JSON.stringify({ error: String(error?.message ?? error), failedAt: new Date().toISOString(), messages: messages.map((message) => message.body) }, null, 2),
      }));
    } catch (writeError) {
      log('error', `dead-letter write failed: ${writeError?.message ?? writeError}`);
    }
    log('error', `${messages.length} event(s) moved to the dead-letter store after repeated failures`);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (buffer.length) {
        const messages = buffer.splice(0, MAX_EVENT_BATCH);
        try {
          await getWorker().queue(makeBatch(messages), getEnv());
        } catch (error) {
          log('error', `queue consumer failed: ${error?.message ?? error}`);
          for (const message of messages) message.attempts += 1;
          const exhausted = messages.every((message) => message.attempts > 5);
          if (exhausted) {
            await deadLetter(messages, error);
          } else {
            buffer.unshift(...messages);
            return; // retried on the next drain
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    async send(payload) {
      if (payload === undefined || payload === null) return;
      buffer.push({ id: crypto.randomUUID(), timestamp: Date.now(), attempts: 1, body: payload, acked: false, retried: false });
      try {
        native.requestQueueDrain();
      } catch {
        // Java triggers drains on a timer as well; a missed nudge is fine.
      }
    },
    drain,
    stats() {
      return { buffered: buffer.length, draining };
    },
  };
}

// ----------------------------------------------------- live feed DO shim ----

function createLiveFeedNamespace(native) {
  const stub = {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
        native.liveBroadcast(await request.text());
        return new Response(null, { status: 204 });
      }
      // Real WebSocket upgrades never reach the stub: Java intercepts them at
      // the socket layer after the Worker's auth middleware approved them.
      return new Response('WebSocket upgrade required', { status: 426 });
    },
  };
  return {
    idFromName(name) {
      return { id: `local:${name}`, name };
    },
    idFromString(id) {
      return { id, name: id };
    },
    get() {
      return stub;
    },
    getByName() {
      return stub;
    },
  };
}

// -------------------------------------------------- local upload storage ----

/**
 * Serves the exact api.github.com REST slice `src/github-storage.ts` uses
 * from the app's private file store, exactly like local-server's
 * github-vfs.mjs. Returns null for every other URL so the call passes
 * through untouched.
 */
async function localGitHubFetch(url, init, native) {
  if (typeof url !== 'string' || !url.startsWith('https://api.github.com/')) return null;
  const parsed = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/.exec(parsed.pathname);
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

  if (!match) return json({ message: 'Not Found' }, 404);
  const [, encodedOwner, encodedRepo, rawContentPath] = match;
  const owner = decodeSegment(encodedOwner);
  const repo = decodeSegment(encodedRepo);
  if (!owner || !repo) return json({ message: 'Not Found' }, 404);

  if (rawContentPath === undefined) {
    // The "is this a private repository" check on the settings screen.
    return json({ id: 1, name: repo, full_name: `${owner}/${repo}`, private: true, default_branch: 'main' });
  }

  const segments = rawContentPath.split('/').filter(Boolean).map(decodeSegment);
  if (!segments.length || segments.some((segment) => !segment)) return json({ message: 'Not Found' }, 404);
  const path = segments.join('/');
  const ref = decodeSegment(parsed.searchParams.get('ref') || 'main') || 'main';
  const storePath = `${owner}/${repo}/${ref}/${path}`;

  if (method === 'PUT') {
    let body = {};
    try { body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}'); } catch { return json({ message: 'content (base64) is required' }, 422); }
    if (typeof body.content !== 'string') return json({ message: 'content (base64) is required' }, 422);
    const reply = parseNative(native.fileStore(JSON.stringify({ op: 'put', path: storePath, b64: body.content })));
    if (!reply.ok) return json({ message: `Local file storage error: ${reply.error}` }, 500);
    return json({ content: { name: segments[segments.length - 1], path, sha: reply.value.sha, size: reply.value.size } }, 201);
  }

  if (method === 'GET' || method === 'HEAD') {
    const reply = parseNative(native.fileStore(JSON.stringify({ op: 'get', path: storePath })));
    if (!reply.ok) return json({ message: `Local file storage error: ${reply.error}` }, 500);
    if (!reply.value.found) return json({ message: 'Not Found' }, 404);
    const bytes = base64ToBytes(reply.value.b64);
    return new Response(method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
    });
  }

  return json({ message: 'Method Not Allowed' }, 405);
}

function decodeSegment(segment) {
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('\0')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseNative(raw) {
  try {
    const parsed = JSON.parse(raw);
    return { ok: !parsed.error, value: parsed };
  } catch (error) {
    return { ok: false, value: null, error: String(error?.message ?? error) };
  }
}

/**
 * AES-256-GCM encrypt matching the Worker's encryptStorageToken byte for byte
 * (key = SHA-256(secret), 12-byte IV, WebCrypto-style tag appended).
 */
async function encryptToken(secret, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

/**
 * Configures the github_storage_settings row so the portal reports storage
 * ready, never overwriting settings an administrator deliberately saved.
 */
async function seedLocalStorageSettings(d1, encryptionSecret) {
  const owner = 'estate';
  const repository = 'local-files';
  const row = await d1.prepare('SELECT enabled, owner, repository, token_ciphertext FROM github_storage_settings WHERE id=?').bind('default').first();
  if (row && (row.enabled === 1 || row.token_ciphertext || (row.owner && row.owner !== owner))) return false;
  const token = `local-storage-${crypto.randomUUID().replaceAll('-', '')}`;
  const { ciphertext, iv } = await encryptToken(encryptionSecret, token);
  await d1.prepare(
    `INSERT INTO github_storage_settings(id,enabled,owner,repository,branch,base_path,token_ciphertext,token_iv,updated_by,updated_at)
     VALUES ('default',1,?,?,?,?,?,?, NULL, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET enabled=1,owner=excluded.owner,repository=excluded.repository,
       branch=excluded.branch,base_path=excluded.base_path,token_ciphertext=excluded.token_ciphertext,
       token_iv=excluded.token_iv,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).bind(owner, repository, 'main', 'uploads', ciphertext, iv).run();
  return true;
}

// ---------------------------------------------------------------- engine ---

export async function createOfflineEngine(native) {
  const log = (level, message) => {
    try { native.log(level, message); } catch { /* never fatal */ }
  };

  let config = {};
  try {
    config = JSON.parse(native.config());
  } catch (error) {
    log('error', `could not read the native config: ${error?.message ?? error}`);
    throw error;
  }
  const secrets = config.secrets ?? {};
  for (const key of ['jwtSecret', 'deviceIngestPepper', 'storageEncryptionKey']) {
    if (!secrets[key]) throw new Error(`native config is missing secrets.${key}`);
  }

  const d1 = createD1OverNative(native, log);
  // The Java side applies migrations before boot; prove the schema is there.
  await d1.prepare('SELECT 1 AS ok').first();

  const liveFeed = createLiveFeedNamespace(native);
  const env = {
    DB: d1,
    LIVE_FEED: liveFeed,
    ACCESS_EVENTS: null,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    APP_NAME: config.appName || 'EstateMate',
    ALLOWED_ORIGINS: config.allowedOrigins || '',
    HIKVISION_MODE: config.hikvisionMode || 'per-device',
    FILE_STORAGE_MODE: 'github-private-configurable',
    JWT_SECRET: secrets.jwtSecret,
    BOOTSTRAP_TOKEN: secrets.bootstrapToken || '',
    DEVICE_INGEST_PEPPER: secrets.deviceIngestPepper,
    STORAGE_ENCRYPTION_KEY: secrets.storageEncryptionKey,
  };

  const pending = new Set();
  const executionCtx = {
    waitUntil(promise) {
      const tracked = Promise.resolve(promise).catch((error) => log('error', `background task failed: ${error?.message ?? error}`));
      pending.add(tracked);
      tracked.finally(() => pending.delete(tracked));
      return tracked;
    },
    passThroughOnException() { /* advisory only */ },
  };

  const queue = createAccessEventsQueue({ getWorker: () => worker, getEnv: () => env, native, log });
  env.ACCESS_EVENTS = queue;

  if (config.fileStorage !== 'disabled') {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const local = await localGitHubFetch(url, init, native);
      if (local) return local;
      return realFetch(input, init);
    };
    try {
      await seedLocalStorageSettings(d1, secrets.storageEncryptionKey);
    } catch (error) {
      log('warn', `local storage could not be initialised: ${error?.message ?? error}`);
    }
  }

  /** Runs one /api request through the unmodified Worker. */
  async function handleRequest(request) {
    return worker.fetch(request, env, executionCtx);
  }

  /**
   * Java entry point: evaluateJavascript("EstateMateOffline.dispatch(id, json)").
   * The payload is {method,url,headers:[[k,v]...],bodyB64}; the reply comes
   * back through native.respond(id, status, headersJson, bodyB64).
   */
  async function dispatch(id, payloadJson) {
    try {
      const payload = JSON.parse(payloadJson);
      const headers = new Headers();
      for (const [name, value] of payload.headers ?? []) headers.append(name, value);
      const method = payload.method || 'GET';
      let body;
      if (method !== 'GET' && method !== 'HEAD' && payload.bodyB64) body = base64ToBytes(payload.bodyB64);
      const request = new Request(payload.url, { method, headers, body, redirect: 'manual' });
      const response = await handleRequest(request);

      const outHeaders = [];
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() === 'set-cookie') continue; // sent explicitly below
        outHeaders.push([name, value]);
      }
      if (typeof response.headers.getSetCookie === 'function') {
        for (const cookie of response.headers.getSetCookie()) outHeaders.push(['Set-Cookie', cookie]);
      }
      const bodyless = response.status === 204 || response.status === 304 || request.method === 'HEAD';
      const bytes = bodyless || !response.body ? null : new Uint8Array(await response.arrayBuffer());
      native.respond(id, response.status, JSON.stringify(outHeaders), bytes ? bytesToBase64(bytes) : '');
    } catch (error) {
      log('error', `dispatch ${id} failed: ${error?.message ?? error}`);
      const fallback = JSON.stringify({ error: 'Internal server error' });
      try {
        native.respond(id, 500, JSON.stringify([['Content-Type', 'application/json']]), bytesToBase64(new TextEncoder().encode(fallback)));
      } catch { /* the bridge itself is gone */ }
    }
  }

  let lastCronKey = null;
  async function tickCron() {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (key === lastCronKey) return;
    lastCronKey = key;
    try {
      await worker.scheduled({ cron: '15 * * * *', scheduledTime: Date.now() }, env, executionCtx);
      await Promise.allSettled([...pending]);
      log('info', 'hourly maintenance completed');
    } catch (error) {
      log('error', `hourly maintenance failed: ${error?.message ?? error}`);
    }
  }

  log('info', `offline engine ready (adapter ${ADAPTER_VERSION})`);
  return {
    version: ADAPTER_VERSION,
    dispatch,
    handleRequest,
    drainQueue: queue.drain,
    tickCron,
    stats: () => ({ queue: queue.stats() }),
  };
}

// ------------------------------------------------------------------- boot ---

// Expose the engine factory explicitly: an esbuild IIFE assigns its
// `globalName` var (which lands on globalThis in a browser classic script),
// but a module-context import — like the integration test — sees neither.
// This assignment works everywhere and is overwritten harmlessly by the
// equivalent esbuild exports object in the WebView.
globalThis.EstateMateOfflineModule = { createOfflineEngine, ADAPTER_VERSION };

// In the APK the Java side injects a global `Native` before this bundle loads;
// boot immediately and report readiness. Everywhere else (tests) the module
// stays dormant and createOfflineEngine is imported explicitly.
if (typeof globalThis.Native === 'object' && globalThis.Native !== null && typeof globalThis.Native.config === 'function') {
  const native = globalThis.Native;
  createOfflineEngine(native).then((engine) => {
    globalThis.EstateMateOffline = engine;
    try { native.onReady(engine.version); } catch { /* reported via log */ }
  }).catch((error) => {
    try { native.log('error', `engine boot failed: ${error?.message ?? error}`); } catch { /* nothing more we can do */ }
  });
}
