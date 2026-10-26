import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotLanguage, BuildToolchain } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { JobBroker } from '../src/jobs/broker.js';
import { LocalJobBrokerTransport, type LocalJobBrokerOptions } from '../src/jobs/local-transport.js';
import { BUILD_LIMITS, NativeAssignmentService } from '../src/jobs/native-assignment.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { CompiledArtifactStore, compiledArtifactKey } from '../src/builds/compiled-artifact-store.js';
import { PrivateTestResultService } from '../src/builds/private-test-result-service.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService } from '../src/results/service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { createZip } from './helpers/zip.js';

/**
 * The BUILD/TEST_BUILD path through the native gateway: the gateway pins the stored source as a
 * per-attempt path grant, the worker compiles and smoke-tests it in its own sandbox, streams the
 * compiled output back over `stageArtifact`, and the completion is only accepted once
 *   - the evidence matches the assignment (toolchain, manifest, key, size, entrypoint),
 *   - the staged bytes hash to the digest the evidence claims,
 *   - the artifact is durable before the receipt/snapshot transition, and
 *   - the attempt spool is gone afterwards.
 *
 * The same file proves the C++ GAME consequence: a compile language is refused while its artifact
 * is missing and ships the stored artifact afterwards, so no compiler ever runs at match time.
 */

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const workerUid = (process.getuid?.() ?? 0) + 1;
const pid = 923;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const toolchains: readonly BuildToolchain[] = [
  { language: 'PYTHON', imageDigest: '1'.repeat(64), version: '3.12.4', flags: [] },
  { language: 'TYPESCRIPT', imageDigest: '2'.repeat(64), version: '24.22.0', flags: ['--experimental-strip-types'] },
  { language: 'CPP', imageDigest: '3'.repeat(64), version: '13.3.0', flags: ['-O2', '-std=c++20'] },
];
const toolchainFor = (language: BotLanguage): BuildToolchain => toolchains.find((toolchain) => toolchain.language === language)!;

const PY_SOURCE = { 'main.py': "# native build acceptance bot\nprint('ready')\n" };
const CPP_SOURCE = {
  'bot.cpp': [
    '#include <iostream>',
    'int main() { std::cout << "READY" << std::endl; return 0; }',
    '',
  ].join('\n'),
};
/**
 * A second C++ project with its own manifest digest. The build key is
 * `(language, manifest digest, toolchain)`, so two entries with identical source share one
 * artifact — this one exists to be unbuilt.
 */
const CPP_UNBUILT_SOURCE = {
  'bot.cpp': [
    '#include <iostream>',
    'int main() { std::cout << "NEVER BUILT" << std::endl; return 0; }',
    '',
  ].join('\n'),
};

/** A third Python project, so the mismatch case owns a key nothing else has built. */
const PY_MISMATCH_SOURCE = { 'main.py': "# native build mismatch bot\nprint('ready')\n" };

/** A fourth Python project, so the replay case starts from a genuinely unpublished key. */
const PY_REPLAY_SOURCE = { 'main.py': "# native build replay bot\nprint('ready')\n" };

/** Output a build declares: exact bytes, a plain entrypoint name, one digest. */
const PY_ARTIFACT = Buffer.from('PYC-BUNDLE\n'.repeat(96));
const PY_REBUILT_ARTIFACT = Buffer.from('PYC-BUNDLE-V2\n'.repeat(96));
const CPP_ARTIFACT = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), randomBytes(4096)]);

