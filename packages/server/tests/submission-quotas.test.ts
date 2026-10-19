import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Database, resolveDbConfig } from '../src/persistence/db.js';
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
import { registerAdmissionRoutes } from '../src/tournaments/routes.js';

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
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // min version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(0, 14); // crc (simplified)
    local.writeUInt32LE(compressedData.length, 18); // compressed size
    local.writeUInt32LE(f.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuf, compressedData);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // deflate
    cd.writeUInt32LE(0, 12); // time/date
    cd.writeUInt32LE(0, 16); // crc
    cd.writeUInt32LE(compressedData.length, 20); // compressed size
    cd.writeUInt32LE(f.data.length, 24); // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28); // name length
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attr
    cd.writeUInt32LE(0, 38); // external attr
    cd.writeUInt32LE(localOffset, 42); // local header offset

    cdHeaders.push(cd, nameBuf);
    localOffset += 30 + nameBuf.length + compressedData.length;
  }

  const cdTotalSize = cdHeaders.reduce((sum, b) => sum + b.length, 0);
  const cdOffset = localOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(fileEntries.length, 8); // disk entries
  eocd.writeUInt16LE(fileEntries.length, 10); // total entries
  eocd.writeUInt32LE(cdTotalSize, 12); // cd size
  eocd.writeUInt32LE(cdOffset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  chunks.push(...cdHeaders, eocd);
  return Buffer.concat(chunks);
}

const ADMIN_USERNAME = 'quota_admin';
const ADMIN_PASSWORD = 'AdminPassword999!';
const COURSE_CODE = 'CSQ500';
const TEAM_LABELS = ['A', 'B', 'C', 'D'] as const;

/**
 * Seeding 100 receipts inside the current UTC day *and* outside the rolling 60-minute
 * window is impossible during the first UTC hour, so that one case is skipped rather
 * than made flaky. Evaluated at collection time; a later execution only widens the margin.
 */
const utcMinutesSinceMidnight = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();

/**
 * Minimal bot that completes the INIT handshake. Receipts now only stop counting against the
 * pending-compile quota once the build gate has accepted them, so quota tests that submit
 * several receipts must forge each one.
 */
const SMOKE_BOT_SOURCE = [
  'import json, sys',
  'for line in sys.stdin:',
  '    if json.loads(line).get("type") == "INIT":',
  '        sys.stdout.write(json.dumps({"status": "READY"}) + "\\n")',
  '        sys.stdout.flush()',
  '',
].join('\n');

interface TeamHarness {
  readonly label: string;
  readonly id: string;
  readonly cookie: string;
  readonly captainUserId: string;
}

