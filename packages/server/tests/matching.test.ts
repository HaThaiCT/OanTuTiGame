import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAIRING_BUDGET_MS,
  PairingSolverError,
  assertSafeWeights,
  minimumWeightPerfectMatching,
  type MatchingEdge,
  type PerfectMatchingOptions,
} from '../src/tournaments/formats/matching.js';

/** Deterministic PRNG (mulberry32) so every randomised case is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function completeGraph(n: number, rng: () => number, maxWeight: number): MatchingEdge[] {
  const edges: MatchingEdge[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) edges.push({ a, b, weight: randInt(rng, maxWeight + 1) });
  }
  return edges;
}

const edgeKey = (n: number, a: number, b: number): number => (a < b ? a * n + b : b * n + a);

function weightLookup(
  n: number,
  edges: readonly MatchingEdge[],
): (a: number, b: number) => number | undefined {
  const byKey = new Map<number, number>();
  for (const edge of edges) byKey.set(edgeKey(n, edge.a, edge.b), edge.weight);
  return (a, b) => byKey.get(edgeKey(n, a, b));
}

function totalWeight(
  n: number,
  edges: readonly MatchingEdge[],
  pairs: readonly (readonly [number, number])[],
): number {
  const lookup = weightLookup(n, edges);
  let total = 0;
  for (const [a, b] of pairs) {
    const weight = lookup(a, b);
    if (weight === undefined) throw new Error(`returned pair (${a}, ${b}) is not an allowed edge`);
    total += weight;
  }
  return total;
}

function assertValidPerfectMatching(n: number, pairs: readonly (readonly [number, number])[]): void {
  const covered = new Set<number>();
  for (const [a, b] of pairs) {
    expect(a).toBeLessThan(b);
    expect(covered.has(a)).toBe(false);
    expect(covered.has(b)).toBe(false);
    covered.add(a);
    covered.add(b);
  }
  expect(covered.size).toBe(n);
  expect(pairs.length).toBe(n / 2);
}

/** Exhaustive oracle: minimum total weight over every perfect matching (null if none). */
function bruteForceMinimumWeight(n: number, edges: readonly MatchingEdge[]): number | null {
  const lookup = weightLookup(n, edges);
  const remaining: number[] = [];
  for (let v = 0; v < n; v++) remaining.push(v);
  let best = Infinity;
  const walk = (left: number[], total: number): void => {
    if (total >= best) return;
    if (left.length === 0) {
      best = total;
      return;
    }
    const first = left[0];
    for (let k = 1; k < left.length; k++) {
      const second = left[k];
      const weight = lookup(first, second);
      if (weight === undefined) continue;
      walk(left.slice(1, k).concat(left.slice(k + 1)), total + weight);
    }
  };
  walk(remaining, 0);
  return Number.isFinite(best) ? best : null;
}

