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
import { ResultService } from '../src/results/service.js';

const sampleMap: MapDescriptor = {
  mapName: 'bye-test-map-3x3',
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

/** Odd-sized Swiss fields must persist a BYE encounter (status allowed by migration 014). */
describe('S09: odd-sized Swiss fields persist BYE encounters', () => {
  let db: PostgresDatabase;
  let scheduler: TournamentSchedulerService;
  let resultService: ResultService;
  let tournamentId = '';
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db), new EliminationFormat(), new SwissFormat(), new RoundRobinFormat(), new EloFormat());
    resultService = new ResultService(db, new ReplayStore(), undefined, async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });

    const course = await db.query<{ id: string }>(`INSERT INTO courses (code, name) VALUES ($1, 'Bye Test Course') RETURNING id`, [`BYE_COURSE_${runId}`]);
    const courseId = course.rows[0].id;
    const teamIds: string[] = [];
    for (let index = 1; index <= 5; index++) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`bye_user_${runId}_${index}`, `Bye Captain ${index}`]
      );
      const team = await db.query<{ id: string }>(`INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`, [
        courseId, `Bye Team ${index} ${runId}`, user.rows[0].id,
      ]);
      teamIds.push(team.rows[0].id);
    }
    // Grace 0: the round becomes seal-eligible on its last game and the sweep below advances it.
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes) VALUES ($1, 'Bye Swiss Cup', 'SWISS_PLAYOFF', 'RUNNING', 0) RETURNING id`,
      [courseId]
    );
    tournamentId = tournament.rows[0].id;
    for (const [index, teamId] of teamIds.entries()) {
      await db.query(`INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', $3)`, [
        tournamentId, teamId, index + 1,
      ]);
    }
  });

  afterAll(async () => {
    await db.query('DELETE FROM accepted_results WHERE game_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE e.tournament_id = $1)', [tournamentId]);
    await db.query('DELETE FROM result_versions WHERE game_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE e.tournament_id = $1)', [tournamentId]);
    await db.query('DELETE FROM jobs WHERE target_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE e.tournament_id = $1)', [tournamentId]);
    await db.query('DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1)', [tournamentId]);
    await db.query('DELETE FROM tournament_rounds WHERE tournament_id = $1', [tournamentId]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    await db.close();
  });

  it('creates one BYE encounter without games and still advances the round', async () => {
    await scheduler.scheduleRound1(tournamentId, sampleMap);

    const encounters = await db.query<{ id: string; status: string; team_a_id: string; team_b_id: string | null; winner_team_id: string | null; points_a: string }>(
      `SELECT id, status, team_a_id, team_b_id, winner_team_id, points_a FROM encounters WHERE tournament_id = $1 AND round_ordinal = 1 ORDER BY slot_ordinal`,
      [tournamentId]
    );
    expect(encounters.rows).toHaveLength(3);
    const byes = encounters.rows.filter((row) => row.status === 'BYE');
    expect(byes).toHaveLength(1);
    expect(byes[0].team_b_id).toBeNull();
    expect(byes[0].winner_team_id).toBe(byes[0].team_a_id);
    expect(Number(byes[0].points_a)).toBe(3);

    const byeGames = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM games WHERE encounter_id = $1`, [byes[0].id]);
    expect(byeGames.rows[0].count).toBe('0');

    const realGames = await db.query<{ id: string; encounter_id: string; white_team_id: string }>(
      `SELECT g.id, g.encounter_id, g.white_team_id FROM games g JOIN encounters e ON e.id = g.encounter_id
       WHERE e.tournament_id = $1 AND e.round_ordinal = 1 AND e.status <> 'BYE' ORDER BY g.encounter_id, g.game_ordinal`,
      [tournamentId]
    );
    expect(realGames.rows).toHaveLength(4);

    // Make team A win every game regardless of side, then the round must advance to round 2.
    for (const game of realGames.rows) {
      const rows = await db.query<{ team_a_id: string }>(`SELECT team_a_id FROM encounters WHERE id = $1`, [game.encounter_id]);
      const teamAWonAsWhite = rows.rows[0].team_a_id === game.white_team_id;
      const evidence = teamAWonAsWhite
        ? {
            gameId: game.id,
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
          }
        : {
            gameId: game.id,
            winner: 2,
            reason: 'THRONE_BREACH',
            disposition: 'DECISIVE' as const,
            executionStatus: 'COMPLETED' as const,
            rulesRevision: 'ArenaGameplay/v2',
            totalPly: 4,
            trace: [
              { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
              { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
              { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 1 } } },
              { ply: 4, side: 2, move: { pieceId: 2, targetPos: { x: 0, y: 0 } } },
            ],
          };
      await resultService.recordResult({
        gameId: game.id,
        attemptId: randomUUID(),
        evidence,
        manifestDigest: `sha256_bye_${game.id.slice(0, 8)}`,
        mapDescriptor: sampleMap,
      });
    }

    // The bye plus both real encounters are terminal: sealing round 1 (grace 0) is what
    // generates round 2.
    const sealed = await scheduler.sealEligibleRounds();
    expect(sealed.sealed).toBeGreaterThanOrEqual(1);

    const roundTwo = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM encounters WHERE tournament_id = $1 AND round_ordinal = 2`,
      [tournamentId]
    );
    expect(Number(roundTwo.rows[0].count)).toBeGreaterThan(0);
  });
});
