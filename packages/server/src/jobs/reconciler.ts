import type { Database } from '../persistence/db.js';
import type { ReconcilerIdentity } from '@oantuti/protocol';

export interface ReconcileReport {
  readonly expiredLeasesReclaimed: number;
  readonly blockedJobsCount: number;
  readonly orphanedCompletionsAccepted: number;
}

export class JobReconciler {
  constructor(
    private readonly db: Database,
    private readonly currentDeploymentGeneration = 1
  ) {}

  async reconcile(reconciler: ReconcilerIdentity): Promise<ReconcileReport> {
    return this.db.withTransaction(async (client) => {
      // 1. Reclaim expired leased/running jobs whose attempts have expired
      // Backoff strategy: attempt 1 -> 5s backoff, attempt 2 -> 15s backoff, attempt 3 -> BLOCKED
      const expiredJobsRes = await client.query<{
        job_id: string;
        attempt_id: string;
        attempt_count: number;
        max_attempts: number;
      }>(
        `SELECT j.id AS job_id, ja.id AS attempt_id, j.attempt_count, j.max_attempts
         FROM jobs j
         JOIN job_attempts ja ON ja.id = j.active_lease_id
         WHERE j.state IN ('LEASED', 'RUNNING')
           AND ja.state = 'ACTIVE'
           AND ja.lease_expires_at <= clock_timestamp()
         FOR UPDATE OF j SKIP LOCKED`
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

      // 2. Promote orphaned COMPLETION_PENDING records that have durable evidence
      const orphanedRes = await client.query<{
        id: string;
        job_id: string;
        attempt_id: string;
        evidence_digest: string;
      }>(
        `SELECT c.id, c.job_id, c.attempt_id, c.evidence_digest
         FROM job_completions c
         JOIN jobs j ON j.id = c.job_id
         WHERE c.state = 'PENDING'
           AND j.state = 'COMPLETION_PENDING'
           AND c.deployment_generation = $1
         FOR UPDATE OF c SKIP LOCKED`,
        [this.currentDeploymentGeneration]
      );

      let orphanedCompletionsAccepted = 0;
      for (const comp of orphanedRes.rows) {
        await client.query(
          `UPDATE job_completions
           SET state = 'ACCEPTED', accepted_at = clock_timestamp()
           WHERE id = $1`,
          [comp.id]
        );
        await client.query(
          `UPDATE jobs
           SET state = 'SUCCEEDED', updated_at = clock_timestamp()
           WHERE id = $1`,
          [comp.job_id]
        );
        await client.query(
          `UPDATE job_attempts
           SET state = 'COMPLETED', evidence_digest = $1
           WHERE id = $2`,
          [comp.evidence_digest, comp.attempt_id]
        );
        orphanedCompletionsAccepted++;
      }

      return {
        expiredLeasesReclaimed,
        blockedJobsCount,
        orphanedCompletionsAccepted,
      };
    });
  }
}
