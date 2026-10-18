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

    // Verify encounter exists in this tournament
    const encRes = await this.db.query<{
      id: string;
      tournament_id: string;
      team_a_id: string;
      team_b_id: string | null;
      status: string;
      tourney_state: string;
    }>(
      `SELECT e.id, e.tournament_id, e.team_a_id, e.team_b_id, e.status, t.state as tourney_state
       FROM encounters e
       JOIN tournaments t ON e.tournament_id = t.id
       WHERE e.id = $1 AND e.tournament_id = $2`,
      [encounterId, tournamentId]
    );

    if (encRes.rows.length === 0) {
      throw new DisputeError(404, `Encounter not found in tournament: ${encounterId}`);
    }

    const enc = encRes.rows[0];

    // Must be RUNNING or PROVISIONAL to dispute
    if (enc.tourney_state !== 'RUNNING' && enc.tourney_state !== 'PROVISIONAL') {
      throw new DisputeError(409, `Cannot file dispute for tournament in state '${enc.tourney_state}'`);
    }

    // If student, verify actor is a member of the claimed team, and team was in encounter
    if (actor.role !== 'ADMIN') {
      if (!actor.teamIds.includes(teamId)) {
        throw new DisputeError(403, 'Actor is not a member of the specified team');
      }
      if (enc.team_a_id !== teamId && enc.team_b_id !== teamId) {
        throw new DisputeError(400, 'Team was not a participant in this encounter');
      }
    }

    const insertRes = await this.db.query<DisputeRow>(
      `INSERT INTO disputes (tournament_id, encounter_id, team_id, created_by_user_id, status, reason)
       VALUES ($1, $2, $3, $4, 'OPEN', $5)
       RETURNING *`,
      [tournamentId, encounterId, teamId, actor.userId, reason.trim()]
    );

    const dispute = insertRes.rows[0];

    // Emit outbox event
    await this.db.query(
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
  }

  async resolveDispute(
    actor: Actor,
    disputeId: string,
    decision: 'RESOLVED' | 'REJECTED',
    note: string
  ): Promise<DisputeRow> {
    if (actor.role !== 'ADMIN') {
      throw new DisputeError(403, 'Only administrators can resolve disputes');
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

  async listDisputes(tournamentId: string, actor?: Actor): Promise<readonly DisputeRow[]> {
    const res = await this.db.query<DisputeRow>(
      `SELECT * FROM disputes WHERE tournament_id = $1 ORDER BY created_at DESC`,
      [tournamentId]
    );
    return res.rows;
  }
}
