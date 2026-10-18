import type pg from 'pg';
import type { MapDescriptor } from '@oantuti/engine';
import type { PostgresDatabase } from '../persistence/db.js';
import type { JobBroker } from '../jobs/broker.js';
import { GAME_JOB_PRIORITY } from '../jobs/game-jobs.js';
import { EliminationFormat } from './formats/elimination.js';
import { SwissFormat } from './formats/swiss.js';
import { RoundRobinFormat } from './formats/round-robin.js';
import { EloFormat } from './formats/elo.js';
import { PairingSolverError } from './formats/matching.js';
import type { CompletedEncounterRecord, RoundSchedule, TeamEntry } from './formats/types.js';

/** A game row this service created, returned so the caller can enqueue its GAME job. */
export interface CreatedGameRef {
  readonly gameId: string;
  readonly encounterId: string;
  readonly gameOrdinal: number;
}

/** What one `handleGameCompletion` call produced: the round it acted on and the games it created. */
interface CompletionOutcome {
  readonly tournamentId: string | null;
  readonly createdGames: readonly CreatedGameRef[];
}

/** Rounds one seal sweep considers; the autonomous worker calls the sweep every tick. */
const DEFAULT_SEAL_BATCH = 10;

/** A round whose grace window has elapsed, with the map the next round plays on. */
interface SealCandidate {
  readonly tournament_id: string;
  readonly stage: string;
  readonly round_ordinal: number;
  readonly map_descriptor: MapDescriptor | null;
}

/** Outcome of one attempt to seal a candidate round. */
type SealAttempt = 'SEALED' | 'BLOCKED' | 'SKIPPED';

/**
 * Encounter statuses that end an encounter without further play. `WALKOVER` and
 * `DOUBLE_WITHDRAWAL` are administrative results written by
 * {@link TournamentAdmissionService.withdrawTeam}: they carry no games, so the per-game hook
 * never fires for them and {@link TournamentSchedulerService.markTerminalRounds} covers them.
 */
function isTerminalEncounterStatus(status: string): boolean {
  return (
    status === 'COMPLETED' ||
    status === 'BYE' ||
    status === 'WALKOVER' ||
    status === 'DOUBLE_WITHDRAWAL'
  );
}

/** Result of a {@link TournamentSchedulerService.sealEligibleRounds} sweep. */
export interface SealSweepResult {
  /** Rounds whose grace window elapsed with no blocker: sealed, next round dispatched. */
  readonly sealed: number;
  /** Rounds held open by an unresolved dispute on one of their encounters; retried later. */
  readonly blocked: number;
}

/**
 * Cancels every encounter after `roundOrdinal` in `stage` (plus the whole PLAYOFF when the stage
 * is not PLAYOFF), cancels their games and pending jobs, drops their ratings and resolves the
 * disputes they carried, then makes `roundOrdinal` seal-eligible again so the schedule can be
 * rebuilt from the reduced field. Shared by result corrections and team disqualification.
 */
