import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ResultService } from './service.js';

export function registerResultRoutes(
  app: FastifyInstance,
  resultService: ResultService
): void {
  // GET /api/v2/games/:id/result
  app.get<{ Params: { id: string } }>(
    '/api/v2/games/:id/result',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const result = await resultService.getAcceptedResult(request.params.id);
      if (!result) {
        return reply.code(404).send({ error: 'Game result not found' });
      }
      return reply.code(200).send(result);
    }
  );

  // GET /api/v2/games/:id/replay
  app.get<{ Params: { id: string } }>(
    '/api/v2/games/:id/replay',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const result = await resultService.getAcceptedResult(request.params.id);
      if (!result) {
        return reply.code(404).send({ error: 'Game or replay not found' });
      }

      const replayBytes = await resultService.getReplay(result.replayDigest);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${request.params.id}.oantuti"`);
      reply.header('ETag', `"${result.replayDigest}"`);
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.code(200).send(replayBytes);
    }
  );

  // GET /api/v2/replays/:digest
  app.get<{ Params: { digest: string } }>(
    '/api/v2/replays/:digest',
    async (request: FastifyRequest<{ Params: { digest: string } }>, reply: FastifyReply) => {
      try {
        const replayBytes = await resultService.getReplay(request.params.digest);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename="${request.params.digest}.oantuti"`);
        reply.header('ETag', `"${request.params.digest}"`);
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        return reply.code(200).send(replayBytes);
      } catch {
        return reply.code(404).send({ error: 'Replay not found' });
      }
    }
  );
}
