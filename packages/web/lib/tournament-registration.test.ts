import { describe, expect, it } from 'vitest';
import type { TeamDto, TournamentEntry, TournamentRegistration } from './api';
import { registrationActions } from './tournament-registration';

const team: TeamDto = { id: 'team', name: 'Đội Sao', tournamentId: 'tournament', captainUserId: 'captain', closedAt: null, rosterLocked: false, members: [{ userId: 'captain', username: 'captain', displayName: 'Trưởng đội', role: 'CAPTAIN' }] };
const entry: TournamentEntry = { id: 'entry', teamId: 'team', teamName: 'Đội Sao', status: 'ELIGIBLE', seedOrdinal: null };
const registration: TournamentRegistration = { id: 'request', tournamentId: 'tournament', teamId: 'team', teamName: 'Đội Sao', status: 'PENDING', version: 1, reason: null, requestedAt: '2026-10-22T09:00:00.000Z', reviewedAt: null, canCancel: true, canRequest: false, members: team.members! };
const now = Date.parse('2026-10-22T10:00:00.000Z');
const input = { tournamentId: 'tournament', userId: 'captain', team, state: 'REGISTRATION_OPEN', registrationClosesAt: '2026-10-22T11:00:00.000Z', registration: null, entry: null };

describe('registrationActions', () => {
  it('allows only the active matching captain to request, leaving members read-only', () => {
    expect(registrationActions(input, now)).toEqual({ canRequest: true, canCancel: false, canSubmit: false });
    expect(registrationActions({ ...input, userId: 'member', registration }, now)).toEqual({ canRequest: false, canCancel: false, canSubmit: false });
    expect(registrationActions({ ...input, team: { ...team, tournamentId: 'other' } }, now).canRequest).toBe(false);
    expect(registrationActions({ ...input, team: { ...team, closedAt: '2026-10-22T09:00:00.000Z' } }, now).canRequest).toBe(false);
  });

  it('keeps pending requests visible but cannot treat them as admissions', () => {
    expect(registrationActions({ ...input, registration }, now)).toEqual({ canRequest: false, canCancel: true, canSubmit: false });
    expect(registrationActions({ ...input, registration, entry }, now).canSubmit).toBe(false);
    expect(registrationActions({ ...input, registration: { ...registration, canCancel: false } }, now).canCancel).toBe(false);
  });

  it('admits approved teams and preserves existing direct admissions', () => {
    expect(registrationActions({ ...input, registration: { ...registration, status: 'APPROVED' }, entry }, now)).toEqual({ canRequest: false, canCancel: true, canSubmit: true });
    expect(registrationActions({ ...input, entry }, now)).toEqual({ canRequest: false, canCancel: false, canSubmit: true });
  });

  it('allows a legacy admitted captain to cancel but not create a new policy-team request', () => {
    expect(registrationActions({ ...input, team: { ...team, tournamentId: null }, registration: { ...registration, status: 'APPROVED' }, entry }, now)).toEqual({ canRequest: false, canCancel: true, canSubmit: true });
    expect(registrationActions({ ...input, team: { ...team, tournamentId: null }, registration: { ...registration, status: 'CANCELLED' }, entry: { ...entry, status: 'EXCLUDED' } }, now).canRequest).toBe(false);
  });

  it('allows rejected or cancelled teams to re-request without reviving their old submission access', () => {
    for (const status of ['REJECTED', 'CANCELLED'] as const) {
      expect(registrationActions({ ...input, registration: { ...registration, status, canCancel: false, canRequest: true }, entry: { ...entry, status: 'EXCLUDED' }, team: { ...team, rosterLocked: true } }, now)).toEqual({ canRequest: true, canCancel: false, canSubmit: false });
    }
    expect(registrationActions({ ...input, entry: { ...entry, status: 'EXCLUDED' } }, now)).toEqual({ canRequest: false, canCancel: false, canSubmit: false });
  });

  it('never offers re-request when server provenance disallows an admin-excluded entry', () => {
    expect(registrationActions({ ...input, registration: { ...registration, status: 'CANCELLED', canCancel: false, canRequest: false }, entry: { ...entry, status: 'EXCLUDED' } }, now)).toEqual({ canRequest: false, canCancel: false, canSubmit: false });
  });

  it('closes request and cancellation at the exact deadline and after registration closes', () => {
    expect(registrationActions({ ...input, registrationClosesAt: '2026-10-22T10:00:00.000Z' }, now).canRequest).toBe(false);
    expect(registrationActions({ ...input, registrationClosesAt: '2026-10-22T10:00:00.000Z', registration }, now).canCancel).toBe(false);
    expect(registrationActions({ ...input, state: 'VALIDATING_SUBMISSIONS', registration }, now).canCancel).toBe(false);
    expect(registrationActions({ ...input, state: 'LOCKED' }, now).canRequest).toBe(false);
  });
});
