/**
 * Sanitizes returnTo parameter to prevent open redirect vulnerabilities.
 * Only accepts valid relative paths on the same origin (starting with a single '/').
 */
export function safeReturnTo(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  // Must start with a single '/'
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return null;
  }
  // Disallow backslashes to prevent browser protocol/domain parsing anomalies
  if (trimmed.includes('\\')) {
    return null;
  }
  // Disallow control characters (\x00-\x1F, \x7F)
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.protocol !== 'http:' || parsed.host !== 'localhost') {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * Determines the destination after workspace login/auth based on user role and sanitized returnTo.
 */
export function resolveWorkspaceDestination(
  returnTo: string | null | undefined,
  role: string | null | undefined
): string {
  return safeReturnTo(returnTo) ?? (role === 'ADMIN' ? '/organizer' : '/tournaments');
}

/**
 * Generates the safe returnTo link for creating a team from within a tournament registration tab.
 */
export function tournamentCreateTeamHref(tournamentId: string): string {
  return `/tournaments/${encodeURIComponent(tournamentId)}?tab=team`;
}

/**
 * Link to the registration console of a tournament page. The `#registration` anchor is only
 * rendered inside the `?tab=registration` view, so a bare `/tournaments/:id#registration` fragment
 * would land on the top of the overview tab; the query must travel with the fragment.
 */
export function tournamentRegistrationHref(tournamentId: string): string {
  return `/tournaments/${encodeURIComponent(tournamentId)}?tab=registration#registration`;
}
