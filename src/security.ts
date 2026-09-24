import type { Env, JwtClaims, Role } from './types';

const encoder = new TextEncoder();
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const data = Uint8Array.from(typeof value === 'string' ? encoder.encode(value) : value);
  const hash = await crypto.subtle.digest('SHA-256', data.buffer);
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('A server encryption key is required');
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(secret));
  return crypto.subtle.importKey('raw',digest,{ name:'AES-GCM' },false,['encrypt','decrypt']);
}

export async function encryptSecret(secret: string, value: string): Promise<{ ciphertext:string;iv:string }> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({ name:'AES-GCM',iv },await aesKey(secret),encoder.encode(value));
  return { ciphertext:base64Url(new Uint8Array(encrypted)),iv:base64Url(iv) };
}

export async function decryptSecret(secret: string, ciphertext: string, iv: string): Promise<string> {
  const ivBytes=Uint8Array.from(fromBase64Url(iv));const ciphertextBytes=Uint8Array.from(fromBase64Url(ciphertext));
  const decrypted=await crypto.subtle.decrypt({ name:'AES-GCM',iv:ivBytes.buffer as ArrayBuffer },await aesKey(secret),ciphertextBytes.buffer as ArrayBuffer);
  return new TextDecoder().decode(decrypted);
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('Password must contain at least 10 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, expectedText] = encoded.split('$');
  if (algorithm !== 'pbkdf2-sha256' || !iterationsText || !saltText || !expectedText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(saltText).buffer as ArrayBuffer, iterations },
    key,
    256,
  );
  return timingSafeEqual(new Uint8Array(bits), fromBase64Url(expectedText));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

async function hmac(secret: string, input: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)));
}

export async function signJwt(
  env: Pick<Env, 'JWT_SECRET'>,
  user: { id: string; role: Role; name: string },
  ttlSeconds = 60 * 60 * 12,
): Promise<string> {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload: JwtClaims = { sub: user.id, role: user.role, name: user.name, iat: now, exp: now + ttlSeconds };
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const input = `${header}.${encodedPayload}`;
  return `${input}.${base64Url(await hmac(env.JWT_SECRET, input))}`;
}

export async function verifyJwt(env: Pick<Env, 'JWT_SECRET'>, token: string): Promise<JwtClaims | null> {
  try {
    const [headerText, payloadText, signatureText] = token.split('.');
    if (!headerText || !payloadText || !signatureText) return null;
    const input = `${headerText}.${payloadText}`;
    const expected = await hmac(env.JWT_SECRET, input);
    if (!timingSafeEqual(expected, fromBase64Url(signatureText))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadText))) as JwtClaims;
    if (!claims.sub || !claims.role || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