/** Number of perfect matchings of the graph (used to sanity-check the oracle itself). */
function countPerfectMatchings(n: number, edges: readonly MatchingEdge[]): number {
  const lookup = weightLookup(n, edges);
  const remaining: number[] = [];
  for (let v = 0; v < n; v++) remaining.push(v);
  let count = 0;
  const walk = (left: number[]): void => {
    if (left.length === 0) {
      count += 1;
      return;
    }
    const first = left[0];
    for (let k = 1; k < left.length; k++) {
      const second = left[k];
      if (lookup(first, second) === undefined) continue;
      walk(left.slice(1, k).concat(left.slice(k + 1)));
    }
  };
  walk(remaining);
  return count;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function expectBlockedPairing(fn: () => unknown): PairingSolverError {
  const error = catchError(fn);
  expect(error).toBeInstanceOf(PairingSolverError);
  const pairingError = error as PairingSolverError;
  expect(pairingError.code).toBe('BLOCKED_PAIRING');
  return pairingError;
}

interface GoldenCase {
  readonly name: string;
  readonly vertexCount: number;
  readonly edges: readonly MatchingEdge[];
  readonly optimumWeight: number;
  readonly optimumPairs?: readonly (readonly [number, number])[];
}

// Golden vectors computed offline with networkx 3.7 `nx.min_weight_matching`
// (throwaway script, deliberately not part of the repository). Every entry
// carries the optimum weight; entries whose optimum is unique also carry the
// unique optimal pairing, which pins down the exact solution and not just its
// value.
const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: 'golden networkx case 0 (n=4)',
    vertexCount: 4,
    edges: [{ a: 0, b: 1, weight: 137 }, { a: 0, b: 2, weight: 582 }, { a: 0, b: 3, weight: 867 }, { a: 1, b: 2, weight: 821 }, { a: 1, b: 3, weight: 782 }, { a: 2, b: 3, weight: 64 }],
    optimumWeight: 201,
  },
  {
    name: 'golden networkx case 1 (n=4)',
    vertexCount: 4,
    edges: [{ a: 0, b: 1, weight: 978 }, { a: 0, b: 2, weight: 883 }, { a: 0, b: 3, weight: 970 }, { a: 1, b: 2, weight: 869 }, { a: 1, b: 3, weight: 57 }, { a: 2, b: 3, weight: 93 }],
    optimumWeight: 940,
  },
  {
    name: 'golden networkx case 2 (n=6)',
    vertexCount: 6,
    edges: [{ a: 0, b: 1, weight: 243 }, { a: 0, b: 2, weight: 606 }, { a: 0, b: 3, weight: 557 }, { a: 0, b: 4, weight: 133 }, { a: 0, b: 5, weight: 378 }, { a: 1, b: 2, weight: 937 }, { a: 1, b: 3, weight: 618 }, { a: 1, b: 4, weight: 485 }, { a: 1, b: 5, weight: 640 }, { a: 2, b: 3, weight: 594 }, { a: 2, b: 4, weight: 67 }, { a: 2, b: 5, weight: 620 }, { a: 3, b: 4, weight: 13 }, { a: 3, b: 5, weight: 930 }, { a: 4, b: 5, weight: 857 }],
    optimumWeight: 876,
  },
  {
    name: 'golden networkx case 3 (n=6)',
    vertexCount: 6,
    edges: [{ a: 0, b: 1, weight: 241 }, { a: 0, b: 2, weight: 310 }, { a: 0, b: 3, weight: 105 }, { a: 0, b: 4, weight: 738 }, { a: 0, b: 5, weight: 405 }, { a: 1, b: 2, weight: 490 }, { a: 1, b: 3, weight: 158 }, { a: 1, b: 4, weight: 92 }, { a: 1, b: 5, weight: 68 }, { a: 2, b: 3, weight: 20 }, { a: 2, b: 4, weight: 411 }, { a: 2, b: 5, weight: 562 }, { a: 3, b: 4, weight: 939 }, { a: 3, b: 5, weight: 296 }, { a: 4, b: 5, weight: 819 }],
    optimumWeight: 517,
  },
  {
    name: 'golden networkx case 4 (n=6)',
    vertexCount: 6,
    edges: [{ a: 0, b: 1, weight: 637 }, { a: 0, b: 2, weight: 261 }, { a: 0, b: 3, weight: 759 }, { a: 0, b: 4, weight: 367 }, { a: 0, b: 5, weight: 814 }, { a: 1, b: 2, weight: 707 }, { a: 1, b: 3, weight: 965 }, { a: 1, b: 4, weight: 861 }, { a: 1, b: 5, weight: 757 }, { a: 2, b: 3, weight: 667 }, { a: 2, b: 4, weight: 944 }, { a: 2, b: 5, weight: 542 }, { a: 3, b: 4, weight: 29 }, { a: 3, b: 5, weight: 860 }, { a: 4, b: 5, weight: 476 }],
    optimumWeight: 1047,
  },
  {
    name: 'golden networkx case 5 (n=8)',
    vertexCount: 8,
    edges: [{ a: 0, b: 1, weight: 812 }, { a: 0, b: 2, weight: 587 }, { a: 0, b: 3, weight: 841 }, { a: 0, b: 4, weight: 82 }, { a: 0, b: 5, weight: 496 }, { a: 0, b: 6, weight: 780 }, { a: 0, b: 7, weight: 267 }, { a: 1, b: 2, weight: 37 }, { a: 1, b: 3, weight: 0 }, { a: 1, b: 4, weight: 149 }, { a: 1, b: 5, weight: 678 }, { a: 1, b: 6, weight: 600 }, { a: 1, b: 7, weight: 481 }, { a: 2, b: 3, weight: 988 }, { a: 2, b: 4, weight: 777 }, { a: 2, b: 5, weight: 752 }, { a: 2, b: 6, weight: 382 }, { a: 2, b: 7, weight: 327 }, { a: 3, b: 4, weight: 788 }, { a: 3, b: 5, weight: 22 }, { a: 3, b: 6, weight: 279 }, { a: 3, b: 7, weight: 500 }, { a: 4, b: 5, weight: 821 }, { a: 4, b: 6, weight: 202 }, { a: 4, b: 7, weight: 747 }, { a: 5, b: 6, weight: 893 }, { a: 5, b: 7, weight: 423 }, { a: 6, b: 7, weight: 932 }],
    optimumWeight: 528,
  },
  {
    name: 'golden networkx case 6 (n=8)',
    vertexCount: 8,
    edges: [{ a: 0, b: 1, weight: 331 }, { a: 0, b: 2, weight: 970 }, { a: 0, b: 3, weight: 154 }, { a: 0, b: 4, weight: 404 }, { a: 0, b: 5, weight: 666 }, { a: 0, b: 6, weight: 49 }, { a: 0, b: 7, weight: 74 }, { a: 1, b: 2, weight: 840 }, { a: 1, b: 3, weight: 548 }, { a: 1, b: 4, weight: 96 }, { a: 1, b: 5, weight: 374 }, { a: 1, b: 6, weight: 596 }, { a: 1, b: 7, weight: 59 }, { a: 2, b: 3, weight: 931 }, { a: 2, b: 4, weight: 519 }, { a: 2, b: 5, weight: 219 }, { a: 2, b: 6, weight: 38 }, { a: 2, b: 7, weight: 88 }, { a: 3, b: 4, weight: 444 }, { a: 3, b: 5, weight: 428 }, { a: 3, b: 6, weight: 71 }, { a: 3, b: 7, weight: 246 }, { a: 4, b: 5, weight: 92 }, { a: 4, b: 6, weight: 564 }, { a: 4, b: 7, weight: 434 }, { a: 5, b: 6, weight: 60 }, { a: 5, b: 7, weight: 846 }, { a: 6, b: 7, weight: 579 }],
    optimumWeight: 343,
  },
  {
    name: 'golden networkx case 7 (n=8)',
    vertexCount: 8,
    edges: [{ a: 0, b: 1, weight: 232 }, { a: 0, b: 2, weight: 379 }, { a: 0, b: 3, weight: 985 }, { a: 0, b: 4, weight: 384 }, { a: 0, b: 5, weight: 129 }, { a: 0, b: 6, weight: 197 }, { a: 0, b: 7, weight: 721 }, { a: 1, b: 2, weight: 44 }, { a: 1, b: 3, weight: 87 }, { a: 1, b: 4, weight: 140 }, { a: 1, b: 5, weight: 253 }, { a: 1, b: 6, weight: 830 }, { a: 1, b: 7, weight: 518 }, { a: 2, b: 3, weight: 214 }, { a: 2, b: 4, weight: 410 }, { a: 2, b: 5, weight: 657 }, { a: 2, b: 6, weight: 31 }, { a: 2, b: 7, weight: 470 }, { a: 3, b: 4, weight: 499 }, { a: 3, b: 5, weight: 464 }, { a: 3, b: 6, weight: 399 }, { a: 3, b: 7, weight: 506 }, { a: 4, b: 5, weight: 586 }, { a: 4, b: 6, weight: 196 }, { a: 4, b: 7, weight: 918 }, { a: 5, b: 6, weight: 850 }, { a: 5, b: 7, weight: 412 }, { a: 6, b: 7, weight: 91 }],
    optimumWeight: 574,
  },
  {
    name: 'golden networkx case 8 (n=10)',
    vertexCount: 10,
    edges: [{ a: 0, b: 1, weight: 474 }, { a: 0, b: 2, weight: 627 }, { a: 0, b: 3, weight: 382 }, { a: 0, b: 4, weight: 273 }, { a: 0, b: 5, weight: 141 }, { a: 0, b: 6, weight: 190 }, { a: 0, b: 7, weight: 887 }, { a: 0, b: 8, weight: 692 }, { a: 0, b: 9, weight: 6 }, { a: 1, b: 2, weight: 346 }, { a: 1, b: 3, weight: 514 }, { a: 1, b: 4, weight: 474 }, { a: 1, b: 5, weight: 919 }, { a: 1, b: 6, weight: 619 }, { a: 1, b: 7, weight: 82 }, { a: 1, b: 8, weight: 342 }, { a: 1, b: 9, weight: 567 }, { a: 2, b: 3, weight: 958 }, { a: 2, b: 4, weight: 631 }, { a: 2, b: 5, weight: 716 }, { a: 2, b: 6, weight: 41 }, { a: 2, b: 7, weight: 745 }, { a: 2, b: 8, weight: 388 }, { a: 2, b: 9, weight: 173 }, { a: 3, b: 4, weight: 720 }, { a: 3, b: 5, weight: 968 }, { a: 3, b: 6, weight: 462 }, { a: 3, b: 7, weight: 974 }, { a: 3, b: 8, weight: 742 }, { a: 3, b: 9, weight: 432 }, { a: 4, b: 5, weight: 160 }, { a: 4, b: 6, weight: 172 }, { a: 4, b: 7, weight: 243 }, { a: 4, b: 8, weight: 52 }, { a: 4, b: 9, weight: 113 }, { a: 5, b: 6, weight: 135 }, { a: 5, b: 7, weight: 518 }, { a: 5, b: 8, weight: 892 }, { a: 5, b: 9, weight: 946 }, { a: 6, b: 7, weight: 604 }, { a: 6, b: 8, weight: 64 }, { a: 6, b: 9, weight: 792 }, { a: 7, b: 8, weight: 704 }, { a: 7, b: 9, weight: 392 }, { a: 8, b: 9, weight: 808 }],
    optimumWeight: 748,
  },
  {
    name: 'golden networkx case 9 (n=12)',
    vertexCount: 12,
    edges: [{ a: 0, b: 1, weight: 585 }, { a: 0, b: 2, weight: 33 }, { a: 0, b: 3, weight: 439 }, { a: 0, b: 4, weight: 494 }, { a: 0, b: 5, weight: 591 }, { a: 0, b: 6, weight: 15 }, { a: 0, b: 7, weight: 211 }, { a: 0, b: 8, weight: 473 }, { a: 0, b: 9, weight: 832 }, { a: 0, b: 10, weight: 503 }, { a: 0, b: 11, weight: 843 }, { a: 1, b: 2, weight: 284 }, { a: 1, b: 3, weight: 669 }, { a: 1, b: 4, weight: 830 }, { a: 1, b: 5, weight: 164 }, { a: 1, b: 6, weight: 35 }, { a: 1, b: 7, weight: 533 }, { a: 1, b: 8, weight: 501 }, { a: 1, b: 9, weight: 335 }, { a: 1, b: 10, weight: 77 }, { a: 1, b: 11, weight: 255 }, { a: 2, b: 3, weight: 975 }, { a: 2, b: 4, weight: 975 }, { a: 2, b: 5, weight: 763 }, { a: 2, b: 6, weight: 369 }, { a: 2, b: 7, weight: 45 }, { a: 2, b: 8, weight: 430 }, { a: 2, b: 9, weight: 880 }, { a: 2, b: 10, weight: 142 }, { a: 2, b: 11, weight: 617 }, { a: 3, b: 4, weight: 363 }, { a: 3, b: 5, weight: 390 }, { a: 3, b: 6, weight: 431 }, { a: 3, b: 7, weight: 290 }, { a: 3, b: 8, weight: 846 }, { a: 3, b: 9, weight: 691 }, { a: 3, b: 10, weight: 268 }, { a: 3, b: 11, weight: 467 }, { a: 4, b: 5, weight: 178 }, { a: 4, b: 6, weight: 702 }, { a: 4, b: 7, weight: 310 }, { a: 4, b: 8, weight: 677 }, { a: 4, b: 9, weight: 371 }, { a: 4, b: 10, weight: 136 }, { a: 4, b: 11, weight: 467 }, { a: 5, b: 6, weight: 786 }, { a: 5, b: 7, weight: 880 }, { a: 5, b: 8, weight: 245 }, { a: 5, b: 9, weight: 992 }, { a: 5, b: 10, weight: 450 }, { a: 5, b: 11, weight: 628 }, { a: 6, b: 7, weight: 384 }, { a: 6, b: 8, weight: 45 }, { a: 6, b: 9, weight: 596 }, { a: 6, b: 10, weight: 4 }, { a: 6, b: 11, weight: 241 }, { a: 7, b: 8, weight: 137 }, { a: 7, b: 9, weight: 199 }, { a: 7, b: 10, weight: 963 }, { a: 7, b: 11, weight: 931 }, { a: 8, b: 9, weight: 310 }, { a: 8, b: 10, weight: 549 }, { a: 8, b: 11, weight: 374 }, { a: 9, b: 10, weight: 790 }, { a: 9, b: 11, weight: 919 }, { a: 10, b: 11, weight: 245 }],
    optimumWeight: 978,
  },
  {
    name: 'crafted: two odd holes with cross edges (unique optimum)',
    vertexCount: 6,
    edges: [{ a: 0, b: 1, weight: 1 }, { a: 1, b: 2, weight: 2 }, { a: 0, b: 2, weight: 3 }, { a: 3, b: 4, weight: 4 }, { a: 4, b: 5, weight: 5 }, { a: 3, b: 5, weight: 6 }, { a: 0, b: 3, weight: 1000 }, { a: 1, b: 4, weight: 2000 }, { a: 2, b: 5, weight: 3000 }],
    optimumWeight: 1007,
    optimumPairs: [[0, 3], [1, 2], [4, 5]], // unique optimum
  },
  {
    name: 'crafted: 5-cycle odd hole plus pendant vertex',
    vertexCount: 6,
    edges: [{ a: 0, b: 1, weight: 3 }, { a: 1, b: 2, weight: 4 }, { a: 2, b: 3, weight: 5 }, { a: 3, b: 4, weight: 6 }, { a: 0, b: 4, weight: 7 }, { a: 0, b: 5, weight: 1 }],
    optimumWeight: 11,
    optimumPairs: [[0, 5], [1, 2], [3, 4]], // unique optimum
  },
  {
    name: 'crafted: sparse random graph 0 (unique optimum)',
    vertexCount: 8,
    edges: [{ a: 2, b: 5, weight: 10 }, { a: 5, b: 6, weight: 73 }, { a: 0, b: 1, weight: 38 }, { a: 2, b: 4, weight: 67 }, { a: 2, b: 6, weight: 63 }, { a: 2, b: 3, weight: 112 }, { a: 0, b: 5, weight: 43 }, { a: 1, b: 7, weight: 93 }, { a: 4, b: 7, weight: 57 }],
    optimumWeight: 280,
    optimumPairs: [[0, 1], [2, 3], [4, 7], [5, 6]], // unique optimum
  },
  {
    name: 'crafted: sparse random graph 1 (unique optimum)',
    vertexCount: 8,
    edges: [{ a: 0, b: 4, weight: 51 }, { a: 3, b: 6, weight: 50 }, { a: 0, b: 2, weight: 13 }, { a: 2, b: 4, weight: 61 }, { a: 1, b: 7, weight: 81 }, { a: 4, b: 6, weight: 51 }, { a: 1, b: 6, weight: 7 }, { a: 2, b: 3, weight: 24 }, { a: 1, b: 5, weight: 8 }, { a: 3, b: 4, weight: 26 }, { a: 2, b: 7, weight: 56 }],
    optimumWeight: 165,
    optimumPairs: [[0, 4], [1, 5], [2, 7], [3, 6]], // unique optimum
  },
  {
    name: 'crafted: sparse random graph 2 (unique optimum)',
    vertexCount: 6,
    edges: [{ a: 0, b: 4, weight: 26 }, { a: 1, b: 3, weight: 67 }, { a: 1, b: 5, weight: 46 }, { a: 2, b: 3, weight: 18 }, { a: 2, b: 4, weight: 88 }, { a: 1, b: 2, weight: 69 }],
    optimumWeight: 90,
    optimumPairs: [[0, 4], [1, 5], [2, 3]], // unique optimum
  },
  {
    name: 'crafted: sparse random graph 3 (unique optimum)',
    vertexCount: 6,
    edges: [{ a: 2, b: 3, weight: 103 }, { a: 0, b: 1, weight: 30 }, { a: 0, b: 4, weight: 104 }, { a: 1, b: 4, weight: 51 }, { a: 1, b: 3, weight: 94 }, { a: 0, b: 3, weight: 102 }, { a: 2, b: 5, weight: 29 }],
    optimumWeight: 182,
    optimumPairs: [[0, 3], [1, 4], [2, 5]], // unique optimum
  },
];

