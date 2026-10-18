/**
 * Pairing weight construction for `ArenaSwiss/v2` and `ArenaEloPair/v1` (02-GAMEPLAY §79/§102).
 *
 * The spec defines each round's objective as a *linear* combination with bases chosen so that
 * minimising the sum is equivalent to minimising the objective lexicographically:
 *
 *   Swiss: weight = rematchFlag·Wr + |pointsA − pointsB|·Wp + |seedA − seedB|
 *          Wp = Smax + 1, Wr = Pmax·Wp + Smax + 1
 *          Smax = m·(maxInitialSeed − minInitialSeed), Pmax = m·3·(roundOrdinal − 1), m = activeAfterBye/2
 *
 *   Elo:   lexicographic (prior counting encounters, |ratingA − ratingB| in micro-rating,
 *          |drawIndexA − drawIndexB|), encoded the same way with its own bases.
 *
 * These numbers feed the exact matcher, so they must be exact integers; the worst case (a 500-team
 * Swiss in its last round) stays far below 2^53 and is asserted in the tests rather than assumed.
 */
import { PairingSolverError } from './matching.js';

export interface SwissWeightContext {
  /** `m` from the spec: active entries after the bye, divided by two. */
  readonly pairedSlots: number;
  readonly maxInitialSeed: number;
  readonly minInitialSeed: number;
  readonly roundOrdinal: number;
}

export interface SwissWeightBases {
  readonly smax: number;
  readonly pmax: number;
  readonly wp: number;
  readonly wr: number;
}

/** Bases for one Swiss round, straight from §79. */
export function swissWeightBases(context: SwissWeightContext): SwissWeightBases {
  const { pairedSlots, maxInitialSeed, minInitialSeed, roundOrdinal } = context;
  if (pairedSlots < 1) throw new PairingSolverError(`Swiss pairing needs at least one pair, got m=${pairedSlots}`);
  const smax = pairedSlots * (maxInitialSeed - minInitialSeed);
  const pmax = pairedSlots * 3 * Math.max(0, roundOrdinal - 1);
  const wp = smax + 1;
  const wr = pmax * wp + smax + 1;
  return { smax, pmax, wp, wr };
}

export interface SwissEdgeInputs {
  readonly rematch: boolean;
  readonly pointsA: number;
  readonly pointsB: number;
  readonly seedA: number;
  readonly seedB: number;
}

/** Total weight of one Swiss pairing undirected edge. */
export function swissEdgeWeight(edge: SwissEdgeInputs, bases: SwissWeightBases): number {
  const rematchTerm = edge.rematch ? bases.wr : 0;
  const pointGap = Math.abs(edge.pointsA - edge.pointsB) * bases.wp;
  const seedGap = Math.abs(edge.seedA - edge.seedB);
  return rematchTerm + pointGap + seedGap;
}

export interface EloWeightContext {
  readonly pairedSlots: number;
  /** Points compare with the highest rating any eligible entry can reach, in micro-rating units. */
  readonly maxRatingGap: number;
  readonly maxDrawIndexGap: number;
}

export interface EloWeightBases {
  readonly wpair: number;
  readonly wrating: number;
}

/**
 * Bases for `ArenaEloPair/v1`: the primary objective is the number of *prior counting* encounters
 * between the paired opponents, then the rating gap, then the draw-index gap.
 */
export function eloWeightBases(context: EloWeightContext): EloWeightBases {
  const { pairedSlots, maxRatingGap, maxDrawIndexGap } = context;
  if (pairedSlots < 1) throw new PairingSolverError(`Elo pairing needs at least one pair, got m=${pairedSlots}`);
  const wrating = Math.max(1, maxDrawIndexGap) + 1;
  const wpair = pairedSlots * Math.max(0, maxRatingGap) * wrating + maxDrawIndexGap + 1;
  return { wpair, wrating };
}

export interface EloEdgeInputs {
  readonly priorEncounters: number;
  readonly ratingMicroA: number;
  readonly ratingMicroB: number;
  readonly drawIndexA: number;
  readonly drawIndexB: number;
}

/** Total weight of one Elo pairing undirected edge. */
export function eloEdgeWeight(edge: EloEdgeInputs, bases: EloWeightBases): number {
  const priorTerm = edge.priorEncounters * bases.wpair;
  const ratingTerm = Math.abs(edge.ratingMicroA - edge.ratingMicroB) * bases.wrating;
  const drawTerm = Math.abs(edge.drawIndexA - edge.drawIndexB);
  return priorTerm + ratingTerm + drawTerm;
}

/** Guards the exact-integer promise before the weights reach the solver. */
export function assertPairingArithmeticSafe(totalWeight: number, label: string): void {
  if (!Number.isSafeInteger(totalWeight)) {
    throw new PairingSolverError(`${label} total weight ${totalWeight} exceeds exact integer range`);
  }
}
