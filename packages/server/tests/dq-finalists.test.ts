import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';
import { CorrectionService } from '../src/adjudication/correction-service.js';
import { JobBroker } from '../src/jobs/broker.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import { ResultService } from '../src/results/service.js';

/**
 * 02-GAMEPLAY §118/§122/§124 at the level that matters for a title: what happens to the trophy when
 * the final itself is hit by disqualifications.
 *
 *   - both finalists disqualified -> nobody advanced, so the stage ends PROVISIONAL with
 *     TOURNAMENT_NO_CHAMPION and **no** fabricated champion;
 *   - one finalist disqualified  -> the active opponent is not punished for someone else's ruling,
 *     so it advances (walkover) and the title is decided on the field.
 */
const sampleMap: MapDescriptor = {
  mapName: 'dq-final-map-3x3',
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

describe('S11: disqualifications and the title', () => {
  let db: PostgresDatabase;
  let scheduler: TournamentSchedulerService;
  let lifecycle: TournamentLifecycleService;
  let corrections: CorrectionService;
  let resultService: ResultService;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const courseId = randomUUID();
  const adminUserId = randomUUID();
  const createdTournamentIds: string[] = [];
  const adminActor: Actor = {
    userId: adminUserId,
    username: `dq_final_admin_${runId}`,
    displayName: 'DQ Final Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor: adminActor, requestId: randomUUID() };

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db));
    lifecycle = new TournamentLifecycleService(db);
    resultService = new ResultService(db, new ReplayStore(), new TraceVerifier(), async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
    corrections = new CorrectionService(
      db,
      undefined,
      (tournamentId, stage, roundOrdinal) => scheduler.invalidateAfterRound(tournamentId, stage, roundOrdinal)
    );

    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'DQ Final Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [adminUserId, adminActor.username]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'DQ Final Course')`, [
      courseId,
      `DQF_${runId}`,
    ]);
  });

  afterAll(async () => {
    if (createdTournamentIds.length > 0) {
      await db.query(`DELETE FROM rating_events WHERE tournament_id = ANY($1::uuid[])`, [createdTournamentIds]);
      await db.query(
        `DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = ANY($1::uuid[]))`,
        [createdTournamentIds]
      );
      await db.query(`DELETE FROM encounters WHERE tournament_id = ANY($1::uuid[])`, [createdTournamentIds]);
      await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = ANY($1::uuid[])`, [createdTournamentIds]);
      await db.query(`DELETE FROM standings_snapshots WHERE tournament_id = ANY($1::uuid[])`, [createdTournamentIds]);
      await db.query(`DELETE FROM tournament_entries WHERE tournament_id = ANY($1::uuid[])`, [createdTournamentIds]);
      await db.query(`DELETE FROM tournament_admissions WHERE tournament_id = ANY($1::uuid[])`, [createdTournamentIds]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [
        createdTournamentIds,
      ]);
      await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [createdTournamentIds]);
      await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [createdTournamentIds]);
    }
    await db.query(`DELETE FROM teams WHERE course_id = $1`, [courseId]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [adminUserId]);
    await db.close();
  });

  /** Records a decisive win for one side of a scheduled game. */
  async function recordWin(
    game: { id: string; white_team_id: string; black_team_id: string },
    teamId: string,
    tag: string
  ): Promise<void> {
    const side = game.white_team_id === teamId ? 1 : 2;
    await resultService.recordResult({
      gameId: game.id,
      attemptId: randomUUID(),
      evidence: {
        gameId: game.id,
        winner: side,
        reason: side === 1 ? 'THRONE_BREACH' : 'BOT_TIMEOUT',
        disposition: 'DECISIVE' as const,
        executionStatus: side === 1 ? ('COMPLETED' as const) : ('BOT_FORFEIT' as const),
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: 3,
        trace: [
          { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
          { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
          { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } },
        ],
      },
      manifestDigest: `sha256_dq_final_manifest_${tag}`,
      mapDescriptor: sampleMap,
    });
  }

  /**
   * Builds a 4-team single-elimination tournament, plays round 1 to completion and seals it, so the
   * tournament sits in the final round exactly as it would in a live run.
   */
  async function buildFinalFixture(tag: string): Promise<{
    tournamentId: string;
    finalEncounterId: string;
    finalists: readonly string[];
  }> {
    const tournamentRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
       VALUES ($1, $2, 'SINGLE_ELIMINATION', 'RUNNING', 0) RETURNING id`,
      [courseId, `DQ Final ${tag} ${runId}`]
    );
    const tournamentId = tournamentRes.rows[0].id;
    createdTournamentIds.push(tournamentId);

    const teamIds: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const userRes = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`dq_final_${tag}_${runId}_${index}`, `DQ Final ${tag} Captain ${index}`]
      );
      const teamRes = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `DQ Final ${tag} Team ${index} ${runId}`, userRes.rows[0].id]
      );
      teamIds.push(teamRes.rows[0].id);
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal) VALUES ($1, $2, 'ELIGIBLE', $3)`,
        [tournamentId, teamRes.rows[0].id, index]
      );
    }

    await scheduler.scheduleRound1(tournamentId, sampleMap);

    const round1 = await db.query<{ id: string }>(
      `SELECT id FROM encounters WHERE tournament_id = $1 AND round_ordinal = 1 ORDER BY slot_ordinal ASC`,
      [tournamentId]
    );
    expect(round1.rows.length).toBe(2);

    for (const [index, encounter] of round1.rows.entries()) {
      const games = await db.query<{ id: string; white_team_id: string; black_team_id: string }>(
        `SELECT id, white_team_id, black_team_id FROM games WHERE encounter_id = $1 ORDER BY game_ordinal ASC`,
        [encounter.id]
      );
      // The higher seed of each pair sweeps its series, so the final has a known pair of finalists.
      const winner = index === 0 ? teamIds[0] : teamIds[1];
      for (const [gameIndex, game] of games.rows.entries()) {
        await recordWin(game, winner, `${tag}_r1_${index}_${gameIndex}`);
      }
    }

    let sealed = 0;
    for (let sweep = 0; sweep < 3 && sealed === 0; sweep += 1) {
      await scheduler.markTerminalRounds(tournamentId);
      sealed = (await scheduler.sealEligibleRounds()).sealed;
    }
    expect(sealed).toBeGreaterThanOrEqual(1);

    const final = await db.query<{ id: string; team_a_id: string; team_b_id: string | null }>(
      `SELECT id, team_a_id, team_b_id FROM encounters WHERE tournament_id = $1 AND round_ordinal = 2`,
      [tournamentId]
    );
    expect(final.rows.length).toBe(1);
    expect(final.rows[0].team_b_id).not.toBeNull();

    return {
      tournamentId,
      finalEncounterId: final.rows[0].id,
      finalists: [final.rows[0].team_a_id, final.rows[0].team_b_id as string],
    };
  }

  /** Runs the worker's sweep until the tournament stops moving (or the budget runs out). */
  async function driveSweeps(tournamentId: string): Promise<string> {
    let state = '';
    for (let pass = 0; pass < 8; pass += 1) {
      await scheduler.markTerminalRounds(tournamentId);
      await scheduler.sealEligibleRounds();
      const res = await db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [tournamentId]);
      state = res.rows[0].state;
      if (state === 'PROVISIONAL') return state;
    }
    return state;
  }

  it('leaves the title unassigned when both finalists are disqualified', async () => {
    const { tournamentId, finalEncounterId, finalists } = await buildFinalFixture('both');
    const [first, second] = finalists;

    const firstRuling = await corrections.disqualifyTeam(
      tournamentId,
      first,
      { reason: 'Gian lận bị phát hiện trước trận chung kết', stage: 'MAIN' },
      ctx
    );
    expect(firstRuling.paused).toBe(true);
    // The round-1 series this team won is voided; the final it never started is not invented.
    expect(firstRuling.voidedEncounters).toBe(1);
    expect(firstRuling.earliestRound).toBe(1);

    const secondRuling = await corrections.disqualifyTeam(
      tournamentId,
      second,
      { reason: 'Gian lận thứ hai trong cùng chung kết', stage: 'MAIN' },
      ctx
    );
    expect(secondRuling.voidedEncounters).toBeGreaterThanOrEqual(1);

    await lifecycle.resumeTournament(tournamentId, ctx);
    const state = await driveSweeps(tournamentId);
    expect(state).toBe('PROVISIONAL');

    // The final never produced a result, so the rebuilt bracket does not even carry the pairing and
    // nothing anywhere may be recorded as its winner.
    const finalRow = await db.query<{ status: string; winner_team_id: string | null }>(
      `SELECT status, winner_team_id FROM encounters WHERE id = $1`,
      [finalEncounterId]
    );
    expect(finalRow.rows.length).toBe(0);

    const champions = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM encounters
        WHERE tournament_id = $1
          AND winner_team_id IS NOT NULL
          AND round_ordinal = (SELECT max(round_ordinal) FROM encounters WHERE tournament_id = $1)`,
      [tournamentId]
    );
    expect(champions.rows[0].count).toBe('0');

    const noChampion = await db.query<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events
        WHERE topic = 'TOURNAMENT_NO_CHAMPION' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(noChampion.rows.length).toBe(1);
    expect(['EMPTY_FINAL', 'FINAL_NO_CONTEST', 'UNRESOLVED_ENCOUNTER']).toContain(noChampion.rows[0].payload.reason);

    const provisional = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE topic = 'TOURNAMENT_PROVISIONAL' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(provisional.rows[0].count).toBe('1');
  });

  it('advances the surviving finalist when only one finalist is disqualified', async () => {
    const { tournamentId, finalists } = await buildFinalFixture('one');
    const [first] = finalists;

    const ruling = await corrections.disqualifyTeam(
      tournamentId,
      first,
      { reason: 'Gian lận bị phát hiện trước trận chung kết', stage: 'MAIN' },
      ctx
    );
    expect(ruling.paused).toBe(true);

    await lifecycle.resumeTournament(tournamentId, ctx);
    const state = await driveSweeps(tournamentId);
    expect(state).toBe('PROVISIONAL');

    // The opponent is not punished for someone else's ruling: it holds the last round (§118/§122).
    const lastRound = await db.query<{ status: string; winner_team_id: string | null }>(
      `SELECT status, winner_team_id FROM encounters
        WHERE tournament_id = $1
          AND round_ordinal = (SELECT max(round_ordinal) FROM encounters WHERE tournament_id = $1)`,
      [tournamentId]
    );
    // One slot, resolved as an unplayed advance for the team that is still in the tournament.
    expect(lastRound.rows.length).toBe(1);
    expect(lastRound.rows[0].status).toBe('BYE');
    expect(lastRound.rows[0].winner_team_id).toBe(finalists[1]);

    const noChampion = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE topic = 'TOURNAMENT_NO_CHAMPION' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(noChampion.rows[0].count).toBe('0');
  });
});
