/**
 * Map Topology Graph for OanTuTi Arena
 * Generalized Grid Graph G = (V, E) with 8 King-step directions and Chebyshev distance.
 */

export interface Coord {
  readonly x: number;
  readonly y: number;
}

export interface StartingPieceDescriptor {
  readonly id: number;
  readonly owner: 'WHITE' | 'BLACK';
  readonly type: 'ROCK' | 'SCISSORS' | 'PAPER';
  readonly pos: [number, number];
}

export interface MapDescriptor {
  readonly mapName: string;
  readonly width: number;
  readonly height: number;
  readonly validTiles: [number, number][];
  readonly whiteThrone: [number, number];
  readonly blackThrone: [number, number];
  readonly startingPieces: StartingPieceDescriptor[];
}

export interface MapTopology {
  readonly mapName: string;
  readonly width: number;
  readonly height: number;
  readonly whiteThrone: Coord;
  readonly blackThrone: Coord;
  readonly validTilesList: readonly Coord[];
  isValidTile(x: number, y: number): boolean;
  getNeighbors(coord: Coord): Coord[];
  chebyshevDistance(a: Coord, b: Coord): number;
}

export const KING_DIRECTIONS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

export function chebyshevDistance(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function createMapTopology(desc: MapDescriptor): MapTopology {
  const tileSet = new Set<string>();
  const validTilesList: Coord[] = [];

  for (const [x, y] of desc.validTiles) {
    const key = `${x},${y}`;
    if (!tileSet.has(key)) {
      tileSet.add(key);
      validTilesList.push({ x, y });
    }
  }

  const whiteThrone: Coord = { x: desc.whiteThrone[0], y: desc.whiteThrone[1] };
  const blackThrone: Coord = { x: desc.blackThrone[0], y: desc.blackThrone[1] };

  const isValidTile = (x: number, y: number): boolean => {
    return tileSet.has(`${x},${y}`);
  };

  const getNeighbors = (coord: Coord): Coord[] => {
    const neighbors: Coord[] = [];
    for (const [dx, dy] of KING_DIRECTIONS) {
      const nx = coord.x + dx;
      const ny = coord.y + dy;
      if (isValidTile(nx, ny)) {
        neighbors.push({ x: nx, y: ny });
      }
    }
    return neighbors;
  };

  return {
    mapName: desc.mapName,
    width: desc.width,
    height: desc.height,
    whiteThrone,
    blackThrone,
    validTilesList,
    isValidTile,
    getNeighbors,
    chebyshevDistance,
  };
}

export function validateMapTopology(desc: MapDescriptor): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!desc.mapName || typeof desc.mapName !== 'string') {
    errors.push('Map name must be a non-empty string');
  }

  if (!Number.isInteger(desc.width) || desc.width < 3 || desc.width > 64) {
    errors.push(`Width must be an integer between 3 and 64 (got ${desc.width})`);
  }

  if (!Number.isInteger(desc.height) || desc.height < 3 || desc.height > 64) {
    errors.push(`Height must be an integer between 3 and 64 (got ${desc.height})`);
  }

  if (!Array.isArray(desc.validTiles) || desc.validTiles.length < 9) {
    errors.push(`validTiles must contain at least 9 tiles (got ${desc.validTiles?.length})`);
  }

  const tileSet = new Set<string>();
  if (Array.isArray(desc.validTiles)) {
    for (const tile of desc.validTiles) {
      if (!Array.isArray(tile) || tile.length !== 2) {
        errors.push(`Invalid tile format: ${JSON.stringify(tile)}`);
        continue;
      }
      const [x, y] = tile;
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        errors.push(`Tile coordinates must be integers: [${x}, ${y}]`);
      } else if (x < 0 || x >= desc.width || y < 0 || y >= desc.height) {
        errors.push(`Tile [${x}, ${y}] is outside map bounding box ${desc.width}x${desc.height}`);
      }
      const key = `${x},${y}`;
      if (tileSet.has(key)) {
        errors.push(`Duplicate tile detected at [${x}, ${y}]`);
      }
      tileSet.add(key);
    }
  }

  if (!Array.isArray(desc.whiteThrone) || desc.whiteThrone.length !== 2) {
    errors.push('whiteThrone must be a 2-element coordinate [x, y]');
  } else {
    const key = `${desc.whiteThrone[0]},${desc.whiteThrone[1]}`;
    if (!tileSet.has(key)) {
      errors.push(`whiteThrone [${desc.whiteThrone[0]}, ${desc.whiteThrone[1]}] is not in validTiles`);
    }
  }

  if (!Array.isArray(desc.blackThrone) || desc.blackThrone.length !== 2) {
    errors.push('blackThrone must be a 2-element coordinate [x, y]');
  } else {
    const key = `${desc.blackThrone[0]},${desc.blackThrone[1]}`;
    if (!tileSet.has(key)) {
      errors.push(`blackThrone [${desc.blackThrone[0]}, ${desc.blackThrone[1]}] is not in validTiles`);
    }
  }

  if (
    Array.isArray(desc.whiteThrone) &&
    Array.isArray(desc.blackThrone) &&
    desc.whiteThrone[0] === desc.blackThrone[0] &&
    desc.whiteThrone[1] === desc.blackThrone[1]
  ) {
    errors.push('whiteThrone and blackThrone cannot occupy the same tile');
  }

  // BFS Reachability between White Throne and Black Throne
  if (errors.length === 0) {
    const topology = createMapTopology(desc);
    const startKey = `${topology.whiteThrone.x},${topology.whiteThrone.y}`;
    const targetKey = `${topology.blackThrone.x},${topology.blackThrone.y}`;

    const queue: Coord[] = [topology.whiteThrone];
    const visited = new Set<string>([startKey]);
    let reachable = false;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.x === topology.blackThrone.x && current.y === topology.blackThrone.y) {
        reachable = true;
        break;
      }
      for (const next of topology.getNeighbors(current)) {
        const nextKey = `${next.x},${next.y}`;
        if (!visited.has(nextKey)) {
          visited.add(nextKey);
          queue.push(next);
        }
      }
    }

    if (!reachable) {
      errors.push(
        `Black Throne [${desc.blackThrone[0]}, ${desc.blackThrone[1]}] is not reachable from White Throne [${desc.whiteThrone[0]}, ${desc.whiteThrone[1]}]`
      );
    }
  }

  // Validate starting pieces if provided
  if (Array.isArray(desc.startingPieces)) {
    const pieceIds = new Set<number>();
    const piecePositions = new Set<string>();

    for (const p of desc.startingPieces) {
      if (!Number.isInteger(p.id) || p.id <= 0) {
        errors.push(`Invalid piece id: ${p.id}`);
      } else if (pieceIds.has(p.id)) {
        errors.push(`Duplicate piece id: ${p.id}`);
      }
      pieceIds.add(p.id);

      if (p.owner !== 'WHITE' && p.owner !== 'BLACK') {
        errors.push(`Invalid piece owner for piece ${p.id}: ${p.owner}`);
      }

      if (p.type !== 'ROCK' && p.type !== 'SCISSORS' && p.type !== 'PAPER') {
        errors.push(`Invalid piece type for piece ${p.id}: ${p.type}`);
      }

      if (!Array.isArray(p.pos) || p.pos.length !== 2) {
        errors.push(`Invalid position for piece ${p.id}: ${JSON.stringify(p.pos)}`);
      } else {
        const key = `${p.pos[0]},${p.pos[1]}`;
        if (!tileSet.has(key)) {
          errors.push(`Piece ${p.id} position [${p.pos[0]}, ${p.pos[1]}] is not on a valid tile`);
        }
        if (piecePositions.has(key)) {
          errors.push(`Multiple pieces share initial position [${p.pos[0]}, ${p.pos[1]}]`);
        }
        piecePositions.add(key);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
