import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { RetentionService } from '../src/operations/retention-service.js';
import type { Actor, CommandContext } from '@oantuti/protocol';

/**
 * Retention defaults from 05-SECURITY-OPERATIONS-QUALITY: private TEST evidence leaves after 7
 * days, diagnostics after 30 days post-finalize, delivered outbox and terminal jobs after 30
 * days, audit is report-only, and holds always win over TTL.
 */
describe('S15: retention report, holds and sweep', () => {
  let db: PostgresDatabase;
  let retention: RetentionService;
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    teamId: randomUUID(),
    heldTeamId: randomUUID(),
    tournamentId: randomUUID(),
    heldTournamentId: randomUUID(),
    sourceDigest: `sha256:retention-${randomUUID()}`,
    replayDigest: `sha256:retention-replay-${randomUUID()}`,
    heldSnapshotId: randomUUID(),
    abandonedSnapshotId: randomUUID(),
    auditId: randomUUID(),
    jobId: randomUUID(),
  };
  let expiredSnapshotId = '';
  const actor: Actor = {
    userId: ids.userId,
    username: 'retention-admin',
    displayName: 'Retention Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor, requestId: randomUUID() };

  beforeAll(async () => {
    db = new PostgresDatabase();
    retention = new RetentionService(db);
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'Retention Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `ret_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Retention Course')`, [
      ids.courseId,
      `RET_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [teamId, name] of [
      [ids.teamId, 'Retention Team'],
      [ids.heldTeamId, 'Held Team'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
    }
    for (const [tournamentId, name, finalizedDaysAgo] of [
      [ids.tournamentId, 'Retention Cup', 40],
      [ids.heldTournamentId, 'Held Cup', 40],
    ] as const) {
      await db.query(
        `INSERT INTO tournaments (id, course_id, name, format, state, max_teams)
         VALUES ($1, $2, $3, 'ROUND_ROBIN', 'FINALIZED', 4)`,
        [tournamentId, ids.courseId, name]
      );
      await db.query(`UPDATE tournaments SET finalized_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
        tournamentId,
        String(finalizedDaysAgo),
      ]);
    }
    await db.query(
      `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
       VALUES ($1, $2, 1024, 4096, 3, '{}'::jsonb)`,
      [ids.sourceDigest, `/tmp/${ids.sourceDigest}`]
    );
    await db.query(
      `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns, created_at)
       VALUES ($1, $2, 2048, 10, now() - interval '10 days')`,
      [ids.replayDigest, `/tmp/${ids.replayDigest}`]
    );

    const expired = await db.query<{ id: string }>(
      `INSERT INTO test_snapshots
         (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status,
          created_at, completed_at, build_logs, execution_logs, private_trace, replay_digest)
       VALUES ($1, $2, $3, $4, 'PYTHON', 'main.py', 'COMPLETED',
               now() - interval '10 days', now() - interval '10 days', 'build log', 'exec log', '[]'::jsonb, $5)
       RETURNING id`,
      [ids.tournamentId, ids.teamId, ids.userId, ids.sourceDigest, ids.replayDigest]
    );
    expiredSnapshotId = expired.rows[0].id;

    await db.query(
      `INSERT INTO test_snapshots
         (id, tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status,
          created_at, completed_at, build_logs, private_trace)
       VALUES ($1, $2, $3, $4, $5, 'PYTHON', 'main.py', 'COMPLETED',
               now() - interval '10 days', now() - interval '10 days', 'held build log', '[]'::jsonb)`,
      [ids.heldSnapshotId, ids.heldTournamentId, ids.heldTeamId, ids.userId, ids.sourceDigest]
    );

    await db.query(
      `INSERT INTO test_snapshots
         (id, tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'PYTHON', 'main.py', 'QUEUED', now() - interval '30 hours')`,
      [ids.abandonedSnapshotId, ids.tournamentId, ids.teamId, ids.userId, ids.sourceDigest]
    );

    await db.query(
      `INSERT INTO outbox_events (topic, payload, created_at, delivered_at)
       VALUES ('RETENTION_TEST', '{"k":1}'::jsonb, now() - interval '40 days', now() - interval '40 days')`
    );
    await db.query(
      `INSERT INTO jobs (id, job_type, target_id, state, updated_at, created_at)
       VALUES ($1, 'TEST_GAME', $2, 'SUCCEEDED', now() - interval '40 days', now() - interval '40 days')`,
      [ids.jobId, ids.abandonedSnapshotId]
    );
    // The job row above references the staging snapshot; remove it so the staging path stays testable.
    await db.query(`DELETE FROM jobs WHERE id = $1`, [ids.jobId]);
    await db.query(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, created_at)
       VALUES ($1, $2, 'ANCIENT_ACTION', 'tournament', 'old', now() - interval '400 days')`,
      [ids.auditId, ids.userId]
    );
  });

  afterAll(async () => {
    const snapshotIds = [expiredSnapshotId, ids.heldSnapshotId, ids.abandonedSnapshotId].filter(Boolean);
    if (snapshotIds.length > 0) {
      await db.query(`DELETE FROM test_snapshots WHERE id = ANY($1::uuid[])`, [snapshotIds]);
    }
    await db.query(`DELETE FROM replay_objects WHERE digest = $1`, [ids.replayDigest]);
    await db.query(`DELETE FROM submission_sources WHERE digest = $1`, [ids.sourceDigest]);
    await db.query(`DELETE FROM audit_events WHERE id = $1`, [ids.auditId]);
    await db.query(`DELETE FROM deployment_settings WHERE key = 'retention_holds'`);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [[ids.tournamentId, ids.heldTournamentId]]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[ids.teamId, ids.heldTeamId]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await db.close();
  });

  it('reports TTL classes and refuses non-admin readers', async () => {
    const report = await retention.report(ctx);
    const byName = Object.fromEntries(report.classes.map((entry) => [entry.className, entry]));
    expect(byName.PRIVATE_TEST_EVIDENCE.purgeableRows).toBeGreaterThanOrEqual(1);
    expect(byName.PRIVATE_TEST_EVIDENCE.purgeableBytes).toBeGreaterThanOrEqual(2048);
    expect(byName.PRIVATE_DIAGNOSTICS.purgeableRows).toBeGreaterThanOrEqual(2);
    expect(byName.OPERATIONAL_OUTBOX.purgeableRows).toBeGreaterThanOrEqual(1);
    expect(byName.SECURITY_ADMIN_AUDIT.appPurgeAllowed).toBe(false);
    expect(byName.SECURITY_ADMIN_AUDIT.rows).toBeGreaterThanOrEqual(1);
    expect(byName.OFFICIAL_SOURCE.appPurgeAllowed).toBe(false);

    const student: Actor = { ...actor, role: 'STUDENT' };
    await expect(retention.report({ actor: student, requestId: randomUUID() })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('plans without deleting in dry-run, then purges only unheld evidence', async () => {
    const holds = await retention.replaceHolds(
      [{ scope: 'TOURNAMENT', id: ids.heldTournamentId, reason: 'open appeal', createdAt: new Date().toISOString() }],
      ctx
    );
    expect(holds).toHaveLength(1);

    const dry = await retention.sweep({ dryRun: true }, ctx);
    expect(dry.dryRun).toBe(true);
    const dryEvidence = dry.actions.find((action) => action.className === 'PRIVATE_TEST_EVIDENCE');
    expect(dryEvidence?.rows).toBeGreaterThanOrEqual(1);
    expect(dryEvidence?.skippedHeld).toBe(1);
    const stillThere = await db.query(`SELECT id FROM test_snapshots WHERE id = $1`, [expiredSnapshotId]);
    expect(stillThere.rows).toHaveLength(1);

    const swept = await retention.sweep({ dryRun: false }, ctx);
    expect(swept.dryRun).toBe(false);
    const evidence = swept.actions.find((action) => action.className === 'PRIVATE_TEST_EVIDENCE');
    expect(evidence?.rows).toBeGreaterThanOrEqual(1);
    const replayAction = swept.actions.find((action) => action.className === 'PRIVATE_TEST_REPLAY_OBJECTS');
    expect(replayAction?.rows).toBe(1);

    expect((await db.query(`SELECT id FROM test_snapshots WHERE id = $1`, [expiredSnapshotId])).rows).toHaveLength(0);
    expect((await db.query(`SELECT id FROM test_snapshots WHERE id = $1`, [ids.abandonedSnapshotId])).rows).toHaveLength(0);
    expect((await db.query(`SELECT id FROM test_snapshots WHERE id = $1`, [ids.heldSnapshotId])).rows).toHaveLength(1);
    expect((await db.query(`SELECT digest FROM replay_objects WHERE digest = $1`, [ids.replayDigest])).rows).toHaveLength(0);
    expect((await db.query(`SELECT id FROM outbox_events WHERE topic = 'RETENTION_TEST'`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT id FROM audit_events WHERE id = $1`, [ids.auditId])).rows).toHaveLength(1);
    const sweepAudit = await db.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_events WHERE action = 'RETENTION_SWEEP' ORDER BY created_at DESC LIMIT 1`
    );
    expect(sweepAudit.rows[0]?.details.testSnapshots).toBeGreaterThanOrEqual(1);

    const heldReport = await retention.report(ctx);
    const heldEvidence = heldReport.classes.find((entry) => entry.className === 'PRIVATE_TEST_EVIDENCE');
    expect(heldEvidence?.purgeableRows).toBe(0);
    expect(heldEvidence?.heldRows).toBe(1);
  });

  it('sweeps without an operator when the worker calls it', async () => {
    // The worker path must not require a CommandContext; its audit row records a null actor.
    const swept = await retention.sweepAsSystem(false);
    expect(swept.dryRun).toBe(false);
    const audit = await db.query<{ actor_user_id: string | null; action: string }>(
      `SELECT actor_user_id, action FROM audit_events WHERE action = 'RETENTION_SWEEP' ORDER BY created_at DESC LIMIT 1`
    );
    expect(audit.rows[0]?.actor_user_id).toBeNull();
  });
});
