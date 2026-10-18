import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/persistence/db.js';
import { JobBroker, JobBrokerError, LEASE_TTL_SECONDS } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import type { ReconcilerIdentity, ResultEvidence, SlotOffer, WorkerIdentity } from '@oantuti/protocol';

describe('S06 Durable Job Broker, Leases & Reconciler (T4)', () => {
  let db: Database;
  let broker: JobBroker;
  let reconciler: JobReconciler;

  const worker1: WorkerIdentity = { workerId: 'supervisor-worker-1', pid: 1001, uid: 1000 };
  const worker2: WorkerIdentity = { workerId: 'supervisor-worker-2', pid: 1002, uid: 1000 };
  const reconcilerId: ReconcilerIdentity = { reconcilerId: 'reconciler-1', pid: 9999, uid: 1000 };

  beforeAll(async () => {
    db = new Database();
    broker = new JobBroker(db);
    reconciler = new JobReconciler(db);

    // Clean tables for job tests
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM job_completions');
      await client.query('DELETE FROM job_attempts');
      await client.query('DELETE FROM jobs');
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it('enqueues jobs and enforces priority and FIFO ordering via SKIP LOCKED claim', async () => {
    const target1 = randomUUID();
    const target2 = randomUUID();
    const target3 = randomUUID();

    // Enqueue 3 jobs with different priorities
    await broker.enqueue('BUILD', target1, 50, { label: 'low-priority' });
    await broker.enqueue('GAME', target2, 200, { label: 'high-priority' });
    await broker.enqueue('BUILD', target3, 100, { label: 'medium-priority' });

    // Worker claims with capacity for both build and game
    const offer: SlotOffer = { buildSlots: 2, gameSlots: 2 };
    const claim1 = await broker.claim(worker1, offer);
    expect(claim1).not.toBeNull();
    // Highest priority (200) claimed first
    expect(claim1?.jobType).toBe('GAME');
    expect(claim1?.targetId).toBe(target2);
    expect(claim1?.identity.fencingToken).toBe('2'); // starts at 1, incremented to 2

    // Claim next
    const claim2 = await broker.claim(worker2, offer);
    expect(claim2).not.toBeNull();
    // Medium priority (100)
    expect(claim2?.jobType).toBe('BUILD');
    expect(claim2?.targetId).toBe(target3);

    // Claim third
    const claim3 = await broker.claim(worker1, offer);
    expect(claim3?.jobType).toBe('BUILD');
    expect(claim3?.targetId).toBe(target1);

    // Queue empty now
    const claimEmpty = await broker.claim(worker1, offer);
    expect(claimEmpty).toBeNull();
  });

  it('renews lease via periodic heartbeat and rejects stale fences', async () => {
    const target = randomUUID();
    await broker.enqueue('GAME', target, 100);

    const lease = await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 });
    expect(lease).not.toBeNull();
    if (!lease) return;

    // Heartbeat with valid identity succeeds and extends lease
    const hb1 = await broker.heartbeat(lease.identity);
    expect(hb1.status).toBe('ACTIVE');
    if (hb1.status === 'ACTIVE') {
      expect(new Date(hb1.expiresAt).getTime()).toBeGreaterThan(Date.now() + 10000);
    }

    // Heartbeat with stale fencing token is commanded to STOP
    const staleIdentity = { ...lease.identity, fencingToken: '9999' };
    const hbStale = await broker.heartbeat(staleIdentity);
    expect(hbStale.status).toBe('STOP');

    // Heartbeat with wrong grantId is commanded to STOP
    const wrongGrant = { ...lease.identity, grantId: randomUUID() };
    const hbWrong = await broker.heartbeat(wrongGrant);
    expect(hbWrong.status).toBe('STOP');
  });

  it('orchestrates two-phase completion: prepareCompletion (COMPLETION_PENDING) -> complete (ACCEPTED)', async () => {
    const target = randomUUID();
    await broker.enqueue('GAME', target, 100);
    const lease = await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 });
    expect(lease).not.toBeNull();
    if (!lease) return;

    const evidence: ResultEvidence = {
      verdict: 'DECISIVE',
      winner: 1,
      reason: 'THRONE_BREACH',
      actionTraceDigest: '0'.repeat(64),
      replayDigest: '1'.repeat(64),
      manifestDigest: '2'.repeat(64),
      cpuUsec: '15000',
      wallUsec: '250000',
    };

    // Phase 1: prepareCompletion
    const compReceipt = await broker.prepareCompletion(lease.identity, evidence);
    expect(compReceipt.data.state).toBe('COMPLETION_PENDING');
    expect(compReceipt.data.evidenceDigest).toBeDefined();

    // Verify job in DB is in COMPLETION_PENDING
    const jobCheck = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [lease.identity.jobId]);
    expect(jobCheck.rows[0].state).toBe('COMPLETION_PENDING');

    // Trying to complete with wrong evidence digest fails
    await expect(
      broker.complete(
        {
          completionId: compReceipt.data.completionId,
          evidenceDigest: 'bad-digest',
          deploymentGeneration: 1,
        },
        reconcilerId
      )
    ).rejects.toThrow(JobBrokerError);

    // Phase 2: complete with exact pinned evidence
    const resReceipt = await broker.complete(
      {
        completionId: compReceipt.data.completionId,
        evidenceDigest: compReceipt.data.evidenceDigest,
        deploymentGeneration: 1,
      },
      reconcilerId
    );

    expect(resReceipt.data.state).toBe('ACCEPTED');

    // Verify final state in DB
    const finalJob = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [lease.identity.jobId]);
    expect(finalJob.rows[0].state).toBe('SUCCEEDED');
  });

  it('reconciles expired leases with backoff and marks BLOCKED after 3 failed attempts', async () => {
    const target = randomUUID();
    const jobId = await broker.enqueue('BUILD', target, 100);

    // Attempt 1: claim and simulate expiry
    const lease1 = await broker.claim(worker1, { buildSlots: 1, gameSlots: 0 });
    expect(lease1?.identity.jobId).toBe(jobId);

    // Manually expire the attempt lease in DB
    await db.query("UPDATE job_attempts SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [
      lease1?.identity.attemptId,
    ]);

    // Reconciler runs: should reclaim with 5s backoff
    const r1 = await reconciler.reconcile(reconcilerId);
    expect(r1.expiredLeasesReclaimed).toBe(1);

    // Job is now in RETRY_WAIT
    const j1 = await db.query<{ state: string; attempt_count: number }>('SELECT state, attempt_count FROM jobs WHERE id = $1', [jobId]);
    expect(j1.rows[0].state).toBe('RETRY_WAIT');
    expect(j1.rows[0].attempt_count).toBe(1);

    // Fast-forward available_at to make it claimable again
    await db.query("UPDATE jobs SET available_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [jobId]);

    // Attempt 2: claim and expire again
    const lease2 = await broker.claim(worker2, { buildSlots: 1, gameSlots: 0 });
    expect(lease2?.identity.fencingToken).toBe('3'); // incremented fence

    await db.query("UPDATE job_attempts SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [
      lease2?.identity.attemptId,
    ]);

    const r2 = await reconciler.reconcile(reconcilerId);
    expect(r2.expiredLeasesReclaimed).toBe(1);

    // Fast-forward for attempt 3
    await db.query("UPDATE jobs SET available_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [jobId]);

    // Attempt 3: claim and expire
    const lease3 = await broker.claim(worker1, { buildSlots: 1, gameSlots: 0 });
    expect(lease3?.identity.fencingToken).toBe('4');

    await db.query("UPDATE job_attempts SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [
      lease3?.identity.attemptId,
    ]);

    // Reconciler on 3rd attempt: reaches max_attempts (3) -> transitions to BLOCKED
    const r3 = await reconciler.reconcile(reconcilerId);
    expect(r3.blockedJobsCount).toBe(1);

    const jFinal = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [jobId]);
    expect(jFinal.rows[0].state).toBe('BLOCKED');
  });

  it('reconciles and promotes orphaned COMPLETION_PENDING records when worker crashes after prepareCompletion', async () => {
    const target = randomUUID();
    await broker.enqueue('GAME', target, 100);
    const lease = await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 });
    if (!lease) return;

    const evidence: ResultEvidence = {
      verdict: 'DRAW',
      reason: 'MAX_TURNS_DRAW',
      actionTraceDigest: 'a'.repeat(64),
      replayDigest: 'b'.repeat(64),
      manifestDigest: 'c'.repeat(64),
      cpuUsec: '30000',
      wallUsec: '500000',
    };

    // Worker pinned completion, then simulated crash / network loss
    await broker.prepareCompletion(lease.identity, evidence);

    // Reconciler runs independently: detects orphaned COMPLETION_PENDING and promotes to ACCEPTED
    const report = await reconciler.reconcile(reconcilerId);
    expect(report.orphanedCompletionsAccepted).toBe(1);

    // Job is now SUCCEEDED
    const jobCheck = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [lease.identity.jobId]);
    expect(jobCheck.rows[0].state).toBe('SUCCEEDED');
  });
});
