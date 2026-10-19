import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TeamService } from './service.js';
import type { IdentityService } from '../identity/service.js';
import type { Actor, UUID } from '@oantuti/protocol';

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

export function registerTeamRoutes(
  app: FastifyInstance,
  teamService: TeamService,
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

  // POST /api/v2/organizer/courses
  app.post('/api/v2/organizer/courses', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const body = request.body as { code?: unknown; name?: unknown };
      if (!body || typeof body.code !== 'string' || typeof body.name !== 'string') {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'code and name required' });
      }
      const course = await teamService.createCourse(body.code, body.name, actor);
      return reply.send(course);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Course creation failed');
      return reply.status(status).send({ code: 'COURSE_FAILED', message });
    }
  });

  // POST /api/v2/organizer/teams/:id/members
  app.post('/api/v2/organizer/teams/:id/members', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const body = request.body as { userId?: unknown };
      if (!body || typeof body.userId !== 'string') {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'userId required' });
      }
      const updated = await teamService.addMember(params.id, body.userId, actor);
      return reply.send(updated);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Add member failed');
      return reply.status(status).send({ code: 'ADD_MEMBER_FAILED', message });
    }
  });

  app.get('/api/v2/organizer/teams', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const query = request.query as { q?: unknown; limit?: unknown; offset?: unknown };
      const q = typeof query.q === 'string' ? query.q : '';
      const limit = typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : 50;
      const offset = typeof query.offset === 'string' && /^\d+$/.test(query.offset) ? Number(query.offset) : 0;
      return reply.send(await teamService.listTeamsForOrganizer({ q, limit, offset }, actor));
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      return reply.status(status).send({ code: 'TEAM_SEARCH_FAILED', message: err instanceof Error ? err.message : 'Team search failed' });
    }
  });

  // GET /api/v2/teams/:id
  // The team row carries member identities (user ids, usernames), which are private: only an
  // organizer or a member of that same team may read it.
  app.get('/api/v2/teams/:id', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      if (!(actor.role === 'ADMIN' && actor.scope === 'FULL') && !actor.teamIds.includes(params.id)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Team members are private' });
      }
      const team = await teamService.getTeam(params.id);
      return reply.send(team);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Get team failed';
      return reply.status(status).send({ code: 'GET_TEAM_FAILED', message });
    }
  });

  // GET /api/v2/tournaments/:id (public)
  app.get('/api/v2/tournaments/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const tournament = await teamService.getTournamentSubstrate(params.id);
      return reply.send(tournament);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Get tournament failed';
      return reply.status(status).send({ code: 'GET_TOURNAMENT_FAILED', message });
    }
  });
}
