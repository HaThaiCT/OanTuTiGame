import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Stable across PostgreSQL jsonb key ordering and a process restart. */
export function completionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(completionJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${completionJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export type CompletionConsumer = (evidence: CompletionEvidence, lease: LeaseIdentity, client: PoolClient) => Promise<ResultReceipt['data']>;
export type AcceptanceFence = (client: PoolClient) => Promise<void>;
import type { Database } from '../persistence/db.js';
import type {
  CompletionReceipt,
  CompletionEvidence,
  Digest,
  JobLease,
  JobType,
  LeaseIdentity,
  LeaseStatus,
  PinnedCompletion,
  ReconcilerIdentity,
  ResultReceipt,
  SlotOffer,
  UUID,
  WorkerIdentity,
} from '@oantuti/protocol';

export const LEASE_TTL_SECONDS = 30;

/**
 * Heartbeat cadence for lease holders: 03-ARCHITECTURE-DATA-CONTRACTS §109 pins lease 30s and
 * heartbeat 5s, so two beats may be lost before a running game's lease could be stolen.
 */
export const LEASE_HEARTBEAT_SECONDS = 5;

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

/** Optional claim narrowing: claims stay generic unless the caller says what is runnable. */
export interface ClaimOptions {
  /**
   * Restrict the claim to these job target ids (the games that are currently runnable).
   * Omitted → any job of an allowed type is claimable. An empty list claims nothing.
   */
  readonly targetIds?: readonly UUID[];
  /**
   * Restrict the claim to these job types, intersected with the ones the slot offer allows.
   * Needed when one slot offer covers several queues that must be drained separately (the
   * worker's private-test phase claims `TEST_GAME` without ever taking an official `GAME`).
   * Omitted → every type the slot offer allows is claimable.
   */
  readonly jobTypes?: readonly JobType[];
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
  readonly result_receipt: ResultReceipt | null;
}

export class JobBroker {
  private consumer?: CompletionConsumer;
  private acceptanceFence?: AcceptanceFence;
  private afterAccepted?: (receipt: ResultReceipt) => Promise<void>;
  registerCompletionPublication(publish: (receipt: ResultReceipt) => Promise<void>): void { this.afterAccepted = publish; }
  registerCompletionConsumer(consumer: CompletionConsumer): void { this.consumer = consumer; }
  setAcceptanceFence(fence: AcceptanceFence): void { this.acceptanceFence = fence; }
  async assertAcceptanceFence(client: PoolClient): Promise<void> { await this.acceptanceFence?.(client); }

  async enqueueInTransaction(client: PoolClient, jobType: JobType, targetId: UUID, priority = 100, payload: unknown = {}): Promise<UUID> {
    const result = await client.query<{ id: string }>(`INSERT INTO jobs (job_type,target_id,priority,state,deployment_generation,payload) VALUES ($1,$2,$3,'QUEUED',$4,$5) RETURNING id`, [jobType,targetId,priority,this.currentDeploymentGeneration,JSON.stringify(payload)]);
    return result.rows[0].id;
  }
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

  /**
   * Enqueue only when `(jobType, targetId)` has no job yet; returns true when one was created.
   *
   * Round transitions and the worker's bootstrap tick are replayed constantly (retried HTTP
   * requests, every 5 s poll, restarts), so enqueuing must be an idempotent side effect:
   * a second GAME job for the same game would only buy a wasted claim and a lease fight.
   */
  async enqueueIfAbsent(
    jobType: JobType,
    targetId: UUID,
    priority = 100,
    payload: unknown = {}
  ): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO jobs (job_type, target_id, priority, state, deployment_generation, payload)
       SELECT $1, $2, $3, 'QUEUED', $4, $5
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs WHERE job_type = $1 AND target_id = $2
       )
       RETURNING id`,
      [jobType, targetId, priority, this.currentDeploymentGeneration, JSON.stringify(payload)]
    );
    return res.rows.length > 0;
  }

  /**
   * Enqueues unless another job for the same `(jobType, targetId)` is still in flight
   * (QUEUED/LEASED/RUNNING/COMPLETION_PENDING/RETRY_WAIT). Used by the game bootstrap so a
   * target whose only jobs already finished without finishing its work can be retried, while a
   * genuinely in-flight job is never duplicated.
   */
  async enqueueIfNoActive(
    jobType: JobType,
    targetId: UUID,
    priority = 100,
    payload: unknown = {}
  ): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO jobs (job_type, target_id, priority, state, deployment_generation, payload)
       SELECT $1, $2, $3, 'QUEUED', $4, $5
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE job_type = $1 AND target_id = $2
           AND state IN ('QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING', 'RETRY_WAIT')
       )
       RETURNING id`,
      [jobType, targetId, priority, this.currentDeploymentGeneration, JSON.stringify(payload)]
    );
    return res.rows.length > 0;
  }

  async claim(
    worker: WorkerIdentity,
    capacity: SlotOffer,
    options: ClaimOptions = {}
  ): Promise<JobLease | null> {
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

    // Caller narrowing is an intersection: a type the slot offer does not cover stays
    // unclaimable even when it is listed.
    const claimTypes =
      options.jobTypes === undefined
        ? allowedTypes
        : allowedTypes.filter((type) => options.jobTypes!.includes(type));
    if (claimTypes.length === 0) {
      return null;
    }

    return this.db.withTransaction(async (client) => {
      // High-concurrency skip locked selection ordered by priority and queue age. `targetIds`
      // narrows the queue to what the caller considers runnable right now (games of RUNNING
      // tournaments); omitting it keeps the claim generic.
      const jobRes = await client.query<JobRow>(
        `SELECT id, job_type, target_id, priority, state, fencing_token::text,
                deployment_generation, attempt_count, max_attempts, payload
         FROM jobs
         WHERE state IN ('QUEUED', 'RETRY_WAIT')
           AND available_at <= clock_timestamp()
           AND job_type = ANY($1::text[])
           AND ($2::uuid[] IS NULL OR target_id = ANY($2::uuid[]))
           AND deployment_generation = $3
         ORDER BY priority DESC, available_at ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [claimTypes, options.targetIds ? [...options.targetIds] : null, this.currentDeploymentGeneration]
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
    evidence: CompletionEvidence
  ): Promise<CompletionReceipt> {
    const fenceBigInt = BigInt(lease.fencingToken).toString();
    const evidenceJson = completionJson(evidence);
    const evidenceDigest = createHash('sha256').update(evidenceJson).digest('hex');

    return this.db.withTransaction(async (client) => {
      // An attempt that already pinned exactly this evidence gets the persisted receipt back before
      // the freshness fence is consulted: the write already happened, and a paused ledger must still
      // answer an idempotent retry of it. Only a *new* pin is a protected write.
      const prior = await client.query<CompletionRow>(`SELECT * FROM job_completions WHERE job_id=$1 AND attempt_id=$2 AND fencing_token=$3 AND deployment_generation=$4`, [lease.jobId,lease.attemptId,fenceBigInt,lease.deploymentGeneration]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.evidence_digest !== evidenceDigest) throw new JobBrokerError('COMPLETION_CONFLICT', 'Attempt already pinned different evidence');
        return { receiptId: row.id, timestamp: row.created_at.toISOString(), data: { completionId: row.id, state: 'COMPLETION_PENDING' as const, evidenceDigest } };
      }
      await this.assertAcceptanceFence(client);
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

  async complete(completion: PinnedCompletion, _actor: ReconcilerIdentity): Promise<ResultReceipt> {
    const receipt = await this.db.withTransaction(async (client) => {
      const found = await client.query<CompletionRow & { target_id: string; grant_id: string }>(
        `SELECT c.*,j.target_id,a.grant_id FROM job_completions c JOIN jobs j ON j.id=c.job_id JOIN job_attempts a ON a.id=c.attempt_id
         WHERE c.id=$1 AND c.evidence_digest=$2 AND c.deployment_generation=$3
           AND j.deployment_generation=c.deployment_generation AND j.fencing_token=c.fencing_token
           AND j.active_lease_id=c.attempt_id AND a.fencing_token=c.fencing_token
           AND ((c.state='PENDING' AND j.state='COMPLETION_PENDING' AND a.state='ACTIVE')
             OR (c.state='ACCEPTED' AND j.state='SUCCEEDED' AND a.state='COMPLETED'))
         FOR UPDATE OF c,j,a`, [completion.completionId,completion.evidenceDigest,completion.deploymentGeneration]);
      // Pinned immutable evidence retains authority without the worker lease clock.
      const row = found.rows[0];
      if (!row) throw new JobBrokerError('COMPLETION_INVALID', 'Invalid completion identity or fence');
      const evidence = row.evidence_payload as CompletionEvidence;
      if (createHash('sha256').update(completionJson(evidence)).digest('hex') !== row.evidence_digest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Pinned evidence digest mismatch');
      if (row.result_receipt) return row.result_receipt;
      if (evidence.native !== undefined && !this.consumer) throw new JobBrokerError('CONSUMER_UNAVAILABLE', 'Durable native completion consumer is not configured');
      const data = evidence.native !== undefined
        ? await this.consumer!(evidence, { jobId: row.job_id, attemptId: row.attempt_id, fencingToken: String(row.fencing_token), deploymentGeneration: row.deployment_generation, grantId: row.grant_id }, client)
        : { state: 'ACCEPTED' as const, kind: evidence.kind, targetId: row.target_id };
      const receipt: ResultReceipt = { receiptId: row.id, timestamp: row.created_at.toISOString(), data };
      await client.query(`UPDATE job_completions SET state='ACCEPTED',accepted_at=clock_timestamp(),result_receipt=$2 WHERE id=$1`, [row.id,JSON.stringify(receipt)]);
      await client.query(`UPDATE jobs SET state='SUCCEEDED',updated_at=clock_timestamp() WHERE id=$1`, [row.job_id]);
      await client.query(`UPDATE job_attempts SET state='COMPLETED',evidence_digest=$1 WHERE id=$2`, [row.evidence_digest,row.attempt_id]);
      return receipt;
    });
    await this.afterAccepted?.(receipt);
    return receipt;
  }
}
