#!/usr/bin/env node
/**
 * Hikvision SDK transport — the terminal's SDK/"server" port (8000 by default).
 *
 * This is the port iVMS-4200, Hik-Connect and the Hikvision batch tools speak.
 * It is a **proprietary binary protocol**, not HTTP and not ISAPI, so the only
 * legitimate client for it is Hikvision's own Device Network SDK (HCNetSDK:
 * `HCNetSDK.dll` on Windows, `libhcnetsdk.so` on Linux) — the same library
 * iVMS-4200 loads. This module does not reimplement that protocol and must never
 * try to: it drives a small helper process that links the vendor library, and it
 * speaks a narrow JSON-lines protocol to that helper over stdin/stdout.
 *
 *   agent.mjs ──JSON lines over pipes──▶ EstateMateHikSdk(.exe)
 *                                             │ HCNetSDK (vendor binaries)
 *                                             ▼ device SDK port 8000
 *
 * Why a helper process at all: HCNetSDK is native code with per-platform
 * binaries, its callback model is C function pointers, and a crash inside it must
 * not take the bridge with it. The helper is the only thing that links it, and it
 * can be restarted without touching the sync loop.
 *
 * What this transport can and cannot do (mirrored from what the vendor SDK
 * exposes for access-control terminals):
 *   - can: log in, read device info, receive access-control events (live gate
 *     history), open/close/always-open a door, read and set the terminal clock;
 *   - cannot: write cards or people. HCNetSDK has no card-record API — iVMS-4200
 *     provisions cards over ISAPI/HTTP itself. So a terminal that is *only*
 *     reachable on port 8000 gets live events and door control here, and its card
 *     and person changes stay operator tasks (or need an ISAPI path).
 *
 * Honesty rules this module keeps:
 *   - Capabilities are read from what the helper actually reports about the SDK
 *     build it loaded (which exports exist), never assumed. A helper that is
 *     missing, or an SDK build without the callback, produces an absent
 *     capability and a sentence an operator can act on — not a silent failure.
 *   - Every operation result carries the vendor's own error code verbatim.
 *   - Nothing here relaxes the public-endpoint rule: a device whose `sdkHost` is
 *     a public address still needs the acknowledgement in the devices file, and
 *     the risks that come with it (see network-access-control.mjs,
 *     docs/PUBLIC-ENDPOINT-DEVICE.md, docs/HIKVISION-SDK-TRANSPORT.md).
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const HELPER_PROTOCOL_VERSION = 1;
export const DEFAULT_SDK_PORT = 8000;

/** The vendor exports this transport needs, and what each one is for. */
export const REQUIRED_EXPORTS = {
  login: ['NET_DVR_Login_V40'],
  events: ['NET_DVR_SetDVRMessageCallBack_V50', 'NET_DVR_SetupAlarmChan_V41'],
  door: ['NET_DVR_ControlGateway'],
  clock: ['NET_DVR_GetDVRConfig', 'NET_DVR_SetDVRConfig'],
};

/**
 * The SDK endpoint a device entry points at, or null when the entry has no host.
 *
 * Two shapes arrive here, and the rule that serves both is "whatever the caller
 * spelled out wins, and the already-built endpoint fills in the rest":
 *
 *   - the devices-file entry (`sdkHost`/`sdkPort`/`sdkUsername`/`sdkPassword`);
 *   - a device the agent already normalised, whose endpoint arrives whole in
 *     `sdkEndpoint` — the raw `sdkUsername`/`sdkPassword` are gone by the time an
 *     operation is applied, so that object is the only carrier of the
 *     credentials, and it is also where a normalised `sdkHost`/`sdkPort` come
 *     from.
 *
 * The subtlety is the second half: an override must not be silently merged with
 * the stale combination it replaces. A caller that hands in a device with a
 * different `sdkPassword` (an operator command, a test with the wrong password)
 * must have the endpoint built from that password, not the one the endpoint
 * object was built with earlier.
 */
export function sdkEndpointFor(device = {}) {
  const normalised = device.sdkEndpoint?.host ? device.sdkEndpoint : null;
  const host = String(device.sdkHost ?? device.sdk_host ?? device.isapiHost ?? normalised?.host ?? '').trim();
  if (!host) return null;
  const raw = device.sdkPort ?? device.sdk_port ?? normalised?.port ?? device.isapiPort;
  const port = Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : DEFAULT_SDK_PORT;
  return {
    host,
    port,
    // `normalised` comes before the ISAPI names on purpose: the agent's
    // normalisation fills `isapiUsername` with its own default ('admin') and
    // `isapiPassword` with '' on every device, so those two would mask the
    // credentials the SDK endpoint already carries.
    username: String(device.sdkUsername ?? device.sdk_username ?? normalised?.username ?? device.isapiUsername ?? 'admin'),
    password: String(device.sdkPassword ?? device.sdk_password ?? normalised?.password ?? device.isapiPassword ?? ''),
  };
}

