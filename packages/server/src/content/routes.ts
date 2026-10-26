import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ContentService } from './service.js';
import type { IdentityService } from '../identity/service.js';
import type { Actor, BotLanguage } from '@oantuti/protocol';

const COOKIE_NAME = 'oantuti_session';
const MAX_UPLOAD_BODY_BYTES = 4 * 1024 * 1024;

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

function sendError(reply: FastifyReply, err: unknown, fallbackCode = 'REQUEST_FAILED') {
  const info = err && typeof err === 'object' ? (err as { statusCode?: unknown; code?: unknown; message?: unknown }) : undefined;
  const status = typeof info?.statusCode === 'number' ? info.statusCode : 500;
  const code = typeof info?.code === 'string' ? info.code : fallbackCode;
  const message = err instanceof Error ? err.message : typeof info?.message === 'string' ? info.message : 'Operation failed';
  return reply.status(status).send({ code, message });
}

interface NewsPatchBody {
  title?: unknown;
  summary?: unknown;
  content?: unknown;
}

/**
 * The update service dereferences `input.<field>.trim()` for every field that arrived, so the
 * route normalizes the body first: only real strings count as "provided", and a missing (no
 * JSON body), `null`, or mis-typed field is dropped (a no-op touch) instead of reaching the
 * service as a TypeError.
 */
function coerceNewsPatch(body: NewsPatchBody | null | undefined): { title?: string; summary?: string; content?: string } {
  const patch: { title?: string; summary?: string; content?: string } = {};
  if (body && typeof body === 'object') {
    for (const field of ['title', 'summary', 'content'] as const) {
      if (typeof body[field] === 'string') patch[field] = body[field];
    }
  }
  return patch;
}

export function registerContentRoutes(
  app: FastifyInstance,
  contentService: ContentService,
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
    if (auth.actor.scope !== 'FULL') {
      throw { statusCode: 403, code: 'FULL_SESSION_REQUIRED', message: 'Full session required' };
    }
    return auth.actor;
  }

  /* ---------------------------------------------------------------------------------------------
   * Public News
   * ------------------------------------------------------------------------------------------- */

  // GET /api/v2/news
  app.get<{ Querystring: { limit?: string } }>('/api/v2/news', async (request, reply) => {
    try {
      // `parseInt` hands back NaN for any non-numeric query, and Postgres refuses a NaN LIMIT with
      // a raw 22P02 — so the route only ever hands the service a real integer.
      const parsed = Number.parseInt(request.query.limit ?? '', 10);
      const limit = Number.isSafeInteger(parsed) ? parsed : 10;
      const result = await contentService.listPublishedNews(limit);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /api/v2/news/:slug
  app.get<{ Params: { slug: string } }>('/api/v2/news/:slug', async (request, reply) => {
    try {
      const post = await contentService.getPublishedPost(request.params.slug);
      if (!post) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'News post not found' });
      }
      return reply.send({ post });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /* ---------------------------------------------------------------------------------------------
   * Organizer News
   * ------------------------------------------------------------------------------------------- */

  // GET /api/v2/organizer/news
  app.get('/api/v2/organizer/news', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      reply.header('Cache-Control', 'private, no-store');
      const result = await contentService.adminListNews(actor);
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /api/v2/organizer/news
  app.post<{ Body: { title: string; slug: string; summary: string; content: string; publishNow?: boolean } }>(
    '/api/v2/organizer/news',
    async (request, reply) => {
      try {
        const actor = await requireActor(request);
        reply.header('Cache-Control', 'private, no-store');
        const post = await contentService.adminCreateNews(request.body, actor);
        return reply.status(201).send({ post });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  // PUT /api/v2/organizer/news/:id
  app.put<{ Params: { id: string }; Body: { title?: string; summary?: string; content?: string } }>(
    '/api/v2/organizer/news/:id',
    async (request, reply) => {
      try {
        const actor = await requireActor(request);
        reply.header('Cache-Control', 'private, no-store');
        const post = await contentService.adminUpdateNews(request.params.id, coerceNewsPatch(request.body), actor);
        return reply.send({ post });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/news/:id/publish
  app.post<{ Params: { id: string } }>('/api/v2/organizer/news/:id/publish', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      reply.header('Cache-Control', 'private, no-store');
      const post = await contentService.adminSetNewsState(request.params.id, 'PUBLISHED', actor);
      return reply.send({ post });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /api/v2/organizer/news/:id/archive
  app.post<{ Params: { id: string } }>('/api/v2/organizer/news/:id/archive', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      reply.header('Cache-Control', 'private, no-store');
      const post = await contentService.adminSetNewsState(request.params.id, 'ARCHIVED', actor);
      return reply.send({ post });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /* ---------------------------------------------------------------------------------------------
   * Public Starter Bots
   * ------------------------------------------------------------------------------------------- */

  // GET /api/v2/starter-bots
  app.get('/api/v2/starter-bots', async (_request, reply) => {
    try {
      const result = await contentService.listActiveStarterBots();
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // GET /api/v2/starter-bots/:idOrSlug/download
  app.get<{ Params: { idOrSlug: string } }>('/api/v2/starter-bots/:idOrSlug/download', async (request, reply) => {
    try {
      const { template, zipBuffer } = await contentService.getStarterBotDownload(request.params.idOrSlug);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${template.slug}.zip"`);
      reply.header('Content-Length', zipBuffer.length);
      return reply.send(zipBuffer);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /* ---------------------------------------------------------------------------------------------
   * Organizer Starter Bots
   * ------------------------------------------------------------------------------------------- */

  // GET /api/v2/organizer/starter-bots
  app.get('/api/v2/organizer/starter-bots', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      reply.header('Cache-Control', 'private, no-store');
      const result = await contentService.listActiveStarterBots();
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /api/v2/organizer/starter-bots
  app.post<{
    Body: {
      name: string;
      slug: string;
      language: BotLanguage;
      entrypoint: string;
      description?: string;
      zipBase64: string;
    };
  }>('/api/v2/organizer/starter-bots', { bodyLimit: MAX_UPLOAD_BODY_BYTES }, async (request, reply) => {
    try {
      const actor = await requireActor(request);
      reply.header('Cache-Control', 'private, no-store');
      const body = request.body;
      if (!body?.zipBase64 || typeof body.zipBase64 !== 'string') {
        return reply.status(400).send({ code: 'INVALID_ZIP', message: 'zipBase64 string required' });
      }
      const zipBuffer = Buffer.from(body.zipBase64, 'base64');
      const template = await contentService.adminCreateStarterBot(
        {
          name: body.name,
          slug: body.slug,
          language: body.language,
          entrypoint: body.entrypoint,
          description: body.description,
          zipBuffer,
        },
        actor
      );
      return reply.status(201).send({ template });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /api/v2/organizer/starter-bots/:id/archive
  app.post<{ Params: { id: string } }>('/api/v2/organizer/starter-bots/:id/archive', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      reply.header('Cache-Control', 'private, no-store');
      await contentService.adminArchiveStarterBot(request.params.id, actor);
      return reply.send({ archived: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
