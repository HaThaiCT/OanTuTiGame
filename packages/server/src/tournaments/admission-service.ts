import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CommandContext } from '@oantuti/protocol';
import type { BackupFence } from '../operations/backup-fence.js';
import type { PostgresDatabase } from '../persistence/db.js';
import { TournamentError } from './lifecycle-service.js';
import { isEncounterStarted } from './encounter-state.js';

import type { GlobalTeamRatingService } from '../ratings/service.js';
export type TournamentFormat = 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';

export const TOURNAMENT_FORMATS: readonly TournamentFormat[] = [
  'SINGLE_ELIMINATION',
  'SWISS_PLAYOFF',
  'ROUND_ROBIN',
  'ELO_ARENA',
];

const ENROLLABLE_STATES = ['REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS'];

/** Upper bound for one bulk paste; the field itself is capped at 500 teams by policy. */
const MAX_BULK_TEAMS = 500;

/** Outcome of one submitted team in a bulk enrollment request. */
export type BulkEnrollmentStatus =
  | 'READY'
  | 'ALREADY_ENROLLED'
  | 'DUPLICATE_IN_REQUEST'
  | 'UNKNOWN_TEAM'
  | 'INVALID_ID'
  | 'CAPACITY_EXCEEDED'
  | 'TEAM_SIZE_INVALID'
  | 'TEAM_MEMBER_ALREADY_ENROLLED';

export interface BulkEnrollmentEntry {
  readonly teamId: string;
  readonly status: BulkEnrollmentStatus;
}

export interface BulkEnrollmentReport {
  readonly tournamentId: string;
  readonly dryRun: boolean;
  readonly submitted: number;
  readonly ready: number;
  readonly enrolled: number;
  readonly skipped: number;
  /** Free slots left once this request is applied. */
  readonly capacityRemaining: number;
  readonly entries: readonly BulkEnrollmentEntry[];
}
// Manual finalization is the last step of the final stage: only a completed, provisional
// tournament may be finalized, and only after the appeal window and open-dispute gates pass.
const FINALIZABLE_STATES = ['PROVISIONAL'];
/** States whose final phase (or the run leading into it) can already carry an appeal window. */
const APPEAL_WINDOW_STATES = ['RUNNING', 'PAUSED', 'PROVISIONAL', 'FINALIZED'];
const MAX_APPEAL_WINDOW_MINUTES = 10080;
/**
 * States in which the post-round grace window (015-round-grace) may still be set. It is posting
 * policy — how long a round waits to be sealed, and therefore how long a team has to dispute it —
 * so it freezes when registration opens and teams begin planning around it.
 */
const GRACE_PERIOD_STATES = ['DRAFT', 'PUBLISHED'];
const MAX_GRACE_PERIOD_MINUTES = 1440;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * audit_events.request_id is UUID-typed while Fastify request ids are free-form,
 * so non-UUID request ids are replaced by a generated correlation id.
 */
function auditRequestId(requestId: string | undefined): string {
  return requestId && UUID_PATTERN.test(requestId) ? requestId : randomUUID();
}

function normalizeCourseCode(courseCode: string): string {
  const code = typeof courseCode === 'string' ? courseCode.trim().toUpperCase() : '';
  if (!code || code.length > 30) {
    throw new TournamentError(400, 'Invalid course code');
  }
  return code;
}

