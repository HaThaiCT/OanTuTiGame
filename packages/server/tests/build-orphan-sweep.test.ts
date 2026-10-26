import { describe, expect, it, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Database } from '../src/persistence/db.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import { PROCESS_RECONCILER_IDENTITY } from '../src/jobs/identity.js';

/**
 * The receipt commit and its BUILD/TEST_BUILD enqueue are two separate steps on purpose (a job must
 * never point at a row a rollback could erase), but a crash between them leaves the row usable and
 * permanently unworked: nothing else in the system ever re-derives the missing job. The reconciler
 * sweep is what closes that window, so this suite drives the reconciler directly against rows that
 * were stranded exactly there.
 */
describe('reconciler requeues acceptably stranded builds', () => {
  const db = new Database();

  const stamp = randomBytes(6).toString('hex');
  let courseId = '';
  let userId = '';
  let teamId = '';
  let tournamentId = '';
  const sourceDigests: string[] = [];
  const submissions: string[] = [];
  const snapshots: string[] = [];
  const strategicallyExistingJobId = randomUUID();

  it('inserts the missing BUILD/TEST_BUILD job exactly once per stranded row', async () => {
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Orphan Sweep Course') RETURNING id`,
      [`orphan-course-${stamp}`]
    );
    courseId = courseRes.rows[0].id;

    const userRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method)
       VALUES ($1, 'Orphan Sweep Student', 'hash', 'STUDENT', 'ADMIN_ISSUED') RETURNING id`,
      [`orphan_sweep_${stamp}`]
    );
    userId = userRes.rows[0].id;

    const teamRes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, 'Orphan Team', $2) RETURNING id`,
      [courseId, userId]
    );
    teamId = teamRes.rows[0].id;

    const tournamentRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format) VALUES ($1, 'Orphan Sweep Tournament', 'ROUND_ROBIN') RETURNING id`,
      [courseId]
    );
    tournamentId = tournamentRes.rows[0].id;

    const insertSource = async (suffix: string): Promise<string> => {
      const digest = `orphan-sweep-source-${stamp}-${suffix}`;
      sourceDigests.push(digest);
      await db.query(
        `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [digest, ['sources', digest + '.zip'].join('/'), 4, 4, 1, JSON.stringify({ language: 'TYPESCRIPT' })]
      );
      return digest;
    };

    const insertSubmission = async (status: string): Promise<string> => {
      const digest = await insertSource(`sub-${submissions.length}-${status}`);
      const row = await db.query<{ id: string }>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, $4, $5, 'TYPESCRIPT', 'bot.ts', $6) RETURNING id`,
        [tournamentId, teamId, userId, submissions.length + 1, digest, status]
      );
      submissions.push(row.rows[0].id);
      return row.rows[0].id;
    };

    const insertSnapshot = async (status: string): Promise<string> => {
      const digest = await insertSource(`snap-${snapshots.length}-${status}`);
      const row = await db.query<{ id: string }>(
        `INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, $4, 'TYPESCRIPT', 'bot.ts', $5) RETURNING id`,
        [tournamentId, teamId, userId, digest, status]
      );
      snapshots.push(row.rows[0].id);
      return row.rows[0].id;
    };

    // A receipt in the middle of its pipeline with no job row at all: exactly the strand window.
    const strandedSubmission = await insertSubmission('VALIDATING');
    // A pipeline stage that already produced its verdict never needs a new job.
    const finishedSubmission = await insertSubmission('READY');
    // A row whose job survived the crash must not gain a second one.
    const alreadyBuilt = await insertSubmission('COMPILING');
    await db.query(
      `INSERT INTO jobs (id, job_type, target_id, state, deployment_generation, payload)
       VALUES ($1, 'BUILD', $2, 'RETRY_WAIT', 1, '{"tournamentId":"guarded-in-premise","teamId":"guarded-in-premise"}')`,
      [strategicallyExistingJobId, alreadyBuilt]
    );
    submissions.push(alreadyBuilt);
    submissions.push(finishedSubmission);

    const strandedSnapshot = await insertSnapshot('QUEUED');
    const finishedSnapshot = await insertSnapshot('COMPLETED');
    snapshots.push(finishedSnapshot);

    const report = await new JobReconciler(db, 1).reconcile(PROCESS_RECONCILER_IDENTITY);
    expect(report.orphanBuildJobsInserted).toBe(2);

    const buildJobs = await db.query<{ target_id: string; state: string; payload: Record<string, string> }>(
      `SELECT target_id::text, state, payload FROM jobs WHERE job_type = 'BUILD' AND target_id = ANY($1::uuid[])`,
      [submissions]
    );
    const rebuilt = buildJobs.rows.filter((row) => row.target_id === strandedSubmission);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].state).toBe('QUEUED');
    expect(rebuilt[0].payload).toEqual({ tournamentId, teamId });
    expect(buildJobs.rows.filter((row) => row.target_id === finishedSubmission)).toHaveLength(0);
    expect(buildJobs.rows.filter((row) => row.target_id === alreadyBuilt)).toEqual([
      { target_id: alreadyBuilt, state: 'RETRY_WAIT', payload: expect.any(Object) },
    ]);

    const testBuildJobs = await db.query<{ target_id: string; state: string }>(
      `SELECT target_id::text, state FROM jobs WHERE job_type = 'TEST_BUILD' AND target_id = ANY($1::uuid[])`,
      [snapshots]
    );
    const rebuiltSnapshot = testBuildJobs.rows.filter((row) => row.target_id === strandedSnapshot);
    expect(rebuiltSnapshot).toHaveLength(1);
    expect(rebuiltSnapshot[0].state).toBe('QUEUED');
    expect(testBuildJobs.rows.filter((row) => row.target_id === finishedSnapshot)).toHaveLength(0);

    // A second pass observes no remaining stragglers and buys no duplicate rows.
    const secondReport = await new JobReconciler(db, 1).reconcile(PROCESS_RECONCILER_IDENTITY);
    expect(secondReport.orphanBuildJobsInserted).toBe(0);
    expect(
      (await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE job_type = 'BUILD' AND target_id = ANY($1::uuid[])`,
        [submissions]
      )).rows[0].count
    ).toBe('2');
  });

  afterAll(async () => {
    if (!courseId) return;
    try {
      await db.query(`DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))`, [
        [...submissions, ...snapshots],
      ]);
      await db.query(`DELETE FROM jobs WHERE target_id = ANY($1::uuid[])`, [[...submissions, ...snapshots]]);
      await db.query(`DELETE FROM submissions WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM test_snapshots WHERE tournament_id = $1`, [tournamentId]);
      if (sourceDigests.length > 0) {
        await db.query(`DELETE FROM submission_sources WHERE digest = ANY($1::text[])`, [sourceDigests]);
      }
      await db.query(`DELETE FROM tournaments WHERE id = $1`, [tournamentId]);
      await db.query(`DELETE FROM team_memberships WHERE team_id = $1`, [teamId]);
      await db.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    } finally {
      await db.close();
    }
  });
});
