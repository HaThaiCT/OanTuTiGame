/**
 * Private TEST execution (S11/T3b): a team's test snapshot plays a real match and leaves no
 * official trace at all.
 *
 * This file drives the real services against PostgreSQL, not doubles:
 *   - `SubmissionService.createPrivateTest` → `BuildPipeline.buildTestSnapshot` (QUEUED → COMPLETED),
 *   - `PrivateTestRunner.runPrivateTest` (COMPLETED → RUNNING → COMPLETED / FAILED),
 *   - `TournamentAutoRunner` (accepted TEST_BUILD → TEST_GAME enqueued → drained in one tick),
 *   - the team-scoped read surface (list / detail / replay / access control).
 *
 * The board committed to the fixture is a 3×3 on which the repo's greedy bot breaches the black
 * throne on its first ply, so a successful run has a deterministic verdict (winner 1 = WHITE,
 * THRONE_BREACH, 1 turn) instead of depending on how a long match happens to end.
 *
 * The durable queue is global — one `jobs` table shared by every fixture in this database — and
 * this file drives whole worker ticks, so it starts (and re-starts) from an empty queue, the same
 * reset the other worker tests perform (`durable-jobs`, `submission-lifecycle`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { SubmissionService } from '../src/submissions/service.js';
import { BuildPipeline } from '../src/builds/build-pipeline.js';
import { PrivateTestRunner } from '../src/builds/private-test-runner.js';
import { ReplayStore, type ReplayV2Payload } from '../src/results/replay-store.js';
import { ResultService } from '../src/results/service.js';
import { MapService } from '../src/tournaments/map-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { MatchExecutionService } from '../src/tournaments/execution-service.js';
import { TournamentAutoRunner } from '../src/tournaments/auto-runner.js';
import { JobBroker } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';

const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const tmpRoot = path.join(os.tmpdir(), `oantuti-private-tests-${runId}`);
const BOARD_NAME = `Private Test Board ${runId}`;

/**
 * 3×3, ROCK vs ROCK. White's ROCK starts on the centre square — one king-step from the black
 * throne — and an immediate throne breach is the greedy bot's top heuristic tier.
 */
const BOARD: MapDescriptor = {
  mapName: `private-test-board-${runId}`,
  width: 3,
  height: 3,
  validTiles: [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [1, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ],
  whiteThrone: [0, 0],
  blackThrone: [2, 2],
  startingPieces: [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, 1] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [0, 2] },
  ],
};

/** `result_payload` of a COMPLETED private test. */
interface TestPayload {
  winner: number;
  reason: string;
  totalTurns: number;
  opponent: { kind: string; label: string; submissionId?: string };
  map: { name: string; version?: number; source: string };
  finishedAt: string;
}

interface TestRow {
  id: string;
  status: string;
  language: string;
  entrypoint: string;
  source_digest: string;
  started_at: Date | null;
  completed_at: Date | null;
  replay_digest: string | null;
  result_payload: TestPayload | { error: string } | null;
}

interface OfficialCounts {
  accepted: string;
  standings: string;
  ratings: string;
  entries: string;
  submissions: string;
  maxReceiptOrdinal: string;
}

/** Evidence a TEST_GAME completion pins: the private test and its verdict live under `details`. */
interface TestGameEvidence {
  verdict: string;
  reason: string;
  actionTraceDigest: string;
  replayDigest: string;
  manifestDigest: string;
  details: { testId: string; status: string; reason?: string };
}

/** Narrows a row's payload to the played-match shape; a failed run carries `{error}` instead. */
function playedPayload(row: TestRow): TestPayload {
  const payload = row.result_payload;
  if (!payload || 'error' in payload) {
    throw new Error(`expected a played match payload, got ${JSON.stringify(payload)}`);
  }
  return payload;
}

