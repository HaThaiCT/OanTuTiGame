import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { JobBroker } from '../src/jobs/broker.js';

/**
 * 02-GAMEPLAY §79/§102: when the exact pairing solver cannot finish inside its budget the round is
 * blocked (`BLOCKED_PAIRING`) — it is never sealed with a degraded pairing. The blocker is durable:
 * the round keeps its seal eligibility and a later sweep with a healthy solver seals it normally,
 * which is what proves the failure is a retryable blocker and not a sticky state.
 */
const sampleMap: MapDescriptor = {
  mapName: 'pairing-blocker-map',
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

describe('S09: a pairing failure blocks the round instead of degrading it', () => {
  let db: PostgresDatabase;
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const courseId = randomUUID();
  const tournamentId = randomUUID();

  beforeAll(async () => {
    db = new PostgresDatabase();
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Pairing Blocker Course')`, [
      courseId,
      `BLK_${runId}`,
    ]);
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, grace_period_minutes)
       VALUES ($1, $2, $3, 'SWISS_PLAYOFF', 'RUNNING', 0)`,
      [tournamentId, courseId, `Pairing Blocker Cup ${runId}`]
    );

    const teamIds: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`blk_${index}_${runId}`, `Blocker Captain ${index}`]
      );
      const team = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `Blocker Team ${index} ${runId}`, user.rows[0].id]
      );
      teamIds.push(team.rows[0].id);
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', $3)`,
        [tournamentId, team.rows[0].id, index]
      );
    }

    // Round 1 already played: two decisive encounters, each with its recorded game row (the sweep
    // needs a map descriptor from the stage).
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status) VALUES ($1, 'MAIN', 1, 'RUNNING')`,
      [tournamentId]
    );
    for (let slot = 0; slot < 2; slot += 1) {
      const encounter = await db.query<{ id: string }>(
        `INSERT INTO encounters (tournament_id, stage, round_ordinal, slot_ordinal, team_a_id, team_b_id, status, winner_team_id, points_a, points_b)
         VALUES ($1, 'MAIN', 1, $2, $3, $4, 'COMPLETED', $3, 3, 0) RETURNING id`,
        [tournamentId, slot + 1, teamIds[slot * 2], teamIds[slot * 2 + 1]]
      );
      await db.query(
        `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
         VALUES ($1, 1, $2, $3, $4, 'COMPLETED')`,
        [encounter.rows[0].id, teamIds[slot * 2], teamIds[slot * 2 + 1], sampleMap]
      );
    }

    const scheduler = new TournamentSchedulerService(db, new JobBroker(db));
    await scheduler.markTerminalRounds(tournamentId);
  });

  afterAll(async () => {
    await db.query(
      `DELETE FROM jobs WHERE target_id IN (SELECT id FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1))`,
      [tournamentId]
    );
    await db.query(
      `DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1)`,
      [tournamentId]
    );
    await db.query(`DELETE FROM encounters WHERE tournament_id = $1`, [tournamentId]);
    await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = $1`, [tournamentId]);
    await db.query(`DELETE FROM tournament_entries WHERE tournament_id = $1`, [tournamentId]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [tournamentId]);
    await db.query(`DELETE FROM teams WHERE course_id = $1`, [courseId]);
    await db.query(`DELETE FROM tournaments WHERE id = $1`, [tournamentId]);
    await db.query(`DELETE FROM users WHERE username LIKE $1`, [`blk\\_%\\_${runId}`]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    await db.close();
  });

  it('blocks the seal, leaves the round eligible and recovers on the next healthy sweep', async () => {
    // A solver whose clock jumps past the budget on its first internal check.
    let tick = 0;
    const exhausted = new TournamentSchedulerService(
      db,
      new JobBroker(db),
      undefined,
      new SwissFormat({ budgetMs: 1, now: () => (tick += 10_000) })
    );

    const blockedSweep = await exhausted.sealEligibleRounds();
    expect(blockedSweep.sealed).toBe(0);
    expect(blockedSweep.blocked).toBeGreaterThanOrEqual(1);

    const round1 = await db.query<{ sealed_at: Date | null; seal_eligible_at: Date | null }>(
      `SELECT sealed_at, seal_eligible_at FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 1`,
      [tournamentId]
    );
    expect(round1.rows[0].sealed_at).toBeNull();
    expect(round1.rows[0].seal_eligible_at).not.toBeNull();

    const round2 = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 2`,
      [tournamentId]
    );
    expect(round2.rows[0].count).toBe('0');

    const blocker = await db.query<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events
        WHERE topic = 'ROUND_SEAL_BLOCKED' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(blocker.rows.length).toBe(1);
    expect(blocker.rows[0].payload.reason).toBe('BLOCKED_PAIRING');

    // The blocker is not sticky: a healthy solver seals the same round on the next sweep.
    const healthy = new TournamentSchedulerService(db, new JobBroker(db));
    const healthySweep = await healthy.sealEligibleRounds();
    expect(healthySweep.sealed).toBeGreaterThanOrEqual(1);

    const sealedRound = await db.query<{ sealed_at: Date | null }>(
      `SELECT sealed_at FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 1`,
      [tournamentId]
    );
    expect(sealedRound.rows[0].sealed_at).not.toBeNull();
    const nextRound = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM encounters WHERE tournament_id = $1 AND round_ordinal = 2`,
      [tournamentId]
    );
    expect(Number(nextRound.rows[0].count)).toBeGreaterThan(0);
  });
});
