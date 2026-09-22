export class AccessLiveFeed implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.getWebSockets().forEach((socket) => this.attach(socket));
  }

  private attach(socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      if (event.data === 'ping') socket.send('pong');
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      const payload = await request.text();
      for (const socket of this.state.getWebSockets()) {
        try { socket.send(payload); } catch { socket.close(1011, 'Broadcast failed'); }
      }
      return new Response(null, { status: 204 });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    this.attach(server);
    server.send(JSON.stringify({ type: 'ready', at: new Date().toISOString() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') socket.send('pong');
  }

  webSocketClose(_socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {}
  webSocketError(socket: WebSocket): void { socket.close(1011, 'Socket error'); }
}
