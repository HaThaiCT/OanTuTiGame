import { expect, it } from 'vitest';
import { createMapTopology, createInitialGameState, evaluateVictory, evaluateVictoryV2, applyMoveV2, PlayerSide } from '../src/index.js';
import type { MapDescriptor } from '../src/graph.js';

const map: MapDescriptor = {
  mapName: 'v2-boundaries', width: 3, height: 3,
  validTiles: Array.from({ length: 9 }, (_, i) => [i % 3, Math.floor(i / 3)] as [number, number]),
  whiteThrone: [0, 0], blackThrone: [2, 2], startingPieces: [],
};

it('simultaneous throne breach is no contest only in v2', () => {
  const state = createInitialGameState(createMapTopology(map), [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 2] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [0, 0] },
  ]);
  expect(evaluateVictoryV2(state)).toEqual({ isGameOver: true, reason: 'INVALID_START_BOTH_SIDES', disposition: 'NO_CONTEST' });
  expect(evaluateVictory(state).winner).toBe(PlayerSide.WHITE);
});

it('material and proximity wins have distinct v2 reasons', () => {
  const state = createInitialGameState(createMapTopology(map), [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, 2] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 0] },
    { id: 3, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
  ]);
  expect(evaluateVictoryV2({ ...state, turnNumber: 301 }).reason).toBe('MAX_TURNS_MATERIAL');
  const pieces = new Map(state.pieces); pieces.delete(3);
  const grid = new Map(state.grid); grid.delete('0,1');
  expect(evaluateVictoryV2({ ...state, pieces, grid, turnNumber: 301 }).reason).toBe('MAX_TURNS_PROXIMITY');
});

it('extinction takes precedence over reaching the opposing throne', () => {
  const state = createInitialGameState(createMapTopology(map), [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, 2] },
    { id: 2, owner: 'BLACK', type: 'SCISSORS', pos: [2, 2] },
  ]);
  const result = applyMoveV2(state, { pieceId: 1, targetPos: { x: 2, y: 2 } });
  expect(result.outcome).toEqual({ isGameOver: true, winner: PlayerSide.WHITE, reason: 'EXTINCTION', disposition: 'DECISIVE' });
});
