import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgresDatabase } from '../src/persistence/db.js';
import { GlobalTeamRatingService } from '../src/ratings/service.js';
import { IdentityService } from '../src/identity/service.js';
import { hashToken } from '../src/identity/crypto.js';
import { registerGlobalRatingRoutes } from '../src/ratings/routes.js';
import { TeamService } from '../src/teams/service.js';
import { registerTeamRoutes } from '../src/teams/routes.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { projectContestPlacements } from '../src/ratings/placements.js';
import { registerAdmissionRoutes } from '../src/tournaments/routes.js';
import { EXPECTED_SCHEMA_VERSION } from '../src/persistence/schema-version.js';

const adminUrl = process.env.OANTUTI_MIGRATION_TEST_URL;
const suite = adminUrl ? describe : describe.skip;
const root = process.cwd();
const migrationCli = join(root, 'deploy/linux/apply-migrations.mts');
let databaseName = '';
let roleName = '';
let passwordDirectory = '';
let priorPassword: string | undefined;
let admin: pg.Client;
let db: PostgresDatabase;
let ratings: GlobalTeamRatingService;
let app: FastifyInstance;
let adminId = '';
let adminCookie = '';
let courseId = '';
let teamA = '';
let teamB = '';
let tournamentId = '';

function databaseUrl(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function migrate(): Promise<void> {
  const url = new URL(adminUrl!);
  const child = spawn(process.execPath, ['--import', 'tsx', migrationCli, '--apply'], {
    cwd: root,
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGDATABASE: databaseName, PGPASSWORD: undefined, PGPASSWORD_FILE: join(passwordDirectory, 'password'), OANTUTI_MIGRATION_ROLE: roleName },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  expect(code, output).toBe(0);
}

suite('global rating publication', () => {
  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (url.pathname !== '/postgres') throw new Error('OANTUTI_MIGRATION_TEST_URL must target the isolated cluster admin database /postgres');
    databaseName = `arena_rating_test_${process.pid}_${Date.now()}`;
    roleName = `arena_rating_migrator_${process.pid}`;
    passwordDirectory = mkdtempSync(join(tmpdir(), 'rating-migration-'));
    writeFileSync(join(passwordDirectory, 'password'), decodeURIComponent(url.password));
    chmodSync(join(passwordDirectory, 'password'), 0o600);
    priorPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = decodeURIComponent(url.password);
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`CREATE ROLE "${roleName}" NOLOGIN`);
    await admin.query(`GRANT CREATE ON DATABASE "${databaseName}" TO "${roleName}"`);
    const schema = new pg.Client({ connectionString: databaseUrl(databaseName) });
    await schema.connect();
    await schema.query('CREATE EXTENSION pgcrypto');
    await schema.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${roleName}"`);
    await schema.end();
    await migrate();
    db = new PostgresDatabase({ host: url.hostname, port: Number(url.port || '5432'), database: databaseName, user: decodeURIComponent(url.username) });
    ratings = new GlobalTeamRatingService(db);
    const identity = new IdentityService(db);
    const user = await db.query<{ id: string }>(`INSERT INTO users(username,display_name,password_hash,role,activation_method,password_change_required) VALUES ('rating_admin','Rating Admin','hash','ADMIN','LOCAL_BOOTSTRAP',false) RETURNING id`);
    adminId = user.rows[0].id;
    const token = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO sessions(user_id,token_hash,scope,expires_at,reauthenticated_at) VALUES ($1,$2,'FULL',clock_timestamp()+interval '1 hour',clock_timestamp())`, [adminId, hashToken(token)]);
    adminCookie = `oantuti_session=${token}`;
    courseId = (await db.query<{ id: string }>(`INSERT INTO courses(code,name) VALUES ('RATING','Rating') RETURNING id`)).rows[0].id;
    teamA = (await db.query<{ id: string }>(`INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,'Alpha',$2) RETURNING id`, [courseId, adminId])).rows[0].id;
    teamB = (await db.query<{ id: string }>(`INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,'Beta',$2) RETURNING id`, [courseId, adminId])).rows[0].id;
    tournamentId = (await db.query<{ id: string }>(`INSERT INTO tournaments(course_id,name,format,state,is_rated) VALUES ($1,'Rated Cup','ROUND_ROBIN','DRAFT',true) RETURNING id`, [courseId])).rows[0].id;
    app = Fastify();
    registerTeamRoutes(app, new TeamService(db), identity);
    registerGlobalRatingRoutes(app, ratings, identity);
    registerAdmissionRoutes(app, new TournamentAdmissionService(db, undefined, undefined, ratings), identity);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
    if (priorPassword === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = priorPassword;
    rmSync(passwordDirectory, { recursive: true, force: true });
  });
  it('hides public tournament rating endpoints while the tournament is DRAFT', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/v2/tournaments/${tournamentId}/rating-changes` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v2/tournaments/${tournamentId}/team-ratings` })).statusCode).toBe(404);
  });

  it('enforces public pagination boundaries and private decision authorization', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v2/ratings/teams?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v2/ratings/teams?cursor=not-json' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v2/ratings/teams/not-a-uuid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v2/ratings/teams/00000000-0000-4000-8000-000000000099' })).statusCode).toBe(404);
    const decision = { reason: 'Rejected in authorization fixture', expectedVersion: 1 };
    const url = `/api/v2/organizer/tournaments/${tournamentId}/rating-reject`;
    expect((await app.inject({ method: 'POST', url, payload: decision })).statusCode).toBe(401);
    const student = (await db.query<{ id: string }>(`INSERT INTO users(username,display_name,password_hash,role,activation_method,password_change_required) VALUES ('rating_student','Rating Student','hash','STUDENT','ADMIN_ISSUED',false) RETURNING id`)).rows[0].id;
    const studentToken = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO sessions(user_id,token_hash,scope,expires_at,reauthenticated_at) VALUES ($1,$2,'FULL',clock_timestamp()+interval '1 hour',clock_timestamp())`, [student, hashToken(studentToken)]);
    expect((await app.inject({ method: 'GET', url: `/api/v2/organizer/tournaments/${tournamentId}/rating-review`, headers: { cookie: `oantuti_session=${studentToken}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: `oantuti_session=${studentToken}` }, payload: decision })).statusCode).toBe(403);
    const unconfirmedToken = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO sessions(user_id,token_hash,scope,expires_at) VALUES ($1,$2,'FULL',clock_timestamp()+interval '1 hour')`, [adminId, hashToken(unconfirmedToken)]);
    const unconfirmed = await app.inject({ method: 'POST', url, headers: { cookie: `oantuti_session=${unconfirmedToken}` }, payload: decision });
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json().code).toBe('REAUTH_REQUIRED');
  });

  it('returns service unavailable rather than an empty leaderboard for database failures', async () => {
    const unavailable = new Error('socket failure') as Error & { code: string };
    unavailable.code = 'ECONNREFUSED';
    const app = Fastify();
    registerGlobalRatingRoutes(app, {
      publicLeaderboard: async () => { throw unavailable; },
      publicProfile: async () => { throw unavailable; },
      publicTournamentChanges: async () => { throw unavailable; },
      publicTournamentTeamRatings: async () => { throw unavailable; },
      setRated: async () => { throw unavailable; },
      review: async () => { throw unavailable; },
      approve: async () => { throw unavailable; },
      reject: async () => { throw unavailable; },
    }, new IdentityService(db));
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/ratings/teams' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'RATING_DATABASE_UNAVAILABLE' });
      expect(response.json()).not.toHaveProperty('rows');
    } finally { await app.close(); }
  });
  it('applies migration 027 and registers the live rated configuration route with FULL ADMIN authorization', async () => {
    expect(Number((await db.query<{ version: number }>('SELECT max(version) AS version FROM schema_migrations')).rows[0].version)).toBe(EXPECTED_SCHEMA_VERSION);
    expect((await db.query(`SELECT to_regclass('public.global_rating_control') AS name`)).rows[0].name).toBe('global_rating_control');
    expect((await app.inject({ method: 'POST', url: `/api/v2/organizer/tournaments/${tournamentId}/rated`, payload: { isRated: true, expectedVersion: 1 } })).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: `/api/v2/organizer/tournaments/${tournamentId}/rated`, headers: { cookie: adminCookie }, payload: { isRated: true, expectedVersion: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tournamentId, isRated: true, version: 2 });
  });
  it('defaults new tournaments to unrated and strictly rejects nonboolean rated choices', async () => {
    const defaulted = await app.inject({ method: 'POST', url: '/api/v2/organizer/tournaments', headers: { cookie: adminCookie }, payload: { courseCode: 'RATING', name: 'Default Unrated Cup', format: 'ROUND_ROBIN' } });
    expect(defaulted.statusCode).toBe(201);
    expect(defaulted.json().tournament.is_rated).toBe(false);
    const rated = await app.inject({ method: 'POST', url: '/api/v2/organizer/tournaments', headers: { cookie: adminCookie }, payload: { courseCode: 'RATING', name: 'Rated Cup', format: 'ROUND_ROBIN', isRated: true } });
    expect(rated.statusCode).toBe(201);
    expect(rated.json().tournament.is_rated).toBe(true);
    const invalid = await app.inject({ method: 'POST', url: '/api/v2/organizer/tournaments', headers: { cookie: adminCookie }, payload: { courseCode: 'RATING', name: 'Bad Rated Cup', format: 'ROUND_ROBIN', isRated: 'true' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('searches and enrolls persistent teams across courses for FULL ADMIN', async () => {
    const otherCourseId = (await db.query<{ id: string }>(`INSERT INTO courses(code,name) VALUES ('OTHER','Other Course') RETURNING id`)).rows[0].id;
    const otherTeamId = (await db.query<{ id: string }>(`INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,'Cross Course Alpha',$2) RETURNING id`, [otherCourseId, adminId])).rows[0].id;
    await db.query(`INSERT INTO team_memberships(team_id,user_id,role) VALUES ($1,$2,'CAPTAIN')`, [otherTeamId, adminId]);
    const tournament = (await db.query<{ id: string }>(`INSERT INTO tournaments(course_id,name,format,state,max_teams) VALUES ($1,'Reuse Cup','ROUND_ROBIN','REGISTRATION_OPEN',8) RETURNING id`, [courseId])).rows[0].id;
    const response = await app.inject({ method: 'GET', url: '/api/v2/organizer/teams?q=Cross%20Course&limit=10', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().teams).toEqual([{ id: otherTeamId, name: 'Cross Course Alpha', courseId: otherCourseId, courseCode: 'OTHER' }]);
    const admitted = await new TournamentAdmissionService(db).enrollTeam(tournament, otherTeamId, { actor: { userId: adminId as never, role: 'ADMIN', scope: 'FULL' }, requestId: randomBytes(16).toString('hex') as never });
    expect(admitted.status).toBe('ELIGIBLE');
  });

  it('freezes rated configuration after finalization and creates a PENDING contest without rating rows', async () => {
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE tournaments SET state='FINALIZED' WHERE id=$1`, [tournamentId]);
      await ratings.prepareFinalization(client, tournamentId);
    });
    await expect(ratings.setRated(tournamentId, false, { actor: { userId: adminId as never, role: 'ADMIN', scope: 'FULL' }, requestId: '00000000-0000-4000-8000-000000000001' as never, expectedVersion: 2 })).rejects.toMatchObject({ message: 'RATING_CONFIGURATION_FROZEN' });
    expect((await db.query<{ review_state: string; desired_included: boolean }>('SELECT review_state,desired_included FROM global_rating_contests WHERE tournament_id=$1', [tournamentId])).rows[0]).toEqual({ review_state: 'PENDING', desired_included: false });
    expect(Number((await db.query<{ count: string }>('SELECT count(*)::text AS count FROM global_team_ratings')).rows[0].count)).toBe(0);
  });
  it('ignores retained cancelled evidence and blocks missing current evidence', async () => {
    await db.withTransaction(async (client) => {
      const fixtureTournament = (await client.query<{ id: string }>(`INSERT INTO tournaments(course_id,name,format,state) VALUES ($1,'Placement Fixture','ROUND_ROBIN','FINALIZED') RETURNING id`, [courseId])).rows[0].id;
      const fixtureTeams = [teamA, teamB];
      await client.query(`INSERT INTO tournament_entries(tournament_id,team_id,status,global_rating_participant) VALUES ($1,$2,'ELIGIBLE',true),($1,$3,'ELIGIBLE',true)`, [fixtureTournament, ...fixtureTeams]);
      await client.query(`INSERT INTO replay_objects(digest,storage_path,size_bytes,total_turns) VALUES (repeat('c',64),'placement-fixture',1,1)`);
      await client.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,sealed_at,slot_count) VALUES ($1,'MAIN',1,'COMPLETED',clock_timestamp(),1)`, [fixtureTournament]);
      const oldEncounter = (await client.query<{ id: string }>(`INSERT INTO encounters(tournament_id,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,1,1,$2,$3,'CANCELLED',NULL) RETURNING id`, [fixtureTournament, ...fixtureTeams])).rows[0].id;
      const oldGame = (await client.query<{ id: string }>(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) VALUES ($1,1,$2,$3,'{}','COMPLETED') RETURNING id`, [oldEncounter, ...fixtureTeams])).rows[0].id;
      const result = (await client.query<{ id: string }>(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',1,'fixture',repeat('d',64),repeat('c',64),repeat('e',64)) RETURNING id`, [oldGame])).rows[0].id;
      await client.query(`INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)`, [oldGame, result]);
      const currentEncounter = (await client.query<{ id: string }>(`INSERT INTO encounters(tournament_id,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,1,1,$2,$3,'COMPLETED',$2) RETURNING id`, [fixtureTournament, ...fixtureTeams])).rows[0].id;
      const currentGame = (await client.query<{ id: string }>(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) VALUES ($1,1,$2,$3,'{}','COMPLETED') RETURNING id`, [currentEncounter, ...fixtureTeams])).rows[0].id;
      const currentResult = (await client.query<{ id: string }>(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',1,'fixture',repeat('f',64),repeat('c',64),repeat('e',64)) RETURNING id`, [currentGame])).rows[0].id;
      await client.query(`INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)`, [currentGame, currentResult]);
      await client.query(`INSERT INTO standings_snapshots(tournament_id,stage,round_ordinal,team_id,rank,points,matches_played,wins,losses) VALUES ($1,'MAIN',1,$2,1,1,1,1,0),($1,'MAIN',1,$3,2,0,1,0,1)`, [fixtureTournament, ...fixtureTeams]);
      const placements = await projectContestPlacements(client, fixtureTournament);
      expect(placements.map((row) => row.teamId)).toEqual(fixtureTeams);
      expect(placements[0].rank).toBe(1);
      await client.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,sealed_at,slot_count) VALUES ($1,'MAIN',2,'COMPLETED',clock_timestamp(),1)`, [fixtureTournament]);
      const latestEncounter = (await client.query<{ id: string }>(`INSERT INTO encounters(tournament_id,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,2,1,$2,$3,'COMPLETED',$3) RETURNING id`, [fixtureTournament, ...fixtureTeams])).rows[0].id;
      const latestGame = (await client.query<{ id: string }>(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) VALUES ($1,1,$2,$3,'{}','COMPLETED') RETURNING id`, [latestEncounter, ...fixtureTeams])).rows[0].id;
      const latestResult = (await client.query<{ id: string }>(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',2,'latest fixture',repeat('a',64),repeat('c',64),repeat('b',64)) RETURNING id`, [latestGame])).rows[0].id;
      await client.query(`INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)`, [latestGame, latestResult]);
      await client.query(`INSERT INTO standings_snapshots(tournament_id,stage,round_ordinal,team_id,rank,points,matches_played,wins,losses) VALUES ($1,'MAIN',2,$2,1,0,1,0,1)`, [fixtureTournament, teamB]);
      await expect(projectContestPlacements(client, fixtureTournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
      await client.query(`INSERT INTO standings_snapshots(tournament_id,stage,round_ordinal,team_id,rank,points,matches_played,wins,losses) VALUES ($1,'MAIN',2,$2,2,1,1,1,0)`, [fixtureTournament, teamA]);
      const latestPlacements = await projectContestPlacements(client, fixtureTournament);
      expect(latestPlacements.map((row) => [row.teamId, row.rank])).toEqual([[teamB, 1], [teamA, 2]]);
      await client.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,slot_count) VALUES ($1,'MAIN',3,'RUNNING',1)`, [fixtureTournament]);
      await expect(projectContestPlacements(client, fixtureTournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
      await client.query(`DELETE FROM tournament_rounds WHERE tournament_id=$1 AND stage='MAIN' AND round_ordinal=3`, [fixtureTournament]);
      await client.query(`UPDATE tournament_entries SET status='EXCLUDED',global_rating_exclusion='WITHDRAWN' WHERE tournament_id=$1 AND team_id=$2`, [fixtureTournament, teamB]);
      const withdrawnPlacements = await projectContestPlacements(client, fixtureTournament);
      expect(withdrawnPlacements.map(({ teamId, rank, participation }) => [teamId, rank, participation])).toEqual([
        [teamA, 1, 'PLACED'], [teamB, 2, 'WITHDRAWN'],
      ]);
      throw new Error('ROLLBACK_PLACEMENT_FIXTURE');
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'ROLLBACK_PLACEMENT_FIXTURE') throw error;
    });
  });

  it('projects a regenerated bracket with DQ, BYE, and post-start withdrawal', async () => {
    await db.withTransaction(async (client) => {
      const thirdTeam = (await client.query<{ id: string }>(`INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,'Knockout Third',$2) RETURNING id`, [courseId, adminId])).rows[0].id;
      const disqualifiedTeam = (await client.query<{ id: string }>(`INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,'Knockout DQ',$2) RETURNING id`, [courseId, adminId])).rows[0].id;
      const fixture = (await client.query<{ id: string }>(`INSERT INTO tournaments(course_id,name,format,state,is_rated) VALUES ($1,'Bye Fixture','SINGLE_ELIMINATION','FINALIZED',true) RETURNING id`, [courseId])).rows[0].id;
      await client.query(`INSERT INTO tournament_entries(tournament_id,team_id,status,global_rating_participant,global_rating_exclusion) VALUES
        ($1,$2,'ELIGIBLE',true,NULL),($1,$3,'EXCLUDED',true,'WITHDRAWN'),($1,$4,'ELIGIBLE',true,NULL),($1,$5,'EXCLUDED',true,'DISQUALIFIED')`,
        [fixture, teamA, teamB, thirdTeam, disqualifiedTeam]);
      await client.query(`INSERT INTO replay_objects(digest,storage_path,size_bytes,total_turns) VALUES (repeat('c',64),'bye-fixture',1,1) ON CONFLICT (digest) DO NOTHING`);
      await client.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,sealed_at,slot_count) VALUES ($1,'MAIN',1,'COMPLETED',clock_timestamp(),2),($1,'MAIN',2,'COMPLETED',clock_timestamp(),1)`, [fixture]);
      await client.query(`INSERT INTO encounters(tournament_id,stage,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,'MAIN',1,1,$2,$3,'COMPLETED',$2)`, [fixture, teamA, teamB]);
      await client.query(`INSERT INTO encounters(tournament_id,stage,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,'MAIN',1,2,$2,NULL,'BYE',$2)`, [fixture, thirdTeam]);
      const finalId = (await client.query<{ id: string }>(`INSERT INTO encounters(tournament_id,stage,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,'MAIN',2,1,$2,$3,'COMPLETED',$2) RETURNING id`, [fixture, teamA, thirdTeam])).rows[0].id;
      const semifinal = (await client.query<{ id: string }>(`SELECT id FROM encounters WHERE tournament_id=$1 AND stage='MAIN' AND round_ordinal=1 AND slot_ordinal=1`, [fixture])).rows[0].id;
      for (const encounterId of [semifinal, finalId]) {
        const gameId = (await client.query<{ id: string }>(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) SELECT $1,1,team_a_id,team_b_id,'{}','COMPLETED' FROM encounters WHERE id=$1 RETURNING id`, [encounterId])).rows[0].id;
        const resultId = (await client.query<{ id: string }>(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',1,'bye fixture',repeat('d',64),repeat('c',64),repeat('e',64)) RETURNING id`, [gameId])).rows[0].id;
        await client.query(`INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)`, [gameId, resultId]);
      }
      const placements = await projectContestPlacements(client, fixture);
      expect(placements.map(({ teamId, rank, participation }) => [teamId, rank, participation])).toEqual([
        [teamA, 1, 'PLACED'], [thirdTeam, 2, 'PLACED'], [teamB, 3, 'WITHDRAWN'],
      ]);
      expect(placements.some(({ teamId }) => teamId === disqualifiedTeam)).toBe(false);
      throw new Error('ROLLBACK_KNOCKOUT_FIXTURE');
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'ROLLBACK_KNOCKOUT_FIXTURE') throw error;
    });
  });

  it('approves once, replays the decision idempotently, and rebuilds rows after rejection and reopen', async () => {
    await db.query(`INSERT INTO tournament_entries(tournament_id,team_id,status,global_rating_participant) VALUES ($1,$2,'ELIGIBLE',true),($1,$3,'ELIGIBLE',true)`, [tournamentId, teamA, teamB]);
    await db.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,sealed_at,slot_count) VALUES ($1,'MAIN',1,'COMPLETED',clock_timestamp(),1)`, [tournamentId]);
    const encounter = (await db.query<{ id: string }>(`INSERT INTO encounters(tournament_id,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,1,1,$2,$3,'COMPLETED',$2) RETURNING id`, [tournamentId, teamA, teamB])).rows[0].id;
    const game = (await db.query<{ id: string }>(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) VALUES ($1,1,$2,$3,'{}','COMPLETED') RETURNING id`, [encounter, teamA, teamB])).rows[0].id;
    await db.query(`INSERT INTO replay_objects(digest,storage_path,size_bytes,total_turns) VALUES (repeat('c',64),'rating-test',1,1)`);
    const result = (await db.query<{ id: string }>(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',1,'rating test',repeat('d',64),repeat('c',64),repeat('e',64)) RETURNING id`, [game])).rows[0].id;
    await db.query(`INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)`, [game, result]);
    await db.query(`INSERT INTO standings_snapshots(tournament_id,stage,round_ordinal,team_id,rank,points,matches_played,wins,losses) VALUES ($1,'MAIN',1,$2,1,1,1,1,0),($1,'MAIN',1,$3,2,0,1,0,1)`, [tournamentId, teamA, teamB]);
    const review = await ratings.review(tournamentId);
    expect(review.status).toBe('PENDING');
    expect(review.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    const context = { actor: { userId: adminId as never, role: 'ADMIN' as const, scope: 'FULL' as const }, requestId: '00000000-0000-4000-8000-000000000003' as never, expectedVersion: 2, idempotencyKey: 'approve-rating-decision-0001' };
    const approvalResponse = await app.inject({ method: 'POST', url: `/api/v2/organizer/tournaments/${tournamentId}/rating-approve`, headers: { cookie: adminCookie, 'idempotency-key': context.idempotencyKey }, payload: { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: 2 } });
    expect(approvalResponse.statusCode, approvalResponse.body).toBe(202);
    const approved = approvalResponse.json();
    const replayed = await ratings.approve(tournamentId, { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: 2 }, context);
    expect(replayed).toEqual(approved);
    expect(Number((await db.query<{ count: string }>('SELECT count(*)::text AS count FROM command_receipts WHERE scope=$1', [`GLOBAL_RATING_APPROVE:${tournamentId}`])).rows[0].count)).toBe(1);
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_events WHERE action='GLOBAL_RATING_APPROVED'`)).rows[0].count)).toBe(1);
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic='GLOBAL_RATING_APPROVED'`)).rows[0].count)).toBe(1);
    const updatingReview = await ratings.review(tournamentId);
    expect(updatingReview.updating).toBe(true);
    expect(updatingReview.previewDigest).toBeNull();
    expect(updatingReview.changes).toEqual([]);
    await ratings.rebuildPending();
    expect(Number((await db.query<{ count: string }>('SELECT count(*)::text AS count FROM global_team_ratings')).rows[0].count)).toBe(2);
    const leaderboardResponse = await app.inject({ method: 'GET', url: '/api/v2/ratings/teams?limit=1' });
    expect(leaderboardResponse.statusCode).toBe(200);
    expect(leaderboardResponse.headers['cache-control']).toBe('no-store');
    const leaderboard = leaderboardResponse.json();
    expect(leaderboard.rows).toHaveLength(1);
    expect(leaderboard.rows[0]).not.toHaveProperty('courseId');
    expect(leaderboard.rows[0]).not.toHaveProperty('captainUserId');
    expect(leaderboard.nextCursor).toEqual(expect.any(String));
    const oldCursor = leaderboard.nextCursor as string;
    const publicProfile = await app.inject({ method: 'GET', url: `/api/v2/ratings/teams/${teamA}` });
    expect(publicProfile.statusCode).toBe(200);
    expect(publicProfile.json().history).toHaveLength(1);
    expect(publicProfile.json()).not.toHaveProperty('members');
    const rejected = await ratings.reject(tournamentId, { reason: 'Invalidated result', expectedVersion: approved.tournamentVersion }, { ...context, expectedVersion: approved.tournamentVersion, idempotencyKey: 'reject-rating-decision-0001' });
    expect(rejected.status).toBe('UPDATING');
    const beforeReplacement = await ratings.publicProfile(teamA, { limit: 25 });
    expect(beforeReplacement.history).toHaveLength(1);
    expect(beforeReplacement.rating.rating).not.toBeNull();
    expect((await ratings.publicLeaderboard({ limit: 10 })).rows).toHaveLength(2);
    expect((await ratings.publicTournamentChanges(tournamentId)).changes).toHaveLength(2);
    const pendingChanges = await ratings.publicTournamentChanges(tournamentId);
    expect(pendingChanges.reviewState).toBe('REJECTED');
    expect(pendingChanges.publication.updating).toBe(true);
    expect(pendingChanges.changes).toHaveLength(2);
    expect(pendingChanges).not.toHaveProperty('reason');
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_events WHERE action='GLOBAL_RATING_REJECTED'`)).rows[0].count)).toBe(1);
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic='GLOBAL_RATING_REJECTED'`)).rows[0].count)).toBe(1);
    await ratings.rebuildPending();
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_events WHERE action='GLOBAL_RATING_GENERATION_PUBLISHED'`)).rows[0].count)).toBe(2);
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic='GLOBAL_RATING_GENERATION_PUBLISHED'`)).rows[0].count)).toBe(2);
    expect(Number((await db.query<{ count: string }>('SELECT count(*)::text AS count FROM global_team_ratings WHERE generation_id=(SELECT active_generation FROM global_rating_control WHERE singleton=true)')).rows[0].count)).toBe(0);
    const stalePage = await app.inject({ method: 'GET', url: `/api/v2/ratings/teams?limit=1&cursor=${encodeURIComponent(oldCursor)}` });
    expect(stalePage.statusCode).toBe(409);
    expect(stalePage.json().code).toBe('RATING_PAGE_STALE');
    expect(stalePage.json().message).toBe('RATING_PAGE_STALE');
    await db.query(`UPDATE global_rating_contests SET desired_included=true,review_state='APPROVED' WHERE tournament_id=$1`, [tournamentId]);
    await db.query(`UPDATE global_rating_control SET desired_revision=desired_revision+1 WHERE singleton=true`);
    await db.withTransaction((client) => ratings.invalidateOnReopen(client, tournamentId, { actor: context.actor, requestId: '00000000-0000-4000-8000-000000000004' as never }));
    expect((await db.query<{ desired_included: boolean; review_state: string }>('SELECT desired_included,review_state FROM global_rating_contests WHERE tournament_id=$1', [tournamentId])).rows[0]).toEqual({ desired_included: false, review_state: 'PENDING' });
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_events WHERE action='GLOBAL_RATING_REOPENED'`)).rows[0].count)).toBe(1);
    expect(Number((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox_events WHERE topic='GLOBAL_RATING_REOPENED'`)).rows[0].count)).toBe(1);
    expect(await ratings.approve(tournamentId, { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: 2 }, context)).toEqual(approved);
  });
});
