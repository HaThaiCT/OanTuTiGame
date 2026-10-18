import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as zlib from 'node:zlib';
import { Database } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { TeamService } from '../src/teams/service.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { SubmissionService } from '../src/submissions/service.js';
import { registerIdentityRoutes } from '../src/identity/routes.js';
import { registerTeamRoutes } from '../src/teams/routes.js';
import { registerSubmissionRoutes } from '../src/submissions/routes.js';

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

    // Local file header (30 bytes + name + data)
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

    // Central directory header (46 bytes + name)
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

  // End of central directory record (22 bytes)
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

describe('S05 Submission Source Pipeline & Private Workspace Tests (T3a)', () => {
  let app: FastifyInstance;
  let db: Database;
  let identity: IdentityService;
  let teams: TeamService;
  let artifactStore: ArtifactStore;
  let submissions: SubmissionService;

  beforeAll(async () => {
    db = new Database();
    identity = new IdentityService(db);
    teams = new TeamService(db);
    artifactStore = new ArtifactStore(db);
    submissions = new SubmissionService(db, artifactStore);

    app = Fastify();
    registerIdentityRoutes(app, identity, ['http://localhost', 'https://localhost']);
    registerTeamRoutes(app, teams, identity);
    registerSubmissionRoutes(app, submissions, identity);
    await app.ready();

    // Clean tables
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
    const courseRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/courses',
      headers: { cookie: adminCookie },
      payload: { code: 'CS500', name: 'Advanced Bot Architecture' },
    });
    const courseId = courseRes.json().id;

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
      payload: { courseId, name: 'Vortex Alpha', captainUserId: u1.userId },
    });
    team1Id = t1Res.json().id;

    const t2Res = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/teams',
      headers: { cookie: adminCookie },
      payload: { courseId, name: 'Quantum Beta', captainUserId: u2.userId },
    });
    team2Id = t2Res.json().id;

    // Admin creates tournament & opens registration
    const tourRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/tournaments',
      headers: { cookie: adminCookie },
      payload: { courseId, name: 'Fall Bot Open 2026', format: 'SWISS_PLAYOFF' },
    });
    tournamentId = tourRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/open-registration`,
      headers: { cookie: adminCookie },
      payload: {},
    });

    // Enroll Team 1
    await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/enrollments`,
      headers: { cookie: adminCookie },
      payload: { teamId: team1Id },
    });
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

  it('submits valid multi-file source, stores artifact with fsync, and assigns monotonic receipt ordinals', async () => {
    const validBotZip1 = createZip({
      'starter_bot.py': '# Version 1\nfrom oantuti import runBot\n',
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
    firstSubmissionId = receipt1.data.submissionId;

    // Second submission by same team
    const validBotZip2 = createZip({
      'starter_bot.py': '# Version 2\nfrom oantuti import runBot\n',
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
    expect(receipt2.data.sourceDigest).not.toBe(receipt1.data.sourceDigest);

    // Latest candidate reflects the latest submission (ordinal 2)
    const meRes = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}/entries/me?teamId=${team1Id}`,
      headers: { cookie: team1Cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().candidate.receiptOrdinal).toBe(2);
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
    const testZip = createZip({ 'starter_bot.py': '# Experimental test run\n' });

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
    expect(testReceipt.data.testId).toBeDefined();

    // Candidate ordinal is STILL 2 (private test does not affect official submissions!)
    const meRes = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}/entries/me?teamId=${team1Id}`,
      headers: { cookie: team1Cookie },
    });
    expect(meRes.json().candidate.receiptOrdinal).toBe(2);
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
