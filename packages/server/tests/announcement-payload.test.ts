import { describe, it, expect } from 'vitest';
import { publicAnnouncementPayload } from '../src/tournaments/routes.js';

/**
 * The public timeline forwards allow-listed outbox payloads, but an organizer's withdrawal note is
 * not a published fact. The reviewed disqualification reason, by contrast, is meant to be public.
 */
describe('S13: public announcement payloads', () => {
  it('drops the withdrawal reason from the public payload', () => {
    const payload = { tournamentId: 't', teamId: 'team', reason: 'medical leave', walkovers: 2 };
    expect(publicAnnouncementPayload('TEAM_WITHDRAWN', payload)).toEqual({
      tournamentId: 't',
      teamId: 'team',
      walkovers: 2,
    });
  });

  it('keeps the reviewed disqualification reason public', () => {
    const payload = { tournamentId: 't', teamId: 'team', stage: 'MAIN', reason: 'cheating upheld', voidedEncounters: 3 };
    expect(publicAnnouncementPayload('TEAM_DISQUALIFIED', payload)).toEqual(payload);
  });

  it('returns non-object payloads untouched', () => {
    expect(publicAnnouncementPayload('TEAM_WITHDRAWN', null)).toBeNull();
    expect(publicAnnouncementPayload('TEAM_WITHDRAWN', 'text')).toBe('text');
    expect(publicAnnouncementPayload('ROUND_SCHEDULED', { round: 1 })).toEqual({ round: 1 });
  });
});
