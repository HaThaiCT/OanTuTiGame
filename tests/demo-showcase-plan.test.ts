import { describe, expect, it } from 'vitest';
import { buildShowcasePlan } from '../deploy/linux/demo-showcase-plan.js';

const FORMATS = ['SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA'] as const;

describe('buildShowcasePlan', () => {
  it('builds the comprehensive 30-contest distribution with unique teams and broad rotation', () => {
    const plan = buildShowcasePlan('showcase-2026', 'stable-seed');

    expect(plan).toMatchObject({
      version: 1,
      tag: 'showcase-2026',
      seed: 'stable-seed',
      teamCount: 48,
      cohortCount: 3,
      teamsPerCohort: 16,
      botVariantCount: 12,
      mapVariantCount: 12,
    });
    expect(plan.contests).toHaveLength(30);
    expect(plan.contests.every(({ cohortIndex }) => cohortIndex >= 0 && cohortIndex < 3)).toBe(true);
    for (const contest of plan.contests) expect(new Set(contest.teamSlots.map((slot) => slot % 12)).size).toBe(4);
    for (const [first, next] of [[0,12],[3,15],[6,18],[9,21]]) {
      expect(plan.contests[first].cohortIndex).toBe(plan.contests[next].cohortIndex);
      expect(plan.contests[first].teamSlots).not.toEqual(plan.contests[next].teamSlots);
    }
    expect(plan.contests.every((contest, index) => contest.index === index && contest.rated && contest.teamSlots.length === 4 && new Set(contest.teamSlots).size === 4)).toBe(true);
    expect(plan.contests.map(({ format }) => format)).toEqual([
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA',
      'SINGLE_ELIMINATION', 'SWISS_PLAYOFF',
    ]);
    const appearances = Array(48).fill(0) as number[];
    for (const contest of plan.contests) for (const team of contest.teamSlots) appearances[team]++;
    expect(appearances.every((count) => count >= 2)).toBe(true);
  });

  it('is deterministic for identical tag and seed', () => {
    expect(buildShowcasePlan('stable-tag', 'stable-seed')).toEqual(buildShowcasePlan('stable-tag', 'stable-seed'));
  });

  it('selects one contest of each format for count four', () => {
    const plan = buildShowcasePlan('small', 'seed', 4);
    expect(plan.contests.map(({ format }) => format)).toEqual([...FORMATS]);
    expect(plan.contests.every(({ teamSlots }) => teamSlots.length === 4 && new Set(teamSlots).size === 4)).toBe(true);
  });

  it('rejects invalid tags, seeds, and counts', () => {
    for (const tag of ['', 'has spaces', '../unsafe', 'x'.repeat(65)]) expect(() => buildShowcasePlan(tag, 'seed')).toThrow();
    for (const seed of ['', 'x'.repeat(257)]) expect(() => buildShowcasePlan('valid-tag', seed)).toThrow();
    for (const count of [0, 31, 1.5]) expect(() => buildShowcasePlan('valid-tag', 'seed', count)).toThrow();
  });
});