/**
 * Where the helper binary lives. The configured path wins; the bundled layout is
 * tried next so a standard install needs no configuration.
 */
export function resolveHelperPath({ configured = '', platform = process.platform, cwd = process.cwd(), execDir = '' } = {}) {
  const exeName = platform === 'win32' ? 'EstateMateHikSdk.exe' : 'EstateMateHikSdk';
  const candidates = [];
  if (configured) candidates.push(configured);
  for (const base of [execDir, cwd].filter(Boolean)) {
    candidates.push(join(base, 'hcnetsdk-helper', exeName));
    candidates.push(join(base, exeName));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return { path: resolve(candidate), tried: candidates };
    } catch { /* an unreadable path is simply not this candidate */ }
  }
  return { path: null, tried: candidates, expectedName: exeName };
}

/** The sentence an operator needs when the helper is not installed. */
export function describeHelperAbsence({ tried = [], expectedName = 'EstateMateHikSdk' } = {}) {
  return [
    `The Hikvision SDK helper (${expectedName}) is not installed, so terminals on the SDK transport cannot be reached.`,
    `Looked in: ${tried.join(', ')}`,
    'Build it from bridge-apps/windows/hcnetsdk (Windows: build-hcnetsdk-helper.cmd; Linux/macOS: dotnet build) after downloading',
    'Hikvision\'s Device Network SDK from hikvision.com, and point "hikSdk": { "helperPath": "..." } at the result, or leave the',
    'helper next to the agent in a folder called hcnetsdk-helper. See docs/HIKVISION-SDK-TRANSPORT.md.',
  ].join(' ');
}

/**
 * Normalises one access-control event from the helper into the same JSON
 * document shape a terminal's own alertStream produces.
 *
 * The Worker already parses that shape (`AccessControllerEvent` with
 * `cardNo`/`employeeNoString`/`subEventType`/`doorNo` and its XML twin), so an
 * SDK event becomes gate history through exactly the same normalisation pipeline
 * as an ISAPI event — one pipeline, not two. The vendor's own numbers ride along
 * so a later firmware pass can decode minor codes without the data being
 * reinvented, and an event the helper could not decode is still filed, marked
 * `sdkUnmapped`, exactly like the PUSH transport's unmapped uploads.
 */
export function hikAcsEventDocument(event = {}, device = {}, { now = () => new Date().toISOString() } = {}) {
  const endpoint = sdkEndpointFor(device);
  const body = {
    deviceName: device.name || event.deviceName || '',
    majorEventType: Number.isFinite(Number(event.major)) ? Number(event.major) : 5,
    // The vendor's own minor code, or the helper's description when it is sure
    // what the code means. EstateMate does not invent a verdict from a code it
    // has not verified: an event with an undecoded code files with the code in
    // sight (`sdkUnmapped`), never as a guess at "granted".
    subEventType: event.minorDescription ?? (Number.isFinite(Number(event.minor)) ? Number(event.minor) : ''),
    // The transport is recorded, so an operator reading gate history can tell an
    // SDK event from an alertStream event without guessing from the address.
    transport: 'hcnetsdk',
  };
  if (event.cardNo) body.cardNo = String(event.cardNo);
  if (event.employeeNo) body.employeeNoString = String(event.employeeNo);
  if (event.name) body.name = String(event.name);
  if (event.verifyMode) body.currentVerifyMode = String(event.verifyMode);
  if (Number.isFinite(Number(event.doorNo))) body.doorNo = Number(event.doorNo);
  if (Number.isFinite(Number(event.alarmType))) body.sdkAlarmType = Number(event.alarmType);
  if (Number.isFinite(Number(event.channel))) body.sdkChannel = Number(event.channel);
  if (event.raw) body.sdkRaw = String(event.raw).slice(0, 512);
  if (event.unmapped === true) body.sdkUnmapped = true;

  // Deliberately no `eventDescription`: the Worker reads the first of
  // `eventDescription`/`subEventType` as the event's description, so a generic
  // "AccessControllerEvent" there would hide the very code that carries the
  // meaning. This is the shape the repository's own parser tests cover.
  return JSON.stringify({
    EventNotificationAlert: {
      ipAddress: endpoint?.host || '',
      portNo: endpoint?.port ?? DEFAULT_SDK_PORT,
      protocol: 'HCNetSDK',
      channelID: Number.isFinite(Number(event.doorNo)) ? Number(event.doorNo) : 1,
      dateTime: event.dateTime || now(),
      activePostCount: 1,
      eventType: 'AccessControllerEvent',
      AccessControllerEvent: body,
    },
  });
}

