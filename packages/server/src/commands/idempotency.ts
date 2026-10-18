import { createHash } from 'node:crypto';
import type { CommandContext } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';

export class IdempotencyError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export interface IdempotentReceiptRow<T> {
  readonly id: string;
  readonly status: string;
  readonly payload_digest: string | null;
  readonly receipt: T | null;
}

/**
 * Runs a mutation at most once per (actor, scope, idempotency key) (03-ARCHITECTURE §166).
 *
 * - The first call claims the key, runs the mutation and stores the canonical receipt.
 * - A retry with the same key and the same payload digest gets that receipt back instead of repeating
 *   the effect, which is what makes a double click or a lost ack harmless.
 * - The same key with a different payload digest is a conflict: the caller reused a key for another
 *   request, and guessing which one they meant would be worse than failing.
 * - A retry that arrives while the original is still running gets `IDEMPOTENT_IN_FLIGHT` so the client
 *   retries instead of racing the first request.
 *
 * `payload` must contain the *semantic* inputs of the command (never the volatile request id).
 */
export async function runIdempotent<T>(
  db: PostgresDatabase,
  ctx: CommandContext,
  scope: string,
  payload: unknown,
  run: () => Promise<T>
): Promise<T> {
  const key = ctx.idempotencyKey?.trim();
  if (!key) return run();
  if (key.length < 16 || key.length > 128) {
    throw new IdempotencyError(400, 'IDEMPOTENCY_KEY_INVALID: the key must be 16–128 characters');
  }

  const digest = createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
  const claim = await db.query<IdempotentReceiptRow<T>>(
    `INSERT INTO command_receipts (actor_user_id, scope, idempotency_key, payload_digest)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (actor_user_id, scope, idempotency_key) DO NOTHING
     RETURNING id, status, payload_digest, receipt`,
    [ctx.actor.userId, scope, key, digest]
  );

  if (claim.rows.length === 0) {
    const existing = await db.query<IdempotentReceiptRow<T>>(
      `SELECT id, status, payload_digest, receipt FROM command_receipts
        WHERE actor_user_id = $1 AND scope = $2 AND idempotency_key = $3`,
      [ctx.actor.userId, scope, key]
    );
    const row = existing.rows[0];
    if (!row) {
      // The winner rolled back and the row vanished between the two statements.
      throw new IdempotencyError(409, 'IDEMPOTENCY_CONFLICT: the key was released; retry the request');
    }
    if (row.payload_digest !== digest) {
      throw new IdempotencyError(409, 'IDEMPOTENCY_CONFLICT: the key was already used for a different payload');
    }
    if (row.status === 'DONE' && row.receipt !== null) {
      return row.receipt;
    }
    throw new IdempotencyError(409, 'IDEMPOTENT_IN_FLIGHT: the original request is still running');
  }

  const result = await run();
  await db.query(
    `UPDATE command_receipts SET status = 'DONE', receipt = $2, updated_at = clock_timestamp() WHERE id = $1`,
    [claim.rows[0].id, JSON.stringify(result)]
  );
  return result;
}
