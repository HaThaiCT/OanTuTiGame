import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentSchedulerService, invalidateDownstream } from '../src/tournaments/scheduler-service.js';
import { EliminationFormat } from '../src/tournaments/formats/elimination.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { RoundRobinFormat } from '../src/tournaments/formats/round-robin.js';
import { EloFormat } from '../src/tournaments/formats/elo.js';
import { JobBroker } from '../src/jobs/broker.js';

/**
 * A correction must tear down everything that depended on the corrected encounter and close the
 * disputes attached to invalidated encounters, otherwise an orphaned dispute blocks finalization.
 */
describe('S11: downstream invalidation cancels rounds, games and their disputes', () => {
  let db: PostgresDatabase;
  let scheduler: TournamentSchedulerService;
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    tournamentId: randomUUID(),
    round1Encounter: randomUUID(),
    round2Encounter: randomUUID(),
    round1Game: randomUUID(),
    round2Game: randomUUID(),
    versionId: randomUUID(),
    disputeId: randomUUID(),
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
       VALUES ($1, $2, 'Invalidate Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `inv_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Invalidate Course')`, [
      ids.courseId,
      `INV_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [teamId, name] of [
      [ids.teamA, 'Inv A'],
      [ids.teamB, 'Inv B'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
    }
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, provisional_at)
       VALUES ($1, $2, 'Invalidate Cup', 'ROUND_ROBIN', 'PROVISIONAL', clock_timestamp())`,
      [ids.tournamentId, ids.courseId]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status, winner_team_id, points_a, points_b, stage)
       VALUES ($1, $3, 1, 1, $4, $5, 'COMPLETED', $4, 3, 0, 'MAIN'),
              ($2, $3, 2, 1, $4, $5, 'COMPLETED', $5, 0, 3, 'MAIN')`,
      [ids.round1Encounter, ids.round2Encounter, ids.tournamentId, ids.teamA, ids.teamB]
    );
    await db.query(
      `INSERT INTO games (id, encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, $3, 1, $4, $5, '{}'::jsonb, 'COMPLETED'),
              ($2, $6, 1, $4, $5, '{}'::jsonb, 'COMPLETED')`,
      [ids.round1Game, ids.round2Game, ids.round1Encounter, ids.teamA, ids.teamB, ids.round2Encounter]
    );
    await db.query(
      `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns)
       VALUES ('invalidate-replay', '/tmp/invalidate.oantuti', 1, 1)`
    );
    await db.query(
      `INSERT INTO result_versions (id, game_id, revision, verdict, winner, reason, disposition,
         action_trace_digest, replay_digest, manifest_digest)
       VALUES ($1, $2, 1, 'DECISIVE', 1, 'THRONE_BREACH', 'DECISIVE', 'trace', 'invalidate-replay', 'manifest')`,
      [ids.versionId, ids.round1Game]
    );
    await db.query(`INSERT INTO accepted_results (game_id, result_version_id) VALUES ($1, $2)`, [
      ids.round1Game,
      ids.versionId,
    ]);
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status, sealed_at, seal_eligible_at)
       VALUES ($1, 'MAIN', 1, 'COMPLETED', clock_timestamp(), clock_timestamp()),
              ($1, 'MAIN', 2, 'COMPLETED', clock_timestamp(), clock_timestamp())`,
      [ids.tournamentId]
    );
    await db.query(
      `INSERT INTO disputes (id, tournament_id, encounter_id, team_id, created_by_user_id, status, reason)
       VALUES ($1, $2, $3, $4, $5, 'OPEN', 'kiểm tra ván')`,
      [ids.disputeId, ids.tournamentId, ids.round2Encounter, ids.teamA, ids.userId]
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM disputes WHERE id = $1`, [ids.disputeId]);
    await db.query(`DELETE FROM accepted_results WHERE game_id = $1`, [ids.round1Game]);
    await db.query(`DELETE FROM result_versions WHERE game_id = $1`, [ids.round1Game]);
    await db.query(`DELETE FROM replay_objects WHERE digest = 'invalidate-replay'`);
    await db.query(`DELETE FROM games WHERE id = ANY($1::uuid[])`, [[ids.round1Game, ids.round2Game]]);
    await db.query(`DELETE FROM encounters WHERE id = ANY($1::uuid[])`, [[ids.round1Encounter, ids.round2Encounter]]);
    await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM tournaments WHERE id = $1`, [ids.tournamentId]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[ids.teamA, ids.teamB]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await db.close();
  });

  it('cancels the later round, blocks its game jobs, closes disputes and reopens the tournament', async () => {
    // Production reaches the rebuild through this exact call: the correction service resolves the
    // game's round and runs `invalidateDownstream` inside its own ledger transaction.
    const game = await db.query<{ tournament_id: string; stage: string; round_ordinal: number }>(
      `SELECT e.tournament_id, e.stage, e.round_ordinal
         FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE g.id = $1`,
      [ids.round1Game]
    );
    expect(game.rows).toHaveLength(1);
    const result = await db.withTransaction((client) => invalidateDownstream(client, {
      tournamentId: game.rows[0].tournament_id,
      stage: game.rows[0].stage,
      roundOrdinal: game.rows[0].round_ordinal,
      extraEncounterIds: [],
    }));
    expect(result.cancelledEncounters).toBe(1);

    const encounters = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM encounters WHERE tournament_id = $1 ORDER BY round_ordinal`,
      [ids.tournamentId]
    );
    expect(encounters.rows.find((row) => row.id === ids.round2Encounter)?.status).toBe('CANCELLED');
    expect(encounters.rows.find((row) => row.id === ids.round1Encounter)?.status).toBe('COMPLETED');

    const round = await db.query<{ sealed_at: Date | null; status: string }>(
      `SELECT sealed_at, status FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 1`,
      [ids.tournamentId]
    );
    expect(round.rows[0].sealed_at).toBeNull();
    expect(round.rows[0].status).toBe('SEAL_ELIGIBLE');

    const tournament = await db.query<{ state: string }>(`SELECT state FROM tournaments WHERE id = $1`, [ids.tournamentId]);
    expect(tournament.rows[0].state).toBe('RUNNING');

    const dispute = await db.query<{ status: string; decision: string | null }>(`SELECT status, decision FROM disputes WHERE id = $1`, [
      ids.disputeId,
    ]);
    expect(dispute.rows[0].status).toBe('RESOLVED');
    expect(dispute.rows[0].decision).toBe('INVALIDATED_BY_CORRECTION');

    const outbox = await db.query<{ topic: string }>(
      `SELECT topic FROM outbox_events WHERE payload->>'tournamentId' = $1`,
      [ids.tournamentId]
    );
    expect(outbox.rows.some((row) => row.topic === 'ROUND_INVALIDATED')).toBe(true);
  });

  it('refuses to rebuild rounds of a finalized tournament and mutates nothing', async () => {
    await db.query(
      `UPDATE tournaments SET state = 'FINALIZED', finalized_at = clock_timestamp() WHERE id = $1`,
      [ids.tournamentId]
    );
    const before = await db.query<{ rounds: number; encounters: number }>(
      `SELECT (SELECT count(*) FROM tournament_rounds WHERE tournament_id = $1)::int AS rounds,
              (SELECT count(*) FROM encounters WHERE tournament_id = $1)::int AS encounters`,
      [ids.tournamentId]
    );

    // Only an explicit reopen may lift the immutability of a finalized ledger.
    await expect(scheduler.invalidateAfterRound(ids.tournamentId, 'MAIN', 1)).rejects.toThrow(
      /TOURNAMENT_REOPEN_REQUIRED/
    );

    const after = await db.query<{ rounds: number; encounters: number; state: string }>(
      `SELECT (SELECT count(*) FROM tournament_rounds WHERE tournament_id = $1)::int AS rounds,
              (SELECT count(*) FROM encounters WHERE tournament_id = $1)::int AS encounters,
              (SELECT state FROM tournaments WHERE id = $1) AS state`,
      [ids.tournamentId]
    );
    expect(after.rows[0]).toEqual({ ...before.rows[0], state: 'FINALIZED' });
  });
});
