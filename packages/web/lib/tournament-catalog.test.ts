import { describe, expect, it } from 'vitest';
import type { TournamentSummary } from './api';
import { filterTournaments, orderTournamentsForDirectory, type TournamentDirectoryStatus } from './public-game-result';

const tournaments: TournamentSummary[] = [
  { id: 'old', name: 'SHOWCASE-01', format: 'ROUND_ROBIN', state: 'FINALIZED', version: 1, isRated: false, globalRatingPolicy: 'ArenaContestRating/v1', rulesRevision: 'ArenaGameplay/v2', maxTeams: 8, registrationClosesAt: null, startedAt: null, createdAt: '' },
  { id: 'open', name: 'Giải Mùa Xuân', format: 'ROUND_ROBIN', state: 'REGISTRATION_OPEN', version: 1, isRated: false, globalRatingPolicy: 'ArenaContestRating/v1', rulesRevision: 'ArenaGameplay/v2', maxTeams: 8, registrationClosesAt: null, startedAt: null, createdAt: '' },
  { id: 'live', name: 'Giải Swiss', format: 'SWISS_PLAYOFF', state: 'RUNNING', version: 1, isRated: true, globalRatingPolicy: 'ArenaContestRating/v1', rulesRevision: 'ArenaGameplay/v2', maxTeams: 16, registrationClosesAt: null, startedAt: null, createdAt: '' },
  { id: 'archived', name: 'Giải Hè', format: 'SINGLE_ELIMINATION', state: 'ARCHIVED', version: 1, isRated: false, globalRatingPolicy: 'ArenaContestRating/v1', rulesRevision: 'ArenaGameplay/v2', maxTeams: 8, registrationClosesAt: null, startedAt: null, createdAt: '' },
  { id: 'ready', name: 'Giải Đang Chờ', format: 'ELO_ARENA', state: 'READY_TO_START', version: 1, isRated: false, globalRatingPolicy: 'ArenaContestRating/v1', rulesRevision: 'ArenaGameplay/v2', maxTeams: 8, registrationClosesAt: null, startedAt: null, createdAt: '' },
];

describe('filterTournaments', () => {
  it.each([
    ['LIVE', ['live']],
    ['UPCOMING', ['open', 'ready']],
    ['ENDED', ['old', 'archived']],
    ['ALL', ['old', 'open', 'live', 'archived', 'ready']],
  ] as const)('selects the directory state group %s', (status: TournamentDirectoryStatus, expected) => {
    expect(filterTournaments(tournaments, { status, format: 'ALL', query: '' }).map((item) => item.id)).toEqual(expected);
  });

  it('combines state, format, and Vietnamese name search without widening the selected state', () => {
    expect(filterTournaments(tournaments, { status: 'UPCOMING', format: 'ROUND_ROBIN', query: 'MÙA xuân' }).map((item) => item.id)).toEqual(['open']);
    expect(filterTournaments(tournaments, { status: 'ENDED', format: 'ALL', query: 'mùa xuân' })).toEqual([]);
  });

  it('keeps actionable events ahead of completed history without hiding or name-filtering any event', () => {
    expect(orderTournamentsForDirectory(tournaments).map((item) => item.id)).toEqual(['open', 'live', 'ready', 'old', 'archived']);
    expect(orderTournamentsForDirectory(tournaments)).toHaveLength(tournaments.length);
    expect(orderTournamentsForDirectory(tournaments)[3].name).toBe('SHOWCASE-01');
  });
});
