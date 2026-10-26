import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MapDescriptor } from '@oantuti/engine';
import type { BuildToolchain } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { JobBroker } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import { LocalJobBrokerTransport, type LocalJobBrokerOptions } from '../src/jobs/local-transport.js';
import { NativeAssignmentService } from '../src/jobs/native-assignment.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { CompiledArtifactStore } from '../src/builds/compiled-artifact-store.js';
import { PrivateTestResultService } from '../src/builds/private-test-result-service.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService } from '../src/results/service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { createZip } from './helpers/zip.js';

/**
 * The official GAME path through the native gateway, driven exactly the way the Rust supervisor
 * drives it: the trusted dispatcher receives a `claim`, answers with a server-built immutable
 * assignment whose inputs are per-attempt path grants, and only accepts a completion whose
 * supervisor observations the trusted side validates against the claimed workload and the native
 * rules verifier.
 *
 * Nothing here reaches into the dispatcher's internals or mints an authenticated execution by hand:
 * the acceptance decision is taken by the same service the production gateway wires in.
 */

const sampleMap: MapDescriptor = {
  mapName: 'native-acceptance-3x3',
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
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 1] },
  ],
};

/** Same three-ply throne breach the adjudication suite proves against the Rust verifier. */
const trace = [
  { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
  { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
  { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } },
];

const response = (body: unknown) => `${JSON.stringify(body)}\n`;
const observations = [
  { side: 1, ply: 0, responseNdjson: response({ status: 'READY' }) },
  { side: 2, ply: 0, responseNdjson: response({ status: 'READY' }) },
  { side: 1, ply: 1, responseNdjson: response({ action: 'MOVE', piece_id: 1, target: [1, 2] }) },
  { side: 2, ply: 2, responseNdjson: response({ action: 'MOVE', piece_id: 2, target: [1, 1] }) },
  { side: 1, ply: 3, responseNdjson: response({ action: 'MOVE', piece_id: 1, target: [2, 2] }) },
].map((observation) => ({
  ...observation,
  kind: 'RESPONSE' as const,
  cpuUsec: '1200',
  wallUsec: '2400',
  freezeConfirmed: true,
  terminationConfirmed: true,
}));

const gameEvidence = {
  winner: 1,
  reason: 'THRONE_BREACH',
  disposition: 'DECISIVE' as const,
  executionStatus: 'COMPLETED' as const,
  totalPly: trace.length,
  trace,
};

/** The operator runtime profile the gateway certifies; one entry per supported language. */
const toolchains: readonly BuildToolchain[] = [
  { language: 'PYTHON', imageDigest: '1'.repeat(64), version: '3.12.4', flags: [] },
  { language: 'TYPESCRIPT', imageDigest: '2'.repeat(64), version: '24.22.0', flags: ['--experimental-strip-types'] },
  { language: 'CPP', imageDigest: '3'.repeat(64), version: '13.3.0', flags: ['-O2', '-std=c++20'] },
];

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('native gateway accepts an official game only through a server-built assignment', () => {
  const db = new PostgresDatabase();
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const workerUid = (process.getuid?.() ?? 0) + 1;
  const pid = 411;

  let storageRoot: string;
  let policy: LocalJobBrokerOptions;
  let replays: ReplayStore;
  let artifacts: ArtifactStore;
  let broker: JobBroker;
  let assignments: NativeAssignmentService;
  let transport: LocalJobBrokerTransport;
  let courseId: string;
  let userIds: string[] = [];
  let teamIds: string[] = [];
  let tournamentId: string;
  let submissionIds: string[] = [];
  let sourceDigests: string[] = [];
  let encounterIds: string[] = [];
  let gameIds: string[] = [];

  const send = (operation: string, parameters: unknown, asPid = pid) =>
    transport['dispatch']({ uid: workerUid, pid: asPid, request: { operation, parameters } });

  const capacity = { buildSlots: 0, gameSlots: 1, runtimeProfileDigest: 'a'.repeat(64) };

  /** One game with its own GAME job, so a refusal cannot consume the acceptance case's lease. */
  async function createGame(): Promise<string> {
    const encounter = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, 'MAIN', 1, 1, $2, $3, 'RUNNING') RETURNING id`,
      [tournamentId, teamIds[0], teamIds[1]]
    );
    encounterIds.push(encounter.rows[0].id);
    const game = await db.query<{ id: string }>(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, 1, $2, $3, $4, 'PENDING') RETURNING id`,
      [encounter.rows[0].id, teamIds[0], teamIds[1], JSON.stringify(sampleMap)]
    );
    gameIds.push(game.rows[0].id);
    await broker.enqueue('GAME', game.rows[0].id);
    return game.rows[0].id;
  }

  /** Claims a game as the supervisor would and returns the assignment payload and lease. */
  async function claim(gameId: string): Promise<{ payload: Record<string, unknown>; lease: Record<string, unknown> }> {
    const claimed = (await send('claim', { capacity, options: { targetIds: [gameId] } })) as Record<string, unknown>;
    if (!claimed?.identity || !claimed?.payload) throw new Error('claim returned no assignment');
    return { payload: claimed.payload as Record<string, unknown>, lease: claimed.identity as Record<string, unknown> };
  }

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'arena-native-acceptance-'));
    policy = {
      executable: '/does-not-exist/arena-job-broker',
      socketPath: '/does-not-exist/broker.sock',
      workerUid,
      socketGid: process.getgid?.() ?? 0,
      grantGid: process.getgid?.() ?? 0,
      deploymentGeneration: 731,
      runtimeProfileDigest: capacity.runtimeProfileDigest,
      maxBuildSlots: 0,
      // Refusal cases deliberately leave their lease to the reconciler, so the policy must tolerate
      // the file's case count without masking the capacity check.
      maxGameSlots: 8,
      spoolRoot: join(storageRoot, 'spool'),
      compiledArtifactsDir: join(storageRoot, 'compiled'),
      toolchains,
    };
    artifacts = new ArtifactStore(db, join(storageRoot, 'sources'));
    replays = new ReplayStore(join(storageRoot, 'replays'), join(storageRoot, 'staging'));

    broker = new JobBroker(db, policy.deploymentGeneration);
    const scheduler = new TournamentSchedulerService(db, broker);
    const resultService = new ResultService(db, replays, new TraceVerifier(), async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
    assignments = new NativeAssignmentService(db, artifacts, resultService, scheduler, broker, new PrivateTestResultService(db, replays), {
      runtimeProfileDigest: policy.runtimeProfileDigest,
      spoolRoot: policy.spoolRoot,
      toolchains: policy.toolchains,
      compiledArtifacts: new CompiledArtifactStore(policy.compiledArtifactsDir),
      grantGid: policy.grantGid,
    });
    transport = new LocalJobBrokerTransport(db, broker, policy, assignments);
    await assignments.start();

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Native Acceptance Course') RETURNING id`,
      [`NATIVE_${run}`]
    );
    courseId = course.rows[0].id;

    for (const [index, role] of [['A', 'STUDENT'], ['B', 'STUDENT']] as const) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', $3, 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`native_${index}_${run}`, `Native ${index}`, role]
      );
      userIds.push(user.rows[0].id);
      const team = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `Native Team ${index}`, user.rows[0].id]
      );
      teamIds.push(team.rows[0].id);
    }

    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, max_teams)
       VALUES ($1, 'Native Acceptance Cup', 'ROUND_ROBIN', 'RUNNING', 4) RETURNING id`,
      [courseId]
    );
    tournamentId = tournament.rows[0].id;

    // Real zips in the artifact store: the assignment is built from stored bytes, not from a
    // fixture digest, so a digest mismatch would be caught rather than passed through.
    for (const [index, teamId] of teamIds.entries()) {
      const zip = createZip({ 'main.py': `# native acceptance bot ${index}\nprint('ready')\n` });
      const stored = await artifacts.storeSource(zip, 'PYTHON', 'main.py');
      sourceDigests.push(stored.digest);
      const submission = await db.query<{ id: string }>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, 1, $4, 'PYTHON', 'main.py', 'READY') RETURNING id`,
        [tournamentId, teamId, userIds[index], stored.digest]
      );
      submissionIds.push(submission.rows[0].id);
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, frozen_submission_id)
         VALUES ($1, $2, 'ELIGIBLE', $3)`,
        [tournamentId, teamId, submission.rows[0].id]
      );
    }
  });

  afterAll(async () => {
    await db.query('DELETE FROM job_completions WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('UPDATE jobs SET active_lease_id = NULL WHERE target_id = ANY($1::uuid[])', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('DELETE FROM jobs WHERE target_id = ANY($1::uuid[])', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('DELETE FROM accepted_results WHERE game_id = ANY($1::uuid[])', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('DELETE FROM result_versions WHERE game_id = ANY($1::uuid[])', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('DELETE FROM games WHERE id = ANY($1::uuid[])', [gameIds.length ? gameIds : [randomUUID()]]);
    await db.query('DELETE FROM encounters WHERE id = ANY($1::uuid[])', [encounterIds.length ? encounterIds : [randomUUID()]]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    await db.query('DELETE FROM tournament_entries WHERE tournament_id = $1', [tournamentId]);
    await db.query('DELETE FROM submissions WHERE id = ANY($1::uuid[])', [submissionIds.length ? submissionIds : [randomUUID()]]);
    await db.query('DELETE FROM submission_sources WHERE digest = ANY($1::text[])', [sourceDigests.length ? sourceDigests : ['']]);
    await db.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [teamIds.length ? teamIds : [randomUUID()]]);
    await db.query('DELETE FROM courses WHERE id = $1', [courseId]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds.length ? userIds : [randomUUID()]]);
    await db.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('builds the assignment from stored artifacts, pinning them as per-attempt grants', async () => {
    const gameId = await createGame();
    const other = await createGame();
    // TEST_GAME is now offered to this worker, but its assignment is built from the snapshot row it
    // targets: a job pointing at a game id is refused instead of being leased with a game payload.
    await broker.enqueue('TEST_GAME', other);
    await expect(send('claim', { capacity, options: { jobTypes: ['TEST_GAME'] } })).rejects.toMatchObject({ code: 'TEST_NOT_FOUND' });

    const { payload, lease } = await claim(gameId);
    expect(payload.version).toBe(1);
    expect(payload.jobType).toBe('GAME');
    expect(payload.targetId).toBe(gameId);
    expect(payload.gameId).toBe(gameId);
    expect(payload.runtimeProfileDigest).toBe(policy.runtimeProfileDigest);
    expect(payload.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    const bots = payload.bots as Array<{
      side: number;
      sourceDigest: string;
      language: string;
      entrypoint: string;
      source: { path: string; digest: string; sizeBytes: number };
      artifact?: unknown;
    }>;
    expect(bots.map((bot) => bot.side)).toEqual([1, 2]);
    expect(bots.map((bot) => bot.sourceDigest)).toEqual(sourceDigests);
    for (const bot of bots) {
      expect(bot.language).toBe('PYTHON');
      // Interpreted languages run the granted source, so no compiled artifact may be granted.
      expect(bot.artifact).toBeUndefined();
      expect(bot.source.path.startsWith(`${attemptDirectory}/`)).toBe(true);
      const info = await stat(bot.source.path);
      expect(info.mode & 0o777).toBe(0o640);
      expect(info.size).toBe(bot.source.sizeBytes);
      expect(sha256(await readFile(bot.source.path))).toBe(bot.source.digest);
    }
  });

  it('accepts a verified completion, records the official result and drops the attempt spool', async () => {
    const gameId = await createGame();
    const { payload, lease } = await claim(gameId);
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    expect((await stat(attemptDirectory)).isDirectory()).toBe(true);

    const pinned = (await send('prepareCompletion', {
      lease,
      evidence: { manifestDigest: payload.manifestDigest, gameEvidence, observations },
    })) as Record<string, unknown>;
    const beforeAcceptance = await db.query(`SELECT 1 FROM accepted_results WHERE game_id=$1`, [gameId]);
    expect(beforeAcceptance.rows).toHaveLength(0);
    const pending = await db.query<{ state: string }>(`SELECT state FROM jobs WHERE id=$1`, [lease.jobId]);
    expect(pending.rows[0].state).toBe('COMPLETION_PENDING');
    // Simulate a dead gateway: startup removes transient spools and process-local assignments.
    assignments['assignments'].clear();
    await assignments.start();
    const recovered = await new JobReconciler(db, policy.deploymentGeneration, broker).reconcile({ reconcilerId: 'restart-recovery', pid: 9999, uid: 1000 });
    expect(recovered.orphanedCompletionsAccepted).toBeGreaterThanOrEqual(1);
    const completion = { ...(pinned.data as Record<string, unknown>), deploymentGeneration: policy.deploymentGeneration };
    const completed = (await send('complete', { completion })) as Record<string, unknown>;
    expect(completed).toMatchObject({ data: { state: 'ACCEPTED' } });
    expect(await send('complete', { completion })).toEqual(completed);

    // The official result's pinned evidence is tagged as a game (03 §173): a reader of the completion
    // row can tell a match verdict from a build verdict without guessing from the payload's shape.
    const pinnedEvidence = await db.query<{ evidence_payload: Record<string, unknown> }>(
      `SELECT jc.evidence_payload
       FROM job_completions jc JOIN jobs j ON j.id = jc.job_id
       WHERE j.id = $1`,
      [lease.jobId]
    );
    expect(pinnedEvidence.rows[0].evidence_payload).toMatchObject({
      kind: 'GAME',
      game: { verdict: 'DECISIVE', winner: 1, reason: 'THRONE_BREACH' },
    });

    const accepted = await db.query<{ result_version_id: string }>(
      'SELECT result_version_id FROM accepted_results WHERE game_id = $1',
      [gameId]
    );
    expect(accepted.rows).toHaveLength(1);
    const version = await db.query<{ winner: number; reason: string; action_trace_digest: string; disposition: string }>(
      'SELECT winner, reason, action_trace_digest, disposition FROM result_versions WHERE id = $1',
      [accepted.rows[0].result_version_id]
    );
    expect(version.rows[0]).toMatchObject({ winner: 1, reason: 'THRONE_BREACH', disposition: 'DECISIVE' });
    expect(version.rows[0].action_trace_digest).toBe(createHash('sha256').update(JSON.stringify(trace)).digest('hex'));
    const game = await db.query<{ status: string }>('SELECT status FROM games WHERE id = $1', [gameId]);
    expect(game.rows[0].status).toBe('COMPLETED');
    // The pinned bytes exist exactly as long as the attempt does.
    await expect(stat(attemptDirectory)).rejects.toThrow();
  });

  it('rejects a submission whose observations do not exist, and a trace that disagrees with them', async () => {
    const noObservations = await createGame();
    const first = await claim(noObservations);
    await expect(
      send('prepareCompletion', {
        lease: first.lease,
        evidence: { manifestDigest: first.payload.manifestDigest, gameEvidence },
      })
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
    const unaccepted = await db.query('SELECT 1 FROM accepted_results WHERE game_id = $1', [noObservations]);
    expect(unaccepted.rows).toHaveLength(0);

    const tampered = await createGame();
    const second = await claim(tampered);
    const lyingTrace = [{ ...trace[0], move: { pieceId: 1, targetPos: { x: 2, y: 1 } } }, trace[1], trace[2]];
    await expect(
      send('prepareCompletion', {
        lease: second.lease,
        evidence: {
          manifestDigest: second.payload.manifestDigest,
          gameEvidence: { ...gameEvidence, trace: lyingTrace },
          observations,
        },
      })
    ).rejects.toThrow();
    expect((await db.query('SELECT 1 FROM accepted_results WHERE game_id = $1', [tampered])).rows).toHaveLength(0);
  });

  it('binds acceptance to the lease owner and the claimed generation', async () => {
    const gameId = await createGame();
    const { payload, lease } = await claim(gameId);
    await expect(send('heartbeat', { lease }, 412)).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
    await expect(
      send('prepareCompletion', {
        lease: { ...lease, fencingToken: String(Number(lease.fencingToken) + 1) },
        evidence: { manifestDigest: payload.manifestDigest, gameEvidence, observations },
      })
    ).rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
    await expect(send('complete', { completion: { completionId: randomUUID(), evidenceDigest: 'b'.repeat(64), deploymentGeneration: policy.deploymentGeneration } }))
      .rejects.toMatchObject({ code: 'WORKER_MISMATCH' });
    expect((await db.query('SELECT 1 FROM accepted_results WHERE game_id = $1', [gameId])).rows).toHaveLength(0);
  });

  it('pins no completion and publishes no result after the real lease expires', async () => {
    const gameId = await createGame();
    const { payload, lease } = await claim(gameId);
    await db.query(`UPDATE job_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [lease.attemptId]);
    await expect(send('prepareCompletion', { lease, evidence: { manifestDigest: payload.manifestDigest, gameEvidence, observations } })).rejects.toMatchObject({ code: 'FENCE_STALE_OR_EXPIRED' });
    expect((await db.query(`SELECT 1 FROM accepted_results WHERE game_id=$1`, [gameId])).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM job_completions WHERE job_id=$1`, [lease.jobId])).rows).toHaveLength(0);
  });

  it('abandons the attempt spool as soon as its lease is gone', async () => {
    const gameId = await createGame();
    const { lease } = await claim(gameId);
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    expect((await stat(attemptDirectory)).isDirectory()).toBe(true);

    // The reconciler's own condition: the lease is no longer renewable, so the worker that owns it
    // is gone and the bytes this attempt was pinned must not outlive it.
    await db.query(`UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [lease.attemptId]);
    await expect(send('heartbeat', { lease })).resolves.toMatchObject({ status: 'STOP' });
    await expect(stat(attemptDirectory)).rejects.toThrow();
  });

  it('refuses the API identity as supervisor and enforces slot policy, runtime profile and generation', async () => {
    expect(() => new LocalJobBrokerTransport(db, broker, { ...policy, workerUid: process.getuid?.() ?? 0 }, assignments))
      .toThrow('separate UID');

    // Slot accounting is per worker UID, so this case gets its own supervisor identity.
    const strictUid = workerUid + 1;
    const strict = new LocalJobBrokerTransport(db, broker, { ...policy, workerUid: strictUid, maxGameSlots: 1 }, assignments);
    const strictSend = (operation: string, parameters: unknown) =>
      strict['dispatch']({ uid: strictUid, pid: 499, request: { operation, parameters } });
    const first = await createGame();
    await createGame();

    await expect(strictSend('claim', { capacity: { ...capacity, runtimeProfileDigest: 'c'.repeat(64) } }))
      .rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    const claimed = (await strictSend('claim', { capacity, options: { targetIds: [first] } })) as Record<string, unknown>;
    expect(claimed).toMatchObject({ jobType: 'GAME', targetId: first });
    const lease = claimed.identity as Record<string, unknown>;
    await expect(strictSend('claim', { capacity })).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    await expect(strictSend('heartbeat', { lease: { ...lease, deploymentGeneration: 1 } }))
      .rejects.toMatchObject({ code: 'GENERATION_MISMATCH' });
    await expect(strictSend('heartbeat', { lease })).resolves.toMatchObject({ status: 'ACTIVE' });

    // A peer that stops heartbeating must not escape its own slot budget: the attempt stays ACTIVE
    // (and therefore counted) until reclamation expires it.
    await db.query(
      `UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [lease.attemptId]
    );
    await expect(strictSend('claim', { capacity })).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });

    // Reclamation is what frees the slot.
    await new JobReconciler(db, policy.deploymentGeneration).reconcile({
      reconcilerId: 'test-reconciler',
      pid: 9999,
      uid: 1000,
    });
    const reclaimed = (await strictSend('claim', { capacity })) as Record<string, unknown> | null;
    expect(reclaimed?.jobType).toBe('GAME');
    expect(reclaimed?.targetId).not.toBe(first);
  });
});
