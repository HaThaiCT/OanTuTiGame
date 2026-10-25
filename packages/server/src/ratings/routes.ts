import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  Actor,
  CommandContext,
  GlobalLeaderboardDto,
  PublicTeamProfileDto,
  RatingDecisionReceipt,
  RatingReviewDto,
  TournamentRatingChangesDto,
  TournamentTeamRatingsDto,
} from '@oantuti/protocol';
import type { IdentityService } from '../identity/service.js';
import { requireRecentReauth } from '../identity/routes.js';

const COOKIE_NAME = 'oantuti_session';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Narrow dependency surface so route registration never owns rating persistence or calculations. */
export interface GlobalRatingRouteService {
  publicLeaderboard(input: { readonly limit: number; readonly cursor?: string }): Promise<GlobalLeaderboardDto>;
  publicProfile(teamId: string, input: { readonly limit: number; readonly cursor?: string }): Promise<PublicTeamProfileDto>;
  publicTournamentChanges(tournamentId: string): Promise<TournamentRatingChangesDto>;
  publicTournamentTeamRatings(tournamentId: string): Promise<TournamentTeamRatingsDto>;
  setRated(tournamentId: string, isRated: boolean, context: CommandContext): Promise<{ tournamentId: string; isRated: boolean; version: number }>;
  review(tournamentId: string): Promise<RatingReviewDto>;
  approve(tournamentId: string, command: { readonly previewDigest: string; readonly generationId: string | null; readonly expectedVersion: number }, context: CommandContext): Promise<RatingDecisionReceipt>;
  reject(tournamentId: string, command: { readonly reason: string; readonly expectedVersion: number }, context: CommandContext): Promise<RatingDecisionReceipt>;
}

function tokenFrom(request: FastifyRequest): string | undefined {
  const value = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = value?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, identityService: IdentityService): Promise<Actor | null> {
  const token = tokenFrom(request);
  if (!token) {
    reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    return null;
  }
  const session = await identityService.authenticateToken(token);
  if (!session) {
    reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'Session expired or revoked' });
    return null;
  }
  if (session.actor.role !== 'ADMIN' || session.actor.scope !== 'FULL') {
    reply.code(403).send({ code: 'FORBIDDEN', message: 'Full administrator access required' });
    return null;
  }
  return session.actor;
}

function error(reply: FastifyReply, cause: unknown, fallback: string): FastifyReply {
  const databaseCode = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  const unavailable = /^(08[A-Z0-9]{3}|53[0-9]{3}|57P0[123]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND)$/.test(databaseCode)
    || (cause instanceof Error && /connection (?:terminated|ended|timeout)|timeout exceeded when trying to connect|cannot use a pool after calling end/i.test(cause.message));
  const status = cause && typeof cause === 'object' && 'statusCode' in cause && typeof cause.statusCode === 'number' ? cause.statusCode : unavailable ? 503 : 500;
  const domainCode = cause instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(cause.message) ? cause.message : undefined;
  const code = unavailable ? 'RATING_DATABASE_UNAVAILABLE' : databaseCode || domainCode || 'RATING_REQUEST_FAILED';
  const message = unavailable ? 'Rating database unavailable; retry later.' : cause instanceof Error ? cause.message : fallback;
  return reply.code(status).send({ code, message });
}

function positiveInt(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function optionalCursor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length <= 1024 ? value : null;
}

function commandContext(request: FastifyRequest, actor: Actor, expectedVersion: number): CommandContext {
  const key = request.headers['idempotency-key'];
  return {
    actor,
    requestId: request.id,
    expectedVersion,
    ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
  };
}

