import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgresDatabase } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { hashPassword, hashToken } from '../src/identity/crypto.js';
import { registerIdentityRoutes } from '../src/identity/routes.js';
import { JobBroker } from '../src/jobs/broker.js';
import { MapService } from '../src/tournaments/map-service.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { registerTournamentRoutes, registerAdmissionRoutes } from '../src/tournaments/routes.js';
import { registerAdjudicationRoutes } from '../src/adjudication/routes.js';
import { DisputeService } from '../src/adjudication/dispute-service.js';
import { CorrectionService } from '../src/adjudication/correction-service.js';

/**
 * S17: migration 016 makes the destructive organizer actions require a recent password confirmation
 * instead of a bare session cookie. These tests pin the whole contract: which routes are guarded, the
 * 10-minute window (stamped and read by the database clock), the fact that confirmation is per session
 * rather than per account, and that a refused confirmation never unlocks anything.
 */
describe('S17: recent re-authentication for destructive organizer actions', () => {
  let db: PostgresDatabase;
  let app: FastifyInstance;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const adminUsername = `reauth_admin_${runId}`;
  const adminPassword = 'reauth-password-123';

  let adminUserId = '';
  let studentUserId = '';
  let courseId = '';
  /** DRAFT, so the grace-period write is accepted; also the target of the refused-route sweep. */
  let graceTournamentId = '';
  /** PROVISIONAL with a 0-minute appeal window: finalization has no other gate left. */
  let finalizableTournamentId = '';

  let adminToken = '';
  let adminCookie = '';
  /** A second, never-confirmed session of the same ADMIN: confirmation must not leak between them. */
  let peerAdminCookie = '';
  let studentCookie = '';

  const insertSession = async (userId: string, scope: 'FULL' | 'PASSWORD_CHANGE_ONLY'): Promise<string> => {
    const token = randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, $3, clock_timestamp() + INTERVAL '1 day')`,
      [userId, hashToken(token), scope]
    );
    return token;
  };

  const post = (url: string, cookie: string | undefined, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: cookie ? { cookie } : undefined, payload });

  const reauth = (cookie: string, password: string) => post('/api/v2/auth/reauth', cookie, { password });

  beforeAll(async () => {
    db = new PostgresDatabase();
    const identity = new IdentityService(db);

    app = Fastify();
    registerIdentityRoutes(app, identity);
    registerTournamentRoutes(
      app,
      db,
      new MapService(db),
      new TournamentLifecycleService(db),
      new TournamentSchedulerService(db, new JobBroker(db)),
      identity
    );
    registerAdmissionRoutes(app, new TournamentAdmissionService(db), identity);
    registerAdjudicationRoutes(app, new DisputeService(db), new CorrectionService(db), identity);
    await app.ready();

    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Re-auth Course') RETURNING id`,
      [`REAUTH_COURSE_${runId}`]
    );
    courseId = courseRes.rows[0].id;

    const adminRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Re-auth Admin', $2, 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [adminUsername, await hashPassword(adminPassword)]
    );
    adminUserId = adminRes.rows[0].id;
    const studentRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Re-auth Student', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`reauth_student_${runId}`]
    );
    studentUserId = studentRes.rows[0].id;

    adminToken = await insertSession(adminUserId, 'FULL');
    adminCookie = `oantuti_session=${adminToken}`;
    peerAdminCookie = `oantuti_session=${await insertSession(adminUserId, 'FULL')}`;
    studentCookie = `oantuti_session=${await insertSession(studentUserId, 'FULL')}`;

    const draft = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
       VALUES ($1, $2, 'ROUND_ROBIN', 'DRAFT', 10) RETURNING id`,
      [courseId, `Reauth Grace Cup ${runId}`]
    );
    graceTournamentId = draft.rows[0].id;

    const provisional = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, provisional_at, final_appeal_window_minutes)
       VALUES ($1, $2, 'ROUND_ROBIN', 'PROVISIONAL', clock_timestamp(), 0) RETURNING id`,
      [courseId, `Reauth Final Cup ${runId}`]
    );
    finalizableTournamentId = provisional.rows[0].id;
  });

  afterAll(async () => {
    const tournaments = [graceTournamentId, finalizableTournamentId];
    const users = [adminUserId, studentUserId];

    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [tournaments]);
    await db.query(`DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournaments]);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [tournaments]);
    await db.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);

    await app.close();
    await db.close();
  });

  it('refuses every guarded organizer route with 403 REAUTH_REQUIRED before any service runs', async () => {
    const guarded: { url: string; payload?: Record<string, unknown> }[] = [
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/start`, payload: { mapSlug: 'any-map' } },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/pause` },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/resume` },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/close-registration` },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/finalize` },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/reopen` },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/appeal-window`, payload: { minutes: 60 } },
      { url: `/api/v2/organizer/tournaments/${graceTournamentId}/grace`, payload: { minutes: 5 } },
      {
        url: `/api/v2/organizer/games/${randomUUID()}/apply-correction`,
        payload: { command: { action: 'VOID', reason: 'refused before the service', expectedRevision: 1 }, previewDigest: 'digest' },
      },
    ];

    for (const route of guarded) {
      const res = await post(route.url, adminCookie, route.payload ?? {});
      expect(res.statusCode, route.url).toBe(403);
      expect(res.json().code, route.url).toBe('REAUTH_REQUIRED');
    }
  });

  it('leaves the correction preview unguarded', async () => {
    const res = await post(`/api/v2/organizer/games/${randomUUID()}/preview-correction`, adminCookie, {
      action: 'VOID',
      reason: 'preview changes nothing',
      expectedRevision: 1,
    });

    // The service's own answer for an unknown game — not the re-authentication gate.
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/^Game not found: /);
    expect(res.json().code).toBeUndefined();
  });

  it('rejects a wrong password with 401 INVALID_CREDENTIALS and does not unlock the session', async () => {
    const wrong = await reauth(adminCookie, `${adminPassword}-wrong`);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('INVALID_CREDENTIALS');

    const stillGuarded = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, adminCookie, {
      minutes: 5,
    });
    expect(stillGuarded.statusCode).toBe(403);
    expect(stillGuarded.json().code).toBe('REAUTH_REQUIRED');
  });

  it('accepts the password, audits ADMIN_REAUTH, and lets the guarded actions through', async () => {
    const before = Date.now();
    const confirmed = await reauth(adminCookie, adminPassword);
    expect(confirmed.statusCode).toBe(200);

    // The 10-minute window, measured against the request's own start as a coarse lower bound.
    const until = new Date(confirmed.json().reauthenticatedUntil).getTime();
    expect(until).toBeGreaterThan(before + 9 * 60 * 1000);
    expect(until).toBeLessThanOrEqual(before + 10 * 60 * 1000 + 5_000);

    const stamped = await db.query<{ reauthenticated_at: Date | null }>(
      `SELECT reauthenticated_at FROM sessions WHERE token_hash = $1`,
      [hashToken(adminToken)]
    );
    expect(stamped.rows[0].reauthenticated_at).not.toBeNull();

    const audited = await db.query<{ created_at: Date; details: { reauthenticatedUntil?: string } }>(
      `SELECT created_at, details FROM audit_events
       WHERE action = 'ADMIN_REAUTH' AND actor_user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [adminUserId]
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0].created_at).toBeInstanceOf(Date);
    expect(typeof audited.rows[0].details.reauthenticatedUntil).toBe('string');

    const grace = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, adminCookie, {
      minutes: 5,
    });
    expect(grace.statusCode).toBe(200);
    expect(grace.json()).toEqual({ tournamentId: graceTournamentId, gracePeriodMinutes: 5 });

    const finalized = await post(`/api/v2/organizer/tournaments/${finalizableTournamentId}/finalize`, adminCookie);
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toEqual({ tournamentId: finalizableTournamentId, state: 'FINALIZED' });
  });

  it('stops accepting a confirmation older than 10 minutes', async () => {
    await db.query(
      `UPDATE sessions SET reauthenticated_at = clock_timestamp() - INTERVAL '11 minutes' WHERE token_hash = $1`,
      [hashToken(adminToken)]
    );

    const stale = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, adminCookie, {
      minutes: 15,
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('REAUTH_REQUIRED');

    // Confirming again restores access: the window is a timestamp, not a one-shot flag.
    const confirmed = await reauth(adminCookie, adminPassword);
    expect(confirmed.statusCode).toBe(200);

    const fresh = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, adminCookie, {
      minutes: 15,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ tournamentId: graceTournamentId, gracePeriodMinutes: 15 });
  });

  it('confirms per session, not per account', async () => {
    const peer = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, peerAdminCookie, {
      minutes: 20,
    });
    expect(peer.statusCode).toBe(403);
    expect(peer.json().code).toBe('REAUTH_REQUIRED');

    // The confirmed session is untouched by the peer's refusal.
    const mine = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, adminCookie, {
      minutes: 20,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ tournamentId: graceTournamentId, gracePeriodMinutes: 20 });
  });

  it('refuses a password-change-only session with 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const limitedCookie = `oantuti_session=${await insertSession(adminUserId, 'PASSWORD_CHANGE_ONLY')}`;

    const res = await reauth(limitedCookie, adminPassword);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('requires a session and a password', async () => {
    const anonymous = await post('/api/v2/auth/reauth', undefined, { password: adminPassword });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('UNAUTHENTICATED');

    const missing = await post('/api/v2/auth/reauth', adminCookie, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('INVALID_PAYLOAD');
  });

  it('keeps the ADMIN check ahead of the re-authentication gate', async () => {
    const res = await post(`/api/v2/organizer/tournaments/${graceTournamentId}/grace`, studentCookie, {
      minutes: 5,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
    expect(res.json().code).toBeUndefined();
  });
});
