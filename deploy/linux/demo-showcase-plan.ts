export type ShowcaseFormat = 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';

export interface ShowcaseContestPlan {
  index: number;
  name: string;
  format: ShowcaseFormat;
  cohortIndex: number;
  teamSlots: readonly number[];
  rated: boolean;
}

export interface ShowcasePlan {
  version: 1;
  tag: string;
  seed: string;
  teamCount: 48;
  cohortCount: 3;
  teamsPerCohort: 16;
  contests: ShowcaseContestPlan[];
  botVariantCount: 12;
  mapVariantCount: 12;
}

const FORMATS: readonly ShowcaseFormat[] = [
  'SINGLE_ELIMINATION',
  'SWISS_PLAYOFF',
  'ROUND_ROBIN',
  'ELO_ARENA',
];

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffledTeams(seed: string, size = 48): number[] {
  const teams = Array.from({ length: size }, (_, index) => index);
  let state = hashSeed(seed) || 0x9e3779b9;
  for (let index = teams.length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const other = (state >>> 0) % (index + 1);
    [teams[index], teams[other]] = [teams[other], teams[index]];
  }
  return teams;
}

export function buildShowcasePlan(tag: string, seed: string, count = 30): ShowcasePlan {
  if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tag)) {
    throw new Error('tag must be 1–64 safe alphanumeric, underscore, or hyphen characters');
  }
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 256 || seed.trim() !== seed) {
    throw new Error('seed must be a non-empty string of at most 256 characters without surrounding whitespace');
  }
  if (!Number.isInteger(count) || count < 1 || count > 30) {
    throw new Error('count must be an integer from 1 through 30');
  }

  const cohortTeams = Array.from({ length: 3 }, (_, cohortIndex) =>
    shuffledTeams(`${tag}\0${seed}\0${cohortIndex}`, 16).map((slot) => cohortIndex * 16 + slot),
  );
  const contests: ShowcaseContestPlan[] = Array.from({ length: count }, (_, index) => {
    const cohortIndex = index % 3;
    const cohortRound = Math.floor(index / 3);
    const roundOffset = (cohortRound * 3) % 16;
    const candidates = [...cohortTeams[cohortIndex]].map((slot, offset) => ({ slot, order: (offset - roundOffset + 16) % 16 }));
    candidates.sort((left, right) => left.order - right.order);
    const teamSlots: number[] = [];
    const variants = new Set<number>();
    for (const { slot } of candidates) {
      const variant = slot % 12;
      if (variants.has(variant)) continue;
      variants.add(variant); teamSlots.push(slot);
      if (teamSlots.length === 4) break;
    }
    if (teamSlots.length !== 4) throw new Error('each four-team field requires four distinct showcase bot variants');
    return { index, name: `${tag}-${String(index + 1).padStart(2, '0')}`, format: FORMATS[index % FORMATS.length], cohortIndex, teamSlots, rated: true };
  });

  return {
    version: 1,
    tag,
    seed,
    teamCount: 48,
    cohortCount: 3,
    teamsPerCohort: 16,
    contests,
    botVariantCount: 12,
    mapVariantCount: 12,
  };
}
