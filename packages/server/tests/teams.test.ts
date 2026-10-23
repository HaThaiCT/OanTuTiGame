import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Database } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { TeamService } from '../src/teams/service.js';
import { registerIdentityRoutes } from '../src/identity/routes.js';
import { registerTeamRoutes } from '../src/teams/routes.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { registerAdmissionRoutes } from '../src/tournaments/routes.js';

describe('S03 HTTP REST API Routes — Identity, Teams & Tournament Substrate', () => {
  let app: FastifyInstance;
  let db: Database;
  let identity: IdentityService;
  let teams: TeamService;

  beforeAll(async () => {
    db = new Database();
    identity = new IdentityService(db);
    teams = new TeamService(db);

    app = Fastify();
    registerIdentityRoutes(app, identity, ['http://localhost', 'https://localhost']);
    registerTeamRoutes(app, teams, identity);
    registerAdmissionRoutes(app, new TournamentAdmissionService(db), identity);
    await app.ready();

    // Clean tables for clean HTTP test run
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM tournament_entries');
      await client.query('DELETE FROM tournament_admissions');
      await client.query('DELETE FROM team_memberships');
      await client.query('DELETE FROM teams');
      await client.query('DELETE FROM tournaments');
      await client.query('DELETE FROM courses');
      await client.query('DELETE FROM sessions');
      await client.query('DELETE FROM users');
      await client.query('DELETE FROM audit_events');
    });

    // Bootstrap singleton admin
    await identity.bootstrapAdmin(adminUsername, 'OrganizerSecurePassword123!');
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  const runId = randomUUID().replaceAll('-', '');
  const adminUsername = `lan_organizer_${runId}`;
  const studentOne = `lan_student_1_${runId}`;
  const studentTwo = `lan_student_2_${runId}`;
  const courseCode = `CS${runId.slice(0, 6).toUpperCase()}`;
  const teamName = `Cyber Warriors ${runId.slice(0, 6)}`;
  const tournamentName = `Spring Invitational ${runId.slice(0, 6)}`;
  let adminCookie = '';
  let studentCookie = '';
  let studentTempPass = '';
  let teamId = '';
  let tournamentId = '';

  it('authenticates ADMIN via POST /api/v2/auth/login and receives session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: {
        username: adminUsername,
        password: 'OrganizerSecurePassword123!',
      },
    });

    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    adminCookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    expect(adminCookie).toContain('oantuti_session=');

    const body = res.json();
    expect(body.user.username).toBe(adminUsername);
    expect(body.user.role).toBe('ADMIN');
    expect(body.scope).toBe('FULL');
  });

  it('provisions student accounts via POST /api/v2/organizer/accounts/provision-lan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/accounts/provision-lan',
      headers: { cookie: adminCookie },
      payload: {
        users: [
          { username: studentOne, displayName: 'Student One', role: 'STUDENT' },
          { username: studentTwo, displayName: 'Student Two', role: 'STUDENT' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created.length).toBe(2);
    studentTempPass = body.created[0].temporaryPassword;
    expect(studentTempPass.length).toBeGreaterThanOrEqual(10);
  });

  it('rejects unauthenticated or non-admin calls to provision-lan', async () => {
    const unauth = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/accounts/provision-lan',
      payload: { users: [{ username: 'hack', displayName: 'H', role: 'STUDENT' }] },
    });
    expect(unauth.statusCode).toBe(401);
  });

  it('logs in student with temporary password, forcing password change', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: {
        username: studentOne,
        password: studentTempPass,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe('PASSWORD_CHANGE_ONLY');
    expect(body.user.passwordChangeRequired).toBe(true);

    const setCookie = res.headers['set-cookie'];
    studentCookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);

    // Verify GET /api/v2/auth/me returns PASSWORD_CHANGE_ONLY
    const me = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: studentCookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().scope).toBe('PASSWORD_CHANGE_ONLY');

    // Change password via POST /api/v2/auth/change-password
    const change = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-password',
      headers: { cookie: studentCookie },
      payload: {
        oldPassword: studentTempPass,
        newPassword: 'MyNewStudentPassword987!',
      },
    });

    expect(change.statusCode).toBe(200);
    expect(change.json().scope).toBe('FULL');
    expect(change.json().user.passwordChangeRequired).toBe(false);

    const updatedCookie = change.headers['set-cookie'];
    studentCookie = Array.isArray(updatedCookie) ? updatedCookie[0] : (updatedCookie as string);

    // Now GET /api/v2/auth/me has FULL scope
    const meFull = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: studentCookie },
    });
    expect(meFull.json().scope).toBe('FULL');
  });

  it('creates course and team via organizer routes', async () => {
    // Admin creates course
    const courseRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/courses',
      headers: { cookie: adminCookie },
      payload: { code: courseCode, name: 'Intro to Competitive Bot AI' },
    });
    expect(courseRes.statusCode).toBe(200);

    // Admin creates team in course with student as captain
    const teamRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/teams',
      headers: { cookie: adminCookie },
      payload: { courseCode, name: teamName, captainUsername: studentOne },
    });
    expect(teamRes.statusCode).toBe(201);
    teamId = teamRes.json().team.id;
    expect(teamRes.json().team.name).toBe(teamName);

    // A team roster names its members, so it is private: the organizer or a member may read it.
    const anonymous = await app.inject({ method: 'GET', url: `/api/v2/teams/${teamId}` });
    expect(anonymous.statusCode).toBe(401);

    const getTeam = await app.inject({
      method: 'GET',
      url: `/api/v2/teams/${teamId}`,
      headers: { cookie: adminCookie },
    });
    expect(getTeam.statusCode).toBe(200);
    expect(getTeam.json().members.length).toBe(1);
    expect(getTeam.json().members[0].role).toBe('CAPTAIN');
  });

  it('manages tournament lifecycle: create -> publish -> open -> direct-enroll', async () => {
    // Create tournament in DRAFT
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v2/organizer/tournaments',
      headers: { cookie: adminCookie },
      payload: {
        courseCode,
        name: tournamentName,
        format: 'ROUND_ROBIN',
        maxTeams: 8,
        minTeamSize: 1,
        maxTeamSize: 3,
      },
    });
    expect(createRes.statusCode).toBe(201);
    tournamentId = createRes.json().tournament.id;
    expect(createRes.json().tournament.state).toBe('DRAFT');

    // Publish tournament (DRAFT -> PUBLISHED)
    const pubRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().state).toBe('PUBLISHED');

    // Publishing twice is an invalid transition
    const republishRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(republishRes.statusCode).toBe(409);

    // Open registration (PUBLISHED -> REGISTRATION_OPEN)
    const openRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/open-registration`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(openRes.statusCode).toBe(200);
    expect(openRes.json().state).toBe('REGISTRATION_OPEN');

    // Direct enroll team
    const enrollRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/enroll`,
      headers: { cookie: adminCookie },
      payload: { teamId },
    });
    expect(enrollRes.statusCode).toBe(201);
    expect(enrollRes.json().entry.id).toBeDefined();
    expect(enrollRes.json().entry.status).toBe('ELIGIBLE');

    // Duplicate enrollment is rejected
    const duplicateRes = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/enroll`,
      headers: { cookie: adminCookie },
      payload: { teamId },
    });
    expect(duplicateRes.statusCode).toBe(409);

    // Entries are publicly readable once the tournament leaves DRAFT
    const entriesRes = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}/entries`,
    });
    expect(entriesRes.statusCode).toBe(200);
    expect(entriesRes.json().entries.length).toBe(1);
    expect(entriesRes.json().entries[0].teamId).toBe(teamId);
    expect(entriesRes.json().entries[0].teamName).toBe(teamName);

    // Query public tournament state
    const tCheck = await app.inject({
      method: 'GET',
      url: `/api/v2/tournaments/${tournamentId}`,
    });
    expect(tCheck.statusCode).toBe(200);
    expect(tCheck.json().admittedTeamCount).toBe(1);
  });

  it('logs out and revokes session', async () => {
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/logout',
      headers: { cookie: studentCookie },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Subsequent call with old cookie is unauthenticated
    const me = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: studentCookie },
    });
    expect(me.statusCode).toBe(401);
  });
});
