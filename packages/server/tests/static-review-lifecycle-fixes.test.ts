/**
 * Static review 2026-10-27 L-fix regression tests (fix ledger
 * docs/qa/static-review-findings-2026-10-27.md).
 *
 * L1  Swiss/RR standings keep sealed completed results counting when the other side later
 *     withdrew; ineligible teams stay off the ranked board and do not gain administrative
 *     (walkover) points.
 * L2  recordResult refuses results for administratively resolved games/encounters (CANCELLED /
 *     WALKOVER / DOUBLE_WITHDRAWAL) instead of seeding/committing an overwrite; and a late
 *     handleGameCompletion must not overwrite a ruled encounter (conditional encounter UPDATE).
 * L4  Control-plane result-outbox loop is per-event resilient: one malformed or failing event
 *     may not stall the pipeline; retries are bounded by a payload-stamped attempt counter.
 * L6  Public listing shows PUBLIC maps even when no map_versions row was ever revealed
 *     (same content getMap serves), keeps newest-revealed for HIDDEN.
 * L7  Locking during a pending-completion drain leaves the tournament state untouched (the
 *     drain hand-off belongs to the deadline sweeps; the old dead write is gone).
 * L8  extendRegistration bumps the aggregate version and decides cutoff races on the DB clock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ResultService, ResultRejectedError } from '../src/results/service.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { JobBroker } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';
import { TournamentControlPlane } from '../src/tournaments/control-plane.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';
import { MapService } from '../src/tournaments/map-service.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { RoundRobinFormat } from '../src/tournaments/formats/round-robin.js';
import { RetentionService } from '../src/operations/retention-service.js';
import type { CompletedEncounterRecord, TeamEntry } from '../src/tournaments/formats/types.js';

const sampleMap: MapDescriptor = {
  mapName: 'lfix-map-3x3',
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

const completed = (
  encounterId: string,
  roundOrdinal: number,
  teamAId: string,
  teamBId: string,
  winnerTeamId: string,
  pointsA: number,
  pointsB: number
): CompletedEncounterRecord => ({
  encounterId,
  roundOrdinal,
  status: 'COMPLETED',
  teamAId,
  teamBId,
  winnerTeamId,
  pointsA,
  pointsB,
});

const walkover = (
  encounterId: string,
  roundOrdinal: number,
  teamAId: string,
  teamBId: string,
  winnerTeamId: string,
  pointsA: number,
  pointsB: number
): CompletedEncounterRecord => ({
  encounterId,
  roundOrdinal,
  status: 'WALKOVER',
  teamAId,
  teamBId,
  winnerTeamId,
  pointsA,
  pointsB,
});

describe('static review L-fixes (lifecycle slice)', () => {
  let db: PostgresDatabase;
  let scheduler: TournamentSchedulerService;
  let resultService: ResultService;
  let lifecycle: TournamentLifecycleService;
  let mapService: MapService;
  let courseId = '';
  let adminUserId = '';
  let adminActor: Actor;
  const createdTournamentIds: string[] = [];
  const createdMapSlugs: string[] = [];
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`.replace(/\W/g, '_');

  /** 4-team RUNNING knockout with round 1 dispatched. */
  async function createRunningKnockout(format: 'SINGLE_ELIMINATION' | 'ROUND_ROBIN' = 'SINGLE_ELIMINATION') {
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
       VALUES ($1, $2, $3, 'RUNNING', 60)
       RETURNING id`,
      [courseId, `LFix ${runId} ${format} ${createdTournamentIds.length}`, format]
    );
    const tournamentId = tournament.rows[0].id;
    createdTournamentIds.push(tournamentId);

    const teamIds: string[] = [];
    for (let index = 1; index <= 4; index++) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`lfix_user_${runId}_${createdTournamentIds.length}_${index}`, `LFix Captain ${index}`]
      );
      const team = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `LFix Team ${createdTournamentIds.length}-${index}`, user.rows[0].id]
      );
      teamIds.push(team.rows[0].id);
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal)
         VALUES ($1, $2, 'ELIGIBLE', $3)`,
        [tournamentId, team.rows[0].id, index]
      );
    }

    await scheduler.scheduleRound1(tournamentId, sampleMap);
    const rounds = await db.query<{ ordinal: number }>(
      `SELECT round_ordinal AS ordinal FROM tournament_rounds WHERE tournament_id = $1 ORDER BY round_ordinal`,
      [tournamentId]
    );
    expect(rounds.rows.length).toBeGreaterThan(0);
    return { tournamentId, teamIds };
  }

  interface ScoredGameEvidenceWork {
    readonly gameId: string;
    readonly whiteIsTeamA: boolean;
  }

  async function gameRefsForEncounter(encounterId: string): Promise<{ id: string; white_team_id: string; black_team_id: string; team_a_id: string }[]> {
    const res = await db.query<{ id: string; white_team_id: string; black_team_id: string; team_a_id: string }>(
      `SELECT g.id, g.white_team_id, g.black_team_id, e.team_a_id
       FROM games g JOIN encounters e ON e.id = g.encounter_id
       WHERE g.encounter_id = $1 ORDER BY g.game_ordinal ASC`,
      [encounterId]
    );
    return res.rows;
  }

  async function winGame(game: { id: string; white_team_id: string; black_team_id: string; team_a_id: string }, winnerTeamId: string, tag: string): Promise<ScoredGameEvidenceWork> {
    const whiteWon = game.white_team_id === winnerTeamId;
    await resultService.recordResult({
      gameId: game.id,
      attemptId: randomUUID(),
      evidence: {
        gameId: game.id,
        winner: whiteWon ? 1 : 2,
        reason: 'THRONE_BREACH',
        disposition: 'DECISIVE' as const,
        executionStatus: 'COMPLETED' as const,
        rulesRevision: 'ArenaGameplay/v2',
        totalPly: whiteWon ? 3 : 4,
        trace: [
          { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
          { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
          { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: whiteWon ? 2 : 1 } } },
          ...(whiteWon ? [] : [{ ply: 4, side: 2, move: { pieceId: 2, targetPos: { x: 0, y: 0 } } }]),
        ],
      },
      manifestDigest: `sha256_lfix_${tag}`,
      mapDescriptor: sampleMap,
    });
    return { gameId: game.id, whiteIsTeamA: game.white_team_id === game.team_a_id };
  }

  /** Plays every game of an encounter for `winnerTeamId` (an encounter ends only when all its games did). */
  async function winAllEncounterGames(encounterId: string, winnerTeamId: string, tag: string): Promise<void> {
    for (const game of await gameRefsForEncounter(encounterId)) {
      await winGame(game, winnerTeamId, `${tag}_${game.id.slice(0, 8)}`);
    }
  }

  /** Mirrors the withdrawal resolution writes withdrawTeam performs for one unstarted encounter. */
  async function applyWithdrawalRuling(encounterId: string, opponentTeamId: string | null, walkover: boolean): Promise<void> {
    if (walkover) {
      await db.query(
        `UPDATE encounters SET status = 'WALKOVER', winner_team_id = $2, points_a = 3, points_b = 0 WHERE id = $1`,
        [encounterId, opponentTeamId]
      );
    } else {
      await db.query(
        `UPDATE encounters SET status = 'DOUBLE_WITHDRAWAL', winner_team_id = NULL, points_a = 0, points_b = 0 WHERE id = $1`,
        [encounterId]
      );
    }
    await db.query(`UPDATE games SET status = 'CANCELLED' WHERE encounter_id = $1 AND status <> 'COMPLETED'`, [encounterId]);
    await db.query(
      `UPDATE jobs SET state = 'BLOCKED', updated_at = clock_timestamp()
       WHERE job_type = 'GAME'
         AND target_id IN (SELECT id FROM games WHERE encounter_id = $1)
         AND state IN ('QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING', 'RETRY_WAIT')`,
      [encounterId]
    );
    await db.query(`DELETE FROM rating_events WHERE encounter_id = $1`, [encounterId]);
    await db.query(
      `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
      [
        walkover ? 'ENCOUNTER_WALKOVER' : 'ENCOUNTER_DOUBLE_WITHDRAWAL',
        JSON.stringify({ tournamentId: null, encounterId, withdrawnTeamId: null, opponentTeamId }),
      ]
    );
  }

  async function encounterRows(tournamentId: string, stage = 'MAIN', roundOrdinal = 1) {
    const res = await db.query<{ id: string; team_a_id: string; team_b_id: string | null; status: string; round_ordinal: number }>(
      `SELECT id, team_a_id, team_b_id, status, round_ordinal FROM encounters
       WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3
       ORDER BY slot_ordinal ASC`,
      [tournamentId, stage, roundOrdinal]
    );
    return res.rows;
  }

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db));
    // No onGameAccepted hook: progression is driven explicitly per test, like the executor's caller.
    resultService = new ResultService(db, new ReplayStore());
    lifecycle = new TournamentLifecycleService(db);
    mapService = new MapService(db);

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'LFix Test Course') RETURNING id`,
      [`LFIX_COURSE_${runId}`]
    );
    courseId = course.rows[0].id;

    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'LFix Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`lfix_admin_${runId}`]
    );
    adminUserId = admin.rows[0].id;
    adminActor = { userId: adminUserId, role: 'ADMIN', username: `lfix_admin_${runId}`, teamIds: [], scope: 'FULL' };
  });

  afterAll(async () => {
    // FK-ordered cleanup of every fixture this file created.
    for (const tournamentId of createdTournamentIds) {
      await db.query(`DELETE FROM accepted_results WHERE game_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1)`, [tournamentId]);
      await db.query(`DELETE FROM result_versions WHERE game_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1)`, [tournamentId]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = $1`, [tournamentId]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'encounterId' IN (SELECT id::text FROM encounters WHERE tournament_id=$1)`, [tournamentId]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'gameId' IN (SELECT g.id::text FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1)`, [tournamentId]);
      await db.query(`DELETE FROM jobs WHERE target_id IN (SELECT g.id FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1)`, [tournamentId]);
      await db.query(`DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id=$1)`, [tournamentId]);
      await db.query(`DELETE FROM tournament_rounds WHERE tournament_id=$1`, [tournamentId]);
      await db.query(`DELETE FROM submissions WHERE tournament_id=$1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_entries WHERE tournament_id=$1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_map_pool WHERE tournament_id=$1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_registrations WHERE tournament_id=$1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_admissions WHERE tournament_id=$1`, [tournamentId]);
      await db.query(`DELETE FROM tournaments WHERE id=$1`, [tournamentId]);
    }
    if (createdMapSlugs.length > 0) {
      await db.query(`DELETE FROM maps WHERE slug = ANY($1::text[])`, [createdMapSlugs]);
    }
    await db.query(`DELETE FROM command_receipts WHERE actor_user_id = $1`, [adminUserId]);
    await db.query(`DELETE FROM outbox_events WHERE topic LIKE 'LFIX%'`);
    await db.query(`DELETE FROM outbox_events WHERE topic IN ('GAME_RESULT_ACCEPTED', 'RESULT_CORRECTED')`);
    try {
      await db.query(`DELETE FROM teams WHERE course_id = $1`, [courseId]);
      await db.query(`DELETE FROM users WHERE username LIKE 'lfix_user_${runId}_%' OR username = 'lfix_admin_${runId}'`, []);
      await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    } catch {
      // Fixture teams/users are disposable; leftover rows never leak the suite.
    }
    await db.close();
  });

  // ------------------------------------------------------------------
  // L1 — sealed completed results survive withdrawal
  // ------------------------------------------------------------------

  describe('L1: standings preserve completed results vs withdrawn teams', () => {
    it('swiss: a completed encounter against a withdrawn side still credits the remaining side (points, played, tiebreakers)', () => {
      const fresh: TeamEntry[] = [
        { teamId: 'aa', seedOrdinal: 1 },
        { teamId: 'cc', seedOrdinal: 3 },
      ];
      // aa↔bb was a draw; bb withdrew afterwards. aa keeps its 1 point, its matchesPlayed and
      // opponents/Buchholz visibility of bb's sealed points.
      const standings = new SwissFormat().computeStandings(
        fresh,
        [completed('e1', 1, 'aa', 'bb', 'winner-less-draw', 1, 1)]
      );
      expect(standings).toHaveLength(2);
      const aa = standings.find((s) => s.teamId === 'aa')!;
      expect(aa.points).toBe(1);
      expect(aa.matchesPlayed).toBe(1);
      expect(aa.draws).toBe(1);
      expect(aa.buchholz).toBe(1);
      expect(aa.rank).toBe(1);
      const cc = standings.find((s) => s.teamId === 'cc')!;
      expect(cc.points).toBe(0);
      expect(cc.matchesPlayed).toBe(0);
      expect(cc.rank).toBe(2);
    });

    it('swiss: ineligible teams stay off the ranked list even when the history contains them', () => {
      const fresh: TeamEntry[] = [
        { teamId: 'aa', seedOrdinal: 1 },
        { teamId: 'cc', seedOrdinal: 3 },
      ];
      const standings = new SwissFormat().computeStandings(
        fresh,
        [
          // bb (now withdrawn) beat aa before withdrawing; the loss stays sealed.
          completed('e1', 1, 'aa', 'bb', 'bb', 0, 3),
          completed('e2', 1, 'aa', 'cc', 'aa', 3, 0),
        ]
      );
      expect(standings.map((s) => s.teamId).sort()).toEqual(['aa', 'cc']);
      const aa = standings.find((s) => s.teamId === 'aa')!;
      // The played loss to bb keeps counting: two matches played, bb feeds aa's Buchholz.
      expect(aa.points).toBe(3);
      expect(aa.matchesPlayed).toBe(2);
      expect(aa.losses).toBe(1);
      expect(aa.wins).toBe(1);
      expect(aa.buchholz).toBe(3);
      expect(aa.rank).toBe(1);
      const cc = standings.find((s) => s.teamId === 'cc')!;
      expect(cc.points).toBe(0);
      expect(cc.matchesPlayed).toBe(1);
      expect(cc.rank).toBe(2);
    });

    it('swiss: withdrawn side gains nothing from walkovers, eligible walker keeps the administrative points', () => {
      const fresh: TeamEntry[] = [
        { teamId: 'aa', seedOrdinal: 1 },
        { teamId: 'cc', seedOrdinal: 3 },
      ];
      const standings = new SwissFormat().computeStandings(
        fresh,
        [
          // bb "won" a walkover before withdrawing (already ruled as administrative, ineligible now).
          walkover('e1', 1, 'bb', 'aa', 'bb', 3, 0),
          // aa was awarded a walkover against bb's withdrawal.
          walkover('e2', 1, 'aa', 'bb', 'aa', 3, 0),
        ]
      );
      const aa = standings.find((s) => s.teamId === 'aa')!;
      expect(aa.points).toBe(3);
      expect(aa.matchesPlayed).toBe(1);
      expect(aa.opponents).toBeUndefined(); // Buchholz lists never seeded from walkovers
      expect(standings.map((s) => s.teamId).sort()).toEqual(['aa', 'cc']);
    });

    it('round-robin: completed encounter vs withdrawn side keeps crediting; walkover fencing holds', () => {
      const fresh: TeamEntry[] = [
        { teamId: 'aa', seedOrdinal: 1 },
        { teamId: 'cc', seedOrdinal: 3 },
      ];
      const standings = new RoundRobinFormat().computeStandings(
        fresh,
        [
          completed('e1', 1, 'aa', 'bb', 'winner-less-draw', 1, 1),
          walkover('e2', 1, 'bb', 'aa', 'bb', 3, 0),
          walkover('e3', 1, 'cc', 'bb', 'bb', 0, 3),
        ]
      );
      expect(standings.map((s) => s.teamId).sort()).toEqual(['aa', 'cc']);
      const aa = standings.find((s) => s.teamId === 'aa')!;
      expect(aa.points).toBe(1);
      expect(aa.matchesPlayed).toBe(1);
      const cc = standings.find((s) => s.teamId === 'cc')!;
      expect(cc.points).toBe(0);
      expect(cc.rank).toBe(2);
    });
  });

  // ------------------------------------------------------------------
  // L2 — recordResult + completion guard
  // ------------------------------------------------------------------

  describe('L2: administratively resolved games refuse late results; encounter rulings resist overwrites', () => {
    it('refuses CANCELLED games after a withdrawal walkover and leaves the ruling untouched', async () => {
      const { tournamentId, teamIds } = await createRunningKnockout();
      const encounters = await encounterRows(tournamentId);
      const encounter = encounters[1];
      const games = await gameRefsForEncounter(encounter.id);
      expect(games.length).toBeGreaterThan(0);

      await applyWithdrawalRuling(encounter.id, encounter.team_a_id, true);

      const refused = resultService.recordResult({
        gameId: games[0].id,
        attemptId: randomUUID(),
        evidence: {
          gameId: games[0].id,
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
        },
        manifestDigest: `sha256_lfix_refused_${tournamentId.slice(0, 8)}`,
        mapDescriptor: sampleMap,
      });
      await expect(refused).rejects.toBeInstanceOf(ResultRejectedError);
      await expect(refused).rejects.toMatchObject({ code: 'RESULT_REJECTED', reason: 'GAME_CANCELLED' });

      const ruling = await db.query<{ status: string; winner_team_id: string | null; points_a: string }>(
        `SELECT status, winner_team_id, points_a FROM encounters WHERE id = $1`, [encounter.id]
      );
      expect(ruling.rows[0].status).toBe('WALKOVER');
      expect(ruling.rows[0].winner_team_id).toBe(encounter.team_a_id);
      expect(parseFloat(ruling.rows[0].points_a)).toBe(3);
      const accepted = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM accepted_results WHERE game_id = $1`, [games[0].id]
      );
      expect(accepted.rows[0].count).toBe('0');
      void teamIds;
    });

    it('refuses results when the encounter is already WALKOVER but the game row was not cancelled', async () => {
      const { tournamentId } = await createRunningKnockout();
      const encounters = await encounterRows(tournamentId);
      const encounter = encounters[1];
      const games = await gameRefsForEncounter(encounter.id);

      // Ruling without the game-cancellation write: the encounter seal is authoritative on its own.
      await db.query(
        `UPDATE encounters SET status = 'WALKOVER', winner_team_id = $2, points_a = 3, points_b = 0 WHERE id = $1`,
        [encounter.id, encounter.team_a_id]
      );

      const refused = resultService.recordResult({
        gameId: games[0].id,
        attemptId: randomUUID(),
        evidence: {
          gameId: games[0].id,
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
        },
        manifestDigest: `sha256_lfix_encstatus_${tournamentId.slice(0, 8)}`,
        mapDescriptor: sampleMap,
      });
      await expect(refused).rejects.toMatchObject({ reason: 'ENCOUNTER_WALKOVER' });
    });

    it('handleGameCompletion does not overwrite a CANCELLED encounter; normal PENDING completion still works', async () => {
      const { tournamentId } = await createRunningKnockout();
      const encounters = await encounterRows(tournamentId);

      // Encounter A: plays to completion while RUNNING, then is administratively voided like a DQ.
      const encounterA = encounters[0];
      await winAllEncounterGames(encounterA.id, encounterA.team_a_id, 'dqvoid');
      // No progression hook on this service: run completion by hand, then void the encounter
      // (the DQ path marks encounters CANCELLED after played games, keeping completed game rows).
      const anchorGameA = (await gameRefsForEncounter(encounterA.id))[0].id;
      await scheduler.handleGameCompletion(anchorGameA);
      const completedBefore = await db.query<{ status: string }>(`SELECT status FROM encounters WHERE id=$1`, [encounterA.id]);
      expect(completedBefore.rows[0].status).toBe('COMPLETED');
      await db.query(
        `UPDATE encounters SET status='CANCELLED', winner_team_id=NULL, points_a=0, points_b=0 WHERE id=$1`,
        [encounterA.id]
      );
      await scheduler.handleGameCompletion(anchorGameA);

      const voided = await db.query<{ status: string }>(`SELECT status FROM encounters WHERE id=$1`, [encounterA.id]);
      expect(voided.rows[0].status).toBe('CANCELLED');

      // Encounter B: normal path still completes and awards the encounter winner.
      const encounterB = encounters[1];
      await winAllEncounterGames(encounterB.id, encounterB.team_a_id, 'normalpath');
      const anchorGameB = (await gameRefsForEncounter(encounterB.id))[0].id;
      await scheduler.handleGameCompletion(anchorGameB);
      const normal = await db.query<{ status: string; winner_team_id: string | null }>(
        `SELECT status, winner_team_id FROM encounters WHERE id=$1`, [encounterB.id]
      );
      expect(normal.rows[0].status).toBe('COMPLETED');
      expect(normal.rows[0].winner_team_id).toBe(encounterB.team_a_id);
    });
  });

  // ------------------------------------------------------------------
  // L4 — control-plane result-outbox per-event resilience
  // ------------------------------------------------------------------

  describe('L4: control-plane advances past bad result outbox events', () => {
    function makeControlPlane(schedulerInstance: TournamentSchedulerService): TournamentControlPlane {
      return new TournamentControlPlane(
        db,
        new JobBroker(db),
        new JobReconciler(db),
        schedulerInstance,
        new RetentionService(db),
        1000,
        60_000
      );
    }

    async function clearResultOutbox(): Promise<void> {
      await db.query(`DELETE FROM outbox_events WHERE topic IN ('GAME_RESULT_ACCEPTED', 'RESULT_CORRECTED')`);
    }

    it('malformed event is marked delivered and does not block the next good event', async () => {
      await clearResultOutbox();
      const { tournamentId } = await createRunningKnockout('ROUND_ROBIN');
      const encounters = await encounterRows(tournamentId);
      await winAllEncounterGames(encounters[0].id, encounters[0].team_a_id, 'outboxgood');
      // recordResult emitted one event per accepted game; drop them so exactly the two
      // events injected below are what this tick sees. onGameAccepted is not wired:
      // progression must arrive through the outbox tick.
      await clearResultOutbox();

      await db.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ('GAME_RESULT_ACCEPTED', $1)`,
        [JSON.stringify({ noGameIdHere: true })]
      );
      await db.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ('GAME_RESULT_ACCEPTED', $1)`,
        [JSON.stringify({ gameId: (await gameRefsForEncounter(encounters[0].id))[0].id })]
      );

      const control = makeControlPlane(scheduler);
      await control.tick();

      const events = await db.query<{ topic: string; payload: Record<string, unknown>; delivered_at: Date | null }>(
        `SELECT topic, payload, delivered_at FROM outbox_events
         WHERE topic = 'GAME_RESULT_ACCEPTED' ORDER BY created_at ASC`
      );
      expect(events.rows.map((row) => row.delivered_at !== null)).toEqual([true, true]);
      expect(events.rows[0].payload.noGameIdHere).toBe(true);
      expect(events.rows[0].payload.deliveryFailures).toBe(-1);
      expect(events.rows[0].payload.lastDeliveryError).toBe('MALFORMED_PAYLOAD');
      const encounter = await db.query<{ status: string; winner_team_id: string | null }>(
        `SELECT status, winner_team_id FROM encounters WHERE id = $1`, [encounters[0].id]
      );
      expect(encounter.rows[0].status).toBe('COMPLETED');
      expect(encounter.rows[0].winner_team_id).toBe(encounters[0].team_a_id);
    });

    it('a transiently failing event stays pending with durable attempt bookkeeping while the loop advances', async () => {
      await clearResultOutbox();
      const failingScheduler = {
        sealEligibleRounds: async () => ({ sealed: 0, blocked: 0 }),
        handleGameCompletion: async () => {
          throw new Error('synthetic transient failure');
        },
        enqueueGameJobs: async () => undefined,
      };
      await db.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ('GAME_RESULT_ACCEPTED', $1)`,
        [JSON.stringify({ gameId: randomUUID() })]
      );
      await db.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ('GAME_RESULT_ACCEPTED', $1)`,
        [JSON.stringify({ gameId: randomUUID() })]
      );

      const control = makeControlPlane(failingScheduler as unknown as TournamentSchedulerService);
      await control.tick();

      const events = await db.query<{ payload: Record<string, unknown>; delivered_at: Date | null }>(
        `SELECT payload, delivered_at FROM outbox_events WHERE topic = 'GAME_RESULT_ACCEPTED' ORDER BY created_at ASC`
      );
      expect(events.rows.map((row) => row.delivered_at === null)).toEqual([true, true]);
      expect(events.rows[0].payload.deliveryFailures).toBe(1);
      expect(events.rows[0].payload.lastDeliveryError).toBe('synthetic transient failure');
      expect(events.rows[1].payload.deliveryFailures).toBe(1);
    });

    it('retry cap poisons a permanently failing event so the pipeline keeps moving', async () => {
      await clearResultOutbox();
      let attempts = 0;
      const failingScheduler = {
        sealEligibleRounds: async () => ({ sealed: 0, blocked: 0 }),
        handleGameCompletion: async () => {
          attempts += 1;
          throw new Error('deterministic poison');
        },
        enqueueGameJobs: async () => undefined,
      };
      await db.query(
        `INSERT INTO outbox_events (topic, payload) VALUES ('GAME_RESULT_ACCEPTED', $1)`,
        [JSON.stringify({ gameId: randomUUID(), deliveryFailures: 4, lastDeliveryError: 'earlier' })]
      );

      const control = makeControlPlane(failingScheduler as unknown as TournamentSchedulerService);
      await control.tick();

      expect(attempts).toBe(1);
      const events = await db.query<{ payload: Record<string, unknown>; delivered_at: Date | null }>(
        `SELECT payload, delivered_at FROM outbox_events WHERE topic = 'GAME_RESULT_ACCEPTED' ORDER BY created_at ASC`
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].delivered_at).not.toBeNull();
      expect(events.rows[0].payload.deliveryFailures).toBe(5);
      expect(events.rows[0].payload.lastDeliveryError).toBe('deterministic poison');
    });
  });

  // ------------------------------------------------------------------
  // L6 — PUBLIC map listing without revealed versions
  // ------------------------------------------------------------------

  describe('L6: public map listing keeps PUBLIC maps without revealed versions', () => {
    async function insertMap(slug: string, visibility: 'PUBLIC' | 'HIDDEN', descriptor: Record<string, unknown>, currentVersion: number, revealedAt: boolean): Promise<string> {
      createdMapSlugs.push(slug);
      const map = await db.query<{ id: string }>(
        `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings, revealed_at, current_version)
         VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6) RETURNING id`,
        [slug, `LFix Map ${slug}`, JSON.stringify(descriptor), visibility, revealedAt ? new Date().toISOString() : null, currentVersion]
      );
      return map.rows[0].id;
    }

    async function insertVersion(mapId: string, version: number, descriptor: Record<string, unknown>, revealed: boolean): Promise<void> {
      await db.query(
        `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings, revealed_at)
         VALUES ($1, $2, $3, '[]'::jsonb, $4)`,
        [mapId, version, JSON.stringify(descriptor), revealed ? new Date().toISOString() : null]
      );
    }

    it('lists PUBLIC maps at their current version even with zero map_versions rows, and keeps HIDDEN newest-revealed semantics', async () => {
      const onlyMapLevel: MapDescriptor = { ...sampleMap, mapName: 'lfix-only-map' };
      const version1: MapDescriptor = { ...sampleMap, mapName: 'lfix-version-1' };
      const version2: MapDescriptor = { ...sampleMap, mapName: 'lfix-version-2' };

      await insertMap(`lfix_pub_noversions_${runId}`, 'PUBLIC', onlyMapLevel, 1, false);
      const revealedCurrent = await insertMap(`lfix_pub_current_${runId}`, 'PUBLIC', version2, 2, true);
      await insertVersion(revealedCurrent, 1, version1, true);
      await insertVersion(revealedCurrent, 2, version2, false);
      await insertMap(`lfix_hidden_revealed_${runId}`, 'HIDDEN', version1, 1, true)
        .then((mapId) => insertVersion(mapId, 1, version1, true));
      await insertMap(`lfix_hidden_noversions_${runId}`, 'HIDDEN', version2, 1, true);
      const listed = await mapService.listMaps(undefined);
      const bySlug = new Map(listed.map((row) => [row.slug, row] as const));

      const pubNo = bySlug.get(`lfix_pub_noversions_${runId}`);
      expect(pubNo).toBeDefined();
      expect(pubNo!.descriptor).toEqual(onlyMapLevel);

      const pubCurrent = bySlug.get(`lfix_pub_current_${runId}`);
      expect(pubCurrent).toBeDefined();
      expect(pubCurrent!.descriptor).toEqual(version2);

      const hide = bySlug.get(`lfix_hidden_revealed_${runId}`);
      expect(hide).toBeDefined();
      expect(hide!.descriptor).toEqual(version1);

      // An inconsistent HIDDEN map (level seal set, no revealed version) must stay hidden.
      expect(bySlug.get(`lfix_hidden_noversions_${runId}`)).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // L7 — dead drain write removed
  // ------------------------------------------------------------------

  describe('L7: draining lock leaves aggregate untouched', () => {
    it('lock during pending submissions throws INTAKE_DRAINING without persisting a state transition', async () => {
      const { tournamentId, teamIds } = await createRunningKnockout();
      // Park the tournament in an intake state with a pending-submission row.
      await db.query(
        `UPDATE tournaments SET state='REGISTRATION_OPEN', registration_closes_at = clock_timestamp() - interval '1 hour' WHERE id=$1`,
        [tournamentId]
      );
      const source = await db.query<{ digest: string }>(
        `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
         VALUES ($1, $1, 10, 10, 1, '[]'::jsonb) RETURNING digest`,
        [`lfix_source_${runId}_1`]
      );
      await db.query(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, 1, $4, 'PYTHON', 'main.py', 'SMOKE_TESTING')`,
        [tournamentId, teamIds[0], adminUserId, source.rows[0].digest]
      );

      const before = await db.query<{ state: string; version: number }>(
        `SELECT state, version FROM tournaments WHERE id=$1`, [tournamentId]
      );
      const ctx: CommandContext = {
        actor: adminActor,
        requestId: randomUUID(),
        expectedVersion: before.rows[0].version,
      };
      await expect(lifecycle.lock(tournamentId, ctx)).rejects.toMatchObject({
        message: expect.stringContaining('INTAKE_DRAINING'),
      });
      const after = await db.query<{ state: string; version: number }>(
        `SELECT state, version FROM tournaments WHERE id=$1`, [tournamentId]
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  // ------------------------------------------------------------------
  // L8 — extendRegistration version/clock
  // ------------------------------------------------------------------

  describe('L8: extendRegistration bumps version and uses the DB clock', () => {
    async function createRegistrationOpen(): Promise<{ tournamentId: string; version: number }> {
      const tournament = await db.query<{ id: string; version: number }>(
        `INSERT INTO tournaments (course_id, name, format, state, registration_closes_at)
         VALUES ($1, $2, 'SINGLE_ELIMINATION', 'REGISTRATION_OPEN', clock_timestamp() + interval '1 hour')
         RETURNING id, version`,
        [courseId, `LFix RegOpen ${runId} ${createdTournamentIds.length}`]
      );
      createdTournamentIds.push(tournament.rows[0].id);
      return { tournamentId: tournament.rows[0].id, version: tournament.rows[0].version };
    }

    it('bumps the aggregate version on success', async () => {
      const { tournamentId, version } = await createRegistrationOpen();
      const ctx: CommandContext = { actor: adminActor, requestId: randomUUID(), expectedVersion: version };
      const result = await lifecycle.extendRegistration(tournamentId, new Date(Date.now() + 90 * 60_000), ctx);
      expect(result.tournamentId).toBe(tournamentId);
      const after = await db.query<{ version: number; closes: Date }>(
        `SELECT version, registration_closes_at AS closes FROM tournaments WHERE id=$1`, [tournamentId]
      );
      expect(after.rows[0].version).toBe(version + 1);
      const delta = after.rows[0].closes.getTime() - new Date(result.registrationClosesAt).getTime();
      expect(Math.abs(delta)).toBeLessThan(2000);
    });

    it('rejects a stale expectedVersion without touching the row', async () => {
      const { tournamentId, version } = await createRegistrationOpen();
      const ctx: CommandContext = { actor: adminActor, requestId: randomUUID(), expectedVersion: version - 1 };
      await expect(lifecycle.extendRegistration(tournamentId, new Date(Date.now() + 90 * 60_000), ctx)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('STALE_VERSION'),
      });
      const after = await db.query<{ version: number; closes: Date }>(
        `SELECT version, registration_closes_at AS closes FROM tournaments WHERE id=$1`, [tournamentId]
      );
      expect(after.rows[0].version).toBe(version);
      expect(after.rows[0].closes.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    });

    it('refuses to reopen an already-passed cutoff (DB clock decides) and a stale new cutoff is 400', async () => {
      const { tournamentId, version } = await createRegistrationOpen();
      await db.query(
        `UPDATE tournaments SET registration_closes_at = clock_timestamp() - interval '5 minutes' WHERE id=$1`,
        [tournamentId]
      );
      const ctx: CommandContext = { actor: adminActor, requestId: randomUUID(), expectedVersion: version };
      await expect(lifecycle.extendRegistration(tournamentId, new Date(Date.now() + 90 * 60_000), ctx)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('EXTENSION_DENIED'),
      });
      const current = await db.query<{ version: number; closes: Date }>(
        `SELECT version, registration_closes_at AS closes FROM tournaments WHERE id=$1`, [tournamentId]
      );
      expect(current.rows[0].version).toBe(version);
      expect(current.rows[0].closes.getTime()).toBeLessThan(Date.now());

      // A second tournament where the cutoff is still open: pushing it backwards is a 400.
      const fresh = await createRegistrationOpen();
      const freshCtx: CommandContext = { actor: adminActor, requestId: randomUUID(), expectedVersion: fresh.version };
      await expect(lifecycle.extendRegistration(fresh.tournamentId, new Date(Date.now() - 60_000), freshCtx)).rejects.toMatchObject({
        statusCode: 400,
      });
      const untouched = await db.query<{ version: number }>(`SELECT version FROM tournaments WHERE id=$1`, [fresh.tournamentId]);
      expect(untouched.rows[0].version).toBe(fresh.version);
    });

    it('rejects non-REGISTRATION_OPEN states before touching the cutoff', async () => {
      const { tournamentId, version } = await createRegistrationOpen();
      await db.query(`UPDATE tournaments SET state='PUBLISHED' WHERE id=$1`, [tournamentId]);
      const ctx: CommandContext = { actor: adminActor, requestId: randomUUID(), expectedVersion: version };
      await expect(lifecycle.extendRegistration(tournamentId, new Date(Date.now() + 90 * 60_000), ctx)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("state 'PUBLISHED'"),
      });
      const after = await db.query<{ version: number }>(`SELECT version FROM tournaments WHERE id=$1`, [tournamentId]);
      expect(after.rows[0].version).toBe(version);
    });
  });

});