function createZip(files: Record<string, string>): Buffer {
  const fileEntries: { name: string; data: Buffer }[] = [];
  for (const [name, content] of Object.entries(files)) {
    fileEntries.push({ name, data: Buffer.from(content, 'utf8') });
  }

  const chunks: Buffer[] = [];
  const cdHeaders: Buffer[] = [];
  let localOffset = 0;

  for (const f of fileEntries) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const compressedData = zlib.deflateRawSync(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedData.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressedData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compressedData.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localOffset, 42);
    cdHeaders.push(cd, nameBuf);

    localOffset += 30 + nameBuf.length + compressedData.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(fileEntries.length, 8);
  eocd.writeUInt16LE(fileEntries.length, 10);
  eocd.writeUInt32LE(cdHeaders.reduce((sum, b) => sum + b.length, 0), 12);
  eocd.writeUInt32LE(localOffset, 16);

  chunks.push(...cdHeaders, eocd);
  return Buffer.concat(chunks);
}

describe('Private TEST execution leaves no official trace', () => {
  let db: PostgresDatabase;
  let artifactStore: ArtifactStore;
  let replayStore: ReplayStore;
  let buildPipeline: BuildPipeline;
  let submissionService: SubmissionService;
  let privateTestRunner: PrivateTestRunner;

  let courseId: string;
  let teamId: string;
  let tournamentId: string;
  let mapId: string;

  let adminActor: Actor;
  let memberActor: Actor;
  let outsiderActor: Actor;
  let passwordChangeActor: Actor;

  let goodDigest: string;
  let opponentDigest: string;
  /** The COMPLETED snapshot whose entrypoint cannot be materialized (recorded FAILED by the run). */
  let materializationFailureId: string;

  /** Fixture for the hidden-map check: a tournament with no commitment plus a secret map. */
  let practiceTournamentId = '';
  let hiddenMapId = '';
  const goodTestIds: string[] = [];
  const otherTestIds: string[] = [];
  const trackedDigests: string[] = [];

  /** Empties the durable queue so a tick claims exactly the jobs this file enqueued. */
  async function resetQueue(): Promise<void> {
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM job_completions');
      await client.query('DELETE FROM job_attempts');
      await client.query('DELETE FROM jobs');
    });
  }

  beforeAll(async () => {
    // The tick under test drives builds and private tests only: the official-game phase stays
    // disarmed so it can neither play nor delay on leftover fixtures of other test files.
    process.env.OANTUTI_DEV_EXECUTION = '0';

    db = new PostgresDatabase();
    artifactStore = new ArtifactStore(db, path.join(tmpRoot, 'submissions'));
    replayStore = new ReplayStore(
      path.join(tmpRoot, 'replays', 'objects'),
      path.join(tmpRoot, 'replays', 'staging')
    );
    buildPipeline = new BuildPipeline(db, artifactStore, { spoolDir: path.join(tmpRoot, 'builds') });
    submissionService = new SubmissionService(db, artifactStore, new JobBroker(db));
    privateTestRunner = new PrivateTestRunner(db, artifactStore, replayStore, {
      spoolDir: path.join(tmpRoot, 'tests'),
    });

    await resetQueue();

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Private Test Course') RETURNING id`,
      [`PT_COURSE_${runId}`]
    );
    courseId = course.rows[0].id;

    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'PT Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`pt_admin_${runId}`]
    );
    const member = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'PT Member', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`pt_member_${runId}`]
    );
    const outsider = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'PT Outsider', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`pt_outsider_${runId}`]
    );

    const team = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, `PT Team ${runId}`, member.rows[0].id]
    );
    teamId = team.rows[0].id;

    const rival = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, `PT Rival ${runId}`, outsider.rows[0].id]
    );

    adminActor = {
      userId: admin.rows[0].id,
      role: 'ADMIN',
      username: `pt_admin_${runId}`,
      teamIds: [],
      scope: 'FULL',
    };
    memberActor = {
      userId: member.rows[0].id,
      role: 'STUDENT',
      username: `pt_member_${runId}`,
      teamIds: [teamId],
      scope: 'FULL',
    };
    outsiderActor = {
      userId: outsider.rows[0].id,
      role: 'STUDENT',
      username: `pt_outsider_${runId}`,
      teamIds: [rival.rows[0].id],
      scope: 'FULL',
    };
    passwordChangeActor = { ...memberActor, scope: 'PASSWORD_CHANGE_ONLY' };

    const map = await db.query<{ id: string }>(
      `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings)
       VALUES ($1, $2, $3, 'PUBLIC', '[]'::jsonb) RETURNING id`,
      [BOARD.mapName, BOARD_NAME, JSON.stringify(BOARD)]
    );
    mapId = map.rows[0].id;
    await db.query(
      `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings)
       VALUES ($1, 1, $2, '[]'::jsonb)`,
      [mapId, JSON.stringify(BOARD)]
    );

    // No `registration_closes_at`: the worker's deadline sweep must not touch this fixture.
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, $2, 'ROUND_ROBIN', 'REGISTRATION_OPEN') RETURNING id`,
      [courseId, `Private Test Cup ${runId}`]
    );
    tournamentId = tournament.rows[0].id;
    await db.query(
      `INSERT INTO tournament_map_commitments (tournament_id, map_id, map_version, committed_by_user_id)
       VALUES ($1, $2, 1, $3)`,
      [tournamentId, mapId, adminActor.userId]
    );

    // Bot sources zipped exactly as a team would upload them.
    const greedy = readFileSync(path.resolve(process.cwd(), 'bots/greedy-bot.ts'), 'utf8');
    goodDigest = (
      await artifactStore.storeSource(createZip({ 'bot.ts': greedy }), 'TYPESCRIPT', 'bot.ts')
    ).digest;
    const random = readFileSync(path.resolve(process.cwd(), 'bots/random-bot.ts'), 'utf8');
    opponentDigest = (
      await artifactStore.storeSource(createZip({ 'opponent.ts': random }), 'TYPESCRIPT', 'opponent.ts')
    ).digest;
    trackedDigests.push(goodDigest, opponentDigest);
  });

  afterAll(async () => {
    await db.withTransaction(async (client) => {
      const ids = [...goodTestIds, ...otherTestIds];
      if (ids.length > 0) {
        await client.query(
          `DELETE FROM job_completions WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))`,
          [ids]
        );
        await client.query(
          `DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))`,
          [ids]
        );
        await client.query(`DELETE FROM jobs WHERE target_id = ANY($1::uuid[])`, [ids]);
      }
      await client.query('DELETE FROM test_snapshots WHERE tournament_id = $1', [tournamentId]);
      await client.query('DELETE FROM submissions WHERE tournament_id = $1', [tournamentId]);
      await client.query('DELETE FROM tournament_map_commitments WHERE tournament_id = $1', [tournamentId]);
      await client.query('DELETE FROM map_versions WHERE map_id = $1', [mapId]);
      await client.query('DELETE FROM maps WHERE id = $1', [mapId]);
      await client.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
      if (practiceTournamentId) {
        await client.query('DELETE FROM test_snapshots WHERE tournament_id = $1', [practiceTournamentId]);
        await client.query('DELETE FROM tournaments WHERE id = $1', [practiceTournamentId]);
      }
      if (hiddenMapId) {
        await client.query('DELETE FROM map_versions WHERE map_id = $1', [hiddenMapId]);
        await client.query('DELETE FROM maps WHERE id = $1', [hiddenMapId]);
      }
      await client.query(
        'DELETE FROM team_memberships WHERE team_id IN (SELECT id FROM teams WHERE course_id = $1)',
        [courseId]
      );
      await client.query('DELETE FROM teams WHERE course_id = $1', [courseId]);
      await client.query('DELETE FROM submission_sources WHERE digest = ANY($1::text[])', [trackedDigests]);
      await client.query('DELETE FROM courses WHERE id = $1', [courseId]);
      await client.query('DELETE FROM users WHERE username LIKE $1', [`pt\\_%\\_${runId}`]);
    });
    await db.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /** Snapshot row as the read API sees it. */
  async function loadRow(testId: string): Promise<TestRow> {
    const res = await db.query<TestRow>(
      `SELECT id, status, language, entrypoint, source_digest, started_at, completed_at,
              replay_digest, result_payload
       FROM test_snapshots WHERE id = $1`,
      [testId]
    );
    return res.rows[0];
  }

  /** Reads and verifies the replay object a row names, as a client of the replay route would. */
  function storedReplay(row: TestRow): ReplayV2Payload {
    const digest = row.replay_digest;
    if (digest === null) throw new Error('expected a stored replay digest');
    return replayStore.deserializeReplayV2(replayStore.readReplay(digest));
  }

  /** Row counts and receipt ordinals a private test must never move. */
  async function officialCounts(): Promise<OfficialCounts> {
    const res = await db.query<OfficialCounts>(
      `SELECT (SELECT count(*) FROM accepted_results)::text AS accepted,
              (SELECT count(*) FROM standings_snapshots)::text AS standings,
              (SELECT count(*) FROM rating_events)::text AS ratings,
              (SELECT count(*) FROM tournament_entries WHERE tournament_id = $1)::text AS entries,
              (SELECT count(*) FROM submissions WHERE tournament_id = $1)::text AS submissions,
              (SELECT COALESCE(max(receipt_ordinal), 0) FROM submissions WHERE tournament_id = $1)::text AS "maxReceiptOrdinal"`,
      [tournamentId]
    );
    return res.rows[0];
  }

  /** Queues a private test through the real intake and returns its snapshot id. */
  async function createTestSnapshot(zip: Buffer, entrypoint: string, log: string[]): Promise<string> {
    const receipt = await submissionService.createPrivateTest(
      tournamentId,
      teamId,
      { language: 'TYPESCRIPT', entrypoint, zipBuffer: zip },
      memberActor
    );
    trackedDigests.push(receipt.data.sourceDigest);
    log.push(receipt.data.testId);
    return receipt.data.testId;
  }

  /** Inserts a snapshot directly, for states this file does not re-drive through intake. */
  async function insertSnapshot(status: string, entrypoint = 'bot.ts'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `INSERT INTO test_snapshots
         (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, $4, 'TYPESCRIPT', $5, $6)
       RETURNING id`,
      [tournamentId, teamId, adminActor.userId, goodDigest, entrypoint, status]
    );
    otherTestIds.push(res.rows[0].id);
    return res.rows[0].id;
  }

  it('plays a built snapshot against the baseline bot and records the match on the snapshot only', async () => {
    const greedy = readFileSync(path.resolve(process.cwd(), 'bots/greedy-bot.ts'), 'utf8');
    const testId = await createTestSnapshot(createZip({ 'bot.ts': greedy }), 'bot.ts', goodTestIds);

    // The build leg the worker drives first: QUEUED → COMPILING → SMOKE_TESTING → COMPLETED.
    expect(await buildPipeline.buildTestSnapshot(testId)).toMatchObject({ status: 'COMPLETED' });
    expect((await loadRow(testId)).status).toBe('COMPLETED');

    const before = await officialCounts();
    expect(await privateTestRunner.runPrivateTest(testId)).toEqual({ status: 'COMPLETED' });

    const row = await loadRow(testId);
    expect(row.status).toBe('COMPLETED');
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();

    const payload = playedPayload(row);
    expect(payload.winner).toBe(1);
    expect(payload.reason).toBe('THRONE_BREACH');
    expect(payload.totalTurns).toBeGreaterThan(0);
    expect(payload.opponent).toEqual({ kind: 'BASELINE', label: 'greedy-bot.ts' });
    expect(payload.map).toEqual({ name: BOARD_NAME, version: 1, source: 'COMMITMENT' });
    expect(Date.parse(payload.finishedAt)).toBeGreaterThan(0);

    // The replay is a real OANTUTI2 object that resolves by the digest stored on the row.
    expect(row.replay_digest).toMatch(/^[0-9a-f]{64}$/);
    const replay = storedReplay(row);
    expect(replay.mapId).toBe(BOARD.mapName);
    expect(replay.winner).toBe(payload.winner);
    expect(replay.reason).toBe(payload.reason);
    expect(replay.totalTurns).toBe(payload.totalTurns);
    expect(replay.trace).toHaveLength(payload.totalTurns);
    expect(replay.disposition).toBe('DECISIVE');

    // Zero official side effects: no accepted result, no standings/rating row, no entry, and no
    // receipt ordinal consumed for the tournament.
    expect(await officialCounts()).toEqual(before);

    // A re-delivered job (lease expiry, restart) must not play the match a second time.
    expect(await privateTestRunner.runPrivateTest(testId)).toEqual({ status: 'COMPLETED' });
    const after = await loadRow(testId);
    expect(after.replay_digest).toBe(row.replay_digest);
    expect(after.started_at?.getTime()).toBe(row.started_at?.getTime());
    expect(after.completed_at?.getTime()).toBe(row.completed_at?.getTime());
  });

  it('plays the team latest READY submission as the opponent instead of the baseline', async () => {
    const submission = await db.query<{ id: string }>(
      `INSERT INTO submissions
         (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, 1, $4, 'TYPESCRIPT', 'opponent.ts', 'READY')
       RETURNING id`,
      [tournamentId, teamId, memberActor.userId, opponentDigest]
    );

    const testId = await insertSnapshot('COMPLETED');
    const before = await officialCounts();
    expect(await privateTestRunner.runPrivateTest(testId)).toEqual({ status: 'COMPLETED' });
    expect(await officialCounts()).toEqual(before);

    const row = await loadRow(testId);
    const payload = playedPayload(row);
    expect(payload.opponent).toEqual({
      kind: 'OWN_SUBMISSION',
      label: 'submission #1',
      submissionId: submission.rows[0].id,
    });
    expect(payload.map).toEqual({ name: BOARD_NAME, version: 1, source: 'COMMITMENT' });
    expect(payload.totalTurns).toBeGreaterThan(0);
    expect([0, 1, 2]).toContain(payload.winner);
    expect(payload.reason.length).toBeGreaterThan(0);
    expect(storedReplay(row).disposition).toBe(payload.winner === 0 ? 'DRAW' : 'DECISIVE');
  });

  it('refuses a snapshot whose build never passed, with the observed status as the reason', async () => {
    const broken = await createTestSnapshot(
      createZip({ 'bot.ts': 'const broken = ;@@@ not typescript' }),
      'bot.ts',
      otherTestIds
    );

    expect(await buildPipeline.buildTestSnapshot(broken)).toMatchObject({ status: 'FAILED' });

    const outcome = await privateTestRunner.runPrivateTest(broken);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toMatch(/TEST_NOT_RUNNABLE: snapshot status is FAILED/);

    const row = await loadRow(broken);
    expect(row.status).toBe('FAILED'); // the guard never claimed it
    expect(row.replay_digest).toBeNull();
    expect(row.started_at).toBeNull();
  });

  it('records a FAILED verdict with its cause when the snapshot cannot be materialized', async () => {
    // COMPLETED, but with an entrypoint the stored artifact does not contain: the failure happens
    // inside the run, so the run itself has to record it.
    materializationFailureId = await insertSnapshot('COMPLETED', 'missing.ts');
    const before = await officialCounts();

    const outcome = await privateTestRunner.runPrivateTest(materializationFailureId);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toMatch(/not found in ZIP files/);

    const row = await loadRow(materializationFailureId);
    expect(row.status).toBe('FAILED');
    expect(row.completed_at).not.toBeNull();
    expect(row.replay_digest).toBeNull();
    expect(row.result_payload).toEqual({ error: outcome.reason });
    expect(await officialCounts()).toEqual(before);
  });

  it('drains a TEST_BUILD job into its TEST_GAME job inside one worker tick', async () => {
    // Whole-tick drive: the queue must hold exactly the job this test enqueues.
    await resetQueue();

    const broker = new JobBroker(db);
    const resultService = new ResultService(db, replayStore);
    const scheduler = new TournamentSchedulerService(db, broker);
    const executionService = new MatchExecutionService(
      db,
      new MapService(db),
      artifactStore,
      replayStore,
      resultService,
      scheduler,
      broker,
      { spoolDir: path.join(tmpRoot, 'execution') }
    );
    const autoRunner = new TournamentAutoRunner(
      db,
      executionService,
      broker,
      new JobReconciler(db),
      buildPipeline,
      privateTestRunner,
      scheduler,
      { intervalMs: 3_600_000, buildsPerTick: 4, testsPerTick: 4 }
    );

    const testId = await insertSnapshot('QUEUED');
    expect(await broker.enqueueIfAbsent('TEST_BUILD', testId, 150, {})).toBe(true);

    // Creation alone must not schedule execution: only an accepted build does.
    const beforeTick = await db.query<{ job_type: string }>(
      `SELECT job_type FROM jobs WHERE target_id = $1 ORDER BY job_type`,
      [testId]
    );
    expect(beforeTick.rows).toEqual([{ job_type: 'TEST_BUILD' }]);

    const before = await officialCounts();
    await autoRunner.runOnce();
    expect(await officialCounts()).toEqual(before);
    expect(autoRunner.stats().testsCompleted).toBe(1);

    const jobs = await db.query<{ job_type: string; state: string }>(
      `SELECT job_type, state FROM jobs WHERE target_id = $1 ORDER BY job_type`,
      [testId]
    );
    expect(jobs.rows).toEqual([
      { job_type: 'TEST_BUILD', state: 'SUCCEEDED' },
      { job_type: 'TEST_GAME', state: 'SUCCEEDED' },
    ]);

    // Evidence pinned by the TEST_GAME completion: the snapshot it ran and the verdict.
    const completion = await db.query<{ evidence_payload: TestGameEvidence }>(
      `SELECT jc.evidence_payload
       FROM job_completions jc
       JOIN jobs j ON j.id = jc.job_id
       WHERE j.job_type = 'TEST_GAME' AND j.target_id = $1`,
      [testId]
    );
    expect(completion.rows[0].evidence_payload).toMatchObject({
      verdict: 'DECISIVE',
      reason: 'COMPLETED',
      details: { testId, status: 'COMPLETED' },
    });

    const row = await loadRow(testId);
    expect(row.status).toBe('COMPLETED');
    expect(row.replay_digest).not.toBeNull();
    expect(playedPayload(row).winner).toBe(1);
  });

  it('serves the team its history, detail and replay, and refuses everyone else', async () => {
    const okTestId = goodTestIds[0];

    const list = await privateTestRunner.listTests(tournamentId, teamId, memberActor);
    expect(list.map((test) => test.id)).toContain(okTestId);
    // Newest first, as the history route orders them.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].createdAt >= list[i].createdAt).toBe(true);
    }

    const detail = await privateTestRunner.getTest(okTestId, memberActor);
    expect(detail.status).toBe('COMPLETED');
    expect(detail.language).toBe('TYPESCRIPT');
    expect(detail.entrypoint).toBe('bot.ts');
    expect(detail.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.startedAt).not.toBeNull();
    expect(detail.completedAt).not.toBeNull();
    expect(detail.replayDigest).toBe((await loadRow(okTestId)).replay_digest);

    // A failed run reads back as `{error}` and has no replay object to serve.
    const failed = await privateTestRunner.getTest(materializationFailureId, memberActor);
    expect(failed.status).toBe('FAILED');
    expect(failed.result).toEqual({ error: expect.stringContaining('not found in ZIP files') });
    expect(failed.replayDigest).toBeNull();
    await expect(
      privateTestRunner.getTestReplay(materializationFailureId, memberActor)
    ).rejects.toThrow(/no replay/i);

    const replay = await privateTestRunner.getTestReplay(okTestId, memberActor);
    expect(replay.digest).toBe(detail.replayDigest);
    expect(replay.buffer.subarray(0, 8).toString('ascii')).toBe('OANTUTI2');

    // The public replay route serves official results only: a private TEST replay digest must not
    // unlock the same bytes through ResultService.
    const officialReader = new ResultService(db, replayStore);
    await expect(officialReader.getReplay(replay.digest)).rejects.toThrow(/not available/i);

    // Private tests stay team-only: the ADMIN submission-inspection right does not extend to them.
    await expect(privateTestRunner.listTests(tournamentId, teamId, adminActor)).rejects.toThrow(/owning team/);
    await expect(privateTestRunner.getTest(okTestId, adminActor)).rejects.toThrow(/owning team/);
    await expect(privateTestRunner.getTestReplay(okTestId, adminActor)).rejects.toThrow(/owning team/);
    await expect(privateTestRunner.getTest(okTestId, outsiderActor)).rejects.toThrow(/Forbidden/);
    await expect(privateTestRunner.listTests(tournamentId, teamId, outsiderActor)).rejects.toThrow(/Forbidden/);
    await expect(privateTestRunner.listTests(tournamentId, teamId, passwordChangeActor)).rejects.toThrow(
      /full scope/
    );

    // Unknown ids answer the 404 semantics instead of reaching a `uuid` column.
    await expect(privateTestRunner.getTest('not-a-uuid', memberActor)).rejects.toThrow(/not found/i);
    await expect(privateTestRunner.getTest(randomUUID(), memberActor)).rejects.toThrow(/not found/i);
    await expect(privateTestRunner.listTests(randomUUID(), teamId, memberActor)).rejects.toThrow(
      /Tournament not found/
    );
  });

  it('never hands a team an unrevealed HIDDEN map through a private practice run', async () => {
    // The newest map in the database is HIDDEN and not revealed. A practice run for a tournament that
    // has not committed its pool yet must not pick it: the team would see the organizer's secret map
    // in its own board and replay, which is the leak S08 forbids.
    const hiddenBoard = { ...BOARD, mapName: `hidden-trap-${runId}` };
    const hidden = await db.query<{ id: string }>(
      `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings)
       VALUES ($1, $2, $3, 'HIDDEN', '[]'::jsonb) RETURNING id`,
      [hiddenBoard.mapName, 'Hidden Trap Board', JSON.stringify(hiddenBoard)]
    );
    hiddenMapId = hidden.rows[0].id;
    await db.query(
      `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings)
       VALUES ($1, 1, $2, '[]'::jsonb)`,
      [hiddenMapId, JSON.stringify(hiddenBoard)]
    );

    // A tournament with no map commitment: the pre-lock state a team practises in.
    const practice = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
       VALUES ($1, $2, 'ROUND_ROBIN', 'REGISTRATION_OPEN', 0) RETURNING id`,
      [courseId, `Hidden Map Practice ${runId}`]
    );
    practiceTournamentId = practice.rows[0].id;
    const snapshot = await db.query<{ id: string }>(
      `INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, $4, 'TYPESCRIPT', 'bot.ts', 'QUEUED') RETURNING id`,
      [practiceTournamentId, teamId, adminActor.userId, goodDigest]
    );
    otherTestIds.push(snapshot.rows[0].id);

    expect(await buildPipeline.buildTestSnapshot(snapshot.rows[0].id)).toMatchObject({ status: 'COMPLETED' });
    expect(await privateTestRunner.runPrivateTest(snapshot.rows[0].id)).toEqual({ status: 'COMPLETED' });

    const payload = playedPayload(await loadRow(snapshot.rows[0].id));
    expect(payload.map.name).not.toBe('Hidden Trap Board');
    expect(payload.map.name).not.toBe(hiddenBoard.mapName);
  });

  it('runs a durable private TEST on a FINALIZED tournament without re-opening official state', async () => {
    // S10 deferred this journey to S11: after the real finalization the durable TEST path must still
    // work (02/03: TEST is allowed in every phase) while official intake stays closed and nothing
    // official moves.
    await db.query(`UPDATE tournaments SET state = 'FINALIZED' WHERE id = $1`, [tournamentId]);
    try {
      const before = await officialCounts();
      const greedy = readFileSync(path.resolve(process.cwd(), 'bots/greedy-bot.ts'), 'utf8');

      const receipt = await submissionService.createPrivateTest(
        tournamentId,
        teamId,
        { language: 'TYPESCRIPT', entrypoint: 'bot.ts', zipBuffer: createZip({ 'bot.ts': greedy }) },
        memberActor
      );
      otherTestIds.push(receipt.data.testId);

      expect(await buildPipeline.buildTestSnapshot(receipt.data.testId)).toMatchObject({ status: 'COMPLETED' });
      expect(await privateTestRunner.runPrivateTest(receipt.data.testId)).toEqual({ status: 'COMPLETED' });

      const row = await loadRow(receipt.data.testId);
      expect(row.status).toBe('COMPLETED');
      expect(row.replay_digest).not.toBeNull();
      expect(await officialCounts()).toEqual(before);

      // The official door stays shut while the tournament is FINALIZED.
      await expect(
        submissionService.submit(
          tournamentId,
          teamId,
          { language: 'TYPESCRIPT', entrypoint: 'bot.ts', zipBuffer: createZip({ 'bot.ts': greedy }) },
          memberActor
        )
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await db.query(`UPDATE tournaments SET state = 'REGISTRATION_OPEN' WHERE id = $1`, [tournamentId]);
    }
  });
});
