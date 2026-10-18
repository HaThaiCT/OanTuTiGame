import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import type { Actor, CommandContext } from '@oantuti/protocol';

/**
 * LAN bulk direct enrollment (S14): a pasted roster is previewed before anything is written, only
 * enrollable teams land, and `maxTeams` is a real limit — a request that would exceed it writes
 * nothing rather than filling the tournament halfway.
 */
describe('S14: bulk enrollment preview and commit', () => {
  let db: PostgresDatabase;
  let admission: TournamentAdmissionService;
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    team1: randomUUID(),
    team2: randomUUID(),
    team3: randomUUID(),
    unknownTeam: randomUUID(),
    tournamentId: randomUUID(),
  };
  const actor: Actor = {
    userId: ids.userId,
    username: 'bulk-admin',
    displayName: 'Bulk Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor, requestId: randomUUID() };

  beforeAll(async () => {
    db = new PostgresDatabase();
    admission = new TournamentAdmissionService(db);
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'Bulk Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `bulk_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Bulk Course')`, [
      ids.courseId,
      `BULK_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [teamId, name] of [
      [ids.team1, 'Bulk Team 1'],
      [ids.team2, 'Bulk Team 2'],
      [ids.team3, 'Bulk Team 3'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
      // Enrollment enforces the tournament's team-size window; one captain satisfies 1–3.
      await db.query('INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2)', [teamId, ids.userId]);
    }
    // Capacity 2 for three known teams: the third one can never fit.
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, max_teams)
       VALUES ($1, $2, 'Bulk Cup', 'ROUND_ROBIN', 'REGISTRATION_OPEN', 2)`,
      [ids.tournamentId, ids.courseId]
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tournament_entries WHERE tournament_id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM tournament_admissions WHERE tournament_id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM audit_events WHERE resource_id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM tournaments WHERE id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM team_memberships WHERE team_id = ANY($1::uuid[])`, [[ids.team1, ids.team2, ids.team3]]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[ids.team1, ids.team2, ids.team3]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await db.close();
  });

  it('classifies every submitted id in a preview without writing anything', async () => {
    const student: Actor = { ...actor, role: 'STUDENT' };
    await expect(
      admission.enrollTeamsBulk(ids.tournamentId, [ids.team1], { dryRun: true }, {
        actor: student,
        requestId: randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    const report = await admission.enrollTeamsBulk(
      ids.tournamentId,
      [ids.team1, ids.team2, ids.team1, 'not-a-uuid', ids.unknownTeam],
      { dryRun: true },
      ctx
    );
    expect(report).toMatchObject({
      dryRun: true,
      submitted: 5,
      ready: 2,
      enrolled: 0,
      skipped: 3,
      capacityRemaining: 0,
    });
    expect(report.entries.map((entry) => entry.status)).toEqual([
      'READY',
      'READY',
      'DUPLICATE_IN_REQUEST',
      'INVALID_ID',
      'UNKNOWN_TEAM',
    ]);

    const entries = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tournament_entries WHERE tournament_id = $1`,
      [ids.tournamentId]
    );
    expect(entries.rows[0].count).toBe('0');
  });

  it('commits the enrollable teams and refuses to exceed capacity', async () => {
    const committed = await admission.enrollTeamsBulk(
      ids.tournamentId,
      [ids.team1, ids.team2, ids.team1, 'not-a-uuid', ids.unknownTeam],
      { dryRun: false },
      ctx
    );
    expect(committed).toMatchObject({ dryRun: false, enrolled: 2, skipped: 3, capacityRemaining: 0 });

    const enrolled = await db.query<{ team_id: string }>(
      `SELECT team_id FROM tournament_entries WHERE tournament_id = $1 ORDER BY team_id`,
      [ids.tournamentId]
    );
    expect(enrolled.rows.map((row) => row.team_id).sort()).toEqual([ids.team1, ids.team2].sort());

    // The field is full: preview says so, and a commit writes nothing at all.
    const preview = await admission.enrollTeamsBulk(ids.tournamentId, [ids.team3], { dryRun: true }, ctx);
    expect(preview.ready).toBe(0);
    expect(preview.entries[0]?.status).toBe('CAPACITY_EXCEEDED');

    await expect(
      admission.enrollTeamsBulk(ids.tournamentId, [ids.team3], { dryRun: false }, ctx)
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(admission.enrollTeam(ids.tournamentId, ids.team3, ctx)).rejects.toMatchObject({
      statusCode: 409,
    });

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tournament_entries WHERE tournament_id = $1`,
      [ids.tournamentId]
    );
    expect(after.rows[0].count).toBe('2');
    const admissions = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tournament_admissions WHERE tournament_id = $1`,
      [ids.tournamentId]
    );
    expect(admissions.rows[0].count).toBe('2');

    const outbox = await db.query<{ topic: string }>(
      `SELECT topic FROM outbox_events WHERE payload->>'tournamentId' = $1`,
      [ids.tournamentId]
    );
    expect(outbox.rows.map((row) => row.topic)).toContain('TEAMS_ENROLLED_BULK');
  });
});
