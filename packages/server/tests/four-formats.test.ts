import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import { PostgresDatabase } from '../src/persistence/db.js';
import { EliminationFormat } from '../src/tournaments/formats/elimination.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { RoundRobinFormat } from '../src/tournaments/formats/round-robin.js';
import { EloFormat } from '../src/tournaments/formats/elo.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService } from '../src/results/service.js';

const sampleMap: MapDescriptor = {
  mapName: 'format-test-map-3x3',
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

describe('S09: 4 Formats: Elimination, Swiss, Round-Robin, Elo (T6)', () => {
  let db: PostgresDatabase;
  let elimination: EliminationFormat;
  let swiss: SwissFormat;
  let roundRobin: RoundRobinFormat;
  let elo: EloFormat;
  let scheduler: TournamentSchedulerService;
  let replayStore: ReplayStore;
  let traceVerifier: TraceVerifier;
  let resultService: ResultService;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    elimination = new EliminationFormat();
    swiss = new SwissFormat();
    roundRobin = new RoundRobinFormat();
    elo = new EloFormat();
    scheduler = new TournamentSchedulerService(db, elimination, swiss, roundRobin, elo);
    replayStore = new ReplayStore();
    traceVerifier = new TraceVerifier();
    resultService = new ResultService(db, replayStore, traceVerifier, async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe('1. Mathematical Policy Formulas', () => {
    it('calculates Swiss rounds R according to canonical formula', () => {
      // R = min(ceil(log2(N)), N-1 if even else N)
      expect(swiss.calculateRounds(2)).toBe(1); // min(1, 1) = 1
      expect(swiss.calculateRounds(3)).toBe(2); // min(2, 3) = 2
      expect(swiss.calculateRounds(4)).toBe(2); // min(2, 3) = 2
      expect(swiss.calculateRounds(8)).toBe(3); // min(3, 7) = 3
      expect(swiss.calculateRounds(16)).toBe(4); // min(4, 15) = 4
      expect(swiss.calculateRounds(64)).toBe(6); // min(6, 63) = 6
      expect(swiss.calculateRounds(500)).toBe(9); // ceil(log2(500)) = 9, min(9, 499) = 9
    });

    it('calculates Swiss playoff cutoff T according to canonical formula', () => {
      // T = min(N, max(2, 2^floor(log2(isqrt(N)))))
      expect(swiss.calculatePlayoffCutoff(2)).toBe(2);
      expect(swiss.calculatePlayoffCutoff(4)).toBe(2); // isqrt(4)=2, 2^1=2
      expect(swiss.calculatePlayoffCutoff(16)).toBe(4); // isqrt(16)=4, 2^2=4
      expect(swiss.calculatePlayoffCutoff(64)).toBe(8); // isqrt(64)=8, 2^3=8
      expect(swiss.calculatePlayoffCutoff(500)).toBe(16); // isqrt(500)=22, floor(log2(22))=4, 2^4=16
    });

    it('calculates Elo epochs E according to canonical formula', () => {
      // E = max(8, 4 * ceil(log2(N)))
      expect(elo.calculateEpochs(2)).toBe(8); // max(8, 4*1) = 8
      expect(elo.calculateEpochs(4)).toBe(8); // max(8, 4*2) = 8
      expect(elo.calculateEpochs(16)).toBe(16); // max(8, 4*4) = 16
      expect(elo.calculateEpochs(64)).toBe(24); // max(8, 4*6) = 24
      expect(elo.calculateEpochs(500)).toBe(36); // max(8, 4*9) = 36
    });
  });

  describe('2. EliminationFormat Invariants', () => {
    it('creates round 1 pairings and advances winners to final for 4 teams', () => {
      const teams = [
        { teamId: 't1', seedOrdinal: 1 },
        { teamId: 't2', seedOrdinal: 2 },
        { teamId: 't3', seedOrdinal: 3 },
        { teamId: 't4', seedOrdinal: 4 },
      ];

      const r1 = elimination.generateRound1(teams);
      expect(r1.pairings.length).toBe(2);
      expect(r1.pairings[0].teamAId).toBe('t1');
      expect(r1.pairings[0].teamBId).toBe('t4'); // 1 vs 4
      expect(r1.pairings[1].teamAId).toBe('t2');
      expect(r1.pairings[1].teamBId).toBe('t3'); // 2 vs 3

      // Simulate completions of R1
      const completed = [
        { encounterId: 'e1', roundOrdinal: 1, teamAId: 't1', teamBId: 't4', winnerTeamId: 't1', pointsA: 3, pointsB: 0 },
        { encounterId: 'e2', roundOrdinal: 1, teamAId: 't2', teamBId: 't3', winnerTeamId: 't2', pointsA: 3, pointsB: 0 },
      ];

      const r2 = elimination.generateNextRound(completed, 1);
      expect(r2).not.toBeNull();
      expect(r2!.roundOrdinal).toBe(2);
      expect(r2!.pairings.length).toBe(1);
      expect(r2!.pairings[0].teamAId).toBe('t1');
      expect(r2!.pairings[0].teamBId).toBe('t2'); // Finals: t1 vs t2!

      // Simulate completion of R2 (Finals)
      const finalCompleted = [
        ...completed,
        { encounterId: 'e3', roundOrdinal: 2, teamAId: 't1', teamBId: 't2', winnerTeamId: 't1', pointsA: 3, pointsB: 0 },
      ];

      const r3 = elimination.generateNextRound(finalCompleted, 2);
      expect(r3).toBeNull(); // Tournament finished!
    });

    it('correctly awards round 1 bye to top seed when N is not a power of 2', () => {
      const teams = [
        { teamId: 't1', seedOrdinal: 1 },
        { teamId: 't2', seedOrdinal: 2 },
        { teamId: 't3', seedOrdinal: 3 },
      ];

      const r1 = elimination.generateRound1(teams);
      // Bracket size 4: Slot 1 is seed 1 vs seed 4 (bye!). Slot 2 is seed 2 vs seed 3.
      expect(r1.pairings[0].teamAId).toBe('t1');
      expect(r1.pairings[0].isBye).toBe(true);
      expect(r1.pairings[1].teamAId).toBe('t2');
      expect(r1.pairings[1].teamBId).toBe('t3');
    });
  });

  describe('3. SwissFormat Invariants & Standings', () => {
    it('computes Swiss standings with Buchholz and Sonneborn-Berger', () => {
      const teams = [
        { teamId: 't1', seedOrdinal: 1 },
        { teamId: 't2', seedOrdinal: 2 },
        { teamId: 't3', seedOrdinal: 3 },
        { teamId: 't4', seedOrdinal: 4 },
      ];

      const completed = [
        { encounterId: 'e1', roundOrdinal: 1, teamAId: 't1', teamBId: 't3', winnerTeamId: 't1', pointsA: 3, pointsB: 0 },
        { encounterId: 'e2', roundOrdinal: 1, teamAId: 't2', teamBId: 't4', winnerTeamId: 't2', pointsA: 3, pointsB: 0 },
      ];

      const standings = swiss.computeStandings(teams, completed);
      expect(standings[0].points).toBe(3);
      expect(standings[1].points).toBe(3);
      expect(standings[2].points).toBe(0);
      expect(standings[3].points).toBe(0);

      // t1 and t2 won; next round pairs the two winners (t1 vs t2) and two losers (t3 vs t4)
      const r2 = swiss.generateNextRound(teams, completed, 1);
      expect(r2.pairings.length).toBe(2);
      expect(r2.pairings.some((p) => (p.teamAId === 't1' && p.teamBId === 't2') || (p.teamAId === 't2' && p.teamBId === 't1'))).toBe(true);
    });

    it('awards bye to eligible candidate when number of teams is odd', () => {
      const teams = [
        { teamId: 't1', seedOrdinal: 1 },
        { teamId: 't2', seedOrdinal: 2 },
        { teamId: 't3', seedOrdinal: 3 },
      ];

      const r1 = swiss.generateRound1(teams);
      expect(r1.pairings.some((p) => p.isBye)).toBe(true);
      // Worst seed (t3) gets bye
      const byePairing = r1.pairings.find((p) => p.isBye);
      expect(byePairing?.teamAId).toBe('t3');
    });
  });

  describe('4. RoundRobin & Elo Format Invariants', () => {
    it('generates complete circle schedule for Round-Robin without duplicate encounters', () => {
      const teams = [
        { teamId: 't1', seedOrdinal: 1 },
        { teamId: 't2', seedOrdinal: 2 },
        { teamId: 't3', seedOrdinal: 3 },
        { teamId: 't4', seedOrdinal: 4 },
      ];

      const totalRounds = roundRobin.calculateTotalRounds(4); // 3 rounds
      expect(totalRounds).toBe(3);

      const allPairs = new Set<string>();
      for (let r = 1; r <= totalRounds; r++) {
        const sched = roundRobin.generateRound(teams, r);
        expect(sched.pairings.length).toBe(2);
        for (const p of sched.pairings) {
          const key = [p.teamAId, p.teamBId].sort().join(':');
          expect(allPairs.has(key)).toBe(false); // No duplicates
          allPairs.add(key);
        }
      }

      // 4 choose 2 = 6 unique encounters
      expect(allPairs.size).toBe(6);
    });

    it('calculates zero-sum Elo rating shifts using K32 formula', () => {
      // Team A (1200) beats Team B (1200) in match
      const res = elo.calculateDeltas(1200, 1200, 3, 0);
      expect(res.deltaA).toBe(16.0); // 32 * (1 - 0.5) = 16
      expect(res.deltaB).toBe(-16.0);
      expect(res.postRatingA).toBe(1216.0);
      expect(res.postRatingB).toBe(1184.0);
      expect(res.deltaA + res.deltaB).toBe(0); // Zero-sum conservation
    });
  });

  describe('5. End-to-End Single Elimination Integration with Database', () => {
    let testCourseId: string;
    let testTournamentId: string;
    let testTeams: { id: string; name: string }[];

    beforeAll(async () => {
      const courseRes = await db.query<{ id: string }>(
        `INSERT INTO courses (code, name) VALUES ($1, 'Elimination Test Course') RETURNING id`,
        [`ELIM_COURSE_${runId}`]
      );
      testCourseId = courseRes.rows[0].id;

      // Create 4 teams
      testTeams = [];
      for (let i = 1; i <= 4; i++) {
        const u = await db.query<{ id: string }>(
          `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
           VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
          [`elim_user_${runId}_${i}`, `Elim Captain ${i}`]
        );
        const t = await db.query<{ id: string }>(
          `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
          [testCourseId, `Elim Team ${i} ${runId}`, u.rows[0].id]
        );
        testTeams.push({ id: t.rows[0].id, name: `Elim Team ${i}` });
      }

      // Create Tournament
      const tourneyRes = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state)
         VALUES ($1, 'Elimination Championship', 'SINGLE_ELIMINATION', 'RUNNING')
         RETURNING id`,
        [testCourseId]
      );
      testTournamentId = tourneyRes.rows[0].id;

      // Enroll and freeze entries
      for (let i = 0; i < 4; i++) {
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal)
           VALUES ($1, $2, 'ELIGIBLE', $3)`,
          [testTournamentId, testTeams[i].id, i + 1]
        );
      }
    });

    it('schedules Round 1, records game results, advances to finals, and marks tournament PROVISIONAL', async () => {
      // 1. Schedule Round 1
      await scheduler.scheduleRound1(testTournamentId, sampleMap);

      // Verify 2 encounters created for Round 1
      const encs = await db.query<{ id: string; slot_ordinal: number; team_a_id: string; team_b_id: string }>(
        `SELECT id, slot_ordinal, team_a_id, team_b_id FROM encounters
         WHERE tournament_id = $1 AND round_ordinal = 1 ORDER BY slot_ordinal ASC`,
        [testTournamentId]
      );
      expect(encs.rows.length).toBe(2);

      // Verify 2 games per encounter (total 4 games)
      const games = await db.query<{ id: string; encounter_id: string; game_ordinal: number; white_team_id: string; black_team_id: string }>(
        `SELECT g.id, g.encounter_id, g.game_ordinal, g.white_team_id, g.black_team_id
         FROM games g
         JOIN encounters e ON g.encounter_id = e.id
         WHERE e.tournament_id = $1 AND e.round_ordinal = 1
         ORDER BY g.encounter_id, g.game_ordinal ASC`,
        [testTournamentId]
      );
      expect(games.rows.length).toBe(4);

      // Encounter 1 (t1 vs t4): game 1 (t1 White, t4 Black), game 2 (t4 White, t1 Black)
      const enc1Games = games.rows.filter((g) => g.encounter_id === encs.rows[0].id);
      expect(enc1Games[0].white_team_id).toBe(testTeams[0].id);
      expect(enc1Games[0].black_team_id).toBe(testTeams[3].id);
      expect(enc1Games[1].white_team_id).toBe(testTeams[3].id);
      expect(enc1Games[1].black_team_id).toBe(testTeams[0].id);

      // Helper to submit a decisive win for White
      async function acceptWinForWhite(game: { id: string; white_team_id: string; black_team_id: string }) {
        const evidence = {
          gameId: game.id,
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
          gameId: game.id,
          attemptId: randomUUID(),
          evidence,
          manifestDigest: 'sha256_fixture_manifest',
          mapDescriptor: sampleMap,
        });
      }

      // Complete Encounter 1: Team 1 wins game 1 (as White), and game 2 Team 4 (as White) wins?
      // Let's make Team 1 win both games (in Game 1 White wins, in Game 2 Black wins):
      // For simplicity, let's submit White win for Game 1 (Team 1 wins) and White win for Game 2 (Team 4 wins -> 1-1 tie).
      // Or let's make Team 1 win Game 1 and forfeit Game 2:
      await acceptWinForWhite(enc1Games[0]); // Team 1 wins game 1!

      // Game 2: White (Team 4) forfeits -> winner is Black (Team 1)!
      const game2Evidence = {
        gameId: enc1Games[1].id,
        winner: 2, // Black wins (Team 1)
        reason: 'BOT_TIMEOUT',
        disposition: 'DECISIVE' as const,
        executionStatus: 'BOT_FORFEIT' as const,
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: 1,
        trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } }],
      };
      await resultService.recordResult({
        gameId: enc1Games[1].id,
        attemptId: randomUUID(),
        evidence: game2Evidence,
        manifestDigest: 'sha256_fixture_manifest_2',
        mapDescriptor: sampleMap,
      });

      // Encounter 1 is now COMPLETED with Team 1 as winner!
      const enc1After = await db.query<{ status: string; winner_team_id: string }>(
        'SELECT status, winner_team_id FROM encounters WHERE id = $1',
        [encs.rows[0].id]
      );
      expect(enc1After.rows[0].status).toBe('COMPLETED');
      expect(enc1After.rows[0].winner_team_id).toBe(testTeams[0].id);

      // Complete Encounter 2: Team 2 vs Team 3. Let's make Team 2 win!
      const enc2Games = games.rows.filter((g) => g.encounter_id === encs.rows[1].id);
      await acceptWinForWhite(enc2Games[0]); // Game 1: White (Team 2) wins!
      // Game 2: White (Team 3) forfeits -> Black (Team 2) wins!
      await resultService.recordResult({
        gameId: enc2Games[1].id,
        attemptId: randomUUID(),
        evidence: {
          gameId: enc2Games[1].id,
          winner: 2, // Black (Team 2) wins
          reason: 'BOT_TIMEOUT',
          disposition: 'DECISIVE' as const,
          executionStatus: 'BOT_FORFEIT' as const,
          rulesRevision: 'ArenaGameplay/v2',
          totalPly: 1,
          trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } }],
        },
        manifestDigest: 'sha256_fixture_manifest_enc2',
        mapDescriptor: sampleMap,
      });

      // Both Round 1 encounters completed!
      // Scheduler should have automatically advanced to Round 2 (Finals)!
      const r2Encs = await db.query<{ id: string; team_a_id: string; team_b_id: string }>(
        `SELECT id, team_a_id, team_b_id FROM encounters
         WHERE tournament_id = $1 AND round_ordinal = 2`,
        [testTournamentId]
      );
      expect(r2Encs.rows.length).toBe(1); // 1 encounter in finals
      expect(r2Encs.rows[0].team_a_id).toBe(testTeams[0].id);
      expect(r2Encs.rows[0].team_b_id).toBe(testTeams[1].id); // Team 1 vs Team 2 in Finals!

      // Now complete the 2 games of the Finals!
      const finalGames = await db.query<{ id: string; white_team_id: string; black_team_id: string }>(
        `SELECT id, white_team_id, black_team_id FROM games WHERE encounter_id = $1 ORDER BY game_ordinal ASC`,
        [r2Encs.rows[0].id]
      );
      expect(finalGames.rows.length).toBe(2);

      // Finals Game 1: Team 1 wins as White
      await acceptWinForWhite(finalGames.rows[0]);

      // Finals Game 2: Team 1 wins as Black (White forfeits)
      await resultService.recordResult({
        gameId: finalGames.rows[1].id,
        attemptId: randomUUID(),
        evidence: {
          gameId: finalGames.rows[1].id,
          winner: 2, // Black wins
          reason: 'BOT_TIMEOUT',
          disposition: 'DECISIVE' as const,
          executionStatus: 'BOT_FORFEIT' as const,
          rulesRevision: 'ArenaGameplay/v2',
          totalPly: 1,
          trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } }],
        },
        manifestDigest: 'sha256_final_game_2',
        mapDescriptor: sampleMap,
      });

      // Tournament is complete! State must be PROVISIONAL!
      const tourneyFinal = await db.query<{ state: string }>(
        'SELECT state FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(tourneyFinal.rows[0].state).toBe('PROVISIONAL');

      // Outbox event TOURNAMENT_PROVISIONAL emitted
      const outbox = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'TOURNAMENT_PROVISIONAL' AND payload->>'tournamentId' = $1`,
        [testTournamentId]
      );
      expect(outbox.rows.length).toBe(1);
    });
  });
});
