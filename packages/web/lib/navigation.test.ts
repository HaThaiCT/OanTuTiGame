import { describe, expect, it } from 'vitest';
import { resolveWorkspaceDestination, safeReturnTo, tournamentCreateTeamHref, tournamentRegistrationHref } from './navigation';

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

  it('sends the no-team create-team CTA to the tournament team tab, not a workspace loop', () => {
    // Regression: `?returnTo=...`-style CTA sent an already-authenticated student to /workspace
    // which immediately redirected back to the registration tab — a no-op loop that never opened
    // the team-creation panel. The fixed link must navigate within the same tournament route.
    const tournamentId = '17d518be-2a9e-458f-9341-2e407156e7ec';
    const href = tournamentCreateTeamHref(tournamentId);
    expect(href).toBe(`/tournaments/${tournamentId}?tab=team`);

    const parsed = new URL(href, 'http://localhost');
    expect(parsed.pathname).toBe(`/tournaments/${tournamentId}`);
    expect(parsed.searchParams.get('tab')).toBe('team');
    expect(parsed.searchParams.has('returnTo')).toBe(false);
    // It must not render as a recurrence of the legacy workspace-loop URL either.
    expect(href).not.toContain('/workspace');
  });

  it('resolves student to exact tournament registration tab when using corrected createTeamHref', () => {
    const returnTo = '/tournaments/17d518be-2a9e-458f-9341-2e407156e7ec?tab=registration';
    expect(resolveWorkspaceDestination(returnTo, 'STUDENT')).toBe('/tournaments/17d518be-2a9e-458f-9341-2e407156e7ec?tab=registration');
    expect(resolveWorkspaceDestination(returnTo, 'ADMIN')).toBe('/tournaments/17d518be-2a9e-458f-9341-2e407156e7ec?tab=registration');
  });

  it('sends the join-page fragment to the registration tab because the anchor only renders there', () => {
    // Regression: the join page used to link `/tournaments/:id#registration`, whose div renders
    // only under `?tab=registration`, so the `<a>` landed silently on top of the overview tab.
    const href = tournamentRegistrationHref('17d518be-2a9e-458f-9341-2e407156e7ec');
    expect(href).toBe('/tournaments/17d518be-2a9e-458f-9341-2e407156e7ec?tab=registration#registration');
    // Query must precede the fragment or navigation drops it entirely.
    expect(href.indexOf('?tab=registration')).toBeLessThan(href.indexOf('#registration'));
    const parsed = new URL(href, 'http://localhost');
    expect(parsed.searchParams.get('tab')).toBe('registration');
    expect(parsed.pathname).toBe('/tournaments/17d518be-2a9e-458f-9341-2e407156e7ec');
    expect(parsed.hash).toBe('#registration');
  });
});
