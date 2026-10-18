import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SubmissionService } from './service.js';
import type { IdentityService } from '../identity/service.js';
import type { Actor, BotLanguage, UUID } from '@oantuti/protocol';

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

export function registerSubmissionRoutes(
  app: FastifyInstance,
  submissionService: SubmissionService,
  identityService: IdentityService
): void {
  async function requireActor(request: FastifyRequest): Promise<Actor> {
    const token = extractToken(request);
    if (!token) {
      throw { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication required' };
    }
    const auth = await identityService.authenticateToken(token);
    if (!auth) {
      throw { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Session expired or revoked' };
    }
    return auth.actor;
  }

  // POST /api/v2/tournaments/:id/submissions
  app.post('/api/v2/tournaments/:id/submissions', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const body = request.body as {
        teamId?: unknown;
        language?: unknown;
        entrypoint?: unknown;
        zipBase64?: unknown;
      };

      if (!body || typeof body.teamId !== 'string' || typeof body.language !== 'string' || typeof body.entrypoint !== 'string' || typeof body.zipBase64 !== 'string') {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'teamId, language, entrypoint, and zipBase64 required' });
      }

      if (!['PYTHON', 'TYPESCRIPT', 'CPP'].includes(body.language)) {
        return reply.status(400).send({ code: 'INVALID_LANGUAGE', message: 'Supported languages: PYTHON, TYPESCRIPT, CPP' });
      }

      const zipBuffer = Buffer.from(body.zipBase64, 'base64');
      const receipt = await submissionService.submit(
        params.id,
        body.teamId,
        {
          language: body.language as BotLanguage,
          entrypoint: body.entrypoint,
          zipBuffer,
        },
        actor
      );

      return reply.send(receipt);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Submission failed');
      return reply.status(status).send({ code: 'SUBMISSION_FAILED', message });
    }
  });

  // POST /api/v2/tournaments/:id/private-tests
  app.post('/api/v2/tournaments/:id/private-tests', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const body = request.body as {
        teamId?: unknown;
        language?: unknown;
        entrypoint?: unknown;
        zipBase64?: unknown;
      };

      if (!body || typeof body.teamId !== 'string' || typeof body.language !== 'string' || typeof body.entrypoint !== 'string' || typeof body.zipBase64 !== 'string') {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'teamId, language, entrypoint, and zipBase64 required' });
      }

      if (!['PYTHON', 'TYPESCRIPT', 'CPP'].includes(body.language)) {
        return reply.status(400).send({ code: 'INVALID_LANGUAGE', message: 'Supported languages: PYTHON, TYPESCRIPT, CPP' });
      }

      const zipBuffer = Buffer.from(body.zipBase64, 'base64');
      const receipt = await submissionService.createPrivateTest(
        params.id,
        body.teamId,
        {
          language: body.language as BotLanguage,
          entrypoint: body.entrypoint,
          zipBuffer,
        },
        actor
      );

      return reply.send(receipt);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Test creation failed');
      return reply.status(status).send({ code: 'TEST_FAILED', message });
    }
  });

  // GET /api/v2/tournaments/:id/entries/me
  app.get('/api/v2/tournaments/:id/entries/me', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const query = request.query as { teamId?: string };
      const teamId = query?.teamId ?? actor.teamIds[0];
      if (!teamId) {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'teamId parameter required' });
      }

      const candidate = await submissionService.getLatestCandidate(params.id, teamId, actor);
      return reply.send({ candidate });
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Get candidate failed';
      return reply.status(status).send({ code: 'GET_CANDIDATE_FAILED', message });
    }
  });

  // GET /api/v2/submissions/:id/source
  app.get('/api/v2/submissions/:id/source', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const source = await submissionService.getSubmissionSource(params.id, actor);
      return reply.send(source);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Get submission source failed';
      return reply.status(status).send({ code: 'GET_SOURCE_FAILED', message });
    }
  });
}
