import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService } from '../identity/service.js';
import { requireRecentReauth } from '../identity/routes.js';
import type { DisputeService } from './dispute-service.js';
import type { CorrectionCommand, CorrectionService } from './correction-service.js';

const COOKIE_NAME = 'oantuti_session';
// Mirror of ratings/routes.ts: the target tables store UUID columns, so a non-UUID identifier
// would surface PostgreSQL's 22P02 verbatim; callers get a structured 400 instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function registerAdjudicationRoutes(
  app: FastifyInstance,
  disputeService: DisputeService,
  correctionService: CorrectionService,
  identityService: IdentityService
): void {
  async function requireActor(req: FastifyRequest, reply: FastifyReply) {
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
    return auth.actor;
  }

  // POST /api/v2/tournaments/:id/disputes
  app.post<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/disputes',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;

      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ error: 'INVALID_TOURNAMENT_ID' });
      }

      const body = req.body as { encounterId?: string; teamId?: string; reason?: string };
      if (!body?.encounterId || !body?.teamId || !body?.reason) {
        return reply.code(400).send({ error: 'encounterId, teamId, and reason are required' });
      }
      if (!UUID_RE.test(body.encounterId) || !UUID_RE.test(body.teamId)) {
        return reply.code(400).send({ error: 'INVALID_DISPUTE_TARGET' });
      }

      try {
        const dispute = await disputeService.createDispute(actor, {
          tournamentId: req.params.id,
          encounterId: body.encounterId,
          teamId: body.teamId,
          reason: body.reason,
        });
        return reply.code(201).send(dispute);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // GET /api/v2/tournaments/:id/disputes
  // Appeal text and adjudicator notes are private: the actor decides the scope, and an
  // unauthenticated caller gets nothing at all.
  app.get<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/disputes',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ error: 'INVALID_TOURNAMENT_ID' });
      }
      const disputes = await disputeService.listDisputes(req.params.id, actor);
      return reply.code(200).send({ disputes });
    }
  );

  // POST /api/v2/organizer/disputes/:id/resolve
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/disputes/:id/resolve',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ error: 'INVALID_DISPUTE_ID' });
      }

      const body = req.body as { decision?: 'RESOLVED' | 'REJECTED'; note?: string };
      if (body?.decision !== 'RESOLVED' && body?.decision !== 'REJECTED') {
        return reply.code(400).send({ error: "decision must be 'RESOLVED' or 'REJECTED'" });
      }

      try {
        const resolved = await disputeService.resolveDispute(
          actor,
          req.params.id,
          body.decision,
          body.note ?? ''
        );
        return reply.code(200).send(resolved);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/teams/:teamId/disqualify  body: { reason, stage? }
  // Upheld disqualification: every encounter of the team in the stage is voided and the schedule
  // from the earliest affected round is rebuilt without it.
  app.post<{ Params: { id: string; teamId: string } }>(
    '/api/v2/organizer/tournaments/:id/teams/:teamId/disqualify',
    async (req: FastifyRequest<{ Params: { id: string; teamId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ error: 'INVALID_TOURNAMENT_ID' });
      }
      if (!UUID_RE.test(req.params.teamId)) {
        return reply.code(400).send({ error: 'INVALID_TEAM_ID' });
      }
      // Destructive: voiding a stage's results changes standings and the bracket.
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      const body = (req.body ?? {}) as { reason?: unknown; stage?: unknown };
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        return reply.code(400).send({ error: 'reason is required' });
      }
      if (body.stage !== undefined && typeof body.stage !== 'string') {
        return reply.code(400).send({ error: 'stage must be a string' });
      }

      try {
        const result = await correctionService.disqualifyTeam(
          req.params.id,
          req.params.teamId,
          { reason: body.reason, ...(typeof body.stage === 'string' ? { stage: body.stage } : {}) },
          { actor, requestId: req.id ?? 'req_disqualify' }
        );
        return reply.code(200).send(result);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/games/:id/preview-correction
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/games/:id/preview-correction',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ error: 'INVALID_GAME_ID' });
      }

      const body = req.body as CorrectionCommand;
      if (!body?.action || !body?.reason || typeof body?.expectedRevision !== 'number') {
        return reply.code(400).send({ error: 'action, reason, and expectedRevision required' });
      }

      try {
        const preview = await correctionService.previewCorrection(req.params.id, body, {
          actor,
          requestId: req.id ?? 'req_preview',
        });
        return reply.code(200).send(preview);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/games/:id/apply-correction
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/games/:id/apply-correction',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }

      // Only the *apply* half is guarded: a preview changes nothing, so the operator can inspect the
      // impact first and is asked for the password only when the correction becomes destructive.
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ error: 'INVALID_GAME_ID' });
      }
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      const body = req.body as { command: CorrectionCommand; previewDigest: string };
      if (!body?.command || typeof body.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewDigest)) {
        return reply.code(400).send({ error: 'command and SHA-256 previewDigest required' });
      }

      try {
        const receipt = await correctionService.applyCorrection(
          req.params.id,
          body.command,
          body.previewDigest,
          {
            actor,
            requestId: req.id ?? 'req_apply',
            ...(typeof req.headers['idempotency-key'] === 'string'
              ? { idempotencyKey: req.headers['idempotency-key'] } : {}),
          }
        );
        return reply.code(200).send(receipt);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );
}
