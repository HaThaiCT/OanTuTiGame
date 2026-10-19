import type { Digest, Instant, Receipt, UUID } from './common.js';
import type { BotLanguage } from './submissions.js';

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
  readonly resultVersionId?: UUID;
  readonly targetId?: UUID;
  readonly kind?: 'GAME' | 'TEST_GAME' | 'BUILD';
  readonly state: 'ACCEPTED';
}>;

/**
 * Evidence a completion pins (03 §173). The tag keeps a build verdict from being shaped like a game
 * result: the broker hashes whatever it is handed, so the tag is what makes the pinned payload
 * self-describing. `TEST_GAME` carries the game shape because a private test is a real match; it
 * simply has no ledger pointers.
 */
export type CompletionEvidence = (
  | { readonly kind: 'GAME'; readonly game: ResultEvidence }
  | { readonly kind: 'TEST_GAME'; readonly game: ResultEvidence }
  | { readonly kind: 'BUILD'; readonly build: BuildCompletionEvidence }
) & { readonly native?: unknown };

/**
 * Compiler/runtime identity a build ran against. It is part of the build cache key (05 §64), so a
 * later game never runs source that a different toolchain produced.
 */
export interface BuildToolchain {
  readonly language: BotLanguage;
  /** OCI image or rootfs digest the compiler ran inside. */
  readonly imageDigest: Digest;
  /** Compiler/interpreter version as measured in the sandbox, not as configured. */
  readonly version: string;
  /** Flags the operator fixed for this language, in canonical order. */
  readonly flags: readonly string[];
}

/** The durable output a build produces; a GAME ships this instead of recompiling. */
export interface CompiledArtifact {
  /** Control-plane object key. A sandbox path is never accepted here. */
  readonly key: string;
  readonly digest: Digest;
  readonly sizeBytes: number;
  readonly entrypoint: string;
}

export type BuildStage = 'COMPILE' | 'INIT_SMOKE';

/**
 * Build evidence (03 §173). `SOURCE_REJECTED` is a *successful* job whose verdict belongs to the
 * student: it names the stage that failed and carries a bounded, sanitised diagnostic. An
 * infrastructure fault is never a rejection — it leaves the lease to retry or exhaust attempts.
 */
export type BuildCompletionEvidence =
  | {
      readonly outcome: 'READY';
      readonly stage: BuildStage;
      readonly toolchain: BuildToolchain;
      readonly manifestDigest: Digest;
      readonly artifact: CompiledArtifact;
      readonly diagnosticsRef?: string;
    }
  | {
      readonly outcome: 'SOURCE_REJECTED';
      readonly stage: BuildStage;
      readonly toolchain: BuildToolchain;
      readonly manifestDigest: Digest;
      readonly diagnostic: string;
      readonly diagnosticsRef?: string;
    }
  /**
   * The in-process (development) executor's gate verdict. It runs no sandbox, so it has no image
   * digest, no measured toolchain version and no compiled artifact to name — only the source it
   * accepted or rejected and the digest of the diagnostic text. Reporting an invented artifact or
   * toolchain here would make a development build indistinguishable from a certified one, so the
   * verdict is named for what it is. The sandboxed gateway never emits this variant.
   */
  | {
      readonly outcome: 'DEV_SOURCE_GATE';
      readonly accepted: boolean;
      readonly sourceDigest: Digest;
      readonly diagnosticDigest: Digest;
      readonly reason?: string;
    };

/**
 * A file the gateway pins for one attempt. The worker may read exactly this path and must verify
 * digest and size before use; it is a per-attempt spool copy, never an object-store path the sandbox
 * could enumerate. This exists because the gateway frames are capped at 1 MiB
 * (`ipc::MAX_FRAME_BYTES`) while a submission ZIP may legitimately be 2 MiB.
 */
export interface GrantedArtifact {
  readonly path: string;
  readonly digest: Digest;
  readonly sizeBytes: number;
}

/**
 * Assignment the trusted gateway hands the worker for a BUILD/TEST_BUILD job. The source travels as
 * a pinned grant — never as a path the worker may choose — and the limits are the ones the server
 * holds the evidence to.
 */
export interface BuildAssignment {
  readonly version: 1;
  readonly jobType: 'BUILD' | 'TEST_BUILD';
  readonly targetId: UUID;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly manifestDigest: Digest;
  /** Operator-declared toolchain; the worker must refuse a mismatch with its own profile. */
  readonly toolchain: BuildToolchain;
  readonly source: GrantedArtifact;
  readonly limits: {
    readonly compileWallMs: number;
    readonly initWallMs: number;
    readonly initCpuUsec: number;
  };
}

/** One side of a game, exactly as the gateway pinned it for this attempt. */
export interface GameBotAssignment {
  readonly side: 1 | 2;
  readonly sourceDigest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  /** Source ZIP, materialized by the worker. Interpreted languages run straight from it. */
  readonly source: GrantedArtifact;
  /** Compiled output for a compile language; absent when the language has no build step. */
  readonly artifact?: CompiledArtifactGrant;
}

export interface CompiledArtifactGrant extends GrantedArtifact {
  readonly entrypoint: string;
}

/** Assignment for an official or private game, built only from frozen/pinned artifacts. */
export interface GameAssignment {
  readonly version: 1;
  readonly jobType: 'GAME';
  readonly targetId: UUID;
  readonly gameId: UUID;
  readonly rulesRevision: string;
  readonly canonicalManifest: string;
  readonly manifestDigest: Digest;
  readonly runtimeProfileDigest: Digest;
  readonly maxTurns: number;
  readonly bots: readonly GameBotAssignment[];
}

/** Which bot a private test played, exactly as the control plane pinned it. */
export interface TestOpponentRef {
  readonly kind: 'OWN_SUBMISSION' | 'BASELINE';
  readonly label: string;
}

/**
 * Assignment for a private test (`test_snapshots` row). It is a real match with the same sandbox
 * and observation rules as a game — white is the team's snapshot bot, black the pinned opponent —
 * but its outcome is recorded on the snapshot only: no accepted result, no rating, no receipt
 * ordinal, no frozen candidate. Completion evidence has the game shape
 * (`{ manifestDigest, gameEvidence, observations }`); the opponent is the control plane's fact and
 * is never taken from the worker.
 */
export interface TestGameAssignment {
  readonly version: 1;
  readonly jobType: 'TEST_GAME';
  readonly targetId: UUID;
  readonly testId: UUID;
  readonly rulesRevision: string;
  readonly canonicalManifest: string;
  readonly manifestDigest: Digest;
  readonly runtimeProfileDigest: Digest;
  readonly maxTurns: number;
  readonly bots: readonly GameBotAssignment[];
  readonly opponent: TestOpponentRef;
}
