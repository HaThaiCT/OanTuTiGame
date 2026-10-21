import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MapDescriptor } from '@oantuti/engine';
import type { IdentityService } from '../identity/service.js';
import { requireRecentReauth, sendProfileDisabled } from '../identity/routes.js';
import type { MapService, VersionedMapRow } from './map-service.js';
import type { TournamentLifecycleService } from './lifecycle-service.js';
import type { TournamentAdmissionService, TournamentFormat } from './admission-service.js';
import { TOURNAMENT_FORMATS } from './admission-service.js';
import type { TournamentEntryCodeService } from './entry-code-service.js';
import type { TournamentSchedulerService } from './scheduler-service.js';
import type { MatchExecutionService } from './execution-service.js';
import type { TournamentAutoRunner } from './auto-runner.js';
import type { PostgresDatabase } from '../persistence/db.js';
import type { Actor, CommandContext } from '@oantuti/protocol';

const COOKIE_NAME = 'oantuti_session';

/**
 * Context for the lifecycle commands. `Idempotency-Key` makes a double click or a lost ack return the
 * original receipt instead of repeating the effect, and an `expectedVersion` in the body rejects a
 * caller that acted on a stale view (03-ARCHITECTURE §68/§166).
 */
function lifecycleContext(req: FastifyRequest, actor: Actor, fallbackRequestId: string): CommandContext {
  const body = (req.body ?? {}) as { expectedVersion?: unknown };
  const header = req.headers['idempotency-key'];
  const idempotencyKey = typeof header === 'string' && header.trim() !== '' ? header.trim() : undefined;
  return {
    actor,
    requestId: req.id ?? fallbackRequestId,
    ...(typeof body.expectedVersion === 'number' ? { expectedVersion: body.expectedVersion } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}


/**
 * Outbox topics that may surface on the public tournament timeline. The payloads below are
 * counts/timestamps only; private topics (disputes, submissions, corrections, draining) stay out.
 */
const PUBLIC_ANNOUNCEMENT_TOPICS = [
  'TOURNAMENT_PUBLISHED',
  'REGISTRATION_OPENED',
  'REGISTRATION_CLOSED',
  'TOURNAMENT_LOCKED',
  'TOURNAMENT_STARTED',
  'TOURNAMENT_PAUSED',
  'TOURNAMENT_RESUMED',
  'ROUND_SCHEDULED',
  'TOURNAMENT_PROVISIONAL',
  'TOURNAMENT_REOPENED',
  'TOURNAMENT_NO_CHAMPION',
  'TOURNAMENT_FINALIZED',
  'TOURNAMENT_ARCHIVED',
  'TEAM_WITHDRAWN',
  'ENCOUNTER_WALKOVER',
  'ENCOUNTER_DOUBLE_WITHDRAWAL',
  'TEAM_DISQUALIFIED',
  'ENCOUNTERS_VOIDED_BY_DQ',
];

/**
 * Fields that must not reach the public timeline even when the topic is allow-listed. A withdrawal
 * reason is an organizer note, not a published fact; the disqualification reason **is** the reviewed
 * public reason and stays. The ledger keeps the full payload — only the public read is trimmed.
 */
const PUBLIC_PAYLOAD_OMIT: Record<string, readonly string[]> = {
  TEAM_WITHDRAWN: ['reason'],
};

export function publicAnnouncementPayload(topic: string, payload: unknown): unknown {
  const omit = PUBLIC_PAYLOAD_OMIT[topic];
  if (!omit || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of omit) delete clone[field];
  return clone;
}

/** Newest public announcements kept in the response. */
const ANNOUNCEMENT_LIMIT = 200;

/** Service errors expose their HTTP semantics through an optional statusCode. */
function sendError(reply: FastifyReply, err: unknown, fallback = 400) {
  const statusCode =
    err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
      ? err.statusCode
      : fallback;
  return reply.code(statusCode).send({ error: err instanceof Error ? err.message : 'Request failed' });
}

/**
 * Entry-code routes answer with a machine-readable `code` so callers can tell a
 * bad code from an expired, exhausted, duplicate or under-privileged one.
 */
function sendEntryCodeError(reply: FastifyReply, err: unknown): FastifyReply {
  const statusCode =
    err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : 'ENTRY_CODE_FAILED';
  return reply.code(statusCode).send({ code, message: err instanceof Error ? err.message : 'Request failed' });
}

/** Structural gate for the raw JSON body; MapValidator applies the semantic rules afterwards. */
function isMapDescriptor(value: unknown): value is MapDescriptor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    Array.isArray(candidate.validTiles) &&
    Array.isArray(candidate.startingPieces)
  );
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

/** Cookie-session guards shared by the tournament and admission route registrars. */
function sessionGuard(identityService: IdentityService) {
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
    if(auth.actor.scope!=='FULL') { reply.code(403).send({error:'FULL_SESSION_REQUIRED'}); return null; }
    return auth.actor;
  }

  async function optionalActor(req: FastifyRequest) {
    const token = extractToken(req);
    if (!token) return undefined;
    const auth = await identityService.authenticateToken(token);
    return auth?.actor;
  }

  return { requireActor, optionalActor };
}

