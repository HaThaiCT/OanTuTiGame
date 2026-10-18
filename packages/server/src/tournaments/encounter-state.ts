import type { PoolClient } from 'pg';

/**
 * Job states that mean a worker has claimed the game: the encounter actually began. Queued work does
 * not count — a round is dispatched by inserting its games as `RUNNING`, so game status alone cannot
 * tell "about to be played" from "already playing".
 */
const CLAIMED_GAME_JOB_STATES = ['LEASED', 'RUNNING', 'COMPLETION_PENDING'] as const;

/**
 * True when an encounter has started in the sense of 02-GAMEPLAY §118/§124: the *first game claim*
 * happened. Withdrawal/disqualification boundaries hang on this — before it the encounter may be
 * resolved as an unplayed walkover, after it the encounter finishes with its frozen Bots and the
 * ruling applies to later encounters only.
 */
export async function isEncounterStarted(client: PoolClient, encounterId: string): Promise<boolean> {
  const res = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM games g
      WHERE g.encounter_id = $1
        AND (
          g.status = 'COMPLETED'
          OR EXISTS (
            SELECT 1 FROM jobs j
             WHERE j.job_type = 'GAME'
               AND j.target_id = g.id
               AND j.state = ANY($2::text[])
          )
        )
      LIMIT 1`,
    [encounterId, [...CLAIMED_GAME_JOB_STATES]]
  );
  return res.rows.length > 0;
}
