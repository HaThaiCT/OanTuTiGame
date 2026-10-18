import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await deriveKey(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const valid = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded);
  const [, salt, expected] = (valid ? encoded : DUMMY_HASH).split('$');
  const key = (await deriveKey(password, salt, 64)) as Buffer;
  return valid && timingSafeEqual(key, Buffer.from(expected, 'hex'));
}

export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function generateTemporaryPassword(): string {
  // 12-char alphanumeric random password
  return randomBytes(9).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
