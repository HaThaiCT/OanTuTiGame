import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry } from './types.js';

/**
 * Single elimination bracket, including the EMPTY slots the policy requires when fewer teams are
 * active than the bracket structure holds (02-GAMEPLAY §83/§122): a locked draw keeps its slots, one
 * active team against an EMPTY slot advances by walkover, two EMPTY slots produce no encounter at
 * all, and a slot whose encounter ended without a winner never falls back to a side.
 *
 * `slotCount` is the structural number of first-round pairings (bracket size / 2). It is persisted
 * on the round row so later rounds keep pairing the correct halves even when EMPTY slots mean a
 * round has fewer encounter rows than slots.
 */
export class EliminationFormat {
  /** First-round pairing slots for a bracket holding `teamCount` teams (at least one). */
  static slotCountFor(teamCount: number): number {
    let bracketSize = 1;
    while (bracketSize < Math.max(2, teamCount)) bracketSize *= 2;
    return bracketSize / 2;
  }

  /**
   * Generates round 1 pairings with the standard seeded bracket (1 vs N, 2 vs N-1, …).
   *
   * `slotCount` overrides the structural width — the playoff stage passes the slot count of the
   * policy cutoff so a shrunk field still occupies its original slots. Seeds beyond the field are
   * EMPTY: they become a bye for the seeded side, and a slot with no seed at all produces no
   * pairing.
   */
  generateRound1(
    teams: readonly TeamEntry[],
    stage: string = 'MAIN',
    slotCount?: number
  ): RoundSchedule {
    const n = teams.length;
    if (n < 2) {
      throw new Error(`Single Elimination requires at least 2 teams, got ${n}`);
    }

    const sorted = [...teams].sort((a, b) => a.seedOrdinal - b.seedOrdinal);
    const structuralSlots = Math.max(slotCount ?? EliminationFormat.slotCountFor(n), Math.ceil(n / 2));
    const bracketSize = structuralSlots * 2;

    const pairings: EncounterPairing[] = [];
    for (let slot = 1; slot <= structuralSlots; slot++) {
      const seedA = slot;
      const seedB = bracketSize - slot + 1;
      const teamA = seedA <= n ? sorted[seedA - 1] : undefined;
      const teamB = seedB <= n ? sorted[seedB - 1] : undefined;
      if (teamA === undefined && teamB === undefined) {
        // Two EMPTY slots: nothing to schedule, but the slot stays part of the structure.
        continue;
      }
      if (teamA === undefined) {
        // Only the bottom seed exists for this slot: it advances as a bye.
        pairings.push({
          slotOrdinal: slot,
          teamAId: (teamB as TeamEntry).teamId,
          teamBId: undefined,
          isBye: true,
        });
        continue;
      }
      pairings.push({
        slotOrdinal: slot,
        teamAId: teamA.teamId,
        teamBId: teamB?.teamId,
        isBye: teamB === undefined,
      });
    }

    return { roundOrdinal: 1, stage, pairings, slotCount: structuralSlots };
  }

  /**
   * Advances winners of `currentRoundOrdinal` into the next round.
   *
   * Pairing is structural: next slot `k` takes the winners of slots `2k-1` and `2k`, whatever order
   * the records arrive in and whether or not a row exists. A missing record or a record without a
   * winner is EMPTY, never a fabricated side. Returns `null` when the bracket is finished — either
   * the completed round was the final, or every remaining slot is EMPTY.
   */
  generateNextRound(
    completedEncounters: readonly CompletedEncounterRecord[],
    currentRoundOrdinal: number,
    stage: string = 'MAIN',
    previousSlotCount?: number
  ): RoundSchedule | null {
    const currentRound = completedEncounters.filter((encounter) => encounter.roundOrdinal === currentRoundOrdinal);
    // Without a persisted slot count (rows written before migration 018, or a direct caller) the
    // only structure available is the row count: a single row is the final, anything else pairs in
    // twos.
    const slotsThisRound =
      previousSlotCount !== undefined && previousSlotCount > 0
        ? previousSlotCount
        : currentRound.length <= 1
          ? 1
          : currentRound.length * 2;
    if (slotsThisRound <= 1) {
      // The completed round was the final: the bracket has produced its champion (or none).
      return null;
    }

    const bySlot = new Map<number, CompletedEncounterRecord>();
    for (const encounter of currentRound) {
      if (encounter.slotOrdinal !== undefined) bySlot.set(encounter.slotOrdinal, encounter);
    }
    if (bySlot.size === 0) {
      // Rows written before slot ordinals were persisted: keep the old array order working.
      currentRound.forEach((encounter, index) => bySlot.set(index + 1, encounter));
    }

    const nextSlots = Math.floor(slotsThisRound / 2);
    const pairings: EncounterPairing[] = [];
    for (let slot = 1; slot <= nextSlots; slot++) {
      const winnerA = bySlot.get(slot * 2 - 1)?.winnerTeamId;
      const winnerB = bySlot.get(slot * 2)?.winnerTeamId;
      if (winnerA === undefined && winnerB === undefined) {
        // Two EMPTY slots stay EMPTY: no encounter row is created for them.
        continue;
      }
      pairings.push({
        slotOrdinal: slot,
        teamAId: winnerA ?? (winnerB as string),
        teamBId: winnerA !== undefined && winnerB !== undefined ? winnerB : undefined,
        isBye: winnerA === undefined || winnerB === undefined,
      });
    }

    if (pairings.length === 0) {
      return null;
    }
    return { roundOrdinal: currentRoundOrdinal + 1, stage, pairings, slotCount: nextSlots };
  }
}
