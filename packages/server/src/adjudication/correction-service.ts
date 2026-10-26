import { createHash, randomUUID } from 'node:crypto';
import type { CommandContext, CorrectionImpact, Digest, Receipt } from '@oantuti/protocol';
import type pg from 'pg';
import { invalidateDownstream } from '../tournaments/scheduler-service.js';
import type { PostgresDatabase } from '../persistence/db.js';
import { isEncounterStarted } from '../tournaments/encounter-state.js';
import type { BackupFence } from '../operations/backup-fence.js';

export class CorrectionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'CorrectionError';
  }
}

export interface CorrectionCommand {
  readonly action: 'VOID' | 'REJUDGE';
  readonly reason: string;
  readonly expectedRevision: number;
}

/** Input for {@link CorrectionService.disqualifyTeam}. */
export interface DisqualificationCommand {
  /** Stage whose encounters are voided; defaults to `MAIN`. */
  readonly stage?: string;
  /** Public reason shown with the decision; required and never derived from private evidence. */
  readonly reason: string;
}

export interface DisqualificationResult {
  readonly tournamentId: string;
  readonly teamId: string;
  readonly stage: string;
  /** Encounters of the team in the stage that were voided. */
  readonly voidedEncounters: number;
  /** Not-yet-started encounters resolved as a walkover for the still-active opponent (§118). */
  readonly walkovers: number;
  /** Not-yet-started encounters where the opponent was already gone (0-0, no rating). */
  readonly doubleWithdrawals: number;
  /** Downstream encounters of the earliest affected round that were cancelled. */
  readonly invalidatedDownstream: number;
  /** True when the call paused a running tournament as part of the ruling. */
  readonly paused: boolean;
  readonly earliestRound: number | null;
}

export type CorrectionImpactDto = CorrectionImpact;

export type CorrectionReceipt = Receipt<{
  readonly gameId: string;
  readonly newRevision: number;
  readonly impactDigest: Digest;
  readonly appliedAt: string;
}>;

