import { describe, it, expect } from 'vitest';
import type { MapDescriptor } from '@oantuti/engine';
import { MapValidator } from '../src/tournaments/map-validator.js';

/** S08: the map authoring check uses the engine's own verdict for an already-decided start. */
describe('S08: initial-terminal map warning', () => {
  const validator = new MapValidator();
  const tiles: [number, number][] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) tiles.push([x, y]);

  function descriptor(pieces: MapDescriptor['startingPieces']): MapDescriptor {
    return {
      mapName: 'initial-terminal-fixture',
      width: 3,
      height: 3,
      validTiles: tiles,
      whiteThrone: [0, 2],
      blackThrone: [2, 0],
      startingPieces: pieces,
    };
  }

  it('warns when the side to move starts without a legal move (stalemate at ply 0)', () => {
    // White's rock is boxed in by paper it cannot capture, so the opening position is terminal.
    const result = validator.validate(
      descriptor([
        { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 0] },
        { id: 2, owner: 'BLACK', type: 'PAPER', pos: [1, 0] },
        { id: 3, owner: 'BLACK', type: 'PAPER', pos: [0, 1] },
        { id: 4, owner: 'BLACK', type: 'PAPER', pos: [1, 1] },
      ])
    );
    expect(result.isValid).toBe(true);
    const warning = result.warnings.find((entry) => entry.code === 'INITIAL_TERMINAL');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('ply 0');
  });

  it('warns when an enemy piece already stands on a throne', () => {
    const result = validator.validate(
      descriptor([
        { id: 1, owner: 'WHITE', type: 'ROCK', pos: [2, 0] },
        { id: 2, owner: 'WHITE', type: 'SCISSORS', pos: [0, 1] },
        { id: 3, owner: 'BLACK', type: 'PAPER', pos: [1, 1] },
        { id: 4, owner: 'BLACK', type: 'ROCK', pos: [0, 0] },
      ])
    );
    expect(result.warnings.some((entry) => entry.code === 'INITIAL_TERMINAL')).toBe(true);
  });

  it('stays quiet for an empty lineup placeholder', () => {
    const result = validator.validate(descriptor([]));
    expect(result.warnings.some((entry) => entry.code === 'INITIAL_TERMINAL')).toBe(false);
  });

  it('stays quiet for a normal opening position', () => {
    const result = validator.validate(
      descriptor([
        { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
        { id: 2, owner: 'WHITE', type: 'SCISSORS', pos: [1, 1] },
        { id: 3, owner: 'BLACK', type: 'ROCK', pos: [2, 1] },
        { id: 4, owner: 'BLACK', type: 'SCISSORS', pos: [1, 0] },
      ])
    );
    expect(result.warnings.some((entry) => entry.code === 'INITIAL_TERMINAL')).toBe(false);
  });
});
