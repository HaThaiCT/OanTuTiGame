import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TeamService } from '../src/teams/service.js';

/**
 * 01 §59/§66: a student may belong to only one team per tournament. The rule has two doors — an
 * organizer enrolling a team whose member already plays in this tournament, and a captain adding a
 * member who already plays for another team here — plus the intra-request case where a bulk preview
 * lists two teams that share a member.
 */
describe('one team per student per tournament', () => {
  const db = new PostgresDatabase();
  const admission = new TournamentAdmissionService(db);
  const teams = new TeamService(db);
  const ids = {
    courseId: randomUUID(),
    adminUserId: randomUUID(),
    u1: randomUUID(),
    u2: randomUUID(),
    u3: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    teamC: randomUUID(),
    otherCourseId: randomUUID(),
    crossCourseTeam: randomUUID(),
    tournament: randomUUID(),
    tournamentBulk: randomUUID(),
    tournamentCrossCourse: randomUUID(),
  };
  const admin: Actor = {
    userId: ids.adminUserId,
    username: 'roster_admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor: admin, requestId: randomUUID() };

  beforeAll(async () => {
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, 'roster_admin', 'Roster Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.adminUserId]
    );
    for (const [userId, name] of [
      [ids.u1, 'student_one'],
      [ids.u2, 'student_two'],
      [ids.u3, 'student_three'],
    ] as const) {
      await db.query(
        `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
         VALUES ($1, $2, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED')`,
        [userId, name]
      );
    }
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Roster Course')`, [
      ids.courseId,
      `ROSTER_${ids.courseId.slice(0, 8)}`,
    ]);
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Other Roster Course')`, [ids.otherCourseId, `OTHER_${ids.otherCourseId.slice(0, 8)}`]);
    // A and B share student one; C holds student three, who is also in B (unenrolled in T).
    for (const [teamId, name, captain] of [
      [ids.teamA, 'Roster Alpha', ids.u1],
      [ids.teamB, 'Roster Beta', ids.u1],
      [ids.teamC, 'Roster Gamma', ids.u3],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        captain,
      ]);
    }
    await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1,$2,'Cross Course Team',$3)`, [ids.crossCourseTeam, ids.otherCourseId, ids.u2]);
    await db.query(`INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1,$2,'CAPTAIN')`, [ids.crossCourseTeam, ids.u2]);
    for (const [teamId, members] of [
      [ids.teamA, [ids.u1, ids.u2]],
      [ids.teamB, [ids.u1, ids.u3]],
      [ids.teamC, [ids.u3]],
    ] as const) {
      for (const member of members) {
        await db.query(`INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'MEMBER')`, [
          teamId,
          member,
        ]);
      }
    }
    for (const tournamentId of [ids.tournament, ids.tournamentBulk]) {
      await db.query(
        `INSERT INTO tournaments (id, course_id, name, format, state, max_teams, min_team_size, max_team_size)
         VALUES ($1, $2, 'Roster Cup', 'ROUND_ROBIN', 'REGISTRATION_OPEN', 8, 1, 5)`,
        [tournamentId, ids.courseId]
      );
    }
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, max_teams, min_team_size, max_team_size)
       VALUES ($1, $2, 'Cross Course Cup', 'ROUND_ROBIN', 'REGISTRATION_OPEN', 8, 1, 5)`,
      [ids.tournamentCrossCourse, ids.courseId]
    );
  });

  afterAll(async () => {
    const tournamentIds = [ids.tournament, ids.tournamentBulk, ids.tournamentCrossCourse];
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournamentIds]);
    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [tournamentIds]);
    await db.query(`DELETE FROM tournament_entries WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
    await db.query(`DELETE FROM tournament_admissions WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [tournamentIds]);
    await db.query(`DELETE FROM team_memberships WHERE team_id = ANY($1::uuid[])`, [[ids.teamA, ids.teamB, ids.teamC, ids.crossCourseTeam]]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[ids.teamA, ids.teamB, ids.teamC, ids.crossCourseTeam]]);
    await db.query(`DELETE FROM courses WHERE id = ANY($1::uuid[])`, [[ids.courseId, ids.otherCourseId]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [ids.adminUserId, ids.u1, ids.u2, ids.u3],
    ]);
    await db.close();
  });

  it('refuses a team whose member already plays in this tournament', async () => {
    const first = await admission.enrollTeam(ids.tournament, ids.teamA, ctx);
    expect(first.status).toBe('ELIGIBLE');

    await expect(admission.enrollTeam(ids.tournament, ids.teamB, ctx)).rejects.toThrow(
      /TEAM_MEMBER_ALREADY_ENROLLED/
    );

    // Student three is in B, which is not enrolled here, so C is admissible.
    const third = await admission.enrollTeam(ids.tournament, ids.teamC, ctx);
    expect(third.status).toBe('ELIGIBLE');
  });

  it('refuses adding a member who already plays for another team of an enrolled tournament', async () => {
    // Every entry, including a historical one, freezes the roster rather than changing participants.
    await expect(teams.addMember(ids.teamC, ids.u2, admin)).rejects.toThrow(/ROSTER_LOCKED/);
    await expect(teams.addMember(ids.teamC, ids.u3, admin)).rejects.toThrow(/ROSTER_LOCKED/);
  });

  it('reports the conflict inside one bulk preview instead of enrolling both', async () => {
    const preview = await admission.enrollTeamsBulk(ids.tournamentBulk, [ids.teamA, ids.teamB], { dryRun: true }, ctx);
    expect(preview.entries.map((entry) => entry.status)).toEqual(['READY', 'TEAM_MEMBER_ALREADY_ENROLLED']);
    expect(preview.ready).toBe(1);

    const committed = await admission.enrollTeamsBulk(ids.tournamentBulk, [ids.teamA], { dryRun: false }, ctx);
    expect(committed.enrolled).toBe(1);
  });
  it('allows cross-course ADMIN enrollment but keeps the one-team-per-student invariant', async () => {
    const source = await db.query<{ course_id: string }>('SELECT course_id FROM teams WHERE id=$1', [ids.crossCourseTeam]);
    const target = await db.query<{ course_id: string }>('SELECT course_id FROM tournaments WHERE id=$1', [ids.tournamentCrossCourse]);
    expect(source.rows[0].course_id).not.toBe(target.rows[0].course_id);
    const preview = await admission.enrollTeamsBulk(ids.tournamentCrossCourse, [ids.crossCourseTeam], { dryRun: true }, ctx);
    expect(preview.entries[0]?.status).toBe('READY');
    const enrolled = await admission.enrollTeam(ids.tournamentCrossCourse, ids.crossCourseTeam, ctx);
    expect(enrolled.status).toBe('ELIGIBLE');
    await expect(admission.enrollTeam(ids.tournamentCrossCourse, ids.teamA, ctx)).rejects.toThrow(/TEAM_MEMBER_ALREADY_ENROLLED/);
  });
});
