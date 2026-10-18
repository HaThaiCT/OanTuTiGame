/**
 * GAME job plumbing shared by the three places that need to agree on what "runnable" means:
 *
 * - `TournamentSchedulerService` enqueues one job per game it just persisted (after commit),
 * - the autonomous worker bootstraps jobs for games that have none and narrows each claim to
 *   the games that are runnable right now,
 * - the organizer route (`runPendingGames`) does the same for a single tournament.
 *
 * Runnable = a PENDING/RUNNING game of a tournament in state RUNNING, in schedule order
 * (round, slot, game ordinal) — plus a COMPLETED game that still has an unfinished job. That
 * last case is how a crash between recording a result and completing its job converges: the
 * game is no longer playable, but its job is still claimable, so the executor replays it as
 * ALREADY_COMPLETED and finishes the round advance the crash interrupted. Restricting the
 * claim *before* leasing is what keeps a PAUSED tournament's jobs queued and un-leased instead
 * of burning an attempt per tick.
 */

import type { UUID } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import type { JobBroker } from './broker.js';

/** Priority of GAME jobs: one baseline, so claims follow schedule (FIFO) order. */
export const GAME_JOB_PRIORITY = 100;

/** Upper bound on one bootstrap scan so a huge backlog cannot stall a worker tick. */
export const DEFAULT_RUNNABLE_GAMES_LIMIT = 200;

export interface RunnableGameRef {
  readonly gameId: UUID;
  readonly encounterId: UUID;
  readonly gameOrdinal: number;
  readonly tournamentId: UUID;
}

export interface RunnableGamesOptions {
  /** Restrict the scan to one tournament (organizer-requested runs). */
  readonly tournamentId?: string;
  /** Maximum games returned; defaults to {@link DEFAULT_RUNNABLE_GAMES_LIMIT}. */
  readonly limit?: number;
}

interface RunnableGameRow {
  readonly game_id: string;
  readonly encounter_id: string;
  readonly game_ordinal: number;
  readonly tournament_id: string;
}

const RUNNABLE_GAMES_SELECT = `SELECT g.id AS game_id, g.encounter_id, g.game_ordinal, e.tournament_id
   FROM games g
   JOIN encounters e ON e.id = g.encounter_id
   JOIN tournaments t ON t.id = e.tournament_id
   WHERE t.state = 'RUNNING'
     AND g.status <> 'CANCELLED'
     AND (
       g.status IN ('PENDING', 'RUNNING')
       OR EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.job_type = 'GAME' AND j.target_id = g.id
           AND j.state IN ('QUEUED', 'RETRY_WAIT')
       )
     )
     AND ($1::uuid IS NULL OR e.tournament_id = $1)`;

const RUNNABLE_GAMES_ORDER = `ORDER BY e.round_ordinal ASC, e.slot_ordinal ASC, g.game_ordinal ASC, g.id ASC
   LIMIT $2`;

/** PENDING/RUNNING games of RUNNING tournaments, in schedule order. */
export async function listRunnableGames(
  db: PostgresDatabase,
  options: RunnableGamesOptions = {}
): Promise<RunnableGameRef[]> {
  const res = await db.query<RunnableGameRow>(
    `${RUNNABLE_GAMES_SELECT}
   ${RUNNABLE_GAMES_ORDER}`,
    [options.tournamentId ?? null, options.limit ?? DEFAULT_RUNNABLE_GAMES_LIMIT]
  );
  return res.rows.map((row) => ({
    gameId: row.game_id,
    encounterId: row.encounter_id,
    gameOrdinal: row.game_ordinal,
    tournamentId: row.tournament_id,
  }));
}

/**
 * Enqueues a GAME job for every runnable game that has none yet and returns how many were
 * created. The `NOT EXISTS` predicate is what makes this resumable: pre-existing dev data,
 * a round persisted before this pipeline existed, and a job lost to a crash all converge to
 * "exactly one job per game".
 */
export async function enqueueMissingGameJobs(
  db: PostgresDatabase,
  broker: JobBroker,
  options: RunnableGamesOptions = {}
): Promise<number> {
  const res = await db.query<RunnableGameRow>(
    `${RUNNABLE_GAMES_SELECT}
     AND NOT EXISTS (
       SELECT 1 FROM jobs j
       WHERE j.job_type = 'GAME' AND j.target_id = g.id
         AND j.state IN ('QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING', 'RETRY_WAIT')
     )
   ${RUNNABLE_GAMES_ORDER}`,
    [options.tournamentId ?? null, options.limit ?? DEFAULT_RUNNABLE_GAMES_LIMIT]
  );

  let created = 0;
  for (const row of res.rows) {
    const inserted = await broker.enqueueIfNoActive('GAME', row.game_id, GAME_JOB_PRIORITY, {
      tournamentId: row.tournament_id,
      encounterId: row.encounter_id,
      gameOrdinal: row.game_ordinal,
    });
    if (inserted) created++;
  }
  return created;
}