describe('minimumWeightPerfectMatching: brute-force oracle', () => {
  for (const n of [2, 4, 6, 8]) {
    it(`matches the exhaustive optimum for 50 seeded complete graphs with n=${n}`, () => {
      for (let caseIndex = 0; caseIndex < 50; caseIndex++) {
        const rng = makeRng(0x5eed + n * 1000 + caseIndex);
        const edges = completeGraph(n, rng, 10_000);
        const optimum = bruteForceMinimumWeight(n, edges);
        expect(optimum).not.toBeNull();

        const pairs = minimumWeightPerfectMatching(n, edges);
        assertValidPerfectMatching(n, pairs);
        expect(totalWeight(n, edges, pairs)).toBe(optimum);
      }
    });
  }

  it('enumerates the expected 105 perfect matchings of a complete 8-vertex graph', () => {
    expect(countPerfectMatchings(8, completeGraph(8, makeRng(0x0badf00d), 10))).toBe(105);
  });

  it('matches the oracle on 60 seeded sparse graphs (including blocked ones)', () => {
    const n = 6;
    let blocked = 0;
    for (let caseIndex = 0; caseIndex < 60; caseIndex++) {
      const rng = makeRng(0xabcdef + caseIndex);
      const edges: MatchingEdge[] = [];
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          if (rng() < 0.6) edges.push({ a, b, weight: randInt(rng, 500) });
        }
      }
      const optimum = bruteForceMinimumWeight(n, edges);
      if (optimum === null) {
        blocked += 1;
        expectBlockedPairing(() => minimumWeightPerfectMatching(n, edges));
        continue;
      }
      const pairs = minimumWeightPerfectMatching(n, edges);
      assertValidPerfectMatching(n, pairs);
      expect(totalWeight(n, edges, pairs)).toBe(optimum);
    }
    // Make sure the sparse sweep really did exercise the blocked branch.
    expect(blocked).toBeGreaterThan(0);
  });
});

