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

  // POST /api/v2/organizer/teams
  app.post('/api/v2/organizer/teams', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const body = request.body as { courseId?: unknown; name?: unknown; captainUserId?: unknown };
      if (!body || typeof body.courseId !== 'string' || typeof body.name !== 'string' || typeof body.captainUserId !== 'string') {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'courseId, name, and captainUserId required' });
      }
      const team = await teamService.createTeam(body.courseId, body.name, body.captainUserId, actor);
      return reply.send(team);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Team creation failed');
      return reply.status(status).send({ code: 'TEAM_FAILED', message });
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

  // GET /api/v2/teams/:id
  app.get('/api/v2/teams/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const team = await teamService.getTeam(params.id);
      return reply.send(team);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : 'Get team failed';
      return reply.status(status).send({ code: 'GET_TEAM_FAILED', message });
    }
  });

  // POST /api/v2/organizer/tournaments
  app.post('/api/v2/organizer/tournaments', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const body = request.body as {
        courseId?: unknown;
        name?: unknown;
        format?: unknown;
        maxTeams?: unknown;
        minTeamSize?: unknown;
        maxTeamSize?: unknown;
      };
      const validFormats = ['SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA'] as const;
      type Format = typeof validFormats[number];
      if (!body || typeof body.courseId !== 'string' || typeof body.name !== 'string' || typeof body.format !== 'string' || !validFormats.includes(body.format as Format)) {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'Valid courseId, name, and format required' });
      }
      const tournament = await teamService.createTournament(
        {
          courseId: body.courseId,
          name: body.name,
          format: body.format as Format,
          maxTeams: typeof body.maxTeams === 'number' ? body.maxTeams : undefined,
          minTeamSize: typeof body.minTeamSize === 'number' ? body.minTeamSize : undefined,
          maxTeamSize: typeof body.maxTeamSize === 'number' ? body.maxTeamSize : undefined,
        },
        actor
      );
      return reply.send(tournament);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Tournament creation failed');
      return reply.status(status).send({ code: 'TOURNAMENT_FAILED', message });
    }
  });

  // POST /api/v2/organizer/tournaments/:id/publish
  app.post('/api/v2/organizer/tournaments/:id/publish', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const tournament = await teamService.publishTournament(params.id, actor);
      return reply.send(tournament);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Publish failed');
      return reply.status(status).send({ code: 'PUBLISH_FAILED', message });
    }
  });

  // POST /api/v2/organizer/tournaments/:id/open-registration
  app.post('/api/v2/organizer/tournaments/:id/open-registration', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const body = (request.body as { opensAt?: unknown; closesAt?: unknown }) ?? {};
      const tournament = await teamService.openRegistration(
        params.id,
        typeof body.opensAt === 'string' ? body.opensAt : undefined,
        typeof body.closesAt === 'string' ? body.closesAt : undefined,
        actor
      );
      return reply.send(tournament);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Open registration failed');
      return reply.status(status).send({ code: 'OPEN_REG_FAILED', message });
    }
  });

  // POST /api/v2/organizer/tournaments/:id/enrollments
  app.post('/api/v2/organizer/tournaments/:id/enrollments', async (request, reply) => {
    try {
      const actor = await requireActor(request);
      const params = request.params as { id: string };
      const body = request.body as { teamId?: unknown };
      if (!body || typeof body.teamId !== 'string') {
        return reply.status(400).send({ code: 'INVALID_PAYLOAD', message: 'teamId required' });
      }
      const enrollment = await teamService.directEnrollTeam(params.id, body.teamId, actor);
      return reply.send(enrollment);
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Direct enroll failed');
      return reply.status(status).send({ code: 'ENROLL_FAILED', message });
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
