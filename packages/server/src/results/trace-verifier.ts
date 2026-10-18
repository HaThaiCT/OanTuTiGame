import {
  applyMoveV2,
  createInitialGameState,
  createMapTopology,
  evaluateVictoryV2,
  isLegalMove,
  PlayerSide,
  type GameState,
  type MapDescriptor,
  type MoveAction,
} from '@oantuti/engine';
import type { ActionTraceStep, GameResultEvidence } from '@oantuti/protocol';

export interface VerificationResult {
  readonly isValid: boolean;
  readonly error?: string;
  readonly verifiedTurns: number;
  readonly finalOutcome?: {
    readonly isGameOver: boolean;
    readonly winner?: PlayerSide;
    readonly reason?: string;
    readonly disposition?: string;
  };
}

export class TraceVerifier {
  /**
   * Verifies that the provided action trace matches the map rules and results in the claimed outcome.
   */
  verify(map: MapDescriptor, evidence: GameResultEvidence, maxTurns: number = 300): VerificationResult {
    const topology = createMapTopology(map);
    let state = createInitialGameState(topology, map.startingPieces, maxTurns);
    let ply = 0;
    for (const step of evidence.trace) {
      ply++;
      const expectedSide = state.activePlayer === PlayerSide.WHITE ? 1 : 2;
      if (step.side !== expectedSide) {
        return {
          isValid: false,
          error: `PLY_${ply}_SIDE_MISMATCH: expected side ${expectedSide}, got ${step.side}`,
          verifiedTurns: state.turnNumber,
        };
      }

      const moveAction: MoveAction = {
        pieceId: step.move.pieceId,
        targetPos: { x: step.move.targetPos.x, y: step.move.targetPos.y },
      };

      if (!isLegalMove(state, moveAction)) {
        return {
          isValid: false,
          error: `PLY_${ply}_ILLEGAL_MOVE: piece ${step.move.pieceId} to (${step.move.targetPos.x}, ${step.move.targetPos.y}) is illegal`,
          verifiedTurns: state.turnNumber,
        };
      }

      const result = applyMoveV2(state, moveAction);
      state = result.nextState;

      if (result.outcome.isGameOver) {
        break;
      }
    }

    // Evaluate final state
    const outcome = evaluateVictoryV2(state);

    // If game ended naturally by rules
    if (evidence.executionStatus === 'COMPLETED') {
      if (!outcome.isGameOver) {
        return {
          isValid: false,
          error: 'GAME_NOT_TERMINATED: Trace ended before decisive condition reached and status is COMPLETED',
          verifiedTurns: state.turnNumber,
        };
      }

      const expectedWinner = outcome.winner === PlayerSide.WHITE ? 1 : outcome.winner === PlayerSide.BLACK ? 2 : 0;
      if (evidence.winner !== expectedWinner) {
        return {
          isValid: false,
          error: `WINNER_MISMATCH: engine evaluated winner=${expectedWinner}, evidence claimed ${evidence.winner}`,
          verifiedTurns: state.turnNumber,
        };
      }

      if (evidence.reason !== outcome.reason) {
        return {
          isValid: false,
          error: `REASON_MISMATCH: engine evaluated reason=${outcome.reason}, evidence claimed ${evidence.reason}`,
          verifiedTurns: state.turnNumber,
        };
      }
    } else if (evidence.executionStatus === 'BOT_FORFEIT') {
      // Forfeits (timeout, crash, protocol violation) conclude with opposing player awarded win
      if (evidence.winner !== 1 && evidence.winner !== 2) {
        return {
          isValid: false,
          error: `FORFEIT_INVALID_WINNER: Bot forfeit must award win to side 1 or 2, got ${evidence.winner}`,
          verifiedTurns: state.turnNumber,
        };
      }
    }

    return {
      isValid: true,
      verifiedTurns: state.turnNumber,
      finalOutcome: {
        isGameOver: outcome.isGameOver,
        winner: outcome.winner,
        reason: outcome.reason,
        disposition: outcome.disposition,
      },
    };
  }
}