/**
 * Vendor event codes the helper has decoded for this EstateMate release.
 *
 * Empty on purpose. Hikvision's ACS major/minor pairs are per-firmware and the
 * repository has no verified table (the same open item as the MinMoe minor-code
 * mapping — see README.md "Still model/account dependent"). An event therefore
 * arrives with its numeric code and files with an unknown verdict, which is a
 * feed, not a lie. When a code is verified against a terminal, add it here,
 * make the helper send `minorDescription`, and the Worker's granted/denied
 * patterns take over — nothing else changes.
 */
export const SDK_MINOR_DESCRIPTIONS = Object.freeze({});

/** The description for a vendor minor code, or null when it has not been verified. */
export function describeSdkMinor(minor, table = SDK_MINOR_DESCRIPTIONS) {
  return table[String(minor)] ?? null;
}

/**
 * The JSON-lines supervisor for the helper process.
 *
 * Requests carry an id and are answered in any order; anything the helper sends
 * without an id is an event. The helper is restarted on demand (never in a tight
 * loop) so a crashed SDK or a pulled plug does not need a service restart.
 */
export function createHikSdkTransport({
  helperPath = null,
  helperArgs = [],
  log = () => {},
  spawn = spawnChild,
  requestTimeoutMs = 20000,
  now = Date.now,
  maxLineBytes = 256 * 1024,
} = {}) {
  const pending = new Map();
  const sessions = new Map();
  const eventListeners = new Set();
  const stats = {
    restarts: 0,
    requests: 0,
    timeouts: 0,
    errors: 0,
    eventsReceived: 0,
    eventsForwarded: 0,
    eventsUnmapped: 0,
    doorCommands: 0,
    lastError: null,
    lastEventAt: null,
  };
  let child = null;
  let nextId = 1;
  let buffer = '';
  let probeResult = null;
  let starting = null;
  let stopped = false;

  const failAll = (reason) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };

  const handleLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // The helper must emit JSON per line; anything else is a bug worth knowing
      // about, not something to crash the bridge over.
      log('debug', `Hikvision SDK helper printed a non-JSON line: ${text.slice(0, 200)}`);
      return;
    }
    if (message.event) {
      stats.eventsReceived += 1;
      stats.lastEventAt = new Date(now()).toISOString();
      for (const listener of eventListeners) {
        try {
          listener(message.event);
        } catch (err) {
          log('warn', `SDK event listener failed: ${err.message}`);
        }
      }
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.fatal) {
        stats.lastError = String(message.fatal);
        log('error', `Hikvision SDK helper reported a fatal error: ${message.fatal}`);
      } else {
        log('debug', `Hikvision SDK helper message: ${text.slice(0, 200)}`);
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === false) entry.reject(new Error(message.error || `helper refused ${entry.op}`));
    else entry.resolve(message);
  };

  const attach = (proc) => {
    child = proc;
    buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > maxLineBytes * 4) buffer = buffer.slice(-maxLineBytes * 2);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf('\n');
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log('debug', `Hikvision SDK helper stderr: ${text.slice(0, 400)}`);
    });
    proc.on('error', (err) => {
      stats.errors += 1;
      stats.lastError = err.message;
      log('warn', `Hikvision SDK helper could not start: ${err.message}`);
      failAll(`helper could not start: ${err.message}`);
      child = null;
    });
    proc.on('exit', (code, signal) => {
      sessions.clear();
      child = null;
      probeResult = null;
      failAll(`helper exited (${signal || code})`);
      if (!stopped) log('warn', `Hikvision SDK helper exited (${signal || `code ${code}`}); sessions are dropped and will be re-established`);
    });
  };

  /** Spawns the helper and asks it what its SDK build can do. Idempotent. */
  async function start() {
    if (child) return probeResult;
    if (starting) return starting;
    if (stopped) return null;
    if (!helperPath) {
      const error = describeHelperAbsence();
      stats.lastError = error;
      return null;
    }
    starting = (async () => {
      stats.restarts += 1;
      const proc = spawn(helperPath, helperArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      attach(proc);
      try {
        const reply = await request('probe');
        probeResult = reply.sdk || { present: false, error: 'the helper did not report an SDK' };
        return probeResult;
      } catch (err) {
        stats.lastError = err.message;
        return null;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function request(op, payload = {}) {
    if (!child || !child.stdin.writable) return Promise.reject(new Error('the Hikvision SDK helper is not running'));
    const id = nextId;
    nextId += 1;
    stats.requests += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        stats.timeouts += 1;
        rejectPromise(new Error(`the Hikvision SDK helper did not answer "${op}" within ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, op });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        rejectPromise(err);
      }
    });
  }

  /** True when the loaded SDK build exports everything the given feature needs. */
  function supports(feature) {
    const needed = REQUIRED_EXPORTS[feature] || [];
    const exports = Array.isArray(probeResult?.exports) ? probeResult.exports : null;
    if (!exports) return false;
    return needed.every((name) => exports.includes(name));
  }

  function capabilityReport() {
    if (!probeResult || probeResult.present === false) {
      return {
        present: false,
        error: probeResult?.error || 'the Hikvision SDK helper is not running',
        events: false,
        door: false,
        clock: false,
        card: false, // never: see the module header
        person: false,
      };
    }
    return {
      present: true,
      sdkVersion: probeResult.version || null,
      helperVersion: probeResult.helperVersion || null,
      platform: probeResult.platform || null,
      library: probeResult.library || null,
      events: supports('events'),
      door: supports('door'),
      clock: supports('clock'),
      card: false,
      person: false,
    };
  }

  async function login(device) {
    const endpoint = sdkEndpointFor(device);
    if (!endpoint) return { ok: false, error: 'this device has no sdkHost to dial' };
    const existing = sessions.get(device.estateMateDeviceId);
    if (existing) return { ok: true, session: existing };
    try {
      const reply = await request('login', {
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        password: endpoint.password,
      });
      const session = {
        sessionId: reply.sessionId,
        deviceId: device.estateMateDeviceId,
        host: endpoint.host,
        port: endpoint.port,
        deviceInfo: reply.deviceInfo || null,
        openedAt: new Date(now()).toISOString(),
      };
      sessions.set(device.estateMateDeviceId, session);
      return { ok: true, session };
    } catch (err) {
      stats.errors += 1;
      stats.lastError = err.message;
      return { ok: false, error: err.message };
    }
  }

  async function logout(deviceId) {
    const session = sessions.get(deviceId);
    if (!session) return { ok: true };
    sessions.delete(deviceId);
    try {
      await request('logout', { sessionId: session.sessionId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Starts the vendor alarm channel, so the helper streams events to us. */
  async function subscribe(device) {
    // The build's own limitation is answered first: "this SDK cannot do it" is a
    // different, actionable fact from "the session is not up yet".
    if (!supports('events')) {
      return { ok: false, error: 'this Hikvision SDK build does not export the alarm-channel functions, so live events are unavailable; gate history stays on manual import for this terminal' };
    }
    const session = sessions.get(device.estateMateDeviceId);
    if (!session) return { ok: false, error: 'not logged in' };
    try {
      await request('events', { sessionId: session.sessionId, enabled: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function door(device, { action, doorNo = 1 } = {}) {
    if (!supports('door')) {
      return { ok: false, error: 'this Hikvision SDK build does not export NET_DVR_ControlGateway, so door control is unavailable over the SDK transport; the operation stays a manual task' };
    }
    const session = sessions.get(device.estateMateDeviceId);
    if (!session) return { ok: false, error: 'the bridge has no live session to this terminal; it reconnects on its own, retry shortly' };
    stats.doorCommands += 1;
    try {
      const reply = await request('door', { sessionId: session.sessionId, action, doorNo });
      return { ok: true, action, doorNo, deviceReply: reply.deviceReply ?? null };
    } catch (err) {
      stats.errors += 1;
      return { ok: false, error: err.message };
    }
  }

  async function clock(device, { action = 'get', isoTime = null } = {}) {
    if (!supports('clock')) {
      return { ok: false, error: 'this Hikvision SDK build does not export the time configuration functions' };
    }
    const session = sessions.get(device.estateMateDeviceId);
    if (!session) return { ok: false, error: 'not logged in' };
    try {
      const reply = await request('clock', { sessionId: session.sessionId, action, isoTime });
      return { ok: true, terminalTime: reply.terminalTime ?? null, driftMs: reply.driftMs ?? null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function onEvent(listener) {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  async function stop() {
    stopped = true;
    for (const deviceId of [...sessions.keys()]) await logout(deviceId).catch(() => {});
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, op: 'shutdown' })}\n`);
    } catch { /* the pipe may already be gone */ }
    const dying = child;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => { dying.kill('SIGKILL'); resolvePromise(); }, 2000);
      timer.unref?.();
      dying.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
  }

  return {
    start,
    stop,
    login,
    logout,
    subscribe,
    door,
    clock,
    onEvent,
    supports,
    capabilityReport,
    sessionFor: (deviceId) => sessions.get(deviceId) || null,
    sessions: () => [...sessions.values()],
    stats: () => ({ ...stats, sessions: sessions.size, running: Boolean(child) }),
    request,
    get running() { return Boolean(child); },
  };
}
