import { describe, it, expect } from 'vitest';
import { EliminationFormat } from '../src/tournaments/formats/elimination.js';
import { SwissFormat } from '../src/tournaments/formats/swiss.js';
import { RoundRobinFormat } from '../src/tournaments/formats/round-robin.js';
import { EloFormat } from '../src/tournaments/formats/elo.js';

/**
 * Field-size acceptance for the four formats (S09). The same policies have to hold at the smallest
 * legal field, at odd fields where a bye is unavoidable, and at 64 entrants — the numbers below come
 * from 02-GAMEPLAY §71/§83/§100 (designer-default), not from the implementation.
 */
const FIELD_SIZES = [2, 3, 4, 5, 10, 16, 64] as const;

/** Swiss rounds R and playoff cutoff T per the pinned policy. */
const EXPECTED_SWISS = {
  2: { rounds: 1, cutoff: 2 },
  3: { rounds: 2, cutoff: 2 },
  4: { rounds: 2, cutoff: 2 },
  5: { rounds: 3, cutoff: 2 },
  10: { rounds: 4, cutoff: 2 },
  16: { rounds: 4, cutoff: 4 },
  64: { rounds: 6, cutoff: 8 },
} as const;

/** Elo epochs E = max(8, 4·ceil(log2 N)). */
const EXPECTED_ELO_EPOCHS = { 2: 8, 3: 8, 4: 8, 5: 12, 10: 16, 16: 16, 64: 24 } as const;

const teams = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ teamId: `team-${index + 1}`, seedOrdinal: index + 1 }));

/**
 * Every team the schedule mentions, in slot order — a bye still names its team, so this is the whole
 * field whenever the round accounts for everyone.
 */
function participants(schedule: {
  readonly pairings: readonly { readonly teamAId: string; readonly teamBId?: string }[];
}): string[] {
  return schedule.pairings.flatMap((pairing) =>
    [pairing.teamAId, pairing.teamBId].filter((teamId): teamId is string => Boolean(teamId))
  );
}

