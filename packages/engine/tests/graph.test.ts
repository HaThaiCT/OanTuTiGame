import { describe, it, expect } from 'vitest';
import {
  chebyshevDistance,
  createMapTopology,
  validateMapTopology,
  MapDescriptor,
  KING_DIRECTIONS,
} from '../src/graph.js';
import sampleDonut from '../../../docs/specs/maps/sample-donut.map.json';

describe('Map Topology Graph & Chebyshev Distance', () => {
  it('calculates Chebyshev distance correctly', () => {
    expect(chebyshevDistance({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
    expect(chebyshevDistance({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(1);
    expect(chebyshevDistance({ x: 1, y: 1 }, { x: 4, y: 2 })).toBe(3);
    expect(chebyshevDistance({ x: 5, y: 1 }, { x: 2, y: 7 })).toBe(6);
  });

  it('defines exactly 8 King-directions', () => {
    expect(KING_DIRECTIONS.length).toBe(8);
  });

  it('creates topology and checks valid tiles and donut hole', () => {
    const topology = createMapTopology(sampleDonut as unknown as MapDescriptor);
    expect(topology.mapName).toBe('Donut Citadel');
    expect(topology.width).toBe(8);
    expect(topology.height).toBe(8);

    // Valid tiles
    expect(topology.isValidTile(0, 0)).toBe(true);
    expect(topology.isValidTile(1, 1)).toBe(true);
    expect(topology.isValidTile(3, 0)).toBe(true);

    // Donut hole tiles
    expect(topology.isValidTile(3, 3)).toBe(false);
    expect(topology.isValidTile(4, 3)).toBe(false);
    expect(topology.isValidTile(3, 4)).toBe(false);
    expect(topology.isValidTile(4, 4)).toBe(false);

    // Out of bounds
    expect(topology.isValidTile(-1, 0)).toBe(false);
    expect(topology.isValidTile(8, 8)).toBe(false);

    // Thrones
    expect(topology.whiteThrone).toEqual({ x: 3, y: 0 });
    expect(topology.blackThrone).toEqual({ x: 4, y: 7 });
  });

  it('computes neighbors excluding invalid tiles and donut hole', () => {
    const topology = createMapTopology(sampleDonut as unknown as MapDescriptor);

    // Corner (0,0) has 3 valid neighbors: (1,0), (0,1), (1,1)
    const cornerNeighbors = topology.getNeighbors({ x: 0, y: 0 });
    expect(cornerNeighbors.length).toBe(3);

    // Tile adjacent to hole: (2, 3)
    // Neighbors would normally be 8, but (3,3) and (3,4) are missing from validTiles
    const nearHoleNeighbors = topology.getNeighbors({ x: 2, y: 3 });
    const hasHoleTile = nearHoleNeighbors.some((c) => c.x === 3 && c.y === 3);
    expect(hasHoleTile).toBe(false);
  });

  it('validates a correct map descriptor', () => {
    const res = validateMapTopology(sampleDonut as unknown as MapDescriptor);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('rejects maps with invalid dimensions or unreachable thrones', () => {
    const badDesc: MapDescriptor = {
      mapName: 'Bad Map',
      width: 2, // invalid: min 3
      height: 8,
      validTiles: [
        [0, 0], [1, 0], [0, 1], [1, 1],
        [0, 2], [1, 2], [0, 3], [1, 3], [0, 4]
      ],
      whiteThrone: [0, 0],
      blackThrone: [1, 4],
      startingPieces: [],
    };
    const res = validateMapTopology(badDesc);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Width must be an integer between 3 and 64'))).toBe(true);
  });

  it('rejects maps where White Throne and Black Throne are disconnected', () => {
    const disconnectedDesc: MapDescriptor = {
      mapName: 'Island Map',
      width: 10,
      height: 10,
      validTiles: [
        // Component 1 (White side)
        [0, 0], [1, 0], [0, 1], [1, 1], [0, 2],
        // Component 2 (Black side - disconnected by space)
        [8, 8], [9, 8], [8, 9], [9, 9]
      ],
      whiteThrone: [0, 0],
      blackThrone: [9, 9],
      startingPieces: [],
    };
    const res = validateMapTopology(disconnectedDesc);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('is not reachable from White Throne'))).toBe(true);
  });

  it('rejects maps where thrones are not in validTiles', () => {
    const invalidThroneDesc: MapDescriptor = {
      mapName: 'Invalid Throne Map',
      width: 5,
      height: 5,
      validTiles: [
        [0, 0], [1, 0], [2, 0],
        [0, 1], [1, 1], [2, 1],
        [0, 2], [1, 2], [2, 2]
      ],
      whiteThrone: [4, 4], // not in validTiles
      blackThrone: [0, 0],
      startingPieces: [],
    };
    const res = validateMapTopology(invalidThroneDesc);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('whiteThrone [4, 4] is not in validTiles'))).toBe(true);
  });
});
