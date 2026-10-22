import { describe, expect, it } from 'vitest';
import type { TournamentRegistration } from '../../lib/api';
import {
  canReviewRegistration,
  filterRegistrations,
  prepareRegistrationReview,
  registrationStatusCounts,
} from './registration-review-state';

function registration(overrides: Partial<TournamentRegistration> = {}): TournamentRegistration {
  return {
    id: 'registration-1',
    tournamentId: 'tournament-1',
    teamId: 'team-1',
    teamName: 'Đội Sao',
    status: 'PENDING',
    version: 4,
    reason: null,
    requestedAt: '2026-10-20T08:30:00.000Z',
    reviewedAt: null,
    canCancel: true,
    canRequest: false,
    members: [{ userId: 'user-1', username: 'captain_one', displayName: 'Ngọc Anh', role: 'CAPTAIN' }],
    ...overrides,
  };
}

describe('registration review state', () => {
  it('only offers pending review while registration or submission validation is open', () => {
    expect(canReviewRegistration('REGISTRATION_OPEN', registration())).toBe(true);
    expect(canReviewRegistration('VALIDATING_SUBMISSIONS', registration())).toBe(true);
    for (const state of ['DRAFT', 'PUBLISHED', 'LOCKED', 'READY_TO_START', 'RUNNING', 'PAUSED', 'FINISHED', 'ARCHIVED', 'CANCELLED']) {
      expect(canReviewRegistration(state, registration())).toBe(false);
    }
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(canReviewRegistration('REGISTRATION_OPEN', registration({ status }))).toBe(false);
    }
  });


  it('requires a nonblank rejection reason and enforces the 500 character boundary', () => {
    expect(prepareRegistrationReview('REGISTRATION_OPEN', registration(), 'REJECT', '   ').ok).toBe(false);
    expect(prepareRegistrationReview('REGISTRATION_OPEN', registration(), 'REJECT', 'x'.repeat(500)).ok).toBe(true);
    expect(prepareRegistrationReview('REGISTRATION_OPEN', registration(), 'REJECT', 'x'.repeat(501)).ok).toBe(false);
    expect(prepareRegistrationReview('LOCKED', registration(), 'APPROVE').ok).toBe(false);
    expect(prepareRegistrationReview('REGISTRATION_OPEN', registration({ status: 'CANCELLED' }), 'REJECT', 'Lý do').ok).toBe(false);
  });

  it('filters by status and team or roster identity without searching private review reasons', () => {
    const pending = registration();
    const rejected = registration({ id: 'registration-2', teamId: 'team-2', teamName: 'Khác', status: 'REJECTED', reason: 'private-note', members: [] });
    const rows = [pending, rejected];
    expect(filterRegistrations(rows, 'PENDING', '')).toEqual([pending]);
    expect(filterRegistrations(rows, 'ALL', '  ĐỘI SAO  ')).toEqual([pending]);
    expect(filterRegistrations(rows, 'ALL', 'captain_ONE')).toEqual([pending]);
    expect(filterRegistrations(rows, 'ALL', 'ngọc anh')).toEqual([pending]);
    expect(filterRegistrations(rows, 'ALL', 'team-2')).toEqual([rejected]);
    expect(filterRegistrations(rows, 'APPROVED', 'Đội')).toEqual([]);
    expect(filterRegistrations(rows, 'ALL', 'private-note')).toEqual([]);
  });

  it('counts every status independently of the active queue filter', () => {
    const rows = [
      registration(),
      registration({ id: 'registration-2' }),
      registration({ id: 'registration-3', status: 'APPROVED' }),
      registration({ id: 'registration-4', status: 'REJECTED' }),
      registration({ id: 'registration-5', status: 'CANCELLED' }),
    ];
    expect(registrationStatusCounts(rows)).toEqual({ ALL: 5, PENDING: 2, APPROVED: 1, REJECTED: 1, CANCELLED: 1 });
    expect(registrationStatusCounts([])).toEqual({ ALL: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 });
  });
});
