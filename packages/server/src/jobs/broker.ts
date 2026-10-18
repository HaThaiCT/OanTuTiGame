import { createHash } from 'node:crypto';
import type { Database } from '../persistence/db.js';
import type {
  CompletionReceipt,
  Digest,
  JobLease,
  JobType,
  LeaseIdentity,
  LeaseStatus,
  PinnedCompletion,
  ReconcilerIdentity,
  ResultEvidence,
  ResultReceipt,
  SlotOffer,
  UUID,
  WorkerIdentity,
} from '@oantuti/protocol';

export const LEASE_TTL_SECONDS = 30;

export class JobBrokerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'JobBrokerError';
  }
}

interface JobRow {
  readonly id: string;
  readonly job_type: JobType;
  readonly target_id: string;
  readonly priority: number;
  readonly state: string;
  readonly fencing_token: string;
  readonly deployment_generation: number;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly active_lease_id: string | null;
  readonly available_at: Date;
  readonly payload: unknown;
}

interface AttemptRow {
  readonly id: string;
  readonly job_id: string;
  readonly ordinal: number;
  readonly fencing_token: string;
  readonly grant_id: string;
  readonly worker_id: string;
  readonly lease_expires_at: Date;
  readonly state: string;
}

interface CompletionRow {
  readonly id: string;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fencing_token: string;
  readonly deployment_generation: number;
  readonly evidence_digest: string;
  readonly evidence_payload: unknown;
  readonly state: string;
  readonly created_at: Date;
  readonly accepted_at: Date | null;
}

export class JobBroker {
  constructor(
    private readonly db: Database,
    private readonly currentDeploymentGeneration = 1
  ) {}