describe('minimumWeightPerfectMatching: golden vectors from networkx', () => {
  for (const golden of GOLDEN_CASES) {
    it(`reproduces the networkx optimum for ${golden.name}`, () => {
      const pairs = minimumWeightPerfectMatching(golden.vertexCount, golden.edges);
      assertValidPerfectMatching(golden.vertexCount, pairs);
      expect(totalWeight(golden.vertexCount, golden.edges, pairs)).toBe(golden.optimumWeight);

      if (golden.optimumPairs !== undefined) {
        const normalize = (list: readonly (readonly [number, number])[]): number[][] =>
          list.map(([a, b]) => [a, b]).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        expect(normalize(pairs)).toEqual(normalize(golden.optimumPairs));
      }
    });
  }
});

describe('minimumWeightPerfectMatching: blocked pairings', () => {
  it('throws BLOCKED_PAIRING when a vertex is isolated', () => {
    expectBlockedPairing(() => minimumWeightPerfectMatching(4, [{ a: 0, b: 1, weight: 1 }]));
  });

  it('throws BLOCKED_PAIRING for a path that cannot be covered perfectly', () => {
    expectBlockedPairing(() =>
      minimumWeightPerfectMatching(4, [
        { a: 0, b: 1, weight: 3 },
        { a: 1, b: 2, weight: 4 },
      ]),
    );
  });

  it('throws BLOCKED_PAIRING for a single odd component', () => {
    expectBlockedPairing(() =>
      minimumWeightPerfectMatching(6, [
        { a: 0, b: 1, weight: 1 },
        { a: 1, b: 2, weight: 1 },
        { a: 0, b: 2, weight: 1 },
      ]),
    );
  });

  it('throws BLOCKED_PAIRING for an odd number of vertices, even when complete', () => {
    const edges: MatchingEdge[] = [];
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 5; b++) edges.push({ a, b, weight: (a + b) % 3 });
    }
    expectBlockedPairing(() => minimumWeightPerfectMatching(5, edges));
  });

  it('throws BLOCKED_PAIRING when there are no edges at all', () => {
    expectBlockedPairing(() => minimumWeightPerfectMatching(2, []));
  });

  it('returns no pairs for an empty field', () => {
    expect(minimumWeightPerfectMatching(0, [])).toEqual([]);
  });
});

