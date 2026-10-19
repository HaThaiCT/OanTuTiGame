import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CommandContext, ContestPlacement, GlobalLeaderboardDto, PublicTeamProfileDto, RatingChangeDto, RatingDecisionReceipt, RatingReviewDto, TournamentRatingChangesDto, TournamentTeamRatingsDto } from '@oantuti/protocol';
import { teamRatingRank } from '@oantuti/protocol';
import type { BackupFence } from '../operations/backup-fence.js';
import { BACKUP_BARRIER } from '../operations/backup-checkpoint.js';
import type { PostgresDatabase } from '../persistence/db.js';
import { auditRequestId } from '../persistence/audit-request-id.js';
import { TournamentError } from '../tournaments/lifecycle-service.js';
import { calculateContestRatingAsync } from './calculator.js';
import { projectContestPlacements, RatingPlacementError } from './placements.js';

const POLICY = 'ArenaContestRating/v1' as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publication = (control: { active_generation: string | null; active_revision: string; desired_revision: string }) => ({ generationId: control.active_generation, activeRevision: control.active_revision, desiredRevision: control.desired_revision, updating: control.active_revision !== control.desired_revision });
type Control = { active_generation: string | null; active_revision: string; desired_revision: string; next_publication_order: string };
type Contest = { tournament_id: string; tournament_name: string; publication_order: string | null; review_state: 'PENDING' | 'APPROVED' | 'REJECTED'; desired_included: boolean; input_revision: number; placements: ContestPlacement[] | null; source_digest: string | null; decision_reason: string | null };

type LeaderboardCursor = { generationId: string; lastRating: number; teamId: string };
type HistoryCursor = { generationId: string; lastPublicationOrder: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function decodeCursor<T extends Record<string, unknown>>(cursor: string | undefined, valid: (value: Record<string, unknown>) => value is T): T | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 1024) throw new TournamentError(400, 'INVALID_RATING_CURSOR');
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    if (!valid(record)) throw new Error('invalid');
    return record;
  } catch {
    throw new TournamentError(400, 'INVALID_RATING_CURSOR');
  }
}
const encodeCursor = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const isPositivePgBigint = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const isLeaderboardCursor = (value: Record<string, unknown>): value is LeaderboardCursor => Object.keys(value).length === 3 && isPositivePgBigint(value.generationId) && typeof value.lastRating === 'number' && Number.isInteger(value.lastRating) && value.lastRating >= 0 && value.lastRating <= 8000 && typeof value.teamId === 'string' && UUID.test(value.teamId);
const isHistoryCursor = (value: Record<string, unknown>): value is HistoryCursor => Object.keys(value).length === 2 && isPositivePgBigint(value.generationId) && isPositivePgBigint(value.lastPublicationOrder);

