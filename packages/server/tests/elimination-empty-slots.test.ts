import { describe, it, expect } from 'vitest';
import { EliminationFormat } from '../src/tournaments/formats/elimination.js';
import type { CompletedEncounterRecord, TeamEntry } from '../src/tournaments/formats/types.js';

/**
 * EMPTY-slot semantics (02-GAMEPLAY §83/§122) for the knockout bracket: a locked draw keeps its
 * structural width, an EMPTY side is a walkover for the active team, two EMPTY slots produce no
 * encounter, and a slot whose encounter ended without a winner never advances anybody.
 */
describe('S09: knockout bracket with EMPTY slots', () => {
  const format = new EliminationFormat();
  const teams = (count: number): TeamEntry[] =>
    Array.from({ length: count }, (_, index) => ({ teamId: `team-${index + 1}`, seedOrdinal: index + 1 }));

  it('fills a fixed-width bracket with byes instead of shrinking it', () => {
    const schedule = format.generateRound1(teams(5), 'PLAYOFF', 4);
    expect(schedule.slotCount).toBe(4);
    expect(schedule.pairings).toHaveLength(4);
    // Seeds 1..5 of an 8-slot bracket: three byes and one real encounter (seeds 4 vs 5).
    expect(schedule.pairings.filter((pairing) => pairing.isBye).map((pairing) => pairing.teamAId)).toEqual([
      'team-1',
      'team-2',
      'team-3',
    ]);
    const real = schedule.pairings.find((pairing) => !pairing.isBye);
    expect(real).toMatchObject({ slotOrdinal: 4, teamAId: 'team-4', teamBId: 'team-5' });
  });

  it('creates no encounter for two EMPTY slots', () => {
    const schedule = format.generateRound1(teams(2), 'PLAYOFF', 4);
    expect(schedule.slotCount).toBe(4);
    // Seeds 1 and 2 occupy slots 1 and 2; slots 3 and 4 have no seed at all.
    expect(schedule.pairings.map((pairing) => pairing.slotOrdinal)).toEqual([1, 2]);
  });

  it('pairs by slot position, advancing the active side past an EMPTY slot', () => {
    const next = format.generateNextRound(
      [
        { encounterId: 'a', roundOrdinal: 1, slotOrdinal: 1, teamAId: 'team-1', winnerTeamId: 'team-1', pointsA: 3, pointsB: 0 },
        { encounterId: 'b', roundOrdinal: 1, slotOrdinal: 2, teamAId: 'team-2', winnerTeamId: 'team-2', pointsA: 3, pointsB: 0 },
        { encounterId: 'c', roundOrdinal: 1, slotOrdinal: 4, teamAId: 'team-4', teamBId: 'team-5', winnerTeamId: 'team-5', pointsA: 0, pointsB: 3 },
      ],
      1,
      'PLAYOFF',
      4
    );
    expect(next?.roundOrdinal).toBe(2);
    expect(next?.slotCount).toBe(2);
    expect(next?.pairings).toEqual([
      expect.objectContaining({ slotOrdinal: 1, teamAId: 'team-1', teamBId: 'team-2', isBye: false }),
      // Slot 3 had no encounter at all: the surviving side advances by walkover.
      expect.objectContaining({ slotOrdinal: 2, teamAId: 'team-5', teamBId: undefined, isBye: true }),
    ]);
  });

  it('never fabricates a winner for an unresolved encounter', () => {
    const next = format.generateNextRound(
      [
        // All games no-contest: this slot has no winner, so it becomes EMPTY and team-1 must not
        // appear downstream — the surviving side of the other slot advances by walkover instead.
        { encounterId: 'a', roundOrdinal: 1, slotOrdinal: 1, teamAId: 'team-1', teamBId: 'team-2', pointsA: 0, pointsB: 0 },
        { encounterId: 'b', roundOrdinal: 1, slotOrdinal: 2, teamAId: 'team-3', teamBId: 'team-4', winnerTeamId: 'team-4', pointsA: 0, pointsB: 3 },
      ],
      1,
      'PLAYOFF',
      4
    );
    expect(next?.pairings).toEqual([
      expect.objectContaining({ slotOrdinal: 1, teamAId: 'team-4', teamBId: undefined, isBye: true }),
    ]);
    expect(JSON.stringify(next)).not.toContain('team-1');
    // Two EMPTY slots (3 and 4) produce no encounter at all.
    expect(next?.slotCount).toBe(2);
  });

  it('returns null when both final slots are EMPTY', () => {
    const next = format.generateNextRound(
      [
        { encounterId: 'a', roundOrdinal: 2, slotOrdinal: 1, teamAId: 'team-1', pointsA: 0, pointsB: 0 },
        { encounterId: 'b', roundOrdinal: 2, slotOrdinal: 2, teamAId: 'team-2', pointsA: 0, pointsB: 0 },
      ],
      2,
      'PLAYOFF',
      2
    );
    expect(next).toBeNull();
  });

  it('keeps the legacy array-order pairing when slot ordinals are missing', () => {
    const next = format.generateNextRound(
      [
        { encounterId: 'a', roundOrdinal: 1, teamAId: 'team-1', teamBId: 'team-2', winnerTeamId: 'team-1', pointsA: 3, pointsB: 0 },
        { encounterId: 'b', roundOrdinal: 1, teamAId: 'team-3', teamBId: 'team-4', winnerTeamId: 'team-4', pointsA: 0, pointsB: 3 },
      ] as readonly CompletedEncounterRecord[],
      1,
      'MAIN'
    );
    expect(next?.pairings).toEqual([
      expect.objectContaining({ slotOrdinal: 1, teamAId: 'team-1', teamBId: 'team-4', isBye: false }),
    ]);
  });
});
