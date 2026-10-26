import type { PostgresDatabase } from '../persistence/db.js';
import type { JobBroker } from '../jobs/broker.js';
import type { JobReconciler } from '../jobs/reconciler.js';
import { PROCESS_RECONCILER_IDENTITY } from '../jobs/identity.js';
import { enqueueMissingGameJobs } from '../jobs/game-jobs.js';
import type { TournamentSchedulerService } from './scheduler-service.js';
import type { RetentionService } from '../operations/retention-service.js';
import { sweepCompletionCapsules } from '../operations/completion-capsules.js';
import type { GlobalTeamRatingService } from '../ratings/service.js';

/** Periodic durable duties are independent of where untrusted code executes. */
export class TournamentControlPlane {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastRetentionAt = 0;
  private activeTick?: Promise<void>;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly broker: JobBroker,
    private readonly reconciler: JobReconciler,
    private readonly scheduler: TournamentSchedulerService,
    private readonly retention: RetentionService,
    private readonly intervalMs = 5_000,
    private readonly retentionIntervalMs = 60 * 60 * 1_000,
    /** Native completion capsules; absent when this deployment runs no native gateway. */
    private readonly completionCapsulesDir?: string,
    private readonly ratingService?: GlobalTeamRatingService,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || !Number.isSafeInteger(retentionIntervalMs) || retentionIntervalMs < 1) {
      throw new Error('Control-plane intervals must be positive integers');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scheduleTick(), this.intervalMs);
    this.timer.unref();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  /** Cap of failed delivery attempts for one result outbox event (payload-stamped, restart-proof). */
  private static readonly RESULT_OUTBOX_MAX_ATTEMPTS = 5;

  private scheduleTick(): void {
    if (this.activeTick) return;
    const active = this.tick();
    this.activeTick = active;
    void active.finally(() => { if (this.activeTick === active) this.activeTick = undefined; });
  }

  /**
   * Delivers one unplayed result event per game, then marks it, in that order — one failing
   * event must never stall the next (a deterministic failure would otherwise re-fail the same
   * oldest row every tick and block round advancement, sealing and job enqueueing platform-wide).
   *
   * Each failure stamps an attempt counter into the payload, so the retry budget is durable
   * without a schema change; after `RESULT_OUTBOX_MAX_ATTEMPTS` failures (or a malformed
   * payload, which can never succeed) the event is delivered with a loud warning so the
   * pipeline keeps advancing. A pending event whose attempt failed transiently stays
   * undelivered and is retried on the next tick, ordered after the ones that advance now.
   */
  private async deliverResultOutbox(): Promise<void> {
    const pending = await this.db.query<{ id: string; topic: string; payload: { gameId?: unknown; deliveryFailures?: unknown; lastDeliveryError?: unknown } }>(
      `SELECT id, topic, payload FROM outbox_events WHERE delivered_at IS NULL
       AND topic IN ('GAME_RESULT_ACCEPTED', 'RESULT_CORRECTED') ORDER BY created_at, id LIMIT 100`
    );
    for (const event of pending.rows) {
      const gameId = event.payload?.gameId;
      if (typeof gameId !== 'string') {
        // Malformed payload: never deliverable, so release the pipeline and keep the marker on the row.
        console.warn(`[control-plane:result-outbox] ${event.id} (${event.topic}) has no gameId payload; marking delivered`);
        await this.db.query(
          `UPDATE outbox_events
              SET delivered_at = clock_timestamp(),
                  payload = payload || $2::jsonb
            WHERE id = $1 AND delivered_at IS NULL`,
          [event.id, JSON.stringify({ deliveryFailures: -1, lastDeliveryError: 'MALFORMED_PAYLOAD' })]
        );
        continue;
      }
      try {
        await this.scheduler.handleGameCompletion(gameId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const previous = Number(event.payload?.deliveryFailures ?? 0) || 0;
        const failures = previous + 1;
        const capped = failures >= TournamentControlPlane.RESULT_OUTBOX_MAX_ATTEMPTS;
        console.warn(
          `[control-plane:result-outbox] ${event.id} (${event.topic}, game ${gameId}) delivery attempt ` +
          `${failures}/${TournamentControlPlane.RESULT_OUTBOX_MAX_ATTEMPTS} failed${capped ? '; giving up' : ''}: ${message}`
        );
        if (capped) {
          await this.db.query(
            `UPDATE outbox_events
                SET delivered_at = clock_timestamp(),
                    payload = payload || $2::jsonb
              WHERE id = $1 AND delivered_at IS NULL`,
            [event.id, JSON.stringify({ deliveryFailures: failures, lastDeliveryError: message })]
          );
        } else {
          await this.db.query(
            `UPDATE outbox_events
                SET payload = payload || $2::jsonb
              WHERE id = $1 AND delivered_at IS NULL`,
            [event.id, JSON.stringify({ deliveryFailures: failures, lastDeliveryError: message })]
          );
        }
        continue;
      }
      await this.db.query(
        'UPDATE outbox_events SET delivered_at = clock_timestamp() WHERE id = $1 AND delivered_at IS NULL',
        [event.id]
      );
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const perform = async (name: string, operation: () => Promise<unknown>) => {
      try { await operation(); }
      catch (error: unknown) { console.warn(`[control-plane:${name}] ${error instanceof Error ? error.message : String(error)}`); }
    };
    try {
      await perform('reconcile', () => this.reconciler.reconcile(PROCESS_RECONCILER_IDENTITY));
      await perform('deadlines', () => this.db.withTransaction(async (client) => {
        const closed = await client.query<{ id: string }>(
          `UPDATE tournaments SET state = 'VALIDATING_SUBMISSIONS', version = version + 1, updated_at = clock_timestamp()
           WHERE state = 'REGISTRATION_OPEN' AND registration_closes_at <= clock_timestamp() RETURNING id`
        );
        for (const row of closed.rows) {
          for (const topic of ['REGISTRATION_CLOSED', 'TOURNAMENT_DRAINING']) {
            await client.query('INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)',
              [topic, JSON.stringify({ tournamentId: row.id, reason: 'REGISTRATION_DEADLINE' })]);
          }
        }
      }));
      await perform('result-outbox', () => this.deliverResultOutbox());
      await perform('seal', () => this.scheduler.sealEligibleRounds());
      await perform('enqueue', () => enqueueMissingGameJobs(this.db, this.broker, { limit: 1_000 }));
      this.ratingService?.kickRebuild();
      if (Date.now() - this.lastRetentionAt >= this.retentionIntervalMs) {
        await perform('retention', async () => {
          await this.retention.sweepAsSystem(false);
          if (this.completionCapsulesDir) {
            // Accepted completions stop needing their recovery capsule; the backup contract still
            // inventories the root, so stale capsules and unreferenced objects are reclaimed here.
            const pending = await this.db.query<{ digest: string | null }>(
              `SELECT DISTINCT evidence_payload->'native'->>'capsuleDigest' AS digest
                 FROM job_completions WHERE state = 'PENDING'`
            );
            const keep = new Set(pending.rows.map((row) => row.digest).filter((digest): digest is string => typeof digest === 'string'));
            const swept = sweepCompletionCapsules(this.completionCapsulesDir, keep);
            if (swept.capsules > 0 || swept.objects > 0) {
              console.warn(`[control-plane:retention] reclaimed ${swept.capsules} completion capsule(s) and ${swept.objects} object(s)`);
            }
          }
          this.lastRetentionAt = Date.now();
        });
      }
    } finally { this.running = false; }
  }
}
