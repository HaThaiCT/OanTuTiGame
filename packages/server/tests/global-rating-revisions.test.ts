import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { GlobalTeamRatingService } from '../src/ratings/service.js';
import * as calculator from '../src/ratings/calculator.js';
import { BackupFence } from '../src/operations/backup-fence.js';
import { TournamentControlPlane } from '../src/tournaments/control-plane.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { JobBroker } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import { RetentionService } from '../src/operations/retention-service.js';

const adminUrl = process.env.OANTUTI_MIGRATION_TEST_URL;
const suite = adminUrl ? describe : describe.skip;
suite('global rating immutable inputs and revision replacement (disposable PostgreSQL)', () => {
  let admin: pg.Client;
  let db: PostgresDatabase;
  let service: GlobalTeamRatingService;
  const database = `arena_rating_revision_test_${process.pid}_${Date.now()}`;
  const role = `arena_rating_revision_${process.pid}`;
  let directory = '';
  let priorPassword: string | undefined;
  let actor: CommandContext['actor'];
  let course: string;
  let teams: string[];
  const context = (): CommandContext => ({ actor, requestId: randomUUID() as never, idempotencyKey: randomUUID() });
  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (url.pathname !== '/postgres') throw new Error('Use an isolated administrative /postgres URL, never a demo database');
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
    await admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${role}"`);
    const target = new URL(url); target.pathname = `/${database}`;
    const schema = new pg.Client({ connectionString: target.toString() }); await schema.connect();
    await schema.query('CREATE EXTENSION pgcrypto');
    await schema.query(`GRANT USAGE,CREATE ON SCHEMA public TO "${role}"`); await schema.end();
    directory = mkdtempSync(join(tmpdir(), 'rating-revisions-'));
    writeFileSync(join(directory, 'password'), decodeURIComponent(url.password), { mode: 0o600 });
    priorPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = decodeURIComponent(url.password);
    const child = spawn(process.execPath, ['--import', 'tsx', 'deploy/linux/apply-migrations.mts', '--apply'], { env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGDATABASE: database, PGPASSWORD: undefined, PGPASSWORD_FILE: join(directory, 'password'), OANTUTI_MIGRATION_ROLE: role } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const completion = Promise.withResolvers<number | null>();
    child.once('close', completion.resolve); child.once('error', completion.reject);
    expect(await completion.promise, output).toBe(0);
    db = new PostgresDatabase({ host: url.hostname, port: Number(url.port || '5432'), database, user: decodeURIComponent(url.username) });
    service = new GlobalTeamRatingService(db);
    const user = (await db.query<{ id: string }>(`INSERT INTO users(username,display_name,password_hash,role,activation_method,password_change_required) VALUES ('revision_admin','Revision Admin','hash','ADMIN','LOCAL_BOOTSTRAP',false) RETURNING id`)).rows[0].id;
    actor = { userId: user as never, role: 'ADMIN', scope: 'FULL' };
    course = (await db.query<{ id: string }>(`INSERT INTO courses(code,name) VALUES ('REVISIONS','Revisions') RETURNING id`)).rows[0].id;
    teams = [];
    for (const name of ['A', 'B']) teams.push((await db.query<{ id: string }>('INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,$2,$3) RETURNING id', [course, name, user])).rows[0].id);
    await db.query(`INSERT INTO replay_objects(digest,storage_path,size_bytes,total_turns) VALUES (repeat('a',64),'revision-fixture',1,1)`);
  }, 120000);
  beforeEach(async () => {
    await db.query('TRUNCATE global_rating_changes,global_team_ratings,global_rating_generations,global_rating_decisions,global_rating_contests,command_receipts');
    await db.query('UPDATE global_rating_control SET desired_revision=0,active_revision=0,active_generation=NULL,next_publication_order=1');
  });
  it('gates decisions while updating and rejects/unrates without sports side effects', async () => {
    const a = await contest('Reject A'); const b = await contest('Reject B');
    const pending = await approve(a.id);
    await expect(service.reject(b.id, { reason: 'Not suitable', expectedVersion: 1 }, context())).rejects.toMatchObject({ message: 'RATING_UPDATE_IN_PROGRESS' });
    expect(await service.approve(a.id, pending.command, pending.ctx)).toEqual(pending.receipt);
    await service.rebuildPending();
    const oldJobs = (await db.query('SELECT * FROM jobs ORDER BY id')).rows;
    const oldResults = (await db.query('SELECT * FROM accepted_results ORDER BY game_id')).rows;
    const reviewed = await service.review(a.id);
    const rejected = await service.reject(a.id, { reason: 'Invalid contest field', expectedVersion: reviewed.tournamentVersion }, context());
    expect(rejected.status).toBe('UPDATING');
    expect((await service.publicTournamentChanges(a.id)).changes).toHaveLength(2);
    await service.rebuildPending();
    expect((await service.publicTournamentChanges(a.id)).changes).toEqual([]);
    expect((await db.query('SELECT * FROM jobs ORDER BY id')).rows).toEqual(oldJobs);
    expect((await db.query('SELECT * FROM accepted_results ORDER BY game_id')).rows).toEqual(oldResults);
    const neverApproved = await service.reject(b.id, { reason: 'Insufficient confidence', expectedVersion: 1 }, context());
    expect(neverApproved.status).toBe('REJECTED');
    await expect(service.reject(b.id, { reason: 'Insufficient confidence', expectedVersion: neverApproved.tournamentVersion }, context())).rejects.toMatchObject({ message: 'RATING_ALREADY_REJECTED' });
    await db.query('UPDATE tournaments SET is_rated=false WHERE id=$1', [b.id]);
    await expect(service.reject(b.id, { reason: 'Not suitable', expectedVersion: neverApproved.tournamentVersion }, context())).rejects.toMatchObject({ message: 'TOURNAMENT_UNRATED' });
    await db.query(`UPDATE tournaments SET is_rated=true,state='PROVISIONAL' WHERE id=$1`, [b.id]);
    await expect(service.reject(b.id, { reason: 'Not suitable', expectedVersion: neverApproved.tournamentVersion }, context())).rejects.toMatchObject({ message: 'RATING_NOT_FINAL' });
  });
  it('discards a paused obsolete build after reopen and releases its session for the next invocation', async () => {
    const a = await contest('Superseded A'); await approve(a.id);
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const calculate = calculator.calculateContestRatingAsync;
    const spy = vi.spyOn(calculator, 'calculateContestRatingAsync').mockImplementation(async entries => { entered.resolve(); await resume.promise; return calculate(entries); });
    const build = service.rebuildPending();
    try {
      await entered.promise;
      expect((await service.publicLeaderboard({ limit: 100 })).rows).toEqual([]);
      await db.withTransaction(async client => { await service.lockForTournamentTransition(client, a.id); await service.invalidateOnReopen(client, a.id, context()); await client.query(`UPDATE tournaments SET state='PROVISIONAL',version=version+1 WHERE id=$1`, [a.id]); });
      resume.resolve(); await build;
      expect((await service.publicLeaderboard({ limit: 100 })).publication).toMatchObject({ generationId: null, updating: true });
      expect((await db.query('SELECT * FROM global_rating_generations')).rows).toEqual([]);
    } finally { resume.resolve(); await build; spy.mockRestore(); }
    await service.rebuildPending();
    expect((await service.publicLeaderboard({ limit: 100 })).publication.updating).toBe(false);
    expect((await service.publicLeaderboard({ limit: 100 })).rows).toEqual([]);
  });
  it('excludes a worker in another process and releases its session lock on child exit', async () => {
    const a = await contest('Cross-process old'); await approve(a.id); await service.rebuildPending();
    const b = await contest('Cross-process pending'); await approve(b.id);
    const before = await service.publicLeaderboard({ limit: 100 });
    const source = `import pg from 'pg';
      const client = new pg.Client(JSON.parse(process.env.RATING_CHILD_CONFIG));
      await client.connect();
      await client.query("SELECT pg_advisory_lock(hashtextextended('ArenaGlobalRatingWorker/v1',0))");
      process.stdout.write('LOCKED\\n');
      process.stdin.resume();
      process.stdin.once('data', () => { process.exit(0); });`;
    const url = new URL(adminUrl!);
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { env: { ...process.env, RATING_CHILD_CONFIG: JSON.stringify({ host: url.hostname, port: Number(url.port || '5432'), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database }) }, stdio: ['pipe','pipe','pipe'] });
    const ready = Promise.withResolvers<void>(); const exited = Promise.withResolvers<number | null>();
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED\n')) ready.resolve(); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { ready.reject(error); exited.reject(error); });
    child.once('close', code => { exited.resolve(code); if (!output.includes('LOCKED\n')) ready.reject(new Error(`Lock child exited ${code}: ${errors}`)); });
    try {
      await ready.promise;
      await service.rebuildPending();
      expect((await service.publicLeaderboard({ limit: 100 })).publication.generationId).toBe(before.publication.generationId);
      expect((await service.publicLeaderboard({ limit: 100 })).rows).toEqual(before.rows);
      child.stdin.end('exit\n');
      expect(await exited.promise, errors).toBe(0);
      await service.rebuildPending();
      expect((await service.publicLeaderboard({ limit: 100 })).publication).toMatchObject({ updating: false });
      expect((await service.publicLeaderboard({ limit: 100 })).publication.generationId).not.toBe(before.publication.generationId);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited.promise; }
  });
  it('keeps old publication readable when a real enforced backup fence rejects decisions and rebuilds', async () => {
    const a = await contest('Backup old'); await approve(a.id); await service.rebuildPending();
    const before = await service.publicLeaderboard({ limit: 100 });
    const oldChanges = await service.publicTournamentChanges(a.id);
    const oldProfile = await service.publicProfile(teams[0], { limit: 25 });
    const b = await contest('Backup pending'); const review = await service.review(b.id);
    const fenced = new GlobalTeamRatingService(db, new BackupFence(db, { enforcement: 'enforce', maxLagMinutes: 5 }));
    expect((await new BackupFence(db, { enforcement: 'enforce', maxLagMinutes: 5 }).status()).stale).toBe(true);
    await expect(fenced.approve(b.id, { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: review.tournamentVersion }, context())).rejects.toThrow('no valid verified offhost backup');
    expect((await service.review(b.id)).tournamentVersion).toBe(review.tournamentVersion);
    await approve(b.id);
    const pendingControl = (await db.query('SELECT * FROM global_rating_control')).rows;
    const generations = (await db.query('SELECT * FROM global_rating_generations ORDER BY id')).rows;
    await expect(fenced.rebuildPending()).rejects.toThrow('no valid verified offhost backup');
    expect((await db.query('SELECT * FROM global_rating_control')).rows).toEqual(pendingControl);
    expect((await db.query('SELECT * FROM global_rating_generations ORDER BY id')).rows).toEqual(generations);
    expect((await fenced.publicLeaderboard({ limit: 100 })).rows).toEqual(before.rows);
    expect((await fenced.publicProfile(teams[0], { limit: 25 })).history).toEqual(oldProfile.history);
    expect((await fenced.publicTournamentChanges(a.id)).changes).toEqual(oldChanges.changes);
    expect((await fenced.publicLeaderboard({ limit: 100 })).publication.updating).toBe(true);
    await fenced.stop(); await service.rebuildPending();
  });
  it('runs real deadline and sealing duties while the rating calculator is paused', async () => {
    const a = await contest('Paused rating'); await approve(a.id);
    const sport = await contest('Seal during rating');
    await db.query(`UPDATE tournaments SET state='RUNNING',is_rated=false WHERE id=$1`, [sport.id]);
    await db.query(`UPDATE tournament_entries SET seed_ordinal=CASE WHEN team_id=$2 THEN 1 ELSE 2 END WHERE tournament_id=$1`, [sport.id, teams[0]]);
    await db.query(`UPDATE tournament_rounds SET status='SEAL_ELIGIBLE',sealed_at=NULL,seal_eligible_at=clock_timestamp()-interval '1 second' WHERE tournament_id=$1`, [sport.id]);
    const deadline = (await db.query<{ id: string }>(`INSERT INTO tournaments(course_id,name,format,state,registration_closes_at) VALUES ($1,'Deadline during rating','ROUND_ROBIN','REGISTRATION_OPEN',clock_timestamp()-interval '1 minute') RETURNING id`, [course])).rows[0].id;
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const calculate = calculator.calculateContestRatingAsync;
    const spy = vi.spyOn(calculator, 'calculateContestRatingAsync').mockImplementation(async entries => { entered.resolve(); await resume.promise; return calculate(entries); });
    const broker = new JobBroker(db); const scheduler = new TournamentSchedulerService(db, broker);
    const control = new TournamentControlPlane(db, broker, new JobReconciler(db), scheduler, new RetentionService(db), 5000, 3600000, undefined, service);
    const seal = vi.spyOn(scheduler, 'sealEligibleRounds');
    try {
      service.kickRebuild(); await entered.promise;
      await control.tick();
      expect((await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id=$1', [deadline])).rows[0].state).toBe('VALIDATING_SUBMISSIONS');
      expect((await db.query<{ sealed_at: Date | null }>('SELECT sealed_at FROM tournament_rounds WHERE tournament_id=$1', [sport.id])).rows[0].sealed_at).not.toBeNull();
      expect(seal).toHaveBeenCalled();
      expect((await service.publicLeaderboard({ limit: 100 })).publication).toMatchObject({ generationId: null, updating: true });
      await control.tick();
      expect(seal).toHaveBeenCalledTimes(2);
    } finally {
      control.stop(); resume.resolve(); spy.mockRestore(); seal.mockRestore();
      // A fresh instance on the next test remains usable; shutdown waits for the active invocation.
      await service.stop(); service = new GlobalTeamRatingService(db);
    }
  });
  it('contains termination of an idle worker backend and never publishes after losing the session lock', async () => {
    const a = await contest('Termination old'); await approve(a.id); await service.rebuildPending();
    const old = await service.publicLeaderboard({ limit: 100 });
    const b = await contest('Termination pending'); await approve(b.id);
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<Error>();
    const calculate = calculator.calculateContestRatingAsync;
    const calculateSpy = vi.spyOn(calculator, 'calculateContestRatingAsync').mockImplementation(async entries => { entered.resolve(); await resume.promise; return calculate(entries); });
    const connect = db.connectDedicated.bind(db);
    let workerPid = 0;
    const connectionSpy = vi.spyOn(db, 'connectDedicated').mockImplementation(async () => {
      const client = await connect();
      workerPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      client.once('error', disconnected.resolve);
      return client;
    });
    const build = service.rebuildPending();
    const outcome = build.then(() => null, (error: unknown) => error);
    try {
      await entered.promise;
      expect((await db.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [workerPid])).rows[0].terminated).toBe(true);
      await disconnected.promise;
      resume.resolve(); expect(await outcome).toBeInstanceOf(Error);
      expect((await service.publicLeaderboard({ limit: 100 })).rows).toEqual(old.rows);
      expect((await service.publicLeaderboard({ limit: 100 })).publication).toMatchObject({ generationId: old.publication.generationId, updating: true });
    } finally { resume.resolve(); await outcome; calculateSpy.mockRestore(); connectionSpy.mockRestore(); }
    await service.rebuildPending();
    expect((await service.publicLeaderboard({ limit: 100 })).publication.updating).toBe(false);
  });
  it('refuses cursor bigint overflow before executing a PostgreSQL cast', async () => {
    const a = await contest('Cursor bounds'); await approve(a.id); await service.rebuildPending();
    const generationId = (await service.publicLeaderboard({ limit: 100 })).publication.generationId!;
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const invalid of ['9223372036854775808', '999999999999999999999999999', '0', '-1', '01']) {
      await expect(service.publicProfile(teams[0], { limit: 25, cursor: encode({ generationId, lastPublicationOrder: invalid }) })).rejects.toMatchObject({ statusCode: 400, message: 'INVALID_RATING_CURSOR' });
      await expect(service.publicProfile(teams[0], { limit: 25, cursor: encode({ generationId: invalid, lastPublicationOrder: '1' }) })).rejects.toMatchObject({ statusCode: 400, message: 'INVALID_RATING_CURSOR' });
      await expect(service.publicLeaderboard({ limit: 25, cursor: encode({ generationId: invalid, lastRating: 1500, teamId: teams[0] }) })).rejects.toMatchObject({ statusCode: 400, message: 'INVALID_RATING_CURSOR' });
    }
    expect((await service.publicProfile(teams[0], { limit: 25, cursor: encode({ generationId, lastPublicationOrder: '9223372036854775807' }) })).history).toHaveLength(1);
  });
  it('preserves full-generation competition rank when equal ratings span leaderboard pages', async () => {
    const extra = [];
    for (const name of ['Gamma', 'Delta']) extra.push((await db.query<{ id: string }>('INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,$2,$3) RETURNING id', [course, name, actor.userId])).rows[0].id);
    const generation = (await db.query<{ id: string }>('INSERT INTO global_rating_generations(desired_revision) VALUES (1) RETURNING id')).rows[0].id;
    const allTeams = [...teams, ...extra];
    for (const teamId of allTeams) await db.query('INSERT INTO global_team_ratings(generation_id,team_id,rating,max_rating,rated_contests,last_publication_order) VALUES ($1,$2,1500,1500,1,1)', [generation, teamId]);
    await db.query('UPDATE global_rating_control SET active_generation=$1,active_revision=1,desired_revision=1', [generation]);
    const first = await service.publicLeaderboard({ limit: 1 });
    const second = await service.publicLeaderboard({ limit: 1, cursor: first.nextCursor! });
    expect(first.rows[0].rank).toBe(1);
    expect(second.rows[0].rank).toBe(1);
    expect(second.rows[0].rating.rating).toBe(1500);
  });
  afterAll(async () => {
    await service?.stop(); await db?.close();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end(); }
    if (priorPassword === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = priorPassword;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function contest(name: string): Promise<{ id: string; result: string }> {
    return db.withTransaction(async client => {
      const id = (await client.query<{ id: string }>(`INSERT INTO tournaments(course_id,name,format,state,is_rated) VALUES ($1,$2,'ROUND_ROBIN','FINALIZED',true) RETURNING id`, [course, name])).rows[0].id;
      await client.query(`INSERT INTO tournament_entries(tournament_id,team_id,status,global_rating_participant) VALUES ($1,$2,'ELIGIBLE',true),($1,$3,'ELIGIBLE',true)`, [id, ...teams]);
      await client.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,sealed_at,slot_count) VALUES ($1,'MAIN',1,'COMPLETED',clock_timestamp(),1)`, [id]);
      const encounter = (await client.query<{ id: string }>(`INSERT INTO encounters(tournament_id,round_ordinal,slot_ordinal,team_a_id,team_b_id,status,winner_team_id) VALUES ($1,1,1,$2,$3,'COMPLETED',$2) RETURNING id`, [id, ...teams])).rows[0].id;
      const game = (await client.query<{ id: string }>(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) VALUES ($1,1,$2,$3,'{}','COMPLETED') RETURNING id`, [encounter, ...teams])).rows[0].id;
      const result = (await client.query<{ id: string }>(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',1,'fixture',repeat('b',64),repeat('a',64),repeat('c',64)) RETURNING id`, [game])).rows[0].id;
      await client.query('INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)', [game, result]);
      await client.query(`INSERT INTO standings_snapshots(tournament_id,stage,round_ordinal,team_id,rank,points,matches_played,wins,losses) VALUES ($1,'MAIN',1,$2,1,1,1,1,0),($1,'MAIN',1,$3,2,0,1,0,1)`, [id, ...teams]);
      await service.prepareFinalization(client, id); return { id, result };
    });
  }
  async function approve(id: string) {
    const review = await service.review(id);
    const command = { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: review.tournamentVersion };
    const ctx = context(); const receipt = await service.approve(id, command, ctx);
    return { review, command, ctx, receipt };
  }
  it('hashes changed accepted evidence even when placements do not move, but ignores approval-only version bumps', async () => {
    const cup = await contest('Source Cup'); const before = await service.review(cup.id);
    await db.query(`UPDATE result_versions SET action_trace_digest=repeat('d',64) WHERE id=$1`, [cup.result]);
    const after = await service.review(cup.id);
    expect(after.placements).toEqual(before.placements); expect(after.sourceDigest).not.toBe(before.sourceDigest);
    await expect(service.approve(cup.id, { previewDigest: before.previewDigest!, generationId: before.generationId, expectedVersion: before.tournamentVersion }, context())).rejects.toMatchObject({ message: 'RATING_PREVIEW_STALE' });
    await approve(cup.id); await service.rebuildPending();
    expect((await service.review(cup.id)).sourceDigest).toBe(after.sourceDigest);
  });
  it('rebuilds successors at the original slot, captures reapproved names, and replays receipts after reopen', async () => {
    const a = await contest('A original'); const b = await contest('B original');
    const first = await approve(a.id); await service.rebuildPending(); await approve(b.id); await service.rebuildPending();
    const aBefore = await service.publicTournamentChanges(a.id); const bBefore = await service.publicTournamentChanges(b.id);
    const pagedProfile = await service.publicProfile(teams[0], { limit: 1 });
    expect(pagedProfile.history).toHaveLength(1); expect(pagedProfile.ratingPoints).toHaveLength(2);
    await db.query('UPDATE tournaments SET name=$2 WHERE id=$1', [a.id, 'A renamed']);
    expect((await service.publicTournamentChanges(a.id)).changes).toEqual(aBefore.changes);
    await db.withTransaction(async client => { await service.lockForTournamentTransition(client, a.id); await service.invalidateOnReopen(client, a.id, context()); await client.query(`UPDATE tournaments SET state='PROVISIONAL',version=version+1 WHERE id=$1`, [a.id]); });
    expect((await service.publicTournamentChanges(a.id)).changes).toEqual(aBefore.changes);
    expect((await service.publicProfile(teams[0], { limit: 25 })).publication.updating).toBe(true);
    expect(await service.approve(a.id, first.command, first.ctx)).toEqual(first.receipt);
    await service.rebuildPending(); expect((await service.publicTournamentChanges(a.id)).changes).toEqual([]);
    const bAlone = await service.publicTournamentChanges(b.id);
    expect(bAlone.changes.every(row => row.oldPublicRating === null)).toBe(true);
    expect(bAlone.changes.map(row => row.oldRating)).not.toEqual(bBefore.changes.map(row => row.oldRating));
    await db.query(`UPDATE tournaments SET state='FINALIZED',version=version+1 WHERE id=$1`, [a.id]);
    const preview = await service.review(a.id);
    expect(preview.changes.every(row => row.oldPublicRating === null)).toBe(true);
    const restored = await approve(a.id); await service.rebuildPending();
    const aAfter = await service.publicTournamentChanges(a.id); const bAfter = await service.publicTournamentChanges(b.id);
    expect(aAfter.changes.map(row => row.publicationOrder)).toEqual(aBefore.changes.map(row => row.publicationOrder));
    expect(aAfter.changes.every(row => row.tournamentName === 'A renamed')).toBe(true);
    expect(aAfter.changes.map(row => row.newRating)).toEqual(restored.review.changes.map(row => row.newRating));
    expect(bAfter.changes.map(row => row.newRating)).toEqual(bBefore.changes.map(row => row.newRating));
    expect(await service.approve(a.id, first.command, first.ctx)).toEqual(first.receipt);
    await expect(service.approve(a.id, { ...first.command, expectedVersion: 999 }, first.ctx)).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
  });
  it('serializes competing approvals and worker sessions, and rolls back an injected pointer-switch failure', async () => {
    const cup = await contest('Concurrent Cup'); const review = await service.review(cup.id);
    const command = { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: review.tournamentVersion };
    const results = await Promise.allSettled([service.approve(cup.id, command, context()), service.approve(cup.id, command, context())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const old = await service.publicLeaderboard({ limit: 100 });
    await db.query(`CREATE FUNCTION fail_rating_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.active_generation IS DISTINCT FROM OLD.active_generation THEN RAISE EXCEPTION 'injected rating failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER fail_rating_pointer BEFORE UPDATE ON global_rating_control FOR EACH ROW EXECUTE FUNCTION fail_rating_pointer()`);
    try { await expect(service.rebuildPending()).rejects.toThrow('injected rating failure'); expect((await service.publicLeaderboard({ limit: 100 })).rows).toEqual(old.rows); }
    finally { await db.query('DROP TRIGGER fail_rating_pointer ON global_rating_control'); await db.query('DROP FUNCTION fail_rating_pointer()'); }
    const lock = await db.connectDedicated();
    try { await lock.query(`SELECT pg_advisory_lock(hashtextextended('ArenaGlobalRatingWorker/v1',0))`); await service.rebuildPending(); expect((await service.publicLeaderboard({ limit: 100 })).publication.generationId).toBe(old.publication.generationId); }
    finally { await lock.end(); }
    const restarted = new GlobalTeamRatingService(db); await Promise.all([service.rebuildPending(), restarted.rebuildPending()]); await restarted.stop();
    expect((await service.publicLeaderboard({ limit: 100 })).publication.updating).toBe(false);
  });
});
