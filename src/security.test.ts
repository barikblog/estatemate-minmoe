import { describe, expect, it } from 'vitest';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './security';

describe('security primitives', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('a-strong-password');
    expect(await verifyPassword('a-strong-password', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('signs and validates a JWT', async () => {
    const env = { JWT_SECRET: '0123456789abcdef0123456789abcdef' };
    const token = await signJwt(env, { id: 'u1', role: 'admin', name: 'Admin' });
    expect((await verifyJwt(env, token))?.sub).toBe('u1');
  });
});