export class GlobalTeamRatingService {
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly db: PostgresDatabase, private readonly backupFence?: BackupFence) {}

  async setRated(tournamentId: string, isRated: boolean, ctx: CommandContext): Promise<{ tournamentId: string; isRated: boolean; version: number }> {
    if (ctx.actor.role !== 'ADMIN' || ctx.actor.scope !== 'FULL') throw new TournamentError(403, 'Only fully authenticated administrators can set rated configuration');
    if (typeof isRated !== 'boolean' || !Number.isInteger(ctx.expectedVersion) || (ctx.expectedVersion ?? 0) < 1) throw new TournamentError(400, 'Invalid rated configuration');
    return this.db.withTransaction(async (client) => {
      await this.mutationBarrier(client);
      const row = await client.query<{ state: string; version: number }>('SELECT state, version FROM tournaments WHERE id = $1 FOR UPDATE', [tournamentId]);
      const tournament = row.rows[0];
      if (!tournament) throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
      if (!['DRAFT', 'PUBLISHED'].includes(tournament.state)) throw new TournamentError(409, 'RATING_CONFIGURATION_FROZEN');
      if (tournament.version !== ctx.expectedVersion!) throw new TournamentError(409, 'VERSION_CONFLICT');
      const updated = await client.query<{ version: number }>('UPDATE tournaments SET is_rated = $2, version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING version', [tournamentId, isRated]);
      return { tournamentId, isRated, version: updated.rows[0].version };
    });
  }

  async lockForTournamentTransition(client: PoolClient, tournamentId: string): Promise<boolean> {
    const row = await client.query<{ is_rated: boolean }>('SELECT is_rated FROM tournaments WHERE id=$1', [tournamentId]);
    if (!row.rows[0]?.is_rated) return false;
    await this.mutationBarrier(client);
    await this.control(client, true);
    return true;
  }

  async prepareFinalization(client: PoolClient, tournamentId: string): Promise<void> {
    const row = await client.query<{ is_rated: boolean; name: string }>('SELECT is_rated, name FROM tournaments WHERE id = $1', [tournamentId]);
    if (row.rows[0]?.is_rated) await client.query(`INSERT INTO global_rating_contests (tournament_id, tournament_name) VALUES ($1, $2) ON CONFLICT (tournament_id) DO NOTHING`, [tournamentId, row.rows[0].name]);
  }

  async invalidateOnReopen(client: PoolClient, tournamentId: string, ctx: CommandContext): Promise<void> {
    await this.mutationBarrier(client);
    const control = await this.control(client, true);
    const contest = await client.query<Contest>('SELECT * FROM global_rating_contests WHERE tournament_id = $1 FOR UPDATE', [tournamentId]);
    const current = contest.rows[0];
    if (!current) return;
    if (current.desired_included) {
      await client.query(`INSERT INTO global_rating_decisions (tournament_id,input_revision,action,actor_user_id,tournament_name,publication_order,source_digest,placements) VALUES ($1,$2,'REOPEN',$3,$4,$5,$6,$7)`, [tournamentId, current.input_revision, ctx.actor.userId, current.tournament_name, current.publication_order, current.source_digest, JSON.stringify(current.placements)]);
      await client.query('UPDATE global_rating_control SET desired_revision = desired_revision + 1 WHERE singleton = true');
      await this.writeEvent(client, ctx.actor.userId, 'GLOBAL_RATING_REOPENED', tournamentId, ctx.requestId, { action: 'REOPEN', tournamentId });
    }
    await client.query(`UPDATE global_rating_contests SET desired_included = false, review_state = 'PENDING', decision_reason = NULL WHERE tournament_id = $1`, [tournamentId]);
    void control;
  }

  async review(tournamentId: string): Promise<RatingReviewDto> {
    const copied = await this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const control = await this.control(client);
      const tournament = (await client.query<{ id: string; name: string; state: string; version: number; is_rated: boolean }>('SELECT id,name,state,version,is_rated FROM tournaments WHERE id=$1', [tournamentId])).rows[0];
      if (!tournament) throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
      const contest = (await client.query<Contest>('SELECT * FROM global_rating_contests WHERE tournament_id=$1', [tournamentId])).rows[0];
      const exclusions = (await client.query<{ team_id: string; global_rating_exclusion: RatingReviewDto['exclusions'][number]['reason'] }>('SELECT team_id,global_rating_exclusion FROM tournament_entries WHERE tournament_id=$1 AND global_rating_exclusion IS NOT NULL ORDER BY team_id', [tournamentId])).rows.map(row => ({ teamId: row.team_id, reason: row.global_rating_exclusion }));
      const base = { tournamentId: tournament.id as RatingReviewDto['tournamentId'], tournamentVersion: tournament.version, isRated: tournament.is_rated, reason: contest?.decision_reason ?? null, generationId: control.active_generation, desiredRevision: control.desired_revision, publicationOrder: contest?.publication_order ?? null, affectedContestCount: 0, updating: control.active_revision !== control.desired_revision, exclusions };
      let review: RatingReviewDto = { ...base, status: !tournament.is_rated ? 'UNRATED' : !['FINALIZED','ARCHIVED'].includes(tournament.state) ? 'NOT_FINAL' : contest?.review_state ?? 'PENDING', sourceDigest: null, previewDigest: null, placements: [], changes: [] };
      const ratings = new Map<string, number>();
      if (!tournament.is_rated || !['FINALIZED','ARCHIVED'].includes(tournament.state)) return { review, ratings, name: tournament.name };
      try {
        const placements = [...await projectContestPlacements(client, tournamentId)];
        const sourceDigest = await this.sourceDigest(client, tournamentId, placements);
        const order = contest?.publication_order ?? control.next_publication_order;
        const affected = (await client.query<{ count: string }>('SELECT count(*)::text AS count FROM global_rating_contests WHERE desired_included AND publication_order>$1', [order])).rows[0];
        review = { ...review, placements, sourceDigest, publicationOrder: order, affectedContestCount: Number(affected.count) };
        if (!base.updating && control.active_generation) {
          const prefix = await client.query<{ team_id: string; new_rating: number }>(`SELECT DISTINCT ON (team_id) team_id,new_rating FROM global_rating_changes WHERE generation_id=$1 AND publication_order<$2 ORDER BY team_id,publication_order DESC`, [control.active_generation, order]);
          for (const row of prefix.rows) ratings.set(row.team_id, row.new_rating);
        }
      } catch (error) {
        if (!(error instanceof RatingPlacementError)) throw error;
        review = { ...review, status: 'BLOCKED', reason: error.code };
      }
      return { review, ratings, name: tournament.name, inputRevision: contest?.input_revision ?? 0 };
    });
    const { review, ratings } = copied;
    if (!review.sourceDigest || review.updating) return review;
    const placements = new Map(review.placements.map(row => [row.teamId, row]));
    const calculated = await calculateContestRatingAsync(review.placements.map(row => ({ teamId: row.teamId, rating: ratings.get(row.teamId) ?? 1500, rank: row.rank, rankEnd: row.rankEnd })));
    const changes: RatingChangeDto[] = calculated.map(row => ({ ...row, oldPublicRating: ratings.get(row.teamId) ?? null, tournamentId: review.tournamentId, tournamentName: copied.name, publicationOrder: review.publicationOrder!, inputRevision: (copied.inputRevision ?? 0) + 1, rank: placements.get(row.teamId)!.rank, rankEnd: placements.get(row.teamId)!.rankEnd, participantCount: placements.size, policy: POLICY }));
    const previewDigest = digest({ policy: POLICY, sourceDigest: review.sourceDigest, tournamentVersion: review.tournamentVersion, generation: review.generationId, desired: review.desiredRevision, order: review.publicationOrder, changes });
    return { ...review, changes, previewDigest };
  }

  private async sourceDigest(client: PoolClient, tournamentId: string, placements: readonly ContestPlacement[]): Promise<string> {
    const tournament = (await client.query('SELECT id,format,rules_revision,name FROM tournaments WHERE id=$1', [tournamentId])).rows[0];
    const participants = (await client.query('SELECT team_id,global_rating_participant,global_rating_exclusion FROM tournament_entries WHERE tournament_id=$1 ORDER BY team_id', [tournamentId])).rows;
    const rounds = (await client.query('SELECT stage,round_ordinal,status,slot_count,sealed_at FROM tournament_rounds WHERE tournament_id=$1 ORDER BY stage,round_ordinal', [tournamentId])).rows;
    const encounters = (await client.query(`SELECT e.id,e.stage,e.round_ordinal,e.slot_ordinal,e.team_a_id,e.team_b_id,e.winner_team_id,e.status FROM encounters e JOIN tournament_rounds r ON r.tournament_id=e.tournament_id AND r.stage=e.stage AND r.round_ordinal=e.round_ordinal WHERE e.tournament_id=$1 AND e.status<>'CANCELLED' ORDER BY e.stage,e.round_ordinal,e.slot_ordinal,e.id`, [tournamentId])).rows;
    const results = (await client.query(`SELECT g.id AS game_id,g.game_ordinal,g.status,g.white_team_id,g.black_team_id,g.rules_revision,v.id AS result_id,v.revision,v.verdict,v.winner,v.disposition,v.action_trace_digest,v.replay_digest,v.manifest_digest FROM encounters e JOIN tournament_rounds r ON r.tournament_id=e.tournament_id AND r.stage=e.stage AND r.round_ordinal=e.round_ordinal JOIN games g ON g.encounter_id=e.id LEFT JOIN accepted_results a ON a.game_id=g.id LEFT JOIN result_versions v ON v.id=a.result_version_id WHERE e.tournament_id=$1 AND e.status<>'CANCELLED' AND g.status<>'CANCELLED' ORDER BY g.id`, [tournamentId])).rows;
    const snapshots = (await client.query(`SELECT to_jsonb(s)-'id'-'created_at' AS value FROM standings_snapshots s JOIN tournament_rounds r ON r.tournament_id=s.tournament_id AND r.stage=s.stage AND r.round_ordinal=s.round_ordinal WHERE s.tournament_id=$1 AND s.round_ordinal=(SELECT max(r2.round_ordinal) FROM tournament_rounds r2 WHERE r2.tournament_id=s.tournament_id AND r2.stage=s.stage) ORDER BY s.stage,s.team_id`, [tournamentId])).rows;
    return digest({ policy: POLICY, tournament, participants, rounds, encounters, results, snapshots, placements });
  }

  async approve(tournamentId: string, command: { previewDigest: string; generationId: string | null; expectedVersion: number }, ctx: CommandContext): Promise<RatingDecisionReceipt> {
    return this.decide(tournamentId, command, ctx, 'APPROVE');
  }
  async reject(tournamentId: string, command: { reason: string; expectedVersion: number }, ctx: CommandContext): Promise<RatingDecisionReceipt> {
    return this.decide(tournamentId, command, ctx, 'REJECT');
  }
  private async decide(tournamentId: string, command: Record<string, unknown>, ctx: CommandContext, action: 'APPROVE' | 'REJECT'): Promise<RatingDecisionReceipt> {
    if (ctx.actor.role !== 'ADMIN' || ctx.actor.scope !== 'FULL') throw new TournamentError(403, 'Only fully authenticated administrators can decide ratings');
    if (!ctx.idempotencyKey || ctx.idempotencyKey.length < 16 || ctx.idempotencyKey.length > 128) throw new TournamentError(400, 'Invalid idempotency key');
    if (!Number.isInteger(command.expectedVersion) || Number(command.expectedVersion) < 1) throw new TournamentError(400, 'Invalid expected version');
    if (action === 'REJECT' && (typeof command.reason !== 'string' || command.reason.trim().length < 3 || command.reason.trim().length > 500)) throw new TournamentError(400, 'Invalid rejection reason');
    const canonical = action === 'APPROVE' ? { previewDigest: command.previewDigest, generationId: command.generationId, expectedVersion: command.expectedVersion } : { reason: String(command.reason).trim(), expectedVersion: command.expectedVersion };
    const payloadDigest = digest(canonical);
    const scope = `GLOBAL_RATING_${action}:${tournamentId}`;
    const replay = (row: { payload_digest: string; receipt: RatingDecisionReceipt }): RatingDecisionReceipt => {
      if (row.payload_digest !== payloadDigest) throw new TournamentError(409, 'IDEMPOTENCY_CONFLICT');
      return row.receipt;
    };
    const fast = (await this.db.query<{ payload_digest: string; receipt: RatingDecisionReceipt }>(`SELECT payload_digest,receipt FROM command_receipts WHERE actor_user_id=$1 AND scope=$2 AND idempotency_key=$3 AND status='DONE'`, [ctx.actor.userId, scope, ctx.idempotencyKey])).rows[0];
    if (fast) return replay(fast);
    const review = action === 'APPROVE' ? await this.review(tournamentId) : null;
    return this.db.withTransaction(async (client) => {
      await this.mutationBarrier(client);
      const lockedControl = await this.control(client, true);
      const tournament = (await client.query<{ state: string; version: number; is_rated: boolean; name: string }>('SELECT state,version,is_rated,name FROM tournaments WHERE id=$1 FOR UPDATE', [tournamentId])).rows[0];
      if (!tournament) throw new TournamentError(404, 'Tournament not found');
      const previous = (await client.query<{ payload_digest: string; receipt: RatingDecisionReceipt }>(`SELECT payload_digest,receipt FROM command_receipts WHERE actor_user_id=$1 AND scope=$2 AND idempotency_key=$3 AND status='DONE' FOR UPDATE`, [ctx.actor.userId, scope, ctx.idempotencyKey])).rows[0];
      if (previous) return replay(previous);
      if (!tournament.is_rated) throw new TournamentError(409, 'TOURNAMENT_UNRATED');
      if (!['FINALIZED','ARCHIVED'].includes(tournament.state)) throw new TournamentError(409, 'RATING_NOT_FINAL');
      if (lockedControl.active_revision !== lockedControl.desired_revision) throw new TournamentError(409, 'RATING_UPDATE_IN_PROGRESS');
      if (tournament.version !== command.expectedVersion) throw new TournamentError(409, 'RATING_PREVIEW_STALE');
      const contest = (await client.query<Contest>('SELECT * FROM global_rating_contests WHERE tournament_id=$1 FOR UPDATE', [tournamentId])).rows[0];
      if (!contest) throw new TournamentError(409, 'RATING_PREVIEW_STALE');
      let changed = false;
      if (action === 'APPROVE') {
        if (!review || !review.previewDigest || command.previewDigest !== review.previewDigest || command.generationId !== review.generationId || lockedControl.active_generation !== review.generationId || lockedControl.desired_revision !== review.desiredRevision || tournament.version !== review.tournamentVersion || (contest.publication_order ?? lockedControl.next_publication_order) !== review.publicationOrder || contest.input_revision + 1 !== review.changes[0]?.inputRevision) throw new TournamentError(409, 'RATING_PREVIEW_STALE');
        const placements = await projectContestPlacements(client, tournamentId);
        if (await this.sourceDigest(client, tournamentId, placements) !== review.sourceDigest) throw new TournamentError(409, 'RATING_PREVIEW_STALE');
        if (contest.desired_included && contest.source_digest === review.sourceDigest) throw new TournamentError(409, 'RATING_ALREADY_APPROVED');
        const order = contest.publication_order ?? lockedControl.next_publication_order; const revision = contest.input_revision + 1;
        await client.query(`UPDATE global_rating_contests SET publication_order=$2,review_state='APPROVED',desired_included=true,input_revision=$3,placements=$4,source_digest=$5,approved_by=$6,approved_at=clock_timestamp(),decision_reason=NULL,tournament_name=$7 WHERE tournament_id=$1`, [tournamentId, order, revision, JSON.stringify(review.placements), review.sourceDigest, ctx.actor.userId, tournament.name]);
        await client.query(`UPDATE global_rating_control SET desired_revision=desired_revision+1,next_publication_order=GREATEST(next_publication_order,$1+1) WHERE singleton=true`, [order]);
        await client.query(`INSERT INTO global_rating_decisions(tournament_id,input_revision,action,actor_user_id,tournament_name,publication_order,source_digest,placements) SELECT tournament_id,$2,'APPROVE',$3,tournament_name,$4,$5,$6 FROM global_rating_contests WHERE tournament_id=$1`, [tournamentId, revision, ctx.actor.userId, order, review.sourceDigest, JSON.stringify(review.placements)]);
        changed = true;
      } else {
        if (contest.review_state === 'REJECTED' && !contest.desired_included) throw new TournamentError(409, 'RATING_ALREADY_REJECTED');
        const revision = contest.input_revision + 1; changed = contest.desired_included;
        await client.query(`UPDATE global_rating_contests SET desired_included=false,review_state='REJECTED',input_revision=$2,decision_reason=$3 WHERE tournament_id=$1`, [tournamentId, revision, String(command.reason).trim()]);
        if (changed) await client.query('UPDATE global_rating_control SET desired_revision=desired_revision+1 WHERE singleton=true');
        await client.query(`INSERT INTO global_rating_decisions(tournament_id,input_revision,action,actor_user_id,tournament_name,reason,publication_order,source_digest,placements) SELECT tournament_id,$2,'REJECT',$3,tournament_name,$4,publication_order,source_digest,placements FROM global_rating_contests WHERE tournament_id=$1`, [tournamentId, revision, ctx.actor.userId, String(command.reason).trim()]);
      }
      await this.writeEvent(client, ctx.actor.userId, `GLOBAL_RATING_${action === 'APPROVE' ? 'APPROVED' : 'REJECTED'}`, tournamentId, ctx.requestId, { action, tournamentId });
      const version = (await client.query<{ version: number }>('UPDATE tournaments SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version', [tournamentId])).rows[0].version;
      const control = await this.control(client); const receipt: RatingDecisionReceipt = { receiptId: randomUUID() as RatingDecisionReceipt['receiptId'], tournamentId: tournamentId as RatingDecisionReceipt['tournamentId'], desiredRevision: control.desired_revision, tournamentVersion: version, status: action === 'REJECT' && !changed ? 'REJECTED' : 'UPDATING' };
      await client.query(`INSERT INTO command_receipts(actor_user_id,scope,idempotency_key,payload_digest,status,receipt) VALUES($1,$2,$3,$4,'DONE',$5)`, [ctx.actor.userId, scope, ctx.idempotencyKey, payloadDigest, JSON.stringify(receipt)]);
      return receipt;
    });
  }
  private async mutationBarrier(client: PoolClient): Promise<void> {
    if (this.backupFence) await this.backupFence.assertFresh(client);
    else await client.query(`SELECT pg_advisory_xact_lock_shared(${BACKUP_BARRIER})`);
  }
  private async writeEvent(client: PoolClient, actorId: string | null, action: string, resourceId: string, requestId: string | null, details: Record<string, unknown>): Promise<void> {
    await client.query(`INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,request_id,details) VALUES($1,$2,'GLOBAL_RATING',$3,$4,$5)`, [actorId, action, resourceId, auditRequestId(requestId ?? undefined), JSON.stringify(details)]);
    await client.query('INSERT INTO outbox_events(topic,payload) VALUES($1,$2)', [action, JSON.stringify(details)]);
  }
  async publicLeaderboard(options: { limit: number; cursor?: string }): Promise<GlobalLeaderboardDto> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new TournamentError(400, 'INVALID_RATING_CURSOR');
    const cursor = decodeCursor(options.cursor, isLeaderboardCursor);
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const control = await this.control(client); const meta = publication(control);
      if (cursor && cursor.generationId !== control.active_generation) throw new TournamentError(409, 'RATING_PAGE_STALE');
      if (!control.active_generation) return { publication: meta, rows: [], nextCursor: null };
      const rows = await client.query<{ team_id: string; name: string; rating: number; max_rating: number; rated_contests: number; position: string }>(
        `WITH ranked AS (SELECT r.team_id,t.name,r.rating,r.max_rating,r.rated_contests,rank() OVER(ORDER BY r.rating DESC) AS position FROM global_team_ratings r JOIN teams t ON t.id=r.team_id WHERE r.generation_id=$1) SELECT *,position::text FROM ranked WHERE ($2::integer IS NULL OR rating < $2 OR (rating=$2 AND team_id>$3::uuid)) ORDER BY rating DESC,team_id LIMIT $4`,
        [control.active_generation, cursor?.lastRating ?? null, cursor?.teamId ?? null, options.limit + 1]);
      const page = rows.rows.slice(0, options.limit); const last = page.at(-1);
      return { publication: meta, rows: page.map((row) => ({ teamId: row.team_id, name: row.name, rank: Number(row.position), rating: { rating: row.rating, maxRating: row.max_rating, ratedContests: row.rated_contests, rank: teamRatingRank(row.rating) } })), nextCursor: rows.rows.length > options.limit && last ? encodeCursor({ generationId: control.active_generation, lastRating: last.rating, teamId: last.team_id }) : null };
    });
  }
  async publicProfile(teamId: string, options: { limit: number; cursor?: string }): Promise<PublicTeamProfileDto> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new TournamentError(400, 'INVALID_RATING_CURSOR');
    const cursor = decodeCursor(options.cursor, isHistoryCursor);
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const control = await this.control(client); const team = (await client.query<{ id: string; name: string }>('SELECT id,name FROM teams WHERE id=$1', [teamId])).rows[0];
      if (!team) throw new TournamentError(404, 'Team not found'); const meta = publication(control);
      if (cursor && cursor.generationId !== control.active_generation) throw new TournamentError(409, 'RATING_PAGE_STALE');
      if (!control.active_generation) return { teamId: team.id as PublicTeamProfileDto['teamId'], name: team.name, rating: { rating: null, maxRating: null, ratedContests: 0, rank: 'UNRATED' }, publication: meta, history: [], ratingPoints: [], nextCursor: null };
      const head = (await client.query<{ rating: number; max_rating: number; rated_contests: number }>('SELECT rating,max_rating,rated_contests FROM global_team_ratings WHERE generation_id=$1 AND team_id=$2', [control.active_generation, teamId])).rows[0];
      const rows = await client.query<RatingChangeDto & { publication_order: string; input_revision: number; tournament_id: string; tournament_name: string; team_id: string; rank: number; rank_end: number; participant_count: number; old_rating: number; old_public_rating: number | null; new_rating: number; policy: typeof POLICY }>(`SELECT * FROM global_rating_changes WHERE generation_id=$1 AND team_id=$2 AND ($3::bigint IS NULL OR publication_order < $3) ORDER BY publication_order DESC LIMIT $4`, [control.active_generation, teamId, cursor?.lastPublicationOrder ?? null, options.limit + 1]);
      const page = rows.rows.slice(0, options.limit); const history = page.map((row) => ({ teamId: row.team_id as RatingChangeDto['teamId'], tournamentId: row.tournament_id as RatingChangeDto['tournamentId'], tournamentName: row.tournament_name, publicationOrder: row.publication_order, inputRevision: row.input_revision, rank: row.rank, rankEnd: row.rank_end, participantCount: row.participant_count, oldRating: row.old_rating, oldPublicRating: row.old_public_rating, delta: row.delta, newRating: row.new_rating, policy: POLICY })); const last = page.at(-1);
      const points = (await client.query<{ publication_order: string; new_rating: number; tournament_name: string }>('SELECT publication_order,new_rating,tournament_name FROM global_rating_changes WHERE generation_id=$1 AND team_id=$2 ORDER BY publication_order', [control.active_generation, teamId])).rows;
      return { teamId: team.id as PublicTeamProfileDto['teamId'], name: team.name, rating: head ? { rating: head.rating, maxRating: head.max_rating, ratedContests: head.rated_contests, rank: teamRatingRank(head.rating) } : { rating: null, maxRating: null, ratedContests: 0, rank: 'UNRATED' }, publication: meta, history, ratingPoints: points.map(row => ({ publicationOrder: row.publication_order, rating: row.new_rating, tournamentName: row.tournament_name })), nextCursor: rows.rows.length > options.limit && last ? encodeCursor({ generationId: control.active_generation, lastPublicationOrder: last.publication_order }) : null };
    });
  }
  async publicTournamentChanges(tournamentId: string): Promise<TournamentRatingChangesDto> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const visible = (await client.query<{ state: string }>('SELECT state FROM tournaments WHERE id=$1', [tournamentId])).rows[0];
      if (!visible || visible.state === 'DRAFT') throw new TournamentError(404, 'Tournament not found');
      const control = await this.control(client);
      const contest = (await client.query<{ review_state: TournamentRatingChangesDto['reviewState']; is_rated: boolean }>(
        'SELECT c.review_state,t.is_rated FROM tournaments t LEFT JOIN global_rating_contests c ON c.tournament_id=t.id WHERE t.id=$1', [tournamentId]
      )).rows[0];
      if (!contest) throw new TournamentError(404, 'Tournament not found');
      const base = { tournamentId: tournamentId as TournamentRatingChangesDto['tournamentId'], isRated: contest.is_rated, policy: POLICY, reviewState: !contest.is_rated ? 'UNRATED' : !['FINALIZED','ARCHIVED'].includes(visible.state) ? 'NOT_FINAL' : (contest.review_state ?? 'PENDING'), publication: publication(control) } satisfies Omit<TournamentRatingChangesDto, 'changes'>;
      if (!control.active_generation) return { ...base, changes: [] };
      const rows = await client.query<{
        team_id: string; tournament_id: string; tournament_name: string; publication_order: string; input_revision: number;
        rank: number; rank_end: number; participant_count: number; old_rating: number; old_public_rating: number | null;
        delta: number; new_rating: number;
      }>('SELECT * FROM global_rating_changes WHERE generation_id=$1 AND tournament_id=$2 ORDER BY team_id', [control.active_generation, tournamentId]);
      const changes: RatingChangeDto[] = rows.rows.map((row) => ({
        teamId: row.team_id as RatingChangeDto['teamId'], tournamentId: row.tournament_id as RatingChangeDto['tournamentId'],
        tournamentName: row.tournament_name, publicationOrder: String(row.publication_order), inputRevision: row.input_revision,
        rank: row.rank, rankEnd: row.rank_end, participantCount: row.participant_count, oldRating: row.old_rating,
        oldPublicRating: row.old_public_rating, delta: row.delta, newRating: row.new_rating, policy: POLICY,
      }));
      return { ...base, changes };
    });
  }
  async publicTournamentTeamRatings(tournamentId: string): Promise<TournamentTeamRatingsDto> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const visible = (await client.query<{ state: string }>('SELECT state FROM tournaments WHERE id=$1', [tournamentId])).rows[0];
      if (!visible || visible.state === 'DRAFT') throw new TournamentError(404, 'Tournament not found');
      const control = await this.control(client);
      const entries = await client.query<{ team_id: string; name: string; rating: number | null; max_rating: number | null; rated_contests: number | null }>(
        `SELECT e.team_id,t.name,r.rating,r.max_rating,r.rated_contests FROM tournament_entries e JOIN teams t ON t.id=e.team_id
         LEFT JOIN global_team_ratings r ON r.team_id=e.team_id AND r.generation_id=$2 WHERE e.tournament_id=$1 ORDER BY t.name`,
        [tournamentId, control.active_generation]
      );
      return {
        publication: publication(control),
        teams: entries.rows.map((row) => ({
          teamId: row.team_id as TournamentTeamRatingsDto['teams'][number]['teamId'], name: row.name,
          rating: { rating: row.rating, maxRating: row.max_rating, ratedContests: row.rated_contests ?? 0, rank: teamRatingRank(row.rating) },
        })),
      };
    });
  }

  kickRebuild(): void { if (!this.stopped && !this.active) this.active = this.rebuildPending().catch((error) => console.warn(`[global-rating] ${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.active = undefined; }); }
  async stop(): Promise<void> { this.stopped = true; await this.active; }
  async rebuildPending(): Promise<void> {
    const client = await this.db.connectDedicated();
    let connectionError: Error | undefined;
    const onConnectionError = (error: Error): void => { connectionError ??= error; };
    client.on('error', onConnectionError);
    try {
      const locked = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('ArenaGlobalRatingWorker/v1', 0)) AS locked`);
      if (!locked.rows[0]?.locked) return;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      let control: Control;
      let contests: Contest[];
      try {
        control = await this.control(client as unknown as PoolClient);
        if (control.active_revision === control.desired_revision) { await client.query('COMMIT'); return; }
        contests = (await client.query<Contest>('SELECT * FROM global_rating_contests WHERE desired_included ORDER BY publication_order')).rows;
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      const history = new Map<string, { rating: number; max: number; contests: number; lastOrder: string }>(); const changes: RatingChangeDto[] = [];
      for (const contest of contests) {
        if (!contest.placements || !contest.publication_order) throw new Error(`Incomplete approved rating input: ${contest.tournament_id}`);
        const input = contest.placements.map((placement) => ({ teamId: placement.teamId, rating: history.get(placement.teamId)?.rating ?? 1500, rank: placement.rank, rankEnd: placement.rankEnd }));
        const calculated = await calculateContestRatingAsync(input);
        const placements = new Map(contest.placements.map(row => [row.teamId, row]));
        for (const row of calculated) { const old = history.get(row.teamId); history.set(row.teamId, { rating: row.newRating, max: Math.max(old?.max ?? 0, row.newRating), contests: (old?.contests ?? 0) + 1, lastOrder: contest.publication_order }); const placement = placements.get(row.teamId)!; changes.push({ ...row, oldPublicRating: old?.rating ?? null, tournamentId: contest.tournament_id as RatingChangeDto['tournamentId'], tournamentName: contest.tournament_name, publicationOrder: contest.publication_order, inputRevision: contest.input_revision, rank: placement.rank, rankEnd: placement.rankEnd, participantCount: input.length, policy: POLICY }); }
      }
      if (connectionError) throw connectionError;
      await client.query('BEGIN');
      try {
        await this.mutationBarrier(client as unknown as PoolClient);
        const fresh = await this.control(client as unknown as PoolClient, true); if (fresh.desired_revision !== control.desired_revision) { await client.query('ROLLBACK'); return; }
        const generation = (await client.query<{ id: string }>('INSERT INTO global_rating_generations(desired_revision) VALUES($1) RETURNING id', [control.desired_revision])).rows[0].id;
        for (let offset = 0; offset < changes.length; offset += 500) {
          const batch = changes.slice(offset, offset + 500);
          await client.query(`INSERT INTO global_rating_changes(generation_id,tournament_id,tournament_name,team_id,publication_order,input_revision,rank,rank_end,participant_count,old_rating,old_public_rating,delta,new_rating,policy) SELECT $1,x.tournament_id,x.tournament_name,x.team_id,x.publication_order,x.input_revision,x.rank,x.rank_end,x.participant_count,x.old_rating,x.old_public_rating,x.delta,x.new_rating,$3 FROM jsonb_to_recordset($2::jsonb) AS x(tournament_id uuid,tournament_name text,team_id uuid,publication_order bigint,input_revision int,rank int,rank_end int,participant_count int,old_rating int,old_public_rating int,delta int,new_rating int)`, [generation, JSON.stringify(batch.map(row => ({ tournament_id: row.tournamentId, tournament_name: row.tournamentName, team_id: row.teamId, publication_order: row.publicationOrder, input_revision: row.inputRevision, rank: row.rank, rank_end: row.rankEnd, participant_count: row.participantCount, old_rating: row.oldRating, old_public_rating: row.oldPublicRating, delta: row.delta, new_rating: row.newRating }))), POLICY]);
        }
        const heads = [...history].map(([teamId, state]) => ({ team_id: teamId, rating: state.rating, max_rating: state.max, rated_contests: state.contests, last_publication_order: state.lastOrder }));
        for (let offset = 0; offset < heads.length; offset += 500) await client.query(`INSERT INTO global_team_ratings(generation_id,team_id,rating,max_rating,rated_contests,last_publication_order) SELECT $1,x.team_id,x.rating,x.max_rating,x.rated_contests,x.last_publication_order FROM jsonb_to_recordset($2::jsonb) AS x(team_id uuid,rating int,max_rating int,rated_contests int,last_publication_order bigint)`, [generation, JSON.stringify(heads.slice(offset, offset + 500))]);
        await client.query('UPDATE global_rating_control SET active_generation=$1,active_revision=desired_revision WHERE singleton=true', [generation]);
        await this.writeEvent(client as unknown as PoolClient, null, 'GLOBAL_RATING_GENERATION_PUBLISHED', String(generation), null, { generationId: String(generation), desiredRevision: control.desired_revision });
        await client.query(`DELETE FROM global_rating_generations WHERE id NOT IN (SELECT id FROM global_rating_generations ORDER BY id DESC LIMIT 2)`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    } finally {
      try {
        if (!connectionError) await client.query(`SELECT pg_advisory_unlock(hashtextextended('ArenaGlobalRatingWorker/v1', 0))`);
      } finally {
        try { await client.end(); } finally { client.removeListener('error', onConnectionError); }
      }
    }
  }


  private async control(client: PoolClient, lock = false): Promise<Control> { const result = await client.query<Control>(`SELECT active_generation::text,active_revision::text,desired_revision::text,next_publication_order::text FROM global_rating_control WHERE singleton=true${lock ? ' FOR UPDATE' : ''}`); return result.rows[0]; }
}
