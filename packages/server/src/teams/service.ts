import type { PoolClient } from 'pg';
import type { Database } from '../persistence/db.js';
import type { Actor, Instant, Role, UUID } from '@oantuti/protocol';
import type { TeamDto, TournamentSubstrateDto } from '@oantuti/protocol';

export class TeamError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'TeamError';
  }
}

interface CourseRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly created_at: Date;
}

interface TeamRow {
  readonly id: string;
  readonly course_id: string;
  readonly name: string;
  readonly captain_user_id: string;
  readonly created_at: Date;
}

interface TournamentRow {
  readonly id: string;
  readonly course_id: string;
  readonly name: string;
  readonly format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
  readonly state: 'DRAFT' | 'PUBLISHED' | 'REGISTRATION_OPEN' | 'VALIDATING_SUBMISSIONS' | 'LOCKED' | 'READY_TO_START' | 'RUNNING' | 'PAUSED' | 'PROVISIONAL' | 'FINALIZED' | 'ARCHIVED' | 'CANCELLED';
  readonly version: number;
  readonly rules_revision: string;
  readonly max_teams: number;
  readonly min_team_size: number;
  readonly max_team_size: number;
  readonly registration_opens_at: Date | null;
  readonly registration_closes_at: Date | null;
  readonly created_at: Date;
}

export class TeamService {
  constructor(private readonly db: Database) {}

