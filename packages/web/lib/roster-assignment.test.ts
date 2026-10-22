import { describe, expect, it } from 'vitest';
import { availableRosterAccounts } from './roster-assignment';

describe('availableRosterAccounts', () => {
  it('keeps only other student accounts and does not offer current team members', () => {
    const accounts = [
      { id: 'captain', username: 'captain', displayName: 'Captain', role: 'STUDENT' },
      { id: 'member', username: 'member', displayName: 'Member', role: 'STUDENT' },
      { id: 'other', username: 'other', displayName: 'Other', role: 'STUDENT' },
      { id: 'admin', username: 'admin', displayName: 'Admin', role: 'ADMIN' },
    ];
    expect(availableRosterAccounts(accounts, ['captain', 'member']).map(({ id }) => id)).toEqual(['other']);
  });
});
