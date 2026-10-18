import { describe, it, expect } from 'vitest';
import {
  assertPairingArithmeticSafe,
  eloEdgeWeight,
  eloWeightBases,
  swissEdgeWeight,
  swissWeightBases,
} from '../src/tournaments/formats/pairing-weights.js';
import { PairingSolverError } from '../src/tournaments/formats/matching.js';

/**
 * The numbers here are the pinned `ArenaSwiss/v2` / `ArenaEloPair/v1` constants from
 * 02-GAMEPLAY-TOURNAMENT-RULES §79/§102 — the pairing objective has to be exact, so the bases are
 * asserted explicitly instead of being recomputed inside the implementation's own terms.
 */
describe('S09: pairing weights', () => {
  it('derives the Swiss bases from the round context', () => {
    // m = 2 (5 entrants, one bye), seeds 1..5, round 2.
    const bases = swissWeightBases({
      pairedSlots: 2,
      maxInitialSeed: 5,
      minInitialSeed: 1,
      roundOrdinal: 2,
    });
    expect(bases.smax).toBe(8); // 2 × (5 − 1)
    expect(bases.pmax).toBe(6); // 2 × 3 × (2 − 1)
    expect(bases.wp).toBe(9); // Smax + 1
    expect(bases.wr).toBe(63); // 6 × 9 + 8 + 1
  });

  it('makes one rematch outweigh every gap improvement combined', () => {
    for (const context of [
      { pairedSlots: 2, maxInitialSeed: 5, minInitialSeed: 1, roundOrdinal: 2 },
      { pairedSlots: 8, maxInitialSeed: 16, minInitialSeed: 1, roundOrdinal: 4 },
      { pairedSlots: 250, maxInitialSeed: 500, minInitialSeed: 1, roundOrdinal: 9 },
    ]) {
      const bases = swissWeightBases(context);
      // The worst possible gap term of a whole round is Pmax·Wp + Smax; the rematch term beats it,
      // which is what makes minimising the sum equivalent to the lexicographic objective.
      expect(bases.wr).toBeGreaterThan(bases.pmax * bases.wp + bases.smax);
    }
  });

  it('composes a Swiss edge exactly as specified', () => {
    const bases = swissWeightBases({ pairedSlots: 2, maxInitialSeed: 5, minInitialSeed: 1, roundOrdinal: 2 });
    expect(
      swissEdgeWeight({ rematch: false, pointsA: 3, pointsB: 3, seedA: 1, seedB: 2 }, bases)
    ).toBe(1); // no rematch, no point gap, one seed step
    expect(
      swissEdgeWeight({ rematch: false, pointsA: 3, pointsB: 0, seedA: 1, seedB: 4 }, bases)
    ).toBe(3 * 9 + 3); // 3 points × Wp + 3 seed steps
    expect(
      swissEdgeWeight({ rematch: true, pointsA: 3, pointsB: 3, seedA: 1, seedB: 2 }, bases)
    ).toBe(63 + 1);
  });

  it('keeps a 500-team final round inside exact integer range', () => {
    const bases = swissWeightBases({ pairedSlots: 250, maxInitialSeed: 500, minInitialSeed: 1, roundOrdinal: 9 });
    expect(bases.smax).toBe(124_750);
    expect(bases.wp).toBe(124_751);
    const worstRoundTotal = 250 * bases.wr;
    expect(Number.isSafeInteger(worstRoundTotal)).toBe(true);
    expect(worstRoundTotal).toBeLessThan(2 ** 53);
    expect(() => assertPairingArithmeticSafe(worstRoundTotal, 'swiss round')).not.toThrow();
    expect(() => assertPairingArithmeticSafe(Number.MAX_SAFE_INTEGER + 2, 'swiss round')).toThrowError(
      PairingSolverError
    );
  });

  it('derives and composes the Elo bases with the same dominance property', () => {
    const bases = eloWeightBases({ pairedSlots: 2, maxRatingGap: 400, maxDrawIndexGap: 5 });
    expect(bases.wrating).toBe(6); // maxDrawIndexGap + 1
    expect(bases.wpair).toBe(2 * 400 * 6 + 6); // m·maxRatingGap·Wrating + maxDrawIndexGap + 1
    expect(bases.wpair).toBeGreaterThan(2 * bases.wrating * 400 + 5);

    expect(
      eloEdgeWeight(
        { priorEncounters: 0, ratingMicroA: 1_200_000_000, ratingMicroB: 1_200_000_000, drawIndexA: 1, drawIndexB: 1 },
        bases
      )
    ).toBe(0);
    expect(
      eloEdgeWeight(
        { priorEncounters: 1, ratingMicroA: 1_200_000_000, ratingMicroB: 1_200_000_000, drawIndexA: 1, drawIndexB: 1 },
        bases
      )
    ).toBe(bases.wpair);
    expect(
      eloEdgeWeight(
        { priorEncounters: 0, ratingMicroA: 1_200_000_000, ratingMicroB: 1_200_000_200, drawIndexA: 1, drawIndexB: 4 },
        bases
      )
    ).toBe(200 * bases.wrating + 3);
  });

  it('refuses a context that cannot be paired', () => {
    expect(() =>
      swissWeightBases({ pairedSlots: 0, maxInitialSeed: 5, minInitialSeed: 1, roundOrdinal: 2 })
    ).toThrowError(PairingSolverError);
    expect(() => eloWeightBases({ pairedSlots: 0, maxRatingGap: 10, maxDrawIndexGap: 1 })).toThrowError(
      PairingSolverError
    );
  });
});
