import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Database, type UserRow } from './db.js';

const deriveKey = promisify(scrypt);
const COOKIE = 'oantuti_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export function objectPayload(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new HttpError(400, 'Invalid request payload');
  return value as Record<string, unknown>;
}
export function textField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new HttpError(400, `Invalid ${field}`);
  return value;
}
export function maxTurnsField(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) throw new HttpError(400, 'Invalid maxTurns');
  return value;
}
export function mapIdField(value: unknown): string {
  const id = textField(value, 'mapId', 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid mapId');
  return id;
}
export function botSourceFields(value: Record<string, unknown>): { name: string; language: 'PYTHON' | 'TYPESCRIPT' | 'CPP'; sourceCode: string } {
  const name = textField(value.name, 'name', 100).trim();
  if (value.language !== 'PYTHON' && value.language !== 'TYPESCRIPT' && value.language !== 'CPP') throw new HttpError(400, 'Invalid language');
  const sourceCode = textField(value.sourceCode, 'sourceCode', 256 * 1024);
  return { name, language: value.language as 'PYTHON' | 'TYPESCRIPT' | 'CPP', sourceCode };
}
function publicUser(user: UserRow) { return { id: user.id, username: user.username, email: user.email, role: user.role }; }
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function cookieToken(request: FastifyRequest): string | undefined {
  const token = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const valid = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded);
  const [, salt, expected] = (valid ? encoded : DUMMY_HASH).split('$');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return valid && timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
export class AuthService {
  constructor(private readonly db: Database) {}
  user(request: FastifyRequest): UserRow | undefined {
    const token = cookieToken(request); return token ? this.db.getSessionUser(tokenHash(token)) : undefined;
  }
  requireUser(request: FastifyRequest): UserRow {
    const user = this.user(request);
    if (!user || user.id === 'usr_system') throw new HttpError(401, 'Authentication required');
    return user;
  }
  requireAdmin(request: FastifyRequest): UserRow {
    const user = this.requireUser(request);
    if (user.role !== 'ADMIN') throw new HttpError(403, 'Forbidden: Admin privilege required');
    return user;
  }
  private setCookie(request: FastifyRequest, reply: FastifyReply, token: string, maxAge: number): void {
    const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
    reply.header('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
    reply.header('Cache-Control', 'no-store');
  }
  private issueSession(user: UserRow, request: FastifyRequest, reply: FastifyReply): void {
    const previous = cookieToken(request); if (previous) this.db.revokeSession(tokenHash(previous));
    const token = randomBytes(32).toString('hex');
    this.db.createSession(tokenHash(token), user.id, Date.now() + SESSION_SECONDS * 1000);
    this.setCookie(request, reply, token, SESSION_SECONDS);
  }
  registerRoutes(app: FastifyInstance): void {
    app.post('/api/auth/register', async (request, reply) => {
      // LAN_OFFLINE provisions every account (01 §4.1), so the compatibility surface must not offer
      // self-registration unless an operator opts in explicitly. Accounts are issued by the organizer.
      if (process.env.OANTUTI_LEGACY_API !== '1') {
        return reply.code(403).send({ error: 'LEGACY_SELF_REGISTRATION_DISABLED' });
      }
      const payload = objectPayload(request.body, ['username', 'email', 'password']);
      const username = textField(payload.username, 'username', 40).trim();
      const email = textField(payload.email, 'email', 254).trim().toLowerCase();
      const password = textField(payload.password, 'password', 128);
      if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) throw new HttpError(400, 'Invalid account fields (password minimum 10 characters)');
      const passwordHash = await hashPassword(password);
      if (this.db.getUserByUsername(username) || this.db.getUserByEmail(email)) throw new HttpError(409, 'Username or email already registered');
      const user = this.db.createUser({ username, email, password_hash: passwordHash });
      this.issueSession(user, request, reply);
      return reply.code(201).send({ user: publicUser(user) });
    });
    app.post('/api/auth/login', async (request, reply) => {
      const payload = objectPayload(request.body, ['username', 'password']);
      const username = textField(payload.username, 'username', 40).trim();
      const password = textField(payload.password, 'password', 128);
      const user = this.db.getUserByUsername(username);
      const verified = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || user.id === 'usr_system' || !verified) throw new HttpError(401, 'Invalid username or password');
      this.issueSession(user, request, reply);
      return { user: publicUser(user) };
    });
    app.get('/api/auth/me', async (request, reply) => {
      reply.header('Cache-Control', 'no-store'); const user = this.user(request);
      return { user: user && user.id !== 'usr_system' ? publicUser(user) : null };
    });
    app.post('/api/auth/logout', async (request, reply) => {
      const token = cookieToken(request); if (token) this.db.revokeSession(tokenHash(token));
      this.setCookie(request, reply, '', 0);
      return reply.code(204).send();
    });
  }
}

export function isLanOrLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === 'localhost' || host.endsWith('.local') || !host.includes('.')) return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

export function protectMutations(app: FastifyInstance, allowedOrigins: readonly string[], options: { readonly exactOrigin?: boolean } = {}): void {
  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-origin mutation denied');
    const origin = request.headers.origin;
    if (options.exactOrigin && (!origin || !allowedOrigins.includes(origin))) {
      throw new HttpError(403, 'Cross-origin mutation denied');
    }
    if (origin && !options.exactOrigin) {
      let normalized: string;
      try { normalized = new URL(origin).origin; } catch { throw new HttpError(403, 'Cross-origin mutation denied'); }
      // Never use forwarded headers to decide which origin is trusted.
      const target = new URL(`${request.protocol}://${request.host}`).origin;
      if (normalized !== target && !allowedOrigins.includes(normalized) && !isLanOrLocalOrigin(normalized)) throw new HttpError(403, 'Cross-origin mutation denied');
    }
    const jsonRequired = request.method !== 'DELETE';
    if (jsonRequired && request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(400, 'JSON payload required');
  });
}
