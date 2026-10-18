import { createHash, randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { AcceptedResultReceipt, Digest, GameResultDto, GameResultEvidence } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import { ReplayStore, type ReplayV2Payload } from './replay-store.js';
import { TraceVerifier } from './trace-verifier.js';

export class ResultIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultIntegrityError';
  }
}

export interface RecordResultInput {
  readonly gameId: string;
  readonly attemptId: string;
  readonly evidence: GameResultEvidence;
  readonly manifestDigest: Digest;
  readonly mapDescriptor: MapDescriptor;
}

export class ResultService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly replayStore: ReplayStore,
    private readonly traceVerifier: TraceVerifier = new TraceVerifier(),
    private readonly onGameAccepted?: (gameId: string) => Promise<void>
  ) {}

  /**
   * Accepts and records a game result with full cryptographic and game engine trace verification.
   * Performs an atomic durable commit in PostgreSQL.
   */
  async recordResult(input: RecordResultInput): Promise<AcceptedResultReceipt> {
    const { gameId, attemptId, evidence, manifestDigest, mapDescriptor } = input;

    // 1. Verify action trace against game rules
    const verification = this.traceVerifier.verify(mapDescriptor, evidence);
    if (!verification.isValid) {
      throw new ResultIntegrityError(`Trace verification failed: ${verification.error}`);
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
    };

    const replayBuffer = this.replayStore.serializeReplayV2(replayPayload);
    const stagingKey = `replays/${gameId}_${attemptId}_${Date.now()}.oantuti`;
    const staged = this.replayStore.stageReplay(stagingKey, replayBuffer);
    const storedReplay = this.replayStore.promoteStagedReplay(staged.stagingPath, staged.digest);

    // 3. Compute digests
    const actionTraceDigest = createHash('sha256')
      .update(JSON.stringify(evidence.trace))
      .digest('hex');

    // 4. Atomic PostgreSQL Transaction
    const receipt = await this.db.withTransaction(async (client) => {
      const gameCheck = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM games WHERE id = $1 FOR UPDATE',
        [gameId]
      );
      if (gameCheck.rows.length === 0) {
        throw new Error(`Game not found: ${gameId}`);
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
    });

    if (this.onGameAccepted) {
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
   * Retrieves replay binary bytes by digest.
   */
  async getReplay(digest: Digest): Promise<Buffer> {
    return this.replayStore.readReplay(digest);
  }
}
