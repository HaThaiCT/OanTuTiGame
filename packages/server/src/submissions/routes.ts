import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SubmissionService } from './service.js';
import type { IdentityService } from '../identity/service.js';
import type { PrivateTestRunner } from '../builds/private-test-runner.js';
import type { Actor, BotLanguage, UUID } from '@oantuti/protocol';

const COOKIE_NAME = 'oantuti_session';
// 2 MiB source ZIP + base64 expansion (~4/3) + JSON envelope headroom.
const MAX_UPLOAD_BODY_BYTES = 4 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single error funnel: preserves `{code, message}` and adds `details` when the
 * thrown error carries structured context (e.g. the S05 quota that tripped).
 * `code` prefers the error's own machine-readable code; plain thrown objects
 * (e.g. the 401 from requireActor) already carry one.
 */
function sendError(reply: FastifyReply, err: unknown, fallbackCode: string, fallbackMessage: string) {
  const info = err && typeof err === 'object' ? (err as { statusCode?: unknown; code?: unknown; message?: unknown; details?: unknown }) : undefined;
  const status = typeof info?.statusCode === 'number' ? info.statusCode : 500;
  const code = typeof info?.code === 'string' ? info.code : fallbackCode;
  const message = err instanceof Error ? err.message : typeof info?.message === 'string' ? info.message : fallbackMessage;
  const body: { code: string; message: string; details?: unknown } = { code, message };
  if (info?.details !== undefined) {
    body.details = info.details;
  }
  return reply.status(status).send(body);
}

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
  identityService: IdentityService,
  /** Reads of the team's private practice runs (list, detail, replay). */
  privateTestRunner: PrivateTestRunner
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
  app.post('/api/v2/tournaments/:id/submissions', { bodyLimit: MAX_UPLOAD_BODY_BYTES }, async (request, reply) => {
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
      return sendError(reply, err, 'SUBMISSION_FAILED', 'Submission failed');
    }
  });

  // POST /api/v2/tournaments/:id/private-tests
  app.post('/api/v2/tournaments/:id/private-tests', { bodyLimit: MAX_UPLOAD_BODY_BYTES }, async (request, reply) => {
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

      // Rate-limit bookkeeping runs before payload validation: a rejected request still consumes the
      // window, so the limiter cannot be evaded by sending malformed bodies (PR §123).
      await submissionService.recordTestCreateAttempt(params.id, body.teamId, actor);

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
      return sendError(reply, err, 'TEST_FAILED', 'Test creation failed');
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
      return sendError(reply, err, 'GET_CANDIDATE_FAILED', 'Get candidate failed');
    }
  });

  // GET /api/v2/tournaments/:id/submissions
  app.get('/api/v2/tournaments/:id/submissions', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const query = request.query as { teamId?: unknown };
      const teamId = typeof query?.teamId === 'string' ? query.teamId : undefined;
      if (!teamId || !UUID_PATTERN.test(teamId)) {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'teamId query parameter must be a UUID' });
      }

      const submissions = await submissionService.listSubmissions(params.id, teamId, actor);
      return reply.send({ submissions });
    } catch (err: unknown) {
      return sendError(reply, err, 'GET_SUBMISSIONS_FAILED', 'Get submissions failed');
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
      return sendError(reply, err, 'GET_SOURCE_FAILED', 'Get submission source failed');
    }
  });

  // GET /api/v2/tournaments/:id/private-tests?teamId=<uuid>
  app.get('/api/v2/tournaments/:id/private-tests', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const query = request.query as { teamId?: unknown };
      const teamId = typeof query?.teamId === 'string' ? query.teamId : undefined;
      if (!teamId || !UUID_PATTERN.test(teamId)) {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'teamId query parameter must be a UUID' });
      }

      const tests = await privateTestRunner.listTests(params.id, teamId, actor);
      return reply.send({ tests });
    } catch (err: unknown) {
      return sendError(reply, err, 'GET_PRIVATE_TESTS_FAILED', 'Get private tests failed');
    }
  });

  // GET /api/v2/private-tests/:id
  app.get('/api/v2/private-tests/:id', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const test = await privateTestRunner.getTest(params.id, actor);
      return reply.send({ test });
    } catch (err: unknown) {
      return sendError(reply, err, 'GET_PRIVATE_TEST_FAILED', 'Get private test failed');
    }
  });

  // GET /api/v2/private-tests/:id/replay
  // Team-scoped, so unlike the immutable official replay it is never publicly cacheable.
  app.get('/api/v2/private-tests/:id/replay', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const replay = await privateTestRunner.getTestReplay(params.id, actor);

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${params.id}.oantuti"`);
      reply.header('ETag', `"${replay.digest}"`);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(replay.buffer);
    } catch (err: unknown) {
      return sendError(reply, err, 'GET_PRIVATE_TEST_REPLAY_FAILED', 'Get private test replay failed');
    }
  });
}
