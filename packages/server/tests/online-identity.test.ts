import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Database } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { registerIdentityRoutes } from '../src/identity/routes.js';
import { hashPassword, hashToken } from '../src/identity/crypto.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentEntryCodeService } from '../src/tournaments/entry-code-service.js';
import { registerAdmissionRoutes, registerEntryCodeRoutes } from '../src/tournaments/routes.js';
import { openMailMaterial, type MailEnvelope } from '../src/identity/mail-crypto.js';
import { mailAad, type IdentityMailOptions } from '../src/identity/mail-outbox.js';
import { MailConsumer, type MailMessage, type MailTransport } from '../src/identity/mail-consumer.js';

const RUN = Date.now().toString(36);
const RESET_PASSWORD = 'ResetPassword456!';
const PASSWORD = 'OnlineIdentityPassword456!';
const ORIGIN = 'https://arena.example';
const mail: IdentityMailOptions = { keyring:{currentKeyId:'test',keys:new Map([['test',Buffer.alloc(32,7)]])},publicBaseUrl:ORIGIN,from:'arena@example.test',replyTo:'support@example.test' };
class RecordingIdentityTransport implements MailTransport { readonly messages: MailMessage[]=[]; async send(message:MailMessage):Promise<void>{this.messages.push(message);} }

function cookieOf(res: { headers: Record<string, string | string[] | undefined> }): string {
  return String(res.headers['set-cookie']).split(';')[0];
}

