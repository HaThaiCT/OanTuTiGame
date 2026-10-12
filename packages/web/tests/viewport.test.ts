import { describe, it, expect } from 'vitest';
import {
  calculateViewportTransform,
  boardToScreen,
  boardToScreenCenter,
  screenToBoard,
} from '../src/canvas/viewport.js';
import { generateDefaultMatch } from '../src/replay/mock-generator.js';

describe('Web Canvas 2D Viewport Transform Suite', () => {
  it('calculates auto-fit scale and offsets correctly', () => {
    // 800x600 canvas with 8x8 board and 24px pad
    // available width: 800 - 48 = 752 / 8 = 94
    // available height: 600 - 48 = 552 / 8 = 69
    // tileSize should be 69
    const transform = calculateViewportTransform(800, 600, 8, 8, 24);
    expect(transform.tileSize).toBe(69);
    expect(transform.offsetX).toBe((800 - 8 * 69) / 2); // (800 - 552) / 2 = 124
    expect(transform.offsetY).toBe((600 - 8 * 69) / 2); // 24
  });

  it('maps board coordinates to screen and centers', () => {
    const transform = calculateViewportTransform(800, 800, 8, 8, 0);
    // 800 / 8 = 100 tileSize, 0 offset
    expect(transform.tileSize).toBe(100);
    expect(transform.offsetX).toBe(0);
    expect(transform.offsetY).toBe(0);

    const pt = boardToScreen(2, 3, transform);
    expect(pt).toEqual({ x: 200, y: 300 });

    const center = boardToScreenCenter(2, 3, transform);
    expect(center).toEqual({ x: 250, y: 350 });
  });

  it('maps mouse clicks back to board coordinates with boundary detection', () => {
    const transform = calculateViewportTransform(800, 800, 8, 8, 0);

    const inside = screenToBoard(250, 350, transform);
    expect(inside).toEqual({ x: 2, y: 3, isInBounds: true });

    const outsideNegative = screenToBoard(-10, 50, transform);
    expect(outsideNegative.isInBounds).toBe(false);

    const outsideExcess = screenToBoard(850, 50, transform);
    expect(outsideExcess.isInBounds).toBe(false);
  });

  it('generates working default match replay with snapshots', () => {
    const match = generateDefaultMatch();
    expect(match.init.matchId).toBe('sample_donut_showcase');
    expect(match.snapshots.length).toBeGreaterThan(1);
    expect(match.snapshots[0].turnNumber).toBe(0);
    expect(match.snapshots[0].pieces.length).toBe(12);
  });
});
