import { randomUUID } from 'node:crypto';
import type { Actor, UUID } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';

export class DisputeError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'DisputeError';
  }
}

export interface DisputeRow {
  readonly id: string;
  readonly tournament_id: string;
  readonly encounter_id: string;
  readonly team_id: string;
  readonly created_by_user_id: string;
  readonly status: 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'REJECTED';
  readonly reason: string;
  readonly decision: string | null;
  readonly decided_by_user_id: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface CreateDisputeInput {
  readonly tournamentId: string;
  readonly encounterId: string;
  readonly teamId: string;
  readonly reason: string;
}

export class DisputeService {
  constructor(private readonly db: PostgresDatabase) {}

  async createDispute(actor: Actor, input: CreateDisputeInput): Promise<DisputeRow> {
    const { tournamentId, encounterId, teamId, reason } = input;

    // The claim, the state check and the outbox event share one transaction, and the tournament row
    // is locked with FOR UPDATE — the same finalize holds while it counts OPEN disputes — so an
    // operator finalizing and a team filing can never interleave.
    return this.db.withTransaction(async (client) => {
      const tourneyRes = await client.query<{ id: string; state: string }>(
        `SELECT id, state FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );
      // A missing tournament and an encounter outside the named tournament read identically: not
      // returning the object matters, not why.
      const tourney = tourneyRes.rows[0];
      if (!tourney) {
        throw new DisputeError(404, `Encounter not found in tournament: ${encounterId}`);
      }

      // Re-checked under the lock: the pre-lock state can belong to an already-committed finalize.
      if (tourney.state !== 'RUNNING' && tourney.state !== 'PROVISIONAL') {
        throw new DisputeError(409, `Cannot file dispute for tournament in state '${tourney.state}'`);
      }

      const encRes = await client.query<{
        id: string;
        tournament_id: string;
        team_a_id: string;
        team_b_id: string | null;
        status: string;
      }>(
        `SELECT e.id, e.tournament_id, e.team_a_id, e.team_b_id, e.status
         FROM encounters e
         WHERE e.id = $1 AND e.tournament_id = $2`,
        [encounterId, tournamentId]
      );

      if (encRes.rows.length === 0) {
        throw new DisputeError(404, `Encounter not found in tournament: ${encounterId}`);
      }

      const enc = encRes.rows[0];

      // Only a fully authenticated administrator may file on behalf of the teams without belonging
      // to them; a password-change-only session is an ordinary claimant for this purpose.
      const claimsAdminAuthority = actor.role === 'ADMIN' && actor.scope === 'FULL';
      if (!claimsAdminAuthority) {
        if (!actor.teamIds.includes(teamId)) {
          throw new DisputeError(403, 'Actor is not a member of the specified team');
        }
        if (enc.team_a_id !== teamId && enc.team_b_id !== teamId) {
          throw new DisputeError(400, 'Team was not a participant in this encounter');
        }
      }

      // A team may hold exactly one live dispute per encounter: refiling while one is OPEN or
      // UNDER_REVIEW (double click, retried request) returns the existing row. Closed disputes
      // never collide — the unique index is partial.
      const insertRes = await client.query<DisputeRow>(
        `INSERT INTO disputes (tournament_id, encounter_id, team_id, created_by_user_id, status, reason)
         VALUES ($1, $2, $3, $4, 'OPEN', $5)
         ON CONFLICT (tournament_id, encounter_id, team_id)
           WHERE status IN ('OPEN', 'UNDER_REVIEW')
         DO NOTHING
         RETURNING *`,
        [tournamentId, encounterId, teamId, actor.userId, reason.trim()]
      );

      const dispute = insertRes.rows[0] ?? (await client.query<DisputeRow>(
        `SELECT * FROM disputes
         WHERE tournament_id = $1 AND encounter_id = $2 AND team_id = $3
           AND status IN ('OPEN', 'UNDER_REVIEW')`,
        [tournamentId, encounterId, teamId]
      )).rows[0];

      if (!dispute) {
        // Unreachable without a unique-violation race losing the row, but the RETURNING contract
        // must hold before the outbox event is written.
        throw new DisputeError(409, 'DISPUTE_CLAIM_LOST');
      }

      // Emit outbox event
      await client.query(
        `INSERT INTO outbox_events (topic, payload)
         VALUES ($1, $2)`,
        [
          'DISPUTE_FILED',
          JSON.stringify({
            disputeId: dispute.id,
            tournamentId,
            encounterId,
            teamId,
            createdByUserId: actor.userId,
          }),
        ]
      );

      return dispute;
    });
  }

  async resolveDispute(
    actor: Actor,
    disputeId: string,
    decision: 'RESOLVED' | 'REJECTED',
    note: string
  ): Promise<DisputeRow> {
    if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
      throw new DisputeError(403, 'Only fully authenticated administrators can resolve disputes');
    }

    const res = await this.db.query<DisputeRow>(
      `UPDATE disputes
       SET status = $1,
           decision = $2,
           decided_by_user_id = $3,
           resolved_at = clock_timestamp()
       WHERE id = $4
       RETURNING *`,
      [decision, note.trim(), actor.userId, disputeId]
    );

    if (res.rows.length === 0) {
      throw new DisputeError(404, `Dispute not found: ${disputeId}`);
    }

    const dispute = res.rows[0];

    // Emit outbox event
    await this.db.query(
      `INSERT INTO outbox_events (topic, payload)
       VALUES ($1, $2)`,
      [
        'DISPUTE_RESOLVED',
        JSON.stringify({
          disputeId: dispute.id,
          tournamentId: dispute.tournament_id,
          encounterId: dispute.encounter_id,
          status: dispute.status,
          decision: dispute.decision,
          decidedByUserId: actor.userId,
        }),
      ]
    );

    return dispute;
  }

  /**
   * Lists the disputes an actor may read. An administrator sees the whole ledger of the
   * tournament; a participant sees only the appeals filed by their own teams. The appeal text, the
   * adjudicator's note and the open/under-review map are private, so there is deliberately no
   * anonymous or cross-team read and the actor parameter is required.
   */
  async listDisputes(tournamentId: string, actor: Actor): Promise<readonly DisputeRow[]> {
    if (actor.role === 'ADMIN' && actor.scope === 'FULL') {
      const res = await this.db.query<DisputeRow>(
        `SELECT * FROM disputes WHERE tournament_id = $1 ORDER BY created_at DESC`,
        [tournamentId]
      );
      return res.rows;
    }
    if (actor.scope !== 'FULL' || actor.teamIds.length === 0) return [];
    const res = await this.db.query<DisputeRow>(
      `SELECT * FROM disputes WHERE tournament_id = $1 AND team_id = ANY($2::uuid[]) ORDER BY created_at DESC`,
      [tournamentId, actor.teamIds]
    );
    return res.rows;
  }
}
