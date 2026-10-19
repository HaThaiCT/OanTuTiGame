import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ResultService } from './service.js';
import type { IdentityService } from '../identity/service.js';

function sessionToken(request: FastifyRequest): string | undefined {
  const token = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('oantuti_session='))?.slice('oantuti_session='.length);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

/** Shared with the legacy download: a SQLite session must never bypass v2 authorization. */
export async function requireReplayAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  identityService: IdentityService
): Promise<boolean> {
  reply.header('Cache-Control', 'private, no-store');
  const token = sessionToken(request);
  const auth = token ? await identityService.authenticateToken(token) : undefined;
  if (!auth) {
    reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return false;
  }
  if (auth.actor.role !== 'ADMIN' || auth.actor.scope !== 'FULL') {
    reply.code(403).send({ error: 'FORBIDDEN' });
    return false;
  }
  return true;
}

export function registerResultRoutes(
  app: FastifyInstance,
  resultService: ResultService,
  identityService: IdentityService
): void {
  // GET /api/v2/games/:id/result
  app.get<{ Params: { id: string } }>(
    '/api/v2/games/:id/result',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      // The same URL has a privileged DTO; never let an intermediary cache it for public readers.
      reply.header('Cache-Control', 'private, no-store');
      const result = await resultService.getAcceptedResult(request.params.id);
      if (!result) {
        return reply.code(404).send({ error: 'Game result not found' });
      }
      const token = sessionToken(request);
      const auth = token ? await identityService.authenticateToken(token) : undefined;
      if (auth?.actor.role === 'ADMIN' && auth.actor.scope === 'FULL') {
        return reply.code(200).send(result);
      }
      const { replayDigest: _replayDigest, ...publicResult } = result;
      return reply.code(200).send(publicResult);
    }
  );

  // GET /api/v2/games/:id/replay
  app.get<{ Params: { id: string } }>(
    '/api/v2/games/:id/replay',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!(await requireReplayAdmin(request, reply, identityService))) return;
      const result = await resultService.getAcceptedResult(request.params.id);
      if (!result) {
        return reply.code(404).send({ error: 'Game or replay not found' });
      }

      const replayBytes = await resultService.getReplay(result.replayDigest);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${request.params.id}.oantuti"`);
      reply.header('ETag', `"${result.replayDigest}"`);
      reply.header('Cache-Control', 'private, no-store');
      return reply.code(200).send(replayBytes);
    }
  );

  // GET /api/v2/replays/:digest
  app.get<{ Params: { digest: string } }>(
    '/api/v2/replays/:digest',
    async (request: FastifyRequest<{ Params: { digest: string } }>, reply: FastifyReply) => {
      if (!(await requireReplayAdmin(request, reply, identityService))) return;
      try {
        const replayBytes = await resultService.getReplay(request.params.digest);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename="${request.params.digest}.oantuti"`);
        reply.header('ETag', `"${request.params.digest}"`);
        reply.header('Cache-Control', 'private, no-store');
        return reply.code(200).send(replayBytes);
      } catch {
        return reply.code(404).send({ error: 'Replay not found' });
      }
    }
  );
}
