import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { calculateContestRating, calculateContestRatingAsync, type RatingCalculationInput } from '../src/ratings/calculator.js';
import { teamRatingRank } from '@oantuti/protocol';

const golden = JSON.parse(readFileSync(new URL('./fixtures/global-rating-v1.json', import.meta.url), 'utf8')) as {
  cases: { name: string; input: RatingCalculationInput[]; expected: { teamId: string; oldRating: number; delta: number; newRating: number }[]; corrections: { topCorrectionCount: number; secondCorrection: number } }[];
};

const equalFour: readonly RatingCalculationInput[] = [
  { teamId: '00000000-0000-0000-0000-000000000001', rating: 1500, rank: 1, rankEnd: 1 },
  { teamId: '00000000-0000-0000-0000-000000000002', rating: 1500, rank: 2, rankEnd: 2 },
  { teamId: '00000000-0000-0000-0000-000000000003', rating: 1500, rank: 3, rankEnd: 3 },
  { teamId: '00000000-0000-0000-0000-000000000004', rating: 1500, rank: 4, rankEnd: 4 },
];

describe('ArenaContestRating/v1 calculator', () => {
  for (const fixture of golden.cases) {
    it(`matches independent Decimal50 integers: ${fixture.name}`, async () => {
      expect(calculateContestRating(fixture.input)).toEqual(fixture.expected);
      expect(calculateContestRating([...fixture.input].reverse())).toEqual(fixture.expected);
      expect(await calculateContestRatingAsync(fixture.input)).toEqual(fixture.expected);
    });
  }

  it('uses exactly twenty UUID-selected correction members across an equal-rating cutoff', () => {
    const fixture = golden.cases.find((row) => row.name === 'equal-25-cutoff-20')!;
    expect(fixture.corrections).toMatchObject({ topCorrectionCount: 20, secondCorrection: -10 });
    expect(calculateContestRating([...fixture.input.slice(20), ...fixture.input.slice(0, 20)])).toEqual(fixture.expected);
  });

  it('stores actual clamped deltas at zero and eight thousand', () => {
    const lower = calculateContestRating(golden.cases.find((row) => row.name === 'clamp-boundaries')!.input);
    const upper = calculateContestRating(golden.cases.find((row) => row.name === 'upper-clamp')!.input);
    expect(lower[0]).toMatchObject({ oldRating: 0, delta: 0, newRating: 0 });
    expect(upper[0]).toMatchObject({ oldRating: 8000, delta: 0, newRating: 8000 });
    for (const row of [...lower, ...upper]) expect(row.delta).toBe(row.newRating - row.oldRating);
  });

  it('rates final contest placement deterministically', () => {
    expect(calculateContestRating(equalFour)).toEqual([
      { teamId: equalFour[0].teamId, oldRating: 1500, delta: 112, newRating: 1612 },
      { teamId: equalFour[1].teamId, oldRating: 1500, delta: 19, newRating: 1519 },
      { teamId: equalFour[2].teamId, oldRating: 1500, delta: -39, newRating: 1461 },
      { teamId: equalFour[3].teamId, oldRating: 1500, delta: -93, newRating: 1407 },
    ]);
  });

  it('validates placement groups by rank when UUID order is inverse', () => {
    const inverseRanks = [
      { ...equalFour[0], teamId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', rank: 1, rankEnd: 1 },
      { ...equalFour[1], teamId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', rank: 2, rankEnd: 2 },
      { ...equalFour[2], teamId: '11111111-1111-1111-1111-111111111111', rank: 3, rankEnd: 3 },
      { ...equalFour[3], teamId: '00000000-0000-0000-0000-000000000000', rank: 4, rankEnd: 4 },
    ];
    const result = calculateContestRating(inverseRanks);
    expect(result.map(({ teamId }) => teamId)).toEqual([...inverseRanks].map(({ teamId }) => teamId).sort());
    expect(result.map(({ delta }) => delta)).toEqual([-93, -39, 19, 112]);
    expect(result.find(({ teamId }) => teamId === inverseRanks[0].teamId)?.delta).toBe(112);
    expect(calculateContestRating([...inverseRanks].reverse())).toEqual(result);
  });
  it('keeps equal-place equal-rating teams on identical deltas independent of input order', () => {
    const tied = [
      { ...equalFour[0], rank: 1, rankEnd: 2 },
      { ...equalFour[1], rank: 1, rankEnd: 2 },
      { ...equalFour[2], rank: 3, rankEnd: 4 },
      { ...equalFour[3], rank: 3, rankEnd: 4 },
    ];
    const forward = calculateContestRating(tied);
    const reverse = calculateContestRating([...tied].reverse());
    expect(forward).toEqual(reverse);
    expect(forward[0].delta).toBe(forward[1].delta);
    expect(forward[2].delta).toBe(forward[3].delta);
  });
  it('keeps the event loop responsive while rating 500 teams and matches sync output', async () => {
    const entries: RatingCalculationInput[] = Array.from({ length: 500 }, (_, index) => ({
      teamId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      rating: 1000 + (index * 37) % 2000,
      rank: index + 1,
      rankEnd: index + 1,
    }));
    const smallExpected = calculateContestRating(equalFour);
    const eventLoopTurn = new Promise<'yielded'>((resolve) => setImmediate(() => resolve('yielded')));
    const largeCalculation = calculateContestRatingAsync(entries);
    const winner = await Promise.race([eventLoopTurn, largeCalculation.then(() => 'completed' as const)]);
    expect(winner).toBe('yielded');
    const actual = await largeCalculation;
    expect(actual).toEqual(calculateContestRating(entries));
    expect(await calculateContestRatingAsync(equalFour)).toEqual(smallExpected);
  });

  it('rejects malformed competition ranks and duplicate teams', () => {
    expect(() => calculateContestRating([{ ...equalFour[0], rank: 1, rankEnd: 3 }, ...equalFour.slice(1)])).toThrow('INVALID_CONTEST_PLACEMENT');
    expect(() => calculateContestRating([equalFour[0], { ...equalFour[0], rank: 2, rankEnd: 2 }])).toThrow('INVALID_CONTEST_PLACEMENT');
  });

  it.each([
    [1200, 'NEWBIE', 'PUPIL'],
    [1400, 'PUPIL', 'SPECIALIST'],
    [1600, 'SPECIALIST', 'EXPERT'],
    [1900, 'EXPERT', 'CANDIDATE_MASTER'],
    [2100, 'CANDIDATE_MASTER', 'MASTER'],
    [2300, 'MASTER', 'INTERNATIONAL_MASTER'],
    [2400, 'INTERNATIONAL_MASTER', 'GRANDMASTER'],
    [2600, 'GRANDMASTER', 'INTERNATIONAL_GRANDMASTER'],
    [3000, 'INTERNATIONAL_GRANDMASTER', 'LEGENDARY_GRANDMASTER'],
  ] as const)('maps threshold %i at boundary minus/at/plus one', (threshold, below, at) => {
    expect(teamRatingRank(threshold - 1)).toBe(below);
    expect(teamRatingRank(threshold)).toBe(at);
    expect(teamRatingRank(threshold + 1)).toBe(at);
  });

  it('distinguishes Unrated from rating zero and accepts the numeric endpoints', () => {
    expect(teamRatingRank(null)).toBe('UNRATED');
    expect(teamRatingRank(0)).toBe('NEWBIE');
    expect(teamRatingRank(8000)).toBe('LEGENDARY_GRANDMASTER');
  });

  it.each([-1, 8001, 1500.5, NaN, Infinity, -Infinity])('rejects invalid rating %s in summaries and contest inputs', (rating) => {
    expect(() => teamRatingRank(rating)).toThrow();
    expect(() => calculateContestRating([{ ...equalFour[0], rating }, ...equalFour.slice(1)])).toThrow('INVALID_CONTEST_PLACEMENT');
  });

  it.each([-1, 8001, 1500.5, NaN, Infinity, -Infinity])('rejects invalid rating %s on a nonfirst tied member', async (rating) => {
    const entries = equalFour.map((entry) => ({ ...entry, rank: 1, rankEnd: 4 }));
    entries[1] = { ...entries[1], rating };
    expect(() => calculateContestRating(entries)).toThrow('INVALID_CONTEST_PLACEMENT');
    await expect(calculateContestRatingAsync(entries)).rejects.toThrow('INVALID_CONTEST_PLACEMENT');
  });

  it('rejects an invalid ID on a nonfirst tied member', async () => {
    const entries = equalFour.map((entry) => ({ ...entry, rank: 1, rankEnd: 4 }));
    entries[3] = { ...entries[3], teamId: 'zzzz-invalid-team-id' };
    expect(() => calculateContestRating(entries)).toThrow('INVALID_CONTEST_PLACEMENT');
    await expect(calculateContestRatingAsync(entries)).rejects.toThrow('INVALID_CONTEST_PLACEMENT');
  });

  it('rejects invalid field sizes, rank gaps, fractional ranks and inconsistent ties', () => {
    for (const entries of [
      [],
      [equalFour[0]],
      Array.from({ length: 501 }, (_, index) => ({ teamId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, rating: 1500, rank: index + 1, rankEnd: index + 1 })),
      equalFour.map((row) => ({ ...row, rank: row.rank + 1, rankEnd: row.rankEnd + 1 })),
      [{ ...equalFour[0], rank: 1.5 }, ...equalFour.slice(1)],
      [{ ...equalFour[0], rankEnd: 2 }, ...equalFour.slice(1)],
      [{ ...equalFour[0], rankEnd: 0 }, ...equalFour.slice(1)],
      [{ ...equalFour[0], teamId: 'not-a-team-id' }, ...equalFour.slice(1)],
    ]) expect(() => calculateContestRating(entries)).toThrow('INVALID_CONTEST_PLACEMENT');
  });
});
