/**
 * Game State & Spatial Index for OanTuTi Arena
 * Pure immutable state snapshots with O(1) coordinate-to-piece spatial indexing.
 */

import { Coord, MapTopology, StartingPieceDescriptor } from './graph.js';

export enum PlayerSide {
  PLAYER_UNSPECIFIED = 0,
  WHITE = 1,
  BLACK = 2,
}

export enum PieceType {
  PIECE_TYPE_UNSPECIFIED = 0,
  ROCK = 1,
  SCISSORS = 2,
  PAPER = 3,
}

export enum WinReason {
  WIN_REASON_UNSPECIFIED = 0,
  EXTINCTION = 1,
  THRONE_BREACH = 2,
  STALEMATE = 3,
  TIMEOUT = 4,
  ILLEGAL_MOVE = 5,
  CRASH_FORFEIT = 6,
  MAX_TURNS_DRAW = 7,
  PROTOCOL_VIOLATION = 8,
}

export interface Piece {
  readonly id: number;
  readonly owner: PlayerSide;
  readonly type: PieceType;
  readonly pos: Coord;
  readonly isAlive: boolean;
}

export interface GameState {
  readonly map: MapTopology;
  readonly pieces: ReadonlyMap<number, Piece>;
  readonly grid: ReadonlyMap<string, number>;
  readonly turnNumber: number;
  readonly activePlayer: PlayerSide;
  readonly maxTurns: number;
  readonly isGameOver: boolean;
  readonly winner?: PlayerSide;
  readonly winReason?: WinReason;
}

const SIDE_BY_NAME: Record<string, PlayerSide> = {
  WHITE: PlayerSide.WHITE,
  BLACK: PlayerSide.BLACK,
};

const NAME_BY_SIDE: Record<number, 'WHITE' | 'BLACK'> = {
  [PlayerSide.WHITE]: 'WHITE',
  [PlayerSide.BLACK]: 'BLACK',
};

const PIECE_TYPE_BY_NAME: Record<string, PieceType> = {
  ROCK: PieceType.ROCK,
  SCISSORS: PieceType.SCISSORS,
  PAPER: PieceType.PAPER,
};

const NAME_BY_PIECE_TYPE: Record<number, 'ROCK' | 'SCISSORS' | 'PAPER'> = {
  [PieceType.ROCK]: 'ROCK',
  [PieceType.SCISSORS]: 'SCISSORS',
  [PieceType.PAPER]: 'PAPER',
};

export function parsePlayerSide(name: string): PlayerSide {
  return SIDE_BY_NAME[name] ?? PlayerSide.PLAYER_UNSPECIFIED;
}

export function playerSideToString(side: PlayerSide): 'WHITE' | 'BLACK' {
  return NAME_BY_SIDE[side] ?? 'WHITE';
}

export function parsePieceType(name: string): PieceType {
  return PIECE_TYPE_BY_NAME[name] ?? PieceType.PIECE_TYPE_UNSPECIFIED;
}

export function pieceTypeToString(type: PieceType): 'ROCK' | 'SCISSORS' | 'PAPER' {
  return NAME_BY_PIECE_TYPE[type] ?? 'ROCK';
}

export function getPieceAt(state: GameState, coord: Coord): Piece | undefined {
  const pieceId = state.grid.get(`${coord.x},${coord.y}`);
  if (pieceId === undefined) return undefined;
  const piece = state.pieces.get(pieceId);
  return piece && piece.isAlive ? piece : undefined;
}

export function getLivingPieces(state: GameState, player?: PlayerSide): Piece[] {
  const result: Piece[] = [];
  for (const piece of state.pieces.values()) {
    if (piece.isAlive && (player === undefined || piece.owner === player)) {
      result.push(piece);
    }
  }
  return result;
}

export function getLivingPiecesByType(state: GameState, player: PlayerSide, type: PieceType): Piece[] {
  const result: Piece[] = [];
  for (const piece of state.pieces.values()) {
    if (piece.isAlive && piece.owner === player && piece.type === type) {
      result.push(piece);
    }
  }
  return result;
}

export function createInitialGameState(
  map: MapTopology,
  startingPieces: readonly StartingPieceDescriptor[] = [],
  maxTurns: number = 300
): GameState {
  const pieces = new Map<number, Piece>();
  const grid = new Map<string, number>();

  for (const sp of startingPieces) {
    const owner = parsePlayerSide(sp.owner);
    const type = parsePieceType(sp.type);
    const pos: Coord = { x: sp.pos[0], y: sp.pos[1] };
    const piece: Piece = {
      id: sp.id,
      owner,
      type,
      pos,
      isAlive: true,
    };
    pieces.set(piece.id, piece);
    grid.set(`${pos.x},${pos.y}`, piece.id);
  }

  return {
    map,
    pieces,
    grid,
    turnNumber: 1,
    activePlayer: PlayerSide.WHITE,
    maxTurns,
    isGameOver: false,
  };
}
