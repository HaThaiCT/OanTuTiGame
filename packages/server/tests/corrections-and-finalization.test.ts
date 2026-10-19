import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { DisputeService, DisputeError } from '../src/adjudication/dispute-service.js';
import { CorrectionService, CorrectionError, type CorrectionReceipt } from '../src/adjudication/correction-service.js';
import { TournamentLifecycleService, TournamentError } from '../src/tournaments/lifecycle-service.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { JobBroker } from '../src/jobs/broker.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService } from '../src/results/service.js';

const sampleMap: MapDescriptor = {
  mapName: 'adjudication-test-map-3x3',
  width: 3,
  height: 3,
  validTiles: [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [1, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ],
  whiteThrone: [0, 0],
  blackThrone: [2, 2],
  startingPieces: [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 1] },
  ],
};

describe('S10: Result Correction, Dispute Ledger & Finalization (T7)', () => {
  let db: PostgresDatabase;
  let disputeService: DisputeService;
  let correctionService: CorrectionService;
  let lifecycleService: TournamentLifecycleService;
  let admissionService: TournamentAdmissionService;
  let scheduler: TournamentSchedulerService;
  let resultService: ResultService;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  let adminActor: Actor;
  let studentActorA: Actor;
  let studentActorOther: Actor;
  let adminCtx: CommandContext;

  let testCourseId: string;
  let testTournamentId: string;
  let testTeamAId: string;
  let testTeamBId: string;
  let testTeamOtherId: string;
  let testEncounterId: string;
  let testGameId: string;

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db));
    disputeService = new DisputeService(db);
    correctionService = new CorrectionService(db, async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
    lifecycleService = new TournamentLifecycleService(db);
    admissionService = new TournamentAdmissionService(db);
    const replayStore = new ReplayStore();
    const traceVerifier = new TraceVerifier();
    resultService = new ResultService(db, replayStore, traceVerifier, async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });

    // Create Course
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Adjudication Course') RETURNING id`,
      [`ADJ_COURSE_${runId}`]
    );
    testCourseId = courseRes.rows[0].id;

    // Create Users
    const uAdmin = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`adj_admin_${runId}`]
    );
    const uStudentA = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Student A', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`adj_student_a_${runId}`]
    );
    const uStudentOther = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Student Other', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`adj_student_other_${runId}`]
    );

    // Create Teams
    const tA = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team A ${runId}`, uStudentA.rows[0].id]
    );
    testTeamAId = tA.rows[0].id;

    const tB = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team B ${runId}`, uStudentA.rows[0].id]
    );
    testTeamBId = tB.rows[0].id;

    const tOther = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team Other ${runId}`, uStudentOther.rows[0].id]
    );
    testTeamOtherId = tOther.rows[0].id;

    adminActor = {
      userId: uAdmin.rows[0].id,
      role: 'ADMIN',
      username: `adj_admin_${runId}`,
      teamIds: [],
      scope: 'FULL',
    };

    studentActorA = {
      userId: uStudentA.rows[0].id,
      role: 'STUDENT',
      username: `adj_student_a_${runId}`,
      teamIds: [testTeamAId],
      scope: 'FULL',
    };

    studentActorOther = {
      userId: uStudentOther.rows[0].id,
      role: 'STUDENT',
      username: `adj_student_other_${runId}`,
      teamIds: [testTeamOtherId],
      scope: 'FULL',
    };

    adminCtx = { actor: adminActor, requestId: randomUUID() };

    // Create tournament in PROVISIONAL state
    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, 'Championship 2026', 'SINGLE_ELIMINATION', 'PROVISIONAL')
       RETURNING id`,
      [testCourseId]
    );
    testTournamentId = tourneyRes.rows[0].id;

    // Create encounter
    const encRes = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, 'MAIN', 1, 1, $2, $3, 'COMPLETED')
       RETURNING id`,
      [testTournamentId, testTeamAId, testTeamBId]
    );
    testEncounterId = encRes.rows[0].id;

    // Create completed game with accepted result
    const gameRes = await db.query<{ id: string }>(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, 1, $2, $3, $4, 'RUNNING')
       RETURNING id`,
      [testEncounterId, testTeamAId, testTeamBId, JSON.stringify(sampleMap)]
    );
    testGameId = gameRes.rows[0].id;

    // Accept initial result (White won)
    const evidence = {
      gameId: testGameId,
      winner: 1, // White wins
      reason: 'THRONE_BREACH',
      disposition: 'DECISIVE' as const,
      executionStatus: 'COMPLETED' as const,
      rulesRevision: 'ArenaGameplay/v2',
      totalPly: 3,
      trace: [
        { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
        { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
        { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } },
      ],
    };

    await resultService.recordResult({
      gameId: testGameId,
      attemptId: randomUUID(),
      evidence,
      manifestDigest: 'sha256_fixture_manifest',
      mapDescriptor: sampleMap,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe('1. Dispute Ledger Invariants', () => {
    let disputeId: string;

    it('allows participant student to file dispute on their match', async () => {
      const dispute = await disputeService.createDispute(studentActorA, {
        tournamentId: testTournamentId,
        encounterId: testEncounterId,
        teamId: testTeamAId,
        reason: 'Opponent bot submitted illegal move during turn 2',
      });

      expect(dispute.status).toBe('OPEN');
      expect(dispute.tournament_id).toBe(testTournamentId);
      expect(dispute.team_id).toBe(testTeamAId);
      disputeId = dispute.id;

      // Verify outbox event DISPUTE_FILED
      const outbox = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'DISPUTE_FILED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outbox.rows[0].payload.disputeId).toBe(disputeId);
    });

    it('denies third-party non-participant student from disputing another encounter', async () => {
      await expect(
        disputeService.createDispute(studentActorOther, {
          tournamentId: testTournamentId,
          encounterId: testEncounterId,
          teamId: testTeamOtherId, // Not in this encounter!
          reason: 'I want to dispute this match',
        })
      ).rejects.toThrow(DisputeError);
    });

    it('lists disputes for tournament and allows Admin to resolve with decision note', async () => {
      // The organizer reads the whole ledger; the filing team sees its own appeal.
      const list = await disputeService.listDisputes(testTournamentId, adminActor);
      expect(list.length).toBeGreaterThanOrEqual(1);
      const own = await disputeService.listDisputes(testTournamentId, studentActorA);
      expect(own.map((row) => row.id)).toContain(disputeId);
      const uninvolved = await disputeService.listDisputes(testTournamentId, studentActorOther);
      expect(uninvolved).toEqual([]);

      // Student cannot resolve
      await expect(
        disputeService.resolveDispute(studentActorA, disputeId, 'RESOLVED', 'Granted')
      ).rejects.toThrow(DisputeError);

      // Admin resolves
      const resolved = await disputeService.resolveDispute(
        adminActor,
        disputeId,
        'RESOLVED',
        'Inspection confirmed hardware latency glitch; voiding game'
      );
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.decided_by_user_id).toBe(adminActor.userId);
      expect(resolved.resolved_at).not.toBeNull();
    });
  });

  describe('2. Result Correction & Cryptographic Preview Fencing', () => {
    let previewDigest: string;

    it('generates correction preview with canonical cryptographic digest', async () => {
      const command = {
        action: 'VOID' as const,
        reason: 'Inspection determined hardware glitch on engine host',
        expectedRevision: 1,
      };

      const preview = await correctionService.previewCorrection(testGameId, command, adminCtx);
      expect(preview.gameId).toBe(testGameId);
      expect(preview.currentRevision).toBe(1);
      expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(preview.affectedRevisions).toContainEqual({ gameId: testGameId, revision: 1 });
      expect(preview.requiredRebuild).toBe(true);
      expect(preview.descendantEncounterIds).toEqual([]);
      expect(preview.ratingImpact.eventIds).toEqual(expect.any(Array));
      previewDigest = preview.previewDigest;
    });

    it('rejects applyCorrection if previewDigest is tampered or stale', async () => {
      const command = {
        action: 'VOID' as const,
        reason: 'Inspection determined hardware glitch on engine host',
        expectedRevision: 1,
      };

      await expect(
        correctionService.applyCorrection(testGameId, command, 'fake_preview_digest', adminCtx)
      ).rejects.toThrow(CorrectionError);
    });

    it('rejects invalid action and revision before any ledger mutation', async () => {
      await expect(correctionService.previewCorrection(testGameId,
        { action: 'WIN', reason: 'Invalid override', expectedRevision: 1 } as never, adminCtx))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(correctionService.previewCorrection(testGameId,
        { action: 'VOID', reason: 'Invalid revision', expectedRevision: 1.5 }, adminCtx))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a preview when a descendant appears after confirmation', async () => {
      const command = { action: 'VOID' as const, reason: 'Inspection determined hardware glitch on engine host', expectedRevision: 1 };
      const descendant = (await db.query<{ id: string }>(`INSERT INTO encounters
        (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
        VALUES ($1, 'MAIN', 2, 99, $2, $3, 'PENDING') RETURNING id`, [testTournamentId, testTeamAId, testTeamBId])).rows[0];
      try {
        const impact = await correctionService.previewCorrection(testGameId, command, adminCtx);
        expect(impact.descendantEncounterIds).toContain(descendant.id);
        expect(impact.requiredRePair).toBe(true);
        await expect(correctionService.applyCorrection(testGameId, command, previewDigest, adminCtx))
          .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('PREVIEW_DIGEST_MISMATCH') });
      } finally {
        await db.query('DELETE FROM encounters WHERE id = $1', [descendant.id]);
      }
    });

    it('checks finalized state and cancelled encounter under the apply locks', async () => {
      const command = { action: 'VOID' as const, reason: 'Inspection determined hardware glitch on engine host', expectedRevision: 1 };
      const originalState = (await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [testTournamentId])).rows[0].state;
      try {
        for (const state of ['FINALIZED', 'ARCHIVED']) {
          await db.query('UPDATE tournaments SET state = $2 WHERE id = $1', [testTournamentId, state]);
          await expect(correctionService.applyCorrection(testGameId, command, previewDigest, adminCtx))
            .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('TOURNAMENT_REOPEN_REQUIRED') });
        }
        await db.query('UPDATE tournaments SET state = $2 WHERE id = $1', [testTournamentId, originalState]);
        await db.query(`UPDATE encounters SET status = 'CANCELLED' WHERE id = $1`, [testEncounterId]);
        await expect(correctionService.applyCorrection(testGameId, command, previewDigest, adminCtx))
          .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('ENCOUNTER_CANCELLED') });
      } finally {
        await db.query('UPDATE tournaments SET state = $2 WHERE id = $1', [testTournamentId, originalState]);
        await db.query(`UPDATE encounters SET status = 'COMPLETED' WHERE id = $1`, [testEncounterId]);
      }
    });

    it('applies correction atomically, creates new result_version, and records correction ledger', async () => {
      const command = {
        action: 'VOID' as const,
        reason: 'Inspection determined hardware glitch on engine host',
        expectedRevision: 1,
      };

      const retryCtx = { ...adminCtx, idempotencyKey: randomUUID() };
      const attempts = await Promise.allSettled([
        correctionService.applyCorrection(testGameId, command, previewDigest, retryCtx),
        correctionService.applyCorrection(testGameId, command, previewDigest, retryCtx),
      ]);
      expect(attempts.every(result => result.status === 'fulfilled')).toBe(true);
      const receipt = (attempts[0] as PromiseFulfilledResult<CorrectionReceipt>).value;
      expect((attempts[1] as PromiseFulfilledResult<typeof receipt>).value).toEqual(receipt);
      expect(await correctionService.applyCorrection(testGameId, command, previewDigest, retryCtx)).toEqual(receipt);
      await expect(correctionService.applyCorrection(testGameId,
        { ...command, reason: 'Different command using the same key' }, previewDigest, retryCtx))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(receipt.data.gameId).toBe(testGameId);
      expect(receipt.data.newRevision).toBe(2);
      await expect(correctionService.applyCorrection(testGameId, command, previewDigest,
        { ...adminCtx, idempotencyKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });

      // Verify accepted_results points to revision 2
      const curAccepted = await db.query<{ revision: number; verdict: string }>(
        `SELECT rv.revision, rv.verdict
         FROM accepted_results ar
         JOIN result_versions rv ON ar.result_version_id = rv.id
         WHERE ar.game_id = $1`,
        [testGameId]
      );
      expect(curAccepted.rows[0].revision).toBe(2);
      expect(curAccepted.rows[0].verdict).toBe('NO_CONTEST');

      // Verify result_corrections ledger entry
      const corrections = await db.query<{ action: string; preview_digest: string }>(
        'SELECT action, preview_digest FROM result_corrections WHERE game_id = $1',
        [testGameId]
      );
      expect(corrections.rows.length).toBe(1);
      expect(corrections.rows[0].preview_digest).toBe(previewDigest);

      // Verify outbox event RESULT_CORRECTED
      const outbox = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'RESULT_CORRECTED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outbox.rows[0].payload.gameId).toBe(testGameId);
      expect(outbox.rows[0].payload.toRevision).toBe(2);

      // A correction rewrites the settled ledger, so the provisional tournament it belonged to is
      // re-opened for a rebuild instead of staying parked with a rewritten result.
      const reopenedByCorrection = await db.query<{ state: string }>(
        'SELECT state FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(reopenedByCorrection.rows[0].state).toBe('RUNNING');
    });
  });

  describe('3. Tournament Finalization Gate', () => {
    it('blocks finalization when open/unresolved disputes exist', async () => {
      // File a new dispute that is left OPEN
      await disputeService.createDispute(studentActorA, {
        tournamentId: testTournamentId,
        encounterId: testEncounterId,
        teamId: testTeamAId,
        reason: 'Unresolved appeal regarding tournament scoring',
      });

      // Admin attempts to finalize through the production path -> BLOCKED!
      await expect(
        admissionService.finalizeTournament(testTournamentId, adminCtx)
      ).rejects.toThrow(TournamentError);
    });

    it('allows finalization once all disputes are decided and sets state to FINALIZED', async () => {
      // The correction above re-opened the ledger; park it back at the final stage, which is the
      // only state the finalization gate accepts.
      await db.query(
        "UPDATE tournaments SET state = 'PROVISIONAL', provisional_at = clock_timestamp() WHERE id = $1",
        [testTournamentId]
      );
      // Resolve the open dispute
      const openDisputes = await db.query<{ id: string }>(
        `SELECT id FROM disputes WHERE tournament_id = $1 AND status = 'OPEN'`,
        [testTournamentId]
      );
      for (const d of openDisputes.rows) {
        await disputeService.resolveDispute(adminActor, d.id, 'RESOLVED', 'Adjudicated by committee');
      }

      // The production finalize also requires the appeal window to be over; a 0-minute window is
      // the operator's explicit "no appeals pending" setting, and disputes are still checked.
      await admissionService.setAppealWindow(testTournamentId, 0, adminCtx);
      const receipt = await admissionService.finalizeTournament(testTournamentId, adminCtx);
      expect(receipt.tournamentId).toBe(testTournamentId);
      expect(receipt.state).toBe('FINALIZED');

      // Verify DB state
      const tourney = await db.query<{ state: string; finalized_at: string }>(
        'SELECT state, finalized_at FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(tourney.rows[0].state).toBe('FINALIZED');
      expect(tourney.rows[0].finalized_at).not.toBeNull();

      // Verify outbox event TOURNAMENT_FINALIZED
      const outbox = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'TOURNAMENT_FINALIZED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outbox.rows[0].payload.tournamentId).toBe(testTournamentId);
    });

    it('rejects finalization on already FINALIZED tournament with 409 Conflict', async () => {
      await expect(
        admissionService.finalizeTournament(testTournamentId, adminCtx)
      ).rejects.toThrow(TournamentError);
    });
  });

  describe('4. REJUDGE asks for a replay instead of voiding the result', () => {
    it('withdraws the acceptance, records the reason and queues the game again', async () => {
      // The previous block left the tournament FINALIZED; the documented flow is an explicit reopen
      // before any ledger correction, which is exactly what the guard requires.
      const reopened = await admissionService.reopenTournament(testTournamentId, adminCtx);
      expect(reopened.state).toBe('PROVISIONAL');

      const replayRequests: string[] = [];
      const replays = new CorrectionService(
        db,
        async () => { throw new Error('lost acknowledgement after commit'); },
        undefined,
        undefined,
        async (gameId, client) => {
          replayRequests.push(gameId);
          await client.query(`INSERT INTO jobs (job_type, target_id, priority, state, payload)
            VALUES ('GAME', $1, 300, 'QUEUED', '{}')`, [gameId]);
        }
      );

      const replayObject = `rejudge-fixture-${runId}.oantuti`;
      const game = await db.query<{ id: string }>(
        `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
         VALUES ($1, 2, $2, $3, $4, 'COMPLETED') RETURNING id`,
        [testEncounterId, testTeamAId, testTeamBId, JSON.stringify(sampleMap)]
      );
      const gameId = game.rows[0].id;
      await db.query(
        `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns) VALUES ($1, $2, 8, 3)`,
        [replayObject, `/tmp/${replayObject}`]
      );
      const version = await db.query<{ id: string }>(
        `INSERT INTO result_versions (
           game_id, revision, verdict, winner, reason, disposition,
           action_trace_digest, replay_digest, manifest_digest)
         VALUES ($1, 1, 'DECISIVE', 1, 'THRONE_BREACH', 'DECISIVE', 'trace', $2, 'manifest') RETURNING id`,
        [gameId, replayObject]
      );
      await db.query(`INSERT INTO accepted_results (game_id, result_version_id) VALUES ($1, $2)`, [
        gameId,
        version.rows[0].id,
      ]);

      const command = { action: 'REJUDGE' as const, reason: 'Scoreboard firmware fault', expectedRevision: 1 };
      const preview = await replays.previewCorrection(gameId, command, adminCtx);
      const failedCtx = { ...adminCtx, idempotencyKey: randomUUID() };
      const unavailableQueue = new CorrectionService(db, undefined, undefined, undefined, async (_id, client) => {
        await client.query(`INSERT INTO jobs (job_type,target_id,state,payload) VALUES ('GAME',$1,'QUEUED','{}')`, [gameId]);
        throw new Error('queue transaction interrupted');
      });
      await expect(unavailableQueue.applyCorrection(gameId, command, preview.previewDigest, failedCtx)).rejects.toThrow('queue transaction interrupted');
      expect((await db.query('SELECT 1 FROM accepted_results WHERE game_id = $1', [gameId])).rows).toHaveLength(1);
      expect((await db.query('SELECT 1 FROM jobs WHERE target_id = $1', [gameId])).rows).toHaveLength(0);
      expect((await db.query('SELECT 1 FROM command_receipts WHERE idempotency_key = $1', [failedCtx.idempotencyKey])).rows).toHaveLength(0);
      const replayCtx = { ...adminCtx, idempotencyKey: randomUUID() };
      await expect(replays.applyCorrection(gameId, command, preview.previewDigest, replayCtx)).rejects.toThrow('lost acknowledgement after commit');
      const receipt = await replays.applyCorrection(gameId, command, preview.previewDigest, replayCtx);
      expect(await replays.applyCorrection(gameId, command, preview.previewDigest, replayCtx)).toEqual(receipt);
      expect(receipt.data.gameId).toBe(gameId);
      expect(replayRequests).toEqual([gameId]);
      expect((await db.query(`SELECT id FROM jobs WHERE job_type = 'GAME' AND target_id = $1 AND state = 'QUEUED'`, [gameId])).rows).toHaveLength(1);

      // No fabricated outcome: the ledger keeps the original version and adds no void version.
      const versions = await db.query<{ revision: number; reason: string; disposition: string }>(
        `SELECT revision, reason, disposition FROM result_versions WHERE game_id = $1 ORDER BY revision`,
        [gameId]
      );
      expect(versions.rows).toEqual([{ revision: 1, reason: 'THRONE_BREACH', disposition: 'DECISIVE' }]);
      expect((await db.query(`SELECT 1 FROM accepted_results WHERE game_id = $1`, [gameId])).rows).toHaveLength(0);
      const status = await db.query<{ status: string }>(`SELECT status FROM games WHERE id = $1`, [gameId]);
      expect(status.rows[0].status).toBe('PENDING');

      // The withdrawal itself is auditable: action, reason and a null replacement version.
      const corrections = await db.query<{ action: string; reason: string; to_result_version_id: string | null }>(
        `SELECT action, reason, to_result_version_id FROM result_corrections WHERE game_id = $1`,
        [gameId]
      );
      expect(corrections.rows).toEqual([
        { action: 'REJUDGE', reason: 'Scoreboard firmware fault', to_result_version_id: null },
      ]);
      const requested = await db.query(
        `SELECT payload FROM outbox_events WHERE topic = 'RESULT_REJUDGE_REQUESTED' AND payload->>'gameId' = $1`,
        [gameId]
      );
      expect(requested.rows).toHaveLength(1);

      // A game with no acceptance has nothing to replay.
      await expect(replays.applyCorrection(gameId, command, preview.previewDigest, adminCtx)).rejects.toMatchObject({
        statusCode: 400,
      });

      await db.query(`DELETE FROM outbox_events WHERE payload->>'gameId' = $1`, [gameId]);
      await db.query(`DELETE FROM audit_events WHERE resource_id = $1`, [gameId]);
      await db.query('DELETE FROM result_corrections WHERE game_id = $1', [gameId]);
      await db.query('DELETE FROM accepted_results WHERE game_id = $1', [gameId]);
      await db.query('DELETE FROM result_versions WHERE game_id = $1', [gameId]);
      await db.query(`DELETE FROM jobs WHERE target_id = $1`, [gameId]);
      await db.query('DELETE FROM games WHERE id = $1', [gameId]);
      await db.query('DELETE FROM replay_objects WHERE digest = $1', [replayObject]);
    });
  });
});
