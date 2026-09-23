import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const workerOrigin = String(process.env.ESTATEMATE_WORKER_URL || 'https://estatemate.barikblog.workers.dev').replace(/\/$/, '');
const maxBody = 2 * 1024 * 1024;

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'EstateMate stateless access-event relay', workerOrigin });
  const match = /^\/v1\/events\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (request.method !== 'POST' || !match) return json(response, 404, { error: 'Route not found' });
  if (Number(request.headers['content-length'] || 0) > maxBody) return json(response, 413, { error: 'Payload too large' });

  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBody) request.destroy(new Error('Payload too large'));
    else chunks.push(chunk);
  });
  request.on('error', (error) => {
    if (!response.headersSent) json(response, error.message === 'Payload too large' ? 413 : 400, { error: error.message });
  });
  request.on('end', async () => {
    if (response.headersSent || size > maxBody) return;
    const upstream = new URL(`/api/hikvision/v1/events/${match[1]}`, workerOrigin);
    if (url.searchParams.has('key')) upstream.searchParams.set('key', url.searchParams.get('key'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const forwarded = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': request.headers['content-type'] || 'application/octet-stream',
          ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}),
          'User-Agent': 'EstateMate-Render-Bridge/1.0',
        },
        body: Buffer.concat(chunks),
        signal: controller.signal,
      });
      const body = Buffer.from(await forwarded.arrayBuffer());
      response.writeHead(forwarded.status, {
        'Content-Type': forwarded.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'X-EstateMate-Relay': 'render',
      });
      response.end(body);
    } catch (error) {
      json(response, 502, { error: error instanceof Error ? error.message : 'Upstream request failed' });
    } finally { clearTimeout(timeout); }
  });
});

server.listen(port, '0.0.0.0', () => console.log(`EstateMate access relay listening on ${port}; forwarding to ${workerOrigin}`));
