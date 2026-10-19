import * as crypto from 'node:crypto';
import { promisify } from 'node:util';

const deriveLegacyKey = promisify(crypto.scrypt);
type Argon2 = (algorithm: 'argon2id', options: {
  message: string; nonce: Buffer; memory: number; passes: number; parallelism: number; tagLength: number;
}, callback: (error: Error | null, key: Buffer) => void) => void;
// Node 24.7 added this API; the repository currently carries Node 22 declarations.
const cryptoWithArgon2 = crypto as unknown as { argon2?: Argon2 };
const argon2 = cryptoWithArgon2.argon2;
const PREFIX = '$argon2id$v=19$m=65536,t=3,p=1$';
const ARGON_PATTERN = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const LEGACY_PATTERN = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

export function validPassword(password: unknown): password is string {
  if (typeof password !== 'string' || password.length > 256) return false;
  const length = Array.from(password).length;
  return length >= 12 && length <= 128;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (!argon2) throw new Error('Password hashing requires Node.js >=24.7 with built-in Argon2 support');
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  argon2('argon2id', { message: password, nonce: salt, memory: 65536, passes: 3, parallelism: 1, tagLength: 32 },
    (error, key) => error ? reject(error) : resolve(key));
  return promise;
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length > 256) throw new Error('Password input exceeds the supported bound');
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}${salt.toString('hex')}$${key.toString('hex')}`;
}

export function needsPasswordRehash(encoded: string): boolean {
  return LEGACY_PATTERN.test(encoded);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  // Legacy passwords can be shorter than today's issuance policy, but all work is bounded.
  if (typeof password !== 'string' || password.length > 256) return false;
  const current = ARGON_PATTERN.exec(encoded);
  if (current) {
    const key = await derive(password, Buffer.from(current[1], 'hex'));
    return crypto.timingSafeEqual(key, Buffer.from(current[2], 'hex'));
  }
  const legacy = LEGACY_PATTERN.exec(encoded);
  if (legacy) {
    // The historical scrypt helper used the hex text itself as its salt.
    const key = await deriveLegacyKey(password, legacy[1], 64) as Buffer;
    return crypto.timingSafeEqual(key, Buffer.from(legacy[2], 'hex'));
  }
  await derive(password, Buffer.alloc(16));
  return false;
}

export function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

export function generateTemporaryPassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
