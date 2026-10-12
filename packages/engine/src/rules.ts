/**
 * Rules, Combat & Victory Evaluation for OanTuTi Arena
 * Cyclic Rock-Paper-Scissors dominance, invariant validation, and deterministic victory conditions.
 */

import { Coord, chebyshevDistance } from './graph.js';
import {
  GameState,
  Piece,
  PieceType,
  PlayerSide,
  WinReason,
  getLivingPieces,
  getLivingPiecesByType,
  getPieceAt,
} from './state.js';

export interface MoveAction {
  readonly pieceId: number;
  readonly targetPos: Coord;
}

export interface CaptureEvent {
  readonly attackerId: number;
  readonly victimId: number;
  readonly pos: Coord;
  readonly attackerType: PieceType;
  readonly victimType: PieceType;
}

export interface TurnDelta {
  readonly moveAction: MoveAction;
  readonly capture?: CaptureEvent;
  readonly previousState: GameState;
  readonly nextState: GameState;
}

export interface VictoryResult {
  readonly isGameOver: boolean;
  readonly winner?: PlayerSide;
  readonly winReason?: WinReason;
}

/**
 * Cyclic Rock-Paper-Scissors combat dominance:
 * +1 if attacker beats defender
 *  0 if attacker equals defender
 * -1 if defender beats attacker
 */
export function combatDominance(att: PieceType, def: PieceType): number {
  if (att === def) return 0;
  if (
    (att === PieceType.ROCK && def === PieceType.SCISSORS) ||
    (att === PieceType.SCISSORS && def === PieceType.PAPER) ||
    (att === PieceType.PAPER && def === PieceType.ROCK)
  ) {
    return 1;
  }
  return -1;
}

/**
 * Validates move invariants:
 * 1. Game not over
 * 2. Piece exists, alive, owned by acting player
 * 3. Exactly 1 King-step (Chebyshev distance === 1)
 * 4. Topology bound (target in validTiles)
 * 5. Friendly fire (no ally at target)
 * 6. Blocking invariant (cannot enter enemy of identical type)
 * 7. Suicide prevention (cannot enter enemy with dominance -1)
 */
export function isLegalMove(
  state: GameState,
  action: MoveAction,
  player: PlayerSide = state.activePlayer
): boolean {
  if (state.isGameOver) return false;

  const piece = state.pieces.get(action.pieceId);
  if (!piece || !piece.isAlive || piece.owner !== player) {
    return false;
  }

  const { targetPos } = action;
  if (chebyshevDistance(piece.pos, targetPos) !== 1) {
    return false;
  }

  if (!state.map.isValidTile(targetPos.x, targetPos.y)) {
    return false;
  }

  const targetPiece = getPieceAt(state, targetPos);
  if (!targetPiece) {
    return true;
  }

  if (targetPiece.owner === piece.owner) {
    return false;
  }

  const dominance = combatDominance(piece.type, targetPiece.type);
  return dominance === 1;
}

/**
 * Returns all legal moves for the specified player.
 */
export function getLegalMoves(
  state: GameState,
  player: PlayerSide = state.activePlayer
): MoveAction[] {
  if (state.isGameOver) return [];

  const legalMoves: MoveAction[] = [];
  const livingPieces = getLivingPieces(state, player);

  for (const piece of livingPieces) {
    const neighbors = state.map.getNeighbors(piece.pos);
    for (const targetPos of neighbors) {
      const action: MoveAction = { pieceId: piece.id, targetPos };
      if (isLegalMove(state, action, player)) {
        legalMoves.push(action);
      }
    }
  }

  return legalMoves;
}

/**
 * Integer-scaled Chebyshev proximity score (Scale factor 2520 * 10 = 25200)
 */
export function calculateProximityScore(state: GameState, player: PlayerSide): number {
  const enemyThrone =
    player === PlayerSide.WHITE ? state.map.blackThrone : state.map.whiteThrone;
  const living = getLivingPieces(state, player);
  let score = 0;

  for (const p of living) {
    const dist = chebyshevDistance(p.pos, enemyThrone);
    score += Math.floor(25200 / (dist + 1));
  }

  return score;
}

function checkSpeciesExtinction(state: GameState): { extinctPlayer?: PlayerSide } {
  for (const side of [PlayerSide.WHITE, PlayerSide.BLACK]) {
    const sidePieces = Array.from(state.pieces.values()).filter((p) => p.owner === side);
    if (sidePieces.length === 0) continue;

    const living = sidePieces.filter((p) => p.isAlive);
    if (living.length === 0) {
      return { extinctPlayer: side };
    }

    for (const type of [PieceType.ROCK, PieceType.SCISSORS, PieceType.PAPER]) {
      const hadType = sidePieces.some((p) => p.type === type);
      if (hadType) {
        const livingOfType = living.filter((p) => p.type === type);
        if (livingOfType.length === 0) {
          return { extinctPlayer: side };
        }
      }
    }
  }

  return {};
}

function checkThroneBreach(state: GameState): { winner?: PlayerSide } {
  const whiteAtBlackThrone = getPieceAt(state, state.map.blackThrone);
  if (whiteAtBlackThrone && whiteAtBlackThrone.owner === PlayerSide.WHITE) {
    return { winner: PlayerSide.WHITE };
  }

  const blackAtWhiteThrone = getPieceAt(state, state.map.whiteThrone);
  if (blackAtWhiteThrone && blackAtWhiteThrone.owner === PlayerSide.BLACK) {
    return { winner: PlayerSide.BLACK };
  }

  return {};
}

/**
 * Evaluates game victory condition:
 * Priority 1: Species Extinction
 * Priority 2: Throne Breach
 * Priority 3: Stalemate (active player has 0 legal moves)
 * Priority 4: Max Turns limit
 */