/** Teams that actually play in this round (both sides of a non-bye pairing). */
function playing(schedule: {
  readonly pairings: readonly { readonly teamAId: string; readonly teamBId?: string }[];
}): string[] {
  return schedule.pairings
    .filter((pairing) => Boolean(pairing.teamBId))
    .flatMap((pairing) => [pairing.teamAId, pairing.teamBId as string]);
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

describe('S09: format policies at real field sizes', () => {
  describe('single elimination', () => {
    const format = new EliminationFormat();

    it('keeps the policy width when fewer teams qualify than the playoff cutoff', () => {
      // T=8 (16 entrants) means a playoff bracket of 4 pairing slots; only 3 teams qualified, because
      // the rest were withdrawn. The two EMPTY seeds at the top of a slot produce no encounter row at
      // all — the bracket keeps its width and never fabricates a matchup (02-GAMEPLAY §83).
      const policySlots = EliminationFormat.slotCountFor(8);
      expect(policySlots).toBe(4);

      const schedule = format.generateRound1(teams(3), 'PLAYOFF', policySlots);
      expect(schedule.slotCount).toBe(4);
      expect(schedule.pairings).toHaveLength(3);
      for (const pairing of schedule.pairings) {
        expect(pairing.isBye).toBe(true);
        expect(pairing.teamBId).toBeUndefined();
      }
      expect(participants(schedule)).toHaveLength(3);
    });

    for (const size of FIELD_SIZES) {
      it(`pads ${size} entrants into a fixed-width bracket filled with byes`, () => {
        const slotCount = EliminationFormat.slotCountFor(size);
        const schedule = format.generateRound1(teams(size), 'MAIN');

        expect(schedule.slotCount).toBe(slotCount);
        expect(schedule.pairings).toHaveLength(slotCount);
        // A bracket of `slotCount` pairings holds 2·slotCount seeds; the missing ones are byes.
        expect(schedule.pairings.filter((pairing) => pairing.isBye)).toHaveLength(slotCount * 2 - size);

        const seen = participants(schedule);
        expect(seen).toHaveLength(size);
        expect(new Set(seen).size).toBe(size);

        for (const pairing of schedule.pairings) {
          if (pairing.isBye) {
            expect(pairing.teamBId).toBeUndefined();
            continue;
          }
          expect(pairing.teamBId).toBeDefined();
          expect(pairing.teamAId).not.toBe(pairing.teamBId);
        }
      });
    }
  });

  describe('swiss', () => {
    const format = new SwissFormat();

    for (const size of FIELD_SIZES) {
      const expected = EXPECTED_SWISS[size];

      it(`pairs ${size} entrants without duplicates and honours R=${expected.rounds}`, () => {
        expect(format.calculateRounds(size)).toBe(expected.rounds);
        expect(format.calculatePlayoffCutoff(size)).toBe(expected.cutoff);

        const round1 = format.generateRound1(teams(size));
        const seen = participants(round1);
        expect(new Set(seen).size).toBe(seen.length);
        // Every entrant is accounted for: odd fields give exactly one of them a bye.
        expect(seen).toHaveLength(size);
        expect(round1.pairings.filter((pairing) => pairing.isBye)).toHaveLength(size % 2);
        expect(playing(round1)).toHaveLength(size - (size % 2));
      });

      // Round 2 only exists when the policy allows more than one round (N ≥ 3).
      it.runIf(expected.rounds > 1)(`avoids rematches in round 2 for ${size} entrants`, () => {
        const round1 = format.generateRound1(teams(size));
        const completed = round1.pairings.map((pairing, index) => ({
          encounterId: `enc-${index}`,
          roundOrdinal: 1,
          slotOrdinal: pairing.slotOrdinal,
          status: pairing.isBye ? 'BYE' : 'COMPLETED',
          teamAId: pairing.teamAId,
          teamBId: pairing.teamBId,
          winnerTeamId: pairing.teamAId,
          pointsA: pairing.isBye ? 0 : 3,
          pointsB: 0,
        }));

        const round2 = format.generateNextRound(teams(size), completed, 1);
        const seen = participants(round2);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(size);
        expect(playing(round2)).toHaveLength(size - (size % 2));

        const playedInRound1 = new Set(
          round1.pairings
            .filter((pairing) => !pairing.isBye)
            .map((pairing) => pairKey(pairing.teamAId, pairing.teamBId as string))
        );
        for (const pairing of round2.pairings) {
          if (pairing.isBye) continue;
          expect(playedInRound1.has(pairKey(pairing.teamAId, pairing.teamBId as string))).toBe(false);
        }
      });
    }
  });

  describe('round robin', () => {
    const format = new RoundRobinFormat();

    for (const size of FIELD_SIZES) {
      it(`schedules every unordered pair exactly once for ${size} entrants`, () => {
        const totalRounds = format.calculateTotalRounds(size);
        expect(totalRounds).toBe(size % 2 === 0 ? size - 1 : size);

        const pairs = new Set<string>();
        for (let roundOrdinal = 1; roundOrdinal <= totalRounds; roundOrdinal += 1) {
          const schedule = format.generateRound(teams(size), roundOrdinal);
          const seen = participants(schedule);
          // A round is a perfect matching over the field: every entrant appears exactly once.
          expect(new Set(seen).size).toBe(seen.length);
          expect(seen).toHaveLength(size);
          expect(playing(schedule)).toHaveLength(size - (size % 2));

          for (const pairing of schedule.pairings) {
            if (!pairing.teamBId) continue;
            const key = pairKey(pairing.teamAId, pairing.teamBId);
            expect(pairs.has(key)).toBe(false);
            pairs.add(key);
          }
        }
        expect(pairs.size).toBe((size * (size - 1)) / 2);
      });
    }
  });

  describe('elo arena', () => {
    const format = new EloFormat();

    for (const size of FIELD_SIZES) {
      it(`runs ${size} entrants for E=${EXPECTED_ELO_EPOCHS[size]} epochs and pairs each of them once per epoch`, () => {
        expect(format.calculateEpochs(size)).toBe(EXPECTED_ELO_EPOCHS[size]);

        const ratings = new Map(teams(size).map((team) => [team.teamId, 1200]));
        const epoch = format.generateEpoch(teams(size), ratings, new Map(), 1);
        const seen = participants(epoch);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(size);
        expect(epoch.pairings.filter((pairing) => pairing.isBye)).toHaveLength(size % 2);
        expect(playing(epoch)).toHaveLength(size - (size % 2));
      });
    }
  });
});
