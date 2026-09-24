import type { Env } from './types';

export const MAX_GITHUB_FILE_SIZE = 4 * 1024 * 1024;

export interface GitHubStorageSettings {
  enabled: boolean;
  owner: string;
  repository: string;
  branch: string;
  basePath: string;
  tokenConfigured: boolean;
  updatedAt: string | null;
}

interface StoredSettingsRow {
  enabled: number;
  owner: string;
  repository: string;
  branch: string;
  base_path: string;
  token_ciphertext: string | null;
  token_iv: string | null;
  updated_at: string | null;
}

interface ActiveStorageConfig {
  owner: string;
  repository: string;
  branch: string;
  basePath: string;
  token: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function cryptoKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('STORAGE_ENCRYPTION_KEY is not configured');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptStorageToken(secret: string, token: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(secret), new TextEncoder().encode(token));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptStorageToken(secret: string, ciphertext: string, iv: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    await cryptoKey(secret),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

function storageEncryptionSecret(env: Env): string {
  // An independent key is strongly preferred. JWT_SECRET keeps existing deployments
  // operable until the administrator can add STORAGE_ENCRYPTION_KEY.
  return env.STORAGE_ENCRYPTION_KEY || env.JWT_SECRET;
}

async function storageRow(db: D1Database): Promise<StoredSettingsRow | null> {
  return db.prepare(
    `SELECT enabled,owner,repository,branch,base_path,token_ciphertext,token_iv,updated_at FROM github_storage_settings WHERE id='default'`,
  ).first<StoredSettingsRow>();
}

export async function publicStorageSettings(db: D1Database): Promise<GitHubStorageSettings> {
  const row = await storageRow(db);
  return {
    enabled: row?.enabled === 1,
    owner: row?.owner ?? '',
    repository: row?.repository ?? '',
    branch: row?.branch ?? 'main',
    basePath: row?.base_path ?? 'uploads',
    tokenConfigured: Boolean(row?.token_ciphertext && row?.token_iv),
    updatedAt: row?.updated_at ?? null,
  };
}

async function activeStorageConfig(env: Env): Promise<ActiveStorageConfig> {
  const row = await storageRow(env.DB);
  if (!row || row.enabled !== 1) throw new Error('Private GitHub storage is not enabled');
  if (!row.owner || !row.repository || !row.token_ciphertext || !row.token_iv) throw new Error('Private GitHub storage is not fully configured');
  return {
    owner: row.owner,
    repository: row.repository,
    branch: row.branch || 'main',
    basePath: row.base_path || 'uploads',
    token: await decryptStorageToken(storageEncryptionSecret(env), row.token_ciphertext, row.token_iv),
  };
}

function githubHeaders(token: string, accept = 'application/vnd.github+json'): HeadersInit {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'EstateMate-Worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoUrl(config: Pick<ActiveStorageConfig, 'owner'|'repository'>, suffix = ''): string {
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}${suffix}`;
}

function contentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function verifyPrivateRepository(owner: string, repository: string, token: string): Promise<{ private: boolean; defaultBranch: string }> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) throw new Error(response.status === 404 ? 'GitHub repository not found or token access was denied' : `GitHub returned ${response.status} while checking the repository`);
  const data = await response.json<{ private?: boolean; default_branch?: string }>();
  if (!data.private) throw new Error('The configured GitHub storage repository must be private');
  return { private: true, defaultBranch: data.default_branch ?? 'main' };
}

export async function saveStorageSettings(
  env: Env,
  actorId: string,
  input: { enabled: boolean; owner: string; repository: string; branch: string; basePath: string; accessToken?: string },
): Promise<GitHubStorageSettings> {
  const owner = input.owner.trim();
  const repository = input.repository.trim();
  const branch = input.branch.trim() || 'main';
  const basePath = input.basePath.trim().replace(/^\/+|\/+$/g, '') || 'uploads';
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) throw new Error('GitHub owner is invalid');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error('GitHub repository is invalid');
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.includes('..')) throw new Error('GitHub branch is invalid');
  if (!/^[A-Za-z0-9._\/-]{1,300}$/.test(basePath) || basePath.includes('..')) throw new Error('GitHub base path is invalid');

  const current = await storageRow(env.DB);
  let ciphertext = current?.token_ciphertext ?? null;
  let iv = current?.token_iv ?? null;
  let token = '';
  if (input.accessToken?.trim()) {
    token = input.accessToken.trim();
    const encrypted = await encryptStorageToken(storageEncryptionSecret(env), token);
    ciphertext = encrypted.ciphertext;
    iv = encrypted.iv;
  } else if (ciphertext && iv) {
    token = await decryptStorageToken(storageEncryptionSecret(env), ciphertext, iv);
  }
  if (input.enabled && !token) throw new Error('A GitHub access token is required before storage can be enabled');
  if (input.enabled) await verifyPrivateRepository(owner, repository, token);

  await env.DB.prepare(
    `INSERT INTO github_storage_settings(id,enabled,owner,repository,branch,base_path,token_ciphertext,token_iv,updated_by,updated_at)
     VALUES ('default',?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,owner=excluded.owner,repository=excluded.repository,
       branch=excluded.branch,base_path=excluded.base_path,token_ciphertext=excluded.token_ciphertext,
       token_iv=excluded.token_iv,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).bind(input.enabled ? 1 : 0, owner, repository, branch, basePath, ciphertext, iv, actorId).run();
  return publicStorageSettings(env.DB);
}

function cleanFilename(filename: string): string {
  const cleaned = filename.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-120);
  return cleaned || 'upload.bin';
}

