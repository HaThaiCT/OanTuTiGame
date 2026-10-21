import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, scryptSync } from 'node:crypto';
import { hashToken } from '../src/identity/crypto.js';
import { Database } from '../src/persistence/db.js';
import { IdentityService, IdentityError } from '../src/identity/service.js';
import { TeamService, TeamError } from '../src/teams/service.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import type { Actor } from '@oantuti/protocol';

describe('S03 Production Identity, Teams & Tournament Substrate (PostgreSQL 16)', () => {
  let db: Database;
  let identity: IdentityService;
  let teams: TeamService;
  let admissions: TournamentAdmissionService;
  let adminActor: Actor;

  beforeAll(async () => {
    db = new Database();
    identity = new IdentityService(db);
    teams = new TeamService(db);
    admissions = new TournamentAdmissionService(db);

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

    // Concurrent bootstrap must retain one administrator, never demote existing users.
    const bootstraps = await Promise.allSettled([
      identity.bootstrapAdmin('system_admin', 'AdminPassword123!'),
      identity.bootstrapAdmin('second_candidate', 'AdminPassword123!'),
    ]);
    expect(bootstraps.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = bootstraps.find((result) => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('No bootstrap winner');
    const admin = winner.value;
    await db.query("UPDATE users SET username = 'system_admin' WHERE id = $1", [admin.id]);
    await db.query("INSERT INTO deployment_settings(key, value) VALUES ('accountCapacity', '{\"limit\":1000}')");
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

  it('expires and consumes LAN credentials once, resets students and revokes every session', async () => {
    const [student] = await identity.lanBulkProvision([{ username: 'reset_student', displayName: 'Reset', role: 'STUDENT' }], adminActor);
    const limited = await identity.login(student.username, student.temporaryPassword);
    await expect(identity.login(student.username, student.temporaryPassword)).rejects.toMatchObject({ statusCode: 401 });
    const full = await identity.changePassword(student.userId, student.temporaryPassword, 'PermanentPassword456!');
    const reset = await identity.resetLanStudentPassword(student.userId, adminActor);
    expect(reset.temporaryPassword).not.toBe(student.temporaryPassword);
    expect(await identity.authenticateToken(limited.token)).toBeUndefined();
    expect(await identity.authenticateToken(full.token)).toBeUndefined();
    await expect(identity.login(student.username, 'PermanentPassword456!')).rejects.toMatchObject({ statusCode: 401 });
    await db.query("UPDATE users SET temporary_password_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [student.userId]);
    await expect(identity.login(student.username, reset.temporaryPassword)).rejects.toMatchObject({ statusCode: 401 });
    const renewed = await identity.resetLanStudentPassword(student.userId, adminActor);
    const session = await identity.login(student.username, renewed.temporaryPassword);
    await identity.revokeUserSessions(student.userId, adminActor);
    expect(await identity.authenticateToken(session.token)).toBeUndefined();
    await expect(identity.resetLanStudentPassword(adminActor.userId, adminActor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(identity.resetLanStudentPassword(student.userId, { ...adminActor, scope: 'PASSWORD_CHANGE_ONLY' })).rejects.toMatchObject({ statusCode: 403 });
    const events = await identity.listAuditEvents(adminActor, student.userId);
    expect(events.map((event) => event.action)).toContain('LAN_PASSWORD_RESET');
    expect(JSON.stringify(events)).not.toContain(renewed.temporaryPassword);
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

    // 9. Admin direct-enrolls the team through the one admission path
    const entry = await admissions.enrollTeam(tournament.id, team.id, {
      actor: adminActor,
      requestId: randomUUID(),
    });
    expect(entry.teamId).toBe(team.id);
    expect(entry.status).toBe('ELIGIBLE');

    // 10. Check tournament admitted count updated
    const tCheck = await teams.getTournamentSubstrate(tournament.id);
    expect(tCheck.admittedTeamCount).toBe(1);

    // 11. Prevent double enrollment of the same team
    await expect(
      admissions.enrollTeam(tournament.id, team.id, { actor: adminActor, requestId: randomUUID() })
    ).rejects.toMatchObject({ statusCode: 409 });

    // 12. Non-admin cannot direct enroll
    const nonAdminActor: Actor = {
      userId: p1.userId,
      username: 'team_player1',
      role: 'STUDENT',
      teamIds: [team.id],
      scope: 'FULL',
    };
    await expect(
      admissions.enrollTeam(tournament.id, team.id, { actor: nonAdminActor, requestId: randomUUID() })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('only upgrades legacy hashes after a successful password authentication', async () => {
    const salt = 'ab'.repeat(16);
    const legacy = `scrypt$${salt}$${scryptSync('OldPass123!', salt, 64).toString('hex')}`;
    const [student] = await identity.lanBulkProvision([{ username: 'legacy_student', displayName: 'Legacy', role: 'STUDENT' }], adminActor);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [legacy, student.userId]);
    await expect(identity.login(student.username, 'incorrect password')).rejects.toMatchObject({ statusCode: 401 });
    const before = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [student.userId]);
    expect(before.rows[0].password_hash).toBe(legacy);
    const session = await identity.login(student.username, 'OldPass123!');
    expect(session.scope).toBe('PASSWORD_CHANGE_ONLY');
    const after = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [student.userId]);
    expect(after.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    await expect(identity.changePassword(student.userId, 'OldPass123!', 'too-short')).rejects.toMatchObject({ statusCode: 400 });
    await expect(identity.changePassword(student.userId, 'OldPass123!', '🔒'.repeat(129))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enforces idle, absolute and ADMIN session lifetime bounds', async () => {
    const session = await identity.login('system_admin', 'AdminPassword123!');
    expect(new Date(session.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
    await db.query("UPDATE sessions SET last_seen_at = clock_timestamp() - INTERVAL '12 hours' WHERE id = $1", [session.sessionId]);
    expect(await identity.authenticateToken(session.token)).toBeUndefined();
    await expect(identity.reauthenticate(session.token, 'AdminPassword123!')).rejects.toMatchObject({ statusCode: 401 });
    const second = await identity.login('system_admin', 'AdminPassword123!');
    await db.query("UPDATE sessions SET created_at = clock_timestamp() - INTERVAL '12 hours', expires_at = clock_timestamp() + INTERVAL '7 days' WHERE id = $1", [second.sessionId]);
    expect(await identity.authenticateToken(second.token)).toBeUndefined();
    const [student] = await identity.lanBulkProvision([{ username: 'absolute_student', displayName: 'Absolute', role: 'STUDENT' }], adminActor);
    const limited = await identity.login(student.username, student.temporaryPassword);
    expect((await identity.authenticateToken(limited.token))?.actor.teamIds).toEqual([]);
    await db.query("UPDATE sessions SET created_at = clock_timestamp() - INTERVAL '7 days', expires_at = clock_timestamp() + INTERVAL '7 days' WHERE id = $1", [limited.sessionId]);
    expect(await identity.authenticateToken(limited.token)).toBeUndefined();
  });

  it('limits failed account and shared-IP attempts without charging successful logins', async () => {
    await db.query('DELETE FROM identity_login_attempts');
    for (let index = 0; index < 10; index++) {
      await expect(identity.login('nonexistent_rate_account', 'incorrect password', `account-ip-${index}`)).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(identity.login('nonexistent_rate_account', 'incorrect password', 'fresh-ip')).rejects.toMatchObject({ statusCode: 429 });
    for (let index = 0; index < 30; index++) {
      await expect(identity.login(`nonexistent_ip_account_${index}`, 'incorrect password', 'shared-ip')).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(identity.login('new_ip_account', 'incorrect password', 'shared-ip')).rejects.toMatchObject({ statusCode: 429 });
    await db.query('DELETE FROM identity_login_attempts');
    for (let index = 0; index < 11; index++) await identity.login('system_admin', 'AdminPassword123!', 'successful-ip');
    const count = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM identity_login_attempts');
    expect(count.rows[0].count).toBe('0');
  }, 30_000);
  it('expires throttle attempts using the database clock at the exact 15-minute boundary', async () => {
    await db.query('DELETE FROM identity_login_attempts');
    const accountKey = hashToken('db-clock-boundary');
    await db.query("INSERT INTO identity_login_attempts(account_key,ip_key,attempted_at) VALUES ($1,$2,clock_timestamp()-interval '15 minutes')", [accountKey, hashToken('db-clock-boundary-ip')]);
    await expect(identity.login('db-clock-boundary', 'incorrect password', 'db-clock-boundary-ip')).rejects.toMatchObject({ statusCode: 401 });
    const count = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM identity_login_attempts WHERE account_key=$1', [accountKey]);
    expect(count.rows[0].count).toBe('1');
    await db.query('DELETE FROM identity_login_attempts');
  });
  it('serializes concurrent failures so the account limit cannot be exceeded', async () => {
    await db.query('DELETE FROM identity_login_attempts');
    const accountKey = hashToken('concurrent_rate_account');
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => identity.login('concurrent_rate_account', 'incorrect password', randomUUID())));
    expect(results.filter((result) => result.status === 'rejected' && (result.reason as IdentityError).statusCode === 401)).toHaveLength(10);
    expect(results.filter((result) => result.status === 'rejected' && (result.reason as IdentityError).statusCode === 429)).toHaveLength(6);
    const count = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM identity_login_attempts WHERE account_key=$1', [accountKey]);
    expect(count.rows[0].count).toBe('10');
    await db.query('DELETE FROM identity_login_attempts');
  });

  it('fails closed for missing/invalid capacity and serializes competing provisions', async () => {
    await db.query("DELETE FROM deployment_settings WHERE key = 'accountCapacity'");
    const entry = (username: string) => [{ username, displayName: username, role: 'STUDENT' as const }];
    await expect(identity.lanBulkProvision(entry('missing_capacity'), adminActor)).rejects.toMatchObject({ code: 'ACCOUNT_CAPACITY_REQUIRED' });
    await db.query("INSERT INTO deployment_settings(key, value) VALUES ('accountCapacity', '{\"limit\":\"1000\"}')");
    await expect(identity.lanBulkProvision(entry('bad_capacity'), adminActor)).rejects.toMatchObject({ code: 'ACCOUNT_CAPACITY_REQUIRED' });
    const count = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    await db.query("UPDATE deployment_settings SET value = $1 WHERE key = 'accountCapacity'", [JSON.stringify({ limit: Number(count.rows[0].count) + 1 })]);
    const results = await Promise.allSettled([
      identity.lanBulkProvision(entry('capacity_racer_a'), adminActor),
      identity.lanBulkProvision(entry('capacity_racer_b'), adminActor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await db.query("UPDATE deployment_settings SET value = '{\"limit\":1000}' WHERE key = 'accountCapacity'");
  });
});
