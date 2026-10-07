/**
 * HTTP listener for the ZKTeco PUSH (ADMS) transport.
 *
 * Separated from `zkteco-push.mjs` (the codec) so the codec can be exercised
 * without a socket, and so this file's only job is the state a real terminal
 * forces on you: sessions, the devices that are allowed to talk to us, and the
 * correlation between a command we queued and the `Return=` that comes back some
 * seconds later, on a request the *terminal* chose to make.
 *
 * SECURITY MODEL — read before exposing anything.
 * The PUSH protocol has no authentication of its own between an unknown terminal
 * and a server. That is acceptable on a LAN and dangerous anywhere else, so:
 *   - this binds to loopback or the LAN interface, never a public address;
 *   - `requireAgentKey` (below) is the one knob that adds a shared secret, for
 *     firmwares that send it;
 *   - an unrecognised serial is never given a command, only `OK`.
 * This is the same boundary rule EstateMate already applies to ISAPI: keep the
 * access devices and the bridge on one VLAN and do not publish either.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  accessEventDocument,
  buildCommandBody,
  buildRegistrationConfig,
  createCommandQueue,
  encodeUserDelete,
  encodeUserUpdate,
  parseDataRecords,
  parseRegistryBody,
  validateTerminalPin,
} from './zkteco-push.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** A command whose `Return=` never arrived is reported as this, not as success. */
export const ACK_TIMEOUT_ERROR =
  'the terminal has not confirmed this command; it is still queued for its next poll (a ZKTeco terminal only collects commands when it calls the server, so an offline terminal shows this until it returns)';

