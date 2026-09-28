/**
 * Local-disk file storage for the offline server.
 *
 * In the cloud deployment, proof uploads and operation imports go to an
 * administrator-configured *private GitHub repository* through
 * `src/github-storage.ts` (D1 keeps only metadata). Offline there is no
 * GitHub to reach, so instead of forking the Worker this module serves the
 * small slice of the GitHub REST API that `github-storage.ts` uses — from
 * the server's own disk:
 *
 *   GET  /repos/{owner}/{repo}                      → repository check
 *   PUT  /repos/{owner}/{repo}/contents/{path}      → store file bytes
 *   GET  /repos/{owner}/{repo}/contents/{path}?ref= → read file bytes
 *
 * Every role check, size limit and audit trail still runs inside the Worker
 * code; only the byte store changes, and it lives under
 * `<dataDir>/storage/`. The portal's storage-settings screen keeps working
 * too (the "repository" it names is just a folder on the estate server).
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const API_HOST = 'https://api.github.com';

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

/** Decodes and validates a content path; returns segments or null. */
function safeSegments(rawPath) {
  try {
    return rawPath
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment))
      .filter((segment) => segment !== '.' && segment !== '..' && !segment.includes('\0'));
  } catch {
    return null;
  }
}

function safeJoin(root, segments) {
  const target = join(root, ...segments);
  const normalizedRoot = join(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) return null;
  return target;
}

/**
 * Installs the interceptor on globalThis.fetch. Must run before the Worker
 * module is imported. Non-GitHub requests pass through untouched.
 */
export function installLocalGitHubStorage({ rootDir, logger = console }) {
  const realFetch = globalThis.fetch.bind(globalThis);
  let intercepted = true;

  const localFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!intercepted || typeof url !== 'string' || !url.startsWith(`${API_HOST}/`)) {
      return realFetch(input, init);
    }
    try {
      return await handleGithubApiCall(url, init, rootDir);
    } catch (error) {
      logger.error('[storage] local file storage failed', error);
      return Response.json({ message: `Local file storage error: ${error?.message ?? error}` }, { status: 500 });
    }
  };

  globalThis.fetch = localFetch;
  return {
    uninstall() {
      intercepted = false;
      if (globalThis.fetch === localFetch) globalThis.fetch = realFetch;
    },
    realFetch,
  };
}

async function handleGithubApiCall(url, init, rootDir) {
  const parsed = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/.exec(parsed.pathname);
  if (!match) {
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  const [, encodedOwner, encodedRepo, rawContentPath] = match;
  const ownerSegments = safeSegments(encodedOwner);
  const repoSegments = safeSegments(encodedRepo);
  if (!ownerSegments || !repoSegments || ownerSegments.length !== 1 || repoSegments.length !== 1) {
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  const [owner] = ownerSegments;
  const [repo] = repoSegments;

  // GET /repos/{owner}/{repo} — the "is this a private repository" check.
  if (rawContentPath === undefined) {
    return Response.json({
      id: 1,
      name: repo,
      full_name: `${owner}/${repo}`,
      private: true,
      default_branch: 'main',
    }, { headers: { 'Content-Type': 'application/json' } });
  }

  const segments = safeSegments(rawContentPath);
  if (!segments || !segments.length) {
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  const ref = parsed.searchParams.get('ref') || 'main';
  const refSegment = safeSegments(ref);
  if (!refSegment || refSegment.some((segment) => segment === '.' || segment === '..')) {
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  const fileTarget = safeJoin(rootDir, [owner, repo, ...refSegment, ...segments]);
  if (!fileTarget) {
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }

  if (method === 'PUT') {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (typeof body.content !== 'string') {
      return Response.json({ message: 'content (base64) is required' }, { status: 422 });
    }
    const bytes = Buffer.from(body.content, 'base64');
    mkdirSync(dirname(fileTarget), { recursive: true });
    writeFileSync(fileTarget, bytes);
    return Response.json({
      content: {
        name: segments[segments.length - 1],
        path: segments.join('/'),
        sha: gitBlobSha(bytes),
        size: bytes.byteLength,
      },
      commit: { sha: gitBlobSha(bytes) },
    }, { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (method === 'GET' || method === 'HEAD') {
    if (!existsSync(fileTarget)) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    const bytes = new Uint8Array(readFileSync(fileTarget));
    return new Response(method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
      },
    });
  }

  return Response.json({ message: 'Method Not Allowed' }, { status: 405 });
}

/**
 * Configures the `github_storage_settings` row the Worker reads, so the
 * portal reports file storage as ready without an administrator having to
 * pretend to connect a real GitHub repository. The token is a placeholder
 * that is encrypted exactly like a real one; nothing ever authenticates with
 * it because api.github.com resolves to the local store above.
 *
 * A row an administrator has deliberately configured (storage enabled with
 * their own repository, or a real token recorded) is never overwritten —
 * the offline store simply reports whatever they chose.
 */
export async function seedLocalStorageSettings(d1, { encryptionSecret, owner = 'estate', repository = 'local-files', branch = 'main', basePath = 'uploads' }) {
  const row = await d1.prepare(
    `SELECT enabled, owner, repository, token_ciphertext FROM github_storage_settings WHERE id='default'`,
  ).first();
  const adminConfigured = row && (row.enabled === 1 || row.token_ciphertext || (row.owner && row.owner !== owner));
  if (adminConfigured) return false;

  const token = `local-storage-${createHash('sha256').update(encryptionSecret + repository).digest('hex').slice(0, 24)}`;
  const { ciphertext, iv } = await encryptToken(encryptionSecret, token);
  await d1.prepare(
    `INSERT INTO github_storage_settings(id,enabled,owner,repository,branch,base_path,token_ciphertext,token_iv,updated_by,updated_at)
     VALUES ('default',1,?,?,?,?,?,?, NULL, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET enabled=1,owner=excluded.owner,repository=excluded.repository,
       branch=excluded.branch,base_path=excluded.base_path,token_ciphertext=excluded.token_ciphertext,
       token_iv=excluded.token_iv,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).bind(owner, repository, branch, basePath, ciphertext, iv).run();
  return true;
}

/**
 * AES-256-GCM encrypt matching the Worker's `encryptStorageToken` byte for
 * byte: key = SHA-256(secret), 12-byte IV, WebCrypto-style tag appended, so
 * `decryptStorageToken` in the Worker code can read it back.
 */
export async function encryptToken(secret, token) {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64') };
}
