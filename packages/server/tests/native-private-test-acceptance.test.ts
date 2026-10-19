import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import type { MapDescriptor } from '@oantuti/engine';
import type { BuildToolchain } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { JobBroker } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import { PROCESS_RECONCILER_IDENTITY } from '../src/jobs/identity.js';
import { LocalJobBrokerTransport, type LocalJobBrokerOptions } from '../src/jobs/local-transport.js';
import { NativeAssignmentService, TEST_GAME_JOB_PRIORITY } from '../src/jobs/native-assignment.js';
import { ArtifactStore, computeCanonicalManifest, parseAndValidateZip } from '../src/submissions/artifact-store.js';
import { CompiledArtifactStore, compiledArtifactKey } from '../src/builds/compiled-artifact-store.js';
import { INFRASTRUCTURE_FAILURE, PrivateTestResultService } from '../src/builds/private-test-result-service.js';
import { ReplayStore, type ReplayV2Payload } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService } from '../src/results/service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { createZip } from './helpers/zip.js';

/**
 * The private-test path through the native gateway: a TEST_GAME claim is answered with an
 * assignment built from the snapshot row (white), the opponent the control plane picks (black) and
 * the board the dev runner would have played, and its completion is held to the official game bar
 * before being recorded on the snapshot only.
 *
 * This file drives the real services — nothing reaches into the dispatcher's internals and no
 * authenticated execution is minted by hand — and asserts the two things a private test must never
 * do: leave its snapshot RUNNING when the worker dies, and move an official table.
 */

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const workerUid = (process.getuid?.() ?? 0) + 1;
const pid = 517;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const BOARD_NAME = `Private Native Board ${run}`;