  async enqueue(
    jobType: JobType,
    targetId: UUID,
    priority = 100,
    payload: unknown = {}
  ): Promise<UUID> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO jobs (job_type, target_id, priority, state, deployment_generation, payload)
       VALUES ($1, $2, $3, 'QUEUED', $4, $5)
       RETURNING id`,
      [jobType, targetId, priority, this.currentDeploymentGeneration, JSON.stringify(payload)]
    );
    return res.rows[0].id;
  }

  async claim(worker: WorkerIdentity, capacity: SlotOffer): Promise<JobLease | null> {
    if (capacity.buildSlots <= 0 && capacity.gameSlots <= 0) {
      return null;
    }

    const allowedTypes: JobType[] = [];
    if (capacity.buildSlots > 0) {
      allowedTypes.push('BUILD', 'TEST_BUILD');
    }
    if (capacity.gameSlots > 0) {
      allowedTypes.push('GAME', 'TEST_GAME');
    }

    return this.db.withTransaction(async (client) => {
      // High-concurrency skip locked selection ordered by priority and queue age
      const jobRes = await client.query<JobRow>(
        `SELECT id, job_type, target_id, priority, state, fencing_token::text,
                deployment_generation, attempt_count, max_attempts, payload
         FROM jobs
         WHERE state IN ('QUEUED', 'RETRY_WAIT')
           AND available_at <= clock_timestamp()
           AND job_type = ANY($1::text[])
         ORDER BY priority DESC, available_at ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [allowedTypes]
      );

      const job = jobRes.rows[0];
      if (!job) {
        return null;
      }

      const nextOrdinal = job.attempt_count + 1;
      const nextFence = BigInt(job.fencing_token) + 1n;

      // Create new job_attempt with 30-second lease
      const attemptRes = await client.query<AttemptRow>(
        `INSERT INTO job_attempts (
           job_id, ordinal, fencing_token, worker_id, lease_expires_at, state
         )
         VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 || ' seconds')::interval, 'ACTIVE')
         RETURNING id, grant_id, lease_expires_at`,
        [job.id, nextOrdinal, nextFence.toString(), `${worker.workerId}:${worker.pid}`, LEASE_TTL_SECONDS]
      );
      const attempt = attemptRes.rows[0];

      // Update job to LEASED with updated fence and attempt count
      await client.query(
        `UPDATE jobs
         SET state = 'LEASED',
             active_lease_id = $1,
             fencing_token = $2,
             attempt_count = $3,
             updated_at = clock_timestamp()
         WHERE id = $4`,
        [attempt.id, nextFence.toString(), nextOrdinal, job.id]
      );

      return {
        identity: {
          jobId: job.id,
          attemptId: attempt.id,
          fencingToken: nextFence.toString(),
          deploymentGeneration: job.deployment_generation,
          grantId: attempt.grant_id,
        },
        jobType: job.job_type,
        targetId: job.target_id,
        payload: job.payload,
        expiresAt: attempt.lease_expires_at.toISOString(),
      };
    });
  }

  async heartbeat(lease: LeaseIdentity): Promise<LeaseStatus> {
    const fenceBigInt = BigInt(lease.fencingToken).toString();

    return this.db.withTransaction(async (client) => {
      const res = await client.query<{ lease_expires_at: Date; state: string }>(
        `UPDATE job_attempts ja
         SET lease_expires_at = clock_timestamp() + ($1 || ' seconds')::interval,
             heartbeat_at = clock_timestamp()
         FROM jobs j
         WHERE ja.id = $2
           AND ja.job_id = $3
           AND ja.fencing_token = $4
           AND ja.grant_id = $5
           AND ja.state = 'ACTIVE'
           AND ja.lease_expires_at > clock_timestamp()
           AND j.id = ja.job_id
           AND j.fencing_token = $4
           AND j.deployment_generation = $6
           AND j.state IN ('LEASED', 'RUNNING')
         RETURNING ja.lease_expires_at, ja.state`,
        [
          LEASE_TTL_SECONDS,
          lease.attemptId,
          lease.jobId,
          fenceBigInt,
          lease.grantId,
          lease.deploymentGeneration,
        ]
      );

      const row = res.rows[0];
      if (!row) {
        return { status: 'STOP', reason: 'FENCE_STALE_OR_EXPIRED' };
      }

      return {
        status: 'ACTIVE',
        expiresAt: row.lease_expires_at.toISOString(),
      };
    });
  }

  async prepareCompletion(
    lease: LeaseIdentity,
    evidence: ResultEvidence
  ): Promise<CompletionReceipt> {
    const fenceBigInt = BigInt(lease.fencingToken).toString();
    const evidenceJson = JSON.stringify(evidence);
    const evidenceDigest = createHash('sha256').update(evidenceJson).digest('hex');

    return this.db.withTransaction(async (client) => {
      // Check attempt is active and not expired
      const attemptRes = await client.query<AttemptRow>(
        `SELECT ja.*
         FROM job_attempts ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.id = $1
           AND ja.job_id = $2
           AND ja.fencing_token = $3
           AND ja.grant_id = $4
           AND ja.state = 'ACTIVE'
           AND ja.lease_expires_at > clock_timestamp()
           AND j.fencing_token = $3
           AND j.deployment_generation = $5
           AND j.state IN ('LEASED', 'RUNNING')
         FOR UPDATE`,
        [lease.attemptId, lease.jobId, fenceBigInt, lease.grantId, lease.deploymentGeneration]
      );

      if (attemptRes.rows.length === 0) {
        throw new JobBrokerError('FENCE_STALE_OR_EXPIRED', 'Cannot complete: lease is stale, expired, or invalid');
      }

      // Insert pinned completion record
      const compRes = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO job_completions (
           job_id, attempt_id, fencing_token, deployment_generation, evidence_digest, evidence_payload, state
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
         RETURNING id, created_at`,
        [lease.jobId, lease.attemptId, fenceBigInt, lease.deploymentGeneration, evidenceDigest, evidenceJson]
      );
      const completion = compRes.rows[0];

      // Atomically update job state to COMPLETION_PENDING
      await client.query(
        `UPDATE jobs
         SET state = 'COMPLETION_PENDING',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [lease.jobId]
      );

      return {
        receiptId: completion.id,
        timestamp: completion.created_at.toISOString(),
        data: {
          completionId: completion.id,
          state: 'COMPLETION_PENDING',
          evidenceDigest,
        },
      };
    });
  }

  async complete(
    completion: PinnedCompletion,
    _actor: ReconcilerIdentity
  ): Promise<ResultReceipt> {
    return this.db.withTransaction(async (client) => {
      const compRes = await client.query<CompletionRow>(
        `SELECT * FROM job_completions
         WHERE id = $1
           AND evidence_digest = $2
           AND deployment_generation = $3
           AND state = 'PENDING'
         FOR UPDATE`,
        [completion.completionId, completion.evidenceDigest, completion.deploymentGeneration]
      );

      const row = compRes.rows[0];
      if (!row) {
        throw new JobBrokerError('COMPLETION_INVALID', 'Invalid completion record, digest mismatch, or already completed');
      }

      // Mark completion ACCEPTED
      await client.query(
        `UPDATE job_completions
         SET state = 'ACCEPTED', accepted_at = clock_timestamp()
         WHERE id = $1`,
        [completion.completionId]
      );

      // Transition job to SUCCEEDED
      await client.query(
        `UPDATE jobs
         SET state = 'SUCCEEDED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [row.job_id]
      );

      // Transition attempt to COMPLETED
      await client.query(
        `UPDATE job_attempts
         SET state = 'COMPLETED', evidence_digest = $1
         WHERE id = $2`,
        [completion.evidenceDigest, row.attempt_id]
      );

      return {
        receiptId: completion.completionId,
        timestamp: new Date().toISOString(),
        data: {
          resultVersionId: completion.completionId,
          state: 'ACCEPTED',
        },
      };
    });
  }
}
