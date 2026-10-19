import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp, type AppContext } from '../src/app.js';
import { PostgresDatabase } from '../src/persistence/db.js';
import { JobBroker } from '../src/jobs/broker.js';

/**
 * Reclaiming expired leases is what keeps a worker that dies mid-game from stranding its job: the
 * job would otherwise stay `LEASED` forever and never be claimable again. With the development
 * executor off nothing else runs the reconciler, so the API process must do it — this suite runs the
 * production shape (no dev executor) and shortens the interval so the behaviour is observable.
 */
describe('expired leases are reclaimed without the development executor', () => {
  const db = new PostgresDatabase();
  const jobIds: string[] = [];
  let context: AppContext | undefined;
  const previousDevFlag = process.env.OANTUTI_DEV_EXECUTION;
  const previousInterval = process.env.OANTUTI_LEASE_RECLAIM_INTERVAL_MS;

  beforeAll(async () => {
    delete process.env.OANTUTI_DEV_EXECUTION;
    process.env.OANTUTI_LEASE_RECLAIM_INTERVAL_MS = '100';
    context = await createApp({ pgDb: db });
    await context.app.ready();
  });

  afterAll(async () => {
    if (context) await context.app.close();
    if (jobIds.length > 0) {
      await db.query(`DELETE FROM job_completions WHERE job_id = ANY($1::uuid[])`, [jobIds]);
      await db.query(`UPDATE jobs SET active_lease_id = NULL WHERE id = ANY($1::uuid[])`, [jobIds]);
      await db.query(`DELETE FROM job_attempts WHERE job_id = ANY($1::uuid[])`, [jobIds]);
      await db.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobIds]);
    }
    await db.close();
    if (previousDevFlag === undefined) delete process.env.OANTUTI_DEV_EXECUTION;
    else process.env.OANTUTI_DEV_EXECUTION = previousDevFlag;
    if (previousInterval === undefined) delete process.env.OANTUTI_LEASE_RECLAIM_INTERVAL_MS;
    else process.env.OANTUTI_LEASE_RECLAIM_INTERVAL_MS = previousInterval;
  });

  it('requeues a job whose lease expired while its worker was gone', async () => {
    const broker = new JobBroker(db, 1);
    const target = randomUUID();
    const jobId = await broker.enqueue('GAME', target, 100);
    jobIds.push(jobId);

    const lease = await broker.claim(
      { workerId: 'stranded-worker', pid: 4242, uid: 1000 },
      { buildSlots: 0, gameSlots: 1 },
      { targetIds: [target] }
    );
    expect(lease?.identity.jobId).toBe(jobId);
    if (!lease) return;
    await db.query(
      `UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [lease.identity.attemptId]
    );

    // The reclamation runs on the API process's own interval, driven by the platform clock, so this
    // case waits for the observable state change (bounded, rechecked every 100 ms) rather than
    // advancing fake timers that the app's loop would not see.
    const deadline = Date.now() + 8_000;
    let state = 'LEASED';
    while (Date.now() < deadline && state === 'LEASED') {
      const res = await db.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [jobId]);
      state = res.rows[0]?.state ?? 'MISSING';
      if (state === 'LEASED') {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
      }
    }

    expect(state).toBe('RETRY_WAIT');
    const attempt = await db.query<{ state: string; error_details: string | null }>(
      `SELECT state, error_details FROM job_attempts WHERE id = $1`,
      [lease.identity.attemptId]
    );
    expect(attempt.rows[0]).toEqual({ state: 'EXPIRED', error_details: 'LEASE_TIMEOUT' });
  });
});
