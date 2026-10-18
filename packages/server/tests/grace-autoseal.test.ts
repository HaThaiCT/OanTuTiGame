/**
 * S11: durable post-round grace window and autoseal dispatch (migration 015).
 *
 * A round whose last encounter goes terminal is only *eligible* to seal: `handleGameCompletion`
 * stamps `last_terminal_at` / `seal_eligible_at` (now + `tournaments.grace_period_minutes`) and
 * emits ROUND_COMPLETED. The round is only sealed — and the next round generated — by
 * `sealEligibleRounds`, which the autonomous worker runs on every tick. The window stays open
 * while any encounter of the round carries a dispute that is not decided.
 *
 * Fixtures set `grace_period_minutes` explicitly: 0 means "the next sweep may seal it", 60 means
 * "not within this test's lifetime".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { BuildPipeline } from '../src/builds/build-pipeline.js';
import { PrivateTestRunner } from '../src/builds/private-test-runner.js';
import { DisputeService } from '../src/adjudication/dispute-service.js';
import { JobBroker } from '../src/jobs/broker.js';
import { JobReconciler } from '../src/jobs/reconciler.js';
import { ReplayStore } from '../src/results/replay-store.js';
import { ResultService } from '../src/results/service.js';
import { MapService } from '../src/tournaments/map-service.js';
import { MatchExecutionService } from '../src/tournaments/execution-service.js';
import { TournamentAutoRunner } from '../src/tournaments/auto-runner.js';
import { TournamentSchedulerService } from '../src/tournaments/scheduler-service.js';

const sampleMap: MapDescriptor = {
  mapName: 'grace-autoseal-map-3x3',
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

interface FixtureTeam {
  readonly teamId: string;
  readonly captainUserId: string;
}

interface RoundState {
  readonly status: string;
  readonly last_terminal_at: Date | null;
  readonly seal_eligible_at: Date | null;
  readonly sealed_at: Date | null;
}

describe('S11: round grace window and autoseal', () => {
  let db: PostgresDatabase;
  let scheduler: TournamentSchedulerService;
  let resultService: ResultService;
  let disputeService: DisputeService;
  let courseId = '';
  let adminActor: Actor;
  const createdTournaments: string[] = [];
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  /** Creates a 4-team single-elimination tournament in RUNNING with the given grace, round 1 scheduled. */
  async function createTournament(graceMinutes: number, label: string): Promise<{ tournamentId: string; teams: FixtureTeam[] }> {
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, grace_period_minutes)
       VALUES ($1, $2, 'SINGLE_ELIMINATION', 'RUNNING', $3)
       RETURNING id`,
      [courseId, `Grace ${label} ${runId}`, graceMinutes]
    );
    const tournamentId = tournament.rows[0].id;
    createdTournaments.push(tournamentId);

    const teams: FixtureTeam[] = [];
    for (let index = 1; index <= 4; index++) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
         VALUES ($1, $2, 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
        [`grace_user_${runId}_${label}_${index}`, `Grace Captain ${index}`]
      );
      const team = await db.query<{ id: string }>(
        `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [courseId, `Grace Team ${label} ${index} ${runId}`, user.rows[0].id]
      );
      teams.push({ teamId: team.rows[0].id, captainUserId: user.rows[0].id });
      await db.query(
        `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal)
         VALUES ($1, $2, 'ELIGIBLE', $3)`,
        [tournamentId, team.rows[0].id, index]
      );
    }

    await scheduler.scheduleRound1(tournamentId, sampleMap);
    return { tournamentId, teams };
  }

  /**
   * Records a decisive win for `winnerTeamId` in every game of one encounter; the last such
   * result is what makes the encounter — and possibly its round — terminal.
   */
  async function winEncounter(encounterId: string, winnerTeamId: string, tag: string): Promise<void> {
    const games = await db.query<{ id: string; white_team_id: string }>(
      `SELECT id, white_team_id FROM games WHERE encounter_id = $1 ORDER BY game_ordinal ASC`,
      [encounterId]
    );

    for (const [index, game] of games.rows.entries()) {
      const whiteWon = game.white_team_id === winnerTeamId;
      await resultService.recordResult({
        gameId: game.id,
        attemptId: randomUUID(),
        evidence: {
          gameId: game.id,
          winner: whiteWon ? 1 : 2,
          reason: whiteWon ? 'THRONE_BREACH' : 'BOT_TIMEOUT',
          disposition: 'DECISIVE' as const,
          executionStatus: whiteWon ? ('COMPLETED' as const) : ('BOT_FORFEIT' as const),
          rulesRevision: 'ArenaGameplay/v2',
          totalPly: 3,
          trace: [
            { ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 2 } } },
            { ply: 2, side: 2, move: { pieceId: 2, targetPos: { x: 1, y: 1 } } },
            { ply: 3, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } },
          ],
        },
        manifestDigest: `sha256_grace_${tag}_${index}`,
        mapDescriptor: sampleMap,
      });
    }
  }

  /** Plays out round 1 of MAIN by letting each encounter's first-seeded side sweep it. */
  async function completeRoundOne(tournamentId: string): Promise<{ id: string; team_a_id: string }[]> {
    const encounters = await db.query<{ id: string; team_a_id: string }>(
      `SELECT id, team_a_id FROM encounters
       WHERE tournament_id = $1 AND stage = 'MAIN' AND round_ordinal = 1
       ORDER BY slot_ordinal ASC`,
      [tournamentId]
    );

    for (const encounter of encounters.rows) {
      await winEncounter(encounter.id, encounter.team_a_id, `${tournamentId.slice(0, 8)}_${encounter.id.slice(0, 8)}`);
    }
    return encounters.rows;
  }

  async function roundState(tournamentId: string, roundOrdinal: number): Promise<RoundState> {
    const res = await db.query<RoundState>(
      `SELECT status, last_terminal_at, seal_eligible_at, sealed_at FROM tournament_rounds
       WHERE tournament_id = $1 AND stage = 'MAIN' AND round_ordinal = $2`,
      [tournamentId, roundOrdinal]
    );
    return res.rows[0];
  }

  async function encounterCount(tournamentId: string, roundOrdinal: number): Promise<number> {
    const res = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM encounters
       WHERE tournament_id = $1 AND round_ordinal = $2`,
      [tournamentId, roundOrdinal]
    );
    return Number.parseInt(res.rows[0].count, 10);
  }

  beforeAll(async () => {
    db = new PostgresDatabase();
    scheduler = new TournamentSchedulerService(db, new JobBroker(db));
    resultService = new ResultService(db, new ReplayStore(), undefined, async (gameId) => {
      await scheduler.handleGameCompletion(gameId);
    });
    disputeService = new DisputeService(db);

    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Grace Test Course') RETURNING id`,
      [`GRACE_COURSE_${runId}`]
    );
    courseId = course.rows[0].id;

    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Grace Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`grace_admin_${runId}`]
    );
    adminActor = {
      userId: admin.rows[0].id,
      role: 'ADMIN',
      username: `grace_admin_${runId}`,
      teamIds: [],
      scope: 'FULL',
    };

    // The sweep is global by design (the worker drives every tournament), so fixtures another
    // test file left eligible are drained first: the counts asserted below then describe this
    // file's tournaments only.
    await scheduler.sealEligibleRounds(100);
  });

  afterAll(async () => {
    // Leave no seal-eligible fixtures behind: a later test file's worker tick would seal them.
    for (const tournamentId of createdTournaments) {
      await db.query(`DELETE FROM disputes WHERE tournament_id = $1`, [tournamentId]);
      await db.query(
        `DELETE FROM accepted_results
         WHERE game_id IN (
           SELECT g.id FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE e.tournament_id = $1
         )`,
        [tournamentId]
      );
      await db.query(
        `DELETE FROM result_versions
         WHERE game_id IN (
           SELECT g.id FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE e.tournament_id = $1
         )`,
        [tournamentId]
      );
      await db.query(
        `DELETE FROM jobs
         WHERE target_id IN (
           SELECT g.id FROM games g JOIN encounters e ON e.id = g.encounter_id WHERE e.tournament_id = $1
         )`,
        [tournamentId]
      );
      await db.query(
        `DELETE FROM games WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1)`,
        [tournamentId]
      );
      await db.query(`DELETE FROM encounters WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM tournament_rounds WHERE tournament_id = $1`, [tournamentId]);
      await db.query(`DELETE FROM tournaments WHERE id = $1`, [tournamentId]);
    }
    await db.close();
  });

  it('leaves a completed round unsealed while its 60-minute grace window is running', async () => {
    const { tournamentId } = await createTournament(60, 'window');
    await completeRoundOne(tournamentId);

    const round = await roundState(tournamentId, 1);
    expect(round.status).toBe('SEAL_ELIGIBLE');
    expect(round.sealed_at).toBeNull();
    expect(round.last_terminal_at).not.toBeNull();
    // Eligibility is anchored to the grace window, measured from the last terminal encounter.
    const minutesUntilEligible = (round.seal_eligible_at!.getTime() - round.last_terminal_at!.getTime()) / 60_000;
    expect(minutesUntilEligible).toBeCloseTo(60, 1);

    // The worker's sweep runs and must refuse to seal it: nothing is due yet.
    const swept = await scheduler.sealEligibleRounds();
    expect(swept).toEqual({ sealed: 0, blocked: 0 });
    expect((await roundState(tournamentId, 1)).sealed_at).toBeNull();
    expect(await encounterCount(tournamentId, 2)).toBe(0);

    // ROUND_COMPLETED announces eligibility; no ROUND_SEALED may exist yet.
    const completed = await db.query<{ payload: { sealEligibleAt: string } }>(
      `SELECT payload FROM outbox_events WHERE topic = 'ROUND_COMPLETED' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(completed.rows).toHaveLength(1);
    expect(Date.parse(completed.rows[0].payload.sealEligibleAt)).toBe(round.seal_eligible_at!.getTime());

    const sealed = await db.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE topic = 'ROUND_SEALED' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(sealed.rows).toHaveLength(0);
  });

  it('blocks the seal while a dispute on one of the round encounters is unresolved', async () => {
    const { tournamentId, teams } = await createTournament(0, 'dispute');
    const encounters = await completeRoundOne(tournamentId);

    const captainActor: Actor = {
      userId: teams[0].captainUserId,
      role: 'STUDENT',
      username: `grace_user_${runId}_dispute_1`,
      teamIds: [teams[0].teamId],
      scope: 'FULL',
    };
    const dispute = await disputeService.createDispute(captainActor, {
      tournamentId,
      encounterId: encounters[0].id,
      teamId: teams[0].teamId,
      reason: 'Opponent bot appeared to move twice on turn 2',
    });
    expect(dispute.status).toBe('OPEN');

    // Both encounters are terminal and grace is 0, but the open dispute holds the round.
    const blockedSweep = await scheduler.sealEligibleRounds();
    expect(blockedSweep).toEqual({ sealed: 0, blocked: 1 });
    expect((await roundState(tournamentId, 1)).sealed_at).toBeNull();
    expect(await encounterCount(tournamentId, 2)).toBe(0);

    // UNDER_REVIEW blocks exactly like OPEN; no route produces it yet, so set it directly.
    await db.query(`UPDATE disputes SET status = 'UNDER_REVIEW' WHERE id = $1`, [dispute.id]);
    expect(await scheduler.sealEligibleRounds()).toEqual({ sealed: 0, blocked: 1 });

    // Deciding the dispute releases the seal on the next sweep.
    await disputeService.resolveDispute(adminActor, dispute.id, 'RESOLVED', 'Trace inspection found no double move');
    const unblocked = await scheduler.sealEligibleRounds();
    expect(unblocked).toEqual({ sealed: 1, blocked: 0 });
    expect((await roundState(tournamentId, 1)).sealed_at).not.toBeNull();
    expect(await encounterCount(tournamentId, 2)).toBe(1);
  });

  it('seals a grace-0 round on the next sweep and schedules the next round exactly once', async () => {
    const { tournamentId } = await createTournament(0, 'immediate');
    await completeRoundOne(tournamentId);
    expect((await roundState(tournamentId, 1)).sealed_at).toBeNull();

    const first = await scheduler.sealEligibleRounds();
    expect(first).toEqual({ sealed: 1, blocked: 0 });
    expect((await roundState(tournamentId, 1)).status).toBe('COMPLETED');
    expect((await roundState(tournamentId, 1)).sealed_at).not.toBeNull();
    expect(await encounterCount(tournamentId, 2)).toBe(1);

    const sealedEvent = await db.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE topic = 'ROUND_SEALED' AND payload->>'tournamentId' = $1`,
      [tournamentId]
    );
    expect(sealedEvent.rows).toHaveLength(1);

    // A second sweep has nothing left to seal and must not re-schedule the final.
    const second = await scheduler.sealEligibleRounds();
    expect(second).toEqual({ sealed: 0, blocked: 0 });
    expect(await encounterCount(tournamentId, 2)).toBe(1);
  });

  it('seals through the autonomous worker tick even when gamesPerTick is 0', async () => {
    const { tournamentId } = await createTournament(0, 'worker');
    await completeRoundOne(tournamentId);
    expect((await roundState(tournamentId, 1)).sealed_at).toBeNull();

    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'grace-autoseal-'));
    const broker = new JobBroker(db);
    const replayStore = new ReplayStore();
    const artifactStore = new ArtifactStore(db, path.join(tmpRoot, 'submissions'));
    const executionService = new MatchExecutionService(
      db,
      new MapService(db),
      artifactStore,
      replayStore,
      resultService,
      scheduler,
      broker,
      { spoolDir: path.join(tmpRoot, 'execution') }
    );
    const autoRunner = new TournamentAutoRunner(
      db,
      executionService,
      broker,
      new JobReconciler(db),
      new BuildPipeline(db, artifactStore, { spoolDir: path.join(tmpRoot, 'builds') }),
      new PrivateTestRunner(db, artifactStore, replayStore, { spoolDir: path.join(tmpRoot, 'tests') }),
      scheduler,
      { intervalMs: 3_600_000, gamesPerTick: 0, buildsPerTick: 0, testsPerTick: 0 }
    );

    await autoRunner.runOnce();

    expect((await roundState(tournamentId, 1)).sealed_at).not.toBeNull();
    expect(await encounterCount(tournamentId, 2)).toBe(1);
  });
});