export class CorrectionService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly onCorrectionApplied?: (gameId: string) => Promise<void>,
    /**
     * Cancels every round after `roundOrdinal` in `stage` and re-opens it. Disqualification needs
     * the schedule rebuilt from the reduced field; the scheduler owns that work.
     */
    private readonly onStageInvalidated?: (
      tournamentId: string,
      stage: string,
      roundOrdinal: number
    ) => Promise<{ cancelledEncounters: number; cancelledRounds: readonly number[] }>,
    /**
     * Freshness fence for protected ledger writes (05 §7). Corrections, disqualifications and
     * finalization mutate accepted results, so they refuse to proceed while the last verified
     * restore point is missing or older than the configured lag.
     */
    private readonly backupFence?: BackupFence,
    /** Must enqueue through this transaction using the active broker deployment generation. */
    private readonly scheduleReplay?: (gameId: string, client: pg.PoolClient) => Promise<void>
  ) {}

  private validateCommand(command: CorrectionCommand, ctx: CommandContext): void {
    if (ctx.actor.role !== 'ADMIN' || ctx.actor.scope !== 'FULL') throw new CorrectionError(403, 'Only fully authenticated administrators can correct results');
    if (!command || !['VOID', 'REJUDGE'].includes(command.action) || typeof command.reason !== 'string' ||
        command.reason.trim().length < 3 || command.reason.length > 500 ||
        !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
      throw new CorrectionError(400, 'Valid action, reason (3–500 characters), and positive integer expectedRevision required');
    }
  }

  private async lockedImpact(client: pg.PoolClient, gameId: string, command: CorrectionCommand) {
    const t = (await client.query<{ id: string; state: string }>(
      `SELECT t.id, t.state FROM tournaments t WHERE t.id = (SELECT e.tournament_id FROM games g
       JOIN encounters e ON e.id = g.encounter_id WHERE g.id = $1) FOR UPDATE`, [gameId])).rows[0];
    if (!t) throw new CorrectionError(404, `Game not found: ${gameId}`);
    if (t.state === 'FINALIZED' || t.state === 'ARCHIVED') throw new CorrectionError(409,
      'TOURNAMENT_REOPEN_REQUIRED: reopen the finalized tournament before correcting its results');
    const game = (await client.query<{ encounter_id: string; encounter_status: string; stage: string; round_ordinal: number; status: string }>(
      `SELECT e.id AS encounter_id, e.status AS encounter_status, e.stage, e.round_ordinal, g.status FROM games g
       JOIN encounters e ON e.id = g.encounter_id WHERE g.id = $1 FOR UPDATE OF e, g`, [gameId])).rows[0];
    if (game.encounter_status === 'CANCELLED') throw new CorrectionError(409, 'ENCOUNTER_CANCELLED: a correction cannot undo disqualification or invalidation');
    const accepted = (await client.query<{ revision: number }>(
      `SELECT rv.revision FROM accepted_results ar JOIN result_versions rv ON rv.id = ar.result_version_id
       WHERE ar.game_id = $1 FOR UPDATE OF ar`, [gameId])).rows[0];
    if (game.status !== 'COMPLETED' || !accepted) throw new CorrectionError(400, 'Cannot correct a game that has no accepted result');
    if (accepted.revision !== command.expectedRevision) throw new CorrectionError(409,
      `Revision mismatch: expected ${command.expectedRevision}, current is ${accepted.revision}`);
    const descendants = await client.query<{ id: string }>(
      `SELECT id FROM encounters WHERE tournament_id = $1 AND status <> 'CANCELLED'
       AND ((stage = $2 AND round_ordinal > $3) OR ($2 <> 'PLAYOFF' AND stage = 'PLAYOFF'))
       ORDER BY stage, round_ordinal, id FOR UPDATE`, [t.id, game.stage, game.round_ordinal]);
    const ids = [game.encounter_id, ...descendants.rows.map(row => row.id)];
    const revisions = await client.query<{ gameId: string; revision: number }>(
      `SELECT g.id AS "gameId", rv.revision FROM games g JOIN accepted_results ar ON ar.game_id = g.id
       JOIN result_versions rv ON rv.id = ar.result_version_id WHERE g.encounter_id = ANY($1::uuid[])
       ORDER BY g.id FOR UPDATE OF g, ar`, [ids]);
    const rounds = await client.query<{ stage: string; roundOrdinal: number }>(
      `SELECT stage, round_ordinal AS "roundOrdinal" FROM tournament_rounds WHERE tournament_id = $1
       AND ((stage = $2 AND round_ordinal >= $3) OR ($2 <> 'PLAYOFF' AND stage = 'PLAYOFF'))
       ORDER BY stage, round_ordinal FOR UPDATE`, [t.id, game.stage, game.round_ordinal]);
    const ratings = await client.query<{ id: string; team_id: string }>(
      `SELECT id, team_id FROM rating_events WHERE encounter_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
    const impact = { gameId, encounterId: game.encounter_id, roundOrdinal: game.round_ordinal,
      currentRevision: accepted.revision, action: command.action, affectedRevisions: revisions.rows,
      descendantEncounterIds: descendants.rows.map(row => row.id), affectedRounds: rounds.rows,
      requiredRePair: descendants.rows.length > 0 || rounds.rows.length > 1, requiredRebuild: true,
      ratingImpact: { eventIds: ratings.rows.map(row => row.id), teamIds: [...new Set(ratings.rows.map(row => row.team_id))].sort() } };
    const previewDigest = createHash('sha256').update(JSON.stringify({ ...impact, reason: command.reason })).digest('hex');
    const preview: CorrectionImpactDto = { ...impact, previewDigest,
      description: `${command.action} revision ${accepted.revision}; rebuild ${rounds.rows.length} rounds, invalidate ${descendants.rows.length} descendants and ${ratings.rows.length} rating events. Reason: ${command.reason}` };
    return { preview, tournamentId: t.id, stage: game.stage };
  }

  async previewCorrection(gameId: string, command: CorrectionCommand, ctx: CommandContext): Promise<CorrectionImpactDto> {
    this.validateCommand(command, ctx);
    return this.db.withTransaction(async client => (await this.lockedImpact(client, gameId, command)).preview);
  }

  async applyCorrection(gameId: string, command: CorrectionCommand, previewDigest: string, ctx: CommandContext): Promise<CorrectionReceipt> {
    this.validateCommand(command, ctx);
    const key = ctx.idempotencyKey?.trim();
    if (key && (key.length < 16 || key.length > 128)) throw new CorrectionError(400, 'IDEMPOTENCY_KEY_INVALID');
    const payloadDigest = createHash('sha256').update(JSON.stringify({ gameId, action: command.action,
      reason: command.reason, expectedRevision: command.expectedRevision, previewDigest })).digest('hex');
    let newlyApplied = false;
    const receipt = await this.db.withTransaction(async client => {
      let receiptRowId: string | undefined;
      if (key) {
        const claimed = await client.query<{ id: string }>(
          `INSERT INTO command_receipts (actor_user_id, scope, idempotency_key, payload_digest)
           VALUES ($1, 'RESULT_CORRECTION', $2, $3) ON CONFLICT (actor_user_id, scope, idempotency_key) DO NOTHING RETURNING id`,
          [ctx.actor.userId, key, payloadDigest]);
        if (!claimed.rows.length) {
          const existing = (await client.query<{ payload_digest: string; status: string; receipt: CorrectionReceipt }>(
            `SELECT payload_digest, status, receipt FROM command_receipts
             WHERE actor_user_id = $1 AND scope = 'RESULT_CORRECTION' AND idempotency_key = $2 FOR UPDATE`, [ctx.actor.userId, key])).rows[0];
          if (existing?.payload_digest !== payloadDigest) throw new CorrectionError(409, 'IDEMPOTENCY_CONFLICT');
          if (existing.status === 'DONE' && existing.receipt) return existing.receipt;
          throw new CorrectionError(409, 'IDEMPOTENT_IN_FLIGHT');
        }
        receiptRowId = claimed.rows[0].id;
      }
      await this.backupFence?.assertFresh(client);
      const { preview, tournamentId, stage } = await this.lockedImpact(client, gameId, command);
      if (preview.previewDigest !== previewDigest) throw new CorrectionError(409, 'PREVIEW_DIGEST_MISMATCH: Stale or invalid preview digest');
      if (command.action === 'REJUDGE' && !this.scheduleReplay) throw new CorrectionError(503, 'REJUDGE_UNAVAILABLE: no transactional replay executor is wired');
      const current = (await client.query<{
        result_version_id: string; revision: number; action_trace_digest: string; replay_digest: string; manifest_digest: string;
      }>(`SELECT ar.result_version_id, rv.revision, rv.action_trace_digest, rv.replay_digest, rv.manifest_digest
          FROM accepted_results ar JOIN result_versions rv ON rv.id = ar.result_version_id
          WHERE ar.game_id = $1 FOR UPDATE OF ar`, [gameId])).rows[0];
      const appliedAt = new Date().toISOString();
      let newVersionId: string | null = null;
      let newRevision = current.revision;
      if (command.action === 'VOID') {
        newRevision++;
        newVersionId = (await client.query<{ id: string }>(
          `INSERT INTO result_versions (game_id, revision, verdict, winner, reason, disposition, action_trace_digest, replay_digest, manifest_digest)
           VALUES ($1,$2,'NO_CONTEST',0,$3,'NO_CONTEST',$4,$5,$6) RETURNING id`,
          [gameId, newRevision, `CORRECTION_VOID: ${command.reason}`, current.action_trace_digest, current.replay_digest, current.manifest_digest])).rows[0].id;
        await client.query(`UPDATE accepted_results SET result_version_id = $2, accepted_at = $3 WHERE game_id = $1`, [gameId, newVersionId, appliedAt]);
      } else {
        // REJUDGE preserves evidence and records no fabricated replacement outcome.
        await client.query('DELETE FROM accepted_results WHERE game_id = $1', [gameId]);
        await client.query(`UPDATE games SET status = 'PENDING' WHERE id = $1`, [gameId]);
      }
      await client.query(`INSERT INTO result_corrections (game_id, from_result_version_id, to_result_version_id,
        action, reason, authorized_by_user_id, preview_digest, impact_summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [gameId, current.result_version_id, newVersionId, command.action, command.reason, ctx.actor.userId, previewDigest, JSON.stringify(preview)]);
      await invalidateDownstream(client, { tournamentId, stage, roundOrdinal: preview.roundOrdinal, extraEncounterIds: [preview.encounterId] });
      await client.query(`DELETE FROM rating_events WHERE encounter_id = $1`, [preview.encounterId]);
      await client.query(`DELETE FROM standings_snapshots WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
        [tournamentId, stage, preview.roundOrdinal]);
      await client.query(`UPDATE tournament_rounds SET status = 'RUNNING', seal_eligible_at = NULL,
        last_terminal_at = NULL WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
        [tournamentId, stage, preview.roundOrdinal]);
      await client.query(`UPDATE encounters SET status = 'RUNNING', points_a = 0, points_b = 0, winner_team_id = NULL WHERE id = $1`, [preview.encounterId]);
      if (command.action === 'REJUDGE') await this.scheduleReplay!(gameId, client);
      const topic = command.action === 'REJUDGE' ? 'RESULT_REJUDGE_REQUESTED' : 'RESULT_CORRECTED';
      const details = { gameId, fromRevision: current.revision, toRevision: newRevision, withdrawnRevision: current.revision,
        action: command.action, reason: command.reason, authorizedByUserId: ctx.actor.userId, appliedAt };
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1,$2)`, [topic, JSON.stringify(details)]);
      await client.query(`INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
        VALUES ($1,$2,'game',$3,$4)`, [ctx.actor.userId, topic, gameId, JSON.stringify({ ...details, requestId: ctx.requestId })]);
      const result: CorrectionReceipt = { receiptId: randomUUID(), timestamp: appliedAt,
        data: { gameId, newRevision, impactDigest: previewDigest, appliedAt } };
      if (receiptRowId) await client.query(`UPDATE command_receipts SET status = 'DONE', receipt = $2,
        updated_at = clock_timestamp() WHERE id = $1`, [receiptRowId, JSON.stringify(result)]);
      newlyApplied = true;
      return result;
    });
    // Invalidation and replay intent are already durable. This only reduces scoring latency.
    if (newlyApplied && this.onCorrectionApplied) await this.onCorrectionApplied(gameId);
    return receipt;
  }

  /**
   * Disqualification (02-GAMEPLAY §124): the decision voids **every** encounter of the team in the
   * stage — no cherry-picking which results to keep — and the schedule from the earliest affected
   * round is rebuilt without that team. The tournament is paused first: a DQ is an upheld ruling,
   * not a live adjustment. A running tournament is paused by this call; already-played games stay
   * as evidence, but their encounter no longer counts in standings or ratings.
   */
  async disqualifyTeam(
    tournamentId: string,
    teamId: string,
    command: DisqualificationCommand,
    ctx: CommandContext
  ): Promise<DisqualificationResult> {
    if (ctx.actor.role !== 'ADMIN' || ctx.actor.scope !== 'FULL') {
      throw new CorrectionError(403, 'Only fully authenticated administrators can disqualify a team');
    }
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
      throw new CorrectionError(400, 'A public reason between 3 and 500 characters is required');
    }
    const stage = (command.stage ?? 'MAIN').toUpperCase();
    if (stage !== 'MAIN' && stage !== 'PLAYOFF' && stage !== 'SWISS') {
      throw new CorrectionError(400, "stage must be 'MAIN', 'SWISS' or 'PLAYOFF'");
    }


    const outcome = await this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const tournamentRes = await client.query<{ state: string }>(
        'SELECT state FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId]
      );
      const tournament = tournamentRes.rows[0];
      if (!tournament) {
        throw new CorrectionError(404, `Tournament not found: ${tournamentId}`);
      }
      const disqualifiable = ['RUNNING', 'PAUSED', 'PROVISIONAL'];
      if (!disqualifiable.includes(tournament.state)) {
        throw new CorrectionError(
          409,
          `Cannot disqualify a team in tournament state '${tournament.state}'; expected ${disqualifiable.join(' or ')}`
        );
      }

      const entryRes = await client.query<{ status: string }>(
        'SELECT status FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2 FOR UPDATE',
        [tournamentId, teamId]
      );
      if (entryRes.rows.length === 0) {
        throw new CorrectionError(404, 'Team is not enrolled in this tournament');
      }
      if (entryRes.rows[0].status === 'EXCLUDED') {
        throw new CorrectionError(409, 'Team is already out of this tournament');
      }

      const stageEncounters = await client.query<{
        id: string;
        round_ordinal: number;
        team_a_id: string;
        team_b_id: string | null;
        status: string;
      }>(
        `SELECT id, round_ordinal, team_a_id, team_b_id, status FROM encounters
          WHERE tournament_id = $1 AND stage = $2 AND (team_a_id = $3 OR team_b_id = $3)
          FOR UPDATE`,
        [tournamentId, stage, teamId]
      );

      const voidedIds: string[] = [];
      const erasedRounds: number[] = [];
      const affectedIds: string[] = [];

      for (const encounter of stageEncounters.rows) {
        affectedIds.push(encounter.id);
        const started = await isEncounterStarted(client, encounter.id);

        // An encounter that has not started stays untouched here: it is either cancelled by the
        // rebuild triggered below, or resolved as a walkover afterwards (never both). A dispatched
        // encounter is `RUNNING` before any worker claims it, so its status alone proves nothing.
        if (!started && (encounter.status === 'PENDING' || encounter.status === 'RUNNING')) continue;

        // Played (or already resolved) encounter: §124 voids the team's stage results as a block, so
        // no partial result survives and nobody inherits the win.
        voidedIds.push(encounter.id);
        erasedRounds.push(encounter.round_ordinal);
        // Unstarted games are cancelled; a game that already ran keeps its row and evidence.
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
        await client.query(
          `UPDATE encounters
              SET status = 'CANCELLED', winner_team_id = NULL, points_a = 0, points_b = 0
            WHERE id = $1`,
          [encounter.id]
        );
      }

      // The earliest erased round is where the bracket must be rebuilt without this team. A walkover
      // needs no rebuild: it resolves inside the schedule that already exists.
      const earliestRound = erasedRounds.length > 0 ? Math.min(...erasedRounds) : null;

      if (affectedIds.length > 0) {
        const closed = await client.query(
          `UPDATE disputes
              SET status = 'RESOLVED', decision = 'DQ_UPHELD', resolved_at = clock_timestamp()
            WHERE encounter_id = ANY($1::uuid[]) AND status IN ('OPEN', 'UNDER_REVIEW')`,
          [affectedIds]
        );
        await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'ENCOUNTERS_VOIDED_BY_DQ',
          JSON.stringify({
            tournamentId,
            teamId,
            stage,
            voidedEncounters: voidedIds.length,
            resolvedDisputes: closed.rowCount ?? 0,
          }),
        ]);
      }

      await client.query(
        `UPDATE tournament_entries SET status = 'EXCLUDED', frozen_submission_id = NULL,
         global_rating_exclusion = 'DISQUALIFIED'
          WHERE tournament_id = $1 AND team_id = $2`,
        [tournamentId, teamId]
      );
      await client.query(
        `UPDATE tournament_registrations SET status='CANCELLED',version=version+1,cancelled_entry_id=NULL,
           reason=$3,reviewed_by_user_id=$4,reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE tournament_id=$1 AND team_id=$2 AND status='APPROVED'`,
        [tournamentId, teamId, reason, ctx.actor.userId],
      );

      const paused = tournament.state === 'RUNNING';
      if (paused) {
        await client.query(
          `UPDATE tournaments SET state = 'PAUSED', updated_at = clock_timestamp() WHERE id = $1`,
          [tournamentId]
        );
        await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'TOURNAMENT_PAUSED',
          JSON.stringify({ tournamentId, reason: 'DISQUALIFICATION' }),
        ]);
      }

      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'TEAM_DISQUALIFIED', 'tournament', $2, $3, $4)`,
        [
          ctx.actor.userId,
          tournamentId,
          randomUUID(),
          JSON.stringify({ teamId, stage, reason, voidedEncounters: voidedIds.length, paused }),
        ]
      );
      await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
        'TEAM_DISQUALIFIED',
        JSON.stringify({ tournamentId, teamId, stage, reason, voidedEncounters: voidedIds.length }),
      ]);

      return { voidedIds, earliestRound, paused };
    });

    let cancelledEncounters = 0;
    if (outcome.earliestRound !== null && this.onStageInvalidated) {
      const invalidated = await this.onStageInvalidated(tournamentId, stage, outcome.earliestRound);
      cancelledEncounters = invalidated.cancelledEncounters;
    }

    // Only now, with the schedule rebuilt without this team, are the encounter slots that still
    // reference it resolved (02-GAMEPLAY §118) — rebuilding first keeps a walkover from being
    // announced for a pairing the rebuild is about to replace.
    const resolved = await this.resolveUnstartedStageEncounters(tournamentId, teamId, stage);

    return {
      tournamentId,
      teamId,
      stage,
      voidedEncounters: outcome.voidedIds.length,
      walkovers: resolved.walkovers,
      doubleWithdrawals: resolved.doubleWithdrawals,
      invalidatedDownstream: cancelledEncounters,
      paused: outcome.paused,
      earliestRound: outcome.earliestRound,
    };
  }

  /**
   * Resolves the disqualified team's not-yet-started encounters that survived the rebuild exactly
   * like a withdrawal (02-GAMEPLAY §118): the active opponent is not punished for someone else's
   * disqualification — Swiss/RR award 3 points, knockout advances that opponent, Elo rates nothing.
   * With no opponent left it becomes a 0-0 double withdrawal. Nothing of the disqualified team
   * survives either way, and an encounter that already started finishes with its frozen Bots.
   */
  private async resolveUnstartedStageEncounters(
    tournamentId: string,
    teamId: string,
    stage: string
  ): Promise<{ walkovers: number; doubleWithdrawals: number }> {
    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const formatRes = await client.query<{ format: string }>('SELECT format FROM tournaments WHERE id = $1', [
        tournamentId,
      ]);
      const format = formatRes.rows[0]?.format ?? '';
      const winnerPoints = format === 'SWISS_PLAYOFF' || format === 'ROUND_ROBIN' ? 3 : 0;

      const pending = await client.query<{
        id: string;
        round_ordinal: number;
        team_a_id: string;
        team_b_id: string | null;
      }>(
        `SELECT id, round_ordinal, team_a_id, team_b_id FROM encounters
          WHERE tournament_id = $1 AND stage = $2 AND status IN ('PENDING', 'RUNNING')
            AND (team_a_id = $3 OR team_b_id = $3)
          FOR UPDATE`,
        [tournamentId, stage, teamId]
      );

      let walkovers = 0;
      let doubleWithdrawals = 0;

      for (const encounter of pending.rows) {
        const opponentId = encounter.team_a_id === teamId ? encounter.team_b_id : encounter.team_a_id;
        if (!opponentId) continue;

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
        // Dispatched games are `RUNNING` before any worker touches them, so everything that is not
        // COMPLETED must be withdrawn — and the pending jobs blocked, or the worker would still play
        // a game whose encounter is already decided.
        await client.query(`UPDATE games SET status = 'CANCELLED' WHERE encounter_id = $1 AND status <> 'COMPLETED'`, [
          encounter.id,
        ]);
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
            disqualifiedTeamId: teamId,
            opponentTeamId: opponentActive ? opponentId : null,
            stage,
            roundOrdinal: encounter.round_ordinal,
            points: aWins ? winnerPoints : bWins ? winnerPoints : 0,
          }),
        ]);
        if (opponentActive) walkovers++;
        else doubleWithdrawals++;
      }

      return { walkovers, doubleWithdrawals };
    });
  }

}
