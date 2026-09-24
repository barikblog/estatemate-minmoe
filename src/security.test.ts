import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashPassword, signJwt, verifyJwt, verifyPassword } from './security';

describe('security primitives', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('a-strong-password');
    expect(await verifyPassword('a-strong-password', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('signs and validates administrator and manager JWTs', async () => {
    const env = { JWT_SECRET: '0123456789abcdef0123456789abcdef' };
    const adminToken = await signJwt(env, { id: 'u1', role: 'admin', name: 'Admin' });
    const managerToken = await signJwt(env, { id: 'u2', role: 'manager', name: 'Manager' });
    expect((await verifyJwt(env, adminToken))?.sub).toBe('u1');
    expect((await verifyJwt(env, managerToken))?.role).toBe('manager');
  });

  it('encrypts and decrypts sensitive device verification material', async () => {
    const encrypted=await encryptSecret('0123456789abcdef0123456789abcdef','VERIFY-42');
    expect(encrypted.ciphertext).not.toContain('VERIFY-42');
    expect(await decryptSecret('0123456789abcdef0123456789abcdef',encrypted.ciphertext,encrypted.iv)).toBe('VERIFY-42');
  });
});
