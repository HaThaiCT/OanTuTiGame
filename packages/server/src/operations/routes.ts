import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService } from '../identity/service.js';
import { requireRecentReauth } from '../identity/routes.js';
import type { RetentionHold, RetentionService } from './retention-service.js';
import { RetentionError } from './retention-service.js';

const COOKIE_NAME = 'oantuti_session';

function extractToken(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = match?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export function registerOperationsRoutes(
  app: FastifyInstance,
  retentionService: RetentionService,
  identityService: IdentityService
): void {
  async function requireAdminActor(req: FastifyRequest, reply: FastifyReply) {
    const token = extractToken(req);
    if (!token) {
      reply.code(401).send({ error: 'UNAUTHENTICATED' });
      return null;
    }
    const auth = await identityService.authenticateToken(token);
    if (!auth) {
      reply.code(401).send({ error: 'SESSION_EXPIRED' });
      return null;
    }
    if (auth.actor.role !== 'ADMIN') {
      reply.code(403).send({ error: 'Forbidden: administrator only' });
      return null;
    }
    return auth.actor;
  }

  app.get('/api/v2/organizer/operations/retention', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireAdminActor(req, reply);
    if (!actor) return;
    try {
      const report = await retentionService.report({ actor, requestId: req.id });
      return reply.code(200).send(report);
    } catch (err: unknown) {
      if (err instanceof RetentionError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.put<{ Body: { holds?: unknown } }>(
    '/api/v2/organizer/operations/retention/holds',
    async (req: FastifyRequest<{ Body: { holds?: unknown } }>, reply: FastifyReply) => {
      const actor = await requireAdminActor(req, reply);
      if (!actor) return;
      if (!(await requireRecentReauth(identityService, req, reply))) return;
      const body = req.body ?? {};
      if (!Array.isArray(body.holds)) {
        return reply.code(400).send({ error: 'holds must be an array' });
      }
      for (const hold of body.holds as Partial<RetentionHold>[]) {
        if (!hold || typeof hold !== 'object') {
          return reply.code(400).send({ error: 'each hold must be an object' });
        }
        if (hold.scope !== 'GLOBAL' && hold.scope !== 'TOURNAMENT' && hold.scope !== 'TEAM') {
          return reply.code(400).send({ error: "hold.scope must be 'GLOBAL', 'TOURNAMENT' or 'TEAM'" });
        }
        if (hold.scope !== 'GLOBAL' && (typeof hold.id !== 'string' || hold.id.trim() === '')) {
          return reply.code(400).send({ error: 'hold.id is required for tournament/team holds' });
        }
        if (typeof hold.reason !== 'string' || hold.reason.trim() === '') {
          return reply.code(400).send({ error: 'hold.reason is required' });
        }
      }
      try {
        const holds = await retentionService.replaceHolds(body.holds as RetentionHold[], {
          actor,
          requestId: req.id,
        });
        return reply.code(200).send({ holds });
      } catch (err: unknown) {
        if (err instanceof RetentionError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    }
  );

  app.post<{ Body: { dryRun?: unknown } }>(
    '/api/v2/organizer/operations/retention/sweep',
    async (req: FastifyRequest<{ Body: { dryRun?: unknown } }>, reply: FastifyReply) => {
      const actor = await requireAdminActor(req, reply);
      if (!actor) return;
      const body = req.body ?? {};
      const dryRun = body.dryRun !== false;
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        return reply.code(400).send({ error: 'dryRun must be a boolean' });
      }
      // A real purge deletes evidence: require a fresh credential check.
      if (!dryRun && !(await requireRecentReauth(identityService, req, reply))) return;
      try {
        const result = await retentionService.sweep({ dryRun }, { actor, requestId: req.id });
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof RetentionError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    }
  );
}
