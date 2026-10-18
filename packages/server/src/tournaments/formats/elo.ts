import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry, TeamStanding } from './types.js';

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
    playedPairs: ReadonlySet<string>,
    epoch: number
  ): RoundSchedule {
    const sorted = [...teams].sort((a, b) => {
      const rA = currentRatings.get(a.teamId) ?? this.INITIAL_RATING;
      const rB = currentRatings.get(b.teamId) ?? this.INITIAL_RATING;
      return rB - rA;
    });

    const unassigned = [...sorted];
    const pairings: EncounterPairing[] = [];

    // If odd number, worst rated team gets a bye
    if (unassigned.length % 2 !== 0) {
      const byeTeam = unassigned.pop()!;
      pairings.push({
        slotOrdinal: 1,
        teamAId: byeTeam.teamId,
        teamBId: undefined,
        isBye: true,
      });
    }

    while (unassigned.length >= 2) {
      const teamA = unassigned.shift()!;
      let bestIdx = 0;
      let minGap = Infinity;

      for (let i = 0; i < unassigned.length; i++) {
        const cand = unassigned[i];
        const isRematch = playedPairs.has(`${teamA.teamId}:${cand.teamId}`);
        const rA = currentRatings.get(teamA.teamId) ?? this.INITIAL_RATING;
        const rCand = currentRatings.get(cand.teamId) ?? this.INITIAL_RATING;
        const gap = Math.abs(rA - rCand) + (isRematch ? 1000 : 0);

        if (gap < minGap) {
          minGap = gap;
          bestIdx = i;
        }
      }

      const teamB = unassigned.splice(bestIdx, 1)[0];
      pairings.push({
        slotOrdinal: pairings.length + 1,
        teamAId: teamA.teamId,
        teamBId: teamB.teamId,
        isBye: false,
      });
    }

    return {
      roundOrdinal: epoch,
      stage: 'MAIN',
      pairings,
    };
  }
}
