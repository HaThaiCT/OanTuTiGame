/**
 * Camera Viewport Transform Engine
 * Adheres strictly to docs/specs/06-UI-UX-VISUALIZER-SPEC.md Section 2.
 * Calculates auto-fit scaling and centering for generalized grid graphs G = (V, E).
 */

export interface ViewportTransform {
  readonly tileSize: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly padding: number;
}

export function calculateViewportTransform(
  canvasWidth: number,
  canvasHeight: number,
  boardWidth: number,
  boardHeight: number,
  padding: number = 24
): ViewportTransform {
  const safePad = Math.max(0, padding);
  const availableWidth = Math.max(10, canvasWidth - 2 * safePad);
  const availableHeight = Math.max(10, canvasHeight - 2 * safePad);

  const tileSize = Math.max(
    1,
    Math.min(availableWidth / boardWidth, availableHeight / boardHeight)
  );

  const offsetX = (canvasWidth - boardWidth * tileSize) / 2;
  const offsetY = (canvasHeight - boardHeight * tileSize) / 2;

  return {
    tileSize,
    offsetX,
    offsetY,
    canvasWidth,
    canvasHeight,
    boardWidth,
    boardHeight,
    padding: safePad,
  };
}

export function boardToScreen(
  x: number,
  y: number,
  transform: ViewportTransform
): { x: number; y: number } {
  return {
    x: transform.offsetX + x * transform.tileSize,
    y: transform.offsetY + y * transform.tileSize,
  };
}

export function boardToScreenCenter(
  x: number,
  y: number,
  transform: ViewportTransform
): { x: number; y: number } {
  return {
    x: transform.offsetX + (x + 0.5) * transform.tileSize,
    y: transform.offsetY + (y + 0.5) * transform.tileSize,
  };
}

export function screenToBoard(
  screenX: number,
  screenY: number,
  transform: ViewportTransform
): { x: number; y: number; isInBounds: boolean } {
  const x = Math.floor((screenX - transform.offsetX) / transform.tileSize);
  const y = Math.floor((screenY - transform.offsetY) / transform.tileSize);
  const isInBounds =
    x >= 0 && x < transform.boardWidth && y >= 0 && y < transform.boardHeight;

  return { x, y, isInBounds };
}