function parseInstant(value: string | undefined, field: string): Date | null {
  if (value === undefined || value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TournamentError(400, `${field} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

export type TournamentSummary = {
  readonly id: string;
  readonly name: string;
  readonly format: TournamentFormat;
  readonly state: string;
  readonly rules_revision: string;
  readonly max_teams: number;
  readonly is_rated: boolean;
  readonly global_rating_policy: 'ArenaContestRating/v1';
  readonly registration_opens_at: Date | null;
  readonly registration_closes_at: Date | null;
  readonly created_at: Date;
};

export type TournamentEntrySummary = {
  readonly id: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly status: string;
  readonly seedOrdinal: number | null;
};

export type TeamSummary = {
  readonly id: string;
  readonly name: string;
  readonly courseId: string;
  readonly captainUserId: string;
};

export type DirectEnrollmentSummary = {
  readonly id: string;
  readonly tournamentId: string;
  readonly teamId: string;
  readonly status: string;
};

export interface CreateTournamentInput {
  readonly courseCode: string;
  readonly name: string;
  readonly format: TournamentFormat;
  readonly maxTeams?: number;
  readonly minTeamSize?: number;
  readonly maxTeamSize?: number;
  readonly registrationOpensAt?: string;
  readonly registrationClosesAt?: string;
  readonly isRated?: boolean;
}

export interface CreateTeamInput {
  readonly courseCode: string;
  readonly name: string;
  readonly captainUsername: string;
}

export class TournamentAdmissionService {
  constructor(
    private readonly db: PostgresDatabase,
    /**
     * Called after a live withdrawal resolved encounters. The scheduler owns rounds, so the
     * admission service cannot mark them seal-eligible itself; without this callback a round of
     * pure walkovers would never become eligible to seal.
     */
    private readonly onEncounterResolution?: (tournamentId: string) => Promise<unknown>,
    /** Protected-write fence: direct enrollment pauses while the backup heartbeat is stale. */
    private readonly backupFence?: BackupFence,
    private readonly ratingService?: GlobalTeamRatingService
  ) {}

  /** Creates a course by code when absent and a DRAFT tournament under it. */
  async createTournament(input: CreateTournamentInput, ctx: CommandContext): Promise<TournamentSummary> {
    this.requireAdmin(ctx, 'create tournaments');

    const courseCode = normalizeCourseCode(input.courseCode);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 100) {
      throw new TournamentError(400, 'Tournament name must be between 2 and 100 characters');
    }
    if (!TOURNAMENT_FORMATS.includes(input.format)) {
      throw new TournamentError(400, `Unsupported tournament format: ${input.format}`);
    }
    if (input.isRated !== undefined && typeof input.isRated !== 'boolean') throw new TournamentError(400, 'isRated must be a boolean');

    const maxTeams = input.maxTeams ?? 500;
    const minTeamSize = input.minTeamSize ?? 1;
    const maxTeamSize = input.maxTeamSize ?? 3;
    if (maxTeams < 1 || minTeamSize < 1 || maxTeamSize < minTeamSize || maxTeamSize > 5) {
      throw new TournamentError(400, 'Invalid tournament constraints');
    }

    const registrationOpensAt = parseInstant(input.registrationOpensAt, 'registrationOpensAt');
    const registrationClosesAt = parseInstant(input.registrationClosesAt, 'registrationClosesAt');
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const courseId = await this.ensureCourse(client, courseCode);

      const res = await client.query<TournamentSummary>(
        `INSERT INTO tournaments
           (course_id, name, format, max_teams, min_team_size, max_team_size,
            registration_opens_at, registration_closes_at, is_rated)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9)
         RETURNING id, name, format, state, rules_revision, max_teams, is_rated, global_rating_policy,
                   registration_opens_at, registration_closes_at, created_at`,
        [courseId, name, input.format, maxTeams, minTeamSize, maxTeamSize, registrationOpensAt, registrationClosesAt, input.isRated ?? false]
      );
      const tournament = res.rows[0];

      await this.recordAudit(client, ctx, requestId, 'TOURNAMENT_CREATED', 'tournament', tournament.id, {
        courseCode,
        courseId,
        name,
        format: input.format,
      });

      return tournament;
    });
  }

  /** DRAFT -> PUBLISHED. */
  async publishTournament(
    tournamentId: string,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; state: 'PUBLISHED' }> {
    this.requireAdmin(ctx, 'publish tournaments');
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const tournament = await this.lockTournament(client, tournamentId);
      if (tournament.state !== 'DRAFT') {
        throw new TournamentError(409, `Cannot publish tournament in state '${tournament.state}'; expected 'DRAFT'`);
      }

      const updated = await client.query<{ updated_at: Date }>(
        `UPDATE tournaments
         SET state = 'PUBLISHED', version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING updated_at`,
        [tournamentId]
      );
      const publishedAt = updated.rows[0].updated_at;

      await this.recordAudit(client, ctx, requestId, 'TOURNAMENT_PUBLISHED', 'tournament', tournamentId, {});

      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'TOURNAMENT_PUBLISHED',
        JSON.stringify({ tournamentId, publishedAt }),
      ]);

      return { tournamentId, state: 'PUBLISHED' as const };
    });
  }

  /** PUBLISHED -> REGISTRATION_OPEN; sets registration_opens_at when still null. */
  async openRegistration(
    tournamentId: string,
    registrationClosesAt: string | undefined,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; state: 'REGISTRATION_OPEN'; registrationClosesAt: string | null }> {
    this.requireAdmin(ctx, 'open tournament registration');
    const closesAt = parseInstant(registrationClosesAt, 'registrationClosesAt');
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const tournament = await this.lockTournament(client, tournamentId);
      if (tournament.state !== 'PUBLISHED') {
        throw new TournamentError(
          409,
          `Cannot open registration in state '${tournament.state}'; expected 'PUBLISHED'`
        );
      }

      const updated = await client.query<{ registration_closes_at: Date | null }>(
        `UPDATE tournaments
         SET state = 'REGISTRATION_OPEN',
             registration_opens_at = COALESCE(registration_opens_at, clock_timestamp()),
             registration_closes_at = COALESCE($2::timestamptz, registration_closes_at),
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING registration_closes_at`,
        [tournamentId, closesAt]
      );
      const closes = updated.rows[0].registration_closes_at;

      await this.recordAudit(client, ctx, requestId, 'REGISTRATION_OPENED', 'tournament', tournamentId, {
        registrationClosesAt: closes ? closes.toISOString() : null,
      });

      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'REGISTRATION_OPENED',
        JSON.stringify({ tournamentId, registrationClosesAt: closes }),
      ]);

      return {
        tournamentId,
        state: 'REGISTRATION_OPEN' as const,
        registrationClosesAt: closes ? closes.toISOString() : null,
      };
    });
  }

  /** Closes intake (REGISTRATION_OPEN -> VALIDATING_SUBMISSIONS); pending builds drain before lock. */
  async closeRegistration(
    tournamentId: string,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; state: 'VALIDATING_SUBMISSIONS' }> {
    this.requireAdmin(ctx, 'close tournament registration');
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const tournament = await this.lockTournament(client, tournamentId);
      if (tournament.state !== 'REGISTRATION_OPEN') {
        throw new TournamentError(
          409,
          `Cannot close registration in state '${tournament.state}'; expected 'REGISTRATION_OPEN'`
        );
      }

      await client.query(
        `UPDATE tournaments
         SET state = 'VALIDATING_SUBMISSIONS',
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [tournamentId]
      );

      await this.recordAudit(client, ctx, requestId, 'REGISTRATION_CLOSED', 'tournament', tournamentId, {});
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'REGISTRATION_CLOSED',
        JSON.stringify({ tournamentId, reason: 'ADMIN_CLOSED' }),
      ]);
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'TOURNAMENT_DRAINING',
        JSON.stringify({ tournamentId, reason: 'ADMIN_CLOSED' }),
      ]);

      return { tournamentId, state: 'VALIDATING_SUBMISSIONS' as const };
    });
  }

  /**
   * 01 §59/§66: a student may belong to only one team per tournament. Returns the first member of
   * `teamId` who already plays for another team of this tournament — counting teams this same bulk
   * request is about to enroll — so enrollment is where the rule becomes true for a field.
   */
  private async memberEnrollmentConflict(
    client: PoolClient,
    tournamentId: string,
    teamId: string,
    pendingTeamIds: readonly string[] = []
  ): Promise<{ username: string; teamName: string } | null> {
    const res = await client.query<{ username: string; team_name: string }>(
      `SELECT u.username, other.name AS team_name
         FROM team_memberships mine
         JOIN team_memberships theirs
           ON theirs.user_id = mine.user_id AND theirs.team_id <> mine.team_id
         JOIN teams other ON other.id = theirs.team_id
         JOIN users u ON u.id = mine.user_id
        WHERE mine.team_id = $2
          AND (
            EXISTS (SELECT 1 FROM tournament_entries e
                     WHERE e.tournament_id = $1 AND e.team_id = theirs.team_id)
            OR theirs.team_id = ANY($3::uuid[])
          )
        ORDER BY u.username
        LIMIT 1`,
      [tournamentId, teamId, pendingTeamIds.length > 0 ? [...pendingTeamIds] : []]
    );
    const row = res.rows[0];
    return row ? { username: row.username, teamName: row.team_name } : null;
  }

  /** Admits a team directly and creates its ELIGIBLE entry. */
  async enrollTeam(
    tournamentId: string,
    teamId: string,
    ctx: CommandContext
  ): Promise<DirectEnrollmentSummary> {
    this.requireAdmin(ctx, 'enroll teams into tournaments');
    if (typeof teamId !== 'string' || !teamId.trim()) {
      throw new TournamentError(400, 'teamId is required');
    }
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const tournament = await this.lockTournament(client, tournamentId);
      if (!ENROLLABLE_STATES.includes(tournament.state)) {
        throw new TournamentError(
          409,
          `Cannot enroll teams while tournament is in state '${tournament.state}'; expected ${ENROLLABLE_STATES.join(' or ')}`
        );
      }

      const teamRes = await client.query<{
        id: string;
        course_id: string;
        members: string;
      }>(
        `SELECT t.id, t.course_id,
                (SELECT count(*)::text FROM team_memberships m WHERE m.team_id = t.id) AS members
           FROM teams t WHERE t.id = $1`,
        [teamId]
      );
      if (teamRes.rows.length === 0) {
        throw new TournamentError(404, `Team not found: ${teamId}`);
      }
      const limits = await client.query<{
        course_id: string;
        min_team_size: number;
        max_team_size: number;
      }>('SELECT course_id, min_team_size, max_team_size FROM tournaments WHERE id = $1', [tournamentId]);
      const team = teamRes.rows[0];
      const tournamentLimits = limits.rows[0];
      const memberCount = Number(team.members);
      if (
        tournamentLimits &&
        (memberCount < tournamentLimits.min_team_size || memberCount > tournamentLimits.max_team_size)
      ) {
        throw new TournamentError(
          400,
          `TEAM_SIZE_INVALID: team has ${memberCount} member(s), tournament allows ${tournamentLimits.min_team_size}–${tournamentLimits.max_team_size}`
        );
      }

      const existing = await client.query<{ id: string }>(
        'SELECT id FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2',
        [tournamentId, teamId]
      );
      if (existing.rows.length > 0) {
        throw new TournamentError(409, 'Team is already enrolled in this tournament');
      }

      const conflict = await this.memberEnrollmentConflict(client, tournamentId, teamId);
      if (conflict) {
        throw new TournamentError(
          409,
          `TEAM_MEMBER_ALREADY_ENROLLED: ${conflict.username} already plays for '${conflict.teamName}' in this tournament`
        );
      }

      // `maxTeams` is an explicit operator limit, not a display hint.
      const capacity = await client.query<{ max_teams: number; used: string }>(
        `SELECT t.max_teams,
                (SELECT count(*)::text FROM tournament_entries e
                  WHERE e.tournament_id = t.id AND e.status <> 'EXCLUDED') AS used
           FROM tournaments t WHERE t.id = $1`,
        [tournamentId]
      );
      const maxTeams = capacity.rows[0]?.max_teams ?? 0;
      if (Number(capacity.rows[0]?.used ?? '0') >= maxTeams) {
        throw new TournamentError(409, `Tournament capacity of ${maxTeams} team(s) is reached`);
      }

      let admissionId: string;
      try {
        const admissionRes = await client.query<{ id: string }>(
          `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
           VALUES ($1, $2, $3, 'DIRECT_ENROLLMENT')
           RETURNING id`,
          [tournamentId, teamId, ctx.actor.userId]
        );
        admissionId = admissionRes.rows[0].id;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
          throw new TournamentError(409, 'Team is already enrolled in this tournament');
        }
        throw err;
      }

      const entryRes = await client.query<{ id: string; status: string }>(
        `INSERT INTO tournament_entries (tournament_id, team_id, status)
         VALUES ($1, $2, 'ELIGIBLE')
         RETURNING id, status`,
        [tournamentId, teamId]
      );
      const entry = entryRes.rows[0];

      await this.recordAudit(client, ctx, requestId, 'DIRECT_ENROLL_TEAM', 'tournament', tournamentId, {
        teamId,
        admissionId,
        entryId: entry.id,
      });

      return { id: entry.id, tournamentId, teamId, status: entry.status };
    });
  }

  /**
   * Direct-enrolls many teams from one paste, with a preview pass.
   *
   * `dryRun` (the default) reports exactly what would happen — unknown ids, duplicates, teams already
   * in the field, and how many slots are left — without writing anything, so a lecturer can check a
   * LAN roster before it lands. A commit is all-or-nothing on capacity: it never partially fills a
   * tournament. Teams that are unknown, duplicated or already enrolled are reported and skipped.
   */
  async enrollTeamsBulk(
    tournamentId: string,
    teamIds: readonly string[],
    options: { readonly dryRun?: boolean },
    ctx: CommandContext
  ): Promise<BulkEnrollmentReport> {
    this.requireAdmin(ctx, 'enroll teams into tournaments');
    if (!Array.isArray(teamIds) || teamIds.length === 0) {
      throw new TournamentError(400, 'teamIds must be a non-empty array');
    }
    if (teamIds.length > MAX_BULK_TEAMS) {
      throw new TournamentError(400, `At most ${MAX_BULK_TEAMS} teams can be submitted at once`);
    }
    const dryRun = options.dryRun !== false;
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const tournament = await this.lockTournament(client, tournamentId);
      if (!ENROLLABLE_STATES.includes(tournament.state)) {
        throw new TournamentError(
          409,
          `Cannot enroll teams while tournament is in state '${tournament.state}'; expected ${ENROLLABLE_STATES.join(' or ')}`
        );
      }

      // One status slot per submitted id, so the report mirrors the paste order an operator checks.
      const statuses: BulkEnrollmentStatus[] = new Array(teamIds.length).fill('INVALID_ID');
      const candidates: { teamId: string; index: number }[] = [];
      const seen = new Set<string>();
      teamIds.forEach((raw, index) => {
        const teamId = typeof raw === 'string' ? raw.trim() : '';
        if (!UUID_PATTERN.test(teamId)) {
          statuses[index] = 'INVALID_ID';
          return;
        }
        if (seen.has(teamId)) {
          statuses[index] = 'DUPLICATE_IN_REQUEST';
          return;
        }
        seen.add(teamId);
        candidates.push({ teamId, index });
      });

      const candidateIds = candidates.map((candidate) => candidate.teamId);
      const teamRows = await client.query<{
        id: string;
        course_id: string;
        members: string;
      }>(
        `SELECT t.id, t.course_id,
                (SELECT count(*)::text FROM team_memberships m WHERE m.team_id = t.id) AS members
           FROM teams t WHERE t.id = ANY($1::uuid[])`,
        [candidateIds]
      );
      const teamById = new Map(teamRows.rows.map((row) => [row.id, row]));
      const limits = await client.query<{
        course_id: string;
        min_team_size: number;
        max_team_size: number;
      }>('SELECT course_id, min_team_size, max_team_size FROM tournaments WHERE id = $1', [tournamentId]);
      const tournamentLimits = limits.rows[0];
      const alreadyEnrolled = new Set(
        (
          await client.query<{ team_id: string }>(
            'SELECT team_id FROM tournament_entries WHERE tournament_id = $1 AND team_id = ANY($2::uuid[])',
            [tournamentId, candidateIds]
          )
        ).rows.map((row) => row.team_id)
      );
      const capacity = await client.query<{ max_teams: number; used: string }>(
        `SELECT t.max_teams,
                (SELECT count(*)::text FROM tournament_entries e
                  WHERE e.tournament_id = t.id AND e.status <> 'EXCLUDED') AS used
           FROM tournaments t WHERE t.id = $1`,
        [tournamentId]
      );
      const maxTeams = capacity.rows[0]?.max_teams ?? 0;
      const used = Number(capacity.rows[0]?.used ?? '0');

      const ready: string[] = [];
      let overflow = 0;
      for (const candidate of candidates) {
        const team = teamById.get(candidate.teamId);
        if (!team) {
          statuses[candidate.index] = 'UNKNOWN_TEAM';
          continue;
        }
        const memberCount = Number(team.members);
        if (
          tournamentLimits &&
          (memberCount < tournamentLimits.min_team_size || memberCount > tournamentLimits.max_team_size)
        ) {
          statuses[candidate.index] = 'TEAM_SIZE_INVALID';
          continue;
        }
        if (alreadyEnrolled.has(candidate.teamId)) {
          statuses[candidate.index] = 'ALREADY_ENROLLED';
          continue;
        }
        const memberConflict = await this.memberEnrollmentConflict(client, tournamentId, candidate.teamId, ready);
        if (memberConflict) {
          statuses[candidate.index] = 'TEAM_MEMBER_ALREADY_ENROLLED';
          continue;
        }
        if (used + ready.length >= maxTeams) {
          statuses[candidate.index] = 'CAPACITY_EXCEEDED';
          overflow++;
          continue;
        }
        ready.push(candidate.teamId);
        statuses[candidate.index] = 'READY';
      }
      const entries: BulkEnrollmentEntry[] = teamIds.map((raw, index) => ({
        teamId: typeof raw === 'string' ? raw.trim() || String(raw) : String(raw),
        status: statuses[index] ?? 'INVALID_ID',
      }));

      if (dryRun) {
        return {
          tournamentId,
          dryRun: true,
          submitted: teamIds.length,
          ready: ready.length,
          enrolled: 0,
          skipped: teamIds.length - ready.length,
          capacityRemaining: Math.max(0, maxTeams - used - ready.length),
          entries,
        };
      }

      // All-or-nothing on capacity: a commit that cannot fit every ready team writes nothing.
      if (overflow > 0) {
        throw new TournamentError(
          409,
          `Tournament capacity of ${maxTeams} team(s) would be exceeded by ${overflow} team(s); nothing was enrolled`
        );
      }
      if (ready.length === 0) {
        throw new TournamentError(409, 'No team in this request can be enrolled; nothing was enrolled');
      }

      for (const teamId of ready) {
        await client.query(
          `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
           VALUES ($1, $2, $3, 'DIRECT_ENROLLMENT')`,
          [tournamentId, teamId, ctx.actor.userId]
        );
        await client.query(
          `INSERT INTO tournament_entries (tournament_id, team_id, status) VALUES ($1, $2, 'ELIGIBLE')`,
          [tournamentId, teamId]
        );
      }
      await this.recordAudit(client, ctx, requestId, 'DIRECT_ENROLL_TEAM_BULK', 'tournament', tournamentId, {
        submitted: teamIds.length,
        enrolled: ready.length,
        skipped: teamIds.length - ready.length,
      });
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'TEAMS_ENROLLED_BULK',
        JSON.stringify({
          tournamentId,
          enrolled: ready.length,
          skipped: teamIds.length - ready.length,
        }),
      ]);

      return {
        tournamentId,
        dryRun: false,
        submitted: teamIds.length,
        ready: ready.length,
        enrolled: ready.length,
        skipped: teamIds.length - ready.length,
        capacityRemaining: Math.max(0, maxTeams - used - ready.length),
        entries,
      };
    });
  }

  /**
   * Withdraws a team. Before the tournament starts the entry simply leaves the field; once a
   * round is scheduled the spec (02-GAMEPLAY §118/§124/§126) resolves every not-yet-started
   * encounter of that team as an unplayed result instead of inventing a score:
   *
   *   - opponent still active -> `WALKOVER`: Swiss/RR award 3 points, knockout advances the
   *     opponent, Elo moves no rating; no game is played.
   *   - opponent gone too      -> `DOUBLE_WITHDRAWAL`: 0-0, no rating.
   *
   * An encounter that already started is left alone: it finishes with the frozen Bots, and the
   * withdrawal applies to later encounters. Scheduled PENDING games of a resolved encounter are
   * cancelled so the worker never tries to play them.
   */
  async withdrawTeam(
    tournamentId: string,
    teamId: string,
    reason: string,
    ctx: CommandContext
  ): Promise<{
    tournamentId: string;
    teamId: string;
    status: 'EXCLUDED';
    walkovers: number;
    doubleWithdrawals: number;
  }> {
    this.requireAdmin(ctx, 'withdraw teams');
    const requestId = auditRequestId(ctx.requestId);
    const preStartStates = ['REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS', 'LOCKED', 'READY_TO_START'];
    const liveStates = ['RUNNING', 'PAUSED', 'PROVISIONAL'];

    return this.db.withTransaction(async (client) => {
      const tournament = await this.lockTournament(client, tournamentId);
      const preStart = preStartStates.includes(tournament.state);
      if (!preStart && !liveStates.includes(tournament.state)) {
        throw new TournamentError(
          409,
          `Cannot withdraw a team in tournament state '${tournament.state}'`
        );
      }

      const entry = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2 FOR UPDATE',
        [tournamentId, teamId]
      );
      if (entry.rows.length === 0) {
        throw new TournamentError(404, 'Team is not enrolled in this tournament');
      }
      if (entry.rows[0].status === 'EXCLUDED') {
        throw new TournamentError(409, 'Team is already withdrawn from this tournament');
      }

      let walkovers = 0;
      let doubleWithdrawals = 0;

      if (!preStart) {
        const formatRes = await client.query<{ format: string }>(
          'SELECT format FROM tournaments WHERE id = $1',
          [tournamentId]
        );
        const format = formatRes.rows[0]?.format ?? '';
        // Swiss and round robin award encounter points; knockout only needs the bracket to
        // advance and Elo rates played encounters only, so both get 0 here.
        const winnerPoints = format === 'SWISS_PLAYOFF' || format === 'ROUND_ROBIN' ? 3 : 0;

        const pending = await client.query<{ id: string; team_a_id: string; team_b_id: string | null }>(
          // `RUNNING` here means dispatched, not playing: only a claimed game proves the encounter
          // started, which the isEncounterStarted() guard below decides.
          `SELECT id, team_a_id, team_b_id FROM encounters
            WHERE tournament_id = $1 AND status IN ('PENDING', 'RUNNING')
              AND (team_a_id = $2 OR team_b_id = $2)
            FOR UPDATE`,
          [tournamentId, teamId]
        );

        for (const encounter of pending.rows) {
          const opponentId = encounter.team_a_id === teamId ? encounter.team_b_id : encounter.team_a_id;
          if (!opponentId) continue;

          // Only a *claimed* game means the encounter really started; a dispatched-but-untouched
          // encounter is still resolvable as a walkover (02-GAMEPLAY §118/§124).
          if (await isEncounterStarted(client, encounter.id)) continue;

          const opponent = await client.query<{ status: string }>(
            'SELECT status FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2',
            [tournamentId, opponentId]
          );
          const opponentActive = opponent.rows[0]?.status === 'ELIGIBLE';
          const aWins = opponentActive && encounter.team_a_id === opponentId;
          const bWins = opponentActive && encounter.team_b_id === opponentId;

          await client.query(
            `UPDATE encounters
                SET status = $2, winner_team_id = $3, points_a = $4, points_b = $5
              WHERE id = $1`,
            [
              encounter.id,
              opponentActive ? 'WALKOVER' : 'DOUBLE_WITHDRAWAL',
              opponentActive ? opponentId : null,
              aWins ? winnerPoints : 0,
              bWins ? winnerPoints : 0,
            ]
          );
          // Dispatched games are `RUNNING` before any worker touches them: everything that is not
          // COMPLETED must be withdrawn, and the pending jobs blocked, or the worker would still
          // play a game whose encounter is already resolved.
          await client.query(
            `UPDATE games SET status = 'CANCELLED'
              WHERE encounter_id = $1 AND status <> 'COMPLETED'`,
            [encounter.id]
          );
          await client.query(
            `UPDATE jobs SET state = 'BLOCKED', updated_at = clock_timestamp()
              WHERE job_type = 'GAME'
                AND target_id IN (SELECT id FROM games WHERE encounter_id = $1)
                AND state IN ('QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING', 'RETRY_WAIT')`,
            [encounter.id]
          );
          await client.query(`DELETE FROM rating_events WHERE encounter_id = $1`, [encounter.id]);
          await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
            opponentActive ? 'ENCOUNTER_WALKOVER' : 'ENCOUNTER_DOUBLE_WITHDRAWAL',
            JSON.stringify({
              tournamentId,
              encounterId: encounter.id,
              withdrawnTeamId: teamId,
              opponentTeamId: opponentActive ? opponentId : null,
              points: aWins ? winnerPoints : bWins ? winnerPoints : 0,
            }),
          ]);
          if (opponentActive) walkovers++;
          else doubleWithdrawals++;
        }
      }

      await client.query(
        `UPDATE tournament_entries
            SET status = 'EXCLUDED', frozen_submission_id = NULL,
                global_rating_exclusion = $3
          WHERE tournament_id = $1 AND team_id = $2`,
        [tournamentId, teamId, preStart ? 'PRESTART_EXCLUDED' : 'WITHDRAWN']
      );
      await this.recordAudit(client, ctx, requestId, 'TEAM_WITHDRAWN', 'tournament', tournamentId, {
        teamId,
        reason: reason.slice(0, 500),
        walkovers,
        doubleWithdrawals,
      });
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'TEAM_WITHDRAWN',
        JSON.stringify({
          tournamentId,
          teamId,
          reason: reason.slice(0, 500),
          walkovers,
          doubleWithdrawals,
        }),
      ]);

      return { tournamentId, teamId, status: 'EXCLUDED' as const, walkovers, doubleWithdrawals };
    }).then(async (result) => {
      // A round made entirely of walkovers has no game completion to trigger the seal sweep.
      if (result.walkovers + result.doubleWithdrawals > 0 && this.onEncounterResolution) {
        await this.onEncounterResolution(tournamentId);
      }
      return result;
    });
  }

  /** Public entry list; DRAFT tournaments stay invisible. */
  async listEntries(tournamentId: string): Promise<TournamentEntrySummary[]> {
    const tournamentRes = await this.db.query<{ id: string; state: string }>(
      'SELECT id, state FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    const tournament = tournamentRes.rows[0];
    if (!tournament || tournament.state === 'DRAFT') {
      throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
    }

    const res = await this.db.query<{
      id: string;
      team_id: string;
      team_name: string;
      status: string;
      seed_ordinal: number | null;
    }>(
      `SELECT e.id, e.team_id, t.name AS team_name, e.status, e.seed_ordinal
       FROM tournament_entries e
       JOIN teams t ON t.id = e.team_id
       WHERE e.tournament_id = $1
       ORDER BY e.seed_ordinal ASC NULLS LAST, t.name ASC`,
      [tournamentId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      teamId: row.team_id,
      teamName: row.team_name,
      status: row.status,
      seedOrdinal: row.seed_ordinal,
    }));
  }

  /** Creates the course by code when absent plus a team captained by an existing user. */
  async createTeam(input: CreateTeamInput, ctx: CommandContext): Promise<TeamSummary> {
    this.requireAdmin(ctx, 'create teams');

    const courseCode = normalizeCourseCode(input.courseCode);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 50) {
      throw new TournamentError(400, 'Invalid team name');
    }
    const captainUsername = typeof input.captainUsername === 'string' ? input.captainUsername.trim() : '';
    if (!captainUsername) {
      throw new TournamentError(400, 'captainUsername is required');
    }
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const courseId = await this.ensureCourse(client, courseCode);

      const captainRes = await client.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [
        captainUsername,
      ]);
      const captain = captainRes.rows[0];
      if (!captain) {
        throw new TournamentError(404, `Captain user not found: ${captainUsername}`);
      }

      let team: { id: string; name: string; course_id: string; captain_user_id: string };
      try {
        const teamRes = await client.query<{
          id: string;
          name: string;
          course_id: string;
          captain_user_id: string;
        }>(
          `INSERT INTO teams (course_id, name, captain_user_id)
           VALUES ($1, $2, $3)
           RETURNING id, name, course_id, captain_user_id`,
          [courseId, name, captain.id]
        );
        team = teamRes.rows[0];
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
          throw new TournamentError(409, `Team "${name}" already exists in course ${courseCode}`);
        }
        throw err;
      }

      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, 'CAPTAIN')`,
        [team.id, captain.id]
      );

      await this.recordAudit(client, ctx, requestId, 'TEAM_CREATED', 'team', team.id, {
        courseCode,
        courseId,
        captainUserId: captain.id,
      });

      return { id: team.id, name: team.name, courseId: team.course_id, captainUserId: team.captain_user_id };
    });
  }

  /** RUNNING or PROVISIONAL -> FINALIZED. */
  async finalizeTournament(
    tournamentId: string,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; state: 'FINALIZED' }> {
    this.requireAdmin(ctx, 'finalize tournaments');
    const requestId = auditRequestId(ctx.requestId);


    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const rated = this.ratingService ? await this.ratingService.lockForTournamentTransition(client, tournamentId) : false;
      if (!this.ratingService) {
        const ratingConfig = await client.query<{ is_rated: boolean }>('SELECT is_rated FROM tournaments WHERE id=$1', [tournamentId]);
        if (ratingConfig.rows[0]?.is_rated) throw new TournamentError(503, 'GLOBAL_RATING_SERVICE_UNAVAILABLE');
      }
      const tournament = await this.lockTournament(client, tournamentId);
      if (!FINALIZABLE_STATES.includes(tournament.state)) {
        throw new TournamentError(
          409,
          `Cannot finalize tournament in state '${tournament.state}'; expected ${FINALIZABLE_STATES.join(' or ')}`
        );
      }

      if (tournament.state === 'PROVISIONAL') {
        const disputesRes = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM disputes
           WHERE tournament_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')`,
          [tournamentId]
        );
        const openDisputes = parseInt(disputesRes.rows[0].count, 10);
        if (openDisputes > 0) {
          throw new TournamentError(
            409,
            `OPEN_DISPUTES_BLOCK_FINALIZATION: ${openDisputes} unresolved dispute(s) must be decided before finalization`
          );
        }

        // The clock starts when the scheduler parked the tournament at PROVISIONAL. Rounded up
        // so a partially elapsed minute still reports 1; a 0-minute window is already elapsed
        // and therefore never bypasses the dispute gate above.
        const windowRes = await client.query<{ remaining_minutes: number }>(
          `SELECT GREATEST(
                    0,
                    CEIL(EXTRACT(EPOCH FROM (
                      provisional_at + final_appeal_window_minutes * INTERVAL '1 minute' - clock_timestamp()
                    )) / 60)
                  )::int AS remaining_minutes
           FROM tournaments
           WHERE id = $1`,
          [tournamentId]
        );
        const remainingMinutes = windowRes.rows[0]?.remaining_minutes ?? 0;
        if (remainingMinutes > 0) {
          throw new TournamentError(409, `APPEAL_WINDOW_OPEN: ${remainingMinutes} minute(s) remaining`);
        }
      }

      const updated = await client.query<{ finalized_at: Date }>(
        `UPDATE tournaments
         SET state = 'FINALIZED',
             finalized_at = clock_timestamp(),
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING finalized_at`,
        [tournamentId]
      );
      const finalizedAt = updated.rows[0].finalized_at;
      if (rated) await this.ratingService!.prepareFinalization(client, tournamentId);

      await this.recordAudit(client, ctx, requestId, 'TOURNAMENT_FINALIZED', 'tournament', tournamentId, {
        finalizedAt: finalizedAt.toISOString(),
      });

      await client.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
        ['TOURNAMENT_FINALIZED', JSON.stringify({ tournamentId, finalizedAt })]
      );

      return { tournamentId, state: 'FINALIZED' as const };
    });
  }

  /**
   * Sets the final-appeal window (0–10080 minutes) that must elapse from `provisional_at`
   * before the tournament may finalize. Only states that can already carry the window accept it.
   */
  async setAppealWindow(
    tournamentId: string,
    minutes: number,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; finalAppealWindowMinutes: number }> {
    this.requireAdmin(ctx, 'set the appeal window');
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_APPEAL_WINDOW_MINUTES) {
      throw new TournamentError(
        400,
        `INVALID_MINUTES: minutes must be an integer between 0 and ${MAX_APPEAL_WINDOW_MINUTES}`
      );
    }
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const tournament = await this.lockTournament(client, tournamentId);
      if (!APPEAL_WINDOW_STATES.includes(tournament.state)) {
        throw new TournamentError(
          409,
          `Cannot set the appeal window in state '${tournament.state}'; expected ${APPEAL_WINDOW_STATES.join(', ')}`
        );
      }

      const updated = await client.query<{ final_appeal_window_minutes: number }>(
        `UPDATE tournaments
         SET final_appeal_window_minutes = $2,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING final_appeal_window_minutes`,
        [tournamentId, minutes]
      );

      await this.recordAudit(client, ctx, requestId, 'APPEAL_WINDOW_SET', 'tournament', tournamentId, {
        minutes,
      });

      return { tournamentId, finalAppealWindowMinutes: updated.rows[0].final_appeal_window_minutes };
    });
  }

  /**
   * Sets the post-round grace window (0–1440 minutes) that must elapse after a round's last
   * encounter goes terminal before the scheduler may seal it and generate the next round.
   *
   * Only DRAFT/PUBLISHED accept it: once registration opens, the window is the guarantee a team
   * plans its dispute around, and the scheduler already anchors eligibility to the tournament's
   * current value.
   */
  async setGracePeriod(
    tournamentId: string,
    minutes: number,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; gracePeriodMinutes: number }> {
    this.requireAdmin(ctx, 'set the round grace period');
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_GRACE_PERIOD_MINUTES) {
      throw new TournamentError(
        400,
        `INVALID_MINUTES: minutes must be an integer between 0 and ${MAX_GRACE_PERIOD_MINUTES}`
      );
    }
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const tournament = await this.lockTournament(client, tournamentId);
      if (!GRACE_PERIOD_STATES.includes(tournament.state)) {
        throw new TournamentError(
          409,
          `Cannot set the grace period in state '${tournament.state}'; expected ${GRACE_PERIOD_STATES.join(', ')}`
        );
      }

      const updated = await client.query<{ grace_period_minutes: number }>(
        `UPDATE tournaments
         SET grace_period_minutes = $2,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING grace_period_minutes`,
        [tournamentId, minutes]
      );

      await this.recordAudit(client, ctx, requestId, 'GRACE_PERIOD_SET', 'tournament', tournamentId, {
        minutes,
      });

      return { tournamentId, gracePeriodMinutes: updated.rows[0].grace_period_minutes };
    });
  }

  /** Explicitly reopens a finalized tournament so corrections can be recorded and re-finalized. */
  async reopenTournament(
    tournamentId: string,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; state: 'PROVISIONAL' }> {
    this.requireAdmin(ctx, 'reopen tournaments');
    const requestId = auditRequestId(ctx.requestId);


    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const rated = this.ratingService ? await this.ratingService.lockForTournamentTransition(client, tournamentId) : false;
      if (!this.ratingService) {
        const ratingConfig = await client.query<{ is_rated: boolean }>('SELECT is_rated FROM tournaments WHERE id=$1', [tournamentId]);
        if (ratingConfig.rows[0]?.is_rated) throw new TournamentError(503, 'GLOBAL_RATING_SERVICE_UNAVAILABLE');
      }
      const tournament = await this.lockTournament(client, tournamentId);
      if (tournament.state !== 'FINALIZED') {
        throw new TournamentError(
          409,
          `Cannot reopen tournament in state '${tournament.state}'; expected 'FINALIZED'`
        );
      }

      if (rated) await this.ratingService!.invalidateOnReopen(client, tournamentId, ctx);
      const updated = await client.query<{ provisional_at: Date }>(
        `UPDATE tournaments
         SET state = 'PROVISIONAL',
             finalized_at = NULL,
             provisional_at = clock_timestamp(),
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING provisional_at`,
        [tournamentId]
      );
      const provisionalAt = updated.rows[0].provisional_at;

      await this.recordAudit(client, ctx, requestId, 'TOURNAMENT_REOPENED', 'tournament', tournamentId, {
        provisionalAt: provisionalAt.toISOString(),
      });
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'TOURNAMENT_REOPENED',
        JSON.stringify({ tournamentId, provisionalAt: provisionalAt.toISOString() }),
      ]);

      return { tournamentId, state: 'PROVISIONAL' as const };
    });
  }

  private requireAdmin(ctx: CommandContext, action: string): void {
    if (ctx.actor.role !== 'ADMIN') {
      throw new TournamentError(403, `Only administrators can ${action}`);
    }
  }

  private async lockTournament(client: PoolClient, tournamentId: string): Promise<{ id: string; state: string }> {
    const res = await client.query<{ id: string; state: string }>(
      'SELECT id, state FROM tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId]
    );
    const tournament = res.rows[0];
    if (!tournament) {
      throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
    }
    return tournament;
  }

  private async ensureCourse(client: PoolClient, courseCode: string): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, $1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
       RETURNING id`,
      [courseCode]
    );
    return res.rows[0].id;
  }

  private async recordAudit(
    client: PoolClient,
    ctx: CommandContext,
    requestId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.actor.userId, action, resourceType, resourceId, requestId, JSON.stringify(details)]
    );
  }
}
