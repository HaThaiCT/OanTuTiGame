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
  /**
   * Structural number of pairing slots in this round. EMPTY slots produce no encounter row, so this
   * can exceed `pairings.length`; later rounds pair by slot position, not by array order.
   */
  readonly slotCount?: number;
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
  /** Bracket position of the encounter; absent on rows written before slot ordinals existed. */
  readonly slotOrdinal?: number;
  /**
   * `COMPLETED`/`BYE` carry a played (or ghost) result; `WALKOVER` and `DOUBLE_WITHDRAWAL` are
   * unplayed administrative results: their points count, but Buchholz/Sonneborn-Berger ignore
   * them and Elo never rates them.
   */
  readonly status?: string;
  readonly teamAId: UUID;
  readonly teamBId?: UUID;
  readonly winnerTeamId?: UUID;
  readonly pointsA: number;
  readonly pointsB: number;
}
