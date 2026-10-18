import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database } from '../src/persistence/db.js';
import { IdentityService, IdentityError } from '../src/identity/service.js';
import { TeamService, TeamError } from '../src/teams/service.js';
import type { Actor } from '@oantuti/protocol';

describe('S03 Production Identity, Teams & Tournament Substrate (PostgreSQL 16)', () => {
  let db: Database;
  let identity: IdentityService;
  let teams: TeamService;
  let adminActor: Actor;

  beforeAll(async () => {
    db = new Database();
    identity = new IdentityService(db);
    teams = new TeamService(db);

    // Clean test schema tables in development db
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM tournament_entries');
      await client.query('DELETE FROM tournament_admissions');
      await client.query('DELETE FROM tournaments');
      await client.query('DELETE FROM team_memberships');
      await client.query('DELETE FROM teams');
      await client.query('DELETE FROM courses');
      await client.query('DELETE FROM sessions');
      await client.query('DELETE FROM users');
      await client.query('DELETE FROM audit_events');
      await client.query('DELETE FROM deployment_settings');
    });

    // Bootstrap singleton Admin
    const admin = await identity.bootstrapAdmin('system_admin', 'AdminPassword123!');
    expect(admin.username).toBe('system_admin');
    expect(admin.role).toBe('ADMIN');

    // Logging in as Admin gives FULL session
    const adminSession = await identity.login('system_admin', 'AdminPassword123!');
    expect(adminSession.scope).toBe('FULL');
    adminActor = {
      userId: admin.id,
      username: admin.username,
      role: 'ADMIN',
      teamIds: [],
      scope: 'FULL',
    };
  });

  afterAll(async () => {
    await db.close();
  });

  it('enforces singleton ADMIN account bootstrap', async () => {
    await expect(identity.bootstrapAdmin('second_admin', 'Password123!')).rejects.toThrow(IdentityError);
  });

  it('provisions LAN bulk student accounts with unique temporary passwords and forced password change', async () => {
    const entries = [
      { username: 'student_alice', displayName: 'Alice Liddell', role: 'STUDENT' as const },
      { username: 'student_bob', displayName: 'Bob Builder', role: 'STUDENT' as const },
      { username: 'student_charlie', displayName: 'Charlie Brown', role: 'STUDENT' as const },
    ];

    const provisioned = await identity.lanBulkProvision(entries, adminActor);
    expect(provisioned.length).toBe(3);
    expect(new Set(provisioned.map((p) => p.temporaryPassword)).size).toBe(3);

    // Non-admin cannot bulk provision
    const studentActor: Actor = {
      userId: provisioned[0].userId,
      username: provisioned[0].username,
      role: 'STUDENT',
      teamIds: [],
      scope: 'FULL',
    };
    await expect(identity.lanBulkProvision([{ username: 'hacker', displayName: 'H', role: 'STUDENT' }], studentActor)).rejects.toThrow(IdentityError);
  });

  it('forces password change workflow on initial student login', async () => {
    const [alice] = await identity.lanBulkProvision(
      [{ username: 'alice_first', displayName: 'Alice First', role: 'STUDENT' }],
      adminActor
    );

    // Login with temporary password
    const tempSession = await identity.login('alice_first', alice.temporaryPassword);
    expect(tempSession.scope).toBe('PASSWORD_CHANGE_ONLY');
    expect(tempSession.user.passwordChangeRequired).toBe(true);

    // Authenticate token returns PASSWORD_CHANGE_ONLY actor
    const auth = await identity.authenticateToken(tempSession.token);
    expect(auth?.actor.scope).toBe('PASSWORD_CHANGE_ONLY');

    // Change password to permanent password
    const fullSession = await identity.changePassword(alice.userId, alice.temporaryPassword, 'PermanentPassword456!');
    expect(fullSession.scope).toBe('FULL');
    expect(fullSession.user.passwordChangeRequired).toBe(false);

    // Previous temporary session is revoked
    const oldAuth = await identity.authenticateToken(tempSession.token);
    expect(oldAuth).toBeUndefined();

    // Full session works
    const newAuth = await identity.authenticateToken(fullSession.token);
    expect(newAuth?.actor.scope).toBe('FULL');

    // Re-login with permanent password
    const reLogin = await identity.login('alice_first', 'PermanentPassword456!');
    expect(reLogin.scope).toBe('FULL');
  });

  it('manages courses, teams, and tournament admission substrate atomically', async () => {
    // 1. Admin creates course
    const course = await teams.createCourse('CS301', 'Algorithm & Tournament Competition', adminActor);
    expect(course.code).toBe('CS301');

    // 2. Admin provisions team members
    const [p1, p2] = await identity.lanBulkProvision(
      [
        { username: 'team_player1', displayName: 'Player One', role: 'STUDENT' },
        { username: 'team_player2', displayName: 'Player Two', role: 'STUDENT' },
      ],
      adminActor
    );

    // 3. Admin creates team and assigns captain
    const team = await teams.createTeam(course.id, 'Dragon Slayers', p1.userId, adminActor);
    expect(team.name).toBe('Dragon Slayers');
    expect(team.members.length).toBe(1);
    expect(team.members[0].role).toBe('CAPTAIN');

    // 4. Add second member
    const updatedTeam = await teams.addMember(team.id, p2.userId, adminActor);
    expect(updatedTeam.members.length).toBe(2);

    // 5. Prevent duplicate member in same team
    await expect(teams.addMember(team.id, p2.userId, adminActor)).rejects.toThrow(TeamError);

    // 6. Admin creates tournament substrate (starts in DRAFT)
    const tournament = await teams.createTournament(
      {
        courseId: course.id,
        name: 'Fall 2026 Grand Championship',
        format: 'SWISS_PLAYOFF',
        maxTeams: 10,
        minTeamSize: 1,
        maxTeamSize: 3,
      },
      adminActor
    );
    expect(tournament.state).toBe('DRAFT');
    expect(tournament.version).toBe(1);

    // 7. Publish tournament
    const published = await teams.publishTournament(tournament.id, adminActor);
    expect(published.state).toBe('PUBLISHED');
    expect(published.version).toBe(2);

    // 8. Open registration
    const open = await teams.openRegistration(tournament.id, undefined, undefined, adminActor);
    expect(open.state).toBe('REGISTRATION_OPEN');
    expect(open.version).toBe(3);

    // 9. Admin direct enrolls team into tournament
    const { admissionId, entryId } = await teams.directEnrollTeam(tournament.id, team.id, adminActor);
    expect(admissionId).toBeDefined();
    expect(entryId).toBeDefined();

    // 10. Check tournament admitted count updated
    const tCheck = await teams.getTournamentSubstrate(tournament.id);
    expect(tCheck.admittedTeamCount).toBe(1);

    // 11. Prevent double enrollment of the same team
    await expect(teams.directEnrollTeam(tournament.id, team.id, adminActor)).rejects.toThrow(TeamError);

    // 12. Non-admin cannot direct enroll
    const nonAdminActor: Actor = {
      userId: p1.userId,
      username: 'team_player1',
      role: 'STUDENT',
      teamIds: [team.id],
      scope: 'FULL',
    };
    await expect(teams.directEnrollTeam(tournament.id, team.id, nonAdminActor)).rejects.toThrow(TeamError);
  });
});
