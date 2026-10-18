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

describe('S11: Appeal window enforcement & public announcements', () => {
  let db: PostgresDatabase;
  let app: FastifyInstance;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  /** Real password for the ADMIN fixture: the guarded writes need it for re-authentication. */
  const adminPassword = 'appeal-admin-password-123';

  let adminCookie = '';
  let courseId = '';
  let adminUserId = '';
  let studentUserId = '';
  let teamAId = '';
  let teamBId = '';

  let flowTournamentId = '';
  let disputeTournamentId = '';
  let windowTournamentId = '';
  let seededTournamentId = '';
  let disputeEncounterId = '';
  let disputeId = '';

  const tournamentIds = (): string[] => [
    flowTournamentId,
    disputeTournamentId,
    windowTournamentId,
    seededTournamentId,
  ];

  beforeAll(async () => {
    db = new PostgresDatabase();
    const identity = new IdentityService(db);
    const admissionService = new TournamentAdmissionService(db);

    app = Fastify();
    registerTournamentRoutes(
      app,
      db,
      new MapService(db),
      new TournamentLifecycleService(db),
      new TournamentSchedulerService(db, new JobBroker(db)),
      identity
    );
    registerAdmissionRoutes(app, admissionService, identity);
    // The destructive organizer writes are guarded by a password re-confirmation (migration 016),
    // so the re-authentication route must exist for this suite.
    registerIdentityRoutes(app, identity);
    await app.ready();

    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Appeal & Announcements Course') RETURNING id`,
      [`APPEAL_COURSE_${runId}`]
    );
    courseId = courseRes.rows[0].id;

    const adminRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Appeal Admin', $2, 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`appeal_admin_${runId}`, await hashPassword(adminPassword)]
    );
    adminUserId = adminRes.rows[0].id;
    const studentRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Appeal Student', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`appeal_student_${runId}`]
    );
    studentUserId = studentRes.rows[0].id;

    const teamA = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, `Appeal Team A ${runId}`, studentUserId]
    );
    teamAId = teamA.rows[0].id;
    const teamB = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, `Appeal Team B ${runId}`, adminUserId]
    );
    teamBId = teamB.rows[0].id;

    // A FULL session for the ADMIN, created directly so no login/bootstrap coupling is needed.
    const token = randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, 'FULL', clock_timestamp() + INTERVAL '1 day')`,
      [adminUserId, hashToken(token)]
    );
    adminCookie = `oantuti_session=${token}`;

    const insertTournament = async (name: string, state: string, windowMinutes?: number): Promise<string> => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state, provisional_at, final_appeal_window_minutes)
         VALUES ($1, $2, 'SINGLE_ELIMINATION', $3,
                 CASE WHEN $3 = 'PROVISIONAL' THEN clock_timestamp() ELSE NULL END,
                 COALESCE($4::int, 1440))
         RETURNING id`,
        [courseId, `${name} ${runId}`, state, windowMinutes ?? null]
      );
      return res.rows[0].id;
    };

    flowTournamentId = await insertTournament('Flow Cup', 'DRAFT');
    // Window of 0: the appeal-window gate is already elapsed, so only the dispute gate can block.
    disputeTournamentId = await insertTournament('Dispute Cup', 'PROVISIONAL', 0);
    // Default 24 h window: the appeal-window gate is active.
    windowTournamentId = await insertTournament('Window Cup', 'PROVISIONAL');
    seededTournamentId = await insertTournament('Seeded Cup', 'PUBLISHED');

    const encounterRes = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, 'MAIN', 1, 1, $2, $3, 'COMPLETED') RETURNING id`,
      [disputeTournamentId, teamAId, teamBId]
    );
    disputeEncounterId = encounterRes.rows[0].id;

    const disputeRes = await db.query<{ id: string }>(
      `INSERT INTO disputes (tournament_id, encounter_id, team_id, created_by_user_id, reason)
       VALUES ($1, $2, $3, $4, 'Fixture dispute that must block finalization')
       RETURNING id`,
      [disputeTournamentId, disputeEncounterId, teamAId, studentUserId]
    );
    disputeId = disputeRes.rows[0].id;

    // Seeded publication ledger for `seededTournamentId`: two allow-listed topics, one
    // non-allow-listed topic carrying the same tournamentId, and one allow-listed topic
    // belonging to a different tournament.
    await db.query(
      `INSERT INTO outbox_events (topic, payload, created_at) VALUES
         ('TOURNAMENT_PUBLISHED', $1, clock_timestamp() - INTERVAL '3 minutes'),
         ('GAME_RESULT_ACCEPTED', $2, clock_timestamp() - INTERVAL '2 minutes'),
         ('ROUND_SCHEDULED', $3, clock_timestamp() - INTERVAL '1 minute'),
         ('ROUND_SCHEDULED', $4, clock_timestamp() - INTERVAL '30 seconds')`,
      [
        JSON.stringify({ tournamentId: seededTournamentId }),
        JSON.stringify({ tournamentId: seededTournamentId, gameId: randomUUID() }),
        JSON.stringify({ tournamentId: seededTournamentId, stage: 'MAIN', roundOrdinal: 1, pairingsCount: 1 }),
        JSON.stringify({ tournamentId: windowTournamentId, stage: 'MAIN', roundOrdinal: 1, pairingsCount: 1 }),
      ]
    );
  });

  afterAll(async () => {
    const ids = [flowTournamentId, disputeTournamentId, windowTournamentId, seededTournamentId];
    const users = [adminUserId, studentUserId];
    const teams = [teamAId, teamBId];

    await db.query(`DELETE FROM disputes WHERE tournament_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [ids]);
    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [ids]);
    await db.query(`DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM encounters WHERE tournament_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM team_memberships WHERE user_id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [teams]);
    await db.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await db.query(`DELETE FROM courses WHERE id = ANY($1::uuid[])`, [[courseId]]);

    await app.close();
    await db.close();
  });

  /**
   * Confirms the ADMIN password for this session. Every guarded write below (`appeal-window`, `grace`,
   * `finalize`, and the inline `close-registration` call) answers 403 REAUTH_REQUIRED without it.
   */
  const reauth = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reauth',
      headers: { cookie: adminCookie },
      payload: { password: adminPassword },
    });
    expect(res.statusCode).toBe(200);
  };

  const setAppealWindow = async (tournamentId: string, minutes: unknown) => {
    await reauth();
    return app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/appeal-window`,
      headers: { cookie: adminCookie },
      payload: { minutes },
    });
  };

  const finalize = async (tournamentId: string) => {
    await reauth();
    return app.inject({
      method: 'POST',
      url: `/api/v2/organizer/tournaments/${tournamentId}/finalize`,
      headers: { cookie: adminCookie },
    });
  };

  const announcements = (tournamentId: string) =>
    app.inject({ method: 'GET', url: `/api/v2/tournaments/${tournamentId}/announcements` });

  describe('1. Finalization gates', () => {
    it('refuses an unauthenticated appeal-window write', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${windowTournamentId}/appeal-window`,
        payload: { minutes: 60 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('blocks finalization while a dispute is open, even with a 0-minute window', async () => {
      const res = await finalize(disputeTournamentId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/^OPEN_DISPUTES_BLOCK_FINALIZATION: 1 unresolved dispute/);
    });

    it('blocks finalization while the appeal window is still open', async () => {
      const res = await finalize(windowTournamentId);
      expect(res.statusCode).toBe(409);
      // 24 h default, stamped moments ago → the remaining time rounds up to the full window.
      expect(res.json().error).toBe('APPEAL_WINDOW_OPEN: 1440 minute(s) remaining');
    });

    it('rejects non-integer/out-of-range minutes and states outside the provisional phase', async () => {
      const fractional = await setAppealWindow(seededTournamentId, 0.5);
      expect(fractional.statusCode).toBe(400);
      expect(fractional.json().error).toMatch(/^INVALID_MINUTES:/);

      const tooLarge = await setAppealWindow(seededTournamentId, 10081);
      expect(tooLarge.statusCode).toBe(400);
      expect(tooLarge.json().error).toMatch(/^INVALID_MINUTES:/);

      const wrongState = await setAppealWindow(seededTournamentId, 1440);
      expect(wrongState.statusCode).toBe(409);
      expect(wrongState.json().error).toMatch(/Cannot set the appeal window in state 'PUBLISHED'/);
    });

    it('finalizes once {minutes: 0} is stored and no dispute is open', async () => {
      const set = await setAppealWindow(windowTournamentId, 0);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ tournamentId: windowTournamentId, finalAppealWindowMinutes: 0 });

      const res = await finalize(windowTournamentId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tournamentId: windowTournamentId, state: 'FINALIZED' });

      const row = await db.query<{ state: string; final_appeal_window_minutes: number }>(
        `SELECT state, final_appeal_window_minutes FROM tournaments WHERE id = $1`,
        [windowTournamentId]
      );
      expect(row.rows[0]).toEqual({ state: 'FINALIZED', final_appeal_window_minutes: 0 });

      const audited = await db.query<{ action: string; details: { minutes?: number } }>(
        `SELECT action, details FROM audit_events
         WHERE resource_type = 'tournament' AND resource_id = $1 AND action = 'APPEAL_WINDOW_SET'`,
        [windowTournamentId]
      );
      expect(audited.rows).toHaveLength(1);
      expect(audited.rows[0].details.minutes).toBe(0);

      const finalized = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM outbox_events
         WHERE topic = 'TOURNAMENT_FINALIZED' AND payload->>'tournamentId' = $1`,
        [windowTournamentId]
      );
      expect(finalized.rows[0].count).toBe('1');
    });
  });

  describe('2. Public announcements', () => {
    it('404s for an unknown tournament and for a DRAFT tournament', async () => {
      const missing = await announcements(randomUUID());
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toMatch(/^Tournament not found:/);

      const draft = await announcements(flowTournamentId);
      expect(draft.statusCode).toBe(404);
    });

    it('returns allow-listed topics newest first and hides everything else', async () => {
      const res = await announcements(seededTournamentId);
      expect(res.statusCode).toBe(200);

      const body = res.json() as { announcements: { id: string; topic: string; createdAt: string; payload: Record<string, unknown> }[] };
      expect(body.announcements.map((a) => a.topic)).toEqual(['ROUND_SCHEDULED', 'TOURNAMENT_PUBLISHED']);

      const [newest, oldest] = body.announcements;
      expect(newest.payload).toEqual({
        tournamentId: seededTournamentId,
        stage: 'MAIN',
        roundOrdinal: 1,
        pairingsCount: 1,
      });
      expect(oldest.payload).toEqual({ tournamentId: seededTournamentId });
      expect(new Date(newest.createdAt).getTime()).toBeGreaterThan(new Date(oldest.createdAt).getTime());
      expect(body.announcements.every((a) => a.id && typeof a.createdAt === 'string')).toBe(true);
    });

    it('records publish/open/close as announcements, in order', async () => {
      const published = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${flowTournamentId}/publish`,
        headers: { cookie: adminCookie },
      });
      expect(published.statusCode).toBe(200);

      const opened = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${flowTournamentId}/open-registration`,
        headers: { cookie: adminCookie },
        payload: { registrationClosesAt: new Date(Date.now() + 3_600_000).toISOString() },
      });
      expect(opened.statusCode).toBe(200);

      await reauth();
      const closed = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${flowTournamentId}/close-registration`,
        headers: { cookie: adminCookie },
      });
      expect(closed.statusCode).toBe(200);

      const res = await announcements(flowTournamentId);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { announcements: { topic: string; payload: Record<string, unknown> }[] };

      // TOURNAMENT_DRAINING is emitted by the same transaction but is not public.
      expect(body.announcements.map((a) => a.topic)).toEqual([
        'REGISTRATION_CLOSED',
        'REGISTRATION_OPENED',
        'TOURNAMENT_PUBLISHED',
      ]);

      const [closedEvent, openedEvent, publishedEvent] = body.announcements;
      expect(closedEvent.payload).toEqual({ tournamentId: flowTournamentId, reason: 'ADMIN_CLOSED' });
      expect(openedEvent.payload.tournamentId).toBe(flowTournamentId);
      expect(typeof openedEvent.payload.registrationClosesAt).toBe('string');
      expect(publishedEvent.payload.tournamentId).toBe(flowTournamentId);
      expect(typeof publishedEvent.payload.publishedAt).toBe('string');
    });
  });

  describe('3. Round grace window policy', () => {
    const setGrace = async (tournamentId: string, minutes: unknown) => {
      await reauth();
      return app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tournamentId}/grace`,
        headers: { cookie: adminCookie },
        payload: { minutes },
      });
    };

    it('pins the grace window in DRAFT/PUBLISHED and audits GRACE_PERIOD_SET', async () => {
      const draft = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
         VALUES ($1, $2, 'SINGLE_ELIMINATION', 'DRAFT', 10) RETURNING id`,
        [courseId, `Grace Cup ${runId}`]
      );
      const draftId = draft.rows[0].id;

      try {
        // PROVISIONAL stands in for "past registration opening": the window freezes there.
        const frozen = await setGrace(disputeTournamentId, 5);
        expect(frozen.statusCode).toBe(409);
        expect(frozen.json().error).toMatch(/Cannot set the grace period in state 'PROVISIONAL'/);

        const outOfRange = await setGrace(draftId, 1441);
        expect(outOfRange.statusCode).toBe(400);
        expect(outOfRange.json().error).toMatch(/^INVALID_MINUTES:/);

        const draftSet = await setGrace(draftId, 0);
        expect(draftSet.statusCode).toBe(200);
        expect(draftSet.json()).toEqual({ tournamentId: draftId, gracePeriodMinutes: 0 });

        const publishedSet = await setGrace(seededTournamentId, 30);
        expect(publishedSet.statusCode).toBe(200);
        expect(publishedSet.json()).toEqual({ tournamentId: seededTournamentId, gracePeriodMinutes: 30 });

        const rows = await db.query<{ id: string; grace_period_minutes: number }>(
          `SELECT id, grace_period_minutes FROM tournaments WHERE id = ANY($1::uuid[])
           ORDER BY grace_period_minutes`,
          [[draftId, seededTournamentId]]
        );
        expect(rows.rows).toEqual([
          { id: draftId, grace_period_minutes: 0 },
          { id: seededTournamentId, grace_period_minutes: 30 },
        ]);

        const audited = await db.query<{ resource_id: string; details: { minutes: number } }>(
          `SELECT resource_id, details FROM audit_events
           WHERE action = 'GRACE_PERIOD_SET' AND resource_id = ANY($1::text[])
           ORDER BY details->>'minutes'`,
          [[draftId, seededTournamentId]]
        );
        expect(audited.rows).toEqual([
          { resource_id: draftId, details: { minutes: 0 } },
          { resource_id: seededTournamentId, details: { minutes: 30 } },
        ]);
      } finally {
        await db.query(`DELETE FROM audit_events WHERE resource_type = 'tournament' AND resource_id = $1`, [draftId]);
        await db.query(`DELETE FROM tournaments WHERE id = $1`, [draftId]);
      }
    });

    it('refuses an unauthenticated or non-integer grace write', async () => {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${seededTournamentId}/grace`,
        payload: { minutes: 30 },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const missing = await setGrace(seededTournamentId, undefined);
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toMatch(/^INVALID_MINUTES:/);

      const fractional = await setGrace(seededTournamentId, 2.5);
      expect(fractional.statusCode).toBe(400);
      expect(fractional.json().error).toMatch(/^INVALID_MINUTES:/);
    });
  });
});
