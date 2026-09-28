/**
 * AccessLiveFeed replacement for the offline server.
 *
 * On Cloudflare the live gate feed is a Durable Object holding browser
 * WebSockets, and the queue consumer fans batches out by POSTing to the
 * object's `/broadcast` endpoint. Node has no Durable Objects or
 * WebSocketPair, so this module provides the same two halves with the `ws`
 * package:
 *
 *   - a hub that owns the connected portal browsers (upgrade interception
 *     happens in server.mjs, after the Worker's own auth middleware has
 *     approved the session), and
 *   - a namespace shim exposing `idFromName()`/`get().fetch()` so the
 *     untouched Worker code can broadcast exactly as it does in production.
 *
 * The wire protocol is identical to the Durable Object: `{"type":"ready"}`
 * on connect, `ping` → `pong`, and broadcast payloads forwarded verbatim.
 */
import { WebSocketServer } from 'ws';

export class LiveFeedHub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();
  }

  /** Called by server.mjs once the HTTP server has approved an upgrade. */
  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws));
  }

  #attach(ws) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    ws.on('message', (data) => {
      if (data.toString() === 'ping') {
        try { ws.send('pong'); } catch { /* client went away */ }
      }
    });
    ws.send(JSON.stringify({ type: 'ready', at: new Date().toISOString() }));
  }

  /** Fan a batch payload out to every connected browser, ignoring dead ones. */
  broadcast(text) {
    let delivered = 0;
    for (const ws of this.clients) {
      try {
        ws.send(text);
        delivered += 1;
      } catch {
        this.clients.delete(ws);
      }
    }
    return delivered;
  }

  close() {
    for (const ws of this.clients) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* already closed */ }
    }
    this.clients.clear();
    this.wss.close();
  }
}

/**
 * The `LIVE_FEED` binding. `idFromName()` returns an opaque id object and
 * `get(id)` returns the stub whose `fetch()` understands the object's
 * internal `/broadcast` POST that `consumeAccessEvents` performs.
 */
export function createLiveFeedNamespace(hub) {
  const stub = {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
        const payload = await request.text();
        hub.broadcast(payload);
        return new Response(null, { status: 204 });
      }
      // Real WebSocket upgrades never reach the stub in Node — server.mjs
      // intercepts them at the HTTP layer after running Worker auth.
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
