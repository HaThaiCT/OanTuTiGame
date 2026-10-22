export interface RosterAccountCandidate {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
}

export function availableRosterAccounts<T extends RosterAccountCandidate>(
  accounts: readonly T[],
  memberIds: readonly string[],
): T[] {
  const currentMembers = new Set(memberIds);
  return accounts.filter((account) => account.role === 'STUDENT' && !currentMembers.has(account.id));
}