export function createZktecoPushHandler(options = {}) {
  const {
    log = () => {},
    resolveDevice,
    onEvent,
    onDeviceInfo,
    requireAgentKey = false,
    agentKey = null,
    ackTimeoutMs = 180000,
  } = options;

  const queue = createCommandQueue();
  /** serial -> device state */
  const devices = new Map();
  /** `${serial}:${id}` -> resolver, for a caller awaiting a terminal's Return= */
  const awaiting = new Map();
  const stats = {
    requests: 0,
    unmapped: 0,
    rejectedKey: 0,
    events: 0,
    registrations: 0,
    commandsSent: 0,
    commandsConfirmed: 0,
    commandsTimedOut: 0,
  };

  const newCode = () => randomBytes(16).toString('hex');

  function remember(serial, patch) {
    const key = String(serial).trim();
    const current = devices.get(key) ?? { serial: key, options: {}, commands: 0 };
    const next = { ...current, ...patch, lastSeenAt: Date.now() };
    devices.set(key, next);
    return next;
  }

  /**
   * Which EstateMate device a serial belongs to. `resolveDevice` is the agent's
   * own view (its devices file / the portal's linked list), so this module never
   * holds a device table of its own that could drift from the portal's.
   */
  function deviceFor(serial) {
    const state = devices.get(String(serial).trim());
    const resolved = resolveDevice ? resolveDevice(serial, state?.options ?? {}) : null;
    return { state, resolved };
  }

  function reply(res, status, body, headers = {}) {
    const payload = body ?? '';
    res.writeHead(status, {
      // The vendor examples show Content-Type text/plain bodies for the config
      // and `application/push` for the request headers; terminals parse the
      // bytes, not the media type, so plain text is what they are given.
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        // A terminal is not the attacker here, but a half-written 200 MB photo
        // upload must not be able to take the bridge down with it.
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** §7.4 registration, and the same key=value body some firmwares POST to cdata. */
  function absorbDeviceInfo(serial, body) {
    const parsed = parseRegistryBody(body);
    if (!Object.keys(parsed).length) return null;
    const device = remember(serial, { options: { ...(devices.get(serial)?.options ?? {}), ...parsed }, pushProtocol: parsed.PushVersion ?? parsed.pushver ?? devices.get(serial)?.pushProtocol });
    stats.registrations += 1;
    const { resolved } = deviceFor(serial);
    log('info', `ZKTeco terminal ${serial} reported ${Object.keys(parsed).length} parameter(s)` +
      `${parsed.DeviceName ? ` (${parsed.DeviceName})` : ''}${parsed.MachineType ? ` model ${parsed.MachineType}` : ''}` +
      `${resolved ? `, linked to ${resolved.name}` : ', which no configured device matches yet'}`);
    if (onDeviceInfo) {
      Promise.resolve(onDeviceInfo(serial, parsed, device)).catch((err) => log('warn', `device info handler failed: ${err.message}`));
    }
    return device;
  }

  function confirmCommand(serial, params, body) {
    // §10.4 puts the result in the query string and, on some firmwares, in the
    // body; a batch arrives as several lines. Accept both, as the
    // field-confirmed implementations do.
    const records = [];
    if (params.get('ID') || params.get('Return')) records.push(Object.fromEntries(params.entries()));
    for (const line of String(body ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      const record = {};
      for (const pair of trimmed.split('&')) {
        const index = pair.indexOf('=');
        if (index > 0) record[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
      }
      if (record.ID || record.Return) records.push(record);
    }

    for (const record of records) {
      const result = queue.confirm(serial, { id: record.ID, returnCode: record.Return, command: record.CMD });
      if (!result.matched) {
        log('debug', `ZKTeco terminal ${serial} reported a command result we have no queue entry for (ID=${record.ID}, Return=${record.Return})`);
        continue;
      }
      stats.commandsConfirmed += 1;
      const ok = result.returnCode === 0;
      log(ok ? 'info' : 'warn', `ZKTeco command ${result.id} on ${serial}: ${result.meaning}${result.meta?.operation ? ` (${result.meta.operation})` : ''}`);
      const waiter = awaiting.get(`${serial}:${result.id}`);
      if (waiter) {
        awaiting.delete(`${serial}:${result.id}`);
        clearTimeout(waiter.timer);
        waiter.resolve({ ok, returnCode: result.returnCode, meaning: result.meaning, waitedMs: result.waitedMs, meta: result.meta });
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    const serial = (url.searchParams.get('SN') ?? url.searchParams.get('sn') ?? '').trim();
    stats.requests += 1;

    if (!path.startsWith('/iclock/')) {
      // Anything else is not ours. 404 (rather than a redirect or a landing
      // page) keeps a mis-typed terminal URL failing loudly in its own log.
      reply(res, 404, 'notfound\n');
      return;
    }

    if (requireAgentKey) {
      const presented = url.searchParams.get('Key') ?? req.headers['x-estatemate-key'] ?? '';
      if (!agentKey || String(presented).trim() !== String(agentKey).trim()) {
        stats.rejectedKey += 1;
        reply(res, 403, 'unauthorized\n');
        return;
      }
    }

    // Every /iclock/ call except the very first connection carries an SN.
    if (!serial) {
      reply(res, 400, 'missing SN\n');
      return;
    }

    const body = req.method === 'POST' ? await readBody(req) : '';

    if (path === '/iclock/cdata' && req.method === 'GET' && (url.searchParams.get('options') ?? '').toLowerCase() === 'all') {
      // §7.1 initial interaction. Registered -> the registry code plus the
      // configuration; unknown -> `OK`, which is the doc's answer and tells the
      // terminal to go and register.
      const known = devices.get(serial);
      const { resolved } = deviceFor(serial);
      if (known?.registryCode && resolved) {
        reply(res, 200, `${buildRegistrationConfig({ registryCode: known.registryCode, sessionId: known.sessionId ?? randomBytes(8).toString('hex') })}\n`);
        return;
      }
      reply(res, 200, 'OK\n');
      return;
    }

    if (path === '/iclock/registry' || (path === '/iclock/cdata' && req.method === 'POST' && !url.searchParams.get('table'))) {
      // §7.4. Some firmwares register on cdata with no table= instead.
      const device = absorbDeviceInfo(serial, body) ?? remember(serial, {});
      if (!device.registryCode) {
        remember(serial, { registryCode: newCode(), sessionId: randomBytes(8).toString('hex') });
      }
      reply(res, 200, 'OK\n');
      return;
    }

    if (path === '/iclock/ping') {
      // Heartbeat (§9). Answering `OK` is the whole contract; a non-OK answer
      // makes the terminal back off and re-register.
      remember(serial, {});
      reply(res, 200, 'OK\n');
      return;
    }

    if (path === '/iclock/cdata' && req.method === 'POST') {
      const table = (url.searchParams.get('table') ?? '').trim().toUpperCase();
      const records = parseDataRecords(body);
      const { resolved } = deviceFor(serial);
      if (!resolved) {
        // The terminal is talking to us but nothing here owns it. Dropping the
        // records silently would leave an estate believing its gate events are
        // flowing, so this is counted and said out loud.
        stats.unmapped += records.length;
        log('warn', `ZKTeco terminal ${serial} uploaded ${records.length} ${table || 'unknown'} record(s), but no configured device claims that serial; nothing was recorded. Add pushSerial="${serial}" to the device entry.`);
        reply(res, 200, 'OK\n');
        return;
      }
      remember(serial, { estateMateDeviceId: resolved.estateMateDeviceId });
      for (const record of records) {
        if (table && table !== 'ATTLOG' && table !== 'OPERLOG' && table !== 'USERINFO') {
          log('debug', `ZKTeco terminal ${serial} uploaded table=${table}, which EstateMate does not ingest yet; the record is not stored`);
          continue;
        }
        if (table === 'USERINFO') {
          // What the terminal holds for one person. Useful, and never a
          // credential to invent: recorded on the device state only.
          remember(serial, { lastUserInfo: record });
          continue;
        }
        if (table === 'OPERLOG') {
          // A user was added/removed on the terminal's own menu. EstateMate
          // does not mirror terminal-side enrollment yet, so say so once per
          // record rather than pretending the event is a gate event.
          log('info', `ZKTeco terminal ${serial} logged an operator action (OPERLOG); EstateMate records gate events only, so this was not stored`);
          continue;
        }
        const document = accessEventDocument(record);
        stats.events += 1;
        if (onEvent) {
          try {
            onEvent(resolved.estateMateDeviceId, JSON.stringify(document));
          } catch (err) {
            log('warn', `could not queue a gate event from ${serial}: ${err.message}`);
          }
        }
      }
      reply(res, 200, 'OK\n');
      return;
    }

    if (path === '/iclock/getrequest') {
      // §11.1. The terminal is asking for work: this is the only moment a
      // command can reach it. `expireDelivered` first, so a terminal that fetched
      // a command and died is not left holding the portal's attention forever.
      for (const expired of queue.expireDelivered(serial, ackTimeoutMs)) {
        const waiter = awaiting.get(`${serial}:${expired.id}`);
        if (waiter) {
          awaiting.delete(`${serial}:${expired.id}`);
          clearTimeout(waiter.timer);
          waiter.resolve({ ok: false, error: ACK_TIMEOUT_ERROR, meta: expired.meta });
          stats.commandsTimedOut += 1;
        }
      }
      const lines = queue.take(serial);
      stats.commandsSent += lines ? lines.split('\n').filter(Boolean).length : 0;
      remember(serial, {});
      reply(res, 200, buildCommandBody(lines));
      return;
    }

    if (path === '/iclock/devicecmd') {
      confirmCommand(serial, url.searchParams, body);
      reply(res, 200, 'OK\n');
      return;
    }

    // A /iclock/ path this bridge does not implement (photo upload, dispatch of
    // HR data, upgrade). Answering OK keeps the terminal's own loop healthy
    // while the missing feature is recorded rather than silently half-working.
    log('debug', `ZKTeco terminal ${serial} requested ${path}, which this bridge does not implement; answered OK without storing anything`);
    reply(res, 200, 'OK\n');
  }

  function queueForSerial(serial, command, meta) {
    return queue.queue(serial, command, meta);
  }

  /**
   * Waits for the terminal's `Return=` for one command. Resolves rather than
   * rejecting on failure: a refused write is a normal outcome at an access
   * terminal and the caller turns it into an operation result.
   */
  function awaitConfirm(serial, id, timeoutMs = ackTimeoutMs) {
    return new Promise((resolve) => {
      const key = `${serial}:${id}`;
      const timer = setTimeout(() => {
        awaiting.delete(key);
        resolve({ ok: false, error: ACK_TIMEOUT_ERROR });
      }, timeoutMs);
      timer.unref?.();
      awaiting.set(key, { resolve, timer });
    });
  }

  return {
    handle,
    stats,
    devices,
    queue: queueForSerial,
    depth: (serial) => queue.depth(serial),
    awaitConfirm,
    /** What the terminal told us about itself, which is where StringPinFunOn lives. */
    optionsFor: (serial) => devices.get(String(serial).trim())?.options ?? {},
    noteDevice: remember,
  };
}

/* ------------------------------------------------------------------------- *
 * Operations -> commands
 * ------------------------------------------------------------------------- */

/**
 * What the PUSH transport can and cannot be asked to do, and why.
 *
 * Everything the terminal reports back is asynchronous, so a returned
 * `{ success: false }` here is a real answer, and `{ success: true }` means the
 * terminal itself said `Return=0` — never merely "we sent something".
 *
 * Card-only removal is deliberately refused. `DATA DELETE USERINFO` takes the
 * person's **finger and face templates with them** (§12.1.2: "To delete
 * specified user information, including fingerprint template, face template and
 * user photo"), so turning "take this resident's lost card off the gate" into a
 * user delete would silently revoke a whole identity — the same class of mistake
 * as substituting a guessed employee number, and one an operator cannot undo
 * from the portal. EstateMate keeps the queued task visible instead, with this
 * message on it.
 */
export async function applyPushOperation({ handler, serial, operation, employeeNo, log = () => {}, awaitAck = true, ackTimeoutMs }) {
  const payload = operation.payload ?? {};
  const op = operation.operation;
  const options = handler.optionsFor(serial);

  const build = () => {
    if (op === 'upsert_person') {
      const pin = validateOrPin(employeeNo, options);
      if (!pin.ok) return pin;
      return {
        command: encodeUserUpdate(pin.pin, {
          name: payload.name ?? payload.personName,
          privilege: payload.privilege,
          // The card travels on the person record in this protocol: there is no
          // separate card table to write.
          card: payload.cardUid ?? payload.cardNo ?? payload.card_number,
          enabled: payload.enabled !== false,
        }),
        requiresCard: false,
      };
    }
    if (op === 'upsert_card' || op === 'enable_card' || op === 'upsert_visitor') {
      const card = payload.cardUid ?? payload.cardNo ?? payload.card_number ?? payload.credentialNumber;
      if (!card) return { error: 'operation has no card number' };
      const pin = validateOrPin(employeeNo, options);
      if (!pin.ok) return pin;
      return { command: encodeUserUpdate(pin.pin, { name: payload.name ?? payload.personName, card, enabled: true }) };
    }
    if (op === 'delete_person') {
      const pin = validateOrPin(employeeNo, options);
      if (!pin.ok) return pin;
      return { command: encodeUserDelete(pin.pin) };
    }
    if (op === 'disable_card' || op === 'delete_card' || op === 'revoke_visitor') {
      return { error: 'this terminal\'s PUSH protocol has no card-only delete: a card lives on the person record, and the delete command removes the person\'s fingerprints and face template with it. Remove the person from the terminal to revoke their credentials, or leave this task queued for an operator at the device.' };
    }
    if (op === 'upload_fingerprint' || op === 'delete_fingerprint_device' || op === 'capture_fingerprint') {
      return { error: 'fingerprint work is not carried by this terminal\'s PUSH protocol in this bridge; the terminal\'s own reader and menu remain the way to enrol or clear a finger' };
    }
    if (String(op).startsWith('remote_')) {
      return { error: 'remote door control is not delivered over the PUSH transport by this bridge: the command this protocol documents (CONTROL BOARD) has not been confirmed against a physical terminal, and EstateMate does not send an unproven gate command' };
    }
    return { error: `the ZKTeco PUSH transport does not implement "${op}"` };
  };

  let prepared;
  try {
    prepared = build();
  } catch (err) {
    // A field the record format cannot hold (a name carrying a line break, for
    // instance) is refused here rather than rewritten, so the portal and the
    // terminal can never disagree about who a credential belongs to.
    return { success: false, error: err.message };
  }
  if (prepared.error) return { success: false, error: prepared.error };

  const queued = handler.queue(serial, prepared.command, { operation: op, employeeNo });
  if (!queued.queued) return { success: false, error: queued.error };
  if (!awaitAck) {
    return { success: true, result: { queued: true, commandId: queued.id, transport: 'zkteco_push', note: 'the terminal collects this command on its next poll; the result is recorded when it answers' } };
  }
  const ack = await handler.awaitConfirm(serial, queued.id, ackTimeoutMs);
  if (!ack.ok) {
    return { success: false, error: ack.error ?? `the terminal answered "${ack.meaning ?? 'without success'}" for this command`, result: { commandId: queued.id, returnCode: ack.returnCode ?? null, waitedMs: ack.waitedMs ?? null } };
  }
  return { success: true, result: { commandId: queued.id, returnCode: 0, transport: 'zkteco_push', acknowledgedBy: serial } };
}

/** The numeric-PIN gate, kept in one place so no operation can skip it. */
function validateOrPin(employeeNo, options) {
  const result = validateTerminalPin(employeeNo, options);
  return result.ok ? result : { error: result.error };
}

/**
 * Starts the listener. `bindAddress` defaults to loopback: pointing a terminal at
 * a bridge on another host means setting it deliberately, and the log says so.
 */
export function startZktecoPushServer({ port = 8089, bindAddress = '127.0.0.1', ...handlerOptions } = {}) {
  const handler = createZktecoPushHandler(handlerOptions);
  const server = createServer((req, res) => {
    handler.handle(req, res).catch((err) => {
      handler.stats.errors = (handler.stats.errors ?? 0) + 1;
      handlerOptions.log?.('warn', `ZKTeco push request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('error\n');
    });
  });

  let listening = false;
  server.on('error', (err) => {
    handlerOptions.log?.('error', `ZKTeco push listener could not bind ${bindAddress}:${port}: ${err.code || err.message}` +
      (err.code === 'EADDRINUSE' ? ' — something else owns that port; the terminals will keep trying to reach it' : ''));
  });
  server.on('listening', () => {
    listening = true;
    const address = server.address();
    handlerOptions.log?.('info', `ZKTeco PUSH listener on http://${address?.address ?? bindAddress}:${address?.port ?? port}/iclock/ — point the terminal's Cloud Server / ADMS settings at this address and port`);
    if (bindAddress === '0.0.0.0' || bindAddress === '::') {
      handlerOptions.log?.('warn', 'ZKTeco PUSH listener is on every interface. The protocol has no authentication: keep this address inside the estate LAN and never publish it (see AGENTS.md).');
    }
  });

  server.listen(port, bindAddress);

  return {
    handler,
    server,
    isListening: () => listening,
    address: () => server.address(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
