/**
 * Static portal serving for the offline server.
 *
 * Mirrors the wrangler.jsonc asset config (`run_worker_first: ["/api/*"]`,
 * `not_found_handling: "single-page-application"`): every non-`/api` GET/HEAD
 * is answered from the built React portal in `apps/web/dist`, falling back
 * to `index.html` for client-side routes. Hashed Vite assets under
 * `/assets/` are served immutable; everything else revalidates.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function responseWith(bytes, { status = 200, type, etag, cacheControl, length, headOnly }) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': cacheControl,
  };
  if (length !== undefined) headers['Content-Length'] = String(length);
  if (etag) {
    headers.ETag = etag;
    return new Response(headOnly || status === 304 ? null : bytes, { status, headers });
  }
  return new Response(headOnly ? null : bytes, { status, headers });
}

/**
 * Returns a Response for non-/api GET/HEAD requests, or null when the
 * request must go to the Worker API instead.
 */
export function createAssetServer(distDir) {
  const indexPath = join(distDir, 'index.html');
  const hasPortal = existsSync(indexPath);

  return function serveAssets(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;

    if (!hasPortal) {
      return Response.json(
        {
          error: 'The web portal has not been built yet.',
          hint: 'Run "npm run build:web" once (on the estate server or before copying it offline), then restart the server.',
        },
        { status: 503 },
      );
    }

    const headOnly = request.method === 'HEAD';
    const etagMatch = request.headers.get('if-none-match');

    let relative = '';
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      relative = '/';
    }
    relative = relative.replace(/^\/+/, '');
    if (relative.includes('\0') || relative.split('/').includes('..')) relative = '';

    // `relative` has no '..' or NUL segments by this point, so the join stays
    // inside distDir; anything that is not a real file falls back to the SPA.
    const candidate = normalize(join(distDir, relative));
    const isFile = relative !== '' && existsSync(candidate) && statSync(candidate).isFile();

    const filePath = isFile ? candidate : indexPath;
    const stat = statSync(filePath);
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const cacheControl = isFile && url.pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    if (etagMatch === etag) {
      return responseWith(null, { status: 304, type: 'text/plain', cacheControl, etag });
    }

    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const bytes = new Uint8Array(readFileSync(filePath));
    return responseWith(bytes, { type, cacheControl, etag, length: bytes.byteLength, headOnly });
  };
}
