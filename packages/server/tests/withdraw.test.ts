import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { JobBroker } from '../src/jobs/broker.js';
import type { Actor, CommandContext } from '@oantuti/protocol';

/**
 * Withdrawal policy (02-GAMEPLAY §118/§124/§126): before the start the entry just leaves the
 * field; once a round is scheduled, not-yet-started encounters become unplayed results instead of
 * fabricated scores — WALKOVER for an active opponent (Swiss/RR 3 points, knockout advance, no
 * game, no rating), DOUBLE_WITHDRAWAL when both sides are gone.
 */
describe('S09: team withdrawal with walkover resolution', () => {
  let db: PostgresDatabase;
  let admission: TournamentAdmissionService;
  let scheduler: TournamentSchedulerService;
  const resolvedFor: string[] = [];
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    preStartTournament: randomUUID(),
    liveTournament: randomUUID(),
    encounterId: randomUUID(),
    dispatchedTournament: randomUUID(),
    dispatchedEncounter: randomUUID(),
  };
  const actor: Actor = {
    userId: ids.userId,
    username: 'withdraw-admin',
    displayName: 'Withdraw Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor, requestId: randomUUID() };

  beforeAll(async () => {
    db = new PostgresDatabase();
    admission = new TournamentAdmissionService(db, async (tournamentId) => {
      resolvedFor.push(tournamentId);
      await scheduler.markTerminalRounds(tournamentId);
    });
    scheduler = new TournamentSchedulerService(db, new JobBroker(db));

    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'Withdraw Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `wd_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Withdraw Course')`, [
      ids.courseId,
      `WD_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [teamId, name] of [
      [ids.teamA, 'Withdraw Team A'],
      [ids.teamB, 'Withdraw Team B'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
    }
    for (const [tournamentId, state, name] of [
      [ids.preStartTournament, 'REGISTRATION_OPEN', 'Pre-start Cup'],
      [ids.liveTournament, 'RUNNING', 'Live Cup'],
    ] as const) {
      await db.query(
        `INSERT INTO tournaments (id, course_id, name, format, state, max_teams) VALUES ($1, $2, $3, 'SWISS_PLAYOFF', $4, 4)`,
        [tournamentId, ids.courseId, name, state]
      );
    }
    for (const tournamentId of [ids.preStartTournament, ids.liveTournament]) {
      for (const teamId of [ids.teamA, ids.teamB]) {
        await db.query(
          `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
           VALUES ($1, $2, $3, 'DIRECT_ENROLLMENT')`,
          [tournamentId, teamId, ids.userId]
        );
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', 1)`,
          [tournamentId, teamId]
        );
      }
    }

    // One scheduled round whose encounter has not started yet: two PENDING games.
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status) VALUES ($1, 'MAIN', 1, 'PENDING')`,
      [ids.liveTournament]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, $2, 1, 1, $3, $4, 'PENDING')`,
      [ids.encounterId, ids.liveTournament, ids.teamA, ids.teamB]
    );
    for (const [ordinal, white, black] of [
      [1, ids.teamA, ids.teamB],
      [2, ids.teamB, ids.teamA],
    ] as const) {
      await db.query(
        `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'PENDING')`,
        [ids.encounterId, ordinal, white, black]
      );
    }

    // A dispatched encounter: the scheduler inserts games as `RUNNING` before any worker claims
    // one, with a GAME job already queued.
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, max_teams)
       VALUES ($1, $2, 'Dispatched Cup', 'SINGLE_ELIMINATION', 'RUNNING', 4)`,
      [ids.dispatchedTournament, ids.courseId]
    );
    for (const teamId of [ids.teamA, ids.teamB]) {
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', 1)`,
        [ids.dispatchedTournament, teamId]
      );
    }
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status) VALUES ($1, 'MAIN', 1, 'PENDING')`,
      [ids.dispatchedTournament]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, $2, 1, 1, $3, $4, 'RUNNING')`,
      [ids.dispatchedEncounter, ids.dispatchedTournament, ids.teamA, ids.teamB]
    );
    for (const [ordinal, white, black] of [
      [1, ids.teamA, ids.teamB],
      [2, ids.teamB, ids.teamA],
    ] as const) {
      const game = await db.query<{ id: string }>(
        `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'RUNNING') RETURNING id`,
        [ids.dispatchedEncounter, ordinal, white, black]
      );
      await db.query(`INSERT INTO jobs (job_type, target_id, state) VALUES ('GAME', $1, 'QUEUED')`, [
        game.rows[0].id,
      ]);
    }
  });

  afterAll(async () => {
    for (const tournamentId of [ids.preStartTournament, ids.liveTournament, ids.dispatchedTournament]) {
      await db.query(
        `DELETE FROM jobs
          WHERE job_type = 'GAME'
            AND target_id IN (SELECT id FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1))`,
        [tournamentId]
      );
      await db.query(`DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1)`, [tournamentId]);
      await db.query(`DELETE FROM encounters WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_entries WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_admissions WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [tournamentId]);
      await db.query(`DELETE FROM audit_events WHERE resource_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM tournaments WHERE id = $1`, [tournamentId]);
    }
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[ids.teamA, ids.teamB]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await db.close();
  });

  it('leaves the field without resolving encounters before the start', async () => {
    const result = await admission.withdrawTeam(ids.preStartTournament, ids.teamA, 'chấn thương', ctx);
    expect(result).toMatchObject({ status: 'EXCLUDED', walkovers: 0, doubleWithdrawals: 0 });
    const entry = await db.query<{ status: string }>(
      `SELECT status FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2`,
      [ids.preStartTournament, ids.teamA]
    );
    expect(entry.rows[0].status).toBe('EXCLUDED');
    expect(resolvedFor).not.toContain(ids.preStartTournament);
  });

  it('resolves a not-yet-started encounter as a walkover and unblocks the round', async () => {
    const result = await admission.withdrawTeam(ids.liveTournament, ids.teamA, 'bỏ giải', ctx);
    expect(result).toMatchObject({ status: 'EXCLUDED', walkovers: 1, doubleWithdrawals: 0 });

    const encounter = await db.query<{
      status: string;
      winner_team_id: string | null;
      points_a: string;
      points_b: string;
    }>(`SELECT status, winner_team_id, points_a, points_b FROM encounters WHERE id = $1`, [ids.encounterId]);
    expect(encounter.rows[0].status).toBe('WALKOVER');
    expect(encounter.rows[0].winner_team_id).toBe(ids.teamB);
    expect(encounter.rows[0].points_a).toBe('0.0');
    expect(encounter.rows[0].points_b).toBe('3.0');

    const cancelled = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM games WHERE encounter_id = $1 AND status = 'CANCELLED'`,
      [ids.encounterId]
    );
    expect(cancelled.rows[0].count).toBe('2');

    const outbox = await db.query<{ topic: string }>(
      `SELECT topic FROM outbox_events WHERE payload->>'tournamentId' = $1`,
      [ids.liveTournament]
    );
    const topics = outbox.rows.map((row) => row.topic);
    expect(topics).toContain('ENCOUNTER_WALKOVER');
    expect(topics).toContain('TEAM_WITHDRAWN');

    // The callback runs the terminal-round sweep: the round reaches SEAL_ELIGIBLE even though no
    // game ever completed.
    expect(resolvedFor).toContain(ids.liveTournament);
    const round = await db.query<{ status: string }>(
      `SELECT status FROM tournament_rounds WHERE tournament_id = $1 AND stage = 'MAIN' AND round_ordinal = 1`,
      [ids.liveTournament]
    );
    expect(round.rows[0].status).toBe('SEAL_ELIGIBLE');

    // A second withdrawal for the same team is refused.
    await expect(admission.withdrawTeam(ids.liveTournament, ids.teamA, 'again', ctx)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('resolves a dispatched encounter (RUNNING, unclaimed) as a walkover and stops its job', async () => {
    const result = await admission.withdrawTeam(ids.dispatchedTournament, ids.teamA, 'bỏ giải muộn', ctx);
    expect(result).toMatchObject({ status: 'EXCLUDED', walkovers: 1, doubleWithdrawals: 0 });

    const encounter = await db.query<{ status: string; winner_team_id: string | null }>(
      `SELECT status, winner_team_id FROM encounters WHERE id = $1`,
      [ids.dispatchedEncounter]
    );
    expect(encounter.rows[0].status).toBe('WALKOVER');
    expect(encounter.rows[0].winner_team_id).toBe(ids.teamB);

    // Nothing may still be playable for a decided encounter: games cancelled, jobs blocked.
    const liveGames = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM games WHERE encounter_id = $1 AND status <> 'CANCELLED'`,
      [ids.dispatchedEncounter]
    );
    expect(liveGames.rows[0].count).toBe('0');

    const activeJobs = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs
        WHERE job_type = 'GAME'
          AND target_id IN (SELECT id FROM games WHERE encounter_id = $1)
          AND state <> 'BLOCKED'`,
      [ids.dispatchedEncounter]
    );
    expect(activeJobs.rows[0].count).toBe('0');
  });
});
