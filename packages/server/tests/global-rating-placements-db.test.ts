import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { projectContestPlacements } from '../src/ratings/placements.js';

const adminUrl = process.env.OANTUTI_MIGRATION_TEST_URL;
const suite = adminUrl ? describe : describe.skip;
let admin: pg.Client;
let pool: pg.Pool;
let databaseName = '';
let roleName = '';
let passwordDirectory = '';
let courseId = '';
let teams: string[] = [];

suite('global rating placements in disposable PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (url.pathname !== '/postgres') throw new Error('OANTUTI_MIGRATION_TEST_URL must target isolated /postgres');
    databaseName = `arena_placements_test_${process.pid}_${Date.now()}`;
    roleName = `arena_placements_migrator_${process.pid}`;
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`CREATE ROLE "${roleName}" NOLOGIN`);
    await admin.query(`GRANT CREATE ON DATABASE "${databaseName}" TO "${roleName}"`);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await pool.query('CREATE EXTENSION pgcrypto');
    await pool.query(`GRANT USAGE,CREATE ON SCHEMA public TO "${roleName}"`);
    passwordDirectory = mkdtempSync(join(tmpdir(), 'placement-migration-'));
    const passwordFile = join(passwordDirectory, 'password');
    writeFileSync(passwordFile, decodeURIComponent(url.password));
    chmodSync(passwordFile, 0o600);
    const child = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'deploy/linux/apply-migrations.mts'), '--apply'], {
      cwd: process.cwd(),
      env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGDATABASE: databaseName, PGPASSWORD: undefined, PGPASSWORD_FILE: passwordFile, OANTUTI_MIGRATION_ROLE: roleName },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    expect(code, output).toBe(0);
    courseId = (await pool.query(`INSERT INTO courses(code,name) VALUES ('PLACEMENT','Placement') RETURNING id`)).rows[0].id;
    const userId = (await pool.query(`INSERT INTO users(username,display_name,password_hash,role,activation_method,password_change_required) VALUES ('placement_admin','Placement','hash','ADMIN','LOCAL_BOOTSTRAP',false) RETURNING id`)).rows[0].id;
    for (let index = 0; index < 8; index++) teams.push((await pool.query(`INSERT INTO teams(course_id,name,captain_user_id) VALUES ($1,$2,$3) RETURNING id`, [courseId, `Team ${index}`, userId])).rows[0].id);
    await pool.query(`INSERT INTO replay_objects(digest,storage_path,size_bytes,total_turns) VALUES (repeat('c',64),'placement-fixture',1,1)`);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      if (databaseName) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      if (roleName) await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
    if (passwordDirectory) rmSync(passwordDirectory, { recursive: true, force: true });
  });

  async function fixture(format: string, body: (client: pg.PoolClient, tournament: string) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tournament = (await client.query(`INSERT INTO tournaments(course_id,name,format,state,is_rated) VALUES ($1,$2,$3,'FINALIZED',true) RETURNING id`, [courseId, randomUUID(), format])).rows[0].id;
      for (const team of teams) await client.query(`INSERT INTO tournament_entries(tournament_id,team_id,status,global_rating_participant) VALUES ($1,$2,'ELIGIBLE',true)`, [tournament, team]);
      await body(client, tournament);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  async function round(client: pg.PoolClient, tournament: string, stage: string, ordinal: number, slots: number): Promise<void> {
    await client.query(`INSERT INTO tournament_rounds(tournament_id,stage,round_ordinal,status,sealed_at,slot_count) VALUES ($1,$2,$3,'COMPLETED',clock_timestamp(),$4)`, [tournament, stage, ordinal, slots]);
  }
  async function encounter(client: pg.PoolClient, tournament: string, stage: string, ordinal: number, slot: number, a: number, b: number | null, winner: number | null, status = b === null ? 'BYE' : 'COMPLETED'): Promise<string> {
    const id = (await client.query(`INSERT INTO encounters(tournament_id,stage,round_ordinal,slot_ordinal,team_a_id,team_b_id,winner_team_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [tournament, stage, ordinal, slot, teams[a], b === null ? null : teams[b], winner === null ? null : teams[winner], status])).rows[0].id;
    if (b !== null && (status === 'COMPLETED' || status === 'CANCELLED')) {
      // Reverse colors deliberately: accepted official games are not restricted to A=white.
      const game = (await client.query(`INSERT INTO games(encounter_id,game_ordinal,white_team_id,black_team_id,map_descriptor,status) VALUES ($1,1,$2,$3,'{}','COMPLETED') RETURNING id`, [id, teams[b], teams[a]])).rows[0].id;
      const result = (await client.query(`INSERT INTO result_versions(game_id,revision,verdict,winner,reason,action_trace_digest,replay_digest,manifest_digest) VALUES ($1,1,'DECISIVE',1,'fixture',repeat('d',64),repeat('c',64),repeat('e',64)) RETURNING id`, [game])).rows[0].id;
      await client.query(`INSERT INTO accepted_results(game_id,result_version_id) VALUES ($1,$2)`, [game, result]);
    }
    return id;
  }
  async function snapshot(client: pg.PoolClient, tournament: string, stage: string, indices: readonly number[], qualifiers: readonly number[] = [], ratings?: readonly number[]): Promise<void> {
    for (const [index, team] of indices.entries()) await client.query(`INSERT INTO standings_snapshots(tournament_id,stage,round_ordinal,team_id,rank,points,matches_played,wins,losses,is_qualified,rating_elo) VALUES ($1,$2,1,$3,$4,0,1,0,0,$5,$6)`, [tournament, stage, teams[team], index + 1, qualifiers.includes(team), ratings?.[index] ?? 1200]);
  }
  async function swiss(client: pg.PoolClient, tournament: string): Promise<void> {
    await round(client, tournament, 'SWISS', 1, 4);
    for (let slot = 0; slot < 4; slot++) await encounter(client, tournament, 'SWISS', 1, slot + 1, slot * 2, slot * 2 + 1, slot * 2);
    await snapshot(client, tournament, 'SWISS', [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3]);
    await round(client, tournament, 'PLAYOFF', 1, 2);
    await encounter(client, tournament, 'PLAYOFF', 1, 1, 0, 3, 0);
    await encounter(client, tournament, 'PLAYOFF', 1, 2, 1, 2, 1);
    await round(client, tournament, 'PLAYOFF', 2, 1);
    await encounter(client, tournament, 'PLAYOFF', 2, 1, 0, 1, 0);
  }

  it('uses the sealed SWISS qualifier set, playoff winner IDs and Swiss nonqualifier order', async () => {
    await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      const rows = await projectContestPlacements(client, tournament);
      expect(rows.map(({ teamId, rank, rankEnd }) => [teams.indexOf(teamId), rank, rankEnd])).toEqual([[0, 1, 1], [1, 2, 2], ...[2, 3].sort((a, b) => teams[a].localeCompare(teams[b])).map((id) => [id, 3, 4]), [4, 5, 5], [5, 6, 6], [6, 7, 7], [7, 8, 8]]);
      await client.query(`UPDATE standings_snapshots SET is_qualified=false WHERE tournament_id=$1 AND stage='SWISS' AND team_id=$2`, [tournament, teams[3]]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });

  it('rejects missing predecessor slots and wrong structural playoff advancement', async () => {
    await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      await client.query(`UPDATE encounters SET status='CANCELLED' WHERE tournament_id=$1 AND stage='PLAYOFF' AND round_ordinal=1 AND slot_ordinal=2`, [tournament]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
    await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      await client.query(`UPDATE encounters SET team_b_id=$2 WHERE tournament_id=$1 AND stage='PLAYOFF' AND round_ordinal=2`, [tournament, teams[2]]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });

  it('rejects zero/out-of-range and duplicate surviving slots instead of trusting row counts', async () => {
    for (const slot of [0, 3, 1]) await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      await client.query(`UPDATE encounters SET slot_ordinal=$2 WHERE tournament_id=$1 AND stage='PLAYOFF' AND round_ordinal=1 AND slot_ordinal=2`, [tournament, slot]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });

  it('groups equal local Elo, omits DQ, and appends withdrawal even without its final snapshot row', async () => {
    await fixture('ELO_ARENA', async (client, tournament) => {
      await round(client, tournament, 'MAIN', 1, 2);
      await encounter(client, tournament, 'MAIN', 1, 1, 0, 1, 0);
      await encounter(client, tournament, 'MAIN', 1, 2, 2, 3, 2);
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='DISQUALIFIED',status='EXCLUDED' WHERE tournament_id=$1 AND team_id=ANY($2::uuid[])`, [tournament, teams.slice(4)]);
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='WITHDRAWN',status='EXCLUDED',frozen_submission_id=NULL WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[3]]);
      await snapshot(client, tournament, 'MAIN', [0, 1, 2], [], [1300, 1300, 1200]);
      const rows = await projectContestPlacements(client, tournament);
      expect(rows.map(({ teamId, rank, rankEnd, participation }) => [teams.indexOf(teamId), rank, rankEnd, participation])).toEqual([...[0, 1].sort((a, b) => teams[a].localeCompare(teams[b])).map((id) => [id, 1, 2, 'PLACED']), [2, 3, 3, 'PLACED'], [3, 4, 4, 'WITHDRAWN']]);
      await client.query(`DELETE FROM standings_snapshots WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[2]]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });

  it('projects eight-team knockout loss groups without sports seed tie-breaking', async () => {
    await fixture('SINGLE_ELIMINATION', async (client, tournament) => {
      await round(client, tournament, 'MAIN', 1, 4);
      for (let slot = 0; slot < 4; slot++) await encounter(client, tournament, 'MAIN', 1, slot + 1, slot * 2, slot * 2 + 1, slot * 2);
      await round(client, tournament, 'MAIN', 2, 2);
      await encounter(client, tournament, 'MAIN', 2, 1, 0, 2, 0);
      await encounter(client, tournament, 'MAIN', 2, 2, 4, 6, 4);
      await round(client, tournament, 'MAIN', 3, 1);
      await encounter(client, tournament, 'MAIN', 3, 1, 0, 4, 4);
      expect((await projectContestPlacements(client, tournament)).map(({ rank, rankEnd }) => [rank, rankEnd])).toEqual([[1, 1], [2, 2], [3, 4], [3, 4], [5, 8], [5, 8], [5, 8], [5, 8]]);
      await client.query(`UPDATE encounters SET winner_team_id=NULL WHERE tournament_id=$1 AND round_ordinal=3`, [tournament]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_NO_FINAL_PLACEMENT' });
    });
  });

  it('requires accepted current evidence and sealed rounds, not cancelled played history', async () => {
    await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      await client.query(`DELETE FROM accepted_results WHERE game_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1 AND e.stage='PLAYOFF')`, [tournament]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
    await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      await client.query(`UPDATE tournament_rounds SET sealed_at=NULL WHERE tournament_id=$1 AND stage='SWISS'`, [tournament]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });

  it('compacts withdrawn playoff qualifiers once and does not require excluded Swiss snapshot rows', async () => {
    await fixture('SWISS_PLAYOFF', async (client, tournament) => {
      await swiss(client, tournament);
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='WITHDRAWN',status='EXCLUDED',frozen_submission_id=NULL WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[3]]);
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='DISQUALIFIED',status='EXCLUDED' WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[7]]);
      await client.query(`DELETE FROM standings_snapshots WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[7]]);
      const rows = await projectContestPlacements(client, tournament);
      expect(rows.map(({ teamId, rank }) => [teams.indexOf(teamId), rank])).toEqual([[0, 1], [1, 2], [2, 3], [4, 4], [5, 5], [6, 6], [3, 7]]);
      expect(rows.at(-1)?.participation).toBe('WITHDRAWN');
    });
  });

  it('requires two rating participants and an accepted non-walkover game', async () => {
    await fixture('ROUND_ROBIN', async (client, tournament) => {
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='DISQUALIFIED' WHERE tournament_id=$1 AND team_id<>$2`, [tournament, teams[0]]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_TOO_FEW_PARTICIPANTS' });
    });
    await fixture('ROUND_ROBIN', async (client, tournament) => {
      await round(client, tournament, 'MAIN', 1, 1);
      await encounter(client, tournament, 'MAIN', 1, 1, 0, 1, 0, 'WALKOVER');
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_NO_PLAYED_GAMES' });
    });
  });

  it('uses RR snapshot order and rejects a noncaptured final row', async () => {
    await fixture('ROUND_ROBIN', async (client, tournament) => {
      await round(client, tournament, 'MAIN', 1, 4);
      for (let slot = 0; slot < 4; slot++) await encounter(client, tournament, 'MAIN', 1, slot + 1, slot * 2, slot * 2 + 1, slot * 2);
      await snapshot(client, tournament, 'MAIN', [7, 6, 5, 4, 3, 2, 1, 0]);
      expect((await projectContestPlacements(client, tournament)).map((row) => teams.indexOf(row.teamId))).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
      await client.query(`UPDATE tournament_entries SET global_rating_participant=false WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[7]]);
      await client.query(`UPDATE encounters SET status='CANCELLED' WHERE tournament_id=$1 AND (team_a_id=$2 OR team_b_id=$2)`, [tournament, teams[7]]);
      await encounter(client, tournament, 'MAIN', 1, 4, 6, null, 6);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });

  it('accepts regenerated knockout EMPTY/BYE slots, DQ and withdrawal without reusing cancelled evidence', async () => {
    await fixture('SINGLE_ELIMINATION', async (client, tournament) => {
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='DISQUALIFIED',status='EXCLUDED' WHERE tournament_id=$1 AND team_id=ANY($2::uuid[])`, [tournament, teams.slice(3)]);
      await client.query(`UPDATE tournament_entries SET global_rating_exclusion='WITHDRAWN',status='EXCLUDED' WHERE tournament_id=$1 AND team_id=$2`, [tournament, teams[2]]);
      await round(client, tournament, 'MAIN', 1, 4);
      await encounter(client, tournament, 'MAIN', 1, 1, 0, 3, 0, 'CANCELLED');
      await encounter(client, tournament, 'MAIN', 1, 1, 0, null, 0);
      await encounter(client, tournament, 'MAIN', 1, 2, 1, 2, 1);
      await round(client, tournament, 'MAIN', 2, 2);
      await encounter(client, tournament, 'MAIN', 2, 1, 0, 1, 0);
      await round(client, tournament, 'MAIN', 3, 1);
      await encounter(client, tournament, 'MAIN', 3, 1, 0, null, 0);
      expect((await projectContestPlacements(client, tournament)).map(({ teamId, rank }) => [teams.indexOf(teamId), rank])).toEqual([[0, 1], [1, 2], [2, 3]]);
      await client.query(`UPDATE encounters SET status='CANCELLED' WHERE tournament_id=$1 AND round_ordinal=1 AND slot_ordinal=2`, [tournament]);
      await expect(projectContestPlacements(client, tournament)).rejects.toMatchObject({ code: 'RATING_RESULTS_INCOMPLETE' });
    });
  });
});
