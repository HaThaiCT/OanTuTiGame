import type { Digest, Instant, Receipt, UUID } from './common.js';

export type JobType = 'BUILD' | 'GAME' | 'TEST_BUILD' | 'TEST_GAME';

export type JobState =
  | 'QUEUED'
  | 'LEASED'
  | 'RUNNING'
  | 'COMPLETION_PENDING'
  | 'SUCCEEDED'
  | 'RETRY_WAIT'
  | 'BLOCKED';

export interface WorkerIdentity {
  readonly workerId: string;
  readonly pid: number;
  readonly uid: number;
}

export interface ReconcilerIdentity {
  readonly reconcilerId: string;
  readonly pid: number;
  readonly uid: number;
}

export interface SlotOffer {
  readonly buildSlots: number;
  readonly gameSlots: number;
  readonly runtimeProfileDigest?: Digest;
}

export interface LeaseIdentity {
  readonly jobId: UUID;
  readonly attemptId: UUID;
  readonly fencingToken: string;
  readonly deploymentGeneration: number;
  readonly grantId: UUID;
}

export interface JobLease {
  readonly identity: LeaseIdentity;
  readonly jobType: JobType;
  readonly targetId: UUID;
  readonly payload: unknown;
  readonly expiresAt: Instant;
}

export type LeaseStatus =
  | { readonly status: 'ACTIVE'; readonly expiresAt: Instant }
  | { readonly status: 'STOP'; readonly reason: string };

export interface ResultEvidence {
  readonly verdict: 'DECISIVE' | 'DRAW' | 'NO_CONTEST';
  readonly winner?: number;
  readonly reason: string;
  readonly actionTraceDigest: Digest;
  readonly replayDigest: Digest;
  readonly manifestDigest: Digest;
  readonly cpuUsec: string;
  readonly wallUsec: string;
  readonly details?: unknown;
}

export type CompletionReceipt = Receipt<{
  readonly completionId: UUID;
  readonly state: 'COMPLETION_PENDING';
  readonly evidenceDigest: Digest;
}>;

export interface PinnedCompletion {
  readonly completionId: UUID;
  readonly evidenceDigest: Digest;
  readonly deploymentGeneration: number;
}

export type ResultReceipt = Receipt<{
  readonly resultVersionId: UUID;
  readonly state: 'ACCEPTED';
}>;
