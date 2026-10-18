import type { Digest, Instant, Receipt, UUID } from './common.js';

export type BotLanguage = 'PYTHON' | 'TYPESCRIPT' | 'CPP';

export type SubmissionStatus =
  | 'VALIDATING'
  | 'QUEUED'
  | 'COMPILING'
  | 'SMOKE_TESTING'
  | 'READY'
  | 'REJECTED';

export type TestStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ProjectFileEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: Digest;
}

export interface ProjectManifest {
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly ProjectFileEntry[];
}

export type SubmissionReceipt = Receipt<{
  readonly submissionId: UUID;
  readonly receivedAt: Instant;
  readonly receiptOrdinal: number;
  readonly sourceDigest: Digest;
  readonly intakeEligibility: 'ELIGIBLE';
}>;

export type TestReceipt = Receipt<{
  readonly testId: UUID;
  readonly queuedAt: Instant;
  readonly sourceDigest: Digest;
}>;

export interface SubmissionDto {
  readonly id: UUID;
  readonly tournamentId: UUID;
  readonly teamId: UUID;
  readonly receiptOrdinal: number;
  readonly sourceDigest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly status: SubmissionStatus;
  readonly rejectReason?: string;
  readonly receivedAt: Instant;
}

export interface TestSnapshotDto {
  readonly id: UUID;
  readonly tournamentId: UUID;
  readonly teamId: UUID;
  readonly sourceDigest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly status: TestStatus;
  readonly createdAt: Instant;
}

export interface PrivateSourceDto {
  readonly submissionId: UUID;
  readonly sourceDigest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly manifest: ProjectManifest;
  readonly zipBase64: string;
}
