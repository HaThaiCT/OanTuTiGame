import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService } from '../identity/service.js';
import type { MapService } from './map-service.js';
import type { TournamentLifecycleService } from './lifecycle-service.js';
import type { PostgresDatabase } from '../persistence/db.js';

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

export function registerTournamentRoutes(
  app: FastifyInstance,
  db: PostgresDatabase,
  mapService: MapService,
  lifecycleService: TournamentLifecycleService,
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

  async function optionalActor(req: FastifyRequest) {
    const token = extractToken(req);
    if (!token) return undefined;
    const auth = await identityService.authenticateToken(token);
    return auth?.actor;
  }

  // GET /api/v2/tournaments
  app.get('/api/v2/tournaments', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await optionalActor(req);
    const whereClause = actor?.role === 'ADMIN' ? '' : "WHERE state != 'DRAFT'";
    const res = await db.query(
      `SELECT id, name, format, state, rules_revision, max_teams,
              registration_opens_at, registration_closes_at, started_at, finalized_at, created_at
       FROM tournaments
       ${whereClause}
       ORDER BY created_at DESC`
    );
    return reply.code(200).send({ tournaments: res.rows });
  });


  // GET /api/v2/tournaments/:id/standings
  app.get<{ Params: { id: string }; Querystring: { stage?: string; round?: string } }>(
    '/api/v2/tournaments/:id/standings',
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { stage?: string; round?: string } }>, reply: FastifyReply) => {
      const stage = req.query.stage ?? 'MAIN';

      // Find max round if not specified
      let roundOrdinal: number;
      if (req.query.round) {
        roundOrdinal = parseInt(req.query.round, 10);
      } else {
        const maxRoundRes = await db.query<{ max_round: number | null }>(
          `SELECT MAX(round_ordinal) as max_round
           FROM standings_snapshots
           WHERE tournament_id = $1 AND stage = $2`,
          [req.params.id, stage]
        );
        roundOrdinal = maxRoundRes.rows[0]?.max_round ?? 1;
      }

      const standingsRes = await db.query(
        `SELECT ss.rank, ss.team_id, t.name as team_name, ss.points, ss.matches_played,
                ss.wins, ss.draws, ss.losses, ss.buchholz, ss.sonneborn_berger, ss.rating_elo, ss.is_qualified
         FROM standings_snapshots ss
         JOIN teams t ON ss.team_id = t.id
         WHERE ss.tournament_id = $1 AND ss.stage = $2 AND ss.round_ordinal = $3
         ORDER BY ss.rank ASC`,
        [req.params.id, stage, roundOrdinal]
      );

      return reply.code(200).send({
        tournamentId: req.params.id,
        stage,
        roundOrdinal,
        standings: standingsRes.rows,
      });
    }
  );

  // GET /api/v2/tournaments/:id/bracket
  app.get<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/bracket',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const encRes = await db.query(
        `SELECT e.id as encounter_id, e.stage, e.round_ordinal, e.slot_ordinal,
                e.team_a_id, tA.name as team_a_name,
                e.team_b_id, tB.name as team_b_name,
                e.status, e.winner_team_id, e.points_a, e.points_b
         FROM encounters e
         LEFT JOIN teams tA ON e.team_a_id = tA.id
         LEFT JOIN teams tB ON e.team_b_id = tB.id
         WHERE e.tournament_id = $1
         ORDER BY e.stage, e.round_ordinal ASC, e.slot_ordinal ASC`,
        [req.params.id]
      );

      return reply.code(200).send({
        tournamentId: req.params.id,
        encounters: encRes.rows,
      });
    }
  );

  // GET /api/v2/maps
  app.get('/api/v2/maps', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await optionalActor(req);
    const maps = await mapService.listMaps(actor);
    return reply.code(200).send({ maps });
  });

  // GET /api/v2/maps/:slug
  app.get<{ Params: { slug: string } }>(
    '/api/v2/maps/:slug',
    async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const actor = await optionalActor(req);
      try {
        const map = await mapService.getMap(req.params.slug, actor);
        return reply.code(200).send(map);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 500).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/maps
  app.post('/api/v2/organizer/maps', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req, reply);
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }

    try {
      const map = await mapService.createMap(actor, req.body as any);
      return reply.code(201).send(map);
    } catch (err: any) {
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  // POST /api/v2/organizer/tournaments/:id/lock
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/lock',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;

      try {
        const receipt = await lifecycleService.lock(req.params.id, {
          actor,
          requestId: req.id ?? 'req_lock',
        });
        return reply.code(200).send(receipt);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/start
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/start',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;

      try {
        const receipt = await lifecycleService.start(req.params.id, {
          actor,
          requestId: req.id ?? 'req_start',
        });
        return reply.code(200).send(receipt);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/extend
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/extend',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = req.body as { newClosesAt?: string };
      if (!body?.newClosesAt) {
        return reply.code(400).send({ error: 'newClosesAt ISO timestamp required' });
      }

      try {
        const res = await lifecycleService.extendRegistration(
          req.params.id,
          new Date(body.newClosesAt),
          { actor, requestId: req.id ?? 'req_extend' }
        );
        return reply.code(200).send(res);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/pause
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/pause',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      try {
        const res = await lifecycleService.pauseTournament(req.params.id, {
          actor,
          requestId: req.id ?? 'req_pause',
        });
        return reply.code(200).send(res);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/resume
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/resume',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      try {
        const res = await lifecycleService.resumeTournament(req.params.id, {
          actor,
          requestId: req.id ?? 'req_resume',
        });
        return reply.code(200).send(res);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );
}
