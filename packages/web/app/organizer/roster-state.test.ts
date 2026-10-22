import { describe, expect, it } from 'vitest';
import { canAddRosterMember, rosterLoadMessage, isCurrentRosterRequest, type RosterLoadState } from './roster-state';

const empty: RosterLoadState = { kind: 'loaded', members: [], accounts: [{ id: 'u1' }] };

describe('LAN roster load state', () => {
  it('distinguishes a loaded empty team from a failed read', () => {
    expect(rosterLoadMessage(empty)).toBeNull();
    expect(rosterLoadMessage({ kind: 'error', message: 'HTTP 500' })).toBe('HTTP 500');
  });
  it('allows add only after both reads succeeded and while capacity remains', () => {
    expect(canAddRosterMember({ kind: 'loading' })).toBe(false);
    expect(canAddRosterMember({ kind: 'error', message: 'HTTP 500' })).toBe(false);
    expect(canAddRosterMember(empty)).toBe(true);
    expect(canAddRosterMember({ kind: 'loaded', members: Array(5).fill({ userId: 'u' }), accounts: [{ id: 'x' }] })).toBe(false);
  });
  it('ignores responses from a previously selected team', () => {
    expect(isCurrentRosterRequest(4, 4)).toBe(true);
    expect(isCurrentRosterRequest(4, 5)).toBe(false);
  });
});
