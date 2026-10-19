import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import { packReplay, unpackReplay } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ReplayStore, REPLAY_V2_MAGIC } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService, ResultIntegrityError, ResultAlreadyAcceptedError } from '../src/results/service.js';

const testStorageRoot = resolve('/tmp/oantuti-test-results/replays');
const testStagingRoot = resolve('/tmp/oantuti-test-results/staging');

const sampleMap: MapDescriptor = {
  mapName: 'test-duel-3x3',
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
    { id: 2, owner: 'BLACK', type: 'SCISSORS', pos: [2, 1] },
  ],
};

describe('S07: Result Durability, FS & Replay Objects', () => {
  let db: PostgresDatabase;
  let replayStore: ReplayStore;
  let traceVerifier: TraceVerifier;
  let resultService: ResultService;

  let testCourseId: string;
  let testTournamentId: string;
  let testTeamAId: string;
  let testTeamBId: string;
  let testEncounterId: string;
  let testGameId: string;

  beforeAll(async () => {
    rmSync('/tmp/oantuti-test-results', { recursive: true, force: true });
    db = new PostgresDatabase();
    replayStore = new ReplayStore(testStorageRoot, testStagingRoot);
    traceVerifier = new TraceVerifier();
    resultService = new ResultService(db, replayStore, traceVerifier);

    const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const userRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'S07 Captain', 'hash_s07', 'STUDENT', 'ADMIN_ISSUED', FALSE)
       RETURNING id`,
      [`s07_captain_${runId}`]
    );
    const captainUserId = userRes.rows[0].id;

    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name)
       VALUES ($1, 'Result Durability Course')
       RETURNING id`,
      [`S07_TEST_${runId}`]
    );
    testCourseId = courseRes.rows[0].id;

    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, 'S07 Tournament', 'SINGLE_ELIMINATION', 'RUNNING')
       RETURNING id`,
      [testCourseId]
    );
    testTournamentId = tourneyRes.rows[0].id;

    const teamARes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team S07 Alpha ${runId}`, captainUserId]
    );
    testTeamAId = teamARes.rows[0].id;

    const teamBRes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team S07 Beta ${runId}`, captainUserId]
    );
    testTeamBId = teamBRes.rows[0].id;

    const encRes = await db.query<{ id: string }>(
      `INSERT INTO encounters (tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, 1, 1, $2, $3, 'RUNNING')
       RETURNING id`,
      [testTournamentId, testTeamAId, testTeamBId]
    );
    testEncounterId = encRes.rows[0].id;

    const gameRes = await db.query<{ id: string }>(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, 1, $2, $3, $4, 'RUNNING')
       RETURNING id`,
      [testEncounterId, testTeamAId, testTeamBId, JSON.stringify(sampleMap)]
    );
    testGameId = gameRes.rows[0].id;
  });

  afterAll(async () => {
    await db.close();
    rmSync('/tmp/oantuti-test-results', { recursive: true, force: true });
  });

  describe('1. ReplayStore V2 Serialization & Durability', () => {
    it('serializes and deserializes OANTUTI2 replay with checksum verification', () => {
      const payload = {
        gameId: randomUUID(),
        attemptId: randomUUID(),
        mapId: 'test-duel-3x3',
        rulesRevision: 'ArenaGameplay/v2',
        manifestDigest: 'abc123manifest',
        totalTurns: 2,
        winner: 1,
        reason: 'THRONE_BREACH',
        disposition: 'DECISIVE',
        trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } }],
      };

      const buffer = replayStore.serializeReplayV2(payload);
      expect(buffer.subarray(0, 8).toString('ascii')).toBe(REPLAY_V2_MAGIC);

      const parsed = replayStore.deserializeReplayV2(buffer);
      expect(parsed.gameId).toBe(payload.gameId);
      expect(parsed.winner).toBe(1);
      expect(parsed.reason).toBe('THRONE_BREACH');
      expect(parsed.manifestDigest).toBe(payload.manifestDigest);
    });

    it('rejects tampered replay buffers with checksum mismatch error', () => {
      const payload = {
        gameId: randomUUID(),
        attemptId: randomUUID(),
        mapId: 'test-duel-3x3',
        rulesRevision: 'ArenaGameplay/v2',
        manifestDigest: 'manifest_original',
        totalTurns: 1,
        winner: 1,
        reason: 'THRONE_BREACH',
        disposition: 'DECISIVE',
        trace: [],
      };

      const buffer = replayStore.serializeReplayV2(payload);
      // Flip a single bit in the body
      buffer[15] ^= 0x01;

      expect(() => replayStore.deserializeReplayV2(buffer)).toThrow(/checksum mismatch/);
    });

    it('stages with fsync and promotes atomically to immutable storage', () => {
      const payload = {
        gameId: randomUUID(),
        attemptId: randomUUID(),
        mapId: 'test-duel-3x3',
        rulesRevision: 'ArenaGameplay/v2',
        manifestDigest: 'manifest_digest_456',
        totalTurns: 5,
        winner: 2,
        reason: 'EXTINCTION',
        disposition: 'DECISIVE',
        trace: [],
      };

      const buffer = replayStore.serializeReplayV2(payload);
      const stagingKey = `test_stage_${Date.now()}.oantuti`;

      const staged = replayStore.stageReplay(stagingKey, buffer);
      expect(existsSync(staged.stagingPath)).toBe(true);

      const stored = replayStore.promoteStagedReplay(staged.stagingPath, staged.digest);
      expect(existsSync(stored.absolutePath)).toBe(true);
      expect(existsSync(staged.stagingPath)).toBe(false); // Staging moved/renamed

      const readBack = replayStore.readReplay(stored.digest);
      expect(readBack.length).toBe(buffer.length);
    });
  });

  describe('2. TraceVerifier Engine Validation', () => {
    it('verifies valid trace resulting in throne breach', async () => {
      // White piece 1 is at [0, 1]. In test-duel-3x3, black throne is at [2, 2].
      // Step 1 (White): piece 1 moves [0, 1] -> [1, 2]
      // Step 2 (Black): piece 2 at [2, 1] moves [2, 1] -> [1, 1]
      // Step 3 (White): piece 1 moves [1, 2] -> [2, 2] (Black throne breached!)
      const evidence = {
        gameId: testGameId,
        winner: 1,
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

      const result = await traceVerifier.verify(sampleMap, evidence);
      expect(result.isValid).toBe(true);
      expect(result.finalOutcome?.winner).toBe(1); // PlayerSide.WHITE = 1
      expect(result.finalOutcome?.reason).toBe('THRONE_BREACH');
    });

    it('rejects trace with an illegal move', async () => {
      const evidence = {
        gameId: testGameId,
        winner: 1,
        reason: 'THRONE_BREACH',
        disposition: 'DECISIVE' as const,
        executionStatus: 'COMPLETED' as const,
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: 1,
        trace: [
          // Piece 1 is at [0, 1]; moving to [9, 9] is way off-map and illegal
          { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 9, y: 9 } } },
        ],
      };

      const result = await traceVerifier.verify(sampleMap, evidence);
      expect(result.isValid).toBe(false);
      expect(result.error).toMatch(/IllegalAction/);
    });

    it('rejects trace claiming wrong winner', async () => {
      // White breaches throne, but evidence fraudulently claims Black (side 2) won!
      const evidence = {
        gameId: testGameId,
        winner: 2, // FRAUDULENT
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

      const result = await traceVerifier.verify(sampleMap, evidence);
      expect(result.isValid).toBe(false);
      expect(result.error).toMatch(/ClaimedOutcomeMismatch/);
    });

    it('validates a forfeit prefix without certifying the fault', async () => {
      const evidence = {
        gameId: testGameId,
        winner: 1, // White awarded win
        reason: 'TIMEOUT_FORFEIT',
        disposition: 'DECISIVE' as const,
        executionStatus: 'BOT_FORFEIT' as const,
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: 1,
        trace: [
          { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
        ],
      };

      const result = await traceVerifier.verify(sampleMap, evidence);
      expect(result.isValid).toBe(true);
      expect(result.requiresSupervisorEvidence).toBe(true);
    });
  });

  describe('3. ResultService Acceptance & PostgreSQL Durability', () => {
    it('refuses to accept a legal runtime-forfeit prefix without supervisor evidence', async () => {
      const gameId = randomUUID();
      await expect(resultService.recordResult({
        gameId, attemptId: randomUUID(), manifestDigest: 'forfeit-test', mapDescriptor: sampleMap,
        evidence: {
          gameId, winner: 2, reason: 'CRASH_FORFEIT', disposition: 'DECISIVE',
          executionStatus: 'BOT_FORFEIT', rulesRevision: 'ArenaGameplay/v2', totalPly: 0, trace: [],
        },
      })).rejects.toThrow(/SUPERVISOR_EVIDENCE_REQUIRED/);
    });

    it('accepts valid game result, updates game status, and emits outbox event', async () => {
      const evidence = {
        gameId: testGameId,
        winner: 1,
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

      const receipt = await resultService.recordResult({
        gameId: testGameId,
        attemptId: randomUUID(),
        evidence,
        manifestDigest: 'manifest_sha256_001',
        mapDescriptor: sampleMap,
      });

      expect(receipt.data.gameId).toBe(testGameId);
      expect(receipt.data.state).toBe('ACCEPTED');

      // Verify DB persistence
      const accepted = await resultService.getAcceptedResult(testGameId);
      expect(accepted).not.toBeNull();
      expect(accepted?.winner).toBe(1);
      expect(accepted?.reason).toBe('THRONE_BREACH');
      expect(accepted?.revision).toBe(1);

      // Verify game status is COMPLETED
      const gameRow = await db.query<{ status: string }>('SELECT status FROM games WHERE id = $1', [testGameId]);
      expect(gameRow.rows[0].status).toBe('COMPLETED');

      // Verify outbox event was created
      const outbox = await db.query<{ topic: string; payload: any }>(
        `SELECT topic, payload FROM outbox_events WHERE topic = 'GAME_RESULT_ACCEPTED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outbox.rows.length).toBe(1);
      expect(outbox.rows[0].payload.gameId).toBe(testGameId);
      expect(outbox.rows[0].payload.winner).toBe(1);
    });

    it('rejects fraudulent result evidence and does not modify database', async () => {
      // A fresh game: the accepted-result guard short-circuits any game that already has a
      // result, and this case is about trace verification.
      const fraudGameRes = await db.query<{ id: string }>(
        `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
         VALUES ($1, 2, $2, $3, $4, 'RUNNING')
         RETURNING id`,
        [testEncounterId, testTeamAId, testTeamBId, JSON.stringify(sampleMap)]
      );
      const fraudGameId = fraudGameRes.rows[0].id;

      const badEvidence = {
        gameId: fraudGameId,
        winner: 1,
        reason: 'THRONE_BREACH',
        disposition: 'DECISIVE' as const,
        executionStatus: 'COMPLETED' as const,
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: 1,
        trace: [
          { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 99, y: 99 } } }, // Illegal
        ],
      };

      await expect(
        resultService.recordResult({
          gameId: fraudGameId,
          attemptId: randomUUID(),
          evidence: badEvidence,
          manifestDigest: 'bad_manifest',
          mapDescriptor: sampleMap,
        })
      ).rejects.toThrow(ResultIntegrityError);

      // No accepted result was created for the fraudulent attempt.
      expect(await resultService.getAcceptedResult(fraudGameId)).toBeNull();

      // Current accepted result still revision 1
      const current = await resultService.getAcceptedResult(testGameId);
      expect(current?.revision).toBe(1);
    });

    it('never records a second accepted result for the same game (lease replay is rejected)', async () => {
      // A reclaimed job lease (process restarted between recording and completing the job)
      // replays the game. Revision bumps belong to the adjudication ledger
      // (`result_corrections`, exercised in corrections-and-finalization.test.ts) — the
      // executor must never append a second accepted version.
      const replayEvidence = {
        gameId: testGameId,
        winner: 2,
        reason: 'LEASE_REPLAY',
        disposition: 'DECISIVE' as const,
        executionStatus: 'BOT_FORFEIT' as const,
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: 1,
        trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } }],
      };

      await expect(
        resultService.recordResult({
          gameId: testGameId,
          attemptId: randomUUID(),
          evidence: replayEvidence,
          manifestDigest: 'replay_manifest_002',
          mapDescriptor: sampleMap,
        })
      ).rejects.toThrow(ResultAlreadyAcceptedError);

      // The accepted result is untouched and there is still exactly one version.
      const accepted = await resultService.getAcceptedResult(testGameId);
      expect(accepted?.revision).toBe(1);
      expect(accepted?.winner).toBe(1);
      expect(accepted?.reason).toBe('THRONE_BREACH');

      const versions = await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM result_versions WHERE game_id = $1',
        [testGameId]
      );
      expect(versions.rows[0].count).toBe('1');
    });

    it('exposes the accepted result with the evidence a job completion pins', async () => {
      const summary = await resultService.getAcceptedResultSummary(testGameId);
      expect(summary?.revision).toBe(1);
      expect(summary?.evidence.verdict).toBe('DECISIVE');
      expect(summary?.evidence.winner).toBe(1);
      expect(summary?.evidence.reason).toBe('THRONE_BREACH');
      expect(summary?.evidence.actionTraceDigest).toHaveLength(64);
      expect(summary?.evidence.replayDigest).toHaveLength(64);
      expect(summary?.evidence.details).toMatchObject({ gameId: testGameId, accepted: true });

      // A game with no accepted result has no summary (the executor then runs the match).
      expect(await resultService.getAcceptedResultSummary(randomUUID())).toBeNull();
    });
  });

  describe('4. V1 Archive Compatibility', () => {
    it('preserves read compatibility with historical OANTUTI1 binary replays', () => {
      const v1Init = {
        matchId: 'match_v1_legacy',
        map: {
          width: 5,
          height: 5,
          validTilesBitmask: new Uint8Array([0xff]),
          whiteThrone: { x: 0, y: 0 },
          blackThrone: { x: 4, y: 4 },
          mapName: 'classic_map',
        },
        pieces: [],
        maxTurns: 100,
        turnTimeLimitMs: 50,
        whiteBotName: 'LegacyWhite',
        blackBotName: 'LegacyBlack',
      };

      const v1End = {
        matchId: 'match_v1_legacy',
        winner: 1, // PlayerSide.WHITE
        reason: 1, // WinReason.EXTINCTION
        finalScores: { white: 10, black: 5 },
        totalTurns: 10,
      };

      const v1Bytes = packReplay(v1Init, [], v1End);
      expect(Buffer.from(v1Bytes).subarray(0, 8).toString('ascii')).toBe('OANTUTI1');

      const unpacked = unpackReplay(v1Bytes);
      expect(unpacked.init.matchId).toBe('match_v1_legacy');
      expect(unpacked.end.winner).toBe(1);
    });
  });
  describe('6. Acceptance fence applies to new writes, not to a pinned consumer', () => {
    async function freshGame(ordinal: number): Promise<string> {
      const res = await db.query<{ id: string }>(
        `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
         VALUES ($1, $2, $3, $4, $5, 'RUNNING') RETURNING id`,
        [testEncounterId, ordinal, testTeamAId, testTeamBId, JSON.stringify(sampleMap)]
      );
      return res.rows[0].id;
    }
    const evidenceFor = (gameId: string) => ({
      gameId, winner: 1, reason: 'THRONE_BREACH', disposition: 'DECISIVE' as const,
      executionStatus: 'COMPLETED' as const, rulesRevision: 'ArenaGameplay/v2', totalPly: 3,
      trace: [
        { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
        { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
        { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } },
      ],
    });

    it('skips the freshness fence for a completion that was already pinned, and keeps it for a fresh write', async () => {
      // A restored generation has no checkpoint yet; a pending completion pinned before the restore
      // must still drain, or the restored queue stalls forever (the fence was already applied when
      // the evidence was pinned).
      resultService.setAcceptanceFence(() => { throw new Error('fence must not run for a pinned completion'); });
      try {
        const pinnedGame = await freshGame(91);
        const receipt = await db.withTransaction((client) => resultService.recordResult({
          gameId: pinnedGame, attemptId: randomUUID(), evidence: evidenceFor(pinnedGame),
          manifestDigest: 'manifest_pinned', mapDescriptor: sampleMap, client,
        }));
        expect(receipt.data.state).toBe('ACCEPTED');

        const fresh = await freshGame(92);
        await expect(resultService.recordResult({
          gameId: fresh, attemptId: randomUUID(), evidence: evidenceFor(fresh),
          manifestDigest: 'manifest_fresh', mapDescriptor: sampleMap,
        })).rejects.toThrow('fence must not run for a pinned completion');
      } finally {
        resultService.setAcceptanceFence(undefined);
      }
    });
  });

});
