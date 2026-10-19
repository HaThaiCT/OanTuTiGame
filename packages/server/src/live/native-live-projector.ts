import type { MapDescriptor } from '@oantuti/engine';
import type { LeaseIdentity } from '@oantuti/protocol';
import type { Database } from '../persistence/db.js';
import { JobBrokerError } from '../jobs/broker.js';
import { LiveMatchHub, type LivePublisher, type LiveResult, type LiveTurnInput } from './live-match-hub.js';

interface Projection {
  readonly lease: LeaseIdentity;
  readonly publisher: LivePublisher;
  seq: number;
}

/** Ephemeral official-game preview; never writes a result or publishes private test data. */
export class NativeLiveProjector {
  private readonly attempts = new Map<string, Projection>();
  constructor(private readonly db: Database, private readonly hub: LiveMatchHub) {}

  async open(lease: LeaseIdentity, gameId: string, map: MapDescriptor): Promise<void> {
    const result = await this.db.query<{ tournament_id: string; white_team_id: string; black_team_id: string; white_name: string; black_name: string }>(
      `SELECT e.tournament_id, g.white_team_id, g.black_team_id, wt.name AS white_name, bt.name AS black_name
       FROM games g JOIN encounters e ON e.id=g.encounter_id JOIN teams wt ON wt.id = g.white_team_id JOIN teams bt ON bt.id = g.black_team_id
       JOIN jobs j ON j.target_id = g.id AND j.job_type = 'GAME'
       WHERE g.id = $1 AND j.id = $2`, [gameId, lease.jobId]
    );
    const game = result.rows[0];
    if (!game) throw new JobBrokerError('INVALID_REQUEST', 'Live preview requires an official GAME assignment');
    for (const [id, attempt] of this.attempts) {
      if (attempt.publisher.gameId === gameId) this.attempts.delete(id);
    }
    const publisher = this.hub.openGame({
      gameId, map, publisherId: lease.attemptId,
      tournamentId: game.tournament_id,
      identity: { attemptId: lease.attemptId, fencingToken: lease.fencingToken, deploymentGeneration: lease.deploymentGeneration },
      whiteTeam: { id: game.white_team_id, name: game.white_name },
      blackTeam: { id: game.black_team_id, name: game.black_name },
    });
    this.attempts.set(lease.attemptId, { lease, publisher, seq: 0 });
  }

  turn(lease: LeaseIdentity, value: unknown): void {
    const attempt = this.requireAttempt(lease);
    if (typeof value !== 'object' || value === null) this.invalid();
    const input = value as Record<string, unknown>;
    const seq = input.seq;
    if (!Number.isSafeInteger(seq) || (seq as number) < 1 || (seq as number) > 300) this.invalid();
    if (!Number.isSafeInteger(input.turnNumber) || (input.turnNumber as number) < 1 || (input.turnNumber as number) > 300) this.invalid();
    if (input.side !== 1 && input.side !== 2) this.invalid();
    if (typeof input.action !== 'object' || input.action === null) this.invalid();
    const action = input.action as Record<string, unknown>;
    let turn: LiveTurnInput;
    if (action.action === 'PASS') {
      turn = { turnNumber: input.turnNumber as number, side: input.side, action: { action: 'PASS' } };
    } else {
      const target = action.target;
      if (action.action !== 'MOVE' || !Number.isSafeInteger(action.pieceId) || (action.pieceId as number) < 0 ||
          !Array.isArray(target) || target.length !== 2 || !target.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 65535)) this.invalid();
      turn = { turnNumber: input.turnNumber as number, side: input.side, action: {
        action: 'MOVE', pieceId: action.pieceId as number, target: [target[0], target[1]],
      } };
    }
    if ((seq as number) <= attempt.seq) return; // RPC response loss may redeliver a frame.
    if (seq !== attempt.seq + 1) throw new JobBrokerError('INVALID_REQUEST', 'Live turn sequence has a gap');
    attempt.publisher.publishTurn(turn);
    attempt.seq = seq as number;
  }

  previewEnd(lease: LeaseIdentity): void {
    const attempt = this.attempts.get(lease.attemptId);
    if (!attempt) return;
    this.requireAttempt(lease).publisher.previewEnd();
  }

  accepted(gameId: string, result: LiveResult): void {
    this.hub.confirmAccepted(gameId, result);
    for (const [id, attempt] of this.attempts) if (attempt.publisher.gameId === gameId) this.attempts.delete(id);
  }

  abandon(lease: LeaseIdentity): void {
    this.previewEnd(lease);
    this.attempts.delete(lease.attemptId);
  }

  private requireAttempt(lease: LeaseIdentity): Projection {
    const attempt = this.attempts.get(lease.attemptId);
    if (!attempt || attempt.lease.jobId !== lease.jobId || attempt.lease.fencingToken !== lease.fencingToken ||
        attempt.lease.deploymentGeneration !== lease.deploymentGeneration || attempt.lease.grantId !== lease.grantId) {
      throw new JobBrokerError('INVALID_REQUEST', 'Live attempt is stale or not an official game');
    }
    return attempt;
  }

  private invalid(): never { throw new JobBrokerError('INVALID_REQUEST', 'Invalid bounded live turn'); }
}
