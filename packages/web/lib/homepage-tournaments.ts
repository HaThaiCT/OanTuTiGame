export interface HomepageTournamentState {
  readonly id: string;
  readonly state: string;
}

const featuredStates: Readonly<Record<string, true>> = {
  REGISTRATION_OPEN: true,
  PUBLISHED: true,
  VALIDATING_SUBMISSIONS: true,
  LOCKED: true,
  READY_TO_START: true,
  RUNNING: true,
  PAUSED: true,
  PROVISIONAL: true,
};

export function selectHomepageTournaments<T extends HomepageTournamentState>(tournaments: readonly T[]): { readonly spotlight: T | null; readonly featured: T[] } {
  const live = tournaments.find((tournament) => tournament.state === 'RUNNING');
  const actionable = tournaments.filter((tournament) => featuredStates[tournament.state] === true);
  const spotlight = live ?? actionable[0] ?? null;
  return { spotlight, featured: actionable.filter((tournament) => tournament.id !== spotlight?.id).slice(0, 4) };
}
