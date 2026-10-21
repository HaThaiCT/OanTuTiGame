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

  private scheduleTick(): void {
    if (this.activeTick) return;
    const active = this.tick();
    this.activeTick = active;
    void active.finally(() => { if (this.activeTick === active) this.activeTick = undefined; });
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
      await perform('result-outbox', async () => {
        const pending = await this.db.query<{ id: string; payload: { gameId?: unknown } }>(
          `SELECT id, payload FROM outbox_events WHERE delivered_at IS NULL
           AND topic IN ('GAME_RESULT_ACCEPTED', 'RESULT_CORRECTED') ORDER BY created_at, id LIMIT 100`
        );
        for (const event of pending.rows) {
          if (typeof event.payload.gameId !== 'string') throw new Error(`Invalid result outbox event ${event.id}`);
          await this.scheduler.handleGameCompletion(event.payload.gameId);
          await this.db.query('UPDATE outbox_events SET delivered_at = clock_timestamp() WHERE id = $1 AND delivered_at IS NULL', [event.id]);
        }
      });
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
