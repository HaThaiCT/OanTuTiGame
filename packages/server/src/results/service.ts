import { createHash, randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type {
  AcceptedResultReceipt,
  Digest,
  GameResultDto,
  GameResultEvidence,
  ResultEvidence,
} from '@oantuti/protocol';
import { statementRunner, type PostgresDatabase } from '../persistence/db.js';
import { ReplayStore, type ReplayV2Payload } from './replay-store.js';
import { TraceVerifier } from './trace-verifier.js';
import { isAuthenticatedNativeExecution, type AuthenticatedNativeExecution } from '../jobs/local-transport.js';
import type { AcceptanceFence } from '../jobs/broker.js';
import type { PoolClient } from 'pg';

export class ResultIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultIntegrityError';
  }
}

/**
 * Raised when a game already has an accepted result, so a second accepted version was not
 * created. Lease replays (a job reclaimed after a restart, two workers racing the same game)
 * map this to "already complete" and finish the job with the recorded result instead.
 */
export class ResultAlreadyAcceptedError extends Error {
  readonly code = 'ALREADY_ACCEPTED';

  constructor(
    readonly gameId: string,
    readonly resultVersionId: string,
    readonly acceptedAt: string
  ) {
    super(`ALREADY_ACCEPTED: game ${gameId} already has accepted result ${resultVersionId}`);
    this.name = 'ResultAlreadyAcceptedError';
  }
}

/**
 * Raised when an administrative ruling on the game's encounter (withdrawal walkover, double
 * withdrawal, downstream cancellation) outranks the completion attempt of a late-claimed job.
 * Accepting a played result after such a ruling would overwrite the sealed outcome; the caller
 * treats this as terminal — the job's own fence should already refuse the attempt.
 */
export class ResultRejectedError extends Error {
  readonly code = 'RESULT_REJECTED';

  constructor(
    readonly gameId: string,
    readonly reason: string
  ) {
    super(`RESULT_REJECTED: game ${gameId} refused (${reason})`);
    this.name = 'ResultRejectedError';
  }
}

const ADMIN_RESOLVED_ENCOUNTER_STATUSES: Record<string, true> = {
  CANCELLED: true,
  WALKOVER: true,
  DOUBLE_WITHDRAWAL: true,
};

/** Why a result may not land on this game; null when the game is open. */
function resultRejectionReason(gameStatus: string | null, encounterStatus: string | null): string | null {
  if (gameStatus === 'CANCELLED') return 'GAME_CANCELLED';
  if (encounterStatus !== null && ADMIN_RESOLVED_ENCOUNTER_STATUSES[encounterStatus]) {
    return `ENCOUNTER_${encounterStatus}`;
  }
  return null;
}

/** The accepted result of a game, plus the evidence a job completion pins for it. */
export interface AcceptedResultSummary {
  readonly resultVersionId: string;
  readonly revision: number;
  readonly evidence: ResultEvidence;
}

export interface RecordResultInput {
  readonly gameId: string;
  readonly attemptId: string;
  readonly evidence: GameResultEvidence;
  readonly manifestDigest: Digest;
  readonly mapDescriptor: MapDescriptor;
  /** Must match the execution manifest's ply limit. Official games currently use 300. */
  readonly maxTurns?: number;
  readonly client?: PoolClient;
  readonly nativeExecution?: AuthenticatedNativeExecution;
}

export class ResultService {
  private acceptanceFence?: AcceptanceFence;
  setAcceptanceFence(fence: AcceptanceFence): void { this.acceptanceFence = fence; }
  constructor(
    private readonly db: PostgresDatabase,
    private readonly replayStore: ReplayStore,
    private readonly traceVerifier: TraceVerifier = new TraceVerifier(),
    private readonly onGameAccepted?: (gameId: string) => Promise<void>
  ) {}

  async validateNativeEvidence(input: RecordResultInput): Promise<void> {
    const execution = input.nativeExecution;
    if (!execution || !isAuthenticatedNativeExecution(execution) || execution.gameId !== input.gameId || execution.lease.attemptId !== input.attemptId || execution.manifestDigest !== input.manifestDigest || execution.actionTraceDigest !== createHash('sha256').update(JSON.stringify(input.evidence.trace)).digest('hex')) throw new ResultIntegrityError('NATIVE_EXECUTION_BINDING_MISMATCH');
    const verified = await this.traceVerifier.verify(input.mapDescriptor, input.evidence, input.maxTurns ?? 300, execution);
    if (!verified.isValid || verified.requiresSupervisorEvidence) throw new ResultIntegrityError(`Trace verification failed: ${verified.error ?? 'SUPERVISOR_EVIDENCE_REQUIRED'}`);
  }

