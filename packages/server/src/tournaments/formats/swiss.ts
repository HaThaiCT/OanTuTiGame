import type { CompletedEncounterRecord, EncounterPairing, RoundSchedule, TeamEntry, TeamStanding } from './types.js';

export class SwissFormat {
  /**
   * Calculates standard Swiss round count R:
   * R = min(ceil(log2(N)), N - 1 if even else N)
   */
  calculateRounds(n: number): number {
    if (n < 2) return 1;
    const log2Ceil = Math.ceil(Math.log2(n));
    const roundCap = n % 2 === 0 ? n - 1 : n;
    return Math.min(log2Ceil, roundCap);
  }

  /**
   * Calculates playoff cutoff T:
   * T = min(N, max(2, 2^floor(log2(isqrt(N)))))
   */
  calculatePlayoffCutoff(n: number): number {
    if (n < 2) return n;
    const isqrt = Math.floor(Math.sqrt(n));
    const pow2 = Math.pow(2, Math.floor(Math.log2(Math.max(1, isqrt))));
    return Math.min(n, Math.max(2, pow2));
  }

  /**
   * Generates round 1 Swiss pairings by splitting top half vs bottom half by seed.
   */
  generateRound1(teams: readonly TeamEntry[]): RoundSchedule {
    const sorted = [...teams].sort((a, b) => a.seedOrdinal - b.seedOrdinal);
    const n = sorted.length;
    const pairings: EncounterPairing[] = [];

    // If odd number of teams, lowest seed gets a bye
    let activeTeams = sorted;
    if (n % 2 !== 0) {
      const byeTeam = sorted[n - 1]; // Worst seed gets initial bye
      pairings.push({
        slotOrdinal: 1,
        teamAId: byeTeam.teamId,
        teamBId: undefined,
        isBye: true,
      });
      activeTeams = sorted.slice(0, n - 1);
    }

    const half = activeTeams.length / 2;
    for (let i = 0; i < half; i++) {
      pairings.push({
        slotOrdinal: pairings.length + 1,
        teamAId: activeTeams[i].teamId,
        teamBId: activeTeams[i + half].teamId,
        isBye: false,
      });
    }

    return {
      roundOrdinal: 1,
      stage: 'SWISS',
      pairings,
    };
  }

