/**
 * LAN event listener: the terminal pushes, instead of the bridge pulling.
 *
 * The ISAPI alertStream is the better path and stays the default - it is an
 * *outbound* connection, so it needs no open port, no firewall rule and it works
 * on the Android bridge. But some terminals and some site configurations only
 * push: the device's own "HTTP Listening"/event-upload setting posts each event
 * to an address the installer types in. This listener is that address, on the
 * estate LAN.
 *
 * Because it is the one place in this agent that accepts a connection, it is
 * deliberately the most conservative code in the package:
 *
 * - **Off unless configured.** No port is opened by a default install.
 * - **Loopback by default.** Binding a LAN or wildcard address is an explicit
 *   configuration act, and starting that way prints the warning an operator
 *   needs about the firewall rule the installer does not create for them.
 * - **Source-address allowlist** (`allowedSources`, see
 *   `network-access-control.mjs`). When the agent can derive one — every
 *   terminal it serves has an address — everything outside it is refused before
 *   its body is read. This is the control that still works on a site whose
 *   router forwards a port inward and whose settings nobody can change: the
 *   forward is not removed, it simply stops being accepted by anything.
 * - **Ingest only.** It accepts an event document and answers 200. It never
 *   accepts an operation, a command or a configuration change, and it never
 *   answers with anything a caller could use to probe the estate.
 * - **Optional shared secret,** for a site that wants the terminal's requests
 *   authenticated. Hikvision's own event upload sends no credential of its own,
 *   so this is opt-in and off by default rather than a false sense of security.
 * - **A per-source rate limit,** so a port that is reachable from the Internet
 *   cannot be used to bury the bridge — and the estate's gates — in forged
 *   uploads. A forged event is not a hypothetical: with Remote Network
 *   Verification switched on for a terminal, an accepted event is a door
 *   decision, which is why the source of an event is the socket it arrived on
 *   and never the address the body claims.
 */

import { createServer } from 'node:http';
import { parseTerminalEvent } from './remote-verify.mjs';
import { assessBindAddress, createInboundAccessControl, normalizeSourceAddress } from './network-access-control.mjs';

/** A terminal event body larger than this is not an event. */
export const MAX_EVENT_BODY_BYTES = 256 * 1024;

/**
 * Builds the request handler.
 *
 * `resolveDevice({ ip, body, event })` maps an inbound request to one of this
 * agent's terminals - by source address against each device's ISAPI host, which
 * is the only identifier a pushing terminal reliably offers. Returning null is
 * normal and counted: an unmapped upload is a configuration gap to surface, not
 * an error to hide.
 *
 * `ip` is the address the connection actually arrived from. It is the only
 * input a caller may treat as an identity: `event.deviceIp` comes out of the
 * request body, so it is whatever the sender typed, and an upload that reaches
 * this port through a forwarded rule can name any terminal it likes. The
 * allowlist is applied to `ip` before the body is even read.
 *
 * Access-control options (`allowedSources`, `allowUnknownSources`,
 * `maxRequestsPerMinutePerSource`, or a pre-built `accessControl`) are passed
 * straight to `network-access-control.mjs`; `requireKey`/`agentKey` remain the
 * shared-secret switch and are honoured by the same controller.
 */
