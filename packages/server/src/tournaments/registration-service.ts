import type { PoolClient } from 'pg';
import type { Actor, CommandContext } from '@oantuti/protocol';
import type { BackupFence } from '../operations/backup-fence.js';
import { statementRunner, type PostgresDatabase } from '../persistence/db.js';
import { auditRequestId } from '../persistence/audit-request-id.js';
import { admissionRosterProblem, lockRosterAdmission } from '../teams/roster-policy.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_STATES = ['REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS'];
const WINDOW_OPEN = `t.state='REGISTRATION_OPEN'
  AND (t.registration_opens_at IS NULL OR t.registration_opens_at<=clock_timestamp())
  AND (t.registration_closes_at IS NULL OR t.registration_closes_at>clock_timestamp())`;

type RegistrationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export interface RegistrationDto {
  readonly id: string;
  readonly tournamentId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly status: RegistrationStatus;
  readonly version: number;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly reviewedAt: string | null;
  readonly canCancel: boolean;
  readonly canRequest: boolean;
  readonly members: readonly { readonly userId: string; readonly username: string; readonly displayName: string; readonly role: 'CAPTAIN' | 'MEMBER' }[];
}

export class RegistrationError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

interface TournamentRow {
  readonly id: string;
  readonly state: string;
  readonly course_id: string;
  readonly max_teams: number;
  readonly locked_at: Date | null;
}
interface TeamRow {
  readonly id: string;
  readonly tournament_id: string | null;
  readonly course_id: string;
  readonly captain_user_id: string;
  readonly closed_at: Date | null;
}
interface RegistrationRow {
  readonly id: string;
  readonly team_id: string;
  readonly status: RegistrationStatus;
  readonly version: number;
  readonly cancelled_entry_id: string | null;
  readonly entry_code_id: string | null;
  readonly entry_code_revision: number | null;
}
interface EntryRow {
  readonly id: string;
  readonly status: string;
  readonly global_rating_exclusion: string | null;
}
interface DtoRow {
  readonly id: string;
  readonly tournament_id: string;
  readonly team_id: string;
  readonly team_name: string;
  readonly status: RegistrationStatus;
  readonly version: number;
  readonly reason: string | null;
  readonly requested_at: Date;
  readonly reviewed_at: Date | null;
  readonly can_cancel: boolean;
  readonly can_request: boolean;
  readonly members: RegistrationDto['members'];
}

