import { describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';
import { hashPassword, verifyPassword, validPassword } from '../src/identity/crypto.js';

describe('LAN password policy and pinned Argon2id', () => {
  it('counts Unicode code points and preserves whitespace', async () => {
    expect(validPassword('🔒'.repeat(12))).toBe(true);
    expect(validPassword('🔒'.repeat(128))).toBe(true);
    expect(validPassword('🔒'.repeat(129))).toBe(false);
    expect(validPassword('a'.repeat(11))).toBe(false);
    const hash = await hashPassword('  password with spaces  ');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(await verifyPassword('  password with spaces  ', hash)).toBe(true);
    expect(await verifyPassword('password with spaces', hash)).toBe(false);
    expect(await verifyPassword('  password with spaces  ', hash.replace('m=65536', 'm=999999999'))).toBe(false);
  });
  it('verifies historical scrypt with its original textual salt', async () => {
    const salt = 'ab'.repeat(16);
    const hash = `scrypt$${salt}$${scryptSync('legacy-secret', salt, 64).toString('hex')}`;
    expect(await verifyPassword('legacy-secret', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