  /**
   * Computes Swiss standings from history of completed encounters.
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
      opponents: string[];
      defeatedOpponents: string[];
      drawnOpponents: string[];
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
        opponents: [],
        defeatedOpponents: [],
        drawnOpponents: [],
      });
    }

    for (const enc of completedEncounters) {
      const sA = stats.get(enc.teamAId);
      if (!sA) continue;

      if (!enc.teamBId) {
        // BYE: awards 3 points
        sA.points += 3;
        sA.wins += 1;
        sA.matchesPlayed += 1;
        continue;
      }

      const sB = stats.get(enc.teamBId);
      if (!sB) continue;

      sA.matchesPlayed += 1;
      sB.matchesPlayed += 1;
      sA.opponents.push(enc.teamBId);
      sB.opponents.push(enc.teamAId);

      if (enc.winnerTeamId === enc.teamAId) {
        sA.points += 3;
        sA.wins += 1;
        sB.losses += 1;
        sA.defeatedOpponents.push(enc.teamBId);
      } else if (enc.winnerTeamId === enc.teamBId) {
        sB.points += 3;
        sB.wins += 1;
        sA.losses += 1;
        sB.defeatedOpponents.push(enc.teamAId);
      } else {
        // Draw
        sA.points += 1;
        sB.points += 1;
        sA.draws += 1;
        sB.draws += 1;
        sA.drawnOpponents.push(enc.teamBId);
        sB.drawnOpponents.push(enc.teamAId);
      }
    }

    // Calculate Buchholz and Sonneborn-Berger
    const rawStandings = Array.from(stats.values()).map((s) => {
      let buchholz = 0;
      for (const oppId of s.opponents) {
        buchholz += stats.get(oppId)?.points ?? 0;
      }

      let sonnebornBerger = 0;
      for (const oppId of s.defeatedOpponents) {
        sonnebornBerger += stats.get(oppId)?.points ?? 0;
      }
      for (const oppId of s.drawnOpponents) {
        sonnebornBerger += (stats.get(oppId)?.points ?? 0) * 0.5;
      }

      return {
        teamId: s.teamId,
        seedOrdinal: s.seedOrdinal,
        points: s.points,
        matchesPlayed: s.matchesPlayed,
        wins: s.wins,
        draws: s.draws,
        losses: s.losses,
        buchholz,
        sonnebornBerger,
      };
    });

    // Sort: points DESC, Buchholz DESC, Sonneborn-Berger DESC, seedOrdinal ASC
    rawStandings.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
      if (b.sonnebornBerger !== a.sonnebornBerger) return b.sonnebornBerger - a.sonnebornBerger;
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
      buchholz: s.buchholz,
      sonnebornBerger: s.sonnebornBerger,
    }));
  }

  /**
   * Generates next round Swiss pairings.
   */
  generateNextRound(
    teams: readonly TeamEntry[],
    completedEncounters: readonly CompletedEncounterRecord[],
    currentRoundOrdinal: number
  ): RoundSchedule {
    const totalRounds = this.calculateRounds(teams.length);
    if (currentRoundOrdinal >= totalRounds) {
      throw new Error(`Swiss tournament complete after ${totalRounds} rounds`);
    }

    const standings = this.computeStandings(teams, completedEncounters);

    // Build rematch history
    const playedPairs = new Set<string>();
    const byeCount = new Map<string, number>();

    for (const t of teams) byeCount.set(t.teamId, 0);

    for (const enc of completedEncounters) {
      if (!enc.teamBId) {
        byeCount.set(enc.teamAId, (byeCount.get(enc.teamAId) ?? 0) + 1);
      } else {
        const pairKey1 = `${enc.teamAId}:${enc.teamBId}`;
        const pairKey2 = `${enc.teamBId}:${enc.teamAId}`;
        playedPairs.add(pairKey1);
        playedPairs.add(pairKey2);
      }
    }

    let unassigned = [...standings];
    const pairings: EncounterPairing[] = [];

    // If odd number of teams, award bye
    if (unassigned.length % 2 !== 0) {
      // Find candidate with lowest points, fewest byes, highest initial seed
      let byeCandidateIdx = unassigned.length - 1;
      for (let i = unassigned.length - 1; i >= 0; i--) {
        if ((byeCount.get(unassigned[i].teamId) ?? 0) === 0) {
          byeCandidateIdx = i;
          break;
        }
      }
      const byeTeam = unassigned.splice(byeCandidateIdx, 1)[0];
      pairings.push({
        slotOrdinal: 1,
        teamAId: byeTeam.teamId,
        teamBId: undefined,
        isBye: true,
      });
    }

    // Greedy matching minimizing rematches
    while (unassigned.length >= 2) {
      const teamA = unassigned.shift()!;
      let bestPartnerIdx = 0;
      let foundNonRematch = false;

      for (let i = 0; i < unassigned.length; i++) {
        const partner = unassigned[i];
        if (!playedPairs.has(`${teamA.teamId}:${partner.teamId}`)) {
          bestPartnerIdx = i;
          foundNonRematch = true;
          break;
        }
      }

      const teamB = unassigned.splice(bestPartnerIdx, 1)[0];
      pairings.push({
        slotOrdinal: pairings.length + 1,
        teamAId: teamA.teamId,
        teamBId: teamB.teamId,
        isBye: false,
      });
    }

    return {
      roundOrdinal: currentRoundOrdinal + 1,
      stage: 'SWISS',
      pairings,
    };
  }
}
