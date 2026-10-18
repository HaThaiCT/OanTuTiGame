import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry } from './types.js';

export class EliminationFormat {
  /**
   * Generates round 1 pairings for single elimination bracket.
   */
  generateRound1(teams: readonly TeamEntry[], stage: string = 'MAIN'): RoundSchedule {
    const n = teams.length;
    if (n < 2) {
      throw new Error(`Single Elimination requires at least 2 teams, got ${n}`);
    }

    // Sort by seed ordinal ascending
    const sorted = [...teams].sort((a, b) => a.seedOrdinal - b.seedOrdinal);

    // Calculate next power of 2
    let bracketSize = 1;
    while (bracketSize < n) bracketSize *= 2;

    const pairings: EncounterPairing[] = [];
    const totalSlots = bracketSize / 2;

    // Seeded pairing: 1 vs bracketSize, 2 vs bracketSize - 1, etc.
    for (let slot = 1; slot <= totalSlots; slot++) {
      const seedA = slot;
      const seedB = bracketSize - slot + 1;

      const teamA = sorted[seedA - 1]; // seedA is 1-based
      const teamB = seedB <= n ? sorted[seedB - 1] : undefined;

      pairings.push({
        slotOrdinal: slot,
        teamAId: teamA.teamId,
        teamBId: teamB?.teamId,
        isBye: teamB === undefined,
      });
    }

    return {
      roundOrdinal: 1,
      stage,
      pairings,
    };
  }

  /**
   * Advances winners from completed round to next elimination round.
   */
  generateNextRound(
    completedEncounters: readonly CompletedEncounterRecord[],
    currentRoundOrdinal: number,
    stage: string = 'MAIN'
  ): RoundSchedule | null {
    // Sort completed encounters by slot ordinal
    const sorted = [...completedEncounters].sort((a, b) => a.roundOrdinal - b.roundOrdinal);
    const roundEncounters = sorted.filter((e) => e.roundOrdinal === currentRoundOrdinal);

    if (roundEncounters.length <= 1) {
      // Final round completed! Champion is determined!
      return null;
    }

    const nextPairings: EncounterPairing[] = [];
    let nextSlot = 1;

    for (let i = 0; i < roundEncounters.length; i += 2) {
      const enc1 = roundEncounters[i];
      const enc2 = roundEncounters[i + 1];

      const winnerA = enc1.winnerTeamId ?? enc1.teamAId;
      const winnerB = enc2 ? enc2.winnerTeamId ?? enc2.teamAId : undefined;

      nextPairings.push({
        slotOrdinal: nextSlot++,
        teamAId: winnerA,
        teamBId: winnerB,
        isBye: winnerB === undefined,
      });
    }

    return {
      roundOrdinal: currentRoundOrdinal + 1,
      stage,
      pairings: nextPairings,
    };
  }
}
