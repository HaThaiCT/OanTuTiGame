import { describe, expect, it } from 'vitest';
import { resolveWorkspaceDestination, safeReturnTo, tournamentCreateTeamHref } from './navigation';

describe('navigation safeReturnTo and workspace destinations', () => {
  it('validates safe relative paths and rejects open-redirect attempts', () => {
    expect(safeReturnTo('/tournaments/abc?tab=registration')).toBe('/tournaments/abc?tab=registration');
    expect(safeReturnTo('/workspace')).toBe('/workspace');
    expect(safeReturnTo('//evil.com')).toBeNull();
    expect(safeReturnTo('/\\evil.com')).toBeNull();
    expect(safeReturnTo('https://evil.com')).toBeNull();
    expect(safeReturnTo('javascript:alert(1)')).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo('')).toBeNull();
  });

  it('proves old unparameterized workspace URL loses tournament context for students', () => {
    const oldUrl = '/workspace?tournament=17d518be-2a9e-458f-9341-2e407156e7ec#create-team';
    const parsed = new URL(oldUrl, 'http://localhost');
    const returnTo = parsed.searchParams.get('returnTo');
    // The old createTeamHref lacked returnTo, so workspace router dropped the student onto /tournaments
    expect(returnTo).toBeNull();
    expect(resolveWorkspaceDestination(returnTo, 'STUDENT')).toBe('/tournaments');
  });

  it('resolves student to exact tournament registration tab when using corrected createTeamHref', () => {
    const tournamentId = '17d518be-2a9e-458f-9341-2e407156e7ec';
    const href = tournamentCreateTeamHref(tournamentId);
    const parsed = new URL(href, 'http://localhost');
    const returnTo = parsed.searchParams.get('returnTo');

    expect(returnTo).toBe(`/tournaments/${tournamentId}?tab=registration`);
    expect(resolveWorkspaceDestination(returnTo, 'STUDENT')).toBe(`/tournaments/${tournamentId}?tab=registration`);
    expect(resolveWorkspaceDestination(returnTo, 'ADMIN')).toBe(`/tournaments/${tournamentId}?tab=registration`);
  });
});