export function evaluateVictory(state: GameState): VictoryResult {
  if (state.isGameOver) {
    return {
      isGameOver: true,
      winner: state.winner,
      winReason: state.winReason,
    };
  }
  // Priority 1: Species Extinction
  const { extinctPlayer } = checkSpeciesExtinction(state);
  if (extinctPlayer !== undefined) {
    const winner =
      extinctPlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE;
    return {
      isGameOver: true,
      winner,
      winReason: WinReason.EXTINCTION,
    };
  }

  // Priority 2: Throne Breach
  const { winner: breachWinner } = checkThroneBreach(state);
  if (breachWinner !== undefined) {
    return {
      isGameOver: true,
      winner: breachWinner,
      winReason: WinReason.THRONE_BREACH,
    };
  }

  // Priority 3: Stalemate on active player's turn
  const legalMoves = getLegalMoves(state, state.activePlayer);
  if (legalMoves.length === 0) {
    const winner =
      state.activePlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE;
    return {
      isGameOver: true,
      winner,
      winReason: WinReason.STALEMATE,
    };
  }

  // Priority 4: Max Turns threshold
  if (state.turnNumber > state.maxTurns) {
    const whiteCount = getLivingPieces(state, PlayerSide.WHITE).length;
    const blackCount = getLivingPieces(state, PlayerSide.BLACK).length;

    if (whiteCount > blackCount) {
      return {
        isGameOver: true,
        winner: PlayerSide.WHITE,
        winReason: WinReason.MAX_TURNS_DRAW,
      };
    } else if (blackCount > whiteCount) {
      return {
        isGameOver: true,
        winner: PlayerSide.BLACK,
        winReason: WinReason.MAX_TURNS_DRAW,
      };
    }

    const whiteScore = calculateProximityScore(state, PlayerSide.WHITE);
    const blackScore = calculateProximityScore(state, PlayerSide.BLACK);

    if (whiteScore > blackScore) {
      return {
        isGameOver: true,
        winner: PlayerSide.WHITE,
        winReason: WinReason.MAX_TURNS_DRAW,
      };
    } else if (blackScore > whiteScore) {
      return {
        isGameOver: true,
        winner: PlayerSide.BLACK,
        winReason: WinReason.MAX_TURNS_DRAW,
      };
    }

    return {
      isGameOver: true,
      winReason: WinReason.MAX_TURNS_DRAW,
    };
  }

  return { isGameOver: false };
}

/**
 * Applies a legal move to the game state and returns the turn delta.
 * Throws an Error if the move is illegal.
 */
export function applyMove(state: GameState, action: MoveAction): TurnDelta {
  if (!isLegalMove(state, action)) {
    throw new Error(
      `Illegal move: piece ${action.pieceId} to (${action.targetPos.x}, ${action.targetPos.y})`
    );
  }

  const mover = state.pieces.get(action.pieceId)!;
  const targetPiece = getPieceAt(state, action.targetPos);

  const nextPieces = new Map<number, Piece>(state.pieces);
  const nextGrid = new Map<string, number>(state.grid);

  // Remove mover from current position in grid
  nextGrid.delete(`${mover.pos.x},${mover.pos.y}`);

  let capture: CaptureEvent | undefined;

  if (targetPiece) {
    const victim: Piece = {
      ...targetPiece,
      isAlive: false,
    };
    nextPieces.set(victim.id, victim);
    capture = {
      attackerId: mover.id,
      victimId: victim.id,
      pos: action.targetPos,
      attackerType: mover.type,
      victimType: victim.type,
    };
  }

  const updatedMover: Piece = {
    ...mover,
    pos: action.targetPos,
  };
  nextPieces.set(updatedMover.id, updatedMover);
  nextGrid.set(`${action.targetPos.x},${action.targetPos.y}`, updatedMover.id);

  // Step 1: Check immediate victory conditions caused by the move (Extinction or Throne Breach)
  const intermediateState: GameState = {
    map: state.map,
    pieces: nextPieces,
    grid: nextGrid,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    maxTurns: state.maxTurns,
    isGameOver: false,
  };

  const { extinctPlayer } = checkSpeciesExtinction(intermediateState);
  if (extinctPlayer !== undefined) {
    const winner =
      extinctPlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE;
    const nextState: GameState = {
      ...intermediateState,
      isGameOver: true,
      winner,
      winReason: WinReason.EXTINCTION,
    };
    return { moveAction: action, capture, previousState: state, nextState };
  }

  const { winner: breachWinner } = checkThroneBreach(intermediateState);
  if (breachWinner !== undefined) {
    const nextState: GameState = {
      ...intermediateState,
      isGameOver: true,
      winner: breachWinner,
      winReason: WinReason.THRONE_BREACH,
    };
    return { moveAction: action, capture, previousState: state, nextState };
  }

  // Step 2: Advance turn and check Stalemate / Max Turns for next player
  const nextTurnNumber = state.turnNumber + 1;
  const nextActivePlayer =
    state.activePlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE;

  const advancedState: GameState = {
    map: state.map,
    pieces: nextPieces,
    grid: nextGrid,
    turnNumber: nextTurnNumber,
    activePlayer: nextActivePlayer,
    maxTurns: state.maxTurns,
    isGameOver: false,
  };

  const victory = evaluateVictory(advancedState);
  const nextState: GameState = {
    ...advancedState,
    isGameOver: victory.isGameOver,
    winner: victory.winner,
    winReason: victory.winReason,
  };

  return {
    moveAction: action,
    capture,
    previousState: state,
    nextState,
  };
}