export function registerTournamentRoutes(
  app: FastifyInstance,
  db: PostgresDatabase,
  mapService: MapService,
  lifecycleService: TournamentLifecycleService,
  schedulerService: TournamentSchedulerService,
  identityService: IdentityService
): void {
  const { requireActor, optionalActor } = sessionGuard(identityService);

  // GET /api/v2/tournaments
  app.get('/api/v2/tournaments', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await optionalActor(req);
    const whereClause = actor?.role === 'ADMIN' ? '' : "WHERE state != 'DRAFT'";
    const res = await db.query(
      `SELECT id, name, format, state, version, rules_revision, max_teams,
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
      let stage: string = req.query.stage ?? '';
      if (stage === '') {
        const latestStageRes = await db.query<{ stage: string }>(
          `SELECT stage FROM standings_snapshots
           WHERE tournament_id = $1
           ORDER BY created_at DESC, round_ordinal DESC
           LIMIT 1`,
          [req.params.id]
        );
        stage = latestStageRes.rows[0]?.stage ?? 'MAIN';
      }

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
                e.status, e.winner_team_id, e.points_a, e.points_b,
                COALESCE(
                  json_agg(
                    json_build_object('gameId', g.id, 'gameOrdinal', g.game_ordinal, 'status', g.status)
                    ORDER BY g.game_ordinal
                  ) FILTER (WHERE g.id IS NOT NULL),
                  '[]'::json
                ) AS games
         FROM encounters e
         LEFT JOIN teams tA ON e.team_a_id = tA.id
         LEFT JOIN teams tB ON e.team_b_id = tB.id
         LEFT JOIN games g ON g.encounter_id = e.id
         WHERE e.tournament_id = $1
         GROUP BY e.id, tA.name, tB.name
         ORDER BY e.stage, e.round_ordinal ASC, e.slot_ordinal ASC`,
        [req.params.id]
      );

      // `slot_count` is the round's structural width: EMPTY slots produce no encounter row, so the
      // public bracket needs it to render those slots instead of silently dropping them.
      const roundRes = await db.query<{ stage: string; round_ordinal: number; slot_count: number; status: string }>(
        `SELECT stage, round_ordinal, slot_count, status
           FROM tournament_rounds
          WHERE tournament_id = $1
          ORDER BY stage, round_ordinal ASC`,
        [req.params.id]
      );

      return reply.code(200).send({
        tournamentId: req.params.id,
        rounds: roundRes.rows.map((round) => ({
          stage: round.stage,
          roundOrdinal: round.round_ordinal,
          slotCount: round.slot_count,
          status: round.status,
        })),
        encounters: encRes.rows,
      });
    }
  );

  // GET /api/v2/tournaments/:id/announcements
  app.get<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/announcements',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tournamentRes = await db.query<{ state: string }>(
        `SELECT state FROM tournaments WHERE id = $1`,
        [req.params.id]
      );
      const tournament = tournamentRes.rows[0];
      if (!tournament || tournament.state === 'DRAFT') {
        return reply.code(404).send({ error: `Tournament not found: ${req.params.id}` });
      }

      // outbox_events is the publication ledger; only allow-listed topics surface, newest first.
      const eventsRes = await db.query<{
        id: string;
        topic: string;
        created_at: Date;
        payload: unknown;
      }>(
        `SELECT id, topic, created_at, payload
         FROM outbox_events
         WHERE payload->>'tournamentId' = $1
           AND topic = ANY($2::text[])
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [req.params.id, PUBLIC_ANNOUNCEMENT_TOPICS, ANNOUNCEMENT_LIMIT]
      );

      return reply.code(200).send({
        announcements: eventsRes.rows.map((row) => ({
          id: row.id,
          topic: row.topic,
          createdAt: row.created_at.toISOString(),
          payload: publicAnnouncementPayload(row.topic, row.payload),
        })),
      });
    }
  );

  // GET /api/v2/maps
  app.get('/api/v2/maps', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await optionalActor(req);
    const maps = await mapService.listMaps(actor);
    return reply.code(200).send({ maps });
  });

  // GET /api/v2/maps/:slug?version=N
  app.get<{ Params: { slug: string }; Querystring: { version?: string } }>(
    '/api/v2/maps/:slug',
    async (
      req: FastifyRequest<{ Params: { slug: string }; Querystring: { version?: string } }>,
      reply: FastifyReply
    ) => {
      const actor = await optionalActor(req);

      let version: number | undefined;
      if (req.query?.version !== undefined) {
        const raw = String(req.query.version).trim();
        const parsed = Number.parseInt(raw, 10);
        if (!/^\d+$/.test(raw) || parsed < 1) {
          return reply.code(400).send({ error: 'INVALID_VERSION' });
        }
        version = parsed;
      }

      try {
        const map = await mapService.getMap(req.params.slug, actor, version);
        return reply.code(200).send(map);
      } catch (err: unknown) {
        return sendError(reply, err, 500);
      }
    }
  );

  // POST /api/v2/organizer/maps/:slug/versions  body: { descriptor }
  app.post<{ Params: { slug: string } }>(
    '/api/v2/organizer/maps/:slug/versions',
    async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }

      const body = (req.body ?? {}) as { descriptor?: unknown };
      if (body.descriptor === undefined || body.descriptor === null) {
        return reply.code(400).send({ error: 'MAP_DESCRIPTOR_REQUIRED' });
      }
      if (!isMapDescriptor(body.descriptor)) {
        return reply.code(400).send({ error: 'INVALID_DESCRIPTOR' });
      }

      try {
        const result = await mapService.publishVersion(req.params.slug, body.descriptor, actor);
        return reply.code(201).send(result);
      } catch (err: unknown) {
        return sendError(reply, err);
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
          ...lifecycleContext(req, actor, 'req_lock'),
        });
        return reply.code(200).send(receipt);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/start  body: { mapSlug?: string }
  // With a map commitment the pinned version is authoritative; mapSlug is optional and must match.
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/start',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      // Destructive: flipping a tournament to RUNNING schedules its first round.
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      const body = (req.body ?? {}) as { mapSlug?: unknown };
      const requestedSlug =
        typeof body.mapSlug === 'string' && body.mapSlug.trim() !== '' ? body.mapSlug : undefined;

      const commitment = await mapService.getMapCommitment(req.params.id);

      // Resolve and validate the round-1 map BEFORE flipping the tournament to RUNNING:
      // an unknown/hidden slug must not strand a RUNNING tournament without a round.
      let map: VersionedMapRow | undefined;
      if (commitment) {
        if (requestedSlug !== undefined && requestedSlug !== commitment.slug) {
          return reply.code(409).send({ error: 'MAP_COMMITMENT_MISMATCH' });
        }
        try {
          map = await mapService.getMap(commitment.slug, actor, commitment.version);
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      } else {
        if (requestedSlug === undefined) {
          return reply.code(400).send({ error: 'MAP_REQUIRED' });
        }
        try {
          map = await mapService.getMap(requestedSlug, actor);
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      }
      if (!map) return reply.code(404).send({ error: 'MAP_NOT_FOUND' });

      const requestId = req.id ?? 'req_start';
      let started = false;
      try {
        const receipt = await lifecycleService.start(
          req.params.id,
          lifecycleContext(req, actor, 'req_start'),
          { mapSlug: map.slug }
        );
        started = true;
        if (!commitment) {
          await mapService.recordMapUsedWithoutCommitment(req.params.id, actor, requestId);
        }
        await schedulerService.scheduleRound1(req.params.id, map.descriptor);
        return reply.code(200).send(receipt);
      } catch (err: unknown) {
        if (started) {
          // Compensating action: `start()` already advanced the tournament to RUNNING and a
          // RUNNING tournament without a scheduled round can never progress. Pause it so the
          // organizer can fix the cause and resume.
          await lifecycleService
            .pauseTournament(req.params.id, { actor, requestId: `${requestId}:compensate` })
            .catch(() => undefined);
        }
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/map-commitment  body: { slug: string }
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/map-commitment',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { slug?: unknown };
      if (typeof body.slug !== 'string' || body.slug.trim() === '') {
        return reply.code(400).send({ error: 'MAP_SLUG_REQUIRED' });
      }

      try {
        const commitment = await mapService.commitMapForTournament(req.params.id, body.slug, actor);
        return reply.code(200).send(commitment);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // GET /api/v2/organizer/tournaments/:id/map-pool
  app.get<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/map-pool',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      try {
        const pool = await mapService.getTournamentMapPool(req.params.id, actor);
        // The pool is advisory for Swiss/RR and load-bearing for knockout series (4 maps).
        const warnings = pool.length < 4 ? ['POOL_UNDER_FOUR: knockout series need at least four maps'] : [];
        return reply.code(200).send({ pool, warnings });
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/map-pool  body: { slug }
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/map-pool',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { slug?: unknown };
      if (typeof body.slug !== 'string' || body.slug.trim() === '') {
        return reply.code(400).send({ error: 'MAP_SLUG_REQUIRED' });
      }

      try {
        await mapService.addMapToPool(req.params.id, body.slug.trim(), actor);
        const pool = await mapService.getTournamentMapPool(req.params.id, actor);
        return reply.code(200).send({ pool });
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // DELETE /api/v2/organizer/tournaments/:id/map-pool/:slug
  app.delete<{ Params: { id: string; slug: string } }>(
    '/api/v2/organizer/tournaments/:id/map-pool/:slug',
    async (req: FastifyRequest<{ Params: { id: string; slug: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      try {
        await mapService.removeMapFromPool(req.params.id, req.params.slug, actor);
        const pool = await mapService.getTournamentMapPool(req.params.id, actor);
        return reply.code(200).send({ pool });
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // GET /api/v2/tournaments/:id/map-commitment
  app.get<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/map-commitment',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tourneyRes = await db.query<{ id: string; state: string }>(
        `SELECT id, state FROM tournaments WHERE id = $1`,
        [req.params.id]
      );

      const tournament = tourneyRes.rows[0];
      if (!tournament || tournament.state === 'DRAFT') {
        return reply.code(404).send({ error: `Tournament not found: ${req.params.id}` });
      }

      const commitment = await mapService.getMapCommitment(req.params.id);
      return reply.code(200).send({ commitment });
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
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      try {
        const res = await lifecycleService.pauseTournament(req.params.id, {
          ...lifecycleContext(req, actor, 'req_pause'),
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
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      try {
        const res = await lifecycleService.resumeTournament(req.params.id, {
          ...lifecycleContext(req, actor, 'req_resume'),
        });
        return reply.code(200).send(res);
      } catch (err: any) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  // Archiving never purges source, results, replay objects or retention holds.
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/archive',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;
      try {
        const receipt = await lifecycleService.archive(req.params.id, lifecycleContext(req, actor, 'req_archive'));
        return reply.code(200).send(receipt);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );
}

/** Organizer admission surface: creation, publication, registration intake, enrollment, finalization. */
export function registerAdmissionRoutes(
  app: FastifyInstance,
  admissionService: TournamentAdmissionService,
  identityService: IdentityService
): void {
  const { requireActor } = sessionGuard(identityService);

  // POST /api/v2/organizer/tournaments
  app.post('/api/v2/organizer/tournaments', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req, reply);
    if (!actor) return;
    if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

    const body = (req.body ?? {}) as {
      courseCode?: unknown;
      name?: unknown;
      format?: unknown;
      maxTeams?: unknown;
      minTeamSize?: unknown;
      maxTeamSize?: unknown;
      registrationOpensAt?: unknown;
      registrationClosesAt?: unknown;
      isRated?: unknown;
    };
    if (typeof body.courseCode !== 'string' || typeof body.name !== 'string' || typeof body.format !== 'string') {
      return reply.code(400).send({ error: 'courseCode, name, and format are required' });
    }
    if (!TOURNAMENT_FORMATS.includes(body.format as TournamentFormat)) {
      return reply.code(400).send({ error: `format must be one of ${TOURNAMENT_FORMATS.join(', ')}` });
    }
    if (body.isRated !== undefined && typeof body.isRated !== 'boolean') return reply.code(400).send({ error: 'isRated must be a boolean' });

    try {
      const tournament = await admissionService.createTournament(
        {
          courseCode: body.courseCode,
          name: body.name,
          format: body.format as TournamentFormat,
          maxTeams: typeof body.maxTeams === 'number' ? body.maxTeams : undefined,
          minTeamSize: typeof body.minTeamSize === 'number' ? body.minTeamSize : undefined,
          maxTeamSize: typeof body.maxTeamSize === 'number' ? body.maxTeamSize : undefined,
          registrationOpensAt: typeof body.registrationOpensAt === 'string' ? body.registrationOpensAt : undefined,
          isRated: body.isRated as boolean | undefined,
          registrationClosesAt: typeof body.registrationClosesAt === 'string' ? body.registrationClosesAt : undefined,
        },
        { actor, requestId: req.id }
      );
      return reply.code(201).send({ tournament });
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // POST /api/v2/organizer/tournaments/:id/publish
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/publish',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      try {
        const res = await admissionService.publishTournament(req.params.id, { actor, requestId: req.id });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/open-registration
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/open-registration',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { registrationClosesAt?: unknown };

      try {
        const res = await admissionService.openRegistration(
          req.params.id,
          typeof body.registrationClosesAt === 'string' ? body.registrationClosesAt : undefined,
          { actor, requestId: req.id }
        );
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/close-registration
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/close-registration',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      try {
        const res = await admissionService.closeRegistration(req.params.id, { actor, requestId: req.id });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/enroll
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/enroll',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if(identityService.authProfile!=='LAN_OFFLINE') return sendProfileDisabled(reply);
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { teamId?: unknown };
      if (typeof body.teamId !== 'string' || !body.teamId) {
        return reply.code(400).send({ error: 'teamId is required' });
      }

      try {
        const entry = await admissionService.enrollTeam(req.params.id, body.teamId, {
          actor,
          requestId: req.id,
        });
        return reply.code(201).send({ entry });
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/enroll/bulk  body: { teamIds: string[], dryRun?: boolean }
  // Preview by default: the response lists what would happen per team without writing anything.
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/enroll/bulk',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if(identityService.authProfile!=='LAN_OFFLINE') return sendProfileDisabled(reply);
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { teamIds?: unknown; dryRun?: unknown };
      if (!Array.isArray(body.teamIds)) {
        return reply.code(400).send({ error: 'teamIds must be an array' });
      }
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        return reply.code(400).send({ error: 'dryRun must be a boolean' });
      }

      try {
        const report = await admissionService.enrollTeamsBulk(
          req.params.id,
          body.teamIds as string[],
          { dryRun: body.dryRun !== false },
          { actor, requestId: req.id }
        );
        return reply.code(200).send(report);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/enrollments  body: { teamId }
  // Legacy alias kept for older scripts: it now goes through the one admission path (state,
  // course, team-size, capacity and backup-fence checks), instead of a second weaker copy.
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/enrollments',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if(identityService.authProfile!=='LAN_OFFLINE') return sendProfileDisabled(reply);
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { teamId?: unknown };
      if (typeof body.teamId !== 'string' || body.teamId.trim() === '') {
        return reply.code(400).send({ error: 'teamId required' });
      }

      try {
        const entry = await admissionService.enrollTeam(req.params.id, body.teamId.trim(), {
          actor,
          requestId: req.id,
        });
        return reply.code(201).send({ entry });
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // GET /api/v2/tournaments/:id/entries
  app.get<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/entries',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const entries = await admissionService.listEntries(req.params.id);
        return reply.code(200).send({ entries });
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/teams/:teamId/withdraw  body: { reason?: string }
  app.post<{ Params: { id: string; teamId: string } }>(
    '/api/v2/organizer/tournaments/:id/teams/:teamId/withdraw',
    async (req: FastifyRequest<{ Params: { id: string; teamId: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      try {
        const res = await admissionService.withdrawTeam(req.params.id, req.params.teamId, reason, {
          actor,
          requestId: req.id,
        });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/teams
  app.post('/api/v2/organizer/teams', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req, reply);
    if (!actor) return;
    if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

    const body = (req.body ?? {}) as { courseCode?: unknown; name?: unknown; captainUsername?: unknown };
    if (typeof body.courseCode !== 'string' || typeof body.name !== 'string' || typeof body.captainUsername !== 'string') {
      return reply.code(400).send({ error: 'courseCode, name, and captainUsername are required' });
    }

    try {
      const team = await admissionService.createTeam(
        { courseCode: body.courseCode, name: body.name, captainUsername: body.captainUsername },
        { actor, requestId: req.id }
      );
      return reply.code(201).send({ team });
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // POST /api/v2/organizer/tournaments/:id/finalize
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/finalize',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      try {
        const res = await admissionService.finalizeTournament(req.params.id, { actor, requestId: req.id });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/reopen
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/reopen',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      try {
        const res = await admissionService.reopenTournament(req.params.id, { actor, requestId: req.id });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/appeal-window  body: { minutes }
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/appeal-window',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      const body = (req.body ?? {}) as { minutes?: unknown };
      if (typeof body.minutes !== 'number') {
        return reply.code(400).send({ error: 'INVALID_MINUTES: minutes must be an integer between 0 and 10080' });
      }

      try {
        const res = await admissionService.setAppealWindow(req.params.id, body.minutes, {
          actor,
          requestId: req.id,
        });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );

  // POST /api/v2/organizer/tournaments/:id/grace  body: { minutes }
  // The post-round grace window: how long a completed round waits before it seals. Policy, so
  // only DRAFT/PUBLISHED accept it (it freezes when registration opens).
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/grace',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });
      if (!(await requireRecentReauth(identityService, req, reply))) return;

      const body = (req.body ?? {}) as { minutes?: unknown };
      if (typeof body.minutes !== 'number') {
        return reply.code(400).send({ error: 'INVALID_MINUTES: minutes must be an integer between 0 and 1440' });
      }

      try {
        const res = await admissionService.setGracePeriod(req.params.id, body.minutes, {
          actor,
          requestId: req.id,
        });
        return reply.code(200).send(res);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );
}

/**
 * Development-only execution surface (see MatchExecutionService: unsandboxed, gated behind
 * OANTUTI_DEV_EXECUTION=1 and refused with 409 DEV_EXECUTION_DISABLED otherwise), plus the
 * status probe of the autonomous driver that feeds it (TournamentAutoRunner).
 */
export function registerExecutionRoutes(
  app: FastifyInstance,
  executionService: MatchExecutionService,
  autoRunner: TournamentAutoRunner,
  identityService: IdentityService
): void {
  const { requireActor } = sessionGuard(identityService);

  // GET /api/v2/organizer/runner-status
  app.get('/api/v2/organizer/runner-status', async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req, reply);
    if (!actor) return;
    if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

    return reply.code(200).send(autoRunner.stats());
  });

  // POST /api/v2/organizer/tournaments/:id/run-pending-games  body: { limit?: number }
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/run-pending-games',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ error: 'FORBIDDEN' });

      const body = (req.body ?? {}) as { limit?: unknown };
      if (body.limit !== undefined && typeof body.limit !== 'number') {
        return reply.code(400).send({ error: 'INVALID_LIMIT' });
      }

      try {
        const result = await executionService.runPendingGames(req.params.id, { limit: body.limit });
        return reply.code(200).send(result);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    }
  );
}

/**
 * ONLINE shared tournament entry codes (migration 013). An organizer mints a
 * code once — the plaintext is shown only in the 201 response — and a team
 * captain (or an ADMIN) redeems it to be admitted. LAN_OFFLINE enrolls teams
 * directly and has no invite codes, so every route here is hidden there.
 */
export function registerEntryCodeRoutes(
  app: FastifyInstance,
  entryCodeService: TournamentEntryCodeService,
  identityService: IdentityService
): void {
  const { requireActor } = sessionGuard(identityService);

  app.post<{Params:{id:string;codeId:string};Body:{maxUses?:number;expiresAt?:string}}>('/api/v2/organizer/tournaments/:id/entry-codes/:codeId/rotate',async(req,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(identityService.authProfile!=='ONLINE') return sendProfileDisabled(reply);
    const actor=await requireActor(req,reply); if(!actor) return;
    try { return reply.code(201).send(await entryCodeService.rotateCode(req.params.id,req.params.codeId,req.body??{},{actor,requestId:req.id})); }
    catch(err:unknown) { return sendEntryCodeError(reply,err); }
  });
  app.post<{Params:{id:string;codeId:string}}>('/api/v2/organizer/tournaments/:id/entry-codes/:codeId/revoke',async(req,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(identityService.authProfile!=='ONLINE') return sendProfileDisabled(reply);
    const actor=await requireActor(req,reply); if(!actor) return;
    try { return await entryCodeService.revokeCode(req.params.id,req.params.codeId,{actor,requestId:req.id}); }
    catch(err:unknown) { return sendEntryCodeError(reply,err); }
  });

  // POST /api/v2/organizer/tournaments/:id/entry-code  body: { maxUses?, expiresAt? }
  app.post<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/entry-code',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);
      reply.header('Cache-Control','private, no-store');
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ code: 'FORBIDDEN', message: 'ADMIN role required' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const maxUses = typeof body.maxUses === 'number' ? body.maxUses : undefined;
      if (body.maxUses !== undefined && maxUses === undefined) {
        return reply.code(400).send({ code: 'INVALID_MAX_USES', message: 'maxUses must be a number' });
      }
      const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : undefined;
      if (body.expiresAt !== undefined && body.expiresAt !== null && expiresAt === undefined) {
        return reply.code(400).send({ code: 'INVALID_EXPIRES_AT', message: 'expiresAt must be an ISO-8601 string' });
      }

      try {
        const created = await entryCodeService.createCode(req.params.id, { maxUses, expiresAt }, { actor, requestId: req.id });
        return reply.code(201).send(created);
      } catch (err: unknown) {
        return sendEntryCodeError(reply, err);
      }
    }
  );

  // GET /api/v2/organizer/tournaments/:id/entry-codes
  app.get<{ Params: { id: string } }>(
    '/api/v2/organizer/tournaments/:id/entry-codes',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);
      reply.header('Cache-Control','private, no-store');
      const actor = await requireActor(req, reply);
      if (!actor) return;
      if (actor.role !== 'ADMIN') return reply.code(403).send({ code: 'FORBIDDEN', message: 'ADMIN role required' });

      try {
        const codes = await entryCodeService.listCodes(req.params.id, { actor, requestId: req.id });
        return reply.code(200).send({ codes });
      } catch (err: unknown) {
        return sendEntryCodeError(reply, err);
      }
    }
  );

  // POST /api/v2/tournaments/:id/join  body: { code, teamId }
  app.post<{ Params: { id: string } }>(
    '/api/v2/tournaments/:id/join',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (identityService.authProfile !== 'ONLINE') return sendProfileDisabled(reply);
      reply.header('Cache-Control','private, no-store');
      const actor = await requireActor(req, reply);
      if (!actor) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.code !== 'string' || typeof body.teamId !== 'string') {
        return reply.code(400).send({ code: 'INVALID_PAYLOAD', message: 'code and teamId are required' });
      }

      try {
        const entry = await entryCodeService.joinWithCode(
          req.params.id,
          { code: body.code, teamId: body.teamId },
          { actor, requestId: req.id, ip:req.ip }
        );
        return reply.code(201).send({ entry });
      } catch (err: unknown) {
        return sendEntryCodeError(reply, err);
      }
    }
  );
}
