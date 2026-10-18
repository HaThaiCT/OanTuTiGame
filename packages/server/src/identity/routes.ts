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

/**
 * ONLINE-only surfaces are hidden — not silently no-ops — in the LAN_OFFLINE
 * profile, so a deployment cannot be tricked into a self-service flow it has no
 * mail transport for. The refusal is a stable contract shared with the
 * tournament entry-code routes.
 */
export function sendProfileDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({
    code: 'PROFILE_DISABLED',
    message: 'This route is not available in the LAN_OFFLINE authentication profile',
  });
}

/** Maps an IdentityError (or any thrown value) onto the `{code, message}` body contract. */
export function sendIdentityError(reply: FastifyReply, err: unknown, fallbackCode: string): FastifyReply {
  const statusCode =
    err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
  const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : fallbackCode;
  return reply.status(statusCode).send({ code, message: err instanceof Error ? err.message : 'Request failed' });
}

/**
 * Recent-re-authentication gate for destructive organizer routes (migration 016). Call it right after
 * a route's own ADMIN check: it re-reads the session by cookie token and answers 403
 * `REAUTH_REQUIRED` unless the operator confirmed their password within the last 10 minutes, using
 * the same `{code, message}` funnel as every other identity failure. A refused request is never
 * retried for the caller — nothing here re-authenticates on their behalf.
 */
export async function requireRecentReauth(
  identityService: IdentityService,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const token = extractToken(request);
  if (!token) {
    reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    return false;
  }
  try {
    await identityService.assertRecentReauth(token);
    return true;
  } catch (err: unknown) {
    sendIdentityError(reply, err, 'REAUTH_FAILED');
    return false;
  }
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
      return sendIdentityError(reply, err, 'LOGIN_FAILED');
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

  // POST /api/v2/auth/reauth  body: { password }
  // Password confirmation for the destructive organizer routes (migration 016). Cookie session only:
  // the caller is already signed in, so this neither creates a session nor extends one — it only
  // re-stamps the session that made the request, for 10 minutes, after the password matches.
  app.post('/api/v2/auth/reauth', async (request, reply) => {
    const token = extractToken(request);
    if (!token) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }

    const body = (request.body ?? {}) as { password?: unknown };
    if (typeof body.password !== 'string' || body.password === '') {
      return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'password is required' });
    }

    try {
      const receipt = await identityService.reauthenticate(token, body.password);
      return reply.send(receipt);
    } catch (err: unknown) {
      return sendIdentityError(reply, err, 'REAUTH_FAILED');
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
      authProfile: identityService.authProfile,
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

  // ---------------------------------------------------------------- ONLINE only
  // The four routes below exist only in the ONLINE profile (404 PROFILE_DISABLED
  // under LAN_OFFLINE, which has no mail transport). Request bodies are read as a
  // plain record and each field is narrowed with typeof before use.

  // POST /api/v2/auth/register
  app.post('/api/v2/auth/register', async (request, reply) => {
    if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);

    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const registered = await identityService.register({
        username: typeof body.username === 'string' ? body.username : '',
        displayName: typeof body.displayName === 'string' ? body.displayName : '',
        email: typeof body.email === 'string' ? body.email : '',
        password: typeof body.password === 'string' ? body.password : '',
      });
      return reply.status(201).send(registered);
    } catch (err: unknown) {
      return sendIdentityError(reply, err, 'REGISTRATION_FAILED');
    }
  });

  // POST /api/v2/auth/verify-email
  app.post('/api/v2/auth/verify-email', async (request, reply) => {
    if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);

    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const verified = await identityService.verifyEmail(typeof body.token === 'string' ? body.token : '');
      return reply.send(verified);
    } catch (err: unknown) {
      return sendIdentityError(reply, err, 'EMAIL_VERIFICATION_INVALID');
    }
  });

  // POST /api/v2/auth/request-password-reset
  app.post('/api/v2/auth/request-password-reset', async (request, reply) => {
    if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.email !== 'string') {
      return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'email is required' });
    }
    await identityService.requestPasswordReset(body.email);
    return reply.status(202).send({ accepted: true });
  });

  // POST /api/v2/auth/reset-password
  app.post('/api/v2/auth/reset-password', async (request, reply) => {
    if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);

    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const reset = await identityService.resetPassword(
        typeof body.token === 'string' ? body.token : '',
        typeof body.newPassword === 'string' ? body.newPassword : ''
      );
      return reply.send(reset);
    } catch (err: unknown) {
      return sendIdentityError(reply, err, 'PASSWORD_RESET_INVALID');
    }
  });
}
