import { describe, it, expect } from 'vitest';
import {
  createMapTopology,
  MapDescriptor,
  createInitialGameState,
  combatDominance,
  isLegalMove,
  getLegalMoves,
  applyMove,
  evaluateVictory,
  calculateProximityScore,
  PieceType,
  PlayerSide,
  WinReason,
  GameState,
  Piece,
} from '../src/index.js';
import sampleDonut from '../../../docs/specs/maps/sample-donut.map.json';

describe('Rules, Combat Dominance & Edge Cases (TC_ENG_001 - TC_ENG_010)', () => {
  const topology = createMapTopology(sampleDonut as unknown as MapDescriptor);

  it('verifies Rock-Paper-Scissors cyclic combat dominance', () => {
    // Dominance +1
    expect(combatDominance(PieceType.ROCK, PieceType.SCISSORS)).toBe(1);
    expect(combatDominance(PieceType.SCISSORS, PieceType.PAPER)).toBe(1);
    expect(combatDominance(PieceType.PAPER, PieceType.ROCK)).toBe(1);

    // Dominance 0 (ties)
    expect(combatDominance(PieceType.ROCK, PieceType.ROCK)).toBe(0);
    expect(combatDominance(PieceType.SCISSORS, PieceType.SCISSORS)).toBe(0);
    expect(combatDominance(PieceType.PAPER, PieceType.PAPER)).toBe(0);

    // Dominance -1 (losing)
    expect(combatDominance(PieceType.SCISSORS, PieceType.ROCK)).toBe(-1);
    expect(combatDominance(PieceType.PAPER, PieceType.SCISSORS)).toBe(-1);
    expect(combatDominance(PieceType.ROCK, PieceType.PAPER)).toBe(-1);
  });

  it('TC_ENG_001: Vực thẳm bàn cờ - moving into hole in donut is illegal', () => {
    // Piece 1 is at (2, 2). Moving to (3, 3) enters the hole
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 2] },
    ]);

    const moveIntoHole = { pieceId: 1, targetPos: { x: 3, y: 3 } };
    expect(isLegalMove(state, moveIntoHole)).toBe(false);
  });

  it('TC_ENG_002: Vượt Bounding Box - moving outside width/height is illegal', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 0] },
    ]);

    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: -1, y: 0 } })).toBe(false);
    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: 0, y: -1 } })).toBe(false);
    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: -1, y: -1 } })).toBe(false);
  });

  it('TC_ENG_003: Cản đường cùng loại - White Rock cannot enter Black Rock', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 2] },
      { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 3] },
    ]);

    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: 2, y: 3 } })).toBe(false);
  });

  it('TC_ENG_004: Cản đường đồng minh - White Rock cannot enter White Scissors', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 2] },
      { id: 2, owner: 'WHITE', type: 'SCISSORS', pos: [2, 3] },
    ]);

    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: 2, y: 3 } })).toBe(false);
  });

  it('TC_ENG_005: Cấm tự sát - White Scissors cannot enter Black Rock', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'SCISSORS', pos: [2, 2] },
      { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 3] },
    ]);

    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: 2, y: 3 } })).toBe(false);
  });

  it('TC_ENG_006: Ăn quân chuẩn - White Rock captures Black Scissors and emits CaptureEvent', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 2] },
      { id: 2, owner: 'BLACK', type: 'SCISSORS', pos: [2, 3] },
      { id: 3, owner: 'BLACK', type: 'SCISSORS', pos: [5, 5] }, // Black keeps another scissors so not extinct
    ]);

    expect(isLegalMove(state, { pieceId: 1, targetPos: { x: 2, y: 3 } })).toBe(true);

    const delta = applyMove(state, { pieceId: 1, targetPos: { x: 2, y: 3 } });
    expect(delta.capture).toBeDefined();
    expect(delta.capture?.attackerId).toBe(1);
    expect(delta.capture?.victimId).toBe(2);
    expect(delta.capture?.pos).toEqual({ x: 2, y: 3 });

    // Target piece is marked dead
    const deadPiece = delta.nextState.pieces.get(2);
    expect(deadPiece?.isAlive).toBe(false);

    // Mover updated
    const mover = delta.nextState.pieces.get(1);
    expect(mover?.pos).toEqual({ x: 2, y: 3 });
  });

  it('TC_ENG_007: Tuyệt diệt chủng loại - capturing last Scissors triggers EXTINCTION', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 2] },
      { id: 2, owner: 'BLACK', type: 'SCISSORS', pos: [2, 3] }, // Only scissors for Black
      { id: 3, owner: 'BLACK', type: 'ROCK', pos: [5, 5] },
    ]);

    const delta = applyMove(state, { pieceId: 1, targetPos: { x: 2, y: 3 } });
    expect(delta.nextState.isGameOver).toBe(true);
    expect(delta.nextState.winner).toBe(PlayerSide.WHITE);
    expect(delta.nextState.winReason).toBe(WinReason.EXTINCTION);
  });

  it('TC_ENG_008: Chiếm ô chốt - White piece moving into Black Throne (4, 7) triggers THRONE_BREACH', () => {
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [4, 6] },
      { id: 2, owner: 'BLACK', type: 'PAPER', pos: [0, 7] },
    ]);

    const delta = applyMove(state, { pieceId: 1, targetPos: { x: 4, y: 7 } });
    expect(delta.nextState.isGameOver).toBe(true);
    expect(delta.nextState.winner).toBe(PlayerSide.WHITE);
    expect(delta.nextState.winReason).toBe(WinReason.THRONE_BREACH);
  });

  it('TC_ENG_009: Bế tắc nước đi - Black has 0 legal moves on their turn triggers STALEMATE', () => {
    // Black piece at (0, 0) surrounded completely:
    // Its neighbors are (1, 0), (0, 1), (1, 1).
    // Let all 3 neighbors be occupied by Black Rocks (same type = friendly fire)
    // Wait, if it has no moves, when White passes/moves away, Black turn starts with 0 moves!
    // Or simpler: Black piece is Scissors at (0, 0).
    // Neighbors (1, 0), (0, 1), (1, 1) are occupied by White Rocks (suicide prevention prevents Scissors from moving!)
    const state = createInitialGameState(topology, [
      { id: 1, owner: 'WHITE', type: 'PAPER', pos: [7, 7] },
      { id: 10, owner: 'BLACK', type: 'SCISSORS', pos: [0, 0] },
      { id: 2, owner: 'WHITE', type: 'ROCK', pos: [1, 0] },
      { id: 3, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
      { id: 4, owner: 'WHITE', type: 'ROCK', pos: [1, 1] },
    ]);

    // White moves piece 1 from (7,7) to (6,7)
    const delta = applyMove(state, { pieceId: 1, targetPos: { x: 6, y: 7 } });

    // Now it is Black's turn (activePlayer = BLACK)
    // Black's only piece is Scissors at (0,0), all 3 neighbors are White Rocks (suicide = illegal)
    expect(delta.nextState.activePlayer).toBe(PlayerSide.BLACK);
    expect(delta.nextState.isGameOver).toBe(true);
    expect(delta.nextState.winner).toBe(PlayerSide.WHITE);
    expect(delta.nextState.winReason).toBe(WinReason.STALEMATE);
  });

  it('TC_ENG_010: Ngưỡng Max Turns - piece count advantage wins', () => {
    // Create state near max turns
    const state: GameState = {
      map: topology,
      pieces: new Map<number, Piece>([
        [1, { id: 1, owner: PlayerSide.WHITE, type: PieceType.ROCK, pos: { x: 1, y: 1 }, isAlive: true }],
        [2, { id: 2, owner: PlayerSide.WHITE, type: PieceType.PAPER, pos: { x: 1, y: 2 }, isAlive: true }],
        [3, { id: 3, owner: PlayerSide.BLACK, type: PieceType.ROCK, pos: { x: 7, y: 7 }, isAlive: true }],
      ]),
      grid: new Map<string, number>([
        ['1,1', 1],
        ['1,2', 2],
        ['7,7', 3],
      ]),
      turnNumber: 300,
      activePlayer: PlayerSide.BLACK,
      maxTurns: 300,
      isGameOver: false,
    };

    // Black makes move on turn 300
    const delta = applyMove(state, { pieceId: 3, targetPos: { x: 6, y: 7 } });
    expect(delta.nextState.isGameOver).toBe(true);
    // White has 2 pieces, Black has 1 piece -> White wins
    expect(delta.nextState.winner).toBe(PlayerSide.WHITE);
    expect(delta.nextState.winReason).toBe(WinReason.MAX_TURNS_DRAW);
  });

  it('TC_ENG_010: Ngưỡng Max Turns - equal pieces resolved by Integer-scaled Proximity Score', () => {
    // White piece closer to Black Throne (4, 7): e.g. at (4, 5) => dist = 2
    // Black piece farther from White Throne (3, 0): e.g. at (7, 7) => dist = max(|7-3|, |7-0|) = 7
    const state: GameState = {
      map: topology,
      pieces: new Map<number, Piece>([
        [1, { id: 1, owner: PlayerSide.WHITE, type: PieceType.ROCK, pos: { x: 4, y: 4 }, isAlive: true }],
        [2, { id: 2, owner: PlayerSide.BLACK, type: PieceType.ROCK, pos: { x: 7, y: 7 }, isAlive: true }],
      ]),
      grid: new Map<string, number>([
        ['4,4', 1],
        ['7,7', 2],
      ]),
      turnNumber: 300,
      activePlayer: PlayerSide.BLACK,
      maxTurns: 300,
      isGameOver: false,
    };

    // Black moves on turn 300
    const delta = applyMove(state, { pieceId: 2, targetPos: { x: 6, y: 7 } });
    expect(delta.nextState.isGameOver).toBe(true);
    // Equal pieces (1 vs 1), but White is much closer to (4, 7) than Black to (3, 0)
    expect(delta.nextState.winner).toBe(PlayerSide.WHITE);
    expect(delta.nextState.winReason).toBe(WinReason.MAX_TURNS_DRAW);
  });

  it('TC_ENG_010: Ngưỡng Max Turns - equal pieces and equal proximity score resolved by Draw', () => {
    // Symmetrical positioning with identical distance to enemy thrones
    // White Throne: (3, 0), Black Throne: (4, 7)
    // Put White at (4, 6) -> dist to (4, 7) is 1
    // Put Black at (3, 1) -> dist to (3, 0) is 1
    const state: GameState = {
      map: topology,
      pieces: new Map<number, Piece>([
        [1, { id: 1, owner: PlayerSide.WHITE, type: PieceType.ROCK, pos: { x: 4, y: 5 }, isAlive: true }],
        [2, { id: 2, owner: PlayerSide.BLACK, type: PieceType.ROCK, pos: { x: 3, y: 2 }, isAlive: true }],
      ]),
      grid: new Map<string, number>([
        ['4,5', 1],
        ['3,2', 2],
      ]),
      turnNumber: 300,
      activePlayer: PlayerSide.BLACK,
      maxTurns: 300,
      isGameOver: false,
    };

    // Black moves to (3, 1) -> dist to White Throne (3, 0) is 1
    // White is at (4, 5) -> dist to Black Throne (4, 7) is 2
    // Let's make sure both have equal proximity score after move:
    // If White is at (4, 5), dist to (4, 7) is 2.
    // If Black is at (3, 2), and moves to (3, 3) wait, (3,3) is hole!
    // Let's place Black at (0, 3) and White at (7, 4) with symmetrical distances:
    // White at (7, 4): dist to (4, 7) is max(|7-4|, |4-7|) = 3.
    // Black at (0, 3): dist to (3, 0) is max(|0-3|, |3-0|) = 3.
    // If Black moves to (1, 3): dist to (3, 0) is max(|1-3|, |3-0|) = 3.
    // Both dist = 3 => ProximityScore = floor(25200 / (3 + 1)) = 6300 each!
    const symState: GameState = {
      map: topology,
      pieces: new Map<number, Piece>([
        [1, { id: 1, owner: PlayerSide.WHITE, type: PieceType.ROCK, pos: { x: 7, y: 4 }, isAlive: true }],
        [2, { id: 2, owner: PlayerSide.BLACK, type: PieceType.ROCK, pos: { x: 0, y: 3 }, isAlive: true }],
      ]),
      grid: new Map<string, number>([
        ['7,4', 1],
        ['0,3', 2],
      ]),
      turnNumber: 300,
      activePlayer: PlayerSide.BLACK,
      maxTurns: 300,
      isGameOver: false,
    };

    const delta = applyMove(symState, { pieceId: 2, targetPos: { x: 1, y: 3 } });
    expect(delta.nextState.isGameOver).toBe(true);
    expect(delta.nextState.winner).toBeUndefined();
    expect(delta.nextState.winReason).toBe(WinReason.MAX_TURNS_DRAW);
  });
});
