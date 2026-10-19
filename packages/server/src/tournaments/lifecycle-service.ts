import { randomUUID } from 'node:crypto';
import type { CommandContext, Receipt } from '@oantuti/protocol';
import type { BackupFence } from '../operations/backup-fence.js';
import type { PostgresDatabase } from '../persistence/db.js';
import { runIdempotent } from '../commands/idempotency.js';

export class TournamentError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'TournamentError';
  }
}

export type TournamentLockReceipt = Receipt<{
  readonly tournamentId: string;
  readonly state: 'READY_TO_START';
  readonly eligibleTeamsCount: number;
  readonly excludedTeamsCount: number;
  readonly lockedAt: string;
}>;

export type TournamentStartReceipt = Receipt<{
  readonly tournamentId: string;
  readonly state: 'RUNNING';
  readonly startedAt: string;
}>;

export type TournamentArchiveReceipt = Receipt<{
  readonly tournamentId: string;
  readonly state: 'ARCHIVED';
  readonly archivedAt: string;
}>;


export class TournamentLifecycleService {
  constructor(
    private readonly db: PostgresDatabase,
    /** Protected-write fence: lock/start/finalize refuse to advance on a stale backup. */
    private readonly backupFence?: BackupFence,
    private readonly assertExecutionReady?: () => Promise<void>,
  ) {}

  /**
   * Locks tournament intake, drains/freezes latest official submissions for admitted teams,
   * reveals hidden maps, and advances state to READY_TO_START.
   */
  /**
   * Optimistic concurrency for the lifecycle commands (03-ARCHITECTURE §68): when the caller echoes the
   * aggregate version it acted on, a version that moved in the meantime is a conflict, not a silent
   * "start the wrong tournament state".
   */
  private assertExpectedVersion(tourney: { readonly version: number }, ctx: CommandContext): void {
    if (ctx.expectedVersion !== undefined && tourney.version !== ctx.expectedVersion) {
      throw new TournamentError(
        409,
        `STALE_VERSION: expected tournament version ${ctx.expectedVersion}, current ${tourney.version}`
      );
    }
  }

  /**
   * Locks intake. Repeating the call with the same idempotency key returns the same receipt instead of
   * draining twice (03-ARCHITECTURE §166); `expectedVersion` rejects a caller that acted on a stale view.
   */
  async lock(tournamentId: string, ctx: CommandContext): Promise<TournamentLockReceipt> {
    return runIdempotent(this.db, ctx, `LOCK:${tournamentId}`, { tournamentId }, () =>
      this.lockInternal(tournamentId, ctx)
    );
  }