describe('S04 ONLINE identity, recovery & shared tournament entry codes (PostgreSQL 16)', () => {
  let db: Database;
  let online: IdentityService;
  let lan: IdentityService;
  /** ONLINE profile: identity + admission + entry-code routes. */
  let app: FastifyInstance;
  /** LAN_OFFLINE profile: identity routes only. */
  let lanApp: FastifyInstance;

  const userIds: string[] = [];
  const tournamentIds: string[] = [];
  const teamIds: string[] = [];
  const courseCodes: string[] = [];
  const transport = new RecordingIdentityTransport();
  let mailConsumer: MailConsumer;
  let priorCapacity: unknown;
  let hadCapacity = false;
  async function tokenFor(topic: string, recipient: string): Promise<string> {
    const result = await db.query<{outbox_id:string;user_id:string;purpose:string;token_hash:string|null;envelope:MailEnvelope}>(`SELECT d.outbox_id,d.user_id,d.purpose,d.token_hash,d.envelope FROM identity_mail_deliveries d JOIN outbox_events o ON o.id=d.outbox_id WHERE o.topic=$1 AND d.user_id IN (SELECT id FROM users WHERE email=$2) ORDER BY d.created_at DESC LIMIT 1`, [topic,recipient]);
    const row=result.rows[0]; if(!row) throw new Error(`Missing delivery for ${topic}`);
    return openMailMaterial(mail.keyring,mailAad(row.outbox_id,topic,row.user_id,row.purpose,row.token_hash),row.envelope).rawToken!;
  }

  const courseCode = `OC${RUN}`;
  const alice = { username: `alice_${RUN}`, email: `alice.${RUN}@example.test` };
  const carol = { username: `carol_${RUN}`, email: `carol.${RUN}@example.test` };
  const dave = { username: `dave_${RUN}`, email: `dave.${RUN}@example.test` };

  let aliceId = '';
  let daveId = '';
  let adminCookie = '';
  let aliceCookie = '';
  let teamA = '';
  let teamB = '';
  let teamC = '';
  let teamD = '';
  let teamE = '';
  let t1 = '';
  let t2 = '';
  let t3 = '';


  async function register(username: string, email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      headers: { origin: ORIGIN },
      payload: { username, displayName: username, email, password: PASSWORD },
    });
  }

  async function login(target: FastifyInstance, username: string, password: string) {
    return target.inject({ method: 'POST', url: '/api/v2/auth/login', headers: target === app ? { origin: ORIGIN } : undefined, payload: { username, password } });
  }

  beforeAll(async () => {

    db = new Database();
    const existingCapacity = await db.query<{ value: unknown }>("SELECT value FROM deployment_settings WHERE key='accountCapacity'");
    hadCapacity = existingCapacity.rows.length > 0;
    priorCapacity = existingCapacity.rows[0]?.value;
    await db.query("INSERT INTO deployment_settings(key,value) VALUES('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ limit: Number.MAX_SAFE_INTEGER })]);
    mailConsumer = new MailConsumer(db, mail, transport);
    online = new IdentityService(db, 'ONLINE', { mail });
    lan = new IdentityService(db, 'LAN_OFFLINE');

    app = Fastify();
    registerIdentityRoutes(app, online, [ORIGIN]);
    registerAdmissionRoutes(app, new TournamentAdmissionService(db), online);
    registerEntryCodeRoutes(app, new TournamentEntryCodeService(db), online);
    await app.ready();

    lanApp = Fastify();
    registerIdentityRoutes(lanApp, lan);
    registerAdmissionRoutes(lanApp, new TournamentAdmissionService(db), lan);
    registerEntryCodeRoutes(lanApp, new TournamentEntryCodeService(db), lan);
    await lanApp.ready();

    courseCodes.push(courseCode);

    // Deterministic ADMIN: direct insert with a known hash (a singleton bootstrap
    // would depend on whatever the previous test file left behind).
    const adminUsername = `admin_${RUN}`;
    const adminInsert = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, email, email_verified_at, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Online Admin', $2, clock_timestamp(), $3, 'ADMIN', 'SELF_REGISTER', FALSE)
       RETURNING id`,
      [adminUsername, `admin.${RUN}@example.test`, await hashPassword(PASSWORD)]
    );
    userIds.push(adminInsert.rows[0].id);
    const adminLogin = await login(app, adminUsername, PASSWORD);
    expect(adminLogin.statusCode).toBe(200);
    adminCookie = cookieOf(adminLogin);

    // Verified student used as a team captain.
    const aliceRegistration = await register(alice.username, alice.email);
    expect(aliceRegistration.statusCode).toBe(201);
    aliceId = aliceRegistration.json().user.id;
    userIds.push(aliceId);
    const aliceVerification = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/verify-email',
      headers: { origin: ORIGIN },
      payload: { token: await tokenFor('EMAIL_VERIFICATION_REQUESTED', alice.email) },
    });
    expect(aliceVerification.statusCode).toBe(200);
    const aliceLogin = await login(app, alice.username, PASSWORD);
    expect(aliceLogin.statusCode).toBe(200);
    aliceCookie = cookieOf(aliceLogin);

    // Registered but deliberately unverified: the ONLINE verification gate fixture.
    const daveRegistration = await register(dave.username, dave.email);
    expect(daveRegistration.statusCode).toBe(201);
    daveId = daveRegistration.json().user.id;
    const carolRegistration = await register(carol.username, carol.email);
    expect(carolRegistration.statusCode).toBe(201);
    const carolId: string = carolRegistration.json().user.id;
    userIds.push(carolId);
    const carolVerification = await app.inject({ method: 'POST', url: '/api/v2/auth/verify-email', headers: { origin: ORIGIN }, payload: { token: await tokenFor('EMAIL_VERIFICATION_REQUESTED', carol.email) } });
    expect(carolVerification.statusCode).toBe(200);


    async function createTeam(name: string, captainUsername: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v2/organizer/teams',
        headers: { cookie: adminCookie, origin: ORIGIN },
        payload: { courseCode, name, captainUsername },
      });
      expect(res.statusCode).toBe(201);
      const id: string = res.json().team.id;
      teamIds.push(id);
      return id;
    }

    teamA = await createTeam(`Team A ${RUN}`, alice.username);
    teamB = await createTeam(`Team B ${RUN}`, dave.username);
    teamC = await createTeam(`Team C ${RUN}`, carol.username);
    teamD = await createTeam(`Team D ${RUN}`, dave.username);
    teamE = await createTeam(`Team E ${RUN}`, dave.username);

    async function createTournament(name: string, maxTeams: number, open: boolean): Promise<string> {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v2/organizer/tournaments',
        headers: { cookie: adminCookie, origin: ORIGIN },
        payload: { courseCode, name, format: 'ROUND_ROBIN', maxTeams },
      });
      expect(created.statusCode).toBe(201);
      const id: string = created.json().tournament.id;
      tournamentIds.push(id);
      if (open) {
        const published = await app.inject({
          method: 'POST',
          url: `/api/v2/organizer/tournaments/${id}/publish`,
          headers: { cookie: adminCookie, origin: ORIGIN },
          payload: {},
        });
        expect(published.statusCode).toBe(200);
        const opened = await app.inject({
          method: 'POST',
          url: `/api/v2/organizer/tournaments/${id}/open-registration`,
          headers: { cookie: adminCookie, origin: ORIGIN },
          payload: {},
        });
        expect(opened.statusCode).toBe(200);
      }
      return id;
    }

    t1 = await createTournament(`Entry Code Cup ${RUN}`, 2, true);
    t2 = await createTournament(`Single Use Cup ${RUN}`, 10, true);
    t3 = await createTournament(`Draft Cup ${RUN}`, 10, false);
  });

  afterAll(async () => {
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM tournament_admissions WHERE tournament_id = ANY($1::uuid[])', [tournamentIds]);
      await client.query('DELETE FROM tournament_entry_codes WHERE tournament_id = ANY($1::uuid[])', [tournamentIds]);
      await client.query('DELETE FROM tournament_entries WHERE tournament_id = ANY($1::uuid[])', [tournamentIds]);
      await client.query('DELETE FROM tournament_admissions WHERE tournament_id = ANY($1::uuid[])', [tournamentIds]);
      await client.query('DELETE FROM tournaments WHERE id = ANY($1::uuid[])', [tournamentIds]);
      await client.query('DELETE FROM team_memberships WHERE team_id = ANY($1::uuid[])', [teamIds]);
      await client.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [teamIds]);
      await client.query('DELETE FROM courses WHERE code = ANY($1::text[])', [courseCodes]);
      await client.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1::uuid[])', [userIds]);
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = ANY($1::uuid[])', [userIds]);
      await client.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
      await client.query("DELETE FROM outbox_events WHERE payload->>'userId' = ANY($1::text[])", [userIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    });
    if (hadCapacity) await db.query("INSERT INTO deployment_settings(key,value) VALUES('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(priorCapacity)]);
    else await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    await app.close();
    await lanApp.close();
    await db.close();
  });

  it('registers a student, stores only the token hash, then verifies the mailbox and logs in', async () => {
    const erin = { username: `erin_${RUN}`, email: `erin.${RUN}@example.test` };
    const registered = await register(erin.username, erin.email);
    expect(registered.statusCode).toBe(201);
    expect(registered.json().emailVerificationRequired).toBe(true);
    expect(registered.json().user).toMatchObject({ username: erin.username, role: 'STUDENT', email: erin.email });
    const erinId: string = registered.json().user.id;
    userIds.push(erinId);

    const persisted = await db.query<{ activation_method: string; password_change_required: boolean }>(
      'SELECT activation_method, password_change_required FROM users WHERE id = $1',
      [erinId]
    );
    expect(persisted.rows[0]).toMatchObject({ activation_method: 'SELF_REGISTER', password_change_required: false });

    // Weak password, duplicate username and duplicate email are structural failures.
    const weak = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      headers: { origin: ORIGIN },
      payload: { username: `weak_${RUN}`, displayName: 'Weak', email: `weak.${RUN}@example.test`, password: 'short-pass' },
    });
    expect([weak.statusCode, weak.json().code]).toEqual([400, 'WEAK_PASSWORD']);
    const duplicateUsername = await register(erin.username, `other.${RUN}@example.test`);
    expect([duplicateUsername.statusCode, duplicateUsername.json().code]).toEqual([409, 'USERNAME_TAKEN']);
    const duplicateEmail = await register(`other_${RUN}`, erin.email);
    expect([duplicateEmail.statusCode, duplicateEmail.json().code]).toEqual([409, 'EMAIL_TAKEN']);

    // Delivery material is recovered only from the encrypted, AAD-bound test mail record.
    const token = await tokenFor('EMAIL_VERIFICATION_REQUESTED', erin.email);
    expect(token).toHaveLength(64);
    const stored = await db.query('SELECT id FROM email_verification_tokens WHERE token_hash = $1', [hashToken(token)]);
    expect(stored.rows).toHaveLength(1);
    const plaintext = await db.query('SELECT id FROM email_verification_tokens WHERE token_hash = $1', [token]);
    expect(plaintext.rows).toHaveLength(0);

    const verified = await app.inject({ method: 'POST', url: '/api/v2/auth/verify-email', headers: { origin: ORIGIN }, payload: { token } });
    expect([verified.statusCode, verified.json().verified]).toEqual([200, true]);
    const replay = await app.inject({ method: 'POST', url: '/api/v2/auth/verify-email', headers: { origin: ORIGIN }, payload: { token } });
    expect([replay.statusCode, replay.json().code]).toEqual([400, 'EMAIL_VERIFICATION_CONSUMED']);
    const bogus = await app.inject({ method: 'POST', url: '/api/v2/auth/verify-email', headers: { origin: ORIGIN }, payload: { token: 'f'.repeat(64) } });
    expect([bogus.statusCode, bogus.json().code]).toEqual([400, 'EMAIL_VERIFICATION_INVALID']);

    const loggedIn = await login(app, erin.username, PASSWORD);
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().scope).toBe('FULL');
    const me = await app.inject({ method: 'GET', url: '/api/v2/auth/me', headers: { cookie: cookieOf(loggedIn) } });
    expect(me.json().authProfile).toBe('ONLINE');
  });

  it('keeps encrypted delivery material independent of public outbox metadata', async () => {
    const frank = { username: `frank_${RUN}`, email: `frank.${RUN}@example.test` };
    const registered = await register(frank.username, frank.email);
    expect(registered.statusCode).toBe(201);
    const frankId: string = registered.json().user.id;
    userIds.push(frankId);
    const event = await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE topic = 'EMAIL_VERIFICATION_REQUESTED' AND payload->>'userId' = $1", [frankId]);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].payload).toEqual({ userId: frankId, purpose: 'EMAIL_VERIFICATION', expiresAt: expect.any(String) });
    const token = await tokenFor('EMAIL_VERIFICATION_REQUESTED', frank.email);
    expect(token).toHaveLength(64);
  });

  it('cancels superseded pending email-change delivery and erases its encrypted material', async () => {
    const target = { username: `change_${RUN}`, email: `change.${RUN}@example.test` };
    const registered = await register(target.username, target.email);
    expect(registered.statusCode).toBe(201);
    const userId: string = registered.json().user.id;
    userIds.push(userId);
    const verified = await app.inject({ method: 'POST', url: '/api/v2/auth/verify-email', headers: { origin: ORIGIN }, payload: { token: await tokenFor('EMAIL_VERIFICATION_REQUESTED', target.email) } });
    expect(verified.statusCode).toBe(200);
    const session = await online.login(target.username, PASSWORD);
    await online.reauthenticate(session.token, PASSWORD);
    const firstAddress = `first.${RUN}@example.test`;
    const secondAddress = `second.${RUN}@example.test`;
    await online.requestEmailChange(session.token, firstAddress);
    const first = await db.query<{ id: string; token_hash: string }>(`SELECT t.id,t.token_hash FROM email_verification_tokens t WHERE t.user_id=$1 AND t.purpose='EMAIL_CHANGE' AND t.target_email=$2`, [userId, firstAddress]);
    expect(first.rows).toHaveLength(1);
    await online.requestEmailChange(session.token, secondAddress);
    const superseded = await db.query<{ state: string; envelope: unknown; consumed_at: Date | null }>(`SELECT d.state,d.envelope,t.consumed_at FROM email_verification_tokens t JOIN identity_mail_deliveries d ON d.token_hash=t.token_hash WHERE t.id=$1`, [first.rows[0].id]);
    expect(superseded.rows[0]).toMatchObject({ state: 'CANCELLED', envelope: null, consumed_at: expect.any(Date) });
    const current = await db.query<{ state: string; envelope: unknown; consumed_at: Date | null }>(`SELECT d.state,d.envelope,t.consumed_at FROM email_verification_tokens t JOIN identity_mail_deliveries d ON d.token_hash=t.token_hash WHERE t.user_id=$1 AND t.purpose='EMAIL_CHANGE' AND t.target_email=$2`, [userId, secondAddress]);
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]).toMatchObject({ state: 'PENDING', envelope: expect.any(Object), consumed_at: null });
  });

  it('hides every ONLINE-only route and the verification gate under LAN_OFFLINE', async () => {
    const lanRegistration = await lanApp.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username: `lanonly_${RUN}`, displayName: 'LAN Only', email: `lanonly.${RUN}@example.test`, password: PASSWORD },
    });
    expect([lanRegistration.statusCode, lanRegistration.json().code]).toEqual([404, 'PROFILE_DISABLED']);

    const onlineOnlyBodies: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['/api/v2/auth/verify-email', { token: 'a'.repeat(64) }],
      ['/api/v2/auth/request-password-reset', { email: alice.email }],
      ['/api/v2/auth/reset-password', { token: 'a'.repeat(64), newPassword: RESET_PASSWORD }],
    ];
    for (const [url, payload] of onlineOnlyBodies) {
      const res = await lanApp.inject({ method: 'POST', url, payload });
      expect([url, res.statusCode, res.json().code]).toEqual([url, 404, 'PROFILE_DISABLED']);
    }
    const lanEntryCode = await lanApp.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${t1}/entry-code`,
      headers: { cookie: adminCookie },
    });
    expect([lanEntryCode.statusCode, lanEntryCode.json().code]).toEqual([404, 'PROFILE_DISABLED']);
    const lanJoin = await lanApp.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: adminCookie },
    });
    expect([lanJoin.statusCode, lanJoin.json().code]).toEqual([404, 'PROFILE_DISABLED']);

    // Verification is enforced only in ONLINE; the same unverified account logs in on LAN.
    const onlineRefusal = await login(app, dave.username, PASSWORD);
    expect([onlineRefusal.statusCode, onlineRefusal.json().code]).toEqual([403, 'EMAIL_VERIFICATION_REQUIRED']);

    const lanLogin = await login(lanApp, dave.username, PASSWORD);
    expect(lanLogin.statusCode).toBe(200);
    const lanMe = await lanApp.inject({ method: 'GET', url: '/api/v2/auth/me', headers: { cookie: cookieOf(lanLogin) } });
    expect(lanMe.json().authProfile).toBe('LAN_OFFLINE');

    // The refused ONLINE attempt created no session; only the LAN one exists.
    const sessions = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1', [
      daveId,
    ]);
    expect(sessions.rows[0].count).toBe('1');
  });

  it('refuses LAN-issued account provisioning in the ONLINE profile', async () => {
    // Issued credentials skip the mailbox gate by design, so an ONLINE deployment must never mint
    // one — the LAN sibling of this route already refuses, and the panel hides it.
    const admin = await db.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1");
    const actor = { userId: admin.rows[0].id, role: 'ADMIN' as const, scope: 'FULL' as const, teamIds: [] };
    await expect(online.lanBulkProvision([{ username: 'online_minted', displayName: 'Minted', role: 'STUDENT' }], actor))
      .rejects.toMatchObject({ code: 'PROFILE_DISABLED', statusCode: 404 });
  });

  it('resets the password from a recovery token and revokes every existing session', async () => {
    const first = await login(app, alice.username, PASSWORD);
    const second = await login(app, alice.username, PASSWORD);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/request-password-reset',
      headers: { origin: ORIGIN },
      payload: { email: alice.email },
    });
    expect([accepted.statusCode, accepted.json().accepted]).toEqual([202, true]);
    // Unknown addresses answer identically: no account enumeration.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/request-password-reset',
      headers: { origin: ORIGIN },
      payload: { email: `nobody.${RUN}@example.test` },
    });
    expect(unknown.statusCode).toBe(202);

    const resetToken = await tokenFor('PASSWORD_RESET_REQUESTED', alice.email);
    const reset = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      headers: { origin: ORIGIN },
      payload: { token: resetToken, newPassword: RESET_PASSWORD },
    });
    expect([reset.statusCode, reset.json().reset]).toEqual([200, true]);

    for (const session of [first, second]) {
      const me = await app.inject({ method: 'GET', url: '/api/v2/auth/me', headers: { cookie: cookieOf(session) } });
      expect(me.statusCode).toBe(401);
    }
    const oldPassword = await login(app, alice.username, PASSWORD);
    expect(oldPassword.statusCode).toBe(401);

    const reused = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      headers: { origin: ORIGIN },
      payload: { token: resetToken, newPassword: 'AnotherPassword789!' },
    });
    expect([reused.statusCode, reused.json().code]).toEqual([400, 'PASSWORD_RESET_CONSUMED']);
    const garbage = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      headers: { origin: ORIGIN },
      payload: { token: 'a'.repeat(64), newPassword: 'AnotherPassword789!' },
    });
    expect([garbage.statusCode, garbage.json().code]).toEqual([400, 'PASSWORD_RESET_INVALID']);
    const weak = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      headers: { origin: ORIGIN },
      payload: { token: 'a'.repeat(64), newPassword: 'short' },
    });
    expect([weak.statusCode, weak.json().code]).toEqual([400, 'WEAK_PASSWORD']);

    // Fresh captain session for the entry-code cases below.
    const relogin = await login(app, alice.username, RESET_PASSWORD);
    expect(relogin.statusCode).toBe(200);
    aliceCookie = cookieOf(relogin);
  });

  it('admits a captain with a shared code and refuses bad, expired, exhausted or non-captain attempts', async () => {
    const codeHashOf = (code: string) => hashToken(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));

    // Only ADMIN may mint or list codes.
    const nonAdminMint = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${t1}/entry-code`,
      headers: { cookie: aliceCookie, origin: ORIGIN },
      payload: { maxUses: 5 },
    });
    expect(nonAdminMint.statusCode).toBe(403);
    const nonAdminList = await app.inject({
      method: 'GET',
      url: `/api/v2/organizer/tournaments/${t1}/entry-codes`,
      headers: { cookie: aliceCookie },
    });
    expect(nonAdminList.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${t1}/entry-code`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { maxUses: 5 },
    });
    expect(created.statusCode).toBe(201);
    let code: string = created.json().code;
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect([created.json().maxUses, created.json().expiresAt]).toEqual([5, null]);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v2/organizer/tournaments/${t1}/entry-codes`,
      headers: { cookie: adminCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().codes).toHaveLength(1);
    expect(listed.json().codes[0]).toMatchObject({ maxUses: 5, uses: 0, expiresAt: null });
    expect(listed.json().codes[0].code).toBeUndefined();

    // A DRAFT tournament refuses joins regardless of the code.
    const draft = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t3}/join`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { code, teamId: teamA },
    });
    expect([draft.statusCode, draft.json().code]).toEqual([409, 'TOURNAMENT_NOT_OPEN']);

    const badCode = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: aliceCookie, origin: ORIGIN },
      payload: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', teamId: teamA },
    });
    expect([badCode.statusCode, badCode.json().code]).toEqual([403, 'ENTRY_CODE_INVALID']);

    // alice captains team A only.
    const notCaptain = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: aliceCookie, origin: ORIGIN },
      payload: { code, teamId: teamB },
    });
    expect([notCaptain.statusCode, notCaptain.json().code]).toEqual([403, 'NOT_TEAM_CAPTAIN']);

    const expiredCreated = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${t1}/entry-codes/${created.json().id}/rotate`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { maxUses: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(expiredCreated.statusCode).toBe(201);
    const expired = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: aliceCookie, origin: ORIGIN },
      payload: { code: expiredCreated.json().code, teamId: teamA },
    });
    expect([expired.statusCode, expired.json().code]).toEqual([403, 'ENTRY_CODE_EXPIRED']);
    const renewed = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${t1}/entry-codes/${created.json().id}/rotate`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { maxUses: 5 },
    });
    expect(renewed.statusCode).toBe(201);
    code = renewed.json().code;

    // The captain redeems the shared code; one use is burned in the same transaction.
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: aliceCookie, origin: ORIGIN },
      payload: { code, teamId: teamA },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().entry).toMatchObject({ teamId: teamA, status: 'ELIGIBLE' });
    const admission = await db.query<{ admission_type: string }>(
      'SELECT admission_type FROM tournament_admissions WHERE tournament_id = $1 AND team_id = $2',
      [t1, teamA]
    );
    expect(admission.rows[0].admission_type).toBe('INVITE_CODE');
    const usesRow = await db.query<{ uses: number }>(
      'SELECT uses FROM tournament_entry_codes WHERE tournament_id = $1 AND code_hash = $2',
      [t1, codeHashOf(code)]
    );
    expect(usesRow.rows[0].uses).toBe(1);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: aliceCookie, origin: ORIGIN },
      payload: { code, teamId: teamA },
    });
    expect([duplicate.statusCode, duplicate.json().code]).toEqual([409, 'ALREADY_ENROLLED']);

    // An ADMIN may admit a team it does not captain — filling t1's 2-team capacity.
    const adminJoin = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { code, teamId: teamB },
    });
    expect(adminJoin.statusCode).toBe(201);
    const capacity = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t1}/join`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { code, teamId: teamC },
    });
    expect([capacity.statusCode, capacity.json().code]).toEqual([409, 'CAPACITY_EXCEEDED']);

    // maxUses: 1 is single-use, and the burn happens inside the join transaction.
    const single = await app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${t2}/entry-code`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { maxUses: 1 },
    });
    expect(single.statusCode).toBe(201);
    const singleCode: string = single.json().code;
    const firstUse = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t2}/join`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { code: singleCode, teamId: teamD },
    });
    expect(firstUse.statusCode).toBe(201);
    const secondUse = await app.inject({
      method: 'POST',
      url: `/api/v2/tournaments/${t2}/join`,
      headers: { cookie: adminCookie, origin: ORIGIN },
      payload: { code: singleCode, teamId: teamE },
    });
    expect([secondUse.statusCode, secondUse.json().code]).toEqual([403, 'ENTRY_CODE_EXHAUSTED']);
    const singleRow = await db.query<{ uses: number }>(
      'SELECT uses FROM tournament_entry_codes WHERE tournament_id = $1 AND code_hash = $2',
      [t2, codeHashOf(singleCode)]
    );
    expect(singleRow.rows[0].uses).toBe(1);
    const deniedEntry = await db.query(
      'SELECT id FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2',
      [t2, teamE]
    );
    expect(deniedEntry.rows).toHaveLength(0);
  });
});
