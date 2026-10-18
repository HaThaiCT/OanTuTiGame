import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { EliminationFormat } from '../src/tournaments/formats/elimination.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { RoundRobinFormat } from '../src/tournaments/formats/round-robin.js';
import { EloFormat } from '../src/tournaments/formats/elo.js';
import { JobBroker } from '../src/jobs/broker.js';

/**
 * A knockout round whose encounters have no winner (all games NO_CONTEST) must not fabricate an
 * advancing team: the tournament becomes PROVISIONAL with an explicit NO_CHAMPION event.
 */
describe('S09: unresolved knockout rounds produce no champion instead of a fabricated one', () => {
  let db: PostgresDatabase;
  let scheduler: TournamentSchedulerService;
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    tournamentId: randomUUID(),
    encounterId: randomUUID(),
  };

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(
      db,
      new JobBroker(db),
      new EliminationFormat(),
      new SwissFormat(),
      new RoundRobinFormat(),
      new EloFormat()
    );
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'No Champion Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `nc_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'No Champion Course')`, [
      ids.courseId,
      `NC_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [teamId, name] of [
      [ids.teamA, 'NC A'],
      [ids.teamB, 'NC B'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
    }
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state) VALUES ($1, $2, 'No Champion Cup', 'SINGLE_ELIMINATION', 'RUNNING')`,
      [ids.tournamentId, ids.courseId]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status, winner_team_id, points_a, points_b, stage)
       VALUES ($1, $2, 1, 1, $3, $4, 'COMPLETED', NULL, 1, 1, 'MAIN')`,
      [ids.encounterId, ids.tournamentId, ids.teamA, ids.teamB]
    );
    await db.query(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, 1, $2, $3, '{"mapName":"nc-map","width":3,"height":3}'::jsonb, 'COMPLETED')`,
      [ids.encounterId, ids.teamA, ids.teamB]
    );
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status, seal_eligible_at)
       VALUES ($1, 'MAIN', 1, 'SEAL_ELIGIBLE', clock_timestamp())`,
      [ids.tournamentId]
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM games WHERE encounter_id = $1`, [ids.encounterId]);
    await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM encounters WHERE id = $1`, [ids.encounterId]);
    await db.query(`DELETE FROM tournaments WHERE id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[ids.teamA, ids.teamB]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await db.close();
  });

  it('seals the round into PROVISIONAL and emits TOURNAMENT_NO_CHAMPION without a next round', async () => {
    const sweep = await scheduler.sealEligibleRounds();
    expect(sweep.sealed).toBeGreaterThanOrEqual(1);

    const tournament = await db.query<{ state: string }>(`SELECT state FROM tournaments WHERE id = $1`, [ids.tournamentId]);
    expect(tournament.rows[0].state).toBe('PROVISIONAL');

    const rounds = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 2`,
      [ids.tournamentId]
    );
    expect(rounds.rows[0].count).toBe('0');

    const outbox = await db.query<{ topic: string }>(`SELECT topic FROM outbox_events WHERE payload->>'tournamentId' = $1`, [
      ids.tournamentId,
    ]);
    expect(outbox.rows.some((row) => row.topic === 'TOURNAMENT_NO_CHAMPION')).toBe(true);
  });
});
