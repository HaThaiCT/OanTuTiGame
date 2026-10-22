export interface RosterMember {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
}

export type RosterLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly members: readonly RosterMember[]; readonly accounts: readonly unknown[] };

export function canAddRosterMember(state: RosterLoadState): boolean {
  return state.kind === 'loaded' && state.members.length < 5 && state.accounts.length > 0;
}

export function rosterLoadMessage(state: RosterLoadState): string | null {
  return state.kind === 'error' ? state.message : null;
}

export function isCurrentRosterRequest(request: number, activeRequest: number): boolean {
  return request === activeRequest;
}