/** 3×3 board with the same three-ply throne breach the official game suite proves. */
const BOARD: MapDescriptor = {
  mapName: `private-native-3x3-${run}`,
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

const toolchains: readonly BuildToolchain[] = [
  { language: 'PYTHON', imageDigest: '1'.repeat(64), version: '3.12.4', flags: [] },
  { language: 'TYPESCRIPT', imageDigest: '2'.repeat(64), version: '24.22.0', flags: ['--experimental-strip-types'] },
  { language: 'CPP', imageDigest: '3'.repeat(64), version: '13.3.0', flags: ['-O2', '-std=c++20'] },
];
const toolchainFor = (language: 'PYTHON' | 'TYPESCRIPT' | 'CPP'): BuildToolchain =>
  toolchains.find((toolchain) => toolchain.language === language)!;

const PY_ARTIFACT = Buffer.from('PYC-BUNDLE\n'.repeat(32));

interface SnapshotRow {
  readonly id: string;
  readonly status: string;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly replay_digest: string | null;
  readonly result_payload: unknown;
}

interface OfficialCounts {
  accepted: string;
  versions: string;
  ratings: string;
  replayObjects: string;
  standings: string;
  submissions: string;
  maxReceiptOrdinal: string;
  frozenEntries: string;
}

interface Grant {
  path: string;
  digest: string;
  sizeBytes: number;
}

describe('native gateway runs a private test without touching an official table', () => {
  const db = new PostgresDatabase();

  let storageRoot: string;
  let policy: LocalJobBrokerOptions;
  let artifacts: ArtifactStore;
  let replays: ReplayStore;
  let broker: JobBroker;
  let assignments: NativeAssignmentService;
  let transport: LocalJobBrokerTransport;

  let courseId: string;
  const userIds: string[] = [];
  const teamIds: string[] = [];
  let tournamentId: string;
  let mapId: string;
  const snapshotIds: string[] = [];
  const submissionIds: string[] = [];
  const sourceDigests: string[] = [];

  /** Source of the snapshots (the team's own bot), the pinned opponent, and the build case. */
  let snapshotDigest: string;
  let opponentDigest: string;
  let buildDigest: string;

  const capacity = { buildSlots: 1, gameSlots: 1, runtimeProfileDigest: 'e'.repeat(64) };

  const send = (operation: string, parameters: unknown, asPid = pid) =>
    transport['dispatch']({ uid: workerUid, pid: asPid, request: { operation, parameters } });

  /** Inserts one snapshot; the team decides which opponent the control plane will pick. */
  async function createSnapshot(
    options: {
      status?: string;
      teamIndex?: number;
      language?: 'PYTHON' | 'TYPESCRIPT';
      entrypoint?: string;
      sourceDigest?: string;
    } = {}
  ): Promise<string> {
    const index = options.teamIndex ?? 1;
    const res = await db.query<{ id: string }>(
      `INSERT INTO test_snapshots
         (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        tournamentId,
        teamIds[index],
        userIds[index],
        options.sourceDigest ?? snapshotDigest,
        options.language ?? 'TYPESCRIPT',
        options.entrypoint ?? 'bot.ts',
        options.status ?? 'COMPLETED',
      ]
    );
    snapshotIds.push(res.rows[0].id);
    return res.rows[0].id;
  }

  async function loadSnapshotRow(testId: string): Promise<SnapshotRow> {
    const res = await db.query<SnapshotRow>(
      `SELECT id, status, started_at, completed_at, replay_digest, result_payload
       FROM test_snapshots WHERE id = $1`,
      [testId]
    );
    return res.rows[0];
  }

  /** Claims a TEST_GAME job exactly as the supervisor does, narrowed to the snapshot it targets. */
  async function claimTest(testId: string): Promise<{ payload: Record<string, unknown>; lease: Record<string, unknown> }> {
    const claimed = (await send('claim', {
      capacity,
      options: { targetIds: [testId], jobTypes: ['TEST_GAME'] },
    })) as Record<string, unknown>;
    if (!claimed?.identity || !claimed?.payload) throw new Error('claim returned no assignment');
    return { payload: claimed.payload as Record<string, unknown>, lease: claimed.identity as Record<string, unknown> };
  }

  /** Prepares and completes a lease with the given evidence. */
  async function complete(lease: Record<string, unknown>, evidence: unknown): Promise<Record<string, unknown>> {
    const pinned = (await send('prepareCompletion', { lease, evidence })) as Record<string, unknown>;
    return (await send('complete', {
      completion: { ...(pinned.data as Record<string, unknown>), deploymentGeneration: policy.deploymentGeneration },
    })) as Record<string, unknown>;
  }

  /** The completion shape a private test submits: the game evidence plus its observations. */
  const privateEvidence = (payload: Record<string, unknown>, submittedTrace = trace) => ({
    manifestDigest: payload.manifestDigest,
    gameEvidence: { ...gameEvidence, trace: submittedTrace, totalPly: submittedTrace.length },
    observations,
  });

  /** Pins one grant as the supervisor materializes it: path, digest, size and mode all verified. */
  async function assertGrant(grant: Grant, attemptDirectory: string): Promise<Buffer> {
    expect(grant.path.startsWith(`${attemptDirectory}/`)).toBe(true);
    const info = await stat(grant.path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.size).toBe(grant.sizeBytes);
    const bytes = await readFile(grant.path);
    expect(sha256(bytes)).toBe(grant.digest);
    return bytes;
  }

  /**
   * Re-checks a pinned source ZIP against the fields the worker's extractor reads but the intake
   * validator ignores: the stored checksum (verified against an independent CRC-32), the storage
   * method, the declared sizes and the Unix mode the extractor's symlink ban looks at.
   */
  function assertStoredZipEntry(zip: Buffer, entrypoint: string, expected: Buffer): void {
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(1);
    const directory = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt32LE(directory)).toBe(0x02014b50);
    expect(zip.readUInt16LE(directory + 10)).toBe(0); // STORED, so no inflate is needed.
    expect(zip.readUInt32LE(directory + 16)).toBe(zlib.crc32(expected));
    expect(zip.readUInt32LE(directory + 20)).toBe(expected.length);
    expect(zip.readUInt32LE(directory + 24)).toBe(expected.length);
    const nameLength = zip.readUInt16LE(directory + 28);
    expect(zip.toString('utf8', directory + 46, directory + 46 + nameLength)).toBe(entrypoint);
    // External attributes: a regular file, so a symlink ban never fires.
    expect(((zip.readUInt32LE(directory + 38) >>> 16) & 0o170000) === 0o120000).toBe(false);
    const local = zip.readUInt32LE(directory + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    expect(zip.subarray(dataStart, dataStart + expected.length).equals(expected)).toBe(true);
  }

  /** Row counts, receipt ordinals and frozen pointers a private test must never move. */
  async function officialCounts(): Promise<OfficialCounts> {
    const res = await db.query<OfficialCounts>(
      `SELECT (SELECT count(*) FROM accepted_results)::text AS accepted,
              (SELECT count(*) FROM result_versions)::text AS versions,
              (SELECT count(*) FROM rating_events)::text AS ratings,
              (SELECT count(*) FROM replay_objects)::text AS "replayObjects",
              (SELECT count(*) FROM standings_snapshots)::text AS standings,
              (SELECT count(*) FROM submissions WHERE tournament_id = $1)::text AS submissions,
              (SELECT COALESCE(max(receipt_ordinal), 0) FROM submissions WHERE tournament_id = $1)::text AS "maxReceiptOrdinal",
              (SELECT COALESCE(string_agg(frozen_submission_id::text, ',' ORDER BY team_id::text), '')
                 FROM tournament_entries WHERE tournament_id = $1)::text AS "frozenEntries"`,
      [tournamentId]
    );
    return res.rows[0];
  }

  /** Stages an artifact the way the supervisor does: ascending chunks, one digest throughout. */
  async function stageArtifact(lease: Record<string, unknown>, bytes: Buffer): Promise<string> {
    const digest = sha256(bytes);
    let last: Record<string, unknown> | undefined;
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      const chunk = bytes.subarray(offset, Math.min(offset + 1024, bytes.length));
      last = (await send('stageArtifact', {
        lease,
        chunk: { offset, data: chunk.toString('base64'), digest, sizeBytes: bytes.length, entrypoint: 'bot' },
      })) as Record<string, unknown>;
    }
    expect(last).toMatchObject({ staged: true, received: bytes.length });
    return digest;
  }

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'arena-native-private-'));
    policy = {
      executable: '/does-not-exist/arena-job-broker',
      socketPath: '/does-not-exist/broker.sock',
      workerUid,
      socketGid: process.getgid?.() ?? 0,
      deploymentGeneration: 741,
      runtimeProfileDigest: capacity.runtimeProfileDigest,
      maxBuildSlots: 2,
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
      toolchains,
      compiledArtifacts: new CompiledArtifactStore(policy.compiledArtifactsDir),
    });
    transport = new LocalJobBrokerTransport(db, broker, policy, assignments);
    await assignments.start();

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Native Private Course') RETURNING id`,
      [`NATIVE_PRIVATE_${run}`]
    );
    courseId = course.rows[0].id;

    // Team 0 freezes a READY receipt (the OWN_SUBMISSION opponent); team 1 has none, so its tests
    // play the repo baseline.
    for (const [index, label] of [['A', 'STUDENT'], ['B', 'STUDENT']] as const) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', $3, 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`native_private_${index}_${run}`, `Native Private ${index}`, label]
      );
      userIds.push(user.rows[0].id);
      const team = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `Native Private Team ${index}`, user.rows[0].id]
      );
      teamIds.push(team.rows[0].id);
    }

    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, max_teams)
       VALUES ($1, 'Native Private Cup', 'ROUND_ROBIN', 'RUNNING', 4) RETURNING id`,
      [courseId]
    );
    tournamentId = tournament.rows[0].id;

    // A committed board: the map resolution must pin the exact version the tournament plays.
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
    await db.query(
      `INSERT INTO tournament_map_commitments (tournament_id, map_id, map_version, committed_by_user_id)
       VALUES ($1, $2, 1, $3)`,
      [tournamentId, mapId, userIds[0]]
    );

    snapshotDigest = (await artifacts.storeSource(createZip({ 'bot.ts': '// snapshot bot\n' }), 'TYPESCRIPT', 'bot.ts')).digest;
    opponentDigest = (await artifacts.storeSource(createZip({ 'opponent.ts': '// frozen opponent\n' }), 'TYPESCRIPT', 'opponent.ts')).digest;
    buildDigest = (await artifacts.storeSource(createZip({ 'main.py': "# build-gated bot\n" }), 'PYTHON', 'main.py')).digest;
    sourceDigests.push(snapshotDigest, opponentDigest, buildDigest);

    const frozen = await db.query<{ id: string }>(
      `INSERT INTO submissions
         (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, 1, $4, 'TYPESCRIPT', 'opponent.ts', 'READY') RETURNING id`,
      [tournamentId, teamIds[0], userIds[0], opponentDigest]
    );
    submissionIds.push(frozen.rows[0].id);
    await db.query(
      `INSERT INTO tournament_entries (tournament_id, team_id, status, frozen_submission_id)
       VALUES ($1, $2, 'ELIGIBLE', $3)`,
      [tournamentId, teamIds[0], frozen.rows[0].id]
    );
  });

  afterAll(async () => {
    const targets = [...snapshotIds, ...submissionIds];
    const ids = targets.length > 0 ? targets : [randomUUID()];
    await db.query('DELETE FROM job_completions WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))', [ids]);
    await db.query('UPDATE jobs SET active_lease_id = NULL WHERE target_id = ANY($1::uuid[])', [ids]);
    await db.query('DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))', [ids]);
    await db.query('DELETE FROM jobs WHERE target_id = ANY($1::uuid[])', [ids]);
    await db.query('DELETE FROM audit_events WHERE resource_id = ANY($1::text[])', [ids]);
    await db.query('DELETE FROM test_snapshots WHERE id = ANY($1::uuid[])', [snapshotIds.length > 0 ? snapshotIds : [randomUUID()]]);
    // Every snapshot built from this suite's sources goes, whether or not the id list recorded it:
    // a surviving row would block the source delete on the declared foreign key.
    await db.query('DELETE FROM test_snapshots WHERE source_digest = ANY($1::text[])', [sourceDigests.length > 0 ? sourceDigests : ['none']]);
    // The frozen pointer references the submission, so the entry goes first.
    await db.query('DELETE FROM tournament_entries WHERE tournament_id = $1', [tournamentId]);
    await db.query('DELETE FROM submissions WHERE id = ANY($1::uuid[])', [submissionIds.length > 0 ? submissionIds : [randomUUID()]]);
    await db.query('DELETE FROM tournament_map_commitments WHERE tournament_id = $1', [tournamentId]);
    await db.query('DELETE FROM map_versions WHERE map_id = $1', [mapId]);
    await db.query('DELETE FROM maps WHERE id = $1', [mapId]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    await db.query('DELETE FROM submission_sources WHERE digest = ANY($1::text[])', [sourceDigests]);
    await db.query('DELETE FROM teams WHERE course_id = $1', [courseId]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await db.query('DELETE FROM courses WHERE id = $1', [courseId]);
    await db.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  // A case that ends while holding a lease must not spend the next case's slot budget: production
  // frees such an attempt by reclamation within seconds, and a suite must not depend on that clock.
  beforeEach(async () => {
    await db.query(
      `UPDATE job_attempts SET state = 'EXPIRED', error_details = 'TEST_ISOLATION'
        WHERE worker_id LIKE $1 AND state = 'ACTIVE'`,
      [`native-uid-${workerUid}:%`]
    );
  });

  it('pins the snapshot against the repo baseline and claims it RUNNING', async () => {
    const testId = await createSnapshot();
    expect(await broker.enqueueIfAbsent('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY)).toBe(true);

    const { payload, lease } = await claimTest(testId);
    expect(payload).toMatchObject({
      version: 1,
      jobType: 'TEST_GAME',
      targetId: testId,
      testId,
      maxTurns: 300,
      runtimeProfileDigest: policy.runtimeProfileDigest,
      opponent: { kind: 'BASELINE', label: 'greedy-bot.ts' },
    });
    expect(payload.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.rulesRevision).toBe('ArenaGameplay/v2');

    // The canonical manifest is the contract with the worker: the snapshot id is the game id the
    // engine binds to, the attempt is the lease's, and the digest is over exactly these bytes.
    const manifest = JSON.parse(payload.canonicalManifest as string) as Record<string, unknown>;
    expect(manifest).toMatchObject({ gameId: testId, attemptId: lease.attemptId, maxPly: 300 });
    expect((manifest.map as Record<string, unknown>).name).toBe(BOARD.mapName);
    expect(createHash('sha256').update(payload.canonicalManifest as string).digest('hex')).toBe(payload.manifestDigest);

    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    const bots = payload.bots as Array<{ side: number; sourceDigest: string; language: string; entrypoint: string; source: Grant; artifact?: unknown }>;
    expect(bots.map((bot) => bot.side)).toEqual([1, 2]);
    expect(bots[0]).toMatchObject({ sourceDigest: snapshotDigest, language: 'TYPESCRIPT', entrypoint: 'bot.ts' });
    expect(bots[0].artifact).toBeUndefined();
    await assertGrant(bots[0].source, attemptDirectory);

    // The baseline travels as a source ZIP the worker can materialize, with the manifest digest of
    // the packaged bytes — and no artifact, because TypeScript has no compile step.
    expect(bots[1]).toMatchObject({ sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/), language: 'TYPESCRIPT', entrypoint: 'greedy-bot.ts' });
    expect(bots[1].artifact).toBeUndefined();
    const baselineZip = await assertGrant(bots[1].source, attemptDirectory);
    assertStoredZipEntry(baselineZip, 'greedy-bot.ts', await readFile(join(process.cwd(), 'bots/greedy-bot.ts')));
    const extracted = parseAndValidateZip(baselineZip, 'TYPESCRIPT', 'greedy-bot.ts');
    expect(extracted.files.map((file) => file.path)).toEqual(['greedy-bot.ts']);
    expect(computeCanonicalManifest(extracted.files, 'TYPESCRIPT', 'greedy-bot.ts', extracted.expandedBytes).digest).toBe(bots[1].sourceDigest);

    const row = await loadSnapshotRow(testId);
    expect(row.status).toBe('RUNNING');
    expect(row.started_at).not.toBeNull();
    expect(row.result_payload).toBeNull();
    expect(row.replay_digest).toBeNull();
  });

  it('pins the team latest READY receipt when the snapshot team has one', async () => {
    const testId = await createSnapshot({ teamIndex: 0 });
    expect(await broker.enqueueIfAbsent('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY)).toBe(true);

    const { payload } = await claimTest(testId);
    expect(payload.opponent).toEqual({ kind: 'OWN_SUBMISSION', label: 'submission #1' });
    const bots = payload.bots as Array<{ side: number; sourceDigest: string; entrypoint: string }>;
    expect(bots[1]).toMatchObject({ sourceDigest: opponentDigest, entrypoint: 'opponent.ts' });
  });

  it('loses a concurrent claim of the same snapshot instead of playing it twice', async () => {
    const testId = await createSnapshot();
    // A duplicated job — a retried request, a stale queue — must not buy a second run.
    await broker.enqueue('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY, {});
    await broker.enqueue('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY, {});

    const first = await claimTest(testId);
    expect(await loadSnapshotRow(testId)).toMatchObject({ status: 'RUNNING' });
    const startedAt = (await loadSnapshotRow(testId)).started_at?.getTime();

    await expect(claimTest(testId)).rejects.toMatchObject({ code: 'TEST_ALREADY_CLAIMED' });
    const row = await loadSnapshotRow(testId);
    expect(row.status).toBe('RUNNING');
    expect(row.started_at?.getTime()).toBe(startedAt);
    expect(row.result_payload).toBeNull();

    // The loser built no spool of its own; the winner's attempt directory is the only one.
    const attempts = (await readdir(policy.spoolRoot)).filter((entry) => entry === first.lease.attemptId);
    expect(attempts).toHaveLength(1);
  });

  it('releases the snapshot when its claim is abandoned, so a retry can claim it again', async () => {
    const testId = await createSnapshot();
    await broker.enqueue('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY, {});
    const { lease } = await claimTest(testId);
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    expect((await stat(attemptDirectory)).isDirectory()).toBe(true);

    // The worker is gone: its lease is no longer renewable, so the claim goes with it.
    await db.query(`UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [lease.attemptId]);
    await expect(send('heartbeat', { lease })).resolves.toMatchObject({ status: 'STOP' });

    const released = await loadSnapshotRow(testId);
    expect(released.status).toBe('COMPLETED');
    expect(released.started_at).toBeNull();
    expect(released.result_payload).toBeNull();
    await expect(stat(attemptDirectory)).rejects.toThrow();

    // The retried job claims the same snapshot again, on a fresh attempt.
    await broker.enqueue('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY, {});
    const retry = await claimTest(testId);
    expect(retry.payload.testId).toBe(testId);
    expect((await loadSnapshotRow(testId)).status).toBe('RUNNING');
    expect((await loadSnapshotRow(testId)).started_at).not.toBeNull();
  });

  it('records a verified match on the snapshot only, with a replay that resolves', async () => {
    const testId = await createSnapshot();
    await broker.enqueue('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY, {});
    const { payload, lease } = await claimTest(testId);
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);

    const before = await officialCounts();
    const completed = await complete(lease, privateEvidence(payload));
    expect(completed).toMatchObject({ data: { state: 'ACCEPTED' } });
    expect((completed.data as Record<string, unknown>).resultVersionId).toBeUndefined();

    // The private run pins the same game shape under a TEST_GAME tag: it is a real match, and the
    // tag is what keeps a practice verdict from ever being read as an official one (03 §173). Its
    // `reason` is the snapshot's own terminal status, since the ledger has no verdict to name.
    const pinnedEvidence = await db.query<{ evidence_payload: Record<string, unknown> }>(
      `SELECT jc.evidence_payload
       FROM job_completions jc JOIN jobs j ON j.id = jc.job_id
       WHERE j.id = $1`,
      [lease.jobId]
    );
    expect(pinnedEvidence.rows[0].evidence_payload).toMatchObject({
      kind: 'TEST_GAME',
      game: { verdict: 'DECISIVE', winner: 1, reason: 'THRONE_BREACH' },
    });

    const row = await loadSnapshotRow(testId);
    expect(row.status).toBe('COMPLETED');
    expect(row.completed_at).not.toBeNull();
    expect(row.replay_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.result_payload).toEqual({
      winner: 1,
      reason: 'THRONE_BREACH',
      totalTurns: trace.length,
      // Both control-plane facts, exactly as the assignment pinned them.
      opponent: { kind: 'BASELINE', label: 'greedy-bot.ts' },
      map: { name: BOARD_NAME, version: 1, source: 'COMMITMENT' },
      finishedAt: expect.any(String),
    });

    // The digest the row names is an immutable OANTUTI2 object.
    const replayBytes = replays.readReplay(row.replay_digest as string);
    expect(replayBytes.subarray(0, 8).toString('ascii')).toBe('OANTUTI2');
    const replay: ReplayV2Payload = replays.deserializeReplayV2(replayBytes);
    expect(replay).toMatchObject({
      gameId: testId,
      attemptId: lease.attemptId,
      mapId: BOARD.mapName,
      manifestDigest: payload.manifestDigest,
      totalTurns: trace.length,
      winner: 1,
      reason: 'THRONE_BREACH',
      disposition: 'DECISIVE',
    });
    expect(replay.trace).toHaveLength(trace.length);

    // Zero official side effects: no accepted result, no result version, no rating event, no
    // standings row, no replay published for the official routes, and the frozen entries stand.
    expect(await officialCounts()).toEqual(before);
    expect((await db.query('SELECT 1 FROM replay_objects WHERE digest = $1', [row.replay_digest])).rows).toHaveLength(0);

    const jobs = await db.query<{ job_type: string; state: string }>(
      `SELECT job_type, state FROM jobs WHERE target_id = $1`,
      [testId]
    );
    expect(jobs.rows).toEqual([{ job_type: 'TEST_GAME', state: 'SUCCEEDED' }]);
    await expect(stat(attemptDirectory)).rejects.toThrow();
  });

  it('refuses a mismatched manifest or a trace its observations contradict, mutating nothing', async () => {
    const mismatched = await createSnapshot();
    await broker.enqueue('TEST_GAME', mismatched, TEST_GAME_JOB_PRIORITY, {});
    const first = await claimTest(mismatched);
    const startedAt = (await loadSnapshotRow(mismatched)).started_at?.getTime();
    await expect(
      complete(first.lease, { ...privateEvidence(first.payload), manifestDigest: 'f'.repeat(64) })
    ).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
    const afterManifest = await loadSnapshotRow(mismatched);
    expect(afterManifest.status).toBe('RUNNING');
    expect(afterManifest.started_at?.getTime()).toBe(startedAt);
    expect(afterManifest.replay_digest).toBeNull();
    expect(afterManifest.result_payload).toBeNull();

    // A trace that no observation vouches for is refused before anything is stored.
    const lying = await createSnapshot();
    await broker.enqueue('TEST_GAME', lying, TEST_GAME_JOB_PRIORITY, {});
    const second = await claimTest(lying);
    const storedBefore = (await readdir(join(storageRoot, 'replays'))).length;
    const lyingTrace = [{ ...trace[0], move: { pieceId: 1, targetPos: { x: 2, y: 1 } } }, trace[1], trace[2]];
    await expect(complete(second.lease, privateEvidence(second.payload, lyingTrace))).rejects.toThrow(/Trace verification failed|OBSERVATION/);
    const afterTrace = await loadSnapshotRow(lying);
    expect(afterTrace.status).toBe('RUNNING');
    expect(afterTrace.replay_digest).toBeNull();
    expect(afterTrace.result_payload).toBeNull();
    expect((await readdir(join(storageRoot, 'replays'))).length).toBe(storedBefore);
  });

  it('enqueues exactly one TEST_GAME when a private-test build is accepted', async () => {
    const testId = await createSnapshot({ status: 'QUEUED', language: 'PYTHON', entrypoint: 'main.py', sourceDigest: buildDigest });
    expect(await broker.enqueueIfAbsent('TEST_BUILD', testId, 150, {})).toBe(true);

    const claimed = (await send('claim', {
      capacity: { ...capacity, gameSlots: 0 },
      options: { targetIds: [testId], jobTypes: ['TEST_BUILD'] },
    })) as { identity: Record<string, unknown>; payload: Record<string, unknown> };
    const digest = await stageArtifact(claimed.identity, PY_ARTIFACT);
    await complete(claimed.identity, {
      outcome: 'READY',
      stage: 'COMPILE',
      toolchain: toolchainFor('PYTHON'),
      manifestDigest: claimed.payload.manifestDigest,
      artifact: {
        key: compiledArtifactKey('PYTHON', claimed.payload.manifestDigest as string, toolchainFor('PYTHON')),
        digest,
        sizeBytes: PY_ARTIFACT.length,
        entrypoint: 'bot',
      },
    });

    expect((await loadSnapshotRow(testId)).status).toBe('COMPLETED');
    const jobs = await db.query<{ job_type: string; state: string; priority: number }>(
      `SELECT job_type, state, priority FROM jobs WHERE target_id = $1 ORDER BY job_type`,
      [testId]
    );
    expect(jobs.rows).toEqual([
      { job_type: 'TEST_BUILD', state: 'SUCCEEDED', priority: 150 },
      { job_type: 'TEST_GAME', state: 'QUEUED', priority: TEST_GAME_JOB_PRIORITY },
    ]);

    // A drained replay of the same build — the crash window the drain exists for — does not buy a
    // second practice run: the handoff is idempotent.
    await broker.enqueue('TEST_BUILD', testId, 150, {});
    const replay = (await send('claim', {
      capacity: { ...capacity, gameSlots: 0 },
      options: { targetIds: [testId], jobTypes: ['TEST_BUILD'] },
    })) as { identity: Record<string, unknown>; payload: Record<string, unknown> };
    const replayDigest = await stageArtifact(replay.identity, PY_ARTIFACT);
    await complete(replay.identity, {
      outcome: 'READY',
      stage: 'COMPILE',
      toolchain: toolchainFor('PYTHON'),
      manifestDigest: replay.payload.manifestDigest,
      artifact: {
        key: compiledArtifactKey('PYTHON', replay.payload.manifestDigest as string, toolchainFor('PYTHON')),
        digest: replayDigest,
        sizeBytes: PY_ARTIFACT.length,
        entrypoint: 'bot',
      },
    });
    const after = await db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE job_type = 'TEST_GAME' AND target_id = $1`,
      [testId]
    );
    expect(after.rows).toHaveLength(1);
  });

  it('finalizes a snapshot whose TEST_GAME job exhausted its attempts as infrastructure failure', async () => {
    const testId = await createSnapshot();
    await broker.enqueue('TEST_GAME', testId, TEST_GAME_JOB_PRIORITY, {});
    await db.query(`UPDATE jobs SET max_attempts = 1 WHERE job_type = 'TEST_GAME' AND target_id = $1`, [testId]);

    const { lease } = await claimTest(testId);
    expect((await loadSnapshotRow(testId)).status).toBe('RUNNING');
    await db.query(`UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [lease.attemptId]);

    const report = await new JobReconciler(db, policy.deploymentGeneration).reconcile(PROCESS_RECONCILER_IDENTITY);
    expect(report.blockedJobsCount).toBeGreaterThanOrEqual(1);

    const job = await db.query<{ state: string }>(`SELECT state FROM jobs WHERE target_id = $1`, [testId]);
    expect(job.rows[0].state).toBe('BLOCKED');
    const row = await loadSnapshotRow(testId);
    expect(row.status).toBe('FAILED');
    expect(row.result_payload).toEqual({ error: INFRASTRUCTURE_FAILURE });
    expect(row.replay_digest).toBeNull();
    expect(row.completed_at).not.toBeNull();
  });
});