export async function uploadToPrivateGitHub(
  env: Env,
  input: {
    body: ArrayBuffer;
    originalName: string;
    contentType: string;
    uploadedBy: string;
    category?: string;
    linkedEntityType?: string;
    linkedEntityId?: string;
  },
): Promise<{ key: string; filename: string; contentType: string; size: number }> {
  const bytes = new Uint8Array(input.body);
  if (!bytes.byteLength || bytes.byteLength > MAX_GITHUB_FILE_SIZE) throw new Error(`File must be between 1 byte and ${MAX_GITHUB_FILE_SIZE / 1024 / 1024} MB`);
  const config = await activeStorageConfig(env);
  const id = crypto.randomUUID();
  const datePath = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  const filename = cleanFilename(input.originalName);
  const path = `${config.basePath}/${input.category ?? 'general'}/${datePath}/${id}-${filename}`;
  const response = await fetch(repoUrl(config, `/contents/${contentPath(path)}`), {
    method: 'PUT',
    headers: { ...githubHeaders(config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Store ${input.category ?? 'general'} upload ${id}`,
      content: bytesToBase64(bytes),
      branch: config.branch,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error('GitHub upload failed', response.status, detail.slice(0, 500));
    throw new Error(`GitHub storage upload failed (${response.status})`);
  }
  const result = await response.json<{ content?: { sha?: string } }>();
  const sha = result.content?.sha;
  if (!sha) throw new Error('GitHub storage did not return a file identifier');
  const key = `github/${id}`;
  await env.DB.prepare(
    `INSERT INTO stored_files(id,storage_key,github_owner,github_repository,github_branch,github_path,github_sha,original_name,content_type,size_bytes,uploaded_by,category,linked_entity_type,linked_entity_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, key, config.owner, config.repository, config.branch, path, sha, filename, input.contentType, bytes.byteLength, input.uploadedBy, input.category ?? 'general', input.linkedEntityType ?? null, input.linkedEntityId ?? null).run();
  return { key, filename, contentType: input.contentType, size: bytes.byteLength };
}

export async function downloadFromPrivateGitHub(
  env: Env,
  storageKey: string,
  requester: { id: string; role: string },
): Promise<Response | null> {
  const file = await env.DB.prepare(
    `SELECT storage_key,github_owner,github_repository,github_branch,github_path,original_name,content_type,size_bytes,uploaded_by,category FROM stored_files WHERE storage_key=? AND status='active'`,
  ).bind(storageKey).first<{ storage_key: string; github_owner: string; github_repository: string; github_branch: string; github_path: string; original_name: string; content_type: string; size_bytes: number; uploaded_by: string; category:string }>();
  if (!file) return null;
  if (file.category==='user-imports' && requester.role!=='admin') throw new Error('FILE_ACCESS_DENIED');
  if (requester.role === 'resident' && file.uploaded_by !== requester.id) throw new Error('FILE_ACCESS_DENIED');
  const config = await activeStorageConfig(env);
  const response = await fetch(`${repoUrl({ owner: file.github_owner, repository: file.github_repository }, `/contents/${contentPath(file.github_path)}`)}?ref=${encodeURIComponent(file.github_branch)}`, {
    headers: githubHeaders(config.token, 'application/vnd.github.raw+json'),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub storage download failed (${response.status})`);
  return new Response(response.body, {
    headers: {
      'Content-Type': file.content_type,
      'Content-Length': String(file.size_bytes),
      'Content-Disposition': `attachment; filename="${file.original_name.replaceAll('"', '')}"`,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
