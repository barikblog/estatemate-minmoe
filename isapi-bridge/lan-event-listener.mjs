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
 * - **Ingest only.** It accepts an event document and answers 200. It never
 *   accepts an operation, a command or a configuration change, and it never
 *   answers with anything a caller could use to probe the estate.
 * - **Optional shared secret,** for a site that wants the terminal's requests
 *   authenticated. Hikvision's own event upload sends no credential of its own,
 *   so this is opt-in and off by default rather than a false sense of security.
 */

import { createServer } from 'node:http';
import { parseTerminalEvent } from './remote-verify.mjs';

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

  const stats = { received: 0, mapped: 0, unmapped: 0, rejected: 0, failed: 0, lastAt: null, lastError: null };

  const handler = (req, res) => {
    const finish = (status, body = '') => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (req.method !== 'POST') {
      // Some terminals probe with GET before uploading; answering 405 with the
      // allowed method keeps that from being logged as a failure.
      res.writeHead(405, { Allow: 'POST' });
      res.end('POST an event document');
      return;
    }
    if (requireKey && agentKey) {
      const presented = req.headers['x-estatemate-terminal-key'] ?? req.headers['x-estatemate-agent-key'];
      if (String(presented ?? '') !== agentKey) {
        stats.rejected += 1;
        log('warn', 'LAN event listener rejected an upload with a missing or wrong terminal key');
        return finish(401, 'unauthorized');
      }
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
        const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
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
  return handler;
}

/**
 * Starts the listener.
 *
 * Returns `{ server, port, address, stats, close }`. The port is whatever the
 * OS assigned when it was configured as 0, which is how the integration checks
 * and an installer avoid collisions.
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

  // The warning is the point. An operator who binds this to the LAN has opened a
  // port that a default Windows install will not let a terminal reach, and the
  // failure looks exactly like "the feature does not work".
  if (bindAddress !== '127.0.0.1' && bindAddress !== '::1' && bindAddress !== 'localhost') {
    log('warn', `LAN event listener is bound to ${bindAddress}:${port}. It is reachable from the device LAN, so keep the terminals and this host on the same VLAN and never forward this port to the internet. Windows needs an inbound rule before any terminal can reach it, e.g. netsh advfirewall firewall add rule name="EstateMate LAN events" dir=in action=allow protocol=TCP localport=${port} profile=private`);
  }

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
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
