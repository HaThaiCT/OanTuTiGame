import { describe, it, expect } from 'vitest';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { swissEdgeWeight, swissWeightBases } from '../src/tournaments/formats/pairing-weights.js';
import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry } from '../src/tournaments/formats/types.js';

/**
 * `ArenaSwiss/v2` (02-GAMEPLAY §79) needs the exact minimum-weight perfect matching. Both the shipped
 * greedy matcher and any future "close enough" shortcut are rejected here: the first case is a real
 * round-1 field where greedy cost 99 and the optimum is 97, and the second compares whole fields
 * against a brute-force oracle.
 */
const teams = (count: number): TeamEntry[] =>
  Array.from({ length: count }, (_, index) => ({ teamId: `t${index + 1}`, seedOrdinal: index + 1 }));

const id = (index: number): string => `t${index + 1}`;

function encounter(
  roundOrdinal: number,
  slotOrdinal: number,
  teamAIndex: number,
  teamBIndex: number,
  winnerIndex: number | null,
  pointsA: number,
  pointsB: number
): CompletedEncounterRecord {
  return {
    encounterId: `e-${roundOrdinal}-${slotOrdinal}`,
    roundOrdinal,
    slotOrdinal,
    status: 'COMPLETED',
    teamAId: id(teamAIndex),
    teamBId: id(teamBIndex),
    winnerTeamId: winnerIndex === null ? undefined : id(winnerIndex),
    pointsA,
    pointsB,
  };
}

/** Total weight of a produced schedule under the pinned Swiss bases. */
function scheduleWeight(
  schedule: RoundSchedule,
  points: ReadonlyMap<string, number>,
  seedOf: ReadonlyMap<string, number>,
  played: ReadonlySet<string>,
  roundOrdinal: number
): number {
  const bases = swissWeightBases({
    pairedSlots: schedule.pairings.length,
    maxInitialSeed: Math.max(...[...seedOf.values()]),
    minInitialSeed: Math.min(...[...seedOf.values()]),
    roundOrdinal,
  });
  return schedule.pairings.reduce(
    (sum, pairing) =>
      sum +
      swissEdgeWeight(
        {
          rematch: played.has(`${pairing.teamAId}:${pairing.teamBId}`),
          pointsA: points.get(pairing.teamAId) ?? 0,
          pointsB: points.get(pairing.teamBId ?? '') ?? 0,
          seedA: seedOf.get(pairing.teamAId) ?? 0,
          seedB: seedOf.get(pairing.teamBId ?? '') ?? 0,
        },
        bases
      ),
    0
  );
}

/** Exhaustive best perfect matching, as an independent oracle for small fields. */
function bruteForceOptimum(
  entries: readonly TeamEntry[],
  points: ReadonlyMap<string, number>,
  played: ReadonlySet<string>,
  roundOrdinal: number
): number {
  const bases = swissWeightBases({
    pairedSlots: entries.length / 2,
    maxInitialSeed: Math.max(...entries.map((entry) => entry.seedOrdinal)),
    minInitialSeed: Math.min(...entries.map((entry) => entry.seedOrdinal)),
    roundOrdinal,
  });
  const weightOf = (a: TeamEntry, b: TeamEntry): number =>
    swissEdgeWeight(
      {
        rematch: played.has(`${a.teamId}:${b.teamId}`),
        pointsA: points.get(a.teamId) ?? 0,
        pointsB: points.get(b.teamId) ?? 0,
        seedA: a.seedOrdinal,
        seedB: b.seedOrdinal,
      },
      bases
    );

  const best = (remaining: readonly TeamEntry[]): number => {
    if (remaining.length === 0) return 0;
    const [first, ...rest] = remaining;
    let bestTotal = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rest.length; index += 1) {
      const partner = rest[index];
      const next = rest.filter((_, otherIndex) => otherIndex !== index);
      bestTotal = Math.min(bestTotal, weightOf(first, partner) + best(next));
    }
    return bestTotal;
  };

  return best(entries);
}

describe('S09: Swiss pairing is exact, not greedy', () => {
  it('finds the optimum where the shipped greedy matcher cost two more weight units', () => {
    // Round 1: t2 beat t1, t3 beat t6, t4 beat t5, t7 drew t8 — the field that exposed greedy.
    const completed = [
      encounter(1, 1, 0, 1, 1, 0, 3),
      encounter(1, 2, 2, 5, 2, 3, 0),
      encounter(1, 3, 3, 4, 3, 3, 0),
      encounter(1, 4, 6, 7, null, 1, 1),
    ];
    const schedule = new SwissFormat().generateNextRound(teams(8), completed, 1);

    const points = new Map([
      [id(0), 0],
      [id(1), 3],
      [id(2), 3],
      [id(3), 3],
      [id(4), 0],
      [id(5), 0],
      [id(6), 1],
      [id(7), 1],
    ]);
    const seedOf = new Map(Array.from({ length: 8 }, (_, index) => [id(index), index + 1]));
    const played = new Set([
      `${id(0)}:${id(1)}`,
      `${id(1)}:${id(0)}`,
      `${id(2)}:${id(5)}`,
      `${id(5)}:${id(2)}`,
      `${id(3)}:${id(4)}`,
      `${id(4)}:${id(3)}`,
      `${id(6)}:${id(7)}`,
      `${id(7)}:${id(6)}`,
    ]);

    const total = scheduleWeight(schedule, points, seedOf, played, 2);
    expect(total).toBe(97);
    // The greedy matcher produced 99 on this exact field: the exact optimum must beat it.
    expect(total).toBeLessThan(99);
    expect(scheduleWeight(schedule, points, seedOf, played, 2)).toBe(
      bruteForceOptimum(teams(8), points, played, 2)
    );

    const paired = schedule.pairings.flatMap((pairing) => [pairing.teamAId, pairing.teamBId]);
    expect(paired).toHaveLength(8);
    expect(new Set(paired).size).toBe(8);
  });

  it('is optimal across randomly generated fields (brute-force oracle)', () => {
    let seed = 20261018;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };

    for (let trial = 0; trial < 30; trial += 1) {
      const entries = teams(6);
      const completed: CompletedEncounterRecord[] = [];
      const points = new Map<string, number>();
      const played = new Set<string>();
      for (let slot = 0; slot < 3; slot += 1) {
        const a = slot * 2;
        const b = slot * 2 + 1;
        const roll = random();
        const pointsA = roll < 0.6 ? 3 : roll < 0.8 ? 1 : 0;
        const pointsB = pointsA === 1 ? 1 : pointsA === 3 ? 0 : 3;
        completed.push(encounter(1, slot + 1, a, b, pointsA === 3 ? a : pointsB === 3 ? b : null, pointsA, pointsB));
        points.set(id(a), pointsA);
        points.set(id(b), pointsB);
        played.add(`${id(a)}:${id(b)}`);
        played.add(`${id(b)}:${id(a)}`);
      }

      const schedule = new SwissFormat().generateNextRound(entries, completed, 1);
      const seedOf = new Map(entries.map((entry) => [entry.teamId, entry.seedOrdinal]));
      const produced = scheduleWeight(schedule, points, seedOf, played, 2);
      const optimum = bruteForceOptimum(entries, points, played, 2);
      expect(produced).toBe(optimum);
    }
  });
});
