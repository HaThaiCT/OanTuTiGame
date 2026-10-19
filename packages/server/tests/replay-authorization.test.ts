import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppContext } from '../src/app.js';
import { hashToken } from '../src/identity/crypto.js';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ReplayStore } from '../src/results/replay-store.js';

// Run against a migrated, disposable PostgreSQL database: createApp starts the real job runner.
// Fixtures are uniquely named and removed, and all object files live in a per-run temporary root.
describe('official replay authorization', () => {
  let db: PostgresDatabase;
  let context: AppContext;
  let root: string;
  let courseId: string;
  let tournamentId: string;
  let gameId: string;
  let digest: string;
  let privateDigest: string;
  const users: string[] = [];
  const cookies: Record<string, string> = {};
  const runId = randomUUID();
  const replayBytes = Buffer.from(`official replay ${runId}`);

  beforeAll(async () => {
    db = new PostgresDatabase();
    root = mkdtempSync(join(tmpdir(), 'oantuti-replay-acl-'));
    const store = new ReplayStore(join(root, 'replays'), join(root, 'staging'));
    const official = store.stageReplay('official.oantuti', replayBytes);
    digest = store.promoteStagedReplay(official.stagingPath, official.digest).digest;
    const privateObject = store.stageReplay('private.oantuti', Buffer.from(`private TEST ${runId}`));
    privateDigest = store.promoteStagedReplay(privateObject.stagingPath, privateObject.digest).digest;

    for (const role of ['ADMIN', 'STUDENT', 'OPERATOR'] as const) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, 'Replay ACL', 'unused', $2, 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`replay_${role}_${runId}`, role]
      );
      users.push(user.rows[0].id);
      for (const scope of ['FULL', 'PASSWORD_CHANGE_ONLY'] as const) {
        const token = randomBytes(32).toString('hex');
        await db.query(
          `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
           VALUES ($1, $2, $3, clock_timestamp() + INTERVAL '1 day')`,
          [user.rows[0].id, hashToken(token), scope]
        );
        cookies[`${role}_${scope}`] = `oantuti_session=${token}`;
      }
    }
    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Replay ACL') RETURNING id`, [`REPLAY_${runId}`]
    );
    courseId = course.rows[0].id;
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state) VALUES ($1, 'Replay ACL', 'ROUND_ROBIN', 'DRAFT') RETURNING id`,
      [courseId]
    );
    tournamentId = tournament.rows[0].id;
    const teams = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, 'A', $2), ($1, 'B', $2) RETURNING id`,
      [courseId, users[1]]
    );
    const encounter = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, team_a_id, team_b_id) VALUES ($1, $2, $3) RETURNING id`,
      [tournamentId, teams.rows[0].id, teams.rows[1].id]
    );
    const game = await db.query<{ id: string }>(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor)
       VALUES ($1, 1, $2, $3, '{}') RETURNING id`,
      [encounter.rows[0].id, teams.rows[0].id, teams.rows[1].id]
    );
    gameId = game.rows[0].id;
    await db.query(
      `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns) VALUES ($1, $2, $3, 9)`,
      [digest, join(root, 'replays', `${digest}.oantuti`), replayBytes.length]
    );
    const result = await db.query<{ id: string }>(
      `INSERT INTO result_versions (game_id, verdict, winner, reason, action_trace_digest, replay_digest, manifest_digest)
       VALUES ($1, 'DECISIVE', 1, 'THRONE_BREACH', 'trace', $2, 'manifest') RETURNING id`, [gameId, digest]
    );
    await db.query(`INSERT INTO accepted_results (game_id, result_version_id) VALUES ($1, $2)`, [gameId, result.rows[0].id]);
    context = await createApp({ pgDb: db, botsDir: join(root, 'bots'), replaysDir: join(root, 'replays'), executionSpoolDir: join(root, 'execution') });
    await context.app.ready();
    const bots = context.db.listBots();
    context.db.createMatch({ id: 'legacy-replay-acl', mapId: 'sample-donut', whiteBotId: bots[0].id, blackBotId: bots[1].id });
    context.db.saveReplay({ matchId: 'legacy-replay-acl', filePath: 'unused', fileSizeBytes: replayBytes.length, checksumSha256: digest, replayData: replayBytes });
  });

  afterAll(async () => {
    if (context) {
      await context.app.close();
      context.db.close();
    }
    if (db) {
      if (gameId) await db.query('DELETE FROM accepted_results WHERE game_id = $1', [gameId]);
      if (tournamentId) await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
      if (courseId) {
        await db.query('DELETE FROM teams WHERE course_id = $1', [courseId]);
        await db.query('DELETE FROM courses WHERE id = $1', [courseId]);
      }
      if (digest) await db.query('DELETE FROM replay_objects WHERE digest = $1', [digest]);
      await db.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [users]);
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      await db.close();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const get = (url: string, cookie?: string) => context.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : undefined });

  it('requires FULL ADMIN before either official replay lookup, including missing targets', async () => {
    for (const url of [`/api/v2/games/${gameId}/replay`, `/api/v2/replays/${digest}`, `/api/v2/games/${randomUUID()}/replay`, `/api/v2/replays/${'0'.repeat(64)}`]) {
      expect((await get(url)).statusCode, url).toBe(401);
      expect((await get(url, 'oantuti_session=invalid')).statusCode, url).toBe(401);
      expect((await get(url, `oantuti_session=${'f'.repeat(64)}`)).statusCode, url).toBe(401);
      for (const [name, cookie] of Object.entries(cookies)) {
        if (name === 'ADMIN_FULL') continue;
        const response = await get(url, cookie);
        expect(response.statusCode, `${name} ${url}`).toBe(403);
        expect(response.headers['cache-control']).toBe('private, no-store');
      }
    }
  });

  it('serves official bytes only to FULL ADMIN with private no-store caching', async () => {
    for (const url of [`/api/v2/games/${gameId}/replay`, `/api/v2/replays/${digest}`]) {
      const response = await get(url, cookies.ADMIN_FULL);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(replayBytes);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('never lets ADMIN retrieve a private TEST object through the digest route', async () => {
    const response = await get(`/api/v2/replays/${privateDigest}`, cookies.ADMIN_FULL);
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('preserves public result summaries but withholds replay digest from every non-FULL-ADMIN reader', async () => {
    for (const cookie of [undefined, ...Object.entries(cookies).filter(([name]) => name !== 'ADMIN_FULL').map(([, value]) => value)]) {
      const response = await get(`/api/v2/games/${gameId}/result`, cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ gameId, winner: 1, reason: 'THRONE_BREACH', totalTurns: 9 });
      expect(response.json()).not.toHaveProperty('replayDigest');
    }
    const admin = await get(`/api/v2/games/${gameId}/result`, cookies.ADMIN_FULL);
    expect(admin.json().replayDigest).toBe(digest);
    expect(admin.headers['cache-control']).toBe('private, no-store');
  });

  it('serves no legacy download surface at all once the v2 control plane is mounted', async () => {
    const url = '/api/matches/legacy-replay-acl/replay';
    // The v1 match/replay routes belong to the standalone SQLite application: a v2 deployment
    // exposes the versioned API only, so neither an anonymous caller nor a legacy ADMIN cookie
    // finds a path here — there is no compatibility backdoor to guard.
    expect((await get(url)).statusCode).toBe(404);
    for (const [name, cookie] of Object.entries(cookies)) {
      expect((await get(url, cookie)).statusCode, name).toBe(404);
    }
    const token = randomBytes(32).toString('hex');
    context.db.createSession(createHash('sha256').update(token).digest('hex'), 'usr_admin_default', Date.now() + 60_000);
    expect((await get(url, `oantuti_session=${token}`)).statusCode).toBe(404);
    // The official replay is served by the v2 route under the FULL-ADMIN guard, which the cases
    // above and below assert directly.
    expect((await get(`/api/v2/games/${gameId}/replay`)).statusCode).toBe(401);
  });

  it('keeps appeal text and adjudicator notes private to the organizer and the filing team', async () => {
    const teams = await db.query<{ id: string }>(
      `SELECT id FROM teams WHERE course_id = $1 ORDER BY name`,
      [courseId]
    );
    const [teamA, teamB] = teams.rows;
    const encounter = await db.query<{ id: string }>(
      `SELECT id FROM encounters WHERE tournament_id = $1 LIMIT 1`,
      [tournamentId]
    );
    const studentId = users[1];
    // Membership — not team captaincy — is what a session's team scope is built from.
    await db.query(
      `INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2) ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamA.id, studentId]
    );

    const teamAReason = `team A appeal ${runId}`;
    const teamBReason = `team B appeal ${runId}`;
    const organizerNote = `ORGANIZER NOTE ${runId}`;
    for (const filing of [
      { team: teamA.id, reason: teamAReason, decision: null },
      { team: teamB.id, reason: teamBReason, decision: organizerNote },
    ]) {
      await db.query(
        `INSERT INTO disputes (tournament_id, encounter_id, team_id, created_by_user_id, reason, decision, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')`,
        [tournamentId, encounter.rows[0]!.id, filing.team, studentId, filing.reason, filing.decision]
      );
    }

    // Anonymous callers get nothing: the reasons and the decisions are private.
    expect((await get(`/api/v2/tournaments/${tournamentId}/disputes`)).statusCode).toBe(401);

    const student = await get(`/api/v2/tournaments/${tournamentId}/disputes`, cookies.STUDENT_FULL);
    expect(student.statusCode).toBe(200);
    const visible = student.json().disputes as Array<{ team_id: string }>;
    expect(visible.map((row) => row.team_id)).toEqual([teamA.id]);
    expect(student.rawPayload.toString()).not.toContain(teamBReason);
    expect(student.rawPayload.toString()).not.toContain(organizerNote);

    const admin = await get(`/api/v2/tournaments/${tournamentId}/disputes`, cookies.ADMIN_FULL);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().disputes).toHaveLength(2);

    // A limited session exists to change a password; it is not an operator session.
    const limited = await get(`/api/v2/tournaments/${tournamentId}/disputes`, cookies.ADMIN_PASSWORD_CHANGE_ONLY);
    expect(limited.statusCode).toBe(200);
    expect(limited.json().disputes).toEqual([]);

    // An operator without a team in this tournament sees no rival's appeal either.
    const operator = await get(`/api/v2/tournaments/${tournamentId}/disputes`, cookies.OPERATOR_FULL);
    expect(operator.statusCode).toBe(200);
    expect(operator.json().disputes).toEqual([]);
  });

  it('serves a team roster only to the organizer or one of its own members', async () => {
    const teams = await db.query<{ id: string }>(
      `SELECT id FROM teams WHERE course_id = $1 ORDER BY name`,
      [courseId]
    );
    const [teamA, teamB] = teams.rows;
    // The student session is a member of team A (inserted above); membership is what the session's
    // team scope is built from, so it is also what authorizes this read.
    expect((await get(`/api/v2/teams/${teamA.id}`)).statusCode).toBe(401);

    const own = await get(`/api/v2/teams/${teamA.id}`, cookies.STUDENT_FULL);
    expect(own.statusCode).toBe(200);
    const ownRoster: unknown = own.json();
    const ownMembers = ownRoster && typeof ownRoster === 'object' && 'members' in ownRoster && Array.isArray(ownRoster.members)
      ? ownRoster.members
      : [];
    expect(ownMembers.length).toBeGreaterThanOrEqual(1);

    // Another team's member identities are not readable, by a student or by an operator.
    for (const cookie of [cookies.STUDENT_FULL, cookies.OPERATOR_FULL]) {
      const foreign = await get(`/api/v2/teams/${teamB.id}`, cookie);
      expect(foreign.statusCode).toBe(403);
      expect(foreign.rawPayload.toString()).not.toContain('username');
    }
    const limited = await get(`/api/v2/teams/${teamA.id}`, cookies.STUDENT_PASSWORD_CHANGE_ONLY);
    expect(limited.statusCode).toBe(403);

    const admin = await get(`/api/v2/teams/${teamB.id}`, cookies.ADMIN_FULL);
    expect(admin.statusCode).toBe(200);
    const adminRoster: unknown = admin.json();
    const adminMembers = adminRoster && typeof adminRoster === 'object' && 'members' in adminRoster && Array.isArray(adminRoster.members)
      ? adminRoster.members
      : [];
    expect(Array.isArray(adminMembers)).toBe(true);
  });
});