  async createCourse(code: string, name: string, actor: Actor): Promise<CourseRow> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can create courses');
    }
    const cleanCode = code.trim().toUpperCase();
    const cleanName = name.trim();
    if (!cleanCode || cleanCode.length > 30) {
      throw new TeamError(400, 'Invalid course code');
    }
    if (!cleanName || cleanName.length > 100) {
      throw new TeamError(400, 'Invalid course name');
    }

    const res = await this.db.query<CourseRow>(
      'INSERT INTO courses (code, name) VALUES ($1, $2) RETURNING *',
      [cleanCode, cleanName]
    );
    return res.rows[0];
  }

  async createTeam(courseId: UUID, name: string, captainUserId: UUID, actor: Actor): Promise<TeamDto> {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length < 2 || cleanName.length > 50) {
      throw new TeamError(400, 'Invalid team name');
    }

    // In LAN_OFFLINE mode, only ADMIN assigns/creates teams
    if (actor.role !== 'ADMIN' && actor.userId !== captainUserId) {
      throw new TeamError(403, 'Forbidden team creation');
    }

    return this.db.withTransaction(async (client) => {
      // Check captain exists
      const captainRes = await client.query<{ id: string; username: string; display_name: string }>(
        'SELECT id, username, display_name FROM users WHERE id = $1',
        [captainUserId]
      );
      const captain = captainRes.rows[0];
      if (!captain) {
        throw new TeamError(404, 'Captain user not found');
      }

      // Check course exists
      const courseRes = await client.query('SELECT id FROM courses WHERE id = $1', [courseId]);
      if (courseRes.rows.length === 0) {
        throw new TeamError(404, 'Course not found');
      }

      // Check name uniqueness per course
      const existingTeam = await client.query(
        'SELECT id FROM teams WHERE course_id = $1 AND name = $2',
        [courseId, cleanName]
      );
      if (existingTeam.rows.length > 0) {
        throw new TeamError(409, `Team with name "${cleanName}" already exists in this course`);
      }

      // Insert team
      const teamRes = await client.query<TeamRow>(
        `INSERT INTO teams (course_id, name, captain_user_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [courseId, cleanName, captainUserId]
      );
      const team = teamRes.rows[0];

      // Add captain membership
      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, 'CAPTAIN')`,
        [team.id, captainUserId]
      );

      return {
        id: team.id,
        courseId: team.course_id,
        name: team.name,
        captainUserId: team.captain_user_id,
        members: [
          {
            userId: captain.id,
            username: captain.username,
            displayName: captain.display_name,
            role: 'CAPTAIN',
          },
        ],
        createdAt: team.created_at.toISOString(),
      };
    });
  }

  async addMember(teamId: UUID, userId: UUID, actor: Actor): Promise<TeamDto> {
    return this.db.withTransaction(async (client) => {
      const teamRes = await client.query<TeamRow>('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
      const team = teamRes.rows[0];
      if (!team) {
        throw new TeamError(404, 'Team not found');
      }

      if (actor.role !== 'ADMIN' && actor.userId !== team.captain_user_id) {
        throw new TeamError(403, 'Only team captain or ADMIN can add team members');
      }

      // Check user exists
      const userRes = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        throw new TeamError(404, 'User not found');
      }

      // Check current members count
      const countRes = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM team_memberships WHERE team_id = $1',
        [teamId]
      );
      const currentCount = parseInt(countRes.rows[0].count, 10);
      if (currentCount >= 5) {
        throw new TeamError(409, 'Team has reached maximum allowed members (5)');
      }

      // Insert membership (unique constraint will catch duplicate)
      try {
        await client.query(
          `INSERT INTO team_memberships (team_id, user_id, role)
           VALUES ($1, $2, 'MEMBER')`,
          [teamId, userId]
        );
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
          throw new TeamError(409, 'User is already a member of this team');
        }
        throw err;
      }

      return this.getTeam(teamId, client);
    });
  }

  async getTeam(teamId: UUID, client?: PoolClient): Promise<TeamDto> {
    const q = client ? client.query.bind(client) : this.db.query.bind(this.db);
    const teamRes = await q<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    const team = teamRes.rows[0];
    if (!team) {
      throw new TeamError(404, 'Team not found');
    }

    const membersRes = await q<{
      user_id: string;
      username: string;
      display_name: string;
      role: 'CAPTAIN' | 'MEMBER';
    }>(
      `SELECT tm.user_id, u.username, u.display_name, tm.role
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.created_at ASC`,
      [teamId]
    );

    return {
      id: team.id,
      courseId: team.course_id,
      name: team.name,
      captainUserId: team.captain_user_id,
      members: membersRes.rows.map((m) => ({
        userId: m.user_id,
        username: m.username,
        displayName: m.display_name,
        role: m.role,
      })),
      createdAt: team.created_at.toISOString(),
    };
  }

  // --- TOURNAMENT ADMISSION SUBSTRATE (T2/S03) ---

  async createTournament(
    input: {
      courseId: UUID;
      name: string;
      format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
      maxTeams?: number;
      minTeamSize?: number;
      maxTeamSize?: number;
    },
    actor: Actor
  ): Promise<TournamentSubstrateDto> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can create tournaments');
    }

    const cleanName = input.name.trim();
    if (!cleanName || cleanName.length < 2 || cleanName.length > 100) {
      throw new TeamError(400, 'Invalid tournament name');
    }

    const maxTeams = input.maxTeams ?? 500;
    const minTeamSize = input.minTeamSize ?? 1;
    const maxTeamSize = input.maxTeamSize ?? 3;

    if (maxTeams < 1 || minTeamSize < 1 || maxTeamSize < minTeamSize || maxTeamSize > 5) {
      throw new TeamError(400, 'Invalid tournament constraints');
    }

    const res = await this.db.query<TournamentRow>(
      `INSERT INTO tournaments (course_id, name, format, max_teams, min_team_size, max_team_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.courseId, cleanName, input.format, maxTeams, minTeamSize, maxTeamSize]
    );

    const t = res.rows[0];
    return {
      id: t.id,
      courseId: t.course_id,
      name: t.name,
      format: t.format,
      state: t.state,
      version: t.version,
      rulesRevision: t.rules_revision,
      maxTeams: t.max_teams,
      minTeamSize: t.min_team_size,
      maxTeamSize: t.max_team_size,
      admittedTeamCount: 0,
      createdAt: t.created_at.toISOString(),
    };
  }

  async publishTournament(tournamentId: UUID, actor: Actor): Promise<TournamentSubstrateDto> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can publish tournaments');
    }
    const res = await this.db.query<TournamentRow>(
      `UPDATE tournaments
       SET state = 'PUBLISHED', updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND state = 'DRAFT'
       RETURNING *`,
      [tournamentId]
    );
    if (res.rows.length === 0) {
      throw new TeamError(409, 'Tournament not found or not in DRAFT state');
    }
    return this.getTournamentSubstrate(tournamentId);
  }

  async openRegistration(
    tournamentId: UUID,
    opensAt: Instant | undefined,
    closesAt: Instant | undefined,
    actor: Actor
  ): Promise<TournamentSubstrateDto> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can open registration');
    }

    const res = await this.db.query<TournamentRow>(
      `UPDATE tournaments
       SET state = 'REGISTRATION_OPEN',
           registration_opens_at = COALESCE($2::timestamptz, clock_timestamp()),
           registration_closes_at = $3::timestamptz,
           updated_at = clock_timestamp(),
           version = version + 1
       WHERE id = $1 AND state IN ('DRAFT', 'PUBLISHED')
       RETURNING *`,
      [tournamentId, opensAt, closesAt]
    );
    if (res.rows.length === 0) {
      throw new TeamError(409, 'Tournament not found or cannot transition to REGISTRATION_OPEN');
    }
    return this.getTournamentSubstrate(tournamentId);
  }

  async getTournamentSubstrate(tournamentId: UUID): Promise<TournamentSubstrateDto> {
    const res = await this.db.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    const t = res.rows[0];
    if (!t) {
      throw new TeamError(404, 'Tournament not found');
    }

    const countRes = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tournament_admissions WHERE tournament_id = $1',
      [tournamentId]
    );

    return {
      id: t.id,
      courseId: t.course_id,
      name: t.name,
      format: t.format,
      state: t.state,
      version: t.version,
      rulesRevision: t.rules_revision,
      maxTeams: t.max_teams,
      minTeamSize: t.min_team_size,
      maxTeamSize: t.max_team_size,
      registrationOpensAt: t.registration_opens_at?.toISOString(),
      registrationClosesAt: t.registration_closes_at?.toISOString(),
      admittedTeamCount: parseInt(countRes.rows[0].count, 10),
      createdAt: t.created_at.toISOString(),
    };
  }
}
