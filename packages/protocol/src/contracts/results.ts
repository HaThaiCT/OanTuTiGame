import type { Digest, Instant, Receipt, UUID } from './common.js';

export interface ActionTraceStep {
  readonly ply: number;
  readonly side: number;
  readonly move: {
    readonly pieceId: number;
    readonly targetPos: { readonly x: number; readonly y: number };
  };
  readonly capture?: {
    readonly attackerId: number;
    readonly victimId: number;
    readonly pos: { readonly x: number; readonly y: number };
    readonly attackerType: number;
    readonly victimType: number;
  };
}

export interface GameResultEvidence {
  readonly gameId: UUID;
  readonly winner: number; // 0 = unspecified/draw, 1 = white, 2 = black
  readonly reason: string;
  readonly disposition: 'DECISIVE' | 'DRAW' | 'NO_CONTEST';
  readonly executionStatus: 'COMPLETED' | 'BOT_FORFEIT';
  readonly rulesRevision: string;
  readonly totalPly: number;
  readonly trace: readonly ActionTraceStep[];
  readonly cpuUsec?: string;
  readonly wallUsec?: string;
}

export interface GameResultDto {
  readonly gameId: UUID;
  readonly resultVersionId: UUID;
  readonly revision: number;
  readonly winner: number;
  readonly reason: string;
  readonly disposition: string;
  readonly totalTurns: number;
  readonly actionTraceDigest: Digest;
  readonly replayDigest: Digest;
  readonly manifestDigest: Digest;
  readonly acceptedAt: Instant;
}

export interface ReplayMetadataDto {
  readonly digest: Digest;
  readonly sizeBytes: number;
  readonly totalTurns: number;
  readonly createdAt: Instant;
}

export type AcceptedResultReceipt = Receipt<{
  readonly gameId: UUID;
  readonly resultVersionId: UUID;
  readonly state: 'ACCEPTED';
  readonly acceptedAt: Instant;
}>;
