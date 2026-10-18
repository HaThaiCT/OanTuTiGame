import { createHash, randomUUID } from 'node:crypto';
import type { CommandContext, Digest, Receipt } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';

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

export interface CorrectionImpactDto {
  readonly gameId: string;
  readonly encounterId: string;
  readonly roundOrdinal: number;
  readonly currentRevision: number;
  readonly action: 'VOID' | 'REJUDGE';
  readonly previewDigest: Digest;
  readonly description: string;
}

export type CorrectionReceipt = Receipt<{
  readonly gameId: string;
  readonly newRevision: number;
  readonly impactDigest: Digest;
  readonly appliedAt: string;
}>;

export class CorrectionService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly onCorrectionApplied?: (gameId: string) => Promise<void>
  ) {}

  /**
   * Generates a preview of the correction impact and computes the cryptographic previewDigest.
   */
  async previewCorrection(
    gameId: string,
    command: CorrectionCommand,
    ctx: CommandContext
  ): Promise<CorrectionImpactDto> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new CorrectionError(403, 'Only administrators can preview result corrections');
    }

    const gameRes = await this.db.query<{
      id: string;
      encounter_id: string;
      status: string;
      current_rev: number | null;
      round_ordinal: number;
    }>(
      `SELECT g.id, g.encounter_id, g.status, rv.revision as current_rev, e.round_ordinal
       FROM games g
       JOIN encounters e ON g.encounter_id = e.id
       LEFT JOIN accepted_results ar ON g.id = ar.game_id
       LEFT JOIN result_versions rv ON ar.result_version_id = rv.id
       WHERE g.id = $1`,
      [gameId]
    );

    if (gameRes.rows.length === 0) {
      throw new CorrectionError(404, `Game not found: ${gameId}`);
    }

    const game = gameRes.rows[0];
    if (game.status !== 'COMPLETED' || !game.current_rev) {
      throw new CorrectionError(400, 'Cannot correct a game that has no accepted result');
    }

    if (game.current_rev !== command.expectedRevision) {
      throw new CorrectionError(
        409,
        `Revision mismatch: expected ${command.expectedRevision}, current is ${game.current_rev}`
      );
    }

    const impact = {
      gameId,
      encounterId: game.encounter_id,
      roundOrdinal: game.round_ordinal,
      currentRevision: game.current_rev,
      action: command.action,
      reason: command.reason,
    };

    const previewDigest = createHash('sha256')
      .update(JSON.stringify(impact))
      .digest('hex');

    return {
      gameId,
      encounterId: game.encounter_id,
      roundOrdinal: game.round_ordinal,
      currentRevision: game.current_rev,
      action: command.action,
      previewDigest,
      description: `Action ${command.action} on game ${gameId} will supersede revision ${game.current_rev} with reason: ${command.reason}`,
    };
  }

  /**
   * Applies the previewed correction atomically and triggers encounter rescoring.
   */
  async applyCorrection(
    gameId: string,
    command: CorrectionCommand,
    previewDigest: string,
    ctx: CommandContext
  ): Promise<CorrectionReceipt> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new CorrectionError(403, 'Only administrators can apply result corrections');
    }

    // Verify preview digest matches recomputed preview
    const preview = await this.previewCorrection(gameId, command, ctx);
    if (preview.previewDigest !== previewDigest) {
      throw new CorrectionError(409, 'PREVIEW_DIGEST_MISMATCH: Stale or invalid preview digest');
    }

    const receipt = await this.db.withTransaction(async (client) => {
      // Fetch latest accepted result version details
      const curRes = await client.query<{
        result_version_id: string;
        revision: number;
        replay_digest: string;
        manifest_digest: string;
        action_trace_digest: string;
      }>(
        `SELECT ar.result_version_id, rv.revision, rv.replay_digest, rv.manifest_digest, rv.action_trace_digest
         FROM accepted_results ar
         JOIN result_versions rv ON ar.result_version_id = rv.id
         WHERE ar.game_id = $1
         FOR UPDATE`,
        [gameId]
      );

      const cur = curRes.rows[0];
      const nextRevision = cur.revision + 1;

      // 1. Insert new result version (NO_CONTEST / VOID)
      const newVerRes = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO result_versions (
           game_id, revision, verdict, winner, reason, disposition,
           action_trace_digest, replay_digest, manifest_digest
         ) VALUES ($1, $2, 'NO_CONTEST', 0, $3, 'NO_CONTEST', $4, $5, $6)
         RETURNING id, created_at`,
        [
          gameId,
          nextRevision,
          `CORRECTION_VOID: ${command.reason}`,
          cur.action_trace_digest,
          cur.replay_digest,
          cur.manifest_digest,
        ]
      );
      const newVerId = newVerRes.rows[0].id;
      const appliedAt = newVerRes.rows[0].created_at;

      // 2. Update accepted_results pointer
      await client.query(
        `UPDATE accepted_results
         SET result_version_id = $1,
             accepted_at = $2
         WHERE game_id = $3`,
        [newVerId, appliedAt, gameId]
      );

      // 3. Record in result_corrections ledger
      await client.query(
        `INSERT INTO result_corrections (
           game_id, from_result_version_id, to_result_version_id,
           action, reason, authorized_by_user_id, preview_digest, impact_summary
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          gameId,
          cur.result_version_id,
          newVerId,
          command.action,
          command.reason,
          ctx.actor.userId,
          previewDigest,
          JSON.stringify(preview),
        ]
      );

      // 4. Emit outbox event
      await client.query(
        `INSERT INTO outbox_events (topic, payload)
         VALUES ($1, $2)`,
        [
          'RESULT_CORRECTED',
          JSON.stringify({
            gameId,
            fromRevision: cur.revision,
            toRevision: nextRevision,
            action: command.action,
            reason: command.reason,
            authorizedByUserId: ctx.actor.userId,
            appliedAt,
          }),
        ]
      );

      return {
        receiptId: randomUUID(),
        timestamp: appliedAt,
        data: {
          gameId,
          newRevision: nextRevision,
          impactDigest: previewDigest,
          appliedAt,
        },
      };
    });

    // Notify scheduler to re-evaluate encounter score with corrected game result
    if (this.onCorrectionApplied) {
      await this.onCorrectionApplied(gameId);
    }

    return receipt;
  }
}
