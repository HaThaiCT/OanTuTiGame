import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { CorrectionService } from '../src/adjudication/correction-service.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { JobBroker } from '../src/jobs/broker.js';
import type { Actor, CommandContext } from '@oantuti/protocol';

/**
 * Disqualification (02-GAMEPLAY §124): an upheld ruling voids every encounter of that team in the
 * stage — no selective results — pauses the tournament, drops the voided encounters' ratings and
 * rebuilds the schedule from the earliest affected round without that team.
 */
describe('S11: disqualification voids a stage and rebuilds descendants', () => {
  let db: PostgresDatabase;
  let corrections: CorrectionService;
  let scheduler: TournamentSchedulerService;
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    tournamentId: randomUUID(),
    playedEncounter: randomUUID(),
    pendingEncounter: randomUUID(),
    heldEncounter: randomUUID(),
  };
  const actor: Actor = {
    userId: ids.userId,
    username: 'dq-admin',
    displayName: 'DQ Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor, requestId: randomUUID() };

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db));
    corrections = new CorrectionService(
      db,
      undefined,
      (tournamentId, stage, roundOrdinal) => scheduler.invalidateAfterRound(tournamentId, stage, roundOrdinal)
    );

    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'DQ Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `dq_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'DQ Course')`, [
      ids.courseId,
      `DQ_${ids.courseId.slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, max_teams)
       VALUES ($1, $2, 'DQ Cup', 'SWISS_PLAYOFF', 'RUNNING', 4)`,
      [ids.tournamentId, ids.courseId]
    );
    for (const [teamId, name] of [
      [ids.teamA, 'DQ Team A'],
      [ids.teamB, 'DQ Team B'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
      await db.query(
        `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
         VALUES ($1, $2, $3, 'DIRECT_ENROLLMENT')`,
        [ids.tournamentId, teamId, ids.userId]
      );
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', 1)`,
        [ids.tournamentId, teamId]
      );
    }

    // Round 1: A already won it. Round 2: A is scheduled again, plus a round-2 encounter between
    // the other two slots that must be cancelled by the rebuild.
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status) VALUES ($1, 'MAIN', 1, 'COMPLETED'), ($1, 'MAIN', 2, 'SEAL_ELIGIBLE')`,
      [ids.tournamentId]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status, winner_team_id, points_a, points_b)
       VALUES ($1, $2, 1, 1, $3, $4, 'COMPLETED', $3, 3, 0)`,
      [ids.playedEncounter, ids.tournamentId, ids.teamA, ids.teamB]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, $2, 2, 1, $3, $4, 'PENDING'), ($5, $2, 2, 2, $4, NULL, 'BYE')`,
      [ids.pendingEncounter, ids.tournamentId, ids.teamA, ids.teamB, ids.heldEncounter]
    );
    await db.query(
      `INSERT INTO rating_events (tournament_id, encounter_id, team_id, epoch, pre_rating, delta, post_rating)
       VALUES ($1, $2, $3, 1, 1200, 16, 1216)`,
      [ids.tournamentId, ids.playedEncounter, ids.teamA]
    );
    await db.query(
      `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, 1, $2, $3, '{}'::jsonb, 'COMPLETED')`,
      [ids.playedEncounter, ids.teamA, ids.teamB]
    );
  });

  afterAll(async () => {
    // Sweep every tournament this fixture created (the walkover case adds its own), then the course.
    const tournaments = await db.query<{ id: string }>('SELECT id FROM tournaments WHERE course_id = $1', [
      ids.courseId,
    ]);
    const tournamentIds = tournaments.rows.map((row) => row.id);
    if (tournamentIds.length > 0) {
      await db.query(
        `DELETE FROM jobs
          WHERE job_type = 'GAME'
            AND target_id IN (SELECT id FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = ANY($1::uuid[])))`,
        [tournamentIds]
      );
      await db.query(`DELETE FROM rating_events WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
      await db.query(
        `DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = ANY($1::uuid[]))`,
        [tournamentIds]
      );
      await db.query(`DELETE FROM encounters WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
      await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
      await db.query(`DELETE FROM standings_snapshots WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
      await db.query(`DELETE FROM tournament_entries WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
      await db.query(`DELETE FROM tournament_admissions WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournamentIds]);
      await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [tournamentIds]);
      await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [tournamentIds]);
    }
    await db.query(`DELETE FROM teams WHERE course_id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await db.close();
  });

  it('requires an administrator and a public reason', async () => {
    const student: Actor = { ...actor, role: 'STUDENT' };
    await expect(
      corrections.disqualifyTeam(ids.tournamentId, ids.teamA, { reason: 'cheating' }, {
        actor: student,
        requestId: randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      corrections.disqualifyTeam(ids.tournamentId, ids.teamA, { reason: '  ' }, ctx)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('voids every stage encounter, pauses the tournament and rebuilds the schedule', async () => {
    const result = await corrections.disqualifyTeam(
      ids.tournamentId,
      ids.teamA,
      { reason: 'Gian lận trong vòng 1 (quyết định đã được duyệt)', stage: 'MAIN' },
      ctx
    );
    expect(result.voidedEncounters).toBe(1);
    expect(result.walkovers).toBe(0);
    expect(result.doubleWithdrawals).toBe(0);
    expect(result.paused).toBe(true);
    expect(result.earliestRound).toBe(1);

    const state = await db.query<{ state: string }>(`SELECT state FROM tournaments WHERE id = $1`, [ids.tournamentId]);
    expect(state.rows[0].state).toBe('PAUSED');

    const entry = await db.query<{ status: string }>(
      `SELECT status FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2`,
      [ids.tournamentId, ids.teamA]
    );
    expect(entry.rows[0].status).toBe('EXCLUDED');

    const encounters = await db.query<{ id: string; status: string; points_a: string; winner_team_id: string | null }>(
      `SELECT id, status, points_a, winner_team_id FROM encounters WHERE id = ANY($1::uuid[])`,
      [[ids.playedEncounter, ids.pendingEncounter, ids.heldEncounter]]
    );
    const byId = new Map(encounters.rows.map((row) => [row.id, row]));
    expect(byId.get(ids.playedEncounter)?.status).toBe('CANCELLED');
    expect(byId.get(ids.playedEncounter)?.points_a).toBe('0.0');
    expect(byId.get(ids.playedEncounter)?.winner_team_id).toBeNull();
    // Round 2 is deleted and re-derived from the reduced field, so its unplayed rows are replaced
    // rather than left behind: a rebuilt slot must hold exactly one row.
    expect(byId.has(ids.pendingEncounter)).toBe(false);
    expect(byId.has(ids.heldEncounter)).toBe(false);

    const ratings = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rating_events WHERE encounter_id = $1`,
      [ids.playedEncounter]
    );
    expect(ratings.rows[0].count).toBe('0');

    const round1 = await db.query<{ status: string }>(
      `SELECT status FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 1`,
      [ids.tournamentId]
    );
    expect(round1.rows[0].status).toBe('SEAL_ELIGIBLE');
    const round2 = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tournament_rounds WHERE tournament_id = $1 AND round_ordinal = 2`,
      [ids.tournamentId]
    );
    expect(round2.rows[0].count).toBe('0');

    const topics = await db.query<{ topic: string }>(
      `SELECT topic FROM outbox_events WHERE payload->>'tournamentId' = $1`,
      [ids.tournamentId]
    );
    const names = topics.rows.map((row) => row.topic);
    expect(names).toContain('TEAM_DISQUALIFIED');
    expect(names).toContain('ENCOUNTERS_VOIDED_BY_DQ');
    expect(names).toContain('TOURNAMENT_PAUSED');

    // A second disqualification of the same team is refused.
    await expect(
      corrections.disqualifyTeam(ids.tournamentId, ids.teamA, { reason: 'again' }, ctx)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('resolves a not-yet-started encounter as a walkover for the active opponent (02 §118)', async () => {
    const walkoverTournamentId = randomUUID();
    const teamC = randomUUID();
    const teamD = randomUUID();
    const pendingEncounter = randomUUID();

    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, max_teams)
       VALUES ($1, $2, 'DQ Walkover Cup', 'SINGLE_ELIMINATION', 'RUNNING', 4)`,
      [walkoverTournamentId, ids.courseId]
    );
    for (const [teamId, name] of [
      [teamC, 'DQ Walkover C'],
      [teamD, 'DQ Walkover D'],
    ] as const) {
      await db.query(
        `INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`,
        [teamId, ids.courseId, name, ids.userId]
      );
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', 1)`,
        [walkoverTournamentId, teamId]
      );
    }
    await db.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status) VALUES ($1, 'MAIN', 1, 'SEAL_ELIGIBLE')`,
      [walkoverTournamentId]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status)
       VALUES ($1, $2, 1, 1, $3, $4, 'PENDING')`,
      [pendingEncounter, walkoverTournamentId, teamC, teamD]
    );
    // A dispatched game is `RUNNING` before any worker claims it, and it already has a queued job:
    // resolving the encounter must withdraw both, or the worker would play a decided game.
    const dispatchedGame = randomUUID();
    await db.query(
      `INSERT INTO games (id, encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, 'RUNNING')`,
      [dispatchedGame, pendingEncounter, teamC, teamD]
    );
    await db.query(`INSERT INTO jobs (job_type, target_id, state) VALUES ('GAME', $1, 'QUEUED')`, [dispatchedGame]);

    // No played encounter for this team, so nothing needs rebuilding: the scheduled encounter is
    // resolved in place instead of being erased.
    const result = await corrections.disqualifyTeam(
      walkoverTournamentId,
      teamC,
      { reason: 'Quyết định loại trực tiếp cho fixture walkover', stage: 'MAIN' },
      ctx
    );
    expect(result.voidedEncounters).toBe(0);
    expect(result.walkovers).toBe(1);
    expect(result.doubleWithdrawals).toBe(0);
    expect(result.earliestRound).toBeNull();

    const encounter = await db.query<{
      status: string;
      winner_team_id: string | null;
      points_a: string;
      points_b: string;
    }>(`SELECT status, winner_team_id, points_a, points_b FROM encounters WHERE id = $1`, [pendingEncounter]);
    expect(encounter.rows[0].status).toBe('WALKOVER');
    expect(encounter.rows[0].winner_team_id).toBe(teamD);
    // Knockout advances the opponent without inventing encounter points.
    expect(encounter.rows[0].points_a).toBe('0.0');
    expect(encounter.rows[0].points_b).toBe('0.0');

    const liveGames = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM games WHERE encounter_id = $1 AND status <> 'CANCELLED'`,
      [pendingEncounter]
    );
    expect(liveGames.rows[0].count).toBe('0');

    const blockedJobs = await db.query<{ state: string }>(
      `SELECT state FROM jobs WHERE job_type = 'GAME' AND target_id = $1`,
      [dispatchedGame]
    );
    expect(blockedJobs.rows[0].state).toBe('BLOCKED');

    const walkoverEvents = await db.query<{ payload: { opponentTeamId: string; disqualifiedTeamId: string } }>(
      `SELECT payload FROM outbox_events
        WHERE topic = 'ENCOUNTER_WALKOVER' AND payload->>'tournamentId' = $1`,
      [walkoverTournamentId]
    );
    expect(walkoverEvents.rows.length).toBe(1);
    expect(walkoverEvents.rows[0].payload.opponentTeamId).toBe(teamD);
    expect(walkoverEvents.rows[0].payload.disqualifiedTeamId).toBe(teamC);
  });
});
