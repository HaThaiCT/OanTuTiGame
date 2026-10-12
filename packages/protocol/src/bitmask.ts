/**
 * Bitmask Compression for Generalized Grid Graph G = (V, E)
 * Maps 2D coordinates (x, y) in a W x H bounding box into a compact bitmask.
 * Size: ceil(W * H / 8) bytes.
 */

export function encodeValidTilesBitmask(
  width: number,
  height: number,
  validTiles: readonly [number, number][]
): Uint8Array {
  const totalBits = width * height;
  const numBytes = Math.ceil(totalBits / 8);
  const bitmask = new Uint8Array(numBytes);

  for (const [x, y] of validTiles) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const k = y * width + x;
      const byteIdx = Math.floor(k / 8);
      const bitIdx = k % 8;
      bitmask[byteIdx] |= 1 << bitIdx;
    }
  }

  return bitmask;
}

export function isTileValidInBitmask(
  width: number,
  height: number,
  bitmask: Uint8Array,
  x: number,
  y: number
): boolean {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return false;
  }
  const k = y * width + x;
  const byteIdx = Math.floor(k / 8);
  const bitIdx = k % 8;
  if (byteIdx >= bitmask.length) {
    return false;
  }
  return (bitmask[byteIdx] & (1 << bitIdx)) !== 0;
}

export function decodeValidTilesBitmask(
  width: number,
  height: number,
  bitmask: Uint8Array
): Array<[number, number]> {
  const result: Array<[number, number]> = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      const byteIdx = Math.floor(k / 8);
      const bitIdx = k % 8;
      if (byteIdx < bitmask.length && (bitmask[byteIdx] & (1 << bitIdx)) !== 0) {
        result.push([x, y]);
      }
    }
  }

  return result;
}
