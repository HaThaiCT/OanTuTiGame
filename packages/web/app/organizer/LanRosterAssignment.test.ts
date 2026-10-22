import { describe, expect, it } from 'vitest';
import { rosterMemberLabel } from './LanRosterAssignment';

describe('rosterMemberLabel', () => {
  it('shows each member identity and captain role', () => {
    expect(rosterMemberLabel({ id: 'u1', username: 'alice', displayName: 'Alice', role: 'CAPTAIN' })).toBe('Alice · alice · Trưởng đội');
    expect(rosterMemberLabel({ id: 'u2', username: 'bob', displayName: 'Bob', role: 'MEMBER' })).toBe('Bob · bob · Thành viên');
  });
});
