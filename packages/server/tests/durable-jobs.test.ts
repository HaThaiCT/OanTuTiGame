import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/persistence/db.js';
import { JobBroker, JobBrokerError, LEASE_TTL_SECONDS } from '../src/jobs/broker.js';
import type { ResultReceipt } from '@oantuti/protocol';
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

  it('returns the identical terminal receipt after a lost completion acknowledgement', async () => {
    const target = randomUUID();
    await broker.enqueue('BUILD', target);
    const claim = await broker.claim(worker1, { buildSlots: 1, gameSlots: 0 }, { targetIds: [target] });
    expect(claim).not.toBeNull();
    const prepared = await broker.prepareCompletion(claim!.identity, { kind: 'BUILD', build: {
      outcome: 'SOURCE_REJECTED', stage: 'COMPILE', manifestDigest: 'c'.repeat(64),
      toolchain: { language: 'CPP', imageDigest: 'd'.repeat(64), version: '1', flags: [] }, diagnostic: 'invalid source',
    } });
    const pinned = { completionId: prepared.data.completionId, evidenceDigest: prepared.data.evidenceDigest, deploymentGeneration: 1 };
    const receipt = await broker.complete(pinned, reconcilerId);
    expect(receipt.data.resultVersionId).toBeUndefined();
    expect(await broker.complete(pinned, reconcilerId)).toEqual(receipt);
  });

  it('refuses corrupted durable payloads without marking jobs successful', async () => {
    const target = randomUUID();
    await broker.enqueue('GAME', target);
    const claim = await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 }, { targetIds: [target] });
    const prepared = await broker.prepareCompletion(claim!.identity, { kind: 'GAME', game: {
      verdict: 'DRAW', reason: 'draw', actionTraceDigest: 'a'.repeat(64), replayDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64), cpuUsec: '0', wallUsec: '0',
    } });
    await db.query(`UPDATE job_completions SET evidence_payload = jsonb_set(evidence_payload, '{game,reason}', '"tampered"') WHERE id = $1`, [prepared.data.completionId]);
    await expect(broker.complete({ completionId: prepared.data.completionId, evidenceDigest: prepared.data.evidenceDigest, deploymentGeneration: 1 }, reconcilerId)).rejects.toThrow();
    const state = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [claim!.identity.jobId]);
    expect(state.rows[0].state).toBe('COMPLETION_PENDING');
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
    const compReceipt = await broker.prepareCompletion(lease.identity, { kind: 'GAME', game: evidence });
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
    await broker.prepareCompletion(lease.identity, { kind: 'GAME', game: evidence });

    // Reconciler runs independently: detects orphaned COMPLETION_PENDING and promotes to ACCEPTED
    const report = await reconciler.reconcile(reconcilerId);
    expect(report.orphanedCompletionsAccepted).toBe(1);

    // Job is now SUCCEEDED
    const jobCheck = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [lease.identity.jobId]);
    expect(jobCheck.rows[0].state).toBe('SUCCEEDED');
  });

  it('enqueues idempotently and only claims the target ids the caller considers runnable', async () => {
    const runnableGame = randomUUID();
    const pausedGame = randomUUID();

    // A replayed round transition or bootstrap tick must not create a second job.
    expect(await broker.enqueueIfAbsent('GAME', runnableGame, 100, { label: 'runnable' })).toBe(true);
    expect(await broker.enqueueIfAbsent('GAME', runnableGame, 100, { label: 'runnable' })).toBe(false);
    const runnableJobs = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM jobs WHERE job_type = 'GAME' AND target_id = $1`,
      [runnableGame]
    );
    expect(runnableJobs.rows[0].count).toBe('1');

    await broker.enqueue('GAME', pausedGame, 200);

    // Nothing is claimable when the caller's runnable set is empty (e.g. every tournament
    // is PAUSED), even though higher-priority work is queued.
    expect(await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 }, { targetIds: [] })).toBeNull();

    // With a runnable set, the claim still respects the filter: the uneasy game stays queued.
    const lease = await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 }, { targetIds: [runnableGame] });
    expect(lease?.targetId).toBe(runnableGame);
    expect(lease?.jobType).toBe('GAME');

    const pausedJob = await db.query<{ state: string; attempt_count: number }>(
      `SELECT state, attempt_count FROM jobs WHERE job_type = 'GAME' AND target_id = $1`,
      [pausedGame]
    );
    expect(pausedJob.rows[0].state).toBe('QUEUED');
    expect(pausedJob.rows[0].attempt_count).toBe(0);
  });

  it('narrows claims by requested job types and re-enqueues only terminal unfinished targets', async () => {
    const gameTarget = randomUUID();
    const testTarget = randomUUID();

    await broker.enqueue('GAME', gameTarget, 300, { label: 'official' });
    await broker.enqueue('TEST_GAME', testTarget, 300, { label: 'practice' });

    // A private-test phase must never claim the official game even though the slot offer allows games.
    const testLease = await broker.claim(worker1, { buildSlots: 0, gameSlots: 1 }, { jobTypes: ['TEST_GAME'] });
    expect(testLease?.jobType).toBe('TEST_GAME');
    expect(testLease?.targetId).toBe(testTarget);

    // The official game is still queued and claimable by a normal game claim.
    const gameLease = await broker.claim(worker2, { buildSlots: 0, gameSlots: 1 });
    expect(gameLease?.jobType).toBe('GAME');
    expect(gameLease?.targetId).toBe(gameTarget);

    // A finished job for a still-unfinished target may be replaced; an in-flight one may not.
    const recovered = randomUUID();
    const finishedJobId = await broker.enqueue('GAME', recovered, 100);
    await db.query(`UPDATE jobs SET state = 'SUCCEEDED' WHERE id = $1`, [finishedJobId]);
    expect(await broker.enqueueIfNoActive('GAME', recovered, 100)).toBe(true);
    expect(await broker.enqueueIfNoActive('GAME', recovered, 100)).toBe(false);

    const queued = randomUUID();
    await broker.enqueue('GAME', queued, 100);
    expect(await broker.enqueueIfNoActive('GAME', queued, 100)).toBe(false);
  });

  it('lets exactly one supervisor win a claim race and accepts a pinned completion once', async () => {
    const target = randomUUID();
    const jobId = await broker.enqueue('GAME', target, 100);

    // Eight supervisors claim simultaneously; only this target is runnable, so one lease exists
    // (the suite shares a database, so unclaimed jobs from earlier cases must stay excluded).
    const racers: WorkerIdentity[] = Array.from({ length: 8 }, (_, index) => ({
      workerId: `racer-${index}`,
      pid: 2000 + index,
      uid: 1000,
    }));
    const claims = await Promise.all(
      racers.map((racer) => broker.claim(racer, { buildSlots: 0, gameSlots: 1 }, { targetIds: [target] }))
    );
    const leases = claims.filter((claim) => claim !== null);
    expect(leases).toHaveLength(1);
    const lease = leases[0]!;
    expect(lease.identity.jobId).toBe(jobId);

    const attempts = await db.query<{ state: string }>(
      `SELECT state FROM job_attempts WHERE job_id = $1`,
      [jobId]
    );
    expect(attempts.rows).toEqual([{ state: 'ACTIVE' }]);

    const pinned = await broker.prepareCompletion(lease.identity, {
      kind: 'GAME',
      game: {
        verdict: 'DECISIVE',
        winner: 1,
        reason: 'THRONE_BREACH',
        actionTraceDigest: '0'.repeat(64),
        replayDigest: '1'.repeat(64),
        manifestDigest: '2'.repeat(64),
        cpuUsec: '15000',
        wallUsec: '250000',
      },
    });
    const completion = {
      completionId: pinned.data.completionId,
      evidenceDigest: pinned.data.evidenceDigest,
      deploymentGeneration: lease.identity.deploymentGeneration,
    };

    // Two reconcilers confirm the same pinned completion: a lost acknowledgement must return the
    // same canonical receipt to both, and the ledger must be scored exactly once.
    const outcomes = await Promise.allSettled([
      broker.complete(completion, reconcilerId),
      broker.complete(completion, { reconcilerId: 'reconciler-2', pid: 9998, uid: 1000 }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    const receipts = fulfilled.map((outcome) => (outcome as PromiseFulfilledResult<ResultReceipt>).value);
    expect(receipts[0].data).toEqual(receipts[1].data);

    const job = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [jobId]);
    expect(job.rows[0].state).toBe('SUCCEEDED');
    const accepted = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_completions WHERE job_id = $1 AND state = 'ACCEPTED'`,
      [jobId]
    );
    expect(accepted.rows[0].n).toBe(1);
  });

  it('keeps another deployment generation out of this generation leases and completions', async () => {
    const otherGeneration = 4242;
    const otherBroker = new JobBroker(db, otherGeneration);
    const otherReconciler = new JobReconciler(db, otherGeneration);
    const pinned = async (target: string) => otherBroker.claim(worker1, { buildSlots: 0, gameSlots: 1 }, { targetIds: [target] });

    // An expired lease of the other generation stays untouched for this generation's reconciler…
    const expiredTarget = randomUUID();
    const expiredJob = await otherBroker.enqueue('GAME', expiredTarget, 100);
    const expiredLease = await pinned(expiredTarget);
    expect(expiredLease?.identity.jobId).toBe(expiredJob);
    if (!expiredLease) return;
    await db.query(
      `UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [expiredLease.identity.attemptId]
    );

    // …and neither is a completion pinned by that generation.
    const completedTarget = randomUUID();
    const completedJob = await otherBroker.enqueue('GAME', completedTarget, 100);
    const completedLease = await pinned(completedTarget);
    expect(completedLease?.identity.jobId).toBe(completedJob);
    if (!completedLease) return;
    await otherBroker.prepareCompletion(completedLease.identity, {
      kind: 'GAME',
      game: {
        verdict: 'DECISIVE',
        winner: 1,
        reason: 'THRONE_BREACH',
        actionTraceDigest: '0'.repeat(64),
        replayDigest: '1'.repeat(64),
        manifestDigest: '2'.repeat(64),
        cpuUsec: '15000',
        wallUsec: '250000',
      },
    });

    await reconciler.reconcile(reconcilerId);
    const untouched = await db.query<{ state: string }>(
      `SELECT state FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[expiredJob, completedJob]]
    );
    expect(untouched.rows.map((row) => row.state).sort()).toEqual(['COMPLETION_PENDING', 'LEASED']);
    expect(
      (await db.query(`SELECT id FROM job_completions WHERE job_id = $1 AND state = 'ACCEPTED'`, [completedJob])).rows
    ).toHaveLength(0);

    // Its own generation reclaims the expired lease and promotes the pinned completion once.
    const own = await otherReconciler.reconcile(reconcilerId);
    expect(own.expiredLeasesReclaimed).toBe(1);
    expect(own.orphanedCompletionsAccepted).toBe(1);
    const settled = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM jobs WHERE id = ANY($1::uuid[])`,
      [[expiredJob, completedJob]]
    );
    const byId = Object.fromEntries(settled.rows.map((row) => [row.id, row.state]));
    expect(byId[expiredJob]).toBe('RETRY_WAIT');
    expect(byId[completedJob]).toBe('SUCCEEDED');
    expect(
      (await db.query(`SELECT id FROM job_completions WHERE job_id = $1 AND state = 'ACCEPTED'`, [completedJob])).rows
    ).toHaveLength(1);

    for (const id of [expiredJob, completedJob]) {
      await db.query('DELETE FROM job_completions WHERE job_id = $1', [id]);
      await db.query('UPDATE jobs SET active_lease_id = NULL WHERE id = $1', [id]);
      await db.query('DELETE FROM job_attempts WHERE job_id = $1', [id]);
      await db.query('DELETE FROM jobs WHERE id = $1', [id]);
    }
  });
});
