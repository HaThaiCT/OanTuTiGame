import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry, TeamStanding } from './types.js';

export class RoundRobinFormat {
  /**
   * Calculates total rounds in round-robin:
   * N - 1 if N is even, else N.
   */
  calculateTotalRounds(n: number): number {
    if (n < 2) return 1;
    return n % 2 === 0 ? n - 1 : n;
  }

  /**
   * Generates schedule for a specific round using circle algorithm.
   */
  generateRound(teams: readonly TeamEntry[], roundOrdinal: number): RoundSchedule {
    const n = teams.length;
    const sorted = [...teams].sort((a, b) => a.seedOrdinal - b.seedOrdinal);

    // If odd, add a null dummy for Bye
    const rotationList: (TeamEntry | null)[] = [...sorted];
    if (n % 2 !== 0) {
      rotationList.push(null);
    }

    const numTeams = rotationList.length;
    const totalRounds = numTeams - 1;

    if (roundOrdinal < 1 || roundOrdinal > totalRounds) {
      throw new Error(`Invalid round ${roundOrdinal}; total rounds is ${totalRounds}`);
    }

    // Circle algorithm: fix element 0, rotate rest by (roundOrdinal - 1)
    const shift = roundOrdinal - 1;
    const fixed = rotationList[0];
    const rest = rotationList.slice(1);

    // Rotate rest by shift
    const rotatedRest: (TeamEntry | null)[] = [];
    for (let i = 0; i < rest.length; i++) {
      const srcIdx = (i - shift + rest.length * 100) % rest.length;
      rotatedRest.push(rest[srcIdx]);
    }

    const currentCircle = [fixed, ...rotatedRest];
    const pairings: EncounterPairing[] = [];
    const half = numTeams / 2;

    for (let i = 0; i < half; i++) {
      const t1 = currentCircle[i];
      const t2 = currentCircle[numTeams - 1 - i];

      if (!t1 && !t2) continue;

      if (!t1) {
        pairings.push({
          slotOrdinal: pairings.length + 1,
          teamAId: t2!.teamId,
          teamBId: undefined,
          isBye: true,
        });
      } else if (!t2) {
        pairings.push({
          slotOrdinal: pairings.length + 1,
          teamAId: t1.teamId,
          teamBId: undefined,
          isBye: true,
        });
      } else {
        pairings.push({
          slotOrdinal: pairings.length + 1,
          teamAId: t1.teamId,
          teamBId: t2.teamId,
          isBye: false,
        });
      }
    }

    return {
      roundOrdinal,
      stage: 'MAIN',
      pairings,
    };
  }

  /**
   * Computes standings for Round Robin.
   */
  computeStandings(
    teams: readonly TeamEntry[],
    completedEncounters: readonly CompletedEncounterRecord[]
  ): readonly TeamStanding[] {
    const stats = new Map<string, {
      teamId: string;
      seedOrdinal: number;
      points: number;
      matchesPlayed: number;
      wins: number;
      draws: number;
      losses: number;
    }>();

    for (const t of teams) {
      stats.set(t.teamId, {
        teamId: t.teamId,
        seedOrdinal: t.seedOrdinal,
        points: 0,
        matchesPlayed: 0,
        wins: 0,
        draws: 0,
        losses: 0,
      });
    }

    for (const enc of completedEncounters) {
      const sA = stats.get(enc.teamAId);
      if (!sA) continue;

      if (!enc.teamBId) {
        sA.points += 3;
        sA.wins += 1;
        sA.matchesPlayed += 1;
        continue;
      }

      const sB = stats.get(enc.teamBId);
      if (!sB) continue;

      sA.matchesPlayed += 1;
      sB.matchesPlayed += 1;

      if (enc.winnerTeamId === enc.teamAId) {
        sA.points += 3;
        sA.wins += 1;
        sB.losses += 1;
      } else if (enc.winnerTeamId === enc.teamBId) {
        sB.points += 3;
        sB.wins += 1;
        sA.losses += 1;
      } else {
        sA.points += 1;
        sB.points += 1;
        sA.draws += 1;
        sB.draws += 1;
      }
    }

    const rawStandings = Array.from(stats.values()).map((s) => ({
      teamId: s.teamId,
      seedOrdinal: s.seedOrdinal,
      points: s.points,
      matchesPlayed: s.matchesPlayed,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
    }));

    rawStandings.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return a.seedOrdinal - b.seedOrdinal;
    });

    return rawStandings.map((s, index) => ({
      teamId: s.teamId,
      rank: index + 1,
      points: s.points,
      matchesPlayed: s.matchesPlayed,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
    }));
  }
}
