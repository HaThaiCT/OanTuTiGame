import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import { PostgresDatabase } from '../src/persistence/db.js';
import { EliminationFormat } from '../src/tournaments/formats/elimination.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { RoundRobinFormat } from '../src/tournaments/formats/round-robin.js';
import { EloFormat } from '../src/tournaments/formats/elo.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { JobBroker } from '../src/jobs/broker.js';
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
  /** Tournaments/courses the map-rotation fixtures add, cleaned up when the file ends. */
  const cleanupTournamentIds: string[] = [];
  const cleanupCourseIds: string[] = [];

  beforeAll(async () => {
    db = new PostgresDatabase();
    elimination = new EliminationFormat();
    swiss = new SwissFormat();
    roundRobin = new RoundRobinFormat();
    elo = new EloFormat();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db), elimination, swiss, roundRobin, elo);
    replayStore = new ReplayStore();
    traceVerifier = new TraceVerifier();
    resultService = new ResultService(db, replayStore, traceVerifier, async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
  });

  afterAll(async () => {
    if (cleanupTournamentIds.length > 0) {
      await db.query(
        `DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = ANY($1::uuid[]))`,
        [cleanupTournamentIds]
      );
      await db.query('DELETE FROM encounters WHERE tournament_id = ANY($1::uuid[])', [cleanupTournamentIds]);
      await db.query('DELETE FROM tournament_rounds WHERE tournament_id = ANY($1::uuid[])', [cleanupTournamentIds]);
      await db.query('DELETE FROM tournament_map_pool WHERE tournament_id = ANY($1::uuid[])', [cleanupTournamentIds]);
      await db.query('DELETE FROM tournament_entries WHERE tournament_id = ANY($1::uuid[])', [cleanupTournamentIds]);
      await db.query('DELETE FROM tournaments WHERE id = ANY($1::uuid[])', [cleanupTournamentIds]);
    }
    if (cleanupCourseIds.length > 0) {
      await db.query('DELETE FROM map_versions WHERE map_id IN (SELECT id FROM maps WHERE slug LIKE $1)', [`rotation-%${runId}`]);
      await db.query('DELETE FROM maps WHERE slug LIKE $1', [`rotation-%${runId}`]);
      await db.query('DELETE FROM team_memberships WHERE team_id IN (SELECT id FROM teams WHERE course_id = ANY($1::uuid[]))', [cleanupCourseIds]);
      await db.query('DELETE FROM teams WHERE course_id = ANY($1::uuid[])', [cleanupCourseIds]);
      await db.query(`DELETE FROM users WHERE username LIKE $1`, [`rot\_%\_${runId}`]);
      await db.query('DELETE FROM courses WHERE id = ANY($1::uuid[])', [cleanupCourseIds]);
    }
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

      // Create Tournament. Grace 0: the seal sweep may advance the round on its next call, which
      // is what this end-to-end test drives explicitly below.
      const tourneyRes = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
         VALUES ($1, 'Elimination Championship', 'SINGLE_ELIMINATION', 'RUNNING', 0)
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

      // Knockout encounters play 4 games on the same map with swapped sides (2 in other formats).
      const games = await db.query<{ id: string; encounter_id: string; game_ordinal: number; white_team_id: string; black_team_id: string }>(
        `SELECT g.id, g.encounter_id, g.game_ordinal, g.white_team_id, g.black_team_id
         FROM games g
         JOIN encounters e ON g.encounter_id = e.id
         WHERE e.tournament_id = $1 AND e.round_ordinal = 1
         ORDER BY g.encounter_id, g.game_ordinal ASC`,
        [testTournamentId]
      );
      expect(games.rows.length).toBe(8);

      // Encounter 1 (t1 vs t4): odd games t1 White, even games t4 White.
      const enc1Games = games.rows.filter((g) => g.encounter_id === encs.rows[0].id);
      expect(enc1Games.length).toBe(4);
      expect(enc1Games[0].white_team_id).toBe(testTeams[0].id);
      expect(enc1Games[0].black_team_id).toBe(testTeams[3].id);
      expect(enc1Games[1].white_team_id).toBe(testTeams[3].id);
      expect(enc1Games[1].black_team_id).toBe(testTeams[0].id);
      expect(enc1Games[2].white_team_id).toBe(testTeams[0].id);
      expect(enc1Games[3].white_team_id).toBe(testTeams[3].id);

      /** Records a decisive result for the given side of a scheduled game. */
      async function acceptWinForSide(
        game: { id: string; white_team_id: string; black_team_id: string },
        side: 1 | 2,
        attemptSuffix: string
      ) {
        const whiteSideEvidence = {
          gameId: game.id,
          winner: side,
          reason: 'THRONE_BREACH',
          disposition: 'DECISIVE' as const,
          executionStatus: 'COMPLETED' as const,
          rulesRevision: 'ArenaGameplay/v2',
          totalPly: side === 1 ? 3 : 4,
          trace: [
            { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
            { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
            { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: side === 1 ? 2 : 1 } } },
            ...(side === 1 ? [] : [{ ply: 4, side: 2, move: { pieceId: 2, targetPos: { x: 0, y: 0 } } }]),
          ],
        };
        await resultService.recordResult({
          gameId: game.id,
          attemptId: randomUUID(),
          evidence: whiteSideEvidence,
          manifestDigest: `sha256_fixture_manifest_${attemptSuffix}`,
          mapDescriptor: sampleMap,
        });
      }

      /** Makes teamA win every game of the encounter regardless of side. */
      async function sweepEncounter(
        encounterGames: readonly { id: string; white_team_id: string; black_team_id: string }[],
        teamAId: string,
        tag: string
      ) {
        for (const [index, game] of encounterGames.entries()) {
          const side = game.white_team_id === teamAId ? 1 : 2;
          await acceptWinForSide(game, side, `${tag}_${index}`);
        }
      }

      // Complete Encounter 1: Team 1 wins all four games regardless of side.
      await sweepEncounter(enc1Games, testTeams[0].id, 'enc1');

      // Encounter 1 is now COMPLETED with Team 1 as winner!
      const enc1After = await db.query<{ status: string; winner_team_id: string }>(
        'SELECT status, winner_team_id FROM encounters WHERE id = $1',
        [encs.rows[0].id]
      );
      expect(enc1After.rows[0].status).toBe('COMPLETED');
      expect(enc1After.rows[0].winner_team_id).toBe(testTeams[0].id);

      // Complete Encounter 2: Team 2 vs Team 3; Team 2 wins all four games.
      const enc2Games = games.rows.filter((g) => g.encounter_id === encs.rows[1].id);
      await sweepEncounter(enc2Games, testTeams[1].id, 'enc2');

      // Both Round 1 encounters are terminal. With a grace window the round only becomes
      // *eligible* to seal — nothing advances until the sweep runs.
      const round1 = await db.query<{ status: string; sealed_at: Date | null; seal_eligible_at: Date | null }>(
        `SELECT status, sealed_at, seal_eligible_at FROM tournament_rounds
         WHERE tournament_id = $1 AND stage = 'MAIN' AND round_ordinal = 1`,
        [testTournamentId]
      );
      expect(round1.rows[0].status).toBe('SEAL_ELIGIBLE');
      expect(round1.rows[0].sealed_at).toBeNull();
      expect(round1.rows[0].seal_eligible_at).not.toBeNull();

      // The worker's sweep seals it (grace 0 has elapsed) and generates Round 2 (Finals).
      const swept = await scheduler.sealEligibleRounds();
      expect(swept.sealed).toBeGreaterThanOrEqual(1);

      const sealedRound1 = await db.query<{ status: string; sealed_at: Date | null }>(
        `SELECT status, sealed_at FROM tournament_rounds
         WHERE tournament_id = $1 AND stage = 'MAIN' AND round_ordinal = 1`,
        [testTournamentId]
      );
      expect(sealedRound1.rows[0].status).toBe('COMPLETED');
      expect(sealedRound1.rows[0].sealed_at).not.toBeNull();

      // Scheduler has now advanced to Round 2 (Finals)!
      const r2Encs = await db.query<{ id: string; team_a_id: string; team_b_id: string }>(
        `SELECT id, team_a_id, team_b_id FROM encounters
         WHERE tournament_id = $1 AND round_ordinal = 2`,
        [testTournamentId]
      );
      expect(r2Encs.rows.length).toBe(1); // 1 encounter in finals
      expect(r2Encs.rows[0].team_a_id).toBe(testTeams[0].id);
      expect(r2Encs.rows[0].team_b_id).toBe(testTeams[1].id); // Team 1 vs Team 2 in Finals!

      // Now complete the 4 games of the Finals; Team 1 wins every game.
      const finalGames = await db.query<{ id: string; white_team_id: string; black_team_id: string }>(
        `SELECT id, white_team_id, black_team_id FROM games WHERE encounter_id = $1 ORDER BY game_ordinal ASC`,
        [r2Encs.rows[0].id]
      );
      expect(finalGames.rows.length).toBe(4);

      await sweepEncounter(finalGames.rows, testTeams[0].id, 'final');

      // The final is over: sealing it (grace 0) is what parks the tournament as PROVISIONAL.
      const finalSwept = await scheduler.sealEligibleRounds();
      expect(finalSwept.sealed).toBeGreaterThanOrEqual(1);

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

  describe('6. Knockout series rotates the frozen map pool', () => {
    /** Builds a 2-team knockout tournament plus a pool of `mapCount` maps pinned at version 1. */
    async function buildPoolFixture(mapCount: number): Promise<{ tournamentId: string; names: string[] }> {
      const course = await db.query<{ id: string }>(
        `INSERT INTO courses (code, name) VALUES ($1, 'Rotation Course') RETURNING id`,
        [`ROT_${runId}_${mapCount}`]
      );
      const courseId = course.rows[0].id;
      const tournament = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
         VALUES ($1, $2, 'SINGLE_ELIMINATION', 'RUNNING', 0) RETURNING id`,
        [courseId, `Rotation Cup ${mapCount} ${runId}`]
      );
      const tournamentId = tournament.rows[0].id;

      const names: string[] = [];
      for (let index = 1; index <= 2; index += 1) {
        const user = await db.query<{ id: string }>(
          `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
           VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
          [`rot_${mapCount}_${index}_${runId}`, `Rotation Captain ${index}`]
        );
        const team = await db.query<{ id: string }>(
          `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
          [courseId, `Rotation Team ${mapCount}_${index} ${runId}`, user.rows[0].id]
        );
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', $3)`,
          [tournamentId, team.rows[0].id, index]
        );
      }

      for (let index = 1; index <= mapCount; index += 1) {
        const descriptor = { ...sampleMap, mapName: `rotation-${mapCount}-${index}-${runId}` };
        const map = await db.query<{ id: string }>(
          `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings, current_version)
           VALUES ($1, $2, $3, 'PUBLIC', '[]'::jsonb, 1) RETURNING id`,
          [descriptor.mapName, `Rotation Map ${index}`, JSON.stringify(descriptor)]
        );
        await db.query(
          `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings) VALUES ($1, 1, $2, '[]'::jsonb)`,
          [map.rows[0].id, JSON.stringify(descriptor)]
        );
        await db.query(
          `INSERT INTO tournament_map_pool (tournament_id, map_id, map_version) VALUES ($1, $2, 1)`,
          [tournamentId, map.rows[0].id]
        );
        names.push(descriptor.mapName);
      }

      cleanupTournamentIds.push(tournamentId);
      cleanupCourseIds.push(courseId);
      return { tournamentId, names };
    }

    it('gives the four games of a series four distinct map versions from the pool', async () => {
      const { tournamentId, names } = await buildPoolFixture(4);
      await scheduler.scheduleRound1(tournamentId, { ...sampleMap, mapName: 'caller-map' });

      const games = await db.query<{ map_name: string }>(
        `SELECT g.map_descriptor->>'mapName' AS map_name
           FROM games g JOIN encounters e ON e.id = g.encounter_id
          WHERE e.tournament_id = $1 ORDER BY g.game_ordinal ASC`,
        [tournamentId]
      );
      expect(games.rows.map((row) => row.map_name)).toEqual(names);
      expect(new Set(games.rows.map((row) => row.map_name)).size).toBe(4);
    });

    it('keeps the caller map for the whole series when the tournament has no pool', async () => {
      const { tournamentId } = await buildPoolFixture(0);
      await scheduler.scheduleRound1(tournamentId, { ...sampleMap, mapName: `single-map-${runId}` });

      const games = await db.query<{ map_name: string }>(
        `SELECT g.map_descriptor->>'mapName' AS map_name
           FROM games g JOIN encounters e ON e.id = g.encounter_id
          WHERE e.tournament_id = $1`,
        [tournamentId]
      );
      expect(games.rows.length).toBe(4);
      for (const row of games.rows) expect(row.map_name).toBe(`single-map-${runId}`);
    });
  });

  describe('7. Swiss → playoff and Elo arenas reach PROVISIONAL on their own', () => {
    /** 4-team fixture for one format: course, teams, entries and the round-1 schedule. */
    async function buildFormatFixture(format: 'SWISS_PLAYOFF' | 'ELO_ARENA'): Promise<{ tournamentId: string; teams: string[] }> {
      const course = await db.query<{ id: string }>(
        `INSERT INTO courses (code, name) VALUES ($1, $2) RETURNING id`,
        [`${format}_${runId}`, `${format} Course`]
      );
      const courseId = course.rows[0].id;
      cleanupCourseIds.push(courseId);

      const tournament = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
         VALUES ($1, $2, $3, 'RUNNING', 0) RETURNING id`,
        [courseId, `${format} Cup ${runId}`, format]
      );
      const tournamentId = tournament.rows[0].id;
      cleanupTournamentIds.push(tournamentId);

      const teams: string[] = [];
      for (let index = 1; index <= 4; index += 1) {
        const user = await db.query<{ id: string }>(
          `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
           VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
          [`${format.toLowerCase()}_${index}_${runId}`, `${format} Captain ${index}`]
        );
        const team = await db.query<{ id: string }>(
          `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
          [courseId, `${format} Team ${index} ${runId}`, user.rows[0].id]
        );
        teams.push(team.rows[0].id);
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', $3)`,
          [tournamentId, team.rows[0].id, index]
        );
      }

      await scheduler.scheduleRound1(tournamentId, { ...sampleMap, mapName: `${format}-board-${runId}` });
      return { tournamentId, teams };
    }

    /** Records a decisive win on the side of `winnerTeamId`. */
    async function recordWin(
      game: { id: string; white_team_id: string; black_team_id: string },
      winnerTeamId: string,
      tag: string
    ): Promise<void> {
      const side = game.white_team_id === winnerTeamId ? 1 : 2;
      await resultService.recordResult({
        gameId: game.id,
        attemptId: randomUUID(),
        evidence: {
          gameId: game.id,
          winner: side,
          reason: 'THRONE_BREACH',
          disposition: 'DECISIVE' as const,
          executionStatus: 'COMPLETED' as const,
          rulesRevision: 'ArenaGameplay/v2',
          totalPly: side === 1 ? 3 : 4,
          trace: [
            { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
            { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
            { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: side === 1 ? 2 : 1 } } },
            ...(side === 1 ? [] : [{ ply: 4, side: 2, move: { pieceId: 2, targetPos: { x: 0, y: 0 } } }]),
          ],
        },
        manifestDigest: `sha256_${tag}_manifest`,
        mapDescriptor: sampleMap,
      });
    }

    /**
     * Plays every runnable game, seals whatever round is terminally finished, and repeats until the
     * tournament parks itself in PROVISIONAL — the same loop the durable worker runs in production.
     */
    async function driveToProvisional(tournamentId: string, winnerIndex: number): Promise<string> {
      let state = '';
      for (let pass = 0; pass < 80; pass += 1) {
        const pending = await db.query<{
          id: string;
          white_team_id: string;
          black_team_id: string;
          team_a_id: string;
          team_b_id: string | null;
        }>(
          `SELECT g.id, g.white_team_id, g.black_team_id, e.team_a_id, e.team_b_id
             FROM games g JOIN encounters e ON e.id = g.encounter_id
            WHERE e.tournament_id = $1 AND g.status = 'RUNNING'
            ORDER BY e.round_ordinal ASC, e.slot_ordinal ASC, g.game_ordinal ASC`,
          [tournamentId]
        );
        if (pending.rows.length > 0) {
          for (const [index, game] of pending.rows.entries()) {
            const sides = [game.team_a_id, game.team_b_id].filter((teamId): teamId is string => Boolean(teamId));
            const winner = sides.length > 1 ? sides[winnerIndex % sides.length] : sides[0];
            await recordWin(game, winner, `${tournamentId.slice(0, 6)}_${pass}_${index}`);
          }
          continue;
        }
        await scheduler.markTerminalRounds(tournamentId);
        const swept = await scheduler.sealEligibleRounds();
        state = (
          await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [tournamentId])
        ).rows[0].state;
        if (state === 'PROVISIONAL') return state;
        if (swept.sealed === 0 && swept.blocked === 0) break;
      }
      return state;
    }

    it('runs Swiss rounds, auto-qualifies the cut-off into the playoff and crowns a finalist', async () => {
      const { tournamentId } = await buildFormatFixture('SWISS_PLAYOFF');

      expect(await driveToProvisional(tournamentId, 0)).toBe('PROVISIONAL');

      // R = min(ceil(log2 4), 3) = 2 Swiss rounds, and the playoff stage is created automatically:
      // the Swiss standings feed it without a second admin start.
      const swissRounds = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tournament_rounds WHERE tournament_id = $1 AND stage <> 'PLAYOFF'`,
        [tournamentId]
      );
      expect(swissRounds.rows[0].count).toBe('2');
      const playoffRounds = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tournament_rounds WHERE tournament_id = $1 AND stage = 'PLAYOFF'`,
        [tournamentId]
      );
      expect(Number(playoffRounds.rows[0].count)).toBeGreaterThan(0);

      const finalEncounter = await db.query<{ winner_team_id: string | null }>(
        `SELECT winner_team_id FROM encounters
          WHERE tournament_id = $1 AND stage = 'PLAYOFF'
          ORDER BY round_ordinal DESC, slot_ordinal DESC LIMIT 1`,
        [tournamentId]
      );
      expect(finalEncounter.rows[0].winner_team_id).not.toBeNull();

      const started = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbox_events
          WHERE topic = 'TOURNAMENT_PROVISIONAL' AND payload->>'tournamentId' = $1`,
        [tournamentId]
      );
      expect(started.rows[0].count).toBe('1');
    });

    it('runs the full Elo epoch count and parks the arena in PROVISIONAL', async () => {
      const { tournamentId } = await buildFormatFixture('ELO_ARENA');

      expect(await driveToProvisional(tournamentId, 0)).toBe('PROVISIONAL');

      // E = max(8, 4·ceil(log2 4)) = 8 epochs, each one a round with its own pairings.
      const epochs = await db.query<{ count: string }>(
        `SELECT count(DISTINCT round_ordinal)::text AS count FROM encounters WHERE tournament_id = $1`,
        [tournamentId]
      );
      expect(epochs.rows[0].count).toBe('8');

      const rated = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM rating_events WHERE tournament_id = $1`,
        [tournamentId]
      );
      expect(Number(rated.rows[0].count)).toBeGreaterThan(0);
    });
  });
});