async function invalidateDownstream(
  client: pg.PoolClient,
  params: {
    readonly tournamentId: string;
    readonly stage: string;
    readonly roundOrdinal: number;
    /** Encounters that must be treated as affected even though they are not downstream. */
    readonly extraEncounterIds: readonly string[];
  }
): Promise<{ cancelledEncounters: number; cancelledRounds: readonly number[]; invalidatedDisputes: number }> {
    // Unplayed encounters of the rounds this rebuild deletes are replaced outright: keeping them
    // cancelled would leave two rows for the same regenerated slot (a bracket slot must have exactly
    // one). Only rows with no evidence at all — no completed game, no rating, no dispute — qualify.
    const unplayed = await client.query<{ id: string }>(
      `SELECT e.id FROM encounters e
        WHERE e.tournament_id = $1
          AND (
            (e.stage = $2 AND e.round_ordinal > $3)
            OR ($2 <> 'PLAYOFF' AND e.stage = 'PLAYOFF')
          )
          AND e.status IN ('PENDING', 'RUNNING', 'BYE')
          AND NOT EXISTS (SELECT 1 FROM games g WHERE g.encounter_id = e.id AND g.status = 'COMPLETED')
          AND NOT EXISTS (SELECT 1 FROM rating_events r WHERE r.encounter_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.encounter_id = e.id)
        FOR UPDATE`,
      [params.tournamentId, params.stage, params.roundOrdinal]
    );
    if (unplayed.rows.length > 0) {
      const unplayedIds = unplayed.rows.map((row) => row.id);
      await client.query(
        `DELETE FROM jobs
          WHERE job_type = 'GAME'
            AND target_id IN (SELECT id FROM games WHERE encounter_id = ANY($1::uuid[]))`,
        [unplayedIds]
      );
      await client.query(`DELETE FROM encounters WHERE id = ANY($1::uuid[])`, [unplayedIds]);
    }

    const downstream = await client.query<{ id: string; round_ordinal: number }>(
      `SELECT id, round_ordinal
         FROM encounters
        WHERE tournament_id = $1
          AND status <> 'CANCELLED'
          AND (
            (stage = $2 AND round_ordinal > $3)
            OR ($2 <> 'PLAYOFF' AND stage = 'PLAYOFF')
          )
        FOR UPDATE`,
      [params.tournamentId, params.stage, params.roundOrdinal]
    );
    const encounterIds = downstream.rows.map((row) => row.id);
    const cancelledRounds = [...new Set(downstream.rows.map((row) => row.round_ordinal))];

    if (encounterIds.length > 0) {
      await client.query(`UPDATE games SET status = 'CANCELLED' WHERE encounter_id = ANY($1::uuid[])`, [encounterIds]);
      await client.query(`UPDATE encounters SET status = 'CANCELLED' WHERE id = ANY($1::uuid[])`, [encounterIds]);
      await client.query(
        `UPDATE jobs SET state = 'BLOCKED', updated_at = clock_timestamp()
          WHERE job_type = 'GAME'
            AND target_id IN (SELECT id FROM games WHERE encounter_id = ANY($1::uuid[]))
            AND state IN ('QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING', 'RETRY_WAIT')`,
        [encounterIds]
      );
      await client.query(`DELETE FROM rating_events WHERE encounter_id = ANY($1::uuid[])`, [encounterIds]);
    }

    // Disputes against invalidated encounters (and the corrected one) cannot outlive the
    // correction: they would block finalization forever after their round disappears.
    const affectedEncounters = [...encounterIds, ...params.extraEncounterIds];
    const closedDisputes = await client.query(
      `UPDATE disputes
          SET status = 'RESOLVED',
              decision = 'INVALIDATED_BY_CORRECTION',
              resolved_at = clock_timestamp()
        WHERE encounter_id = ANY($1::uuid[])
          AND status IN ('OPEN', 'UNDER_REVIEW')`,
      [affectedEncounters]
    );

    // Drop downstream rounds/snapshots; the corrected round is re-sealed and re-dispatched.
    await client.query(
      `DELETE FROM tournament_rounds
        WHERE tournament_id = $1
          AND (
            (stage = $2 AND round_ordinal > $3)
            OR ($2 <> 'PLAYOFF' AND stage = 'PLAYOFF')
          )`,
      [params.tournamentId, params.stage, params.roundOrdinal]
    );
    await client.query(
      `DELETE FROM standings_snapshots
        WHERE tournament_id = $1
          AND (
            (stage = $2 AND round_ordinal > $3)
            OR ($2 <> 'PLAYOFF' AND stage = 'PLAYOFF')
          )`,
      [params.tournamentId, params.stage, params.roundOrdinal]
    );

    await client.query(
      `UPDATE tournament_rounds
          SET sealed_at = NULL,
              status = 'SEAL_ELIGIBLE',
              last_terminal_at = COALESCE(last_terminal_at, clock_timestamp()),
              seal_eligible_at = clock_timestamp()
        WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
      [params.tournamentId, params.stage, params.roundOrdinal]
    );
    await client.query(
      `UPDATE tournaments
          SET state = 'RUNNING', provisional_at = NULL, updated_at = clock_timestamp()
        WHERE id = $1 AND state IN ('PROVISIONAL', 'FINALIZED')`,
      [params.tournamentId]
    );
    await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
      'ROUND_INVALIDATED',
      JSON.stringify({
        tournamentId: params.tournamentId,
        stage: params.stage,
        roundOrdinal: params.roundOrdinal,
        cancelledEncounters: encounterIds.length,
        cancelledRounds,
        invalidatedDisputes: closedDisputes.rowCount ?? 0,
      }),
    ]);

    return { cancelledEncounters: encounterIds.length, cancelledRounds, invalidatedDisputes: closedDisputes.rowCount ?? 0 };
}

export class TournamentSchedulerService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly jobs: JobBroker,
    private readonly elimination: EliminationFormat = new EliminationFormat(),
    private readonly swiss: SwissFormat = new SwissFormat(),
    private readonly roundRobin: RoundRobinFormat = new RoundRobinFormat(),
    private readonly elo: EloFormat = new EloFormat()
  ) {}

  /**
   * Initializes Round 1 encounters and games upon tournament start.
   *
   * The schedule transaction commits before any GAME job is enqueued: a job must never point
   * at a game row that a rolled-back transaction could have erased.
   */
  async scheduleRound1(tournamentId: string, mapDescriptor: MapDescriptor): Promise<void> {
    const createdGames = await this.db.withTransaction(async (client) => {
      // 1. Fetch tournament format
      const tourneyRes = await client.query<{ format: string }>(
        'SELECT format FROM tournaments WHERE id = $1',
        [tournamentId]
      );
      if (tourneyRes.rows.length === 0) throw new Error(`Tournament not found: ${tournamentId}`);
      const format = tourneyRes.rows[0].format;

      // 2. Fetch eligible teams
      const entriesRes = await client.query<{ team_id: string; seed_ordinal: number }>(
        `SELECT team_id, seed_ordinal FROM tournament_entries
         WHERE tournament_id = $1 AND status = 'ELIGIBLE'
         ORDER BY seed_ordinal ASC`,
        [tournamentId]
      );

      const teams: TeamEntry[] = entriesRes.rows.map((r) => ({
        teamId: r.team_id,
        seedOrdinal: r.seed_ordinal ?? 1,
      }));

      if (teams.length < 2) {
        throw new Error(`Cannot schedule round 1: minimum 2 eligible teams required, found ${teams.length}`);
      }

      // 3. Generate initial schedule
      let schedule: RoundSchedule;
      if (format === 'SINGLE_ELIMINATION') {
        schedule = this.elimination.generateRound1(teams);
      } else if (format === 'SWISS_PLAYOFF') {
        schedule = this.swiss.generateRound1(teams);
      } else if (format === 'ROUND_ROBIN') {
        schedule = this.roundRobin.generateRound(teams, 1);
      } else if (format === 'ELO_ARENA') {
        schedule = this.elo.generateEpoch(teams, new Map(), new Map(), 1, new Map());
      } else {
        throw new Error(`Unsupported tournament format: ${format}`);
      }

      // 4. Persist schedule
      return this.persistSchedule(client, tournamentId, schedule, mapDescriptor, format);
    });

    await this.enqueueGameJobs(tournamentId, createdGames);
  }

  /**
   * Handles completion of a game: scores its encounter and, when that was the round's last
   * terminal encounter, marks the round seal-eligible.
   *
   * It deliberately does not advance the round. A round's results are only frozen — and the
   * next round generated — by `sealEligibleRounds` once `seal_eligible_at` has passed with no
   * open dispute against the round, so the grace window stays usable.
   *
   * This call schedules nothing, but it keeps the `CompletionOutcome` shape: a retried or
   * replayed completion must not enqueue duplicate work.
   */
  async handleGameCompletion(gameId: string): Promise<void> {
    const outcome = await this.db.withTransaction(async (client): Promise<CompletionOutcome> => {
      // Find encounter for this game
      const gameRes = await client.query<{
        encounter_id: string;
        tournament_id: string;
        stage: string;
        round_ordinal: number;
      }>(
        `SELECT g.encounter_id, e.tournament_id, e.stage, e.round_ordinal
         FROM games g
         JOIN encounters e ON g.encounter_id = e.id
         WHERE g.id = $1`,
        [gameId]
      );

      if (gameRes.rows.length === 0) return { tournamentId: null, createdGames: [] };
      const { encounter_id, tournament_id, stage, round_ordinal } = gameRes.rows[0];

      // Idempotency: when this game's round is already sealed, the call is a replay (a
      // reclaimed lease re-running the same game). Scoring the encounter, advancing the round
      // and emitting progression events were all done when the round completed, so there is
      // nothing left to do — and doing it again would duplicate the next round's bracket.
      const roundStateRes = await client.query<{ status: string }>(
        `SELECT status FROM tournament_rounds
         WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
        [tournament_id, stage, round_ordinal]
      );
      if (roundStateRes.rows[0]?.status === 'COMPLETED') {
        return { tournamentId: tournament_id, createdGames: [] };
      }

      // Check if all games for this encounter are COMPLETED
      const allGamesRes = await client.query<{
        id: string;
        game_ordinal: number;
        white_team_id: string;
        black_team_id: string;
        status: string;
        winner: number | null;
      }>(
        `SELECT g.id, g.game_ordinal, g.white_team_id, g.black_team_id, g.status, rv.winner
         FROM games g
         LEFT JOIN accepted_results ar ON g.id = ar.game_id
         LEFT JOIN result_versions rv ON ar.result_version_id = rv.id
         WHERE g.encounter_id = $1
         ORDER BY g.game_ordinal ASC`,
        [encounter_id]
      );

      const allCompleted = allGamesRes.rows.every((g) => g.status === 'COMPLETED');
      if (!allCompleted) return { tournamentId: tournament_id, createdGames: [] };

      // Fetch encounter details
      const encRes = await client.query<{
        team_a_id: string;
        team_b_id: string | null;
      }>('SELECT team_a_id, team_b_id FROM encounters WHERE id = $1', [encounter_id]);

      const { team_a_id, team_b_id } = encRes.rows[0];
      if (!team_b_id) return { tournamentId: tournament_id, createdGames: [] }; // Already a bye

      let winsA = 0;
      let winsB = 0;

      for (const g of allGamesRes.rows) {
        if (g.winner === 1) {
          // White won
          if (g.white_team_id === team_a_id) winsA++;
          else winsB++;
        } else if (g.winner === 2) {
          // Black won
          if (g.black_team_id === team_a_id) winsA++;
          else winsB++;
        }
      }

      let winnerTeamId: string | null = null;
      let pointsA = 1.0;
      let pointsB = 1.0;

      if (winsA > winsB) {
        winnerTeamId = team_a_id;
        pointsA = 3.0;
        pointsB = 0.0;
      } else if (winsB > winsA) {
        winnerTeamId = team_b_id;
        pointsA = 0.0;
        pointsB = 3.0;
      } else {
        // Knockout draw: advance the better seed unless every game was a no-contest.
        const formatRes = await client.query<{ format: string }>(
          'SELECT format FROM tournaments WHERE id = $1',
          [tournament_id]
        );
        const format = formatRes.rows[0]?.format ?? '';
        const everyGameNoContest = allGamesRes.rows.every((game) => game.winner === null);
        if (!everyGameNoContest && (format === 'SINGLE_ELIMINATION' || stage === 'PLAYOFF')) {
          const seedRes = await client.query<{ team_id: string; seed_ordinal: number | null }>(
            `SELECT team_id, seed_ordinal FROM tournament_entries
             WHERE tournament_id = $1 AND team_id = ANY($2::uuid[])`,
            [tournament_id, [team_a_id, team_b_id]]
          );
          const seedOf = (teamId: string) => seedRes.rows.find((row) => row.team_id === teamId)?.seed_ordinal ?? null;
          const seedA = seedOf(team_a_id);
          const seedB = seedOf(team_b_id);
          if (seedA !== null && seedB !== null && seedA !== seedB) {
            winnerTeamId = seedA < seedB ? team_a_id : team_b_id;
          }
        }
      }

      // Update encounter
      await client.query(
        `UPDATE encounters
         SET status = 'COMPLETED',
             winner_team_id = $1,
             points_a = $2,
             points_b = $3
         WHERE id = $4`,
        [winnerTeamId, pointsA, pointsB, encounter_id]
      );

      // Check if all encounters in this round are completed
      const allEncRes = await client.query<{ status: string }>(
        `SELECT status FROM encounters
         WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3
           AND status <> 'CANCELLED'`,
        [tournament_id, stage, round_ordinal]
      );

      const roundComplete = allEncRes.rows.every((e) => isTerminalEncounterStatus(e.status));

      if (roundComplete) {
        // The round is now *eligible* to seal, not sealed: the grace window exists so a
        // dispute or correction can still land before the next round's bracket is generated.
        // `sealEligibleRounds` (the worker's sweep) owns the transition and the dispatch.
        await this.markRoundSealEligible(client, tournament_id, stage, round_ordinal);
      }
      return { tournamentId: tournament_id, createdGames: [] };
    });

    if (outcome.tournamentId) {
      await this.enqueueGameJobs(outcome.tournamentId, outcome.createdGames);
    }
  }

  /**
   * Invalidates every round that depended on the encounter of `gameId` after a correction.
   *
   * Downstream encounters are cancelled (their games and pending jobs too), later rounds and
   * their standings/rating snapshots are removed, the corrected round is made seal-eligible
   * again and the tournament is put back into RUNNING so the worker re-dispatches from here.
   * The correction service calls this before rescoring the corrected encounter.
   */
  async invalidateAfterGame(gameId: string): Promise<{
    tournamentId: string;
    stage: string;
    roundOrdinal: number;
    cancelledEncounters: number;
  } | null> {
    return this.db.withTransaction(async (client) => {
      const gameRes = await client.query<{
        tournament_id: string;
        stage: string;
        round_ordinal: number;
        encounter_id: string;
      }>(
        `SELECT e.tournament_id, e.stage, e.round_ordinal, e.id AS encounter_id
           FROM games g
           JOIN encounters e ON e.id = g.encounter_id
          WHERE g.id = $1`,
        [gameId]
      );
      const game = gameRes.rows[0];
      if (!game) return null;

      const invalidated = await invalidateDownstream(client, {
        tournamentId: game.tournament_id,
        stage: game.stage,
        roundOrdinal: game.round_ordinal,
        extraEncounterIds: [game.encounter_id],
      });
      return {
        tournamentId: game.tournament_id,
        stage: game.stage,
        roundOrdinal: game.round_ordinal,
        cancelledEncounters: invalidated.cancelledEncounters,
      };
    });
  }

  /**
   * Seals every round whose grace window has elapsed and dispatches its next round.
   *
   * The worker tick calls this before claiming games, so the games a seal creates are claimable
   * right away and a whole tournament runs with no organizer action.
   *
   * Candidates are unsealed rounds of RUNNING tournaments whose `seal_eligible_at` has passed,
   * oldest first, capped at `limit`. A round is *blocked* — counted, left eligible, retried on
   * the next sweep — while any of its encounters carries a dispute still OPEN or UNDER_REVIEW:
   * freezing a contested result into the bracket is exactly what the window exists to prevent.
   */
  /**
   * Marks every unfinished round whose encounters are all terminal as seal-eligible.
   *
   * A withdrawal resolves its encounters administratively, so no game completion ever announces
   * that the round is over; without this sweep a round made entirely of walkovers would stall.
   * Sealing itself (grace window, disputes, dispatch) stays with {@link sealEligibleRounds}.
   */
  /**
   * Cancels everything scheduled after `roundOrdinal` in `stage` and re-opens that round, so the
   * schedule is rebuilt from the reduced field. Disqualification uses this; the corrected-round
   * path (`invalidateAfterGame`) keeps its own dispute/evidence semantics.
   */
  async invalidateAfterRound(
    tournamentId: string,
    stage: string,
    roundOrdinal: number
  ): Promise<{ cancelledEncounters: number; cancelledRounds: readonly number[] }> {
    const result = await this.db.withTransaction((client) =>
      invalidateDownstream(client, { tournamentId, stage, roundOrdinal, extraEncounterIds: [] })
    );
    return { cancelledEncounters: result.cancelledEncounters, cancelledRounds: result.cancelledRounds };
  }

  async markTerminalRounds(tournamentId: string): Promise<number> {
    return this.db.withTransaction(async (client) => {
      const rounds = await client.query<{ stage: string; round_ordinal: number }>(
        `SELECT stage, round_ordinal FROM tournament_rounds
         WHERE tournament_id = $1 AND status <> 'COMPLETED'
         ORDER BY round_ordinal ASC`,
        [tournamentId]
      );
      let marked = 0;
      for (const round of rounds.rows) {
        const statuses = await client.query<{ status: string }>(
          `SELECT status FROM encounters
           WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3
             AND status <> 'CANCELLED'`,
          [tournamentId, round.stage, round.round_ordinal]
        );
        if (statuses.rows.length === 0) continue;
        if (!statuses.rows.every((row) => isTerminalEncounterStatus(row.status))) continue;
        await this.markRoundSealEligible(client, tournamentId, round.stage, round.round_ordinal);
        marked++;
      }
      return marked;
    });
  }

  async sealEligibleRounds(limit = DEFAULT_SEAL_BATCH): Promise<SealSweepResult> {
    const candidates = await this.db.query<SealCandidate>(
      `SELECT r.tournament_id, r.stage, r.round_ordinal,
              (SELECT g.map_descriptor
                 FROM games g
                 JOIN encounters e ON e.id = g.encounter_id
                WHERE e.tournament_id = r.tournament_id AND e.stage = r.stage
                ORDER BY e.round_ordinal ASC, g.game_ordinal ASC
                LIMIT 1) AS map_descriptor
         FROM tournament_rounds r
         JOIN tournaments t ON t.id = r.tournament_id
        WHERE t.state = 'RUNNING'
          AND r.sealed_at IS NULL
          AND r.seal_eligible_at IS NOT NULL
          AND r.seal_eligible_at <= clock_timestamp()
        ORDER BY r.seal_eligible_at ASC
        LIMIT $1`,
      [limit]
    );

    let sealed = 0;
    let blocked = 0;
    for (const candidate of candidates.rows) {
      const attempt = await this.sealRound(candidate);
      if (attempt === 'SEALED') sealed++;
      else if (attempt === 'BLOCKED') blocked++;
    }
    return { sealed, blocked };
  }

  /**
   * Marks a round whose last encounter just went terminal as seal-eligible.
   *
   * The window is anchored to the *first* terminal observation: a replayed completion (a
   * reclaimed lease, a retried correction) must not push `seal_eligible_at` further out, so both
   * timestamps are written with COALESCE. Only the transition into SEAL_ELIGIBLE emits
   * ROUND_COMPLETED, which keeps the announcement one-shot.
   */
  private async markRoundSealEligible(
    client: pg.PoolClient,
    tournamentId: string,
    stage: string,
    roundOrdinal: number
  ): Promise<void> {
    const marked = await client.query<{ seal_eligible_at: Date }>(
      `UPDATE tournament_rounds AS r
          SET status = 'SEAL_ELIGIBLE',
              last_terminal_at = COALESCE(r.last_terminal_at, clock_timestamp()),
              seal_eligible_at = COALESCE(
                r.seal_eligible_at,
                clock_timestamp() + t.grace_period_minutes * interval '1 minute'
              )
         FROM tournaments AS t
        WHERE t.id = r.tournament_id
          AND r.tournament_id = $1
          AND r.stage = $2
          AND r.round_ordinal = $3
          AND r.sealed_at IS NULL
          AND r.status <> 'SEAL_ELIGIBLE'
      RETURNING r.seal_eligible_at`,
      [tournamentId, stage, roundOrdinal]
    );
    if (marked.rows.length === 0) return;

    await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
      'ROUND_COMPLETED',
      JSON.stringify({
        tournamentId,
        stage,
        roundOrdinal,
        sealEligibleAt: marked.rows[0].seal_eligible_at.toISOString(),
      }),
    ]);
  }

  /**
   * One seal attempt, in its own transaction: lock the round row, refuse while a dispute on this
   * round is unresolved, otherwise seal it and dispatch what follows. The row lock is what keeps
   * two workers sweeping at once from sealing — and scheduling — the same round twice.
   */
  private async sealRound(candidate: SealCandidate): Promise<SealAttempt> {
    const mapDescriptor = candidate.map_descriptor;
    if (!mapDescriptor) {
      // A stage whose rounds hold no games at all has no map to schedule the next round with, so
      // sealing it could only emit a round whose games cannot be built. Byes are the only way to
      // get here and a stage that still has rounds to play always has games, so this stays a
      // warning instead of a state change: the round keeps its eligibility for a later sweep.
      console.warn(
        `[scheduler] round ${candidate.tournament_id}/${candidate.stage}/${candidate.round_ordinal} has no games; seal deferred`
      );
      return 'SKIPPED';
    }

    let createdGames: readonly CreatedGameRef[] | null | undefined;
    try {
      createdGames = await this.db.withTransaction(
        async (client): Promise<readonly CreatedGameRef[] | null | undefined> => {
        const locked = await client.query(
          `SELECT tournament_id FROM tournament_rounds
            WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3 AND sealed_at IS NULL
            FOR UPDATE`,
          [candidate.tournament_id, candidate.stage, candidate.round_ordinal]
        );
        if (locked.rows.length === 0) return null; // sealed by a concurrent sweep

        const openDisputes = await client.query(
          `SELECT d.id
             FROM disputes d
             JOIN encounters e ON e.id = d.encounter_id
            WHERE e.tournament_id = $1 AND e.stage = $2 AND e.round_ordinal = $3
              AND d.status IN ('OPEN', 'UNDER_REVIEW')
            LIMIT 1`,
          [candidate.tournament_id, candidate.stage, candidate.round_ordinal]
        );
        if (openDisputes.rows.length > 0) return undefined; // blocked: retry on a later sweep

        return this.advanceRound(
          client,
          candidate.tournament_id,
          candidate.stage,
          candidate.round_ordinal,
          mapDescriptor
        );
        }
      );
    } catch (err) {
      if (!(err instanceof PairingSolverError)) throw err;
      // The exact pairing solver could not prove an optimum inside its budget. The transaction rolled
      // back, so the round stays unsealed and a later sweep retries; the pairing is never degraded
      // (02-GAMEPLAY §79/§102: timeout/error -> BLOCKED_PAIRING) and the organizer is told once why.
      const existing = await this.db.query<{ one: number }>(
        `SELECT 1 AS one FROM outbox_events
          WHERE topic = 'ROUND_SEAL_BLOCKED'
            AND payload->>'tournamentId' = $1
            AND payload->>'stage' = $2
            AND payload->>'roundOrdinal' = $3
          LIMIT 1`,
        [candidate.tournament_id, candidate.stage, String(candidate.round_ordinal)]
      );
      if (existing.rows.length === 0) {
        await this.db.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'ROUND_SEAL_BLOCKED',
          JSON.stringify({
            tournamentId: candidate.tournament_id,
            stage: candidate.stage,
            roundOrdinal: candidate.round_ordinal,
            reason: 'BLOCKED_PAIRING',
          }),
        ]);
      }
      return 'BLOCKED';
    }

    if (createdGames === null) return 'SKIPPED';
    if (createdGames === undefined) return 'BLOCKED';

    await this.enqueueGameJobs(candidate.tournament_id, createdGames);
    return 'SEALED';
  }

  /**
   * Turns created games into GAME jobs. Runs after the scheduling transaction committed and
   * is idempotent (one job per game), so a retried round transition cannot double-queue.
   */
  private async enqueueGameJobs(tournamentId: string, games: readonly CreatedGameRef[]): Promise<void> {
    for (const game of games) {
      await this.jobs.enqueueIfAbsent('GAME', game.gameId, GAME_JOB_PRIORITY, {
        tournamentId,
        encounterId: game.encounterId,
        gameOrdinal: game.gameOrdinal,
      });
    }
  }

  /**
   * Seals an eligible round and dispatches whatever follows it: the next round, the Swiss
   * playoff stage, the Elo epoch's standings, or the tournament's PROVISIONAL state. The format
   * branches themselves are unchanged from the pre-grace scheduler.
   *
   * Only `sealRound` may call this: the round must already be locked and clear of open disputes.
   */
  private async advanceRound(
    client: pg.PoolClient,
    tournamentId: string,
    stage: string,
    roundOrdinal: number,
    mapDescriptor: MapDescriptor
  ): Promise<readonly CreatedGameRef[]> {
    // 1. Seal the round: its results are frozen from here on, and this timestamp is what keeps
    // every other sweep off the row.
    await client.query(
      `UPDATE tournament_rounds
       SET status = 'COMPLETED',
           sealed_at = clock_timestamp()
       WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
      [tournamentId, stage, roundOrdinal]
    );

    await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
      'ROUND_SEALED',
      JSON.stringify({ tournamentId, stage, roundOrdinal }),
    ]);

    // 2. Fetch tournament format and all teams
    const tourneyRes = await client.query<{ format: string }>(
      'SELECT format FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    const format = tourneyRes.rows[0].format;

    const entriesRes = await client.query<{ team_id: string; seed_ordinal: number }>(
      `SELECT team_id, seed_ordinal FROM tournament_entries
       WHERE tournament_id = $1 AND status = 'ELIGIBLE'
       ORDER BY seed_ordinal ASC`,
      [tournamentId]
    );
    const teams: TeamEntry[] = entriesRes.rows.map((r) => ({
      teamId: r.team_id,
      seedOrdinal: r.seed_ordinal ?? 1,
    }));

    // 3. Fetch completed encounters for this stage/tournament
    const encHistoryRes = await client.query<{
      id: string;
      round_ordinal: number;
      slot_ordinal: number;
      team_a_id: string;
      team_b_id: string | null;
      winner_team_id: string | null;
      points_a: string;
      points_b: string;
      status: string;
    }>(
      `SELECT id, round_ordinal, slot_ordinal, team_a_id, team_b_id, winner_team_id, points_a, points_b, status
       FROM encounters
       WHERE tournament_id = $1 AND stage = $2
         AND status IN ('COMPLETED', 'BYE', 'WALKOVER', 'DOUBLE_WITHDRAWAL')
       ORDER BY round_ordinal ASC, slot_ordinal ASC`,
      [tournamentId, stage]
    );

    const completedEncounters: CompletedEncounterRecord[] = encHistoryRes.rows.map((r) => ({
      encounterId: r.id,
      roundOrdinal: r.round_ordinal,
      slotOrdinal: r.slot_ordinal,
      status: r.status,
      teamAId: r.team_a_id,
      teamBId: r.team_b_id ?? undefined,
      winnerTeamId: r.winner_team_id ?? undefined,
      pointsA: parseFloat(r.points_a),
      pointsB: parseFloat(r.points_b),
    }));

    // 4. Format-specific branch
    if (format === 'SINGLE_ELIMINATION' || stage === 'PLAYOFF') {
      // A knockout encounter without a winner (all games NO_CONTEST / double forfeit) cannot
      // advance anybody: fabricating a side would decide the title from nothing.
      const unresolved = completedEncounters.filter(
        (encounter) => encounter.roundOrdinal === roundOrdinal && encounter.teamBId !== undefined && !encounter.winnerTeamId
      );
      if (unresolved.length > 0) {
        await client.query(
          `UPDATE tournaments
          SET state = 'PROVISIONAL',
              provisional_at = COALESCE(provisional_at, clock_timestamp()),
              updated_at = clock_timestamp()
          WHERE id = $1`,
          [tournamentId]
        );
        await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'TOURNAMENT_PROVISIONAL',
          JSON.stringify({ tournamentId, stage }),
        ]);
        await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'TOURNAMENT_NO_CHAMPION',
          JSON.stringify({ tournamentId, stage, roundOrdinal, reason: 'UNRESOLVED_ENCOUNTER' }),
        ]);
        return [];
      }

      const slotCountRes = await client.query<{ slot_count: number }>(
        `SELECT slot_count FROM tournament_rounds
          WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
        [tournamentId, stage, roundOrdinal]
      );
      const previousSlotCount = slotCountRes.rows[0]?.slot_count ?? 0;
      const nextSchedule = this.elimination.generateNextRound(
        completedEncounters,
        roundOrdinal,
        stage,
        previousSlotCount
      );
      if (!nextSchedule) {
        // Elimination bracket is complete!
        await client.query(
          `UPDATE tournaments
          SET state = 'PROVISIONAL',
              provisional_at = COALESCE(provisional_at, clock_timestamp()),
              updated_at = clock_timestamp()
          WHERE id = $1`,
          [tournamentId]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
          ['TOURNAMENT_PROVISIONAL', JSON.stringify({ tournamentId, stage })]
        );
        // No next round means the bracket is over. It only crowned a champion when some encounter
        // of the last round actually produced a winner; otherwise the title stays unassigned —
        // including the case where both final slots were EMPTY and no row exists at all.
        const finalEncounters = completedEncounters.filter((encounter) => encounter.roundOrdinal === roundOrdinal);
        if (finalEncounters.length === 0 || finalEncounters.every((encounter) => !encounter.winnerTeamId)) {
          await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
            'TOURNAMENT_NO_CHAMPION',
            JSON.stringify({
              tournamentId,
              stage,
              roundOrdinal,
              reason: finalEncounters.length === 0 ? 'EMPTY_FINAL' : 'FINAL_NO_CONTEST',
            }),
          ]);
        }
        return [];
      }
      return this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor, format);
    } else if (format === 'SWISS_PLAYOFF') {
      const totalSwissRounds = this.swiss.calculateRounds(teams.length);
      const standings = this.swiss.computeStandings(teams, completedEncounters);

      // Record standings snapshot
      for (const s of standings) {
        await client.query(
          `INSERT INTO standings_snapshots (
             tournament_id, stage, round_ordinal, team_id, rank, points,
             matches_played, wins, draws, losses, buchholz, sonneborn_berger
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (tournament_id, stage, round_ordinal, team_id) DO UPDATE
           SET rank = EXCLUDED.rank, points = EXCLUDED.points`,
          [
            tournamentId,
            stage,
            roundOrdinal,
            s.teamId,
            s.rank,
            s.points,
            s.matchesPlayed,
            s.wins,
            s.draws,
            s.losses,
            s.buchholz ?? 0,
            s.sonnebornBerger ?? 0,
          ]
        );
      }

      if (roundOrdinal < totalSwissRounds) {
        // Next Swiss round
        const nextSchedule = this.swiss.generateNextRound(teams, completedEncounters, roundOrdinal);
        return this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor, format);
      } else {
        // Swiss completed! Auto-qualify top T into PLAYOFF stage
        const cutoff = this.swiss.calculatePlayoffCutoff(teams.length);
        const topTeams = standings.slice(0, cutoff).map((s) => ({
          teamId: s.teamId,
          seedOrdinal: s.rank,
        }));

        // Mark qualified in standings
        for (const t of topTeams) {
          await client.query(
            `UPDATE standings_snapshots SET is_qualified = TRUE
             WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3 AND team_id = $4`,
            [tournamentId, stage, roundOrdinal, t.teamId]
          );
        }

        // The locked draw keeps its structural width: with fewer active qualifiers than the cutoff,
        // the missing ranks stay EMPTY slots instead of shrinking the bracket.
        const playoffSlots = EliminationFormat.slotCountFor(cutoff);
        const playoffRound1 = this.elimination.generateRound1(topTeams, 'PLAYOFF', playoffSlots);
        return this.persistSchedule(client, tournamentId, playoffRound1, mapDescriptor, format);
      }
    } else if (format === 'ROUND_ROBIN') {
      const totalRounds = this.roundRobin.calculateTotalRounds(teams.length);
      const standings = this.roundRobin.computeStandings(teams, completedEncounters);

      for (const s of standings) {
        await client.query(
          `INSERT INTO standings_snapshots (
             tournament_id, stage, round_ordinal, team_id, rank, points,
             matches_played, wins, draws, losses
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (tournament_id, stage, round_ordinal, team_id) DO UPDATE
           SET rank = EXCLUDED.rank, points = EXCLUDED.points`,
          [tournamentId, stage, roundOrdinal, s.teamId, s.rank, s.points, s.matchesPlayed, s.wins, s.draws, s.losses]
        );
      }

      if (roundOrdinal < totalRounds) {
        const nextSchedule = this.roundRobin.generateRound(teams, roundOrdinal + 1);
        return this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor, format);
      } else {
        // RR complete
        await client.query(
          `UPDATE tournaments
          SET state = 'PROVISIONAL',
              provisional_at = COALESCE(provisional_at, clock_timestamp()),
              updated_at = clock_timestamp()
          WHERE id = $1`,
          [tournamentId]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
          ['TOURNAMENT_PROVISIONAL', JSON.stringify({ tournamentId, stage })]
        );
        return [];
      }
    } else if (format === 'ELO_ARENA') {
      const totalEpochs = this.elo.calculateEpochs(teams.length);

      // Compute and record Elo deltas for each encounter in this epoch
      const currentRatings = new Map<string, number>();
      for (const t of teams) currentRatings.set(t.teamId, this.elo.INITIAL_RATING);

      // Load previous ratings
      const prevEvents = await client.query<{ team_id: string; post_rating: string }>(
        `SELECT DISTINCT ON (team_id) team_id, post_rating
         FROM rating_events
         WHERE tournament_id = $1
         ORDER BY team_id, epoch DESC`,
        [tournamentId]
      );
      for (const r of prevEvents.rows) {
        currentRatings.set(r.team_id, parseFloat(r.post_rating));
      }

      const epochEncounters = completedEncounters.filter((e) => e.roundOrdinal === roundOrdinal);
      for (const enc of epochEncounters) {
        if (!enc.teamBId) continue;
        // Walkovers and double withdrawals are unplayed: they never move ratings.
        if (enc.status === 'WALKOVER' || enc.status === 'DOUBLE_WITHDRAWAL') continue;
        const rA = currentRatings.get(enc.teamAId) ?? this.elo.INITIAL_RATING;
        const rB = currentRatings.get(enc.teamBId) ?? this.elo.INITIAL_RATING;

        const deltas = this.elo.calculateDeltas(rA, rB, enc.pointsA, enc.pointsB);

        await client.query(
          `INSERT INTO rating_events (tournament_id, encounter_id, team_id, epoch, pre_rating, delta, post_rating)
           VALUES ($1, $2, $3, $4, $5, $6, $7),
                  ($1, $2, $8, $4, $9, $10, $11)
           ON CONFLICT (tournament_id, encounter_id, team_id) DO NOTHING`,
          [
            tournamentId,
            enc.encounterId,
            enc.teamAId,
            roundOrdinal,
            rA,
            deltas.deltaA,
            deltas.postRatingA,
            enc.teamBId,
            rB,
            deltas.deltaB,
            deltas.postRatingB,
          ]
        );

        currentRatings.set(enc.teamAId, deltas.postRatingA);
        currentRatings.set(enc.teamBId, deltas.postRatingB);
      }

      // Record standings
      const sortedRatings = Array.from(currentRatings.entries()).sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < sortedRatings.length; i++) {
        const [teamId, rating] = sortedRatings[i];
        await client.query(
          `INSERT INTO standings_snapshots (
             tournament_id, stage, round_ordinal, team_id, rank, points, rating_elo
           ) VALUES ($1, $2, $3, $4, $5, 0, $6)
           ON CONFLICT (tournament_id, stage, round_ordinal, team_id) DO UPDATE
           SET rank = EXCLUDED.rank, rating_elo = EXCLUDED.rating_elo`,
          [tournamentId, stage, roundOrdinal, teamId, i + 1, rating]
        );
      }

      if (roundOrdinal < totalEpochs) {
        // The Elo objective counts prior encounters per opponent (not just "played before"), and the
        // bye rule needs each team's bye count (02-GAMEPLAY §102).
        const priorEncounters = new Map<string, number>();
        const byeCounts = new Map<string, number>();
        for (const e of completedEncounters) {
          if (e.teamBId) {
            for (const key of [`${e.teamAId}:${e.teamBId}`, `${e.teamBId}:${e.teamAId}`]) {
              priorEncounters.set(key, (priorEncounters.get(key) ?? 0) + 1);
            }
          } else {
            byeCounts.set(e.teamAId, (byeCounts.get(e.teamAId) ?? 0) + 1);
          }
        }
        const nextSchedule = this.elo.generateEpoch(teams, currentRatings, priorEncounters, roundOrdinal + 1, byeCounts);
        return this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor, format);
      } else {
        // Elo complete
        await client.query(
          `UPDATE tournaments
          SET state = 'PROVISIONAL',
              provisional_at = COALESCE(provisional_at, clock_timestamp()),
              updated_at = clock_timestamp()
          WHERE id = $1`,
          [tournamentId]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
          ['TOURNAMENT_PROVISIONAL', JSON.stringify({ tournamentId, stage })]
        );
        return [];
      }
    }

    // No schedule was produced for this stage/format; the round is simply sealed.
    return [];
  }

  /**
   * Atomically records a round schedule, creating encounters and 2 games per encounter.
   * Returns the created games so the caller can enqueue their GAME jobs after commit.
   */
  /**
   * The tournament's frozen map pool in pinned order (02-GAMEPLAY §153). The version was pinned when
   * the map joined the pool and re-pinned at lock, so a map published later cannot rewrite a frozen
   * tournament. An empty pool falls back to the single descriptor the caller resolved.
   */
  private async resolveStageMapPool(
    client: pg.PoolClient,
    tournamentId: string,
    fallback: MapDescriptor
  ): Promise<MapDescriptor[]> {
    const res = await client.query<{ descriptor: MapDescriptor }>(
      `SELECT mv.descriptor
         FROM tournament_map_pool p
         JOIN maps m ON m.id = p.map_id
         JOIN map_versions mv
           ON mv.map_id = p.map_id
          AND mv.version = COALESCE(p.map_version, m.current_version)
        WHERE p.tournament_id = $1
        ORDER BY p.created_at ASC, p.map_id ASC`,
      [tournamentId]
    );
    const pool = res.rows.map((row) => row.descriptor);
    return pool.length > 0 ? pool : [fallback];
  }

  private async persistSchedule(
    client: pg.PoolClient,
    tournamentId: string,
    schedule: RoundSchedule,
    mapDescriptor: MapDescriptor,
    format: string
  ): Promise<readonly CreatedGameRef[]> {
    // A knockout series must not repeat a map version across its games (02-GAMEPLAY §153): the games
    // take the frozen pool in pinned order, cycling if the series has more games than the pool.
    // Round-robin/Elo play one map per encounter, and a pool-less fixture keeps the caller's map.
    const knockoutStage = schedule.stage === 'PLAYOFF' || format === 'SINGLE_ELIMINATION';
    const mapRotation = knockoutStage
      ? await this.resolveStageMapPool(client, tournamentId, mapDescriptor)
      : [mapDescriptor];

    // 1. Insert round record. The round row is the dedup key: if this
    // (tournament, stage, round) was already scheduled, its encounters and games exist, and
    // re-inserting them would duplicate the bracket. Returning nothing makes every caller
    // (retried round transition, replayed game completion) safe to re-run.
    const roundRes = await client.query<{ tournament_id: string }>(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status, slot_count)
       VALUES ($1, $2, $3, 'RUNNING', $4)
       ON CONFLICT (tournament_id, stage, round_ordinal) DO NOTHING
       RETURNING tournament_id`,
      [tournamentId, schedule.stage, schedule.roundOrdinal, schedule.slotCount ?? schedule.pairings.length]
    );
    if (roundRes.rows.length === 0) return [];

    // 2. Insert encounters & games
    const createdGames: CreatedGameRef[] = [];
    for (const p of schedule.pairings) {
      const encRes = await client.query<{ id: string }>(
        `INSERT INTO encounters (
           tournament_id, stage, round_ordinal, slot_ordinal,
           team_a_id, team_b_id, status, winner_team_id, points_a, points_b
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          tournamentId,
          schedule.stage,
          schedule.roundOrdinal,
          p.slotOrdinal,
          p.teamAId,
          p.teamBId ?? null,
          p.isBye ? 'BYE' : 'RUNNING',
          p.isBye ? p.teamAId : null,
          p.isBye ? 3.0 : 0.0,
          0.0,
        ]
      );

      const encounterId = encRes.rows[0].id;

      if (!p.isBye && p.teamBId) {
        // Knockout stages play 4 games on the same map with swapped sides; other formats play 2.
        const gamesPerEncounter = format === 'SINGLE_ELIMINATION' || schedule.stage === 'PLAYOFF' ? 4 : 2;
        for (let ordinal = 1; ordinal <= gamesPerEncounter; ordinal++) {
          const teamAIsWhite = ordinal % 2 === 1;
          const gameRes = await client.query<{ id: string }>(
            `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
             VALUES ($1, $2, $3, $4, $5, 'RUNNING')
             RETURNING id`,
            [
              encounterId,
              ordinal,
              teamAIsWhite ? p.teamAId : p.teamBId,
              teamAIsWhite ? p.teamBId : p.teamAId,
              mapRotation[(ordinal - 1) % mapRotation.length],
            ]
          );
          createdGames.push({ gameId: gameRes.rows[0].id, encounterId, gameOrdinal: ordinal });
        }
      }
    }

    // 3. Emit outbox event
    await client.query(
      `INSERT INTO outbox_events (topic, payload)
       VALUES ($1, $2)`,
      [
        'ROUND_SCHEDULED',
        JSON.stringify({
          tournamentId,
          stage: schedule.stage,
          roundOrdinal: schedule.roundOrdinal,
          pairingsCount: schedule.pairings.length,
        }),
      ]
    );

    return createdGames;
  }
}
