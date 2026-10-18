import { applyMove, calculateProximityScore, getLegalMoves, type MoveAction } from './rules.js';
import { getLivingPieces, getPieceAt, PieceType, PlayerSide, type GameState } from './state.js';

export type V2Reason = 'EXTINCTION' | 'THRONE_BREACH' | 'STALEMATE'
  | 'MAX_TURNS_MATERIAL' | 'MAX_TURNS_PROXIMITY' | 'MAX_TURNS_DRAW' | 'INVALID_START_BOTH_SIDES';
export interface V2Outcome {
  isGameOver: boolean;
  winner?: PlayerSide;
  reason?: V2Reason;
  disposition?: 'DECISIVE' | 'DRAW' | 'NO_CONTEST';
}

/** Explicit v2 evaluation; historical evaluateVictory/applyMove remain v1. */
export function evaluateVictoryV2(state: GameState): V2Outcome {
  const white = getLivingPieces(state, PlayerSide.WHITE);
  const black = getLivingPieces(state, PlayerSide.BLACK);
  function result(whiteLoses: boolean, blackLoses: boolean, reason: V2Reason): V2Outcome | undefined {
    if (whiteLoses && blackLoses) return { isGameOver: true, reason: 'INVALID_START_BOTH_SIDES', disposition: 'NO_CONTEST' };
    if (whiteLoses || blackLoses) return { isGameOver: true, winner: whiteLoses ? PlayerSide.BLACK : PlayerSide.WHITE, reason, disposition: 'DECISIVE' };
  }
  const roster = [new Set<PieceType>(), new Set<PieceType>()];
  for (const piece of state.pieces.values()) roster[piece.owner === PlayerSide.WHITE ? 0 : 1].add(piece.type);
  const extinction = result(
    [...roster[0]].some(type => !white.some(piece => piece.type === type)),
    [...roster[1]].some(type => !black.some(piece => piece.type === type)), 'EXTINCTION');
  if (extinction) return extinction;
  const whiteBreached = getPieceAt(state, state.map.blackThrone)?.owner === PlayerSide.WHITE;
  const blackBreached = getPieceAt(state, state.map.whiteThrone)?.owner === PlayerSide.BLACK;
  const breach = result(blackBreached, whiteBreached, 'THRONE_BREACH');
  if (breach) return breach;
  // Initial stalemate concerns only the side about to move, not both rosters.
  if (getLegalMoves(state, state.activePlayer).length === 0) return {
    isGameOver: true, winner: state.activePlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE,
    reason: 'STALEMATE', disposition: 'DECISIVE',
  };
  if (state.turnNumber > state.maxTurns) {
    const material = white.length - black.length;
    if (material) return { isGameOver: true, winner: material > 0 ? PlayerSide.WHITE : PlayerSide.BLACK, reason: 'MAX_TURNS_MATERIAL', disposition: 'DECISIVE' };
    const proximity = calculateProximityScore(state, PlayerSide.WHITE) - calculateProximityScore(state, PlayerSide.BLACK);
    if (proximity) return { isGameOver: true, winner: proximity > 0 ? PlayerSide.WHITE : PlayerSide.BLACK, reason: 'MAX_TURNS_PROXIMITY', disposition: 'DECISIVE' };
    return { isGameOver: true, reason: 'MAX_TURNS_DRAW', disposition: 'DRAW' };
  }
  return { isGameOver: false };
}

/** Reuse only the v1 movement/capture mechanics, then evaluate v2 precedence. */
export function applyMoveV2(state: GameState, action: MoveAction) {
  const delta = applyMove(state, action);
  const next: GameState = { ...delta.nextState, isGameOver: false, winner: undefined,
    winReason: undefined, turnNumber: state.turnNumber + 1,
    activePlayer: state.activePlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE };
  const outcome = evaluateVictoryV2(next);
  return { ...delta, nextState: { ...next, isGameOver: outcome.isGameOver, winner: outcome.winner }, outcome };
}
