import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry, TeamStanding } from './types.js';
import { minimumWeightPerfectMatching, type MatchingEdge, type PerfectMatchingOptions } from './matching.js';
import { assertPairingArithmeticSafe, eloEdgeWeight, eloWeightBases } from './pairing-weights.js';

export interface EloDeltaResult {
  readonly teamAId: string;
  readonly teamBId: string;
  readonly preRatingA: number;
  readonly preRatingB: number;
  readonly deltaA: number;
  readonly deltaB: number;
  readonly postRatingA: number;
  readonly postRatingB: number;
}

export class EloFormat {
  private readonly solverOptions: PerfectMatchingOptions;

  constructor(solverOptions: PerfectMatchingOptions = {}) {
    this.solverOptions = solverOptions;
  }

  readonly INITIAL_RATING = 1200.0;
  readonly K_FACTOR = 32.0;

  /**
   * Calculates total epochs E:
   * E = max(8, 4 * ceil(log2(N)))
   */
  calculateEpochs(n: number): number {
    if (n < 2) return 8;
    const log2Ceil = Math.ceil(Math.log2(n));
    return Math.max(8, 4 * log2Ceil);
  }

  /**
   * Calculates rating deltas for an encounter.
   */
  calculateDeltas(
    preRatingA: number,
    preRatingB: number,
    pointsA: number,
    pointsB: number
  ): { deltaA: number; deltaB: number; postRatingA: number; postRatingB: number } {
    const expectedA = 1.0 / (1.0 + Math.pow(10, (preRatingB - preRatingA) / 400.0));
    const expectedB = 1.0 - expectedA;

    let scoreA = 0.5;
    if (pointsA > pointsB) scoreA = 1.0;
    else if (pointsA < pointsB) scoreA = 0.0;
    const scoreB = 1.0 - scoreA;

    const deltaA = parseFloat((this.K_FACTOR * (scoreA - expectedA)).toFixed(2));
    const deltaB = parseFloat((this.K_FACTOR * (scoreB - expectedB)).toFixed(2));

    const postRatingA = parseFloat((preRatingA + deltaA).toFixed(2));
    const postRatingB = parseFloat((preRatingB + deltaB).toFixed(2));

    return { deltaA, deltaB, postRatingA, postRatingB };
  }

  /**
   * Generates epoch pairing minimizing rating gap and rematch count.
   */
  generateEpoch(
    teams: readonly TeamEntry[],
    currentRatings: ReadonlyMap<string, number>,
    priorEncounters: ReadonlyMap<string, number>,
    epoch: number,
    byeCounts: ReadonlyMap<string, number> = new Map()
  ): RoundSchedule {
    const sorted = [...teams].sort((a, b) => {
      const rA = currentRatings.get(a.teamId) ?? this.INITIAL_RATING;
      const rB = currentRatings.get(b.teamId) ?? this.INITIAL_RATING;
      return rB - rA;
    });

    const unassigned = [...sorted];
    const pairings: EncounterPairing[] = [];

    // Odd field: the bye goes to `(byeCount asc, drawIndex desc)` (02-GAMEPLAY §102), where the
    // draw index is the entry's seed ordinal — never to a team that already sat out when it can be
    // avoided, and the best draw index last.
    if (unassigned.length % 2 !== 0) {
      let byeIndex = 0;
      let bestKey: readonly [number, number] | null = null;
      for (let index = 0; index < unassigned.length; index += 1) {
        const team = unassigned[index];
        const key = [byeCounts.get(team.teamId) ?? 0, -team.seedOrdinal] as const;
        if (bestKey === null || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
          bestKey = key;
          byeIndex = index;
        }
      }
      const byeTeam = unassigned.splice(byeIndex, 1)[0];
      pairings.push({
        slotOrdinal: 1,
        teamAId: byeTeam.teamId,
        teamBId: undefined,
        isBye: true,
      });
    }

    // Exact lexicographic matching (02-GAMEPLAY §102): prior counting encounters → rating gap →
    // draw-index gap. Micro-rating integers keep the arithmetic exact; a solver failure raises
    // BLOCKED_PAIRING rather than degrading the pairing.
    if (unassigned.length >= 2) {
      const ids = unassigned.map((team) => team.teamId);
      const seedOf = new Map(teams.map((team) => [team.teamId, team.seedOrdinal]));
      const ratingMicro = (teamId: string): number =>
        Math.round((currentRatings.get(teamId) ?? this.INITIAL_RATING) * 1_000_000);

      const ratings = ids.map(ratingMicro);
      const maxRatingGap = ratings.length > 1 ? Math.max(...ratings) - Math.min(...ratings) : 0;
      const seedValues = teams.map((team) => team.seedOrdinal);
      const bases = eloWeightBases({
        pairedSlots: ids.length / 2,
        maxRatingGap,
        maxDrawIndexGap: Math.max(...seedValues) - Math.min(...seedValues),
      });

      const edges: MatchingEdge[] = [];
      const weightOf = new Map<string, number>();
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = ids[i];
          const b = ids[j];
          const weight = eloEdgeWeight(
            {
              priorEncounters: priorEncounters.get(`${a}:${b}`) ?? priorEncounters.get(`${b}:${a}`) ?? 0,
              ratingMicroA: ratingMicro(a),
              ratingMicroB: ratingMicro(b),
              drawIndexA: seedOf.get(a) ?? 0,
              drawIndexB: seedOf.get(b) ?? 0,
            },
            bases
          );
          edges.push({ a: i, b: j, weight });
          weightOf.set(`${i}:${j}`, weight);
        }
      }

      const matching = minimumWeightPerfectMatching(ids.length, edges, this.solverOptions);
      let totalWeight = 0;
      for (const [i, j] of matching) {
        totalWeight += weightOf.get(`${Math.min(i, j)}:${Math.max(i, j)}`) ?? 0;
        pairings.push({ slotOrdinal: pairings.length + 1, teamAId: ids[i], teamBId: ids[j], isBye: false });
      }
      assertPairingArithmeticSafe(totalWeight, 'ArenaEloPair/v1 epoch');
    }

    return {
      roundOrdinal: epoch,
      stage: 'MAIN',
      pairings,
    };
  }
}
