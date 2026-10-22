import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentRegistrationService } from '../src/tournaments/registration-service.js';

const adminUrl = process.env.OANTUTI_MIGRATION_TEST_URL;
const suite = adminUrl ? describe : describe.skip;

suite('030 registration upgrade preserves existing enrollment (isolated PostgreSQL)', () => {
  const courseId = randomUUID(), adminId = randomUUID(), captainId = randomUUID();
  const activeTournament = randomUUID(), excludedTournament = randomUUID();
  const activeTeam = randomUUID(), excludedTeam = randomUUID(), entryId = randomUUID(), admissionId = randomUUID();
  const captain: Actor = { userId: captainId, username: 'migration_captain', role: 'STUDENT', scope: 'FULL', teamIds: [activeTeam] };
  const adminActor: Actor = { userId: adminId, username: 'migration_admin', role: 'ADMIN', scope: 'FULL', teamIds: [] };
  const migrations = fileURLToPath(new URL('../src/persistence/migrations/', import.meta.url));
  let owner: pg.Client;
  let schema: pg.Client;
  let db: PostgresDatabase;
  let databaseName = '';
  let priorPassword: string | undefined;

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (url.pathname !== '/postgres') throw new Error('Migration tests require the isolated cluster admin database /postgres');
    databaseName = `arena_registration_test_${process.pid}_${Date.now()}`;
    priorPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = decodeURIComponent(url.password);
    owner = new pg.Client({ connectionString: adminUrl });
    await owner.connect();
    await owner.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = '/' + databaseName;
    schema = new pg.Client({ connectionString: url.toString() });
    await schema.connect();
    for (const name of (await readdir(migrations)).filter(name => /^\d{3}-.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 30).sort()) {
      await schema.query(await readFile(migrations + name, 'utf8'));
    }
    await schema.query("INSERT INTO courses(id,code,name) VALUES($1,'MIGRATION_REG','Migration registration')", [courseId]);
    await schema.query("INSERT INTO users(id,username,display_name,password_hash,role,activation_method,email,email_verified_at) VALUES($1,'migration_admin','Admin','hash','ADMIN','LOCAL_BOOTSTRAP','admin@example.test',clock_timestamp()),($2,'migration_captain','Captain','hash','STUDENT','SELF_REGISTER','captain@example.test',clock_timestamp())", [adminId, captainId]);
    await schema.query("INSERT INTO tournaments(id,course_id,name,format,state) VALUES($1,$3,'Existing cup','ROUND_ROBIN','REGISTRATION_OPEN'),($2,$3,'Excluded cup','ROUND_ROBIN','REGISTRATION_OPEN')", [activeTournament, excludedTournament, courseId]);
    await schema.query("INSERT INTO teams(id,course_id,name,captain_user_id) VALUES($1,$3,'Legacy active',$4),($2,$3,'Legacy excluded',$4)", [activeTeam, excludedTeam, courseId, captainId]);
    await schema.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$3,'CAPTAIN'),($2,$3,'CAPTAIN')", [activeTeam, excludedTeam, captainId]);
    await schema.query("INSERT INTO tournament_admissions(id,tournament_id,team_id,admitted_by_user_id,admission_type,created_at) VALUES($1,$2,$3,$4,'DIRECT_ENROLLMENT','2026-01-01T12:00:00Z')", [admissionId, activeTournament, activeTeam, adminId]);
    await schema.query("INSERT INTO tournament_entries(id,tournament_id,team_id,status) VALUES($1,$2,$3,'ELIGIBLE')", [entryId, activeTournament, activeTeam]);
    await schema.query("INSERT INTO tournament_admissions(tournament_id,team_id,admitted_by_user_id,admission_type) VALUES($1,$2,$3,'DIRECT_ENROLLMENT')", [excludedTournament, excludedTeam, adminId]);
    await schema.query("INSERT INTO tournament_entries(tournament_id,team_id,status,global_rating_exclusion) VALUES($1,$2,'EXCLUDED','PRESTART_EXCLUDED')", [excludedTournament, excludedTeam]);
    await schema.query(await readFile(migrations + '030-tournament-registrations.sql', 'utf8'));
    db = new PostgresDatabase({ host: url.hostname, port: Number(url.port || '5432'), database: databaseName, user: decodeURIComponent(url.username) });
  });

  afterAll(async () => {
    await db?.close();
    await schema?.end();
    if (owner) {
      await owner.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await owner.end();
    }
    if (priorPassword === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = priorPassword;
  });

  it('backfills only active enrollments, preserves history, and lets the legacy captain cancel without reviving policy', async () => {
    const registrations = new TournamentRegistrationService(db, 'ONLINE');
    const listed = await registrations.list(activeTournament, { actor: captain });
    expect(listed).toEqual([expect.objectContaining({ teamId: activeTeam, status: 'APPROVED', version: 1, requestedAt: '2026-01-01T12:00:00.000Z', reviewedAt: '2026-01-01T12:00:00.000Z', canCancel: true, canRequest: false })]);
    expect(await registrations.list(excludedTournament, { actor: adminActor })).toEqual([]);
    const cancelled = await registrations.cancel(activeTournament, listed[0].id, { expectedVersion: 1 }, { actor: captain });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', version: 2, canCancel: false, canRequest: false });
    expect((await db.query('SELECT id,admission_type,created_at FROM tournament_admissions WHERE tournament_id=$1', [activeTournament])).rows).toEqual([{ id: admissionId, admission_type: 'DIRECT_ENROLLMENT', created_at: new Date('2026-01-01T12:00:00Z') }]);
    expect((await db.query('SELECT id,status,global_rating_exclusion FROM tournament_entries WHERE tournament_id=$1', [activeTournament])).rows).toEqual([{ id: entryId, status: 'EXCLUDED', global_rating_exclusion: 'PRESTART_EXCLUDED' }]);
    await expect(registrations.request(activeTournament, { teamId: activeTeam }, { actor: captain })).rejects.toMatchObject({ code: 'TEAM_POLICY_MISMATCH' });
    expect((await db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0].version).toBe(30);
  });
});