describe('minimumWeightPerfectMatching: budget', () => {
  it('exposes the 10s default budget', () => {
    expect(DEFAULT_PAIRING_BUDGET_MS).toBe(10_000);
  });

  it('throws BLOCKED_PAIRING when the budget is exhausted inside the search', () => {
    const n = 64;
    const edges = completeGraph(n, makeRng(0xb0d9e7), 10_000);
    let clockCalls = 0;
    // The first call fixes the deadline; every later call (which only happens
    // inside the search loop) is far past it.
    const now = (): number => {
      clockCalls += 1;
      return clockCalls === 1 ? 0 : 1_000_000;
    };
    const error = expectBlockedPairing(() =>
      minimumWeightPerfectMatching(n, edges, { budgetMs: 10, now }),
    );
    expect(error.message).toContain('budget');
    expect(clockCalls).toBeGreaterThan(1);
  });

  it('completes when a supplied clock never advances past the deadline', () => {
    const options: PerfectMatchingOptions = { budgetMs: 10, now: () => 0 };
    const edges = completeGraph(4, makeRng(0x1234), 100);
    const pairs = minimumWeightPerfectMatching(4, edges, options);
    assertValidPerfectMatching(4, pairs);
    expect(totalWeight(4, edges, pairs)).toBe(bruteForceMinimumWeight(4, edges));
  });
});