describe('native gateway accepts a build only from verified, durably stored output', () => {
  const db = new PostgresDatabase();

  let storageRoot: string;
  let policy: LocalJobBrokerOptions;
  let artifacts: ArtifactStore;
  let compiledArtifacts: CompiledArtifactStore;
  let broker: JobBroker;
  let assignments: NativeAssignmentService;
  let transport: LocalJobBrokerTransport;

  let courseId: string;
  const userIds: string[] = [];
  const teamIds: string[] = [];
  let tournamentId: string;
  const submissionIds: string[] = [];
  const snapshotIds: string[] = [];
  const sourceDigests: string[] = [];
  const encounterIds: string[] = [];
  const gameIds: string[] = [];
  /** Tournament entry frozen for each team, so one team's submission can be built after fixtures. */
  const frozenByTeam = new Map<string, string>();
  const cppSubmissionByTeam = new Map<string, string>();

  const capacity = { buildSlots: 1, gameSlots: 1, runtimeProfileDigest: 'd'.repeat(64) };

  const send = (operation: string, parameters: unknown) =>
    transport['dispatch']({ uid: workerUid, pid, request: { operation, parameters } });

  const claim = async (targetId: string, jobType: 'BUILD' | 'TEST_BUILD' | 'GAME') =>
    (await send('claim', { capacity, options: { targetIds: [targetId], jobTypes: [jobType] } })) as {
      identity: Record<string, unknown>;
      payload: Record<string, unknown>;
    };

  /** Stages one artifact the way the supervisor does: ascending chunks, one digest throughout. */
  async function stageArtifact(lease: Record<string, unknown>, bytes: Buffer, entrypoint: string, chunkSize: number) {
    const digest = sha256(bytes);
    let last: Record<string, unknown> | undefined;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      last = (await send('stageArtifact', {
        lease,
        chunk: { offset, data: chunk.toString('base64'), digest, sizeBytes: bytes.length, entrypoint },
      })) as Record<string, unknown>;
    }
    return { digest, last: last! };
  }

  const readyEvidence = (
    payload: Record<string, unknown>,
    language: BotLanguage,
    entrypoint: string,
    digest: string,
    sizeBytes: number
  ) => ({
    outcome: 'READY' as const,
    stage: 'COMPILE' as const,
    toolchain: toolchainFor(language),
    manifestDigest: payload.manifestDigest,
    artifact: {
      key: compiledArtifactKey(language, payload.manifestDigest as string, toolchainFor(language)),
      digest,
      sizeBytes,
      entrypoint,
    },
  });

  async function createSubmission(
    teamId: string,
    files: Record<string, string>,
    language: BotLanguage,
    entrypoint: string,
    status: string
  ): Promise<string> {
    const stored = await artifacts.storeSource(createZip(files), language, entrypoint);
    sourceDigests.push(stored.digest);
    const res = await db.query<{ id: string }>(
      `INSERT INTO submissions
         (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tournamentId, teamId, userIds[teamIds.indexOf(teamId)], submissionIds.length + 1, stored.digest, language, entrypoint, status]
    );
    submissionIds.push(res.rows[0].id);
    return res.rows[0].id;
  }

  async function createTestSnapshot(files: Record<string, string>, language: BotLanguage, entrypoint: string): Promise<string> {
    const stored = await artifacts.storeSource(createZip(files), language, entrypoint);
    sourceDigests.push(stored.digest);
    const res = await db.query<{ id: string }>(
      `INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED') RETURNING id`,
      [tournamentId, teamIds[0], userIds[0], stored.digest, language, entrypoint]
    );
    snapshotIds.push(res.rows[0].id);
    await broker.enqueueIfAbsent('TEST_BUILD', res.rows[0].id);
    return res.rows[0].id;
  }

  async function createGame(white: string, black: string): Promise<string> {
    const encounter = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, 'MAIN', 1, 1, $2, $3, 'RUNNING') RETURNING id`,
      [tournamentId, white, black]
    );
    encounterIds.push(encounter.rows[0].id);
    const map = {
      mapName: 'native-build-acceptance-3x3',
      width: 3,
      height: 3,
      validTiles: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
      whiteThrone: [0, 0],
      blackThrone: [2, 2],
      startingPieces: [
        { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
        { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 1] },
      ],
    };
    const game = await db.query<{ id: string }>(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, 1, $2, $3, $4, 'PENDING') RETURNING id`,
      [encounter.rows[0].id, white, black, JSON.stringify(map)]
    );
    gameIds.push(game.rows[0].id);
    await broker.enqueue('GAME', game.rows[0].id);
    return game.rows[0].id;
  }

  /** Runs one full BUILD/TEST_BUILD job and completes it with the given evidence. */
  async function runBuild(
    targetId: string,
    jobType: 'BUILD' | 'TEST_BUILD',
    build: { language: BotLanguage; entrypoint: string; artifact?: Buffer; artifactEntrypoint?: string; rejected?: string; chunkSize?: number }
  ) {
    const claimed = await claim(targetId, jobType);
    const { payload, identity: lease } = claimed;
    let evidence: Record<string, unknown> = {
      outcome: 'SOURCE_REJECTED',
      stage: 'INIT_SMOKE',
      toolchain: toolchainFor(build.language),
      manifestDigest: payload.manifestDigest,
      diagnostic: build.rejected ?? 'SMOKE_TEST_FAILED: bot never answered INIT',
    };
    if (build.artifact) {
      const staged = await stageArtifact(lease, build.artifact, build.artifactEntrypoint ?? 'bot', build.chunkSize ?? 900);
      expect(staged.last).toMatchObject({ staged: true, received: build.artifact.length });
      evidence = readyEvidence(payload, build.language, build.artifactEntrypoint ?? 'bot', staged.digest, build.artifact.length);
    }
    const pinned = (await send('prepareCompletion', { lease, evidence })) as Record<string, unknown>;
    const completed = (await send('complete', {
      completion: { ...(pinned.data as Record<string, unknown>), deploymentGeneration: policy.deploymentGeneration },
    })) as Record<string, unknown>;
    expect(completed).toMatchObject({ data: { state: 'ACCEPTED' } });
    return { payload, lease, evidence, stagedDigest: sha256(build.artifact ?? Buffer.alloc(0)) };
  }

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'arena-native-build-'));
    policy = {
      executable: '/does-not-exist/arena-job-broker',
      socketPath: '/does-not-exist/broker.sock',
      workerUid,
      socketGid: process.getgid?.() ?? 0,
      grantGid: process.getgid?.() ?? 0,
      deploymentGeneration: 733,
      runtimeProfileDigest: capacity.runtimeProfileDigest,
      maxBuildSlots: 4,
      maxGameSlots: 4,
      spoolRoot: join(storageRoot, 'spool'),
      compiledArtifactsDir: join(storageRoot, 'compiled'),
      toolchains,
    };
    artifacts = new ArtifactStore(db, join(storageRoot, 'sources'));
    compiledArtifacts = new CompiledArtifactStore(policy.compiledArtifactsDir);
    broker = new JobBroker(db, policy.deploymentGeneration);
    const scheduler = new TournamentSchedulerService(db, broker);
    const replays = new ReplayStore(join(storageRoot, 'replays'), join(storageRoot, 'staging'));
    const resultService = new ResultService(db, replays, new TraceVerifier(), async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
    assignments = new NativeAssignmentService(db, artifacts, resultService, scheduler, broker, new PrivateTestResultService(db, replays), {
      runtimeProfileDigest: policy.runtimeProfileDigest,
      spoolRoot: policy.spoolRoot,
      toolchains,
      compiledArtifacts,
      grantGid: policy.grantGid,
    });
    transport = new LocalJobBrokerTransport(db, broker, policy, assignments);

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Native Build Course') RETURNING id`,
      [`NATIVE_BUILD_${run}`]
    );
    courseId = course.rows[0].id;
    for (const index of [0, 1, 2, 3]) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`native_build_${index}_${run}`, `Native Build ${index}`]
      );
      userIds.push(user.rows[0].id);
      const team = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `Native Build Team ${index}`, user.rows[0].id]
      );
      teamIds.push(team.rows[0].id);
    }
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, max_teams)
       VALUES ($1, 'Native Build Cup', 'ROUND_ROBIN', 'RUNNING', 8) RETURNING id`,
      [courseId]
    );
    tournamentId = tournament.rows[0].id;

    // Team 0: Python, frozen and READY (a game side that needs no artifact).
    // Team 1: C++, frozen and READY but never built (its artifact is missing).
    // Team 2: C++, built below through the native BUILD path.
    const pythonSubmission = await createSubmission(teamIds[0], PY_SOURCE, 'PYTHON', 'main.py', 'READY');
    const unbuiltCpp = await createSubmission(teamIds[1], CPP_UNBUILT_SOURCE, 'CPP', 'bot.cpp', 'READY');
    cppSubmissionByTeam.set(teamIds[1], unbuiltCpp);
    const builtCpp = await createSubmission(teamIds[2], CPP_SOURCE, 'CPP', 'bot.cpp', 'VALIDATING');
    cppSubmissionByTeam.set(teamIds[2], builtCpp);
    frozenByTeam.set(teamIds[0], pythonSubmission);
    frozenByTeam.set(teamIds[1], unbuiltCpp);
    frozenByTeam.set(teamIds[2], builtCpp);
    for (const teamId of [teamIds[0], teamIds[1], teamIds[2]]) {
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, frozen_submission_id)
         VALUES ($1, $2, 'ELIGIBLE', $3)`,
        [tournamentId, teamId, frozenByTeam.get(teamId)]
      );
    }
  });

  afterAll(async () => {
    const targets = [...submissionIds, ...snapshotIds, ...gameIds];
    await db.query('DELETE FROM job_completions WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))', [targets]);
    await db.query('UPDATE jobs SET active_lease_id = NULL WHERE target_id = ANY($1::uuid[])', [targets]);
    await db.query('DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE target_id = ANY($1::uuid[]))', [targets]);
    await db.query('DELETE FROM jobs WHERE target_id = ANY($1::uuid[])', [targets]);
    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [targets]);
    await db.query('DELETE FROM tournament_entries WHERE tournament_id = $1', [tournamentId]);
    await db.query('DELETE FROM submissions WHERE id = ANY($1::uuid[])', [submissionIds]);
    await db.query('DELETE FROM test_snapshots WHERE id = ANY($1::uuid[])', [snapshotIds]);
    await db.query('DELETE FROM games WHERE id = ANY($1::uuid[])', [gameIds]);
    await db.query('DELETE FROM encounters WHERE id = ANY($1::uuid[])', [encounterIds]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    await db.query('DELETE FROM submission_sources WHERE digest = ANY($1::text[])', [sourceDigests]);
    await db.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [teamIds]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await db.query('DELETE FROM courses WHERE id = $1', [courseId]);
    await db.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('prunes attempt directories left by a previous process but keeps foreign files', async () => {
    await mkdir(policy.spoolRoot, { mode: 0o710 });
    const stale = join(policy.spoolRoot, randomUUID());
    const foreign = join(policy.spoolRoot, 'not-an-attempt');
    await mkdir(stale, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await assignments.start();
    // A restart drops assignment authority, so an attempt directory can never be resumed.
    await expect(stat(stale)).rejects.toThrow();
    expect((await stat(foreign)).isDirectory()).toBe(true);
    await rm(foreign, { recursive: true, force: true });
  });

  it('pins the stored source, accepts READY, keeps the artifact on disk and drops the spool', async () => {
    const submissionId = await createSubmission(teamIds[0], PY_SOURCE, 'PYTHON', 'main.py', 'VALIDATING');
    await broker.enqueueIfAbsent('BUILD', submissionId);
    const claimed = await claim(submissionId, 'BUILD');
    const { payload, identity: lease } = claimed;

    expect(payload).toMatchObject({
      version: 1,
      jobType: 'BUILD',
      targetId: submissionId,
      language: 'PYTHON',
      entrypoint: 'main.py',
      toolchain: toolchainFor('PYTHON'),
      limits: { ...BUILD_LIMITS },
    });
    expect(payload.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    const source = payload.source as { path: string; digest: string; sizeBytes: number };
    expect(source.path.startsWith(`${attemptDirectory}/`)).toBe(true);
    const sourceInfo = await stat(source.path);
    expect(sourceInfo.mode & 0o777).toBe(0o640);
    const storedSource = await artifacts.getSource(payload.manifestDigest as string);
    expect(storedSource!.zipBuffer.equals(await readFile(source.path))).toBe(true);
    expect(source.sizeBytes).toBe(storedSource!.zipBuffer.length);
    expect(source.digest).toBe(sha256(storedSource!.zipBuffer));
    // The claim moved the receipt into the state acceptance is defined to leave.
    expect((await db.query<{ status: string }>('SELECT status FROM submissions WHERE id = $1', [submissionId])).rows[0].status).toBe('COMPILING');

    const staged = await stageArtifact(lease, PY_ARTIFACT, 'bot', 900);
    expect(staged.last).toMatchObject({ staged: true, received: PY_ARTIFACT.length, digest: staged.digest });

    // A retried final frame (a lost response) is answered idempotently rather than with an error.
    const tail = PY_ARTIFACT.subarray(PY_ARTIFACT.length - 100);
    await expect(
      send('stageArtifact', {
        lease,
        chunk: { offset: PY_ARTIFACT.length - 100, data: tail.toString('base64'), digest: staged.digest, sizeBytes: PY_ARTIFACT.length, entrypoint: 'bot' },
      })
    ).resolves.toMatchObject({ staged: true, received: PY_ARTIFACT.length, digest: staged.digest });

    const pinned = (await send('prepareCompletion', {
      lease,
      evidence: readyEvidence(payload, 'PYTHON', 'bot', staged.digest, PY_ARTIFACT.length),
    })) as Record<string, unknown>;
    const completed = (await send('complete', {
      completion: { ...(pinned.data as Record<string, unknown>), deploymentGeneration: policy.deploymentGeneration },
    })) as Record<string, unknown>;
    expect(completed).toMatchObject({ data: { state: 'ACCEPTED' } });

    // The pinned evidence is the sandboxed build's own verdict (03 §173): it names the outcome, the
    // stage, the measured toolchain and the artifact it produced, and never takes a game's shape.
    const pinnedEvidence = await db.query<{ evidence_payload: Record<string, unknown> }>(
      `SELECT jc.evidence_payload
       FROM job_completions jc JOIN jobs j ON j.id = jc.job_id
       WHERE j.id = $1`,
      [lease.jobId]
    );
    expect(pinnedEvidence.rows[0].evidence_payload).toMatchObject({
      kind: 'BUILD',
      build: {
        outcome: 'READY',
        stage: 'COMPILE',
        toolchain: { language: 'PYTHON' },
        manifestDigest: payload.manifestDigest,
        artifact: { digest: staged.digest, entrypoint: 'bot', sizeBytes: PY_ARTIFACT.length },
      },
    });

    const receipt = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT status, build_error, built_at FROM submissions WHERE id = $1',
      [submissionId]
    );
    expect(receipt.rows[0].status).toBe('READY');
    expect(receipt.rows[0].build_error).toBeNull();
    expect(receipt.rows[0].built_at).not.toBeNull();

    // Durable before the transition: the bytes are readable from the store and from the object file.
    const key = compiledArtifactKey('PYTHON', payload.manifestDigest as string, toolchainFor('PYTHON'));
    const stored = await compiledArtifacts.get(key);
    expect(stored!.bytes.equals(PY_ARTIFACT)).toBe(true);
    expect(stored!.record).toMatchObject({ entrypoint: 'bot', sizeBytes: PY_ARTIFACT.length, digest: staged.digest, language: 'PYTHON' });
    expect((await readFile(join(policy.compiledArtifactsDir, 'objects', `${staged.digest}.bin`))).equals(PY_ARTIFACT)).toBe(true);

    const audit = await db.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM audit_events WHERE resource_id = $1',
      [submissionId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('BUILD_ACCEPTED');
    expect(audit.rows[0].details).toMatchObject({ status: 'READY', stage: 'COMPILE', artifactDigest: staged.digest });

    await expect(stat(attemptDirectory)).rejects.toThrow();
  });

  it('records SOURCE_REJECTED with its stage and diagnostic, and refuses an empty one', async () => {
    const submissionId = await createSubmission(teamIds[0], CPP_SOURCE, 'CPP', 'bot.cpp', 'VALIDATING');
    await broker.enqueueIfAbsent('BUILD', submissionId);
    const { payload, identity: lease } = await claim(submissionId, 'BUILD');

    // A rejection has to say why: an empty diagnostic is not a verdict and must not settle the row.
    await expect(
      send('prepareCompletion', {
        lease,
        evidence: {
          outcome: 'SOURCE_REJECTED',
          stage: 'COMPILE',
          toolchain: toolchainFor('CPP'),
          manifestDigest: payload.manifestDigest,
          diagnostic: '   ',
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
    expect((await db.query<{ status: string }>('SELECT status FROM submissions WHERE id = $1', [submissionId])).rows[0].status).toBe('COMPILING');

    const diagnostic = 'COMPILE_FAILED: bot.cpp:3:1: error: expected primary-expression before } token';
    const pinned = (await send('prepareCompletion', {
      lease,
      evidence: {
        outcome: 'SOURCE_REJECTED',
        stage: 'COMPILE',
        toolchain: toolchainFor('CPP'),
        manifestDigest: payload.manifestDigest,
        diagnostic,
      },
    })) as Record<string, unknown>;
    await send('complete', {
      completion: { ...(pinned.data as Record<string, unknown>), deploymentGeneration: policy.deploymentGeneration },
    });

    const receipt = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT status, build_error, built_at FROM submissions WHERE id = $1',
      [submissionId]
    );
    expect(receipt.rows[0].status).toBe('REJECTED');
    expect(receipt.rows[0].build_error).toBe(diagnostic);
    expect(receipt.rows[0].built_at).not.toBeNull();

    const audit = await db.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM audit_events WHERE resource_id = $1',
      [submissionId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('BUILD_REJECTED');
    expect(audit.rows[0].details).toMatchObject({ status: 'REJECTED', stage: 'COMPILE', reason: diagnostic });

    // A rejected build never publishes an artifact.
    const key = compiledArtifactKey('CPP', payload.manifestDigest as string, toolchainFor('CPP'));
    expect(await compiledArtifacts.get(key)).toBeUndefined();
    await expect(stat(join(policy.spoolRoot, lease.attemptId as string))).rejects.toThrow();
  });

  it('refuses a mismatched artifact digest or key with no DB mutation', async () => {
    const submissionId = await createSubmission(teamIds[0], PY_MISMATCH_SOURCE, 'PYTHON', 'main.py', 'VALIDATING');
    await broker.enqueueIfAbsent('BUILD', submissionId);
    const { payload, identity: lease } = await claim(submissionId, 'BUILD');
    const key = compiledArtifactKey('PYTHON', payload.manifestDigest as string, toolchainFor('PYTHON'));
    expect(await compiledArtifacts.get(key)).toBeUndefined();
    const staged = await stageArtifact(lease, PY_ARTIFACT, 'bot', 900);

    // Digest the staged bytes do not hash to.
    await expect(
      send('prepareCompletion', { lease, evidence: readyEvidence(payload, 'PYTHON', 'bot', 'f'.repeat(64), PY_ARTIFACT.length) })
    ).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });

    // A key that is not this build's key.
    const wrongKey = { ...readyEvidence(payload, 'PYTHON', 'bot', staged.digest, PY_ARTIFACT.length) } as Record<string, unknown>;
    wrongKey.artifact = { ...(wrongKey.artifact as Record<string, unknown>), key: 'compiled/PYTHON/' + 'a'.repeat(64) + '/' + 'b'.repeat(64) };
    await expect(send('prepareCompletion', { lease, evidence: wrongKey })).rejects.toMatchObject({ code: 'ARTIFACT_KEY_MISMATCH' });

    // An artifact that was never staged cannot be claimed.
    const neverStaged = await createSubmission(teamIds[0], PY_MISMATCH_SOURCE, 'PYTHON', 'main.py', 'VALIDATING');
    await broker.enqueueIfAbsent('BUILD', neverStaged);
    const second = await claim(neverStaged, 'BUILD');
    await expect(
      send('prepareCompletion', { lease: second.identity, evidence: readyEvidence(second.payload, 'PYTHON', 'bot', staged.digest, PY_ARTIFACT.length) })
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_STAGED' });

    const missing = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT status, build_error, built_at FROM submissions WHERE id = $1',
      [submissionId]
    );
    expect(missing.rows[0]).toMatchObject({ status: 'COMPILING', build_error: null, built_at: null });
    expect((await db.query('SELECT 1 FROM audit_events WHERE resource_id = $1', [submissionId])).rows).toHaveLength(0);
    expect(await compiledArtifacts.get(key)).toBeUndefined();
    // The attempt is not over, so its spool — and the staged bytes — are still there.
    expect((await stat(join(policy.spoolRoot, lease.attemptId as string))).isDirectory()).toBe(true);
  });

  it('drains a replayed build job without unpublishing the verdict or rewriting it', async () => {
    const submissionId = await createSubmission(teamIds[0], PY_REPLAY_SOURCE, 'PYTHON', 'main.py', 'VALIDATING');
    await broker.enqueueIfAbsent('BUILD', submissionId);
    const first = await runBuild(submissionId, 'BUILD', { language: 'PYTHON', entrypoint: 'main.py', artifact: PY_ARTIFACT, artifactEntrypoint: 'bot' });
    const key = compiledArtifactKey('PYTHON', first.payload.manifestDigest as string, toolchainFor('PYTHON'));
    const settled = await db.query<{ status: string; built_at: Date }>('SELECT status, built_at FROM submissions WHERE id = $1', [submissionId]);
    expect(settled.rows[0].status).toBe('READY');

    // A crash between the published verdict and the pinned completion leaves a job whose only way
    // out is to be reassigned and drained: refusing the target here would strand it until BLOCKED.
    await broker.enqueue('BUILD', submissionId);
    const { payload, identity: lease } = await claim(submissionId, 'BUILD');
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    // A published verdict is never pulled back into COMPILING by the replay.
    expect((await db.query<{ status: string }>('SELECT status FROM submissions WHERE id = $1', [submissionId])).rows[0].status).toBe('READY');

    const staged = await stageArtifact(lease, PY_REBUILT_ARTIFACT, 'bot', 1024);
    const pinned = (await send('prepareCompletion', {
      lease,
      evidence: readyEvidence(payload, 'PYTHON', 'bot', staged.digest, PY_REBUILT_ARTIFACT.length),
    })) as Record<string, unknown>;
    await send('complete', {
      completion: { ...(pinned.data as Record<string, unknown>), deploymentGeneration: policy.deploymentGeneration },
    });

    const replayed = await db.query<{ status: string; built_at: Date }>('SELECT status, built_at FROM submissions WHERE id = $1', [submissionId]);
    expect(replayed.rows[0].status).toBe('READY');
    // Terminal -> terminal is not a transition: the published timestamp, reason and audit row stay.
    expect(replayed.rows[0].built_at.toISOString()).toBe(settled.rows[0].built_at.toISOString());
    expect((await db.query('SELECT 1 FROM audit_events WHERE resource_id = $1', [submissionId])).rows).toHaveLength(1);
    expect((await compiledArtifacts.get(key))!.bytes.equals(PY_REBUILT_ARTIFACT)).toBe(true);
    const jobs = await db.query<{ state: string }>(`SELECT state FROM jobs WHERE job_type = 'BUILD' AND target_id = $1`, [submissionId]);
    expect(jobs.rows.map((row) => row.state)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    await expect(stat(attemptDirectory)).rejects.toThrow();
  });

  it('gates a private-test snapshot through TEST_BUILD', async () => {
    const testId = await createTestSnapshot(CPP_SOURCE, 'CPP', 'bot.cpp');
    await runBuild(testId, 'TEST_BUILD', { language: 'CPP', entrypoint: 'bot.cpp', artifact: CPP_ARTIFACT, artifactEntrypoint: 'bot' });

    const snapshot = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT status, build_error, built_at FROM test_snapshots WHERE id = $1',
      [testId]
    );
    expect(snapshot.rows[0]).toMatchObject({ status: 'COMPLETED', build_error: null });
    expect(snapshot.rows[0].built_at).not.toBeNull();
    const audit = await db.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM audit_events WHERE resource_id = $1',
      [testId]
    );
    expect(audit.rows[0]).toMatchObject({ action: 'BUILD_ACCEPTED' });
    expect(audit.rows[0].details).toMatchObject({ status: 'COMPLETED' });
  });

  it('refuses a C++ game whose artifact is missing, then runs it from the stored artifact', async () => {
    // Team 1 is a compile language whose build never produced an artifact: the gateway refuses the
    // claim instead of handing the supervisor something that will fail at startup.
    const unbuilt = await createGame(teamIds[0], teamIds[1]);
    await expect(claim(unbuilt, 'GAME')).rejects.toMatchObject({ code: 'BUILD_ARTIFACT_UNAVAILABLE' });

    // Build team 2's frozen C++ submission through the native BUILD path, in one staging chunk.
    const submissionId = cppSubmissionByTeam.get(teamIds[2])!;
    await broker.enqueueIfAbsent('BUILD', submissionId);
    const build = await runBuild(submissionId, 'BUILD', {
      language: 'CPP',
      entrypoint: 'bot.cpp',
      artifact: CPP_ARTIFACT,
      artifactEntrypoint: 'bot',
      chunkSize: 8192,
    });
    expect((await db.query<{ status: string }>('SELECT status FROM submissions WHERE id = $1', [submissionId])).rows[0].status).toBe('READY');

    const gameId = await createGame(teamIds[0], teamIds[2]);
    const { payload, identity: lease } = await claim(gameId, 'GAME');
    const bots = payload.bots as Array<{
      side: number;
      language: string;
      sourceDigest: string;
      source: { path: string; digest: string; sizeBytes: number };
      artifact?: { path: string; digest: string; sizeBytes: number; entrypoint: string };
    }>;
    const attemptDirectory = join(policy.spoolRoot, lease.attemptId as string);
    expect(bots[0].artifact).toBeUndefined();
    expect(bots[0].language).toBe('PYTHON');
    expect(bots[1]).toMatchObject({
      side: 2,
      language: 'CPP',
      sourceDigest: build.payload.manifestDigest,
      artifact: { entrypoint: 'bot', digest: build.stagedDigest, sizeBytes: CPP_ARTIFACT.length },
    });
    const artifact = bots[1].artifact!;
    expect(artifact.path.startsWith(`${attemptDirectory}/`)).toBe(true);
    const artifactBytes = await readFile(artifact.path);
    expect((await stat(artifact.path)).mode & 0o777).toBe(0o640);
    expect(artifactBytes.equals(CPP_ARTIFACT)).toBe(true);
    expect(sha256(artifactBytes)).toBe(artifact.digest);
    // The resolved artifact is the one the durable store kept, not the build attempt's spool.
    const key = compiledArtifactKey('CPP', build.payload.manifestDigest as string, toolchainFor('CPP'));
    expect((await compiledArtifacts.get(key))!.bytes.equals(CPP_ARTIFACT)).toBe(true);

    // Leaving the game attempt unfinished leaves exactly its own spool behind.
    const beforeAbandon = (await readdir(policy.spoolRoot)).filter((entry) => entry === lease.attemptId);
    expect(beforeAbandon).toHaveLength(1);
    await db.query(`UPDATE job_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [lease.attemptId]);
    await expect(send('heartbeat', { lease })).resolves.toMatchObject({ status: 'STOP' });
    await expect(stat(attemptDirectory)).rejects.toThrow();
  });
});
