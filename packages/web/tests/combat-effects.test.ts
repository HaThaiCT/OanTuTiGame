import { describe, it, expect } from 'vitest';
import {
  FloatingCombatText,
  createFloatingText,
  updateFloatingTexts,
  calculateScreenShakeOffset,
} from '../src/canvas/renderer.js';

describe('Combat Effects: Floating Text & Screen Shake', () => {
  it('creates floating combat text with valid initial coordinates and alpha', () => {
    const list: FloatingCombatText[] = [];
    createFloatingText(list, 'KILL!', 200, 300, '#ef4444');

    expect(list.length).toBe(1);
    expect(list[0].text).toBe('KILL!');
    expect(list[0].x).toBe(200);
    expect(list[0].y).toBe(300);
    expect(list[0].color).toBe('#ef4444');
    expect(list[0].alpha).toBe(1);
    expect(list[0].life).toBe(0);
  });

  it('updates floating texts: drifts upward, decays alpha, and removes expired text', () => {
    const list: FloatingCombatText[] = [];
    createFloatingText(list, 'BREACH!', 100, 100);

    const initialY = list[0].y;
    updateFloatingTexts(list);

    expect(list.length).toBe(1);
    expect(list[0].y).toBeLessThan(initialY); // Drifts upward
    expect(list[0].alpha).toBeLessThan(1); // Fading
    expect(list[0].life).toBe(1);

    // Fast forward to end of life
    list[0].life = list[0].maxLife;
    updateFloatingTexts(list);
    expect(list.length).toBe(0); // Cleaned up
  });

  it('calculates screen shake offset that decays to 0 after duration', () => {
    const now = 1000;
    // Shake active
    const offset1 = calculateScreenShakeOffset(now, now, 200, 4);
    expect(Math.abs(offset1.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(offset1.y)).toBeLessThanOrEqual(4);

    // Shake expired
    const offset2 = calculateScreenShakeOffset(now + 250, now, 200, 4);
    expect(offset2).toEqual({ x: 0, y: 0 });
  });
});
