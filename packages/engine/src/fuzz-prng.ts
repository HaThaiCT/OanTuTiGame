/**
 * Fast Deterministic 32-bit PRNG (Mulberry32)
 * High-quality pseudo-randomness for deterministic fuzzing and simulation.
 * Pure integer bitwise arithmetic, zero external dependencies.
 */

export class SeededPRNG {
  private state: number;

  constructor(seed: number) {
    this.state = (seed ^ 0xdeadbeef) >>> 0;
  }

  /**
   * Returns a deterministic 32-bit unsigned integer.
   */
  nextUint32(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Returns an integer in range [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    if (min >= max) return min;
    const range = max - min + 1;
    return min + (this.nextUint32() % range);
  }

  /**
   * Random choice from an array.
   */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from empty array');
    }
    const idx = this.nextUint32() % items.length;
    return items[idx];
  }
}