  /**
   * Accepts and records a game result with full cryptographic and game engine trace verification.
   * Performs an atomic durable commit in PostgreSQL.
   */
  async recordResult(input: RecordResultInput): Promise<AcceptedResultReceipt> {
    const { gameId, attemptId, evidence, manifestDigest, mapDescriptor } = input;

    // 0. Idempotency guard (fast path). A game has at most one accepted result: a reclaimed
    //    lease or a duplicate job for the same game must not record a second version, so it
    //    short-circuits here before verification and before any replay object is staged.
    const alreadyAccepted = await statementRunner(input.client ?? this.db)<{ result_version_id: string; accepted_at: Date }>(
      'SELECT result_version_id, accepted_at FROM accepted_results WHERE game_id = $1',
      [gameId]
    );
    if (alreadyAccepted.rows.length > 0) {
      throw new ResultAlreadyAcceptedError(
        gameId,
        alreadyAccepted.rows[0].result_version_id,
        alreadyAccepted.rows[0].accepted_at.toISOString()
      );
    }

    // Fast-path refusal before staging replay bytes. A withdrawal, disqualification or correction
    // that already resolved this encounter has the final word over any late-claimed completion;
    // the authoritative re-check below runs again inside the write transaction's row locks, so a
    // ruling landing between the two reads still cannot be overwritten.
    const precheckRow = (
      await statementRunner(input.client ?? this.db)<{ status: string | null; encounter_status: string | null }>(
        `SELECT g.status, e.status AS encounter_status
         FROM games g LEFT JOIN encounters e ON e.id = g.encounter_id
         WHERE g.id = $1`,
        [gameId]
      )
    ).rows[0];
    if (precheckRow) {
      const precheckReason = resultRejectionReason(
        precheckRow.status,
        precheckRow.encounter_status ?? null
      );
      if (precheckReason) {
        throw new ResultRejectedError(gameId, precheckReason);
      }
    }

    if (evidence.gameId !== gameId) throw new ResultIntegrityError('EVIDENCE_GAME_ID_MISMATCH');
    // Rust is the rules authority; trace prefixes cannot certify runtime faults.
    const nativeExecution = input.nativeExecution;
    if (nativeExecution !== undefined) {
      const actionTraceDigest = createHash('sha256').update(JSON.stringify(evidence.trace)).digest('hex');
      if (!isAuthenticatedNativeExecution(nativeExecution)
        || nativeExecution.gameId !== gameId || nativeExecution.lease.attemptId !== attemptId
        || nativeExecution.manifestDigest !== manifestDigest || nativeExecution.actionTraceDigest !== actionTraceDigest) {
        throw new ResultIntegrityError('NATIVE_EXECUTION_BINDING_MISMATCH');
      }
    }
    const verification = await this.traceVerifier.verify(mapDescriptor, evidence, input.maxTurns ?? 300, nativeExecution);
    if (!verification.isValid) {
      throw new ResultIntegrityError(`Trace verification failed: ${verification.error}`);
    }
    if (verification.requiresSupervisorEvidence) {
      throw new ResultIntegrityError('SUPERVISOR_EVIDENCE_REQUIRED: a legal trace does not prove a runtime forfeit');
    }

    // 2. Serialize replay and write into immutable object store
    const replayPayload: ReplayV2Payload = {
      gameId,
      attemptId,
      mapId: mapDescriptor.mapName,
      rulesRevision: evidence.rulesRevision,
      manifestDigest,
      totalTurns: verification.verifiedTurns,
      winner: evidence.winner,
      reason: evidence.reason,
      disposition: evidence.disposition,
      trace: evidence.trace,
      map: mapDescriptor,
      nativeExecution,
    };


    // 3. Compute digests
    const actionTraceDigest = createHash('sha256')
      .update(JSON.stringify(evidence.trace))
      .digest('hex');

    // 4. Atomic PostgreSQL Transaction
    const accept = async (client: PoolClient, pinned: boolean): Promise<AcceptedResultReceipt> => {
      // A pinned completion was fenced when its evidence was pinned (`prepareCompletion`); only a
      // fresh write needs the check again. Re-asserting it at consume time would strand restored
      // pending completions, because activation removes the checkpoints of the old generation and
      // no checkpoint exists for the new one yet.
      if (!pinned) {
        await this.acceptanceFence?.(client);
        await client.query('SELECT pg_advisory_xact_lock_shared(1868657748,26)');
      }
    const replayBuffer = this.replayStore.serializeReplayV2(replayPayload);
    const stagingKey = `replays/${gameId}_${attemptId}_${Date.now()}.oantuti`;
    const staged = this.replayStore.stageReplay(stagingKey, replayBuffer);
    const storedReplay = this.replayStore.promoteStagedReplay(staged.stagingPath, staged.digest);
      const gameCheck = await client.query<{ id: string; status: string; encounter_id: string | null }>(
        'SELECT id, status, encounter_id FROM games WHERE id = $1 FOR UPDATE',
        [gameId]
      );
      if (gameCheck.rows.length === 0) {
        throw new Error(`Game not found: ${gameId}`);
      }
      // Authoritative refusal under the games row lock: the administrative ruling on this
      // game/encounter (withdrawal walkover/double-withdrawal, downstream cancellation)
      // outranks the completion attempt of a late-claimed job (claim/withdrawal race, TR-07 §124).
      const gameRow = gameCheck.rows[0];
      let encounterStatus: string | null = null;
      if (gameRow.encounter_id) {
        encounterStatus = (
          await client.query<{ status: string }>(
            'SELECT status FROM encounters WHERE id = $1',
            [gameRow.encounter_id]
          )
        ).rows[0]?.status ?? null;
      }
      const authoritativeReason = resultRejectionReason(gameRow.status, encounterStatus);
      if (authoritativeReason) {
        throw new ResultRejectedError(gameId, authoritativeReason);
      }

      // The row lock above serialises recorders for this game, so this check is authoritative
      // for the fast path's race: if another worker won, roll back instead of inserting a
      // second accepted version (throws before any write below).
      const duplicateRes = await client.query<{ result_version_id: string; accepted_at: Date }>(
        'SELECT result_version_id, accepted_at FROM accepted_results WHERE game_id = $1',
        [gameId]
      );
      if (duplicateRes.rows.length > 0) {
        throw new ResultAlreadyAcceptedError(
          gameId,
          duplicateRes.rows[0].result_version_id,
          duplicateRes.rows[0].accepted_at.toISOString()
        );
      }

      // Check current latest revision
      const revCheck = await client.query<{ max_rev: number | null }>(
        'SELECT MAX(revision) as max_rev FROM result_versions WHERE game_id = $1',
        [gameId]
      );
      const nextRevision = (revCheck.rows[0]?.max_rev ?? 0) + 1;

      // Insert replay object
      await client.query(
        `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (digest) DO UPDATE
         SET total_turns = EXCLUDED.total_turns`,
        [storedReplay.digest, storedReplay.absolutePath, storedReplay.sizeBytes, verification.verifiedTurns]
      );

      // Insert immutable result version
      const resultVerInsert = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO result_versions (
           game_id, revision, verdict, winner, reason, disposition,
           action_trace_digest, replay_digest, manifest_digest,
           cpu_usec, wall_usec, trace
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, created_at`,
        [
          gameId,
          nextRevision,
          evidence.disposition,
          evidence.winner,
          evidence.reason,
          evidence.disposition,
          actionTraceDigest,
          storedReplay.digest,
          manifestDigest,
          BigInt(evidence.cpuUsec ?? '0'),
          BigInt(evidence.wallUsec ?? '0'),
          JSON.stringify(evidence.trace),
        ]
      );
      const resultVersionId = resultVerInsert.rows[0].id;
      const acceptedAt = resultVerInsert.rows[0].created_at;

      // Upsert accepted_results pointer
      await client.query(
        `INSERT INTO accepted_results (game_id, result_version_id, accepted_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (game_id) DO UPDATE
         SET result_version_id = EXCLUDED.result_version_id,
             accepted_at = EXCLUDED.accepted_at`,
        [gameId, resultVersionId, acceptedAt]
      );

      // Update game status to COMPLETED
      await client.query(
        `UPDATE games SET status = 'COMPLETED' WHERE id = $1`,
        [gameId]
      );

      // Insert outbox event for tournament progression / standings
      await client.query(
        `INSERT INTO outbox_events (topic, payload)
         VALUES ($1, $2)`,
        [
          'GAME_RESULT_ACCEPTED',
          JSON.stringify({
            gameId,
            resultVersionId,
            revision: nextRevision,
            winner: evidence.winner,
            reason: evidence.reason,
            disposition: evidence.disposition,
            totalTurns: verification.verifiedTurns,
            replayDigest: storedReplay.digest,
            acceptedAt,
          }),
        ]
      );

      return {
        receiptId: randomUUID(),
        timestamp: acceptedAt,
        data: {
          gameId,
          resultVersionId,
          state: 'ACCEPTED' as const,
          acceptedAt,
        },
      };
    };
    const receipt = input.client
      ? await accept(input.client, true)
      : await this.db.withTransaction((client) => accept(client, false));

    if (this.onGameAccepted && !input.client) {
      await this.onGameAccepted(gameId);
    }

    return receipt;
  }

  /**
   * Retrieves the currently accepted result for a game.
   */
  async getAcceptedResult(gameId: string): Promise<GameResultDto | null> {
    const res = await this.db.query<{
      game_id: string;
      result_version_id: string;
      revision: number;
      winner: number;
      reason: string;
      disposition: string;
      total_turns: number;
      action_trace_digest: string;
      replay_digest: string;
      manifest_digest: string;
      accepted_at: string;
    }>(
      `SELECT ar.game_id, ar.result_version_id, rv.revision, rv.winner, rv.reason,
              rv.disposition, ro.total_turns, rv.action_trace_digest, rv.replay_digest,
              rv.manifest_digest, ar.accepted_at
       FROM accepted_results ar
       JOIN result_versions rv ON ar.result_version_id = rv.id
       JOIN replay_objects ro ON rv.replay_digest = ro.digest
       WHERE ar.game_id = $1`,
      [gameId]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    return {
      gameId: row.game_id,
      resultVersionId: row.result_version_id,
      revision: row.revision,
      winner: row.winner,
      reason: row.reason,
      disposition: row.disposition,
      totalTurns: row.total_turns,
      actionTraceDigest: row.action_trace_digest,
      replayDigest: row.replay_digest,
      manifestDigest: row.manifest_digest,
      acceptedAt: row.accepted_at,
    };
  }

  /**
   * The accepted result of a game plus the completion evidence derived from it.
   *
   * The executor uses this both to detect an already-complete game before running a match
   * again and to pin the job completion with the digests the verifier already accepted.
   */
  async getAcceptedResultSummary(gameId: string, client?: PoolClient): Promise<AcceptedResultSummary | null> {
    const res = await statementRunner(client ?? this.db)<{
      id: string;
      revision: number;
      verdict: string;
      winner: number | null;
      reason: string;
      action_trace_digest: string;
      replay_digest: string;
      manifest_digest: string;
      cpu_usec: string;
      wall_usec: string;
    }>(
      `SELECT rv.id, rv.revision, rv.verdict, rv.winner, rv.reason,
              rv.action_trace_digest, rv.replay_digest, rv.manifest_digest,
              rv.cpu_usec::text AS cpu_usec, rv.wall_usec::text AS wall_usec
       FROM accepted_results ar
       JOIN result_versions rv ON rv.id = ar.result_version_id
       WHERE ar.game_id = $1`,
      [gameId]
    );
    const row = res.rows[0];
    if (!row) return null;

    return {
      resultVersionId: row.id,
      revision: row.revision,
      evidence: {
        // result_versions.verdict is CHECK-constrained to these three values.
        verdict: row.verdict as ResultEvidence['verdict'],
        winner: row.winner ?? 0,
        reason: row.reason,
        actionTraceDigest: row.action_trace_digest,
        replayDigest: row.replay_digest,
        manifestDigest: row.manifest_digest,
        cpuUsec: row.cpu_usec,
        wallUsec: row.wall_usec,
        details: { gameId, accepted: true, resultVersionId: row.id, revision: row.revision },
      },
    };
  }

  /**
   * Retrieves replay binary bytes by digest for the ADMIN-only official replay routes.
   *
   * Only replays referenced by an official result version are served. Private TEST replays live in
   * the same object store but never become result versions, and 01-PRODUCT-REQUIREMENTS §113 makes
   * them team-only through every transport — so a digest alone must not unlock one.
   */
  async getReplay(digest: Digest): Promise<Buffer> {
    const official = await this.db.query<{ one: number }>(
      'SELECT 1 AS one FROM result_versions WHERE replay_digest = $1 LIMIT 1',
      [digest]
    );
    if (official.rows.length === 0) {
      throw new ResultIntegrityError(`Replay not available: ${digest}`);
    }
    return this.replayStore.readReplay(digest);
  }
}