  private async lockInternal(tournamentId: string, ctx: CommandContext): Promise<TournamentLockReceipt> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new TournamentError(403, 'Only administrators can lock tournament registration');
    }

    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const tourneyRes = await client.query<{
        id: string;
        state: string;
        version: number;
        registration_closes_at: string | null;
      }>('SELECT id, state, registration_closes_at, version FROM tournaments WHERE id = $1 FOR UPDATE', [
        tournamentId,
      ]);

      if (tourneyRes.rows.length === 0) {
        throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
      }

      const tourney = tourneyRes.rows[0];
      this.assertExpectedVersion(tourney, ctx);
      const validLockStates = ['PUBLISHED', 'REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS'];
      if (!validLockStates.includes(tourney.state)) {
        throw new TournamentError(409, `Cannot lock tournament in state '${tourney.state}'`);
      }

      // Check if any official submissions are currently in PENDING compile
      const pendingCheck = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM submissions
         WHERE tournament_id = $1 AND status IN ('VALIDATING', 'QUEUED', 'COMPILING', 'SMOKE_TESTING')`,
        [tournamentId]
      );
      if (parseInt(pendingCheck.rows[0].count, 10) > 0) {
        // If there are still pending submissions compiling, transition to VALIDATING_SUBMISSIONS
        await client.query(
          `UPDATE tournaments SET state = 'VALIDATING_SUBMISSIONS', updated_at = clock_timestamp() WHERE id = $1`,
          [tournamentId]
        );
        throw new TournamentError(
          409,
          'INTAKE_DRAINING: Submissions are currently compiling; wait for drain before locking'
        );
      }

      // Fetch all admitted teams
      const admissions = await client.query<{ team_id: string }>(
        `SELECT team_id FROM tournament_admissions WHERE tournament_id = $1 ORDER BY created_at ASC`,
        [tournamentId]
      );

      let eligibleCount = 0;
      let excludedCount = 0;
      let seedOrdinal = 1;

      for (const adm of admissions.rows) {
        // Find latest valid official submission
        const subRes = await client.query<{ id: string }>(
          `SELECT id FROM submissions
           WHERE tournament_id = $1 AND team_id = $2 AND status = 'READY'
           ORDER BY receipt_ordinal DESC LIMIT 1`,
          [tournamentId, adm.team_id]
        );

        if (subRes.rows.length > 0) {
          const frozenSubId = subRes.rows[0].id;
          await client.query(
            `INSERT INTO tournament_entries (tournament_id, team_id, status, frozen_submission_id, seed_ordinal)
             VALUES ($1, $2, 'ELIGIBLE', $3, $4)
             ON CONFLICT (tournament_id, team_id) DO UPDATE
             SET frozen_submission_id = EXCLUDED.frozen_submission_id,
                 status = 'ELIGIBLE',
                 seed_ordinal = EXCLUDED.seed_ordinal`,
            [tournamentId, adm.team_id, frozenSubId, seedOrdinal++]
          );
          eligibleCount++;
        } else {
          await client.query(
            `INSERT INTO tournament_entries (tournament_id, team_id, status, frozen_submission_id, seed_ordinal)
             VALUES ($1, $2, 'EXCLUDED', NULL, NULL)
             ON CONFLICT (tournament_id, team_id) DO UPDATE
             SET frozen_submission_id = NULL,
                 status = 'EXCLUDED'`,
            [tournamentId, adm.team_id]
          );
          excludedCount++;
        }
      }

      // Freeze the resolved map versions of the pool (02 §153): from here on the tournament plays the
      // versions the organizer fixed, whatever happens to the maps afterwards.
      await client.query(
        `UPDATE tournament_map_pool p
            SET map_version = m.current_version
           FROM maps m
          WHERE m.id = p.map_id AND p.tournament_id = $1`,
        [tournamentId]
      );

      // Hidden content is revealed per version, for exactly the versions this tournament plays: the
      // committed map (single-map formats) and every map in the pool (knockout series). Both are read
      // from the row each one pinned, and a later publish of the same map stays hidden until the
      // tournament that pins it locks.
      const playedMaps = `SELECT map_id FROM tournament_map_commitments WHERE tournament_id = $1
                          UNION
                          SELECT map_id FROM tournament_map_pool WHERE tournament_id = $1`;

      // Reveal HIDDEN maps in the set this tournament plays.
      await client.query(
        `UPDATE maps
         SET revealed_at = clock_timestamp()
         WHERE id IN (${playedMaps})
           AND revealed_at IS NULL`,
        [tournamentId]
      );

      await client.query(
        `WITH played AS (
           SELECT map_id, map_version FROM tournament_map_commitments WHERE tournament_id = $1
           UNION
           SELECT map_id, map_version FROM tournament_map_pool WHERE tournament_id = $1
         )
         UPDATE map_versions v
            SET revealed_at = clock_timestamp()
           FROM played p
          WHERE v.map_id = p.map_id
            AND v.version = p.map_version
            AND v.revealed_at IS NULL`,
        [tournamentId]
      );

      // Transition tournament state to READY_TO_START
      const updateRes = await client.query<{ locked_at: string }>(
        `UPDATE tournaments
         SET state = 'READY_TO_START',
             locked_at = clock_timestamp(),
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING locked_at`,
        [tournamentId]
      );
      const lockedAt = updateRes.rows[0].locked_at;

      // Emit outbox event
      await client.query(
        `INSERT INTO outbox_events (topic, payload)
         VALUES ($1, $2)`,
        [
          'TOURNAMENT_LOCKED',
          JSON.stringify({
            tournamentId,
            eligibleTeamsCount: eligibleCount,
            excludedTeamsCount: excludedCount,
            lockedAt,
          }),
        ]
      );

      return {
        receiptId: randomUUID(),
        timestamp: lockedAt,
        data: {
          tournamentId,
          state: 'READY_TO_START' as const,
          eligibleTeamsCount: eligibleCount,
          excludedTeamsCount: excludedCount,
          lockedAt,
        },
      };
    });
  }

  /**
   * Starts a locked tournament. Requires state READY_TO_START and at least 2 eligible teams.
   */
  /**
   * Starts a locked tournament. A retry with the same idempotency key and the same resolved map returns
   * the original receipt, which is what makes a double click or a lost ack safe.
   */
  async start(
    tournamentId: string,
    ctx: CommandContext,
    inputs: { readonly mapSlug?: string } = {}
  ): Promise<TournamentStartReceipt> {
    return runIdempotent(
      this.db,
      ctx,
      `START:${tournamentId}`,
      { tournamentId, mapSlug: inputs.mapSlug ?? null },
      () => this.startInternal(tournamentId, ctx)
    );
  }

  private async startInternal(
    tournamentId: string,
    ctx: CommandContext
  ): Promise<TournamentStartReceipt> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new TournamentError(403, 'Only administrators can start the tournament');
    }
    await this.assertExecutionReady?.();

    return this.db.withTransaction(async (client) => {
      await this.backupFence?.assertFresh(client);
      const tourneyRes = await client.query<{ id: string; state: string; version: number; is_rated: boolean }>(
        'SELECT id, state, version, is_rated FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId]
      );

      if (tourneyRes.rows.length === 0) {
        throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
      }

      const tourney = tourneyRes.rows[0];
      this.assertExpectedVersion(tourney, ctx);
      if (tourney.state !== 'READY_TO_START') {
        throw new TournamentError(
          409,
          `Cannot start tournament: expected state 'READY_TO_START', got '${tourney.state}'`
        );
      }

      // Map pool policy (02-GAMEPLAY §153): a knockout preset needs at least four maps so a
      // four-game series never repeats a version, while round-robin and Elo need one. The pool is
      // frozen at registration opening, so a pool that cannot host the stage blocks the start
      // instead of being silently widened later.
      const formatRes = await client.query<{ format: string }>('SELECT format FROM tournaments WHERE id = $1', [
        tournamentId,
      ]);
      const format = formatRes.rows[0]?.format ?? '';
      const requiredPoolSize = format === 'SINGLE_ELIMINATION' || format === 'SWISS_PLAYOFF' ? 4 : 1;
      const poolRes = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tournament_map_pool WHERE tournament_id = $1',
        [tournamentId]
      );
      const poolSize = parseInt(poolRes.rows[0].count, 10);
      if (poolSize < requiredPoolSize) {
        throw new TournamentError(
          400,
          `MAP_POOL_TOO_SMALL: ${format} requires at least ${requiredPoolSize} maps in the pool, found ${poolSize}`
        );
      }

      // Check eligible teams
      const eligibleRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tournament_entries
         WHERE tournament_id = $1 AND status = 'ELIGIBLE'`,
        [tournamentId]
      );
      const eligibleCount = parseInt(eligibleRes.rows[0].count, 10);
      if (eligibleCount < 2) {
        throw new TournamentError(
          400,
          `Cannot start tournament: at least 2 eligible teams with valid frozen submissions required, found ${eligibleCount}`
        );
      }

      if (tourney.is_rated) {
        await client.query(
          `UPDATE tournament_entries
              SET global_rating_participant = true
            WHERE tournament_id = $1 AND status = 'ELIGIBLE' AND frozen_submission_id IS NOT NULL`,
          [tournamentId]
        );
      }

      // Advance state to RUNNING
      const updateRes = await client.query<{ started_at: string }>(
        `UPDATE tournaments
         SET state = 'RUNNING',
             started_at = clock_timestamp(),
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING started_at`,
        [tournamentId]
      );
      const startedAt = updateRes.rows[0].started_at;

      // Emit outbox event
      await client.query(
        `INSERT INTO outbox_events (topic, payload)
         VALUES ($1, $2)`,
        [
          'TOURNAMENT_STARTED',
          JSON.stringify({
            tournamentId,
            eligibleTeamsCount: eligibleCount,
            startedAt,
          }),
        ]
      );

      return {
        receiptId: randomUUID(),
        timestamp: startedAt,
        data: {
          tournamentId,
          state: 'RUNNING' as const,
          startedAt,
        },
      };
    });
  }
  /** Archive is a state transition, never a purge: evidence and retention holds stay intact. */
  async archive(tournamentId: string, ctx: CommandContext): Promise<TournamentArchiveReceipt> {
    // Authorize before receipt lookup, so a limited session cannot replay a privileged command.
    if (ctx.actor.role !== 'ADMIN' || ctx.actor.scope !== 'FULL') {
      throw new TournamentError(403, 'Only fully authenticated administrators can archive tournaments');
    }
    return runIdempotent(this.db, ctx, `ARCHIVE:${tournamentId}`, { tournamentId }, async () => {
      return this.db.withTransaction(async (client) => {
        await this.backupFence?.assertFresh(client);
        const result = await client.query<{ state: string; version: number }>(
          'SELECT state, version FROM tournaments WHERE id = $1 FOR UPDATE',
          [tournamentId]
        );
        const tournament = result.rows[0];
        if (!tournament) throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
        this.assertExpectedVersion(tournament, ctx);
        if (tournament.state !== 'FINALIZED') {
          throw new TournamentError(409, `Cannot archive tournament in state '${tournament.state}'`);
        }
        const disputes = await client.query(
          `SELECT id FROM disputes WHERE tournament_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW') LIMIT 1`,
          [tournamentId]
        );
        if (disputes.rows.length > 0) {
          throw new TournamentError(409, 'OPEN_DISPUTES: Resolve active disputes before archiving');
        }
        // Do not clear legal/security/team holds, rewrite finalized_at, or delete any data.
        const updated = await client.query<{ archived_at: Date }>(
          `UPDATE tournaments SET state = 'ARCHIVED', version = version + 1, updated_at = clock_timestamp()
           WHERE id = $1 RETURNING updated_at AS archived_at`,
          [tournamentId]
        );
        const archivedAt = updated.rows[0].archived_at.toISOString();
        const data = { tournamentId, state: 'ARCHIVED' as const, archivedAt };
        await client.query(
          `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'TOURNAMENT_ARCHIVED', 'tournament', $2, $3)`,
          [ctx.actor.userId, tournamentId, JSON.stringify({ ...data, requestId: ctx.requestId })]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ('TOURNAMENT_ARCHIVED', $1)`,
          [JSON.stringify(data)]
        );
        return { receiptId: randomUUID(), timestamp: archivedAt, data };
      });
    });
  }




  /**
   * Extends registration deadline: only allowed while intake is open and before current cutoff.
   */
  async extendRegistration(
    tournamentId: string,
    newClosesAt: Date,
    ctx: CommandContext
  ): Promise<{ tournamentId: string; registrationClosesAt: string }> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new TournamentError(403, 'Only administrators can extend registration');
    }

    return this.db.withTransaction(async (client) => {
      const tourneyRes = await client.query<{
        id: string;
        state: string;
        version: number;
        registration_closes_at: Date | null;
      }>('SELECT id, state, registration_closes_at, version FROM tournaments WHERE id = $1 FOR UPDATE', [
        tournamentId,
      ]);

      if (tourneyRes.rows.length === 0) {
        throw new TournamentError(404, `Tournament not found: ${tournamentId}`);
      }

      const tourney = tourneyRes.rows[0];
      this.assertExpectedVersion(tourney, ctx);
      if (tourney.state !== 'REGISTRATION_OPEN') {
        throw new TournamentError(
          409,
          `Cannot extend registration: tournament is in state '${tourney.state}', must be 'REGISTRATION_OPEN'`
        );
      }

      const now = new Date();
      if (tourney.registration_closes_at && now >= tourney.registration_closes_at) {
        throw new TournamentError(
          409,
          'EXTENSION_DENIED: Current registration cutoff has already passed; cannot reopen closed intake'
        );
      }

      if (newClosesAt <= now || (tourney.registration_closes_at && newClosesAt <= tourney.registration_closes_at)) {
        throw new TournamentError(400, 'New registration closing time must be strictly after current cutoff');
      }

      await client.query(
        `UPDATE tournaments
         SET registration_closes_at = $1, updated_at = clock_timestamp()
         WHERE id = $2`,
        [newClosesAt, tournamentId]
      );

      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'REGISTRATION_EXTENDED', 'tournament', $2, $3)`,
        [ctx.actor.userId, tournamentId, JSON.stringify({ newClosesAt: newClosesAt.toISOString() })]
      );

      return {
        tournamentId,
        registrationClosesAt: newClosesAt.toISOString(),
      };
    });
  }

  /** Pauses a running tournament; idempotent under the caller's key. */
  async pauseTournament(tournamentId: string, ctx: CommandContext): Promise<{ tournamentId: string; state: 'PAUSED' }> {
    return runIdempotent(this.db, ctx, `PAUSE:${tournamentId}`, { tournamentId }, () =>
      this.pauseInternal(tournamentId, ctx)
    );
  }

  private async pauseInternal(tournamentId: string, ctx: CommandContext): Promise<{ tournamentId: string; state: 'PAUSED' }> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new TournamentError(403, 'Only administrators can pause the tournament');
    }

    return this.db.withTransaction(async (client) => {
      const tourneyRes = await client.query<{ id: string; state: string; version: number }>(
        'SELECT id, state, version FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId]
      );
      if (tourneyRes.rows.length === 0) throw new TournamentError(404, 'Tournament not found');
      const tourney = tourneyRes.rows[0];
      this.assertExpectedVersion(tourney, ctx);
      if (tourney.state !== 'RUNNING') {
        throw new TournamentError(409, `Cannot pause tournament in state '${tourney.state}'`);
      }

      await client.query(
        `UPDATE tournaments SET state = 'PAUSED', version = version + 1, updated_at = clock_timestamp() WHERE id = $1`,
        [tournamentId]
      );

      await client.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
        ['TOURNAMENT_PAUSED', JSON.stringify({ tournamentId })]
      );

      return { tournamentId, state: 'PAUSED' };
    });
  }

  /** Resumes a paused tournament; idempotent under the caller's key. */
  async resumeTournament(tournamentId: string, ctx: CommandContext): Promise<{ tournamentId: string; state: 'RUNNING' }> {
    return runIdempotent(this.db, ctx, `RESUME:${tournamentId}`, { tournamentId }, () =>
      this.resumeInternal(tournamentId, ctx)
    );
  }

  private async resumeInternal(tournamentId: string, ctx: CommandContext): Promise<{ tournamentId: string; state: 'RUNNING' }> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new TournamentError(403, 'Only administrators can resume the tournament');
    }

    return this.db.withTransaction(async (client) => {
      const tourneyRes = await client.query<{ id: string; state: string; version: number }>(
        'SELECT id, state, version FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId]
      );
      if (tourneyRes.rows.length === 0) throw new TournamentError(404, 'Tournament not found');
      const tourney = tourneyRes.rows[0];
      this.assertExpectedVersion(tourney, ctx);
      if (tourney.state !== 'PAUSED') {
        throw new TournamentError(409, `Cannot resume tournament in state '${tourney.state}'`);
      }

      await client.query(
        `UPDATE tournaments SET state = 'RUNNING', version = version + 1, updated_at = clock_timestamp() WHERE id = $1`,
        [tournamentId]
      );

      await client.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
        ['TOURNAMENT_RESUMED', JSON.stringify({ tournamentId })]
      );

      return { tournamentId, state: 'RUNNING' };
    });
  }
}
