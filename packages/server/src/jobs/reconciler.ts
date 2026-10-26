import type { Database } from '../persistence/db.js';
import type { PoolClient } from 'pg';
import type { ReconcilerIdentity } from '@oantuti/protocol';
import { failPrivateTestSnapshotExhausted } from '../builds/private-test-result-service.js';
import { BUILD_JOB_PRIORITY, PENDING_SUBMISSION_STATUSES, PENDING_TEST_STATUSES } from '../submissions/service.js';
import { JobBroker } from './broker.js';

export interface ReconcileReport {
  readonly expiredLeasesReclaimed: number;
  readonly blockedJobsCount: number;
  /** BUILD/TEST_BUILD jobs inserted by the orphan sweep for rows no job ever pointed at. */
  readonly orphanBuildJobsInserted: number;
  readonly orphanedCompletionsAccepted: number;
}

export class JobReconciler {
  constructor(
    private readonly db: Database,
    private readonly currentDeploymentGeneration = 1,
    private readonly broker: JobBroker = new JobBroker(db, currentDeploymentGeneration)
  ) {}

  async reconcile(reconciler: ReconcilerIdentity): Promise<ReconcileReport> {
    const report = await this.db.withTransaction(async (client) => {
      // 1. Reclaim expired leased/running jobs whose attempts have expired
      // Backoff strategy: attempt 1 -> 5s backoff, attempt 2 -> 15s backoff, attempt 3 -> BLOCKED
      const expiredJobsRes = await client.query<{
        job_id: string;
        attempt_id: string;
        job_type: string;
        target_id: string;
        attempt_count: number;
        max_attempts: number;
      }>(
        `SELECT j.id AS job_id, ja.id AS attempt_id, j.job_type, j.target_id::text AS target_id,
                j.attempt_count, j.max_attempts
         FROM jobs j
         JOIN job_attempts ja ON ja.id = j.active_lease_id
         WHERE j.state IN ('LEASED', 'RUNNING')
           AND j.deployment_generation = $1
           AND ja.state = 'ACTIVE'
           AND ja.lease_expires_at <= clock_timestamp()
         FOR UPDATE OF j SKIP LOCKED`,
        [this.currentDeploymentGeneration]
      );

      let expiredLeasesReclaimed = 0;
      let blockedJobsCount = 0;

      for (const row of expiredJobsRes.rows) {
        // Mark current attempt EXPIRED
        await client.query(
          `UPDATE job_attempts
           SET state = 'EXPIRED', error_details = 'LEASE_TIMEOUT'
           WHERE id = $1`,
          [row.attempt_id]
        );

        if (row.attempt_count >= row.max_attempts) {
          // Exceeded max attempts: transition to BLOCKED
          await client.query(
            `UPDATE jobs
             SET state = 'BLOCKED',
                 active_lease_id = NULL,
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [row.job_id]
          );
          // A private test whose job is out of attempts will never run, so its snapshot must not
          // stay RUNNING (or stay runnable) forever. The cause is infrastructure, not a verdict on
          // the student's bot; a snapshot that already carries a result keeps it.
          if (row.job_type === 'TEST_GAME') {
            await failPrivateTestSnapshotExhausted(client, row.target_id);
          }
          blockedJobsCount++;
        } else {
          // Exponential backoff: attempt 1 -> 5s, attempt 2 -> 15s
          const backoffSeconds = row.attempt_count === 1 ? 5 : 15;
          await client.query(
            `UPDATE jobs
             SET state = 'RETRY_WAIT',
                 active_lease_id = NULL,
                 available_at = clock_timestamp() + ($1 || ' seconds')::interval,
                 updated_at = clock_timestamp()
             WHERE id = $2`,
            [backoffSeconds, row.job_id]
          );
          expiredLeasesReclaimed++;
        }
      }

      // 2. Requeue build work stranded before its job could exist. A receipt commits its row in
      // one transaction and enqueues its BUILD/TEST_BUILD job right after; a crash between the
      // two leaves a receipt that is committed, consumes its team's pending quota, blocks
      // lifecycle `lock()` drains (that wait never resolves), yet has no job at any state —
      // step 1 only requeues jobs that exist. Rows still covered by a real job are untouched
      // here even when that job is BLOCKED: the lease/backoff policy above owns those.
      const orphanBuildJobsInserted = await this.requeueStrandedBuilds(client);

      return { expiredLeasesReclaimed, blockedJobsCount, orphanBuildJobsInserted, orphanedCompletionsAccepted: 0 };
    });
    const pending = await this.db.query<{ id: string; evidence_digest: string; deployment_generation: number }>(`SELECT id,evidence_digest,deployment_generation FROM job_completions WHERE state='PENDING' AND (deployment_generation=$1 OR restore_recovery) ORDER BY created_at`, [this.currentDeploymentGeneration]);
    let accepted = 0;
    for (const completion of pending.rows) {
      try {
        await this.broker.complete({ completionId: completion.id, evidenceDigest: completion.evidence_digest, deploymentGeneration: completion.deployment_generation }, reconciler);
        accepted++;
      } catch (error) {
        // Invalid/missing objects and unavailable consumers remain pending, never successful.
        // Other completions must still drain; the next pass retries transient faults. A completion
        // that can never be consumed must not be invisible to the operator, so the reason is logged
        // with its identity instead of being swallowed.
        console.warn(`[reconciler] completion ${completion.id} stayed pending: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...report, orphanedCompletionsAccepted: accepted };
  }

  /**
   * Inserts the missing BUILD/TEST_BUILD job for every non-terminal receipt/snapshot that has no
   * job row of its own type at all. Finalized rows (READY/REJECTED, COMPLETED/FAILED) and a
   * snapshot already executing its test (`RUNNING`) need no future build; anything carrying a
   * real job — QUEUED, leased, blocked, retried — is left to the claim path and step 1, so the
   * sweep can only ever file exactly the one job a stranded receipt was promised.
   */
  private async requeueStrandedBuilds(client: PoolClient): Promise<number> {
    // The look-then-insert is racy across processes, and `jobs` has no unique key on
    // `(job_type, target_id)` to lean on: a database-scoped advisory lock (like the migration
    // applier's) serializes sweeps instead, and the transaction spans the whole reconcile pass.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':oantuti-orphan-build-sweep', 0))");

    const runnableSnapshotStatuses = PENDING_TEST_STATUSES.filter((status) => status !== 'RUNNING');
    const inserted = await client.query<{ job_type: string; target_id: string }>(
      `INSERT INTO jobs (job_type, target_id, priority, state, deployment_generation, payload)
       SELECT stranded.kind,
              stranded.id,
              $3,
              'QUEUED',
              $4,
              jsonb_build_object('tournamentId', stranded.tournament_id, 'teamId', stranded.team_id)
       FROM (
         SELECT 'BUILD'::text AS kind, s.id, s.tournament_id, s.team_id
         FROM submissions s
         WHERE s.status = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.job_type = 'BUILD' AND j.target_id = s.id)
         UNION ALL
         SELECT 'TEST_BUILD'::text AS kind, n.id, n.tournament_id, n.team_id
         FROM test_snapshots n
         WHERE n.status = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.job_type = 'TEST_BUILD' AND j.target_id = n.id)
       ) AS stranded(kind, id, tournament_id, team_id)`,
      [[...PENDING_SUBMISSION_STATUSES], [...runnableSnapshotStatuses], BUILD_JOB_PRIORITY, this.currentDeploymentGeneration]
    );
    return inserted.rowCount ?? inserted.rows.length;
  }
}
