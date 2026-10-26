import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CommandContext, SessionScope } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { hashToken } from '../src/identity/crypto.js';
import { registerAdjudicationRoutes } from '../src/adjudication/routes.js';
import { DisputeService, DisputeError } from '../src/adjudication/dispute-service.js';
import { CorrectionService } from '../src/adjudication/correction-service.js';
import { runIdempotent } from '../src/commands/idempotency.js';

// Static-review 2026-10-27 regression belt:
//  - S1: adjudication authorization requires a FULL administrator session at every route and service
//    entry point; a PASSWORD_CHANGE_ONLY session is an ordinary claimant, never an operator.
//  - L5: dispute filing shares one transaction with finalize's tournament lock, re-checks state
//    in-transaction, and treats a refiling on a live dispute as an idempotent re-create.
//  - R2: non-UUID identifiers answer with structured 400 codes instead of raw PostgreSQL 22P02.
//  - L3: a failed idempotent run releases its PENDING claim so the retry path is not bricked.

const BAD_ID = 'not-a-uuid';
const runId = randomUUID();

describe('static-review repair belt: adjudication + idempotency', () => {
  let db: PostgresDatabase;
  let app: FastifyInstance;
  let disputeService: DisputeService;

  let courseId = '';
  let adminUserId = '';
  let studentUserId = '';
  let teamAId = '';
  let teamBId = '';
  let tournamentId = '';
  let encounterId = '';

  const cookies: Record<string, string> = {};
  const userIds: string[] = [];

  // The DB enforces one ADMIN per database (users_singleton_admin), so the scope variants are two
  // sessions of the same fixture administrator: FULL and PASSWORD_CHANGE_ONLY.
  const insertSession = async (userId: string, scope: SessionScope): Promise<string> => {
    const token = randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, $3, clock_timestamp() + INTERVAL '1 day')`,
      [userId, hashToken(token), scope]
    );
    return token;
  };

  /**
   * The four organizer routes must authorize (403) before anything else, and the UUID guards must
   * fire before the service layer ever sees a malformed identifier.
   */
  const post = (url: string, cookie?: string, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: cookie ? { cookie } : undefined,
      payload,
    });

  beforeAll(async () => {
    db = new PostgresDatabase();
    const identity = new IdentityService(db);
    disputeService = new DisputeService(db);
    app = Fastify();
    registerAdjudicationRoutes(
      app,
      disputeService,
      new CorrectionService(db),
      identity
    );
    await app.ready();

    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Adjudication Guards') RETURNING id`,
      [`FIX_${runId}`]
    );
    courseId = courseRes.rows[0].id;

    const insertUser = async (name: string, role: 'ADMIN' | 'STUDENT') => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'unused', $3, 'ADMIN_ISSUED', $4) RETURNING id`,
        [`${name}_${runId}`, name, role, role === 'ADMIN']
      );
      userIds.push(res.rows[0].id);
      return res.rows[0].id;
    };
    adminUserId = await insertUser('guard_admin', 'ADMIN');
    studentUserId = await insertUser('guard_student', 'STUDENT');

    const teamRes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id)
       VALUES ($1, 'Guard Team A', $2), ($1, 'Guard Team B', $3) RETURNING id`,
      [courseId, studentUserId, adminUserId]
    );
    [teamAId, teamBId] = teamRes.rows.map((row) => row.id);
    await db.query(`INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2)`, [teamAId, studentUserId]);

    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state) VALUES ($1, 'Guard Cup', 'ROUND_ROBIN', 'RUNNING') RETURNING id`,
      [courseId]
    );
    tournamentId = tourneyRes.rows[0].id;
    const encRes = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, 'MAIN', 1, 1, $2, $3, 'COMPLETED') RETURNING id`,
      [tournamentId, teamAId, teamBId]
    );
    encounterId = encRes.rows[0].id;

    cookies.adminFull = `oantuti_session=${await insertSession(adminUserId, 'FULL')}`;
    cookies.adminPco = `oantuti_session=${await insertSession(adminUserId, 'PASSWORD_CHANGE_ONLY')}`;
    cookies.studentFull = `oantuti_session=${await insertSession(studentUserId, 'FULL')}`;
    cookies.studentPco = `oantuti_session=${await insertSession(studentUserId, 'PASSWORD_CHANGE_ONLY')}`;
  });

  afterAll(async () => {
    try {
      if (tournamentId) {
        await db.query(`DELETE FROM disputes WHERE tournament_id = $1`, [tournamentId]);
        await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [tournamentId]);
        await db.query(`DELETE FROM encounters WHERE tournament_id = $1`, [tournamentId]);
        await db.query(`DELETE FROM tournaments WHERE id = $1`, [tournamentId]);
      }
      await db.query(`DELETE FROM command_receipts WHERE actor_user_id = ANY($1::uuid[])`, [userIds]);
      await db.query(`DELETE FROM team_memberships WHERE user_id = ANY($1::uuid[])`, [userIds]);
      await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[teamAId, teamBId]]);
      await db.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [userIds]);
      await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      if (courseId) await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    } finally {
      await app.close();
      await db.close();
    }
  });

  describe('S1: scope === FULL gates adjudication authority', () => {
    it('refuses organizer adjudication to a password-change-only administrator', async () => {
      const guarded = [
        { url: `/api/v2/organizer/disputes/${randomUUID()}/resolve`, payload: { decision: 'RESOLVED' } },
        { url: `/api/v2/organizer/tournaments/${randomUUID()}/teams/${teamAId}/disqualify`, payload: { reason: 'Cheating observed' } },
        { url: `/api/v2/organizer/games/${randomUUID()}/preview-correction`, payload: { action: 'VOID', reason: 'Wrong outcome', expectedRevision: 1 } },
        { url: `/api/v2/organizer/games/${randomUUID()}/apply-correction`, payload: { command: { action: 'VOID', reason: 'Wrong outcome', expectedRevision: 1 }, previewDigest: 'a'.repeat(64) } },
      ];
      for (const route of guarded) {
        const res = await post(route.url, cookies.adminPco, route.payload);
        expect(res.statusCode, route.url).toBe(403);
        expect(res.json(), route.url).toEqual({ error: 'FORBIDDEN' });
      }

      // A password-change-only administrator filing a dispute is an ordinary claimant: it holds no
      // team membership, so the claimant rules answer 403 instead of silently authorizing any team.
      const filing = await post(
        `/api/v2/tournaments/${tournamentId}/disputes`,
        cookies.adminPco,
        { encounterId, teamId: teamBId, reason: 'Privilege escalation attempt' }
      );
      expect(filing.statusCode).toBe(403);
      expect(filing.json().error).toBe('Actor is not a member of the specified team');
      expect(
        (await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM disputes WHERE tournament_id = $1`, [tournamentId])).rows[0].count
      ).toBe(0);
    });

    it('keeps participant filing, limited-session listing and admin resolution for FULL sessions', async () => {
      const filed = await post(
        `/api/v2/tournaments/${tournamentId}/disputes`,
        cookies.studentFull,
        { encounterId, teamId: teamAId, reason: 'Valid team appeal' }
      );
      expect(filed.statusCode).toBe(201);

      // A password-change-only session still reads nothing (its ids resolve, its scope does not).
      const limited = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${tournamentId}/disputes`,
        headers: { cookie: cookies.studentPco },
      });
      expect(limited.statusCode).toBe(200);
      expect(limited.json().disputes).toEqual([]);

      // A fully authenticated administrator may still file on behalf of a team without membership.
      const official = await post(
        `/api/v2/tournaments/${tournamentId}/disputes`,
        cookies.adminFull,
        { encounterId, teamId: teamBId, reason: 'Organizer-initiated complaint' }
      );
      expect(official.statusCode).toBe(201);

      const resolved = await post(
        `/api/v2/organizer/disputes/${filed.json().id}/resolve`,
        cookies.adminFull,
        { decision: 'REJECTED', note: 'Not substantiated' }
      );
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().status).toBe('REJECTED');
    });
  });

  describe('R2: structured INVALID_* instead of raw 22P02', () => {
    it('rejects malformed identifiers with structured codes after authorization', async () => {
      const badRoutes = [
        { url: `/api/v2/tournaments/${BAD_ID}/disputes`, method: 'POST' as const, payload: { encounterId, teamId: teamAId, reason: 'x' }, code: 'INVALID_TOURNAMENT_ID', cookie: 'studentFull' },
        { url: `/api/v2/tournaments/${tournamentId}/disputes`, method: 'POST' as const, payload: { encounterId: BAD_ID, teamId: teamAId, reason: 'x' }, code: 'INVALID_DISPUTE_TARGET', cookie: 'studentFull' },
        { url: `/api/v2/tournaments/${tournamentId}/disputes`, method: 'POST' as const, payload: { encounterId, teamId: BAD_ID, reason: 'x' }, code: 'INVALID_DISPUTE_TARGET', cookie: 'studentFull' },
        { url: `/api/v2/tournaments/${BAD_ID}/disputes`, method: 'GET' as const, code: 'INVALID_TOURNAMENT_ID', cookie: 'adminFull' },
        { url: `/api/v2/organizer/disputes/${BAD_ID}/resolve`, method: 'POST' as const, payload: { decision: 'RESOLVED' }, code: 'INVALID_DISPUTE_ID', cookie: 'adminFull' },
        { url: `/api/v2/organizer/tournaments/${BAD_ID}/teams/${teamAId}/disqualify`, method: 'POST' as const, payload: { reason: 'Cheating observed' }, code: 'INVALID_TOURNAMENT_ID', cookie: 'adminFull' },
        { url: `/api/v2/organizer/tournaments/${tournamentId}/teams/${BAD_ID}/disqualify`, method: 'POST' as const, payload: { reason: 'Cheating observed' }, code: 'INVALID_TEAM_ID', cookie: 'adminFull' },
        { url: `/api/v2/organizer/games/${BAD_ID}/preview-correction`, method: 'POST' as const, payload: { action: 'VOID', reason: 'Wrong', expectedRevision: 1 }, code: 'INVALID_GAME_ID', cookie: 'adminFull' },
        { url: `/api/v2/organizer/games/${BAD_ID}/apply-correction`, method: 'POST' as const, payload: { command: { action: 'VOID', reason: 'Wrong', expectedRevision: 1 }, previewDigest: 'a'.repeat(64) }, code: 'INVALID_GAME_ID', cookie: 'adminFull' },
      ];
      for (const route of badRoutes) {
        const res = await (route.method === 'GET'
          ? app.inject({ method: 'GET', url: route.url, headers: { cookie: cookies[route.cookie] } })
          : post(route.url, cookies[route.cookie], route.payload));
        expect(res.statusCode, route.url).toBe(400);
        expect(res.json(), route.url).toEqual({ error: route.code });
        // PostgreSQL 22P02 leaks column casts verbatim; no raw driver text may reach the caller.
        expect(res.body).not.toMatch(/22P02/i);
      }
    });

    it('authorization wins the ordering: an unauthenticated caller cannot probe id validity', async () => {
      expect((await post(`/api/v2/organizer/disputes/${BAD_ID}/resolve`, cookies.adminPco, { decision: 'RESOLVED' })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: `/api/v2/tournaments/${BAD_ID}/disputes`, headers: { cookie: 'oantuti_session=invalid' } })).statusCode
      ).toBe(401);
    });
  });

  describe('L5: dispute creation is transactional, serialized and idempotent', () => {
    it('returns the live dispute to a double filing instead of inserting a duplicate', async () => {
      const filing: Parameters<DisputeService['createDispute']>[1] = {
        tournamentId,
        encounterId,
        teamId: teamAId,
        reason: 'Double click appeal',
      };
      const actor = { userId: studentUserId, role: 'STUDENT' as const, username: 'guard_student', teamIds: [teamAId], scope: 'FULL' as const };
      const first = await disputeService.createDispute({ ...actor, teamIds: [teamAId] }, filing);
      const second = await disputeService.createDispute(actor, filing);
      expect(second.id).toBe(first.id);
      const live = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM disputes WHERE tournament_id = $1 AND encounter_id = $2 AND team_id = $3 AND status IN ('OPEN','UNDER_REVIEW')`,
        [tournamentId, encounterId, teamAId]
      );
      expect(live.rows[0].count).toBe(1);
    });

    it('serializes against finalize: the state re-check under the tournament lock answers 409', async () => {
      const holder = await db.connectDedicated();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id, state FROM tournaments WHERE id = $1 FOR UPDATE', [tournamentId]);
        const pending = disputeService.createDispute(
          { userId: studentUserId, role: 'STUDENT', username: 'guard_student', teamIds: [teamAId], scope: 'FULL' },
          { tournamentId, encounterId, teamId: teamAId, reason: 'Race versus finalize' }
        );
        const blocked = await waitFor(async () => {
          const locks = await db.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND query ILIKE '%from tournaments where id = $1 for update%'`
          );
          return locks.rows.length > 0;
        });
        expect(blocked).toBe(true);
        // Nothing may be written while the filing is parked on the finalize lock.
        const staged = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM disputes WHERE tournament_id = $1`,
          [tournamentId]
        );
        expect(staged.rows[0].count).toBeGreaterThan(0);

        // Finalize wins the race, closes the dispute ledger leg and marks the tournament FINALIZED.
        const disputeRows = await db.query<{ id: string }>(
          `SELECT id FROM disputes WHERE tournament_id = $1 AND status = 'OPEN'`,
          [tournamentId]
        );
        for (const row of disputeRows.rows) {
          await db.query(`UPDATE disputes SET status = 'RESOLVED', decision = 'Upheld', resolved_at = clock_timestamp() WHERE id = $1`, [row.id]);
        }
        await holder.query(`UPDATE tournaments SET state = 'FINALIZED' WHERE id = $1`, [tournamentId]);
        await holder.query('COMMIT');

        await expect(pending).rejects.toMatchObject<DisputeError>({ statusCode: 409 });
        await expect(
          db.query<{ state: string }>(`SELECT state FROM tournaments WHERE id = $1`, [tournamentId])
        ).resolves.toMatchObject({ rows: [{ state: 'FINALIZED' }] });
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    });
  });

  describe('L3: runIdempotent releases a failed claim', () => {
    const scope = `L3_RELEASE:${runId}`;
    const ctx = (key: string): CommandContext => ({
      actor: { userId: adminUserId, role: 'ADMIN', username: 'guard_admin', teamIds: [], scope: 'FULL' },
      requestId: randomUUID(),
      idempotencyKey: key,
    });

    const receiptsFor = async (key: string) =>
      db.query<{ id: string; status: string }>(
        `SELECT id, status FROM command_receipts WHERE actor_user_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [adminUserId, scope, key]
      );

    it('deletes the PENDING claim when the mutation rejects, so a retry can run again', async () => {
      const key = `failed-${runId}`;
      let attempts = 0;
      await expect(
        runIdempotent(db, ctx(key), scope, { attempt: 'flaky' }, async () => {
          attempts += 1;
          throw new Error('L3: rejected first delivery');
        })
      ).rejects.toThrow('L3: rejected first delivery');
      expect(attempts).toBe(1);
      expect((await receiptsFor(key)).rows).toHaveLength(0);

      const retried = await runIdempotent(db, ctx(key), scope, { attempt: 'flaky' }, async () => {
        attempts += 1;
        return { attempt: attempts };
      });
      expect(retried).toEqual({ attempt: 2 });

      const replayed = await runIdempotent(db, ctx(key), scope, { attempt: 'flaky' }, async () => {
        attempts += 1;
        return { attempt: attempts };
      });
      expect(replayed).toEqual({ attempt: 2 });
      expect(attempts).toBe(2);
      expect((await receiptsFor(key)).rows.map((row) => row.status)).toEqual(['DONE']);
    });

    it('still reports IDEMPOTENT_IN_FLIGHT while the original delivery runs', async () => {
      const key = `concurrent-${runId}`;
      const { promise: releaseGate, resolve: release } = Promise.withResolvers<void>();
      let attempts = 0;
      const first = runIdempotent(db, ctx(key), scope, { i: 1 }, async () => {
        attempts += 1;
        await releaseGate;
        return { attempt: attempts };
      });
      const claimed = await waitFor(async () => (await receiptsFor(key)).rows.some((row) => row.status === 'PENDING'));

      expect(claimed).toBe(true);
      await expect(runIdempotent(db, ctx(key), scope, { i: 1 }, async () => ({ attempt: 2 })))
        .rejects.toMatchObject<Error>({ message: expect.stringContaining('IDEMPOTENT_IN_FLIGHT') });

      release();
      expect(await first).toEqual({ attempt: 1 });
      const afterCompletion = await runIdempotent(db, ctx(key), scope, { i: 1 }, async () => ({ attempt: 2 }));
      expect(afterCompletion).toEqual({ attempt: 1 });
    });
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    // The predicates watch a live PostgreSQL lock/row, so no fake timer can drive their
    // readiness; only a genuine pause between polls can.
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 50);
    await tick.promise;
  }
  return false;
}