/** Private ONLINE intake. Every writer shares the roster/admission and tournament lock order. */
export class TournamentRegistrationService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly profile: 'LAN_OFFLINE' | 'ONLINE' = 'LAN_OFFLINE',
    private readonly backupFence?: BackupFence,
  ) {}

  private requireOnline(actor: Actor): void {
    if (this.profile !== 'ONLINE') throw new RegistrationError(403, 'Tournament requests are ONLINE-only', 'PROFILE_DISABLED');
    if (actor.scope !== 'FULL') throw new RegistrationError(403, 'Full session required', 'FULL_SESSION_REQUIRED');
    if (actor.role !== 'STUDENT' && actor.role !== 'ADMIN') throw new RegistrationError(403, 'Student or administrator required', 'FORBIDDEN');
  }

  private async requireStudent(client: PoolClient, actor: Actor): Promise<void> {
    this.requireOnline(actor);
    if (actor.role !== 'STUDENT') throw new RegistrationError(403, 'Student captain required', 'FORBIDDEN');
    const verified = await client.query("SELECT 1 FROM users WHERE id=$1 AND role='STUDENT' AND email IS NOT NULL AND email_verified_at IS NOT NULL", [actor.userId]);
    if (!verified.rows.length) throw new RegistrationError(403, 'Verified email required', 'EMAIL_NOT_VERIFIED');
  }

  private requireAdmin(actor: Actor): void {
    this.requireOnline(actor);
    if (actor.role !== 'ADMIN') throw new RegistrationError(403, 'Only administrators can review requests', 'FORBIDDEN');
  }

  private uuid(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new RegistrationError(400, `${field} must be a UUID`, 'INVALID_ID');
  }

  private expectedVersion(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RegistrationError(400, 'expectedVersion must be a positive integer', 'INVALID_VERSION');
  }

  private assertVersion(registration: RegistrationRow, expectedVersion: number): void {
    if (registration.version !== expectedVersion) throw new RegistrationError(409, 'Registration changed; reload before trying again', 'STALE_VERSION');
  }

  private async lockTournament(client: PoolClient, tournamentId: string): Promise<TournamentRow> {
    const result = await client.query<TournamentRow>('SELECT id,state,course_id,max_teams,locked_at FROM tournaments WHERE id=$1 FOR UPDATE', [tournamentId]);
    if (!result.rows[0]) throw new RegistrationError(404, 'Tournament not found', 'TOURNAMENT_NOT_FOUND');
    return result.rows[0];
  }

  private async assertWindow(client: PoolClient, tournamentId: string): Promise<void> {
    const result = await client.query<{ open: boolean }>(`SELECT (${WINDOW_OPEN}) AND t.locked_at IS NULL AS open FROM tournaments t WHERE t.id=$1`, [tournamentId]);
    if (!result.rows[0]?.open) throw new RegistrationError(409, 'Registration window is closed', 'REGISTRATION_WINDOW_CLOSED');
  }

  private async lockTeam(client: PoolClient, tournament: TournamentRow, teamId: string, captain?: Actor, allowLegacy = false): Promise<TeamRow> {
    const result = await client.query<TeamRow>('SELECT id,tournament_id,course_id,captain_user_id,closed_at FROM teams WHERE id=$1 FOR UPDATE', [teamId]);
    const team = result.rows[0];
    if (!team) throw new RegistrationError(404, 'Team not found', 'TEAM_NOT_FOUND');
    if (captain) {
      const membership = await client.query("SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2 AND role='CAPTAIN'", [teamId, captain.userId]);
      if (team.captain_user_id !== captain.userId || !membership.rows.length) throw new RegistrationError(403, 'Only the team captain can change registration', 'TEAM_CAPTAIN_REQUIRED');
    }
    if ((team.tournament_id !== tournament.id && !(allowLegacy && team.tournament_id === null)) || team.course_id !== tournament.course_id) throw new RegistrationError(409, 'Team belongs to a different tournament policy', 'TEAM_POLICY_MISMATCH');
    if (team.closed_at) throw new RegistrationError(409, 'Team is closed', 'TEAM_CLOSED');
    return team;
  }

  private async entry(client: PoolClient, tournamentId: string, teamId: string): Promise<EntryRow | undefined> {
    const result = await client.query<EntryRow>('SELECT id,status,global_rating_exclusion FROM tournament_entries WHERE tournament_id=$1 AND team_id=$2 FOR UPDATE', [tournamentId, teamId]);
    return result.rows[0];
  }

  private assertReapplicable(entry: EntryRow | undefined, registration: RegistrationRow | undefined): void {
    if (!entry) return;
    if (entry.status !== 'EXCLUDED' || entry.global_rating_exclusion !== 'PRESTART_EXCLUDED' || registration?.cancelled_entry_id !== entry.id) {
      throw new RegistrationError(409, 'Existing admission cannot be reactivated through registration', 'ENTRY_NOT_REAPPLICABLE');
    }
  }

  private async assertRoster(client: PoolClient, tournamentId: string, teamId: string): Promise<void> {
    const problem = await admissionRosterProblem(client, tournamentId, teamId);
    if (problem) throw new RegistrationError(409, problem, problem);
    const unverified = await client.query("SELECT 1 FROM team_memberships membership JOIN users u ON u.id=membership.user_id WHERE membership.team_id=$1 AND (u.role<>'STUDENT' OR u.email IS NULL OR u.email_verified_at IS NULL) LIMIT 1", [teamId]);
    if (unverified.rows.length) throw new RegistrationError(409, 'Every roster member must be a verified student', 'TEAM_MEMBER_NOT_VERIFIED');
  }

  async list(tournamentId: string, ctx: CommandContext): Promise<RegistrationDto[]> {
    this.requireOnline(ctx.actor);
    this.uuid(tournamentId, 'tournamentId');
    const exists = await this.db.query('SELECT id FROM tournaments WHERE id=$1', [tournamentId]);
    if (!exists.rows.length) throw new RegistrationError(404, 'Tournament not found', 'TOURNAMENT_NOT_FOUND');
    return this.readDtos(tournamentId, ctx.actor);
  }

  async request(tournamentId: string, input: { readonly teamId: string }, ctx: CommandContext): Promise<RegistrationDto> {
    this.requireOnline(ctx.actor);
    this.uuid(tournamentId, 'tournamentId');
    this.uuid(input?.teamId, 'teamId');
    return this.db.withTransaction(client => this.requestOn(client, tournamentId, input.teamId, ctx));
  }

  /** Code redemption calls this on its own transaction so the pending row and use counter commit together. */
  async requestOn(
    client: PoolClient,
    tournamentId: string,
    teamId: string,
    ctx: CommandContext,
    source?: { readonly entryCodeId: string; readonly entryCodeRevision: number },
  ): Promise<RegistrationDto> {
    this.uuid(tournamentId, 'tournamentId');
    this.uuid(teamId, 'teamId');
    await lockRosterAdmission(client);
    await this.backupFence?.assertFresh(client);
    const tournament = await this.lockTournament(client, tournamentId);
    await this.requireStudent(client, ctx.actor);
    await this.lockTeam(client, tournament, teamId, ctx.actor);
    await this.assertWindow(client, tournamentId);
    const prior = await client.query<RegistrationRow>('SELECT * FROM tournament_registrations WHERE tournament_id=$1 AND team_id=$2 FOR UPDATE', [tournamentId, teamId]);
    const registration = prior.rows[0];
    const entry = await this.entry(client, tournamentId, teamId);
    if (entry?.status === 'EXCLUDED') this.assertReapplicable(entry, registration);
    if (registration && (registration.status === 'PENDING' || registration.status === 'APPROVED')) throw new RegistrationError(409, 'Team already has an active request or approval', 'ALREADY_REGISTERED');
    this.assertReapplicable(entry, registration);
    const admission = await client.query('SELECT id FROM tournament_admissions WHERE tournament_id=$1 AND team_id=$2', [tournamentId, teamId]);
    if (admission.rows.length && !entry) throw new RegistrationError(409, 'Existing admission cannot be replaced', 'ENTRY_NOT_REAPPLICABLE');
    await this.assertRoster(client, tournamentId, teamId);
    const saved = await client.query<{ id: string }>(
      `INSERT INTO tournament_registrations(tournament_id,team_id,requested_by_user_id,entry_code_id,entry_code_revision)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(tournament_id,team_id) DO UPDATE SET status='PENDING',version=tournament_registrations.version+1,
         requested_by_user_id=EXCLUDED.requested_by_user_id,requested_at=clock_timestamp(),reviewed_by_user_id=NULL,
         reviewed_at=NULL,reason=NULL,entry_code_id=EXCLUDED.entry_code_id,entry_code_revision=EXCLUDED.entry_code_revision,updated_at=clock_timestamp()
       RETURNING id`,
      [tournamentId, teamId, ctx.actor.userId, source?.entryCodeId ?? null, source?.entryCodeRevision ?? null],
    );
    await this.audit(client, ctx, 'TOURNAMENT_REGISTRATION_REQUESTED', tournamentId, saved.rows[0].id, { teamId, entryCodeId: source?.entryCodeId ?? null, entryCodeRevision: source?.entryCodeRevision ?? null });
    return (await this.readDtos(tournamentId, ctx.actor, saved.rows[0].id, client))[0];
  }

  async cancel(tournamentId: string, registrationId: string, input: { readonly expectedVersion: number }, ctx: CommandContext): Promise<RegistrationDto> {
    this.requireOnline(ctx.actor);
    this.uuid(tournamentId, 'tournamentId');
    this.uuid(registrationId, 'registrationId');
    this.expectedVersion(input?.expectedVersion);
    return this.db.withTransaction(async client => {
      await lockRosterAdmission(client);
      await this.backupFence?.assertFresh(client);
      const tournament = await this.lockTournament(client, tournamentId);
      await this.requireStudent(client, ctx.actor);
      const result = await client.query<RegistrationRow>('SELECT * FROM tournament_registrations WHERE id=$1 AND tournament_id=$2 FOR UPDATE', [registrationId, tournamentId]);
      const registration = result.rows[0];
      if (!registration) throw new RegistrationError(404, 'Registration not found', 'REGISTRATION_NOT_FOUND');
      await this.lockTeam(client, tournament, registration.team_id, ctx.actor, registration.status === 'APPROVED');
      await this.assertWindow(client, tournamentId);
      this.assertVersion(registration, input.expectedVersion);
      if (registration.status !== 'PENDING' && registration.status !== 'APPROVED') throw new RegistrationError(409, 'Only pending or approved registrations may be cancelled', 'REGISTRATION_NOT_CANCELLABLE');
      const entry = await this.entry(client, tournamentId, registration.team_id);
      if (registration.status === 'APPROVED') {
        if (!entry || entry.status !== 'ELIGIBLE' || entry.global_rating_exclusion !== null) throw new RegistrationError(409, 'Administrator-excluded entries cannot be cancelled or reactivated', 'ENTRY_NOT_REAPPLICABLE');
        await client.query("UPDATE tournament_entries SET status='EXCLUDED',frozen_submission_id=NULL,seed_ordinal=NULL,global_rating_exclusion='PRESTART_EXCLUDED' WHERE id=$1", [entry.id]);
      }
      await client.query("UPDATE tournament_registrations SET status='CANCELLED',version=version+1,cancelled_entry_id=$2,updated_at=clock_timestamp() WHERE id=$1", [registrationId, registration.status === 'APPROVED' ? entry!.id : registration.cancelled_entry_id]);
      await this.audit(client, ctx, 'TOURNAMENT_REGISTRATION_CANCELLED', tournamentId, registrationId, { teamId: registration.team_id, priorStatus: registration.status, entryId: entry?.id ?? null });
      return (await this.readDtos(tournamentId, ctx.actor, registrationId, client))[0];
    });
  }

  async review(
    tournamentId: string,
    registrationId: string,
    input: { readonly decision: 'APPROVE' | 'REJECT'; readonly reason?: string; readonly expectedVersion: number },
    ctx: CommandContext,
  ): Promise<RegistrationDto> {
    this.requireAdmin(ctx.actor);
    this.uuid(tournamentId, 'tournamentId');
    this.uuid(registrationId, 'registrationId');
    this.expectedVersion(input?.expectedVersion);
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw new RegistrationError(400, 'decision must be APPROVE or REJECT', 'INVALID_DECISION');
    if (input.reason !== undefined && typeof input.reason !== 'string') throw new RegistrationError(400, 'reason must be text', 'INVALID_REASON');
    const reason = input.reason?.trim() ?? '';
    if (reason.length > 500 || (input.decision === 'REJECT' && !reason)) throw new RegistrationError(400, 'Rejection requires a reason of 1 to 500 characters', 'INVALID_REASON');
    return this.db.withTransaction(async client => {
      await lockRosterAdmission(client);
      await this.backupFence?.assertFresh(client);
      const tournament = await this.lockTournament(client, tournamentId);
      if (!REVIEW_STATES.includes(tournament.state) || tournament.locked_at) throw new RegistrationError(409, 'Requests may only be reviewed before tournament lock', 'TOURNAMENT_LOCKED');
      const result = await client.query<RegistrationRow>('SELECT * FROM tournament_registrations WHERE id=$1 AND tournament_id=$2 FOR UPDATE', [registrationId, tournamentId]);
      const registration = result.rows[0];
      if (!registration) throw new RegistrationError(404, 'Registration not found', 'REGISTRATION_NOT_FOUND');
      this.assertVersion(registration, input.expectedVersion);
      if (registration.status !== 'PENDING') throw new RegistrationError(409, 'Registration is no longer pending', 'REGISTRATION_NOT_PENDING');
      if (input.decision === 'APPROVE') {
        await this.lockTeam(client, tournament, registration.team_id);
        await this.assertRoster(client, tournamentId, registration.team_id);
        const entry = await this.entry(client, tournamentId, registration.team_id);
        this.assertReapplicable(entry, registration);
        const capacity = await client.query<{ used: string }>("SELECT count(*)::text AS used FROM tournament_entries WHERE tournament_id=$1 AND status<>'EXCLUDED'", [tournamentId]);
        if (Number(capacity.rows[0].used) >= tournament.max_teams) throw new RegistrationError(409, 'Tournament capacity has been reached', 'CAPACITY_EXCEEDED');
        await client.query(
          `INSERT INTO tournament_admissions(tournament_id,team_id,admitted_by_user_id,admission_type,entry_code_id,entry_code_revision)
           VALUES($1,$2,$3,'REGISTRATION_APPROVAL',$4,$5) ON CONFLICT(tournament_id,team_id) DO NOTHING`,
          [tournamentId, registration.team_id, ctx.actor.userId, registration.entry_code_id, registration.entry_code_revision],
        );
        await client.query(
          `INSERT INTO tournament_entries(tournament_id,team_id,status) VALUES($1,$2,'ELIGIBLE')
           ON CONFLICT(tournament_id,team_id) DO UPDATE SET status='ELIGIBLE',frozen_submission_id=NULL,seed_ordinal=NULL,global_rating_exclusion=NULL`,
          [tournamentId, registration.team_id],
        );
      }
      await client.query(
        `UPDATE tournament_registrations SET status=$2,version=version+1,reason=$3,reviewed_by_user_id=$4,
         reviewed_at=clock_timestamp(),cancelled_entry_id=CASE WHEN $2='APPROVED' THEN NULL ELSE cancelled_entry_id END,updated_at=clock_timestamp() WHERE id=$1`,
        [registrationId, input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason || null, ctx.actor.userId],
      );
      await this.audit(client, ctx, input.decision === 'APPROVE' ? 'TOURNAMENT_REGISTRATION_APPROVED' : 'TOURNAMENT_REGISTRATION_REJECTED', tournamentId, registrationId, { teamId: registration.team_id, reason: reason || null });
      return (await this.readDtos(tournamentId, ctx.actor, registrationId, client))[0];
    });
  }

  private async readDtos(tournamentId: string, actor: Actor, registrationId?: string, client?: PoolClient): Promise<RegistrationDto[]> {
    const result = await statementRunner(client ?? this.db)<DtoRow>(
      `SELECT r.id,r.tournament_id,r.team_id,team.name AS team_name,r.status,r.version,r.reason,r.requested_at,r.reviewed_at,
        COALESCE(($2='STUDENT' AND team.captain_user_id=$3 AND team.closed_at IS NULL
         AND (team.tournament_id=t.id OR (team.tournament_id IS NULL AND r.status='APPROVED')) AND team.course_id=t.course_id
         AND t.locked_at IS NULL AND ${WINDOW_OPEN}
         AND EXISTS(SELECT 1 FROM users u JOIN team_memberships m ON m.user_id=u.id WHERE u.id=$3 AND m.team_id=team.id AND m.role='CAPTAIN' AND u.role='STUDENT' AND u.email_verified_at IS NOT NULL)
         AND (r.status='PENDING' OR (r.status='APPROVED' AND entry.status='ELIGIBLE' AND entry.global_rating_exclusion IS NULL))),false) AS can_cancel,
        COALESCE(($2='STUDENT' AND team.captain_user_id=$3 AND team.closed_at IS NULL AND team.tournament_id=t.id AND team.course_id=t.course_id
         AND t.locked_at IS NULL AND ${WINDOW_OPEN} AND r.status IN ('REJECTED','CANCELLED')
         AND EXISTS(SELECT 1 FROM users u JOIN team_memberships m ON m.user_id=u.id WHERE u.id=$3 AND m.team_id=team.id AND m.role='CAPTAIN' AND u.role='STUDENT' AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL)
         AND ((entry.id IS NULL AND NOT EXISTS(SELECT 1 FROM tournament_admissions admission WHERE admission.tournament_id=r.tournament_id AND admission.team_id=r.team_id))
           OR (entry.id=r.cancelled_entry_id AND entry.status='EXCLUDED' AND entry.global_rating_exclusion='PRESTART_EXCLUDED'))),false) AS can_request,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',u.id,'username',u.username,'displayName',u.display_name,'role',m.role) ORDER BY m.created_at,m.id)
          FROM team_memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=team.id),'[]'::jsonb) AS members
       FROM tournament_registrations r JOIN teams team ON team.id=r.team_id JOIN tournaments t ON t.id=r.tournament_id
       LEFT JOIN tournament_entries entry ON entry.tournament_id=r.tournament_id AND entry.team_id=r.team_id
       WHERE r.tournament_id=$1 AND ($2='ADMIN' OR EXISTS(SELECT 1 FROM team_memberships m WHERE m.team_id=r.team_id AND m.user_id=$3))
         AND ($4::uuid IS NULL OR r.id=$4) ORDER BY r.requested_at,r.id`,
      [tournamentId, actor.role, actor.userId, registrationId ?? null],
    );
    return result.rows.map(row => ({ id: row.id, tournamentId: row.tournament_id, teamId: row.team_id, teamName: row.team_name, status: row.status, version: row.version, reason: row.reason, requestedAt: row.requested_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null, canCancel: row.can_cancel, canRequest: row.can_request, members: row.members }));
  }

  private async audit(client: PoolClient, ctx: CommandContext, action: string, tournamentId: string, registrationId: string, details: Record<string, unknown>): Promise<void> {
    await client.query(
      "INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,request_id,details) VALUES($1,$2,'tournament_registration',$3,$4,$5)",
      [ctx.actor.userId, action, registrationId, auditRequestId(ctx.requestId), JSON.stringify({ tournamentId, ...details })],
    );
  }
}
