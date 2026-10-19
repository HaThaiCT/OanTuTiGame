import { describe, expect, it } from 'vitest';
import { compactPlacements, mergeSwissPlayoffGroups } from '../src/ratings/placements.js';

describe('global rating placements', () => {
  it('compacts surviving tied groups after exclusions', () => {
    expect(compactPlacements([
      { teamId: '00000000-0000-0000-0000-000000000001', group: 0 },
      { teamId: '00000000-0000-0000-0000-000000000002', group: 1 },
      { teamId: '00000000-0000-0000-0000-000000000003', group: 2 },
      { teamId: '00000000-0000-0000-0000-000000000004', group: 2 },
    ])).toEqual([
      { teamId: '00000000-0000-0000-0000-000000000001', rank: 1, rankEnd: 1, participation: 'PLACED' },
      { teamId: '00000000-0000-0000-0000-000000000002', rank: 2, rankEnd: 2, participation: 'PLACED' },
      { teamId: '00000000-0000-0000-0000-000000000003', rank: 3, rankEnd: 4, participation: 'PLACED' },
      { teamId: '00000000-0000-0000-0000-000000000004', rank: 3, rankEnd: 4, participation: 'PLACED' },
    ]);
  });

  it('places playoff qualifiers before Swiss nonqualifiers without reusing qualifier ranks', () => {
    expect(mergeSwissPlayoffGroups(
      ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      [
        { teamId: '00000000-0000-0000-0000-000000000001', group: 0 },
        { teamId: '00000000-0000-0000-0000-000000000002', group: 1 },
      ],
      [
        { teamId: '00000000-0000-0000-0000-000000000003', rank: 1 },
        { teamId: '00000000-0000-0000-0000-000000000004', rank: 2 },
      ],
    )).toEqual([
      { teamId: '00000000-0000-0000-0000-000000000001', group: 0 },
      { teamId: '00000000-0000-0000-0000-000000000002', group: 1 },
      { teamId: '00000000-0000-0000-0000-000000000003', group: 2 },
      { teamId: '00000000-0000-0000-0000-000000000004', group: 3 },
    ]);
  });
});
