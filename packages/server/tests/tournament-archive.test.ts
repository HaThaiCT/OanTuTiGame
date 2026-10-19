import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { hashToken } from '../src/identity/crypto.js';
import { IdentityService } from '../src/identity/service.js';
import { JobBroker } from '../src/jobs/broker.js';
import { MapService } from '../src/tournaments/map-service.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { registerTournamentRoutes } from '../src/tournaments/routes.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { SubmissionService } from '../src/submissions/service.js';
import { createZip } from './helpers/zip.js';

// Run only with the explicit isolated PG environment used by the integration harness.
describe('LAN tournament archive command', () => {
  const run = randomUUID();
  let db: PostgresDatabase;
  let app: FastifyInstance;
  let service: TournamentLifecycleService;
  let admin: Actor;
  let courseId: string;
  let studentId: string;
  const tournaments: string[] = [];
  const sessionHashes: string[] = [];
  let createdAdmin = false;

  const context = (overrides: Partial<CommandContext> = {}): CommandContext => ({
    actor: admin, requestId: randomUUID(), ...overrides,
  });
  async function tournament(state = 'FINALIZED'): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, finalized_at)
       VALUES ($1, $2, 'ROUND_ROBIN', $3, clock_timestamp()) RETURNING id`,
      [courseId, `Archive ${run}`, state],
    );
    tournaments.push(result.rows[0].id);
    return result.rows[0].id;
  }
  async function cookie(userId: string, scope: 'FULL' | 'PASSWORD_CHANGE_ONLY', recent = true): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const digest = hashToken(token);
    sessionHashes.push(digest);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at, reauthenticated_at)
       VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour',
               CASE WHEN $4 THEN clock_timestamp() ELSE clock_timestamp() - interval '11 minutes' END)`,
      [userId, digest, scope, recent],
    );
    return `oantuti_session=${token}`;
  }
  beforeAll(async () => {
    db = new PostgresDatabase();
    const existing = await db.query<{ id: string; username: string }>(`SELECT id, username FROM users WHERE role = 'ADMIN' LIMIT 1`);
    let account = existing.rows[0];
    if (!account) {
      const inserted = await db.query<{ id: string; username: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, 'Archive admin', 'unused', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id, username`, [`archive_${run}`],
      );
      account = inserted.rows[0];
      createdAdmin = true;
    }
    admin = { userId: account.id, username: account.username, role: 'ADMIN', scope: 'FULL', teamIds: [] };
    const student = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Archive student', 'unused', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`, [`archive_student_${run}`],
    );
    studentId = student.rows[0].id;
    const course = await db.query<{ id: string }>(`INSERT INTO courses (code, name) VALUES ($1, 'Archive course') RETURNING id`, [run]);
    courseId = course.rows[0].id;
    service = new TournamentLifecycleService(db);
    app = Fastify();
    registerTournamentRoutes(app, db, new MapService(db), service, new TournamentSchedulerService(db, new JobBroker(db)), new IdentityService(db));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [tournaments]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournaments]);
    await db.query(`DELETE FROM command_receipts WHERE scope = ANY($1::text[])`, [tournaments.map((id) => `ARCHIVE:${id}`)]);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [tournaments]);
    await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1::text[])`, [sessionHashes]);
    await db.query(`DELETE FROM users WHERE id = $1`, [studentId]);
    if (createdAdmin) await db.query(`DELETE FROM users WHERE id = $1`, [admin.userId]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    await db.close();
  });

  it.each(['DRAFT', 'PUBLISHED', 'REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS', 'LOCKED', 'READY_TO_START', 'RUNNING', 'PAUSED', 'PROVISIONAL', 'CANCELLED', 'ARCHIVED'])(
    'rejects %s rather than bypassing finalization', async (state) => {
      const id = await tournament(state);
      await expect(service.archive(id, context())).rejects.toMatchObject({ statusCode: 409 });
      expect((await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [id])).rows[0].state).toBe(state);
    },
  );
  it('checks FULL ADMIN even when a completed receipt can be replayed', async () => {
    const id = await tournament();
    const ctx = context({ idempotencyKey: randomUUID() });
    await service.archive(id, ctx);
    for (const actor of [{ ...admin, scope: 'PASSWORD_CHANGE_ONLY' as const }, { ...admin, role: 'STUDENT' as const }]) {
      await expect(service.archive(id, { ...ctx, actor })).rejects.toMatchObject({ statusCode: 403 });
    }
  });
  it('rejects missing tournaments and stale aggregate versions without an archive event', async () => {
    await expect(service.archive(randomUUID(), context())).rejects.toMatchObject({ statusCode: 404 });
    const id = await tournament();
    await expect(service.archive(id, context({ expectedVersion: -1 }))).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.query(`SELECT id FROM outbox_events WHERE topic = 'TOURNAMENT_ARCHIVED' AND payload->>'tournamentId' = $1`, [id])).rows).toHaveLength(0);
  });
  it('archives once with optimistic versioning, one audit/outbox event and an identical retry receipt', async () => {
    const id = await tournament();
    const before = (await db.query<{ version: number; finalized_at: Date }>('SELECT version, finalized_at FROM tournaments WHERE id = $1', [id])).rows[0];
    const ctx = context({ expectedVersion: before.version, idempotencyKey: randomUUID() });
    const receipt = await service.archive(id, ctx);
    expect(receipt.data).toMatchObject({ tournamentId: id, state: 'ARCHIVED' });
    expect(await service.archive(id, ctx)).toEqual(receipt);
    const after = (await db.query<{ state: string; version: number; finalized_at: Date }>('SELECT state, version, finalized_at FROM tournaments WHERE id = $1', [id])).rows[0];
    expect(after).toEqual({ state: 'ARCHIVED', version: before.version + 1, finalized_at: before.finalized_at });
    expect((await db.query(`SELECT id FROM audit_events WHERE action = 'TOURNAMENT_ARCHIVED' AND resource_id = $1`, [id])).rows).toHaveLength(1);
    expect((await db.query(`SELECT id FROM outbox_events WHERE topic = 'TOURNAMENT_ARCHIVED' AND payload->>'tournamentId' = $1`, [id])).rows).toHaveLength(1);
    await expect(service.archive(id, context())).rejects.toMatchObject({ statusCode: 409 });
  });
  it('blocks active disputes and preserves held source, accepted results, replay and private tests', async () => {
    const id = await tournament();
    const teamIds = [randomUUID(), randomUUID()];
    const encounterId = randomUUID();
    const gameId = randomUUID();
    const resultId = randomUUID();
    const source = `archive-source-${run}`;
    const replay = `archive-replay-${run}`;
    const holdSetting = (await db.query<{ value: unknown }>(`SELECT value FROM deployment_settings WHERE key = 'retention_holds'`)).rows[0];
    const storageRoot = await mkdtemp(join(tmpdir(), 'arena-archive-'));
    let privateSource: string | undefined;
    const holds = [
      ...(Array.isArray(holdSetting?.value) ? holdSetting.value as unknown[] : []),
      { scope: 'TOURNAMENT', id, reason: 'Legal evidence hold', createdAt: new Date().toISOString() },
      { scope: 'TEAM', id: teamIds[0], reason: 'Security investigation', createdAt: new Date().toISOString() },
    ];
    try {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $3, 'Archive A', $4), ($2, $3, 'Archive B', $4)`, [...teamIds, courseId, studentId]);
      await db.query(`INSERT INTO encounters (id, tournament_id, team_a_id, team_b_id, status) VALUES ($1, $2, $3, $4, 'COMPLETED')`, [encounterId, id, ...teamIds]);
      await db.query(`INSERT INTO games (id, encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status) VALUES ($1, $2, 1, $3, $4, '{}', 'COMPLETED')`, [gameId, encounterId, ...teamIds]);
      await db.query(`INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns) VALUES ($1, $2, 10, 1)`, [replay, `archive/${run}.oantuti`]);
      await db.query(`INSERT INTO result_versions (id, game_id, verdict, winner, reason, action_trace_digest, replay_digest, manifest_digest) VALUES ($1, $2, 'DRAW', 0, 'DRAW', 'trace', $3, 'manifest')`, [resultId, gameId, replay]);
      await db.query(`INSERT INTO accepted_results (game_id, result_version_id) VALUES ($1, $2)`, [gameId, resultId]);
      await db.query(`INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest) VALUES ($1, $2, 10, 10, 1, '{}')`, [source, `archive/${run}.zip`]);
      await db.query(`INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status) VALUES ($1, $2, $3, 1, $4, 'PYTHON', 'main.py', 'READY')`, [id, teamIds[0], studentId, source]);
      await db.query(`INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status) VALUES ($1, $2, $3, $4, 'PYTHON', 'main.py', 'COMPLETED')`, [id, teamIds[0], studentId, source]);
      await db.query(`INSERT INTO deployment_settings (key, value) VALUES ('retention_holds', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(holds)]);
      await db.query(`INSERT INTO disputes (tournament_id, encounter_id, team_id, created_by_user_id, reason) VALUES ($1, $2, $3, $4, 'Appeal')`, [id, encounterId, teamIds[0], studentId]);
      for (const status of ['OPEN', 'UNDER_REVIEW']) {
        await db.query(`UPDATE disputes SET status = $2 WHERE tournament_id = $1`, [id, status]);
        await expect(service.archive(id, context())).rejects.toThrow('OPEN_DISPUTES');
      }
      await db.query(`UPDATE disputes SET status = 'RESOLVED' WHERE tournament_id = $1`, [id]);
      const inventory = async () => {
        const rows = await db.query<{ inventory: unknown }>(
          `SELECT jsonb_build_object(
            'sources', (SELECT jsonb_agg(s) FROM submission_sources s WHERE digest = $2),
            'submissions', (SELECT jsonb_agg(s) FROM submissions s WHERE tournament_id = $1),
            'tests', (SELECT jsonb_agg(s) FROM test_snapshots s WHERE tournament_id = $1),
            'accepted', (SELECT jsonb_agg(a) FROM accepted_results a WHERE game_id = $3),
            'versions', (SELECT jsonb_agg(r) FROM result_versions r WHERE game_id = $3),
            'replays', (SELECT jsonb_agg(r) FROM replay_objects r WHERE digest = $4),
            'holds', (SELECT value FROM deployment_settings WHERE key = 'retention_holds')
          ) AS inventory`, [id, source, gameId, replay]);
        return rows.rows[0].inventory;
      };
      const before = await inventory();
      await service.archive(id, context());
      expect(await inventory()).toEqual(before);
      const student: Actor = { userId: studentId, username: `archive_student_${run}`, role: 'STUDENT', scope: 'FULL', teamIds: [teamIds[0]] };
      const intake = new SubmissionService(db, new ArtifactStore(db, storageRoot), new JobBroker(db));
      const upload = { language: 'PYTHON' as const, entrypoint: 'main.py', zipBuffer: createZip({ 'main.py': '# archive test\n' }) };
      await expect(intake.submit(id, teamIds[0], upload, student)).rejects.toThrow('Submissions closed');
      const test = await intake.createPrivateTest(id, teamIds[0], upload, student);
      privateSource = test.data.sourceDigest;
      expect(test.data.testId).toBeTruthy();
      expect((await intake.getLatestCandidate(id, teamIds[0], student))?.receiptOrdinal).toBe(1);
      expect((await db.query('SELECT id FROM rating_events WHERE tournament_id = $1', [id])).rows).toHaveLength(0);
    } finally {
      if (holdSetting) await db.query(`UPDATE deployment_settings SET value = $1 WHERE key = 'retention_holds'`, [JSON.stringify(holdSetting.value)]);
      else await db.query(`DELETE FROM deployment_settings WHERE key = 'retention_holds'`);
      await db.query(`DELETE FROM jobs WHERE payload->>'tournamentId' = $1`, [id]);
      await db.query('DELETE FROM accepted_results WHERE game_id = $1', [gameId]);
      await db.query('DELETE FROM result_versions WHERE game_id = $1', [gameId]);
      await db.query('DELETE FROM disputes WHERE tournament_id = $1', [id]);
      await db.query('DELETE FROM games WHERE id = $1', [gameId]);
      await db.query('DELETE FROM encounters WHERE id = $1', [encounterId]);
      await db.query('DELETE FROM submissions WHERE tournament_id = $1', [id]);
      await db.query('DELETE FROM test_snapshots WHERE tournament_id = $1', [id]);
      await db.query('DELETE FROM submission_sources WHERE digest = $1', [source]);
      if (privateSource) await db.query('DELETE FROM submission_sources WHERE digest = $1', [privateSource]);
      await rm(storageRoot, { recursive: true, force: true });
      await db.query('DELETE FROM replay_objects WHERE digest = $1', [replay]);
      await db.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [teamIds]);
    }
  });
  it('requires a full admin session and recent session-specific reauthentication at the route', async () => {
    const id = await tournament();
    const url = `/api/v2/organizer/tournaments/${id}/archive`;
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    for (const session of [await cookie(studentId, 'FULL'), await cookie(admin.userId, 'PASSWORD_CHANGE_ONLY')]) {
      expect((await app.inject({ method: 'POST', url, headers: { cookie: session }, payload: {} })).statusCode).toBe(403);
    }
    const stale = await app.inject({ method: 'POST', url, headers: { cookie: await cookie(admin.userId, 'FULL', false) }, payload: {} });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('REAUTH_REQUIRED');
    const full = await cookie(admin.userId, 'FULL');
    const version = (await db.query<{ version: number }>('SELECT version FROM tournaments WHERE id = $1', [id])).rows[0].version;
    const headers = { cookie: full, 'idempotency-key': randomUUID() };
    const first = await app.inject({ method: 'POST', url, headers, payload: { expectedVersion: version } });
    expect(first.statusCode).toBe(200);
    const retry = await app.inject({ method: 'POST', url, headers, payload: { expectedVersion: version } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });
});