describe('minimumWeightPerfectMatching: larger fields', () => {
  it('returns a valid perfect matching for a random complete 64-vertex graph', () => {
    const n = 64;
    const edges = completeGraph(n, makeRng(0x2024), 10_000);
    const pairs = minimumWeightPerfectMatching(n, edges);

    assertValidPerfectMatching(n, pairs);
    expect(pairs.length).toBe(32);

    const lookup = weightLookup(n, edges);
    let sum = 0;
    for (const [a, b] of pairs) sum += lookup(a, b) as number;
    expect(totalWeight(n, edges, pairs)).toBe(sum);
  });
});

describe('assertSafeWeights', () => {
  it('accepts non-negative safe integers', () => {
    expect(() => assertSafeWeights([0, 1, 2, Number.MAX_SAFE_INTEGER])).not.toThrow();
  });

  it('rejects negative, fractional and non-finite weights with BLOCKED_PAIRING', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = catchError(() => assertSafeWeights([bad]));
      expect(error).toBeInstanceOf(PairingSolverError);
      expect((error as PairingSolverError).code).toBe('BLOCKED_PAIRING');
    }
  });

  it('surfaces unsafe weights through the solver as BLOCKED_PAIRING', () => {
    expectBlockedPairing(() => minimumWeightPerfectMatching(2, [{ a: 0, b: 1, weight: -5 }]));
  });
});
