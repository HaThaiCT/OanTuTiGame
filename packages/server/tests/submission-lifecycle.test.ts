import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { TeamService } from '../src/teams/service.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { SubmissionService } from '../src/submissions/service.js';
import { BuildPipeline } from '../src/builds/build-pipeline.js';
import { PrivateTestRunner } from '../src/builds/private-test-runner.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { JobBroker } from '../src/jobs/broker.js';
import { registerIdentityRoutes } from '../src/identity/routes.js';
import { registerTeamRoutes } from '../src/teams/routes.js';
import { registerSubmissionRoutes } from '../src/submissions/routes.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';
import { MapService } from '../src/tournaments/map-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { registerAdmissionRoutes, registerTournamentRoutes } from '../src/tournaments/routes.js';
import { createZip } from './helpers/zip.js';

/**
 * Minimal, self-contained bot that completes the INIT handshake. A receipt only becomes READY
 * by passing the build gate, so the lifecycle test submits this rather than a stub.
 */
const SMOKE_BOT_SOURCE = [
  'import json, sys',
  'for line in sys.stdin:',
  '    if json.loads(line).get("type") == "INIT":',
  '        sys.stdout.write(json.dumps({"status": "READY"}) + "\\n")',
  '        sys.stdout.flush()',
  '',
].join('\n');