export function registerGlobalRatingRoutes(
  app: FastifyInstance,
  service: GlobalRatingRouteService,
  identityService: IdentityService,
): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/v2/ratings/teams', async (request, reply) => {
    const limit = positiveInt(request.query.limit, 50, 100);
    const cursor = optionalCursor(request.query.cursor);
    if (limit === null || cursor === null) return reply.code(400).send({ code: 'INVALID_RATING_CURSOR', message: 'Invalid leaderboard pagination' });
    try {
      reply.header('Cache-Control', 'no-store');
      return reply.send(await service.publicLeaderboard({ limit, ...(cursor ? { cursor } : {}) }));
    } catch (cause) { return error(reply, cause, 'Unable to load rankings'); }
  });

  app.get<{ Params: { teamId: string }; Querystring: { limit?: string; cursor?: string } }>('/api/v2/ratings/teams/:teamId', async (request, reply) => {
    const limit = positiveInt(request.query.limit, 25, 100);
    const cursor = optionalCursor(request.query.cursor);
    if (!UUID_RE.test(request.params.teamId)) return reply.code(400).send({ code: 'INVALID_TEAM_ID', message: 'Invalid team id' });
    if (limit === null || cursor === null) return reply.code(400).send({ code: 'INVALID_RATING_CURSOR', message: 'Invalid profile pagination' });
    try {
      reply.header('Cache-Control', 'no-store');
      return reply.send(await service.publicProfile(request.params.teamId, { limit, ...(cursor ? { cursor } : {}) }));
    } catch (cause) { return error(reply, cause, 'Unable to load team rating'); }
  });

  app.get<{ Params: { id: string } }>('/api/v2/tournaments/:id/rating-changes', async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(400).send({ code: 'INVALID_TOURNAMENT_ID', message: 'Invalid tournament id' });
    try { reply.header('Cache-Control', 'no-store'); return reply.send(await service.publicTournamentChanges(request.params.id)); }
    catch (cause) { return error(reply, cause, 'Unable to load tournament rating changes'); }
  });

  app.get<{ Params: { id: string } }>('/api/v2/tournaments/:id/team-ratings', async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(400).send({ code: 'INVALID_TOURNAMENT_ID', message: 'Invalid tournament id' });
    try { reply.header('Cache-Control', 'no-store'); return reply.send(await service.publicTournamentTeamRatings(request.params.id)); }
    catch (cause) { return error(reply, cause, 'Unable to load tournament team ratings'); }
  });

  app.post<{ Params: { id: string } }>('/api/v2/organizer/tournaments/:id/rated', async (request, reply) => {
    const actor = await requireAdmin(request, reply, identityService);
    if (!actor) return;
    const body = request.body as { isRated?: unknown; expectedVersion?: unknown };
    if (!UUID_RE.test(request.params.id) || typeof body?.isRated !== 'boolean' || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
      return reply.code(400).send({ code: 'INVALID_RATED_CONFIGURATION', message: 'Invalid rated configuration request' });
    }
    try {
      return reply.send(await service.setRated(request.params.id, body.isRated, commandContext(request, actor, body.expectedVersion)));
    } catch (cause) { return error(reply, cause, 'Unable to set rated configuration'); }
  });

  app.get<{ Params: { id: string } }>('/api/v2/organizer/tournaments/:id/rating-review', async (request, reply) => {
    const actor = await requireAdmin(request, reply, identityService);
    if (!actor) return;
    if (!UUID_RE.test(request.params.id)) return reply.code(400).send({ code: 'INVALID_TOURNAMENT_ID', message: 'Invalid tournament id' });
    try { reply.header('Cache-Control', 'no-store'); return reply.send(await service.review(request.params.id)); }
    catch (cause) { return error(reply, cause, 'Unable to load rating review'); }
  });

  app.post<{ Params: { id: string } }>('/api/v2/organizer/tournaments/:id/rating-approve', async (request, reply) => {
    const actor = await requireAdmin(request, reply, identityService);
    if (!actor) return;
    if (!(await requireRecentReauth(identityService, request, reply))) return;
    const body = request.body as { previewDigest?: unknown; generationId?: unknown; expectedVersion?: unknown };
    const expectedVersion = body.expectedVersion;
    if (!UUID_RE.test(request.params.id) || typeof body?.previewDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(body.previewDigest) || !(body.generationId === null || typeof body.generationId === 'string') || typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return reply.code(400).send({ code: 'INVALID_RATING_APPROVAL', message: 'Invalid rating approval request' });
    }
    try {
      const receipt = await service.approve(request.params.id, { previewDigest: body.previewDigest, generationId: body.generationId, expectedVersion }, commandContext(request, actor, expectedVersion));
      return reply.code(receipt.status === 'UPDATING' ? 202 : 200).send(receipt);
    } catch (cause) { return error(reply, cause, 'Unable to approve rating'); }
  });

  app.post<{ Params: { id: string } }>('/api/v2/organizer/tournaments/:id/rating-reject', async (request, reply) => {
    const actor = await requireAdmin(request, reply, identityService);
    if (!actor) return;
    if (!(await requireRecentReauth(identityService, request, reply))) return;
    const body = request.body as { reason?: unknown; expectedVersion?: unknown };
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const expectedVersion = body.expectedVersion;
    if (!UUID_RE.test(request.params.id) || reason.length < 3 || reason.length > 500 || typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return reply.code(400).send({ code: 'INVALID_RATING_REJECTION', message: 'Invalid rating rejection request' });
    }
    try {
      const receipt = await service.reject(request.params.id, { reason, expectedVersion }, commandContext(request, actor, expectedVersion));
      return reply.code(receipt.status === 'UPDATING' ? 202 : 200).send(receipt);
    } catch (cause) { return error(reply, cause, 'Unable to reject rating'); }
  });
}
