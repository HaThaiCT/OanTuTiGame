import { describe, expect, it } from 'vitest';
import { selectHomepageTournaments } from './homepage-tournaments';

const items = [
  { id: 'done', state: 'FINALIZED' },
  { id: 'live', state: 'RUNNING' },
  { id: 'open', state: 'REGISTRATION_OPEN' },
  { id: 'archived', state: 'ARCHIVED' },
  { id: 'ready', state: 'READY_TO_START' },
  { id: 'cancelled', state: 'CANCELLED' },
] as const;

describe('selectHomepageTournaments', () => {
  it('uses live or upcoming events only for spotlight and featured shelf', () => {
    expect(selectHomepageTournaments(items)).toEqual({ spotlight: items[1], featured: [items[2], items[4]] });
  });
  it('returns no spotlight instead of showing completed history when no actionable event exists', () => {
    expect(selectHomepageTournaments([items[0], items[3], items[5]])).toEqual({ spotlight: null, featured: [] });
  });
});