describe('S05 Submission Source Pipeline & Private Workspace Tests (T3a)', () => {
  let app: FastifyInstance;
  let db: Database;
  let identity: IdentityService;
  let teams: TeamService;
  let artifactStore: ArtifactStore;
  let submissions: SubmissionService;
  let buildPipeline: BuildPipeline;
  let broker: JobBroker;

  beforeAll(async () => {
    db = new Database();
    identity = new IdentityService(db);
    teams = new TeamService(db);
    artifactStore = new ArtifactStore(db);
    broker = new JobBroker(db);
    submissions = new SubmissionService(db, artifactStore, broker);
    buildPipeline = new BuildPipeline(db, artifactStore, { spoolDir: path.join(os.tmpdir(), `oantuti-lifecycle-builds-${process.pid}`) });

    app = Fastify();
    registerIdentityRoutes(app, identity, ['http://localhost', 'https://localhost']);
    registerTeamRoutes(app, teams, identity);
    // The private-test read routes are part of this surface; their runner keeps its scratch
    // (spool + replay objects) under tmp rather than the developer's real object store.
    const privateTestRoot = path.join(os.tmpdir(), `oantuti-lifecycle-private-tests-${process.pid}`);
    registerSubmissionRoutes(
      app,
      submissions,
      identity,
      new PrivateTestRunner(
        db,
        artifactStore,
        new ReplayStore(path.join(privateTestRoot, 'objects'), path.join(privateTestRoot, 'staging')),
        { spoolDir: path.join(privateTestRoot, 'spool') }
      )
    );
    registerAdmissionRoutes(app, new TournamentAdmissionService(db), identity);
    registerTournamentRoutes(
      app,
      db,
      new MapService(db),
      new TournamentLifecycleService(db),
      new TournamentSchedulerService(db, broker),
      identity
    );
    await app.ready();

    // Clean tables
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM job_completions');
      await client.query('DELETE FROM job_attempts');
      await client.query('DELETE FROM jobs');
      await client.query('DELETE FROM tournament_entries');
      await client.query('DELETE FROM test_snapshots');
      await client.query('DELETE FROM submissions');
      await client.query('DELETE FROM submission_sources');
      await client.query('DELETE FROM tournament_admissions');
      await client.query('DELETE FROM tournaments');
      await client.query('DELETE FROM team_memberships');
      await client.query('DELETE FROM teams');
      await client.query('DELETE FROM courses');
      await client.query('DELETE FROM sessions');
      await client.query('DELETE FROM users');
      await client.query('DELETE FROM audit_events');
    });

    // Bootstrap admin
    await identity.bootstrapAdmin('s05_admin', 'AdminPassword999!');
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  let adminCookie = '';
  let team1Cookie = '';
  let team2Cookie = '';
  let team1Id = '';
  let team2Id = '';
  let tournamentId = '';
  let firstSubmissionId = '';

  it('sets up tournament, teams, and student sessions', async () => {
    // Admin login
    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: 's05_admin', password: 'AdminPassword999!' },
    });
    adminCookie = adminRes.headers['set-cookie'] as string;

    // Course
    const courseCode = 'CS500';
    const courseRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/courses',
      headers: { cookie: adminCookie },
      payload: { code: courseCode, name: 'Advanced Bot Architecture' },
    });
    expect(courseRes.statusCode).toBe(200);

    // Provision students
    const provRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/accounts/provision-lan',
      headers: { cookie: adminCookie },
      payload: {
        users: [
          { username: 'captain_team1', displayName: 'Captain One', role: 'STUDENT' },
          { username: 'captain_team2', displayName: 'Captain Two', role: 'STUDENT' },
        ],
      },
    });
    const [u1, u2] = provRes.json().created;

    // Login & change password for team 1 captain
    const s1Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: 'captain_team1', password: u1.temporaryPassword },
    });
    const s1Cookie = s1Login.headers['set-cookie'] as string;
    const s1Change = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-password',
      headers: { cookie: s1Cookie },
      payload: { oldPassword: u1.temporaryPassword, newPassword: 'FullPassword111!' },
    });
    team1Cookie = s1Change.headers['set-cookie'] as string;

    // Login & change password for team 2 captain
    const s2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: 'captain_team2', password: u2.temporaryPassword },
    });
    const s2Cookie = s2Login.headers['set-cookie'] as string;
    const s2Change = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-password',
      headers: { cookie: s2Cookie },
      payload: { oldPassword: u2.temporaryPassword, newPassword: 'FullPassword222!' },
    });
    team2Cookie = s2Change.headers['set-cookie'] as string;

    // Admin creates Team 1 and Team 2
    const t1Res = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/teams',
      headers: { cookie: adminCookie },
      payload: { courseCode, name: 'Vortex Alpha', captainUsername: u1.username },
    });
    expect(t1Res.statusCode).toBe(201);
    team1Id = t1Res.json().team.id;

    const t2Res = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/teams',
      headers: { cookie: adminCookie },
      payload: { courseCode, name: 'Quantum Beta', captainUsername: u2.username },
    });
    expect(t2Res.statusCode).toBe(201);
    team2Id = t2Res.json().team.id;

    // Admin creates tournament, publishes it and opens registration
    const tourRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/tournaments',
      headers: { cookie: adminCookie },
      payload: { courseCode, name: 'Fall Bot Open 2026', format: 'SWISS_PLAYOFF' },
    });
    expect(tourRes.statusCode).toBe(201);
    tournamentId = tourRes.json().tournament.id;

    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(publishRes.statusCode).toBe(200);

    const openRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/open-registration`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(openRes.statusCode).toBe(200);

    // Enroll Team 1
    const enrollRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/enroll`,
      headers: { cookie: adminCookie },
      payload: { teamId: team1Id },
    });
    expect(enrollRes.statusCode).toBe(201);
  });

  it('rejects invalid ZIP archives (traversal, missing entrypoint, forbidden extensions)', async () => {
    // 1. Directory traversal in ZIP
    const traversalZip = createZip({ '../escape.py': 'print("bad")' });
    const resTraversal = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: '../escape.py',
        zipBase64: traversalZip.toString('base64'),
      },
    });
    expect(resTraversal.statusCode).toBe(400);

    // 2. Missing specified entrypoint
    const missingEntryZip = createZip({ 'helper.py': 'def foo(): pass' });
    const resMissing = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'main.py',
        zipBase64: missingEntryZip.toString('base64'),
      },
    });
    expect(resMissing.statusCode).toBe(400);

    // 3. Forbidden compiled extension
    const binaryZip = createZip({ 'bot.exe': 'MZ-fake-binary', 'bot.py': 'print("ok")' });
    const resBinary = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'bot.py',
        zipBase64: binaryZip.toString('base64'),
      },
    });
    expect(resBinary.statusCode).toBe(400);
  });

  it('starts a valid receipt as VALIDATING and only makes it usable once the build gate accepts it', async () => {
    const validBotZip1 = createZip({
      'starter_bot.py': SMOKE_BOT_SOURCE,
      'strategy/helper.py': 'def calculate(): return 42\n',
    });

    const res1 = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'starter_bot.py',
        zipBase64: validBotZip1.toString('base64'),
      },
    });

    expect(res1.statusCode).toBe(200);
    const receipt1 = res1.json();
    expect(receipt1.data.receiptOrdinal).toBe(1);
    expect(receipt1.data.sourceDigest).toBeDefined();
    expect(receipt1.data.intakeEligibility).toBe('ELIGIBLE');
    expect(receipt1.data.status).toBe('VALIDATING');
    firstSubmissionId = receipt1.data.submissionId;

    // Intake alone never yields a candidate: the receipt is still VALIDATING.
    const beforeBuild = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}/entries/me?teamId=${team1Id}`,
      headers: { cookie: team1Cookie },
    });
    expect(beforeBuild.statusCode).toBe(200);
    expect(beforeBuild.json().candidate).toBeNull();

    // Second submission by same team
    const validBotZip2 = createZip({
      'starter_bot.py': SMOKE_BOT_SOURCE,
      'strategy/helper.py': 'def calculate(): return 100\n',
    });

    const res2 = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'starter_bot.py',
        zipBase64: validBotZip2.toString('base64'),
      },
    });

    expect(res2.statusCode).toBe(200);
    const receipt2 = res2.json();
    expect(receipt2.data.receiptOrdinal).toBe(2);
    expect(receipt2.data.status).toBe('VALIDATING');
    expect(receipt2.data.sourceDigest).not.toBe(receipt1.data.sourceDigest);

    // Both receipts have a durable BUILD job, enqueued after their transactions committed.
    const jobs = await db.query<{ target_id: string; state: string }>(
      `SELECT target_id, state FROM jobs
       WHERE job_type = 'BUILD' AND target_id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [[firstSubmissionId, receipt2.data.submissionId]]
    );
    expect(jobs.rows.map((row) => row.target_id).sort()).toEqual(
      [firstSubmissionId, receipt2.data.submissionId].sort()
    );
    expect(jobs.rows.every((row) => row.state === 'QUEUED')).toBe(true);

    // Run the gate: compile + smoke test, per receipt.
    expect((await buildPipeline.buildSubmission(firstSubmissionId)).status).toBe('READY');
    expect((await buildPipeline.buildSubmission(receipt2.data.submissionId)).status).toBe('READY');

    const rows = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      `SELECT status, build_error, built_at FROM submissions
       WHERE id = ANY($1::uuid[]) ORDER BY receipt_ordinal ASC`,
      [[firstSubmissionId, receipt2.data.submissionId]]
    );
    expect(rows.rows.map((row) => row.status)).toEqual(['READY', 'READY']);
    expect(rows.rows[0].build_error).toBeNull();
    expect(rows.rows[0].built_at).not.toBeNull();

    // Latest candidate now reflects the latest accepted submission (ordinal 2)
    const meRes = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}/entries/me?teamId=${team1Id}`,
      headers: { cookie: team1Cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().candidate.receiptOrdinal).toBe(2);
    expect(meRes.json().candidate.status).toBe('READY');
  });

  it('rejects submissions from non-team members and unadmitted teams', async () => {
    const validZip = createZip({ 'starter_bot.py': 'print("hello")\n' });

    // Team 2 is NOT admitted to tournament yet
    const unadmittedRes = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team2Cookie },
      payload: {
        teamId: team2Id,
        language: 'PYTHON',
        entrypoint: 'starter_bot.py',
        zipBase64: validZip.toString('base64'),
      },
    });
    expect(unadmittedRes.statusCode).toBe(403);

    // Team 2 captain tries to submit for Team 1
    const crossTeamRes = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team2Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'starter_bot.py',
        zipBase64: validZip.toString('base64'),
      },
    });
    expect(crossTeamRes.statusCode).toBe(403);
  });

  it('supports private workspace test runs without advancing official receipt ordinal', async () => {
    const testZip = createZip({ 'starter_bot.py': SMOKE_BOT_SOURCE });

    const testRes = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/private-tests`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'starter_bot.py',
        zipBase64: testZip.toString('base64'),
      },
    });

    expect(testRes.statusCode).toBe(200);
    const testReceipt = testRes.json();
    const testId = testReceipt.data.testId;
    expect(testId).toBeDefined();

    // The snapshot is queued with a durable TEST_BUILD job of its own.
    const queued = await db.query<{ status: string }>('SELECT status FROM test_snapshots WHERE id = $1', [testId]);
    expect(queued.rows[0].status).toBe('QUEUED');
    const job = await db.query<{ state: string }>(
      `SELECT state FROM jobs WHERE job_type = 'TEST_BUILD' AND target_id = $1`,
      [testId]
    );
    expect(job.rows[0].state).toBe('QUEUED');

    // The same gate as an official receipt: QUEUED → COMPILING → SMOKE_TESTING → COMPLETED.
    expect((await buildPipeline.buildTestSnapshot(testId)).status).toBe('COMPLETED');
    const built = await db.query<{ status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT status, build_error, built_at FROM test_snapshots WHERE id = $1',
      [testId]
    );
    expect(built.rows[0].status).toBe('COMPLETED');
    expect(built.rows[0].build_error).toBeNull();
    expect(built.rows[0].built_at).not.toBeNull();

    // Candidate ordinal is STILL 2 (private test does not affect official submissions!)
    const meRes = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}/entries/me?teamId=${team1Id}`,
      headers: { cookie: team1Cookie },
    });
    expect(meRes.json().candidate.receiptOrdinal).toBe(2);
  });

  it('holds the lock until every receipt has finished building, then freezes the newest READY receipt', async () => {
    const pendingRes = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: team1Cookie },
      payload: {
        teamId: team1Id,
        language: 'PYTHON',
        entrypoint: 'starter_bot.py',
        zipBase64: createZip({ 'starter_bot.py': SMOKE_BOT_SOURCE }).toString('base64'),
      },
    });
    expect(pendingRes.statusCode).toBe(200);
    const pendingReceipt = pendingRes.json();
    expect(pendingReceipt.data.status).toBe('VALIDATING');
    const pendingId = pendingReceipt.data.submissionId;

    // A receipt still in flight is intake that has not drained: the lock refuses.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/lock`,
      headers: { cookie: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain('INTAKE_DRAINING');

    // Once the build gate accepts the receipt, locking freezes it as the team's entry.
    expect((await buildPipeline.buildSubmission(pendingId)).status).toBe('READY');

    const locked = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/lock`,
      headers: { cookie: adminCookie },
    });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().data.state).toBe('READY_TO_START');
    expect(locked.json().data.eligibleTeamsCount).toBe(1);
    expect(locked.json().data.excludedTeamsCount).toBe(0);

    const entry = await db.query<{ status: string; frozen_submission_id: string | null }>(
      'SELECT status, frozen_submission_id FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2',
      [tournamentId, team1Id]
    );
    expect(entry.rows[0].status).toBe('ELIGIBLE');
    expect(entry.rows[0].frozen_submission_id).toBe(pendingId);
  });

  it('protects source code privacy: only owning team or ADMIN can read source', async () => {
    // Owning team member can read source
    const ownSource = await app.inject({
      method: 'GET',
      url: `/api/v2/submissions/${firstSubmissionId}/source`,
      headers: { cookie: team1Cookie },
    });
    expect(ownSource.statusCode).toBe(200);
    expect(ownSource.json().manifest.fileCount).toBe(2);

    // ADMIN can read source for audit
    const adminSource = await app.inject({
      method: 'GET',
      url: `/api/v2/submissions/${firstSubmissionId}/source`,
      headers: { cookie: adminCookie },
    });
    expect(adminSource.statusCode).toBe(200);

    // Other team CANNOT read source (403)
    const foreignSource = await app.inject({
      method: 'GET',
      url: `/api/v2/submissions/${firstSubmissionId}/source`,
      headers: { cookie: team2Cookie },
    });
    expect(foreignSource.statusCode).toBe(403);

    // Guest / unauthenticated CANNOT read source (401)
    const guestSource = await app.inject({
      method: 'GET',
      url: `/api/v2/submissions/${firstSubmissionId}/source`,
    });
    expect(guestSource.statusCode).toBe(401);
  });
});
