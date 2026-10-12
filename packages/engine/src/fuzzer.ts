/**
 * Deterministic Fuzzing Simulator Engine for OanTuTi Arena
 * Plays randomized matches with strict game invariant assertions at every turn.
 */

import { MapTopology, chebyshevDistance, StartingPieceDescriptor } from './graph.js';
import {
  GameState,
  Piece,
  PlayerSide,
  WinReason,
  createInitialGameState,
  getLivingPieces,
} from './state.js';
import {
  isLegalMove,
  getLegalMoves,
  applyMove,
  evaluateVictory,
} from './rules.js';
import { SeededPRNG } from './fuzz-prng.js';

export interface FuzzTurnRecord {
  readonly turnNumber: number;
  readonly player: PlayerSide;
  readonly pieceId: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly captureVictimId?: number;
}

export interface FuzzMatchResult {
  readonly seed: number;
  readonly winner?: PlayerSide;
  readonly winReason: WinReason;
  readonly totalTurns: number;
  readonly whiteRemaining: number;
  readonly blackRemaining: number;
  readonly turns: readonly FuzzTurnRecord[];
  readonly canonicalTrace: string;
}

export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(`Fuzz Invariant Violation: ${message}`);
    this.name = 'InvariantViolationError';
  }
}

export function simulateFuzzMatch(options: {
  seed: number;
  map: MapTopology;
  startingPieces?: readonly StartingPieceDescriptor[];
  maxTurns?: number;
}): FuzzMatchResult {
  const { seed, map, startingPieces, maxTurns = 300 } = options;
  const prng = new SeededPRNG(seed);

  let state = createInitialGameState(map, startingPieces, maxTurns);
  const turns: FuzzTurnRecord[] = [];
  const traceLines: string[] = [
    `MAP:${map.mapName},W:${map.width},H:${map.height},TW:${map.whiteThrone.x},${map.whiteThrone.y},TB:${map.blackThrone.x},${map.blackThrone.y}`,
  ];

  while (!state.isGameOver) {
    const activePlayer = state.activePlayer;
    const legalMoves = getLegalMoves(state, activePlayer);

    if (legalMoves.length === 0) {
      const victory = evaluateVictory(state);
      state = {
        ...state,
        isGameOver: true,
        winner: victory.winner,
        winReason: victory.winReason,
      };
      break;
    }

    // Pick a deterministic pseudo-random legal move
    const chosenMove = prng.pick(legalMoves);

    // Verify invariant 1: Move must be legal
    if (!isLegalMove(state, chosenMove, activePlayer)) {
      throw new InvariantViolationError(
        `Legal move generator yielded illegal move: piece ${chosenMove.pieceId} to (${chosenMove.targetPos.x}, ${chosenMove.targetPos.y})`
      );
    }

    const mover = state.pieces.get(chosenMove.pieceId)!;

    // Verify invariant 2: Chebyshev distance is exactly 1
    if (chebyshevDistance(mover.pos, chosenMove.targetPos) !== 1) {
      throw new InvariantViolationError(
        `Move distance is not 1: from (${mover.pos.x}, ${mover.pos.y}) to (${chosenMove.targetPos.x}, ${chosenMove.targetPos.y})`
      );
    }

    // Verify invariant 3: Target pos is valid tile in graph topology
    if (!map.isValidTile(chosenMove.targetPos.x, chosenMove.targetPos.y)) {
      throw new InvariantViolationError(
        `Move target (${chosenMove.targetPos.x}, ${chosenMove.targetPos.y}) is outside validTiles`
      );
    }

    const delta = applyMove(state, chosenMove);

    // Verify invariant 4: Spatial index consistency
    const nextMoverPiece = delta.nextState.pieces.get(mover.id);
    if (!nextMoverPiece || nextMoverPiece.pos.x !== chosenMove.targetPos.x || nextMoverPiece.pos.y !== chosenMove.targetPos.y) {
      throw new InvariantViolationError(`Piece position was not updated correctly in nextState pieces`);
    }

    const gridPieceId = delta.nextState.grid.get(`${chosenMove.targetPos.x},${chosenMove.targetPos.y}`);
    if (gridPieceId !== mover.id) {
      throw new InvariantViolationError(
        `Spatial index grid at (${chosenMove.targetPos.x}, ${chosenMove.targetPos.y}) does not point to piece ${mover.id}`
      );
    }

    // Verify invariant 5: Capture consistency
    if (delta.capture) {
      const victim = delta.nextState.pieces.get(delta.capture.victimId);
      if (!victim || victim.isAlive) {
        throw new InvariantViolationError(`Captured victim ${delta.capture.victimId} was not marked isAlive = false`);
      }
    }

    // Record turn
    const record: FuzzTurnRecord = {
      turnNumber: state.turnNumber,
      player: activePlayer,
      pieceId: chosenMove.pieceId,
      targetX: chosenMove.targetPos.x,
      targetY: chosenMove.targetPos.y,
      captureVictimId: delta.capture?.victimId,
    };
    turns.push(record);

    traceLines.push(
      `T:${record.turnNumber},P:${record.player},M:${record.pieceId}->${record.targetX},${record.targetY},C:${record.captureVictimId ?? 0}`
    );

    state = delta.nextState;
  }

  // Verify final victory condition
  const victory = evaluateVictory(state);
  if (!victory.isGameOver) {
    throw new InvariantViolationError(`Game loop terminated but evaluateVictory returned isGameOver = false`);
  }

  const whiteRemaining = getLivingPieces(state, PlayerSide.WHITE).length;
  const blackRemaining = getLivingPieces(state, PlayerSide.BLACK).length;

  // Add final state snapshot to trace
  const sortedPieces = Array.from(state.pieces.values())
    .sort((a, b) => a.id - b.id)
    .map((p) => `${p.id}:${p.owner}:${p.type}:${p.isAlive ? 1 : 0}:${p.pos.x},${p.pos.y}`)
    .join(';');

  traceLines.push(
    `END:W:${victory.winner ?? 0},R:${victory.winReason ?? 0},TURNS:${turns.length},PW:${whiteRemaining},PB:${blackRemaining}`
  );
  traceLines.push(`PIECES:${sortedPieces}`);

  return {
    seed,
    winner: victory.winner,
    winReason: victory.winReason ?? WinReason.WIN_REASON_UNSPECIFIED,
    totalTurns: turns.length,
    whiteRemaining,
    blackRemaining,
    turns,
    canonicalTrace: traceLines.join('\n'),
  };
}
