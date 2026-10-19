import type { Database } from '../persistence/db.js';
import type { ReconcilerIdentity } from '@oantuti/protocol';
import { failPrivateTestSnapshotExhausted } from '../builds/private-test-result-service.js';
import { JobBroker } from './broker.js';

export interface ReconcileReport {
  readonly expiredLeasesReclaimed: number;
  readonly blockedJobsCount: number;
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

      return { expiredLeasesReclaimed, blockedJobsCount, orphanedCompletionsAccepted: 0 };
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
}
