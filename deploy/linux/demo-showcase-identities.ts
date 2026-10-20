export interface ShowcaseIdentity {
  readonly username: string;
  readonly displayName: string;
  readonly teamSlot: number;
  readonly role: 'CAPTAIN' | 'MEMBER';
}

export interface ShowcaseCourse {
  readonly code: string;
  readonly name: string;
  readonly cohortIndex: number;
}

export function buildShowcaseCourses(tag: string): readonly ShowcaseCourse[] {
  return Array.from({ length: 3 }, (_, cohortIndex) => ({
    code: `${tag.toUpperCase()}_C${cohortIndex + 1}`,
    name: `${tag} Cohort ${cohortIndex + 1}`,
    cohortIndex,
  }));
}

export function buildShowcaseIdentities(tag: string): readonly ShowcaseIdentity[] {
  return Array.from({ length: 48 }, (_, teamSlot) => {
    const teamName = `${tag}_T${String(teamSlot + 1).padStart(2, '0')}`;
    const suffix = String(teamSlot + 1).padStart(2, '0');
    return [
      { username: `${tag.toLowerCase()}_${suffix}a`, displayName: `${teamName} Captain`, teamSlot, role: 'CAPTAIN' as const },
      { username: `${tag.toLowerCase()}_${suffix}b`, displayName: `${teamName} Member`, teamSlot, role: 'MEMBER' as const },
    ];
  }).flat();
}