describe('S05 Submission quotas (official receipts & private tests)', () => {
  let app: FastifyInstance;
  let db: Database;
  let identity: IdentityService;
  let artifactStore: ArtifactStore;
  let submissions: SubmissionService;
  let buildPipeline: BuildPipeline;

  let adminCookie = '';
  let tournamentId = '';
  const teamHarness: TeamHarness[] = [];

  function team(label: (typeof TEAM_LABELS)[number]): TeamHarness {
    const found = teamHarness.find((t) => t.label === label);
    if (!found) throw new Error(`Team ${label} not provisioned`);
    return found;
  }

  async function submitOfficial(label: (typeof TEAM_LABELS)[number], source: string) {
    const target = team(label);
    return app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/submissions`,
      headers: { cookie: target.cookie },
      payload: {
        teamId: target.id,
        language: 'PYTHON',
        entrypoint: 'bot.py',
        zipBase64: createZip({ 'bot.py': source }).toString('base64'),
      },
    });
  }

  async function submitPrivateTest(label: (typeof TEAM_LABELS)[number], source: string) {
    const target = team(label);
    return app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/private-tests`,
      headers: { cookie: target.cookie },
      payload: {
        teamId: target.id,
        language: 'PYTHON',
        entrypoint: 'bot.py',
        zipBase64: createZip({ 'bot.py': source }).toString('base64'),
      },
    });
  }

  /**
   * Runs the build gate for an accepted receipt. Until a receipt is READY it counts against
   * the PENDING_COMPILES quota, so a test that submits more than two receipts in a row must
   * forge each one before submitting the next.
   */
  async function buildReceipt(receipt: { data: { submissionId: string } }): Promise<void> {
    const outcome = await buildPipeline.buildSubmission(receipt.data.submissionId);
    if (outcome.status !== 'READY') {
      throw new Error(`receipt ${receipt.data.submissionId} failed the build gate: ${outcome.reason ?? 'unknown'}`);
    }
  }

  /** Any stored source digest; the quota tables only need the FK to resolve. */
  async function anySourceDigest(): Promise<string> {
    const res = await db.query<{ source_digest: string }>(
      'SELECT source_digest FROM submissions WHERE tournament_id = $1 LIMIT 1',
      [tournamentId]
    );
    if (!res.rows[0]) throw new Error('No stored submission source available for seeding');
    return res.rows[0].source_digest;
  }

  beforeAll(async () => {
    // Pool sized above the burst in the overshoot test: each in-flight submit holds a
    // client for its transaction while ArtifactStore.storeSource() checks out a second.
    db = new Database(resolveDbConfig({ max: 24 }));
    identity = new IdentityService(db);
    const teams = new TeamService(db);
    artifactStore = new ArtifactStore(db);
    submissions = new SubmissionService(db, artifactStore, new JobBroker(db));
    buildPipeline = new BuildPipeline(db, artifactStore, {
      spoolDir: path.join(os.tmpdir(), `oantuti-quota-builds-${process.pid}`),
    });

    app = Fastify();
    registerIdentityRoutes(app, identity, ['http://localhost', 'https://localhost']);
    registerTeamRoutes(app, teams, identity);
    // Private-test reads are registered alongside the submission surface; scratch goes to tmp.
    const privateTestRoot = path.join(os.tmpdir(), `oantuti-quota-private-tests-${process.pid}`);
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
    await app.ready();

    await db.withTransaction(async (client) => {
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

    await identity.bootstrapAdmin(ADMIN_USERNAME, ADMIN_PASSWORD);
    await db.query(`INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity','{"limit":1000}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  });

  afterAll(async () => {
    if (db) {
      await db.withTransaction(async (client) => {
        if (tournamentId) {
          await client.query('DELETE FROM test_snapshots WHERE tournament_id = $1', [tournamentId]);
          await client.query('DELETE FROM submissions WHERE tournament_id = $1', [tournamentId]);
        }
        // Drop only source artifacts now referenced by nothing.
        await client.query(
          `DELETE FROM submission_sources s
           WHERE NOT EXISTS (SELECT 1 FROM submissions su WHERE su.source_digest = s.digest)
             AND NOT EXISTS (SELECT 1 FROM test_snapshots ts WHERE ts.source_digest = s.digest)`
        );
      });
    }
    await app?.close();
    await db?.close();
  });

  it('provisions four teams enrolled in one tournament', async () => {
    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expect(adminRes.statusCode).toBe(200);
    adminCookie = adminRes.headers['set-cookie'] as string;

    const courseRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/courses',
      headers: { cookie: adminCookie },
      payload: { code: COURSE_CODE, name: 'Quota Policy Course' },
    });
    expect(courseRes.statusCode).toBe(200);

    const usernames = TEAM_LABELS.map((label) => `quota_captain_${label.toLowerCase()}`);
    const provRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/accounts/provision-lan',
      headers: { cookie: adminCookie },
      payload: {
        users: usernames.map((username, i) => ({
          username,
          displayName: `Quota Captain ${TEAM_LABELS[i]}`,
          role: 'STUDENT',
        })),
      },
    });
    expect(provRes.statusCode).toBe(200);
    const created = provRes.json().created as { username: string; temporaryPassword: string }[];

    const tourRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/tournaments',
      headers: { cookie: adminCookie },
      payload: { courseCode: COURSE_CODE, name: 'Quota Open 2026', format: 'SWISS_PLAYOFF' },
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

    for (let i = 0; i < usernames.length; i++) {
      const label = TEAM_LABELS[i];
      const user = created[i];
      const login = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/login',
        payload: { username: user.username, password: user.temporaryPassword },
      });
      const tempCookie = login.headers['set-cookie'] as string;
      const changed = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/change-password',
        headers: { cookie: tempCookie },
        payload: { oldPassword: user.temporaryPassword, newPassword: `QuotaPassword${label}111!` },
      });
      expect(changed.statusCode).toBe(200);

      const teamRes = await app.inject({
        method: 'POST',
        url: '/api/v2/organizer/teams',
        headers: { cookie: adminCookie },
        payload: { courseCode: COURSE_CODE, name: `Quota Team ${label}`, captainUsername: user.username },
      });
      expect(teamRes.statusCode).toBe(201);
      const teamId = teamRes.json().team.id;

      const enrollRes = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tournamentId}/enroll`,
        headers: { cookie: adminCookie },
        payload: { teamId },
      });
      expect(enrollRes.statusCode).toBe(201);

      const captain = await db.query<{ captain_user_id: string }>(
        'SELECT captain_user_id FROM teams WHERE id = $1',
        [teamId]
      );
      teamHarness.push({
        label,
        id: teamId,
        cookie: changed.headers['set-cookie'] as string,
        captainUserId: captain.rows[0].captain_user_id,
      });
    }

    expect(teamHarness).toHaveLength(4);
  });

  it('accepts 10 official receipts in the rolling hour and rejects the 11th with RECEIPTS_HOURLY', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await submitOfficial('A', `${SMOKE_BOT_SOURCE}# official receipt ${i}\n`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.receiptOrdinal).toBe(i);
      expect(res.json().data.status).toBe('VALIDATING');
      // Forging each receipt frees its PENDING_COMPILES slot, leaving the hourly window as the
      // only cap that can stop the 11th.
      await buildReceipt(res.json());
    }

    const eleventh = await submitOfficial('A', '# official receipt 11\n');
    expect(eleventh.statusCode).toBe(429);
    const body = eleventh.json();
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.message).toMatch(/quota/i);
    expect(body.details).toEqual({ quota: 'RECEIPTS_HOURLY', limit: 10, windowSeconds: 3600 });
  });

  it('keeps a concurrent receipt burst from overshooting the hourly cap', async () => {
    const target = team('C');
    const digest = await anySourceDigest();

    // Eight of the team's ten rolling-hour slots are already spent, so a 12-receipt burst
    // serializes on the tournament row lock and can only admit two: the hourly check runs
    // before the pending-compile check, so everything after the tenth receipt is refused
    // with RECEIPTS_HOURLY rather than PENDING_COMPILES.
    await db.query(
      `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       SELECT $1, $2, $3, g, $4, 'PYTHON', 'bot.py', 'READY'
       FROM generate_series(1, 8) AS g`,
      [tournamentId, target.id, target.captainUserId, digest]
    );

    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => submitOfficial('C', `${SMOKE_BOT_SOURCE}# burst ${i}\n`)));
    const accepted = burst.filter((res) => res.statusCode === 200);
    const rejected = burst.filter((res) => res.statusCode === 429);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(10);
    for (const res of rejected) {
      expect(res.json().details).toEqual({ quota: 'RECEIPTS_HOURLY', limit: 10, windowSeconds: 3600 });
    }

    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM submissions WHERE tournament_id = $1 AND team_id = $2',
      [tournamentId, team('C').id]
    );
    expect(count.rows[0].count).toBe('10');
  });

  it('isolates official receipt quotas between teams in the same tournament', async () => {
    // Team A is exhausted above; team D in the same tournament is unaffected.
    const res = await submitOfficial('D', '# isolation check\n');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.receiptOrdinal).toBe(1);
  });

  it('blocks official receipts while 2 compile-pending receipts are in flight with PENDING_COMPILES', async () => {
    const target = team('B');
    const digest = await anySourceDigest();

    await db.query(
      `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       SELECT $1, $2, $3, g, $4, 'PYTHON', 'bot.py', 'VALIDATING'
       FROM generate_series(1, 2) AS g`,
      [tournamentId, target.id, target.captainUserId, digest]
    );

    const res = await submitOfficial('B', '# third in flight\n');
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.details).toEqual({ quota: 'PENDING_COMPILES', limit: 2 });
  });

  it('rejects a 3rd pending private TEST request with TEST_PENDING and isolates it per team', async () => {
    const first = await submitPrivateTest('B', '# pending test 1\n');
    expect(first.statusCode).toBe(200);
    const second = await submitPrivateTest('B', '# pending test 2\n');
    expect(second.statusCode).toBe(200);

    const third = await submitPrivateTest('B', '# pending test 3\n');
    expect(third.statusCode).toBe(429);
    const body = third.json();
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.details).toEqual({ quota: 'TEST_PENDING', limit: 2 });

    // Team C has no pending TEST of its own: its quota is untouched.
    const other = await submitPrivateTest('C', '# isolated test\n');
    expect(other.statusCode).toBe(200);
  });

  it('enforces the daily private TEST cap with TEST_DAILY', async () => {
    const target = team('D');
    const digest = await anySourceDigest();

    // 30 terminal snapshots created today: only the daily window can trip.
    await db.query(
      `INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
       SELECT $1, $2, $3, $4, 'PYTHON', 'bot.py', 'COMPLETED'
       FROM generate_series(1, 30) AS g`,
      [tournamentId, target.id, target.captainUserId, digest]
    );

    const res = await submitPrivateTest('D', '# daily cap\n');
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.details).toEqual({ quota: 'TEST_DAILY', limit: 30 });
  });

  it.skipIf(utcMinutesSinceMidnight < 61)(
    'enforces the daily official receipt cap with RECEIPTS_DAILY',
    async () => {
      const target = team('D');
      const digest = await anySourceDigest();

      // 100 receipts stamped at the current UTC midnight: inside today's UTC day but
      // outside the rolling 60-minute window, so the daily window is the only one that can trip.
      // Ordinals start at 2 because team D already holds receipt 1 from the isolation check.
      await db.query(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status, received_at)
         SELECT $1, $2, $3, g, $4, 'PYTHON', 'bot.py', 'READY',
                (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         FROM generate_series(2, 101) AS g`,
        [tournamentId, target.id, target.captainUserId, digest]
      );

      const res = await submitOfficial('D', '# daily receipts\n');
      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.code).toBe('QUOTA_EXCEEDED');
      expect(body.details).toEqual({ quota: 'RECEIPTS_DAILY', limit: 100 });
    }
  );

  it('caps private TEST creation at 10 requests per rolling minute, counting rejected payloads', async () => {
    const target = team('A');
    // Start from an empty window for this (tournament, team) pair.
    await db.query('DELETE FROM test_create_attempts WHERE tournament_id = $1 AND team_id = $2', [
      tournamentId,
      target.id,
    ]);

    const invalidPayload = {
      teamId: target.id,
      language: 'RUST', // unsupported, so it is rejected only *after* the attempt is recorded
      entrypoint: 'bot.rs',
      zipBase64: Buffer.from('irrelevant').toString('base64'),
    };

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v2/tournaments/${tournamentId}/private-tests`,
        headers: { cookie: target.cookie },
        payload: invalidPayload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_LANGUAGE');
    }

    // The 11th request of the window is refused by the limiter, not by payload validation.
    const eleventh = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${tournamentId}/private-tests`,
      headers: { cookie: target.cookie },
      payload: invalidPayload,
    });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json().code).toBe('QUOTA_EXCEEDED');
    expect(eleventh.json().details).toEqual({ quota: 'TEST_CREATE_RATE', limit: 10 });

    // A well-formed request is refused for the same reason while the window is full.
    const blocked = await submitPrivateTest('A', '# rate limited\n');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().details).toEqual({ quota: 'TEST_CREATE_RATE', limit: 10 });

    // Rolling window, not a lockout: ageing the recorded attempts frees the team again.
    await db.query(
      `UPDATE test_create_attempts SET created_at = clock_timestamp() - interval '2 minutes'
       WHERE tournament_id = $1 AND team_id = $2`,
      [tournamentId, target.id]
    );
    const freed = await submitPrivateTest('A', '# after the window drains\n');
    expect(freed.statusCode).toBe(200);
  });
});