export function createLanEventHandler(options = {}) {
  const {
    resolveDevice,
    onEvent,
    log = () => {},
    requireKey = false,
    agentKey = '',
    maxBodyBytes = MAX_EVENT_BODY_BYTES,
  } = options;

  const stats = {
    received: 0, mapped: 0, unmapped: 0, rejected: 0, failed: 0,
    // Inbound access-control counters. `rejected` stays the shared-secret
    // refusal it always was, so an existing dashboard reading it keeps working;
    // the two new ones are what a forwarded port shows up as.
    deniedSource: 0, throttled: 0,
    lastAt: null, lastError: null,
  };

  const access = options.accessControl ?? createInboundAccessControl({
    name: 'LAN event listener',
    allowedSources: options.allowedSources ?? [],
    allowUnknownSources: Boolean(options.allowUnknownSources),
    allowLoopback: options.allowLoopback !== false,
    requireSecret: Boolean(requireKey),
    secret: String(agentKey ?? ''),
    maxRequestsPerMinutePerSource: options.maxRequestsPerMinutePerSource,
    log,
  });

  const handler = (req, res) => {
    const finish = (status, body = '') => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };

    // Decided before the method, before the secret and before a single byte of
    // the body is read: a caller from outside the allowlist gets the smallest
    // possible answer and learns nothing about what this port is for.
    const sourceIp = normalizeSourceAddress(req.socket?.remoteAddress);
    const decision = access.decide({ ip: sourceIp, headers: req.headers, url: req.url, method: req.method });
    if (!decision.allowed) {
      if (decision.code === 'deniedSecret') stats.rejected += 1;
      else if (decision.code === 'throttled') stats.throttled += 1;
      else stats.deniedSource += 1;
      stats.lastError = `refused ${decision.source}: ${decision.reason}`;
      if (decision.code === 'throttled') return finish(429, 'too many requests');
      if (decision.code === 'deniedSecret') return finish(401, 'unauthorized');
      return finish(403, 'forbidden');
    }

    if (req.method !== 'POST') {
      // Some terminals probe with GET before uploading; answering 405 with the
      // allowed method keeps that from being logged as a failure.
      res.writeHead(405, { Allow: 'POST' });
      res.end('POST an event document');
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        aborted = true;
        stats.failed += 1;
        // Answer first, then drop the connection: destroying the socket before
        // the response is written leaves the terminal with no status at all,
        // which looks like a dead bridge rather than a too-large document.
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('event too large', () => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => { /* the client went away; nothing to answer */ });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      stats.received += 1;
      stats.lastAt = new Date().toISOString();
      try {
        const event = parseTerminalEvent(raw, String(req.headers['content-type'] ?? ''));
        if (!event) {
          stats.failed += 1;
          stats.lastError = 'unparseable event document';
          log('warn', 'LAN event listener received a document with no card or employee number');
          return finish(400, 'no credential in event');
        }
        // The socket's source, normalised once at the top of the request: it is
        // the only address here that the sender did not choose for us.
        const ip = sourceIp;
        const device = resolveDevice?.({ ip, body: raw, event }) ?? null;
        if (!device) {
          stats.unmapped += 1;
          stats.lastError = `no terminal mapped to ${ip || 'an unknown source'}`;
          log('warn', `LAN event listener could not map an upload from ${ip || 'an unknown source'} to a terminal`);
          return finish(200, 'unmapped');
        }
        stats.mapped += 1;
        // Deliberately not awaited: answering the terminal quickly matters more
        // than the decision, and a slow door command must never hold the socket.
        Promise.resolve(onEvent?.({ device, event, raw, ip }))
          .catch((error) => {
            stats.failed += 1;
            stats.lastError = String(error?.message ?? error);
            log('warn', `LAN event handling failed for ${device.name}: ${stats.lastError}`);
          });
        return finish(200, 'ok');
      } catch (error) {
        stats.failed += 1;
        stats.lastError = String(error?.message ?? error);
        log('warn', `LAN event listener error: ${stats.lastError}`);
        return finish(500, 'error');
      }
    });
  };

  handler.stats = stats;
  /** The live controller, so the agent can report its policy and refusals. */
  handler.accessControl = access;
  return handler;
}

/**
 * Starts the listener.
 *
 * Returns `{ server, port, address, stats, accessControl, close }`. The port is
 * whatever the OS assigned when it was configured as 0, which is how the
 * integration checks and an installer avoid collisions.
 */
export function startLanEventListener(options = {}) {
  const log = options.log ?? (() => {});
  const handler = createLanEventHandler({ ...options, log });
  const server = createServer(handler);
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  const port = Number.isInteger(options.port) ? options.port : 8080;
  const bindAddress = String(options.bindAddress || '127.0.0.1');
  const bind = assessBindAddress({
    bindAddress,
    port,
    name: 'LAN event listener',
    enforcing: handler.accessControl.enforcing,
  });

  // The warning is the point. An operator who binds this to the LAN has opened a
  // port that a default Windows install will not let a terminal reach, and the
  // failure looks exactly like "the feature does not work".
  if (bind.reachableBeyondHost) {
    for (const warning of bind.warnings) log('warn', warning);
    log('warn', `LAN event listener is bound to ${bindAddress}:${port}. It is reachable from the device LAN, so keep the terminals and this host on the same VLAN and never forward this port to the internet; if a router rule you cannot change already forwards it, the source allowlist below is what refuses the traffic. Windows needs an inbound rule before any terminal can reach it, e.g. netsh advfirewall firewall add rule name="EstateMate LAN events" dir=in action=allow protocol=TCP localport=${port} profile=private`);
  }
  log(handler.accessControl.enforcing ? 'info' : 'warn', handler.accessControl.describe());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindAddress, () => {
      const address = server.address();
      log('info', `LAN event listener on ${bindAddress}:${address?.port ?? port} (ingest only)`);
      resolve({
        server,
        port: address?.port ?? port,
        address: bindAddress,
        stats: handler.stats,
        accessControl: handler.accessControl,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
