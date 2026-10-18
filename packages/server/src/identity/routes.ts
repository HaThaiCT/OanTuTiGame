import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService } from './service.js';
import type { Actor, LanBulkUserEntry } from '@oantuti/protocol';

const COOKIE_NAME = 'oantuti_session';

function extractToken(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE_NAME}=`));
  const token = match?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string, isHttps = false): void {
  const cookieParts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (isHttps) {
    cookieParts.push('Secure');
  }
  reply.header('Set-Cookie', cookieParts.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  allowedOrigins?: readonly string[]
): void {
  // Origin verification hook for state mutations
  app.addHook('preValidation', async (request, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      if (allowedOrigins && allowedOrigins.length > 0 && origin) {
        if (!allowedOrigins.includes(origin)) {
          return reply.status(403).send({ code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin mutation forbidden' });
        }
      }
    }
  });

  // Helper hook to resolve Actor from session cookie
  app.decorateRequest('actor', undefined);

  // POST /api/v2/auth/login
  app.post('/api/v2/auth/login', async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
      return reply.status(400).send({ code: 'INVALID_CREDENTIALS', message: 'Username and password required' });
    }

    try {
      const session = await identityService.login(body.username, body.password);
      const isHttps = request.headers['x-forwarded-proto'] === 'https' || request.protocol === 'https';
      setSessionCookie(reply, session.token, session.expiresAt, isHttps);
      return reply.send({
        user: session.user,
        scope: session.scope,
        expiresAt: session.expiresAt,
      });
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Login failed';
      return reply.status(status).send({ code: 'LOGIN_FAILED', message });
    }
  });

  // POST /api/v2/auth/change-password
  app.post('/api/v2/auth/change-password', async (request, reply) => {
    const token = extractToken(request);
    if (!token) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    const auth = await identityService.authenticateToken(token);
    if (!auth) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Session expired or revoked' });
    }

    const body = request.body as { oldPassword?: unknown; newPassword?: unknown };
    if (!body || typeof body.oldPassword !== 'string' || typeof body.newPassword !== 'string') {
      return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'oldPassword and newPassword required' });
    }

    try {
      const newSession = await identityService.changePassword(auth.actor.userId, body.oldPassword, body.newPassword);
      const isHttps = request.headers['x-forwarded-proto'] === 'https' || request.protocol === 'https';
      setSessionCookie(reply, newSession.token, newSession.expiresAt, isHttps);
      return reply.send({
        user: newSession.user,
        scope: newSession.scope,
        expiresAt: newSession.expiresAt,
      });
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Password change failed';
      return reply.status(status).send({ code: 'CHANGE_PASSWORD_FAILED', message });
    }
  });

  // POST /api/v2/auth/logout
  app.post('/api/v2/auth/logout', async (request, reply) => {
    const token = extractToken(request);
    if (token) {
      await identityService.revokeSession(token);
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // GET /api/v2/auth/me
  app.get('/api/v2/auth/me', async (request, reply) => {
    const token = extractToken(request);
    if (!token) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    const auth = await identityService.authenticateToken(token);
    if (!auth) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Session expired or revoked' });
    }
    return reply.send({
      user: auth.user,
      scope: auth.actor.scope,
      teamIds: auth.actor.teamIds,
    });
  });

  // POST /api/v2/organizer/accounts/provision-lan (ADMIN only)
  app.post('/api/v2/organizer/accounts/provision-lan', async (request, reply) => {
    const token = extractToken(request);
    if (!token) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    const auth = await identityService.authenticateToken(token);
    if (!auth || auth.actor.role !== 'ADMIN' || auth.actor.scope !== 'FULL') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Only fully authenticated ADMIN can provision accounts' });
    }

    const body = request.body as { users?: unknown };
    if (!body || !Array.isArray(body.users)) {
      return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'users array required' });
    }

    try {
      const created = await identityService.lanBulkProvision(body.users as LanBulkUserEntry[], auth.actor);
      return reply.send({ created });
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Provisioning failed';
      return reply.status(status).send({ code: 'PROVISION_FAILED', message });
    }
  });
}
