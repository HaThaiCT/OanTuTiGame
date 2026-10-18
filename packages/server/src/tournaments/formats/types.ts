import type { UUID } from '@oantuti/protocol';

export interface TeamEntry {
  readonly teamId: UUID;
  readonly seedOrdinal: number;
  readonly name?: string;
}

export interface EncounterPairing {
  readonly slotOrdinal: number;
  readonly teamAId: UUID;
  readonly teamBId?: UUID; // Undefined if BYE
  readonly isBye: boolean;
}

export interface RoundSchedule {
  readonly roundOrdinal: number;
  readonly stage: string;
  readonly pairings: readonly EncounterPairing[];
}

export interface TeamStanding {
  readonly teamId: UUID;
  readonly rank: number;
  readonly points: number;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly buchholz?: number;
  readonly sonnebornBerger?: number;
  readonly ratingElo?: number;
  readonly isQualified?: boolean;
}

export interface CompletedEncounterRecord {
  readonly encounterId: UUID;
  readonly roundOrdinal: number;
  readonly teamAId: UUID;
  readonly teamBId?: UUID;
  readonly winnerTeamId?: UUID;
  readonly pointsA: number;
  readonly pointsB: number;
}
