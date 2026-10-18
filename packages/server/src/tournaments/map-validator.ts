import type { MapDescriptor, StartingPieceDescriptor } from '@oantuti/engine';

export interface MapValidationWarning {
  readonly code: 'UNBALANCED_PIECES' | 'DISCONNECTED_TILES' | 'OCCUPIED_THRONE' | 'ASYMMETRIC_DISTANCE';
  readonly message: string;
}

export interface MapValidationResult {
  readonly isValid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly MapValidationWarning[];
}

export class MapValidator {
  validate(descriptor: MapDescriptor): MapValidationResult {
    const errors: string[] = [];
    const warnings: MapValidationWarning[] = [];

    // 1. Dimensions
    if (descriptor.width < 3 || descriptor.height < 3) {
      errors.push(`Dimensions too small: width ${descriptor.width}, height ${descriptor.height}; minimum is 3x3`);
    }
    if (descriptor.width * descriptor.height > 4096) {
      errors.push(`Tile count ${descriptor.width * descriptor.height} exceeds maximum 4096`);
    }

    // 2. Valid tiles set
    const tileSet = new Set<string>();
    for (const [x, y] of descriptor.validTiles) {
      if (x < 0 || x >= descriptor.width || y < 0 || y >= descriptor.height) {
        errors.push(`Tile [${x}, ${y}] is outside map boundaries [0, 0] to [${descriptor.width - 1}, ${descriptor.height - 1}]`);
      }
      const key = `${x},${y}`;
      if (tileSet.has(key)) {
        errors.push(`Duplicate valid tile [${x}, ${y}]`);
      }
      tileSet.add(key);
    }

    // 3. Thrones
    const [wx, wy] = descriptor.whiteThrone;
    const [bx, by] = descriptor.blackThrone;

    if (!tileSet.has(`${wx},${wy}`)) {
      errors.push(`White throne [${wx}, ${wy}] is not on a valid tile`);
    }
    if (!tileSet.has(`${bx},${by}`)) {
      errors.push(`Black throne [${bx}, ${by}] is not on a valid tile`);
    }
    if (wx === bx && wy === by) {
      errors.push('White and black thrones cannot occupy the exact same coordinate');
    }

    // 4. Starting Pieces validation
    let whitePieces = 0;
    let blackPieces = 0;
    const occupiedTiles = new Map<string, StartingPieceDescriptor>();

    for (const piece of descriptor.startingPieces) {
      const [px, py] = piece.pos;
      const key = `${px},${py}`;

      if (!tileSet.has(key)) {
        errors.push(`Starting piece ${piece.id} at [${px}, ${py}] is not on a valid tile`);
      }
      if (occupiedTiles.has(key)) {
        errors.push(`Multiple starting pieces at tile [${px}, ${py}]`);
      }
      occupiedTiles.set(key, piece);

      if (piece.owner === 'WHITE') whitePieces++;
      else if (piece.owner === 'BLACK') blackPieces++;

      // Check occupied throne warning (not fairness rejection per spec)
      if (px === wx && py === wy) {
        warnings.push({
          code: 'OCCUPIED_THRONE',
          message: `White throne [${wx}, ${wy}] is occupied at game start by piece ${piece.id} (${piece.owner})`,
        });
      }
      if (px === bx && py === by) {
        warnings.push({
          code: 'OCCUPIED_THRONE',
          message: `Black throne [${bx}, ${by}] is occupied at game start by piece ${piece.id} (${piece.owner})`,
        });
      }
    }

    // Warnings: Piece imbalance
    if (whitePieces !== blackPieces) {
      warnings.push({
        code: 'UNBALANCED_PIECES',
        message: `Piece count asymmetry: White has ${whitePieces} pieces, Black has ${blackPieces} pieces`,
      });
    }

    // Warnings: Disconnected tiles (BFS reachability)
    if (tileSet.size > 0 && errors.length === 0) {
      const visited = new Set<string>();
      const queue: [number, number][] = [[wx, wy]];
      visited.add(`${wx},${wy}`);

      while (queue.length > 0) {
        const [cx, cy] = queue.shift()!;
        // 8-directional neighbors (Chebyshev)
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            const nKey = `${nx},${ny}`;
            if (tileSet.has(nKey) && !visited.has(nKey)) {
              visited.add(nKey);
              queue.push([nx, ny]);
            }
          }
        }
      }

      if (visited.size < tileSet.size) {
        warnings.push({
          code: 'DISCONNECTED_TILES',
          message: `Map has disconnected components: ${tileSet.size - visited.size} tiles are unreachable from White throne`,
        });
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
