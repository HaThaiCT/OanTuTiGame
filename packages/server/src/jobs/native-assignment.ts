import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { MapDescriptor } from '@oantuti/engine';
import type {
  ActionTraceStep,
  BotLanguage,
  BuildAssignment,
  BuildCompletionEvidence,
  BuildStage,
  BuildToolchain,
  CompiledArtifact,
  Digest,
  GameAssignment,
  GameBotAssignment,
  GameResultEvidence,
  CompletionEvidence,
  GrantedArtifact,
  JobLease,
  LeaseIdentity,
  TestGameAssignment,
  TestOpponentRef,
} from '@oantuti/protocol';
import { statementRunner, type Database } from '../persistence/db.js';
import { computeCanonicalManifest, parseAndValidateZip, type ArtifactStore } from '../submissions/artifact-store.js';
import type { ResultService } from '../results/service.js';
import type { TournamentSchedulerService } from '../tournaments/scheduler-service.js';
import { compiledArtifactKey, LANGUAGES, MAX_COMPILED_BYTES, sha256Hex, type CompiledArtifactStore } from '../builds/compiled-artifact-store.js';
import {
  claimPrivateTestSnapshot,
  releasePrivateTestSnapshot,
  type PrivateTestResultService,
} from '../builds/private-test-result-service.js';
import {
  DEFAULT_BASELINE_BOT,
  loadLatestReadySubmission,
  resolvePrivateTestMap,
  type PrivateTestMapRef,
} from '../builds/private-test-runner.js';
import type { AuthenticatedNativeExecution, NativeExecutionObservation } from './local-transport.js';
import { authenticateNativeExecution } from './local-transport.js';
import type { NativeLiveProjector } from '../live/native-live-projector.js';
import type { ResultReceipt } from '@oantuti/protocol';
import { ResultAlreadyAcceptedError } from '../results/service.js';
import { JobBrokerError, type JobBroker } from './broker.js';

/**
 * Native gateway assignment and acceptance.
 *
 * Three families of work arrive on the same channel:
 *
 *   GAME          official games a supervisor runs from frozen artifacts. Python/TypeScript run
 *                 from the granted source ZIP; C++ runs the artifact its build produced, because no
 *                 compiler ever runs at match time.
 *   TEST_GAME     one private test: the same kind of match, pinned the same way, but its outcome is
 *                 recorded on the `test_snapshots` row instead of as an official result. The map,
 *                 the opponent and the snapshot are control-plane facts; the worker only reports
 *                 what it observed.
 *   BUILD/TEST_BUILD  the compile + INIT-smoke gate for one receipt or private-test snapshot.
 *
 * For every family the gateway writes the exact pinned bytes into a fresh per-attempt spool
 * directory it owns (0700 directory, 0600 files, atomic write + fsync) and hands the worker *path
 * grants* instead of bytes (gateway frames are capped at 1 MiB). A worker-supplied path is never
 * trusted: acceptance only ever reads paths this service chose, and a compiled artifact comes back
 * as verified bytes over `stageArtifact`, never as a path.
 *
 * Lifecycle of an attempt spool: created at claim, deleted when its completion is accepted or its
 * assignment is abandoned (lease STOP, expiry, or a process restart that dropped the assignment).
 */

/** Build budgets the operator fixed; the server holds the worker's evidence to exactly these. */
export const BUILD_LIMITS = Object.freeze({ compileWallMs: 30_000, initWallMs: 5_000, initCpuUsec: 500_000 });

/** Longest SOURCE_REJECTED diagnostic persisted; a longer one is truncated, an empty one refused. */
export const MAX_BUILD_DIAGNOSTIC_CHARS = 2_048;

/** Largest artifact chunk accepted per `stageArtifact` frame. */
export const MAX_ARTIFACT_CHUNK_BYTES = 512 * 1024;

const MAX_GAME_TURNS = 300;
/**
 * Priority of the private-test execution job a TEST_BUILD READY enqueues (03-ARCHITECTURE §174:
 * exactly one TEST_GAME, in the same acceptance). Below GAME's 100, so practice never delays a
 * round; the same value the dev worker's handoff uses.
 */
export const TEST_GAME_JOB_PRIORITY = 50;
/** Language of the repo baseline bot a private test plays when its team has no READY receipt. */
const BASELINE_BOT_LANGUAGE: BotLanguage = 'TYPESCRIPT';
/** Anything past this is not a diagnostic but an abusive frame. */
const MAX_DIAGNOSTIC_INPUT_CHARS = MAX_BUILD_DIAGNOSTIC_CHARS * 8;
const ARTIFACT_ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Languages whose match-time input is compiled output, not source plus a compiler. */
const COMPILE_LANGUAGES: readonly BotLanguage[] = ['CPP'];

type BuildTargetKind = 'BUILD' | 'TEST_BUILD';

interface BuildTargetSpec {
  /** Literal identifiers only, so they are safe to interpolate into SQL. */
  readonly table: 'submissions' | 'test_snapshots';
  readonly resourceType: 'SUBMISSION' | 'TEST_SNAPSHOT';
  /**
   * States a build may run from. Published verdicts are included on purpose: a job whose verdict
   * was written but whose completion was never pinned must be able to drain, and an operator may
   * deliberately requeue a rebuild. Only a state where building is meaningless (a private test that
   * is already executing) is refused, so the gateway never leases work it cannot assign.
   */
  readonly buildable: readonly string[];
  /** States this path moves to COMPILING; a row already in SMOKE_TESTING is left alone. */
  readonly startable: readonly string[];
  readonly ready: string;
  readonly rejected: string;
}

/** Everything that differs between the two build queues. */
const BUILD_TARGETS: Record<BuildTargetKind, BuildTargetSpec> = {
  BUILD: {
    table: 'submissions',
    resourceType: 'SUBMISSION',
    buildable: ['VALIDATING', 'QUEUED', 'COMPILING', 'SMOKE_TESTING', 'READY', 'REJECTED'],
    startable: ['VALIDATING', 'QUEUED', 'COMPILING'],
    ready: 'READY',
    rejected: 'REJECTED',
  },
  TEST_BUILD: {
    table: 'test_snapshots',
    resourceType: 'TEST_SNAPSHOT',
    buildable: ['QUEUED', 'COMPILING', 'SMOKE_TESTING', 'COMPLETED', 'FAILED'],
    startable: ['QUEUED', 'COMPILING'],
    ready: 'COMPLETED',
    rejected: 'FAILED',
  },
};

export interface NativeAssignmentOptions {
  /** Operator runtime profile this gateway certifies; part of every assignment. */
  readonly runtimeProfileDigest: Digest;
  /** Parent of the per-attempt spool directories this gateway creates, owns and deletes. */
  readonly spoolRoot: string;
  /** Operator-declared toolchain identity, one entry per supported language. */
  readonly toolchains: readonly BuildToolchain[];
  /** Durable store a READY build lands in and a C++ game resolves from. */
  readonly compiledArtifacts: CompiledArtifactStore;
  /**
   * Repo baseline bot pinned as the opponent of a private test whose team has no READY receipt for
   * the tournament. Defaults to the same `bots/greedy-bot.ts` the dev runner plays.
   */
  readonly baselineBotPath?: string;
  readonly liveProjector?: NativeLiveProjector;
  readonly completionRoot?: string;
}

/**
 * What an official game and a private test have in common once their assignment is handed out: the
 * identity a completion is validated against and the board the trace is re-proven on.
 */
interface GameRunRecord {
  readonly jobType: 'GAME' | 'TEST_GAME';
  /** The official game id, or — for a TEST_GAME — the private-test snapshot id. */
  readonly gameId: string;
  readonly rulesRevision: string;
  readonly map: MapDescriptor;
  readonly manifestDigest: string;
}

interface GameAssignmentRecord extends GameRunRecord {
  readonly kind: 'GAME';
  readonly jobType: 'GAME';
  readonly lease: LeaseIdentity;
  leaseExpiresAt: number;
  readonly attemptDirectory: string;
  readonly payload: GameAssignment;
}

interface TestGameAssignmentRecord extends GameRunRecord {
  readonly kind: 'TEST_GAME';
  readonly jobType: 'TEST_GAME';
  readonly lease: LeaseIdentity;
  leaseExpiresAt: number;
  readonly attemptDirectory: string;
  /** The snapshot this attempt claimed; equals {@link GameRunRecord.gameId}. */
  readonly testId: string;
  /** Where the pinned board came from, recorded in `result_payload.map`. */
  readonly mapRef: PrivateTestMapRef;
  /** The opponent the assignment pinned, recorded in `result_payload.opponent`. */
  readonly opponent: TestOpponentRef;
  readonly payload: TestGameAssignment;
}

interface StagedArtifact {
  readonly digest: Digest;
  readonly sizeBytes: number;
  readonly entrypoint: string;
  readonly path: string;
  received: number;
  complete: boolean;
}

interface BuildAssignmentRecord {
  readonly kind: 'BUILD';
  readonly jobType: BuildTargetKind;
  readonly lease: LeaseIdentity;
  leaseExpiresAt: number;
  readonly attemptDirectory: string;
  readonly targetId: string;
  readonly assignment: BuildAssignment;
  staged?: StagedArtifact;
}

type AssignmentRecord = GameAssignmentRecord | TestGameAssignmentRecord | BuildAssignmentRecord;

/** A game completion the gateway has validated against the assignment it handed out. */
export interface ValidatedNativeResult {
  readonly jobType: 'GAME' | 'TEST_GAME';
  /** The game id, or — for a TEST_GAME — the private-test snapshot id. */
  readonly gameId: string;
  readonly attemptId: string;
  readonly manifestDigest: string;
  readonly actionTraceDigest: string;
  readonly mapDescriptor: MapDescriptor;
  readonly evidence: GameResultEvidence;
  readonly observations: readonly NativeExecutionObservation[];
}

/** A build completion the gateway has validated against the assignment it handed out. */
interface ValidatedBuildBase {
  readonly jobType: BuildTargetKind;
  readonly targetId: string;
  readonly attemptId: string;
  readonly stage: BuildStage;
  readonly toolchain: BuildToolchain;
  readonly manifestDigest: Digest;
  readonly diagnosticsRef?: string;
}

/**
 * A validated build verdict. READY carries the artifact and its verified bytes; SOURCE_REJECTED
 * carries the sanitised, bounded cause. The union makes "a rejection has no artifact" and "a READY
 * build always has one" type facts instead of conventions.
 */
export type ValidatedBuildResult =
  | (ValidatedBuildBase & {
      readonly outcome: 'READY';
      readonly artifact: CompiledArtifact;
      readonly artifactBytes: Buffer;
    })
  | (ValidatedBuildBase & {
      readonly outcome: 'SOURCE_REJECTED';
      readonly diagnostic: string;
    });

export interface StagedArtifactState {
  readonly staged: boolean;
  readonly received: number;
  readonly digest?: Digest;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobBrokerError('INVALID_EVIDENCE', 'Expected object');
  return value as Record<string, unknown>;
}

function uint(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new JobBrokerError('INVALID_EVIDENCE', 'Expected unsigned integer');
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid resource counter');
  return value;
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobBrokerError('INVALID_REQUEST', 'Expected object');
  return value as Record<string, unknown>;
}

function requestUint(value: unknown, what: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new JobBrokerError('INVALID_REQUEST', `Invalid ${what}`);
  return value;
}

function sha256Bytes(bytes: Buffer | string): Digest {
  return createHash('sha256').update(bytes).digest('hex');
}

function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** Parses a toolchain identity; `undefined` means the shape is not one this gateway declares. */
function parseToolchain(value: unknown): BuildToolchain | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const toolchain = value as Record<string, unknown>;
  if (typeof toolchain.language !== 'string' || !LANGUAGES.includes(toolchain.language as BotLanguage)) return undefined;
  if (!isDigest(toolchain.imageDigest)) return undefined;
  if (typeof toolchain.version !== 'string' || toolchain.version.length === 0 || toolchain.version.length > 128) return undefined;
  if (!Array.isArray(toolchain.flags) || toolchain.flags.length > 32) return undefined;
  if (toolchain.flags.some((flag) => typeof flag !== 'string' || flag.length > 128)) return undefined;
  return {
    language: toolchain.language as BotLanguage,
    imageDigest: toolchain.imageDigest,
    version: toolchain.version,
    // Flag order is part of the toolchain identity, so it is copied, never sorted.
    flags: [...toolchain.flags] as string[],
  };
}

function sameToolchain(left: BuildToolchain, right: BuildToolchain): boolean {
  return (
    left.language === right.language &&
    left.imageDigest === right.imageDigest &&
    left.version === right.version &&
    left.flags.length === right.flags.length &&
    left.flags.every((flag, index) => flag === right.flags[index])
  );
}

/**
 * Sanitises the rejection diagnostic: control characters that would corrupt a log are dropped, an
 * empty one is refused (a rejection must say why) and an over-long one is truncated rather than
 * refused, because losing a legitimate verdict to log volume would strand the student's build.
 */
function sanitiseDiagnostic(value: unknown): string {
  if (typeof value !== 'string') throw new JobBrokerError('INVALID_EVIDENCE', 'Diagnostic must be a string');
  if (value.length > MAX_DIAGNOSTIC_INPUT_CHARS) throw new JobBrokerError('INVALID_EVIDENCE', 'Diagnostic exceeds its bound');
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) throw new JobBrokerError('INVALID_EVIDENCE', 'Diagnostic must not be empty');
  return cleaned.length > MAX_BUILD_DIAGNOSTIC_CHARS ? `${cleaned.slice(0, MAX_BUILD_DIAGNOSTIC_CHARS)}…` : cleaned;
}

function decodeChunk(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * MAX_ARTIFACT_CHUNK_BYTES) {
    throw new JobBrokerError('INVALID_REQUEST', 'Invalid artifact chunk encoding');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new JobBrokerError('INVALID_REQUEST', 'Invalid artifact chunk encoding');
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_CHUNK_BYTES) throw new JobBrokerError('INVALID_REQUEST', 'Artifact chunk is out of range');
  return bytes;
}

function syncDirectory(directory: string): Promise<void> {
  return open(directory, 'r').then(async (handle) => {
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/**
 * Creates the per-attempt spool directory. It must not exist: an attempt that reused a previous
 * attempt's directory could be handed bytes it did not pin, so reuse is an error, not a merge.
 */
async function createAttemptDirectory(spoolRoot: string, attemptId: string): Promise<string> {
  const directory = path.join(spoolRoot, attemptId);
  try {
    await mkdir(spoolRoot, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    throw new JobBrokerError('SPOOL_UNAVAILABLE', `Cannot create attempt spool: ${error instanceof Error ? error.message : String(error)}`);
  }
  return directory;
}

/** Writes one pinned file into an attempt spool, atomically and durably, and describes it. */
async function writeGrant(directory: string, name: string, bytes: Buffer): Promise<GrantedArtifact> {
  const target = path.join(directory, name);
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw new JobBrokerError('SPOOL_UNAVAILABLE', `Cannot write pinned grant: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: target, digest: sha256Bytes(bytes), sizeBytes: bytes.length };
}

/**
 * The canonical manifest an official game and a private test are both pinned by: the board, the
 * starting pieces and the ply limit, keyed by the id the engine session binds to — the game id, or
 * the private-test snapshot id — and by the attempt that will play it.
 */
function canonicalGameManifest(gameId: string, attemptId: string, map: MapDescriptor, maxPly: number): string {
  return JSON.stringify({ gameId, attemptId,
    map: { name: map.mapName, width: map.width, height: map.height, validTiles: map.validTiles, whiteThrone: map.whiteThrone, blackThrone: map.blackThrone },
    pieces: map.startingPieces.map((piece) => ({ id: piece.id, owner: piece.owner, type: piece.type, x: piece.pos[0], y: piece.pos[1], alive: true })), maxPly });
}

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry stores; built once, as the worker does per call. */
const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Packages files into a store-only ZIP, the shape a submission's source travels in.
 *
 * A granted bot source is materialized by the worker through the intake's own ZIP rules, so the
 * repository baseline has to be packaged before it can be pinned as a grant. Entries are written in
 * the declared order as 0600 regular files, and the timestamp is the ZIP epoch, so the bytes — and
 * therefore their digest — are a pure function of the content.
 */
function storeZip(files: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // Version needed to extract.
    local.writeUInt16LE(0, 6); // Flags: the sizes and the checksum are in the headers.
    local.writeUInt16LE(0, 8); // Method 0: stored.
    local.writeUInt16LE(0, 10); // Modification time.
    local.writeUInt16LE(0x0021, 12); // Modification date: 1980-01-01.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, file.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20 | (3 << 8), 4); // Made by UNIX (3), version 2.0.
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x0021, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(file.data.length, 20);
    header.writeUInt32LE(file.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // External attributes: a regular file (never a symlink) with mode 0600.
    header.writeUInt32LE(0o100600 * 0x10000, 38);
    header.writeUInt32LE(offset, 42);
    directory.push(header, name);
    offset += 30 + name.length + file.data.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/** Only the native gateway uses this service: no request-supplied map/artifact/launcher authority. */
export class NativeAssignmentService {
  private readonly assignments = new Map<string, AssignmentRecord>();
  private readonly baselineBotPath: string;

  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactStore,
    private readonly results: ResultService,
    private readonly scheduler: TournamentSchedulerService,
    /** Durable queue: a TEST_BUILD READY enqueues its follow-up TEST_GAME here, in this process. */
    private readonly broker: JobBroker,
    /** The private-test row transitions and its verified recording (TEST_GAME). */
    private readonly privateTests: PrivateTestResultService,
    private readonly options: NativeAssignmentOptions
  ) {
    this.baselineBotPath = options.baselineBotPath ?? path.resolve(process.cwd(), DEFAULT_BASELINE_BOT);
    this.broker.registerCompletionConsumer((evidence, lease, client) => this.consume(evidence, lease, client));
    this.results.setAcceptanceFence((client) => this.broker.assertAcceptanceFence(client));
    this.privateTests.setAcceptanceFence((client) => this.broker.assertAcceptanceFence(client));
    this.broker.registerCompletionPublication(async (receipt) => {
      if (receipt.data.kind !== 'GAME' || !receipt.data.targetId) return;
      const result = await this.results.getAcceptedResultSummary(receipt.data.targetId);
      if (result) this.options.liveProjector?.accepted(receipt.data.targetId, { winner: result.evidence.winner === 1 || result.evidence.winner === 2 ? result.evidence.winner : null, reason: result.evidence.reason });
    });
    if (!isDigest(options.runtimeProfileDigest)) throw new Error('Runtime profile digest must be a SHA-256 hex string');
    if (!path.isAbsolute(options.spoolRoot)) throw new Error('Native spool root must be an absolute path');
    const seen = new Set<BotLanguage>();
    for (const toolchain of options.toolchains) {
      if (parseToolchain(toolchain) === undefined) throw new Error('Toolchain profile entry is not a valid toolchain identity');
      if (seen.has(toolchain.language)) throw new Error(`Duplicate toolchain profile entry for ${toolchain.language}`);
      seen.add(toolchain.language);
    }
    for (const language of LANGUAGES) {
      if (!seen.has(language)) throw new Error(`Runtime profile has no ${language} toolchain`);
    }
  }

  /**
   * Claims a spool root: creates it, refuses one other identities could write, and deletes attempt
   * directories left by a previous process. A restart drops assignment authority, so every
   * directory that is still there belongs to an attempt that can never be accepted or abandoned.
   */
  async start(): Promise<void> {
    await mkdir(this.options.spoolRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.spoolRoot);
    if (!info.isDirectory() || (info.mode & 0o002) !== 0) throw new Error('Native spool root must be a directory that is not world-writable');
    for (const entry of await readdir(this.options.spoolRoot)) {
      if (!UUID_PATTERN.test(entry)) continue;
      await rm(path.join(this.options.spoolRoot, entry), { recursive: true, force: true });
    }
  }

  /** Builds the immutable assignment for one claim, pinning every input it names. */
  async prepare(lease: JobLease): Promise<unknown> {
    await this.sweepAbandoned();
    if (lease.jobType === 'BUILD' || lease.jobType === 'TEST_BUILD') return this.prepareBuild(lease);
    if (lease.jobType === 'GAME') return this.prepareGame(lease);
    if (lease.jobType === 'TEST_GAME') return this.prepareTestGame(lease);
    throw new JobBrokerError('JOB_TYPE_UNSUPPORTED', `${lease.jobType} has no native assignment builder`);
  }

  /**
   * Accepts one chunk of a build's compiled output. The bytes come from the worker, but the path
   * never does: they land in this attempt's own spool and are only trusted after the whole file
   * hashes to the digest the worker declared when it started staging.
   */
  async stage(lease: LeaseIdentity, value: unknown): Promise<StagedArtifactState> {
    const assignment = this.requireAssignment(lease);
    if (assignment.kind !== 'BUILD') {
      throw new JobBrokerError('INVALID_REQUEST', 'This assignment stages no artifact');
    }
    const input = requestRecord(value);
    const offset = requestUint(input.offset, 'offset', MAX_COMPILED_BYTES);
    const sizeBytes = requestUint(input.sizeBytes, 'size', MAX_COMPILED_BYTES);
    if (sizeBytes === 0) throw new JobBrokerError('INVALID_REQUEST', 'Artifact size must be positive');
    if (!isDigest(input.digest)) throw new JobBrokerError('INVALID_REQUEST', 'Invalid artifact digest');
    const entrypoint = input.entrypoint;
    if (typeof entrypoint !== 'string' || !ARTIFACT_ENTRYPOINT.test(entrypoint)) throw new JobBrokerError('INVALID_REQUEST', 'Invalid artifact entrypoint');
    const data = decodeChunk(input.data);
    if (offset + data.length > sizeBytes) throw new JobBrokerError('INVALID_REQUEST', 'Artifact chunk exceeds the declared size');

    let staged = assignment.staged;
    if (staged === undefined) {
      staged = { digest: input.digest, sizeBytes, entrypoint, path: path.join(assignment.attemptDirectory, 'artifact.bin'), received: 0, complete: false };
      assignment.staged = staged;
    } else if (staged.digest !== input.digest || staged.sizeBytes !== sizeBytes || staged.entrypoint !== entrypoint) {
      throw new JobBrokerError('INVALID_REQUEST', 'Artifact chunks disagree about the artifact');
    }
    if (staged.complete) {
      // A retried frame for an artifact that is already complete is answered with the same result
      // instead of an error: only a chunk that claims to add bytes is refused.
      if (offset + data.length <= staged.received) return { staged: true, received: staged.received, digest: staged.digest };
      throw new JobBrokerError('INVALID_REQUEST', 'Artifact is already staged');
    }
    // A retried chunk that is already durable is ignored; a gap or partial overlap is not.
    if (offset + data.length <= staged.received) return { staged: false, received: staged.received };
    if (offset !== staged.received) throw new JobBrokerError('INVALID_REQUEST', 'Artifact chunk does not continue what is staged');

    try {
      const handle = await open(staged.path, staged.received === 0 ? 'wx' : 'a', 0o600);
      try {
        await handle.write(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      throw new JobBrokerError('SPOOL_UNAVAILABLE', `Cannot stage artifact: ${error instanceof Error ? error.message : String(error)}`);
    }
    staged.received += data.length;

    if (staged.received === staged.sizeBytes) {
      const bytes = await readFile(staged.path).catch(() => undefined);
      if (!bytes || bytes.length !== staged.sizeBytes || sha256Bytes(bytes) !== staged.digest) {
        await rm(staged.path, { force: true });
        assignment.staged = undefined;
        throw new JobBrokerError('ARTIFACT_DIGEST_MISMATCH', 'Staged artifact bytes do not match their digest');
      }
      staged.complete = true;
    }
    return staged.complete ? { staged: true, received: staged.received, digest: staged.digest } : { staged: false, received: staged.received };
  }

  /** Validates a completion against the assignment this gateway handed out for that attempt. */
  async validate(lease: LeaseIdentity, value: unknown): Promise<ValidatedNativeResult | ValidatedBuildResult> {
    const assignment = this.requireAssignment(lease);
    if (assignment.kind === 'BUILD') return this.validateBuild(assignment, lease, value);
    // A private test's evidence is held to exactly the game bar; only the recording differs.
    return this.validateGameRun(assignment, lease, value);
  }

  liveTurn(lease: LeaseIdentity, value: unknown): void {
    if (this.requireAssignment(lease).kind !== 'GAME') throw new JobBrokerError('INVALID_REQUEST', 'Only official games publish live turns');
    this.options.liveProjector?.turn(lease, value);
  }

  async materialize(lease: LeaseIdentity, validated: ValidatedNativeResult | ValidatedBuildResult, requestDigest?: string): Promise<CompletionEvidence> {
    const assignment = this.requireAssignment(lease);
    if ('evidence' in validated) {
      const execution = authenticateNativeExecution(lease, validated, this.options.runtimeProfileDigest, assignment.kind === 'BUILD' ? undefined : assignment.payload);
      await this.results.validateNativeEvidence({ gameId: validated.gameId, attemptId: validated.attemptId, evidence: validated.evidence, manifestDigest: validated.manifestDigest, mapDescriptor: validated.mapDescriptor, maxTurns: MAX_GAME_TURNS, nativeExecution: execution });
    }
    const directory = this.options.completionRoot ?? path.join(this.options.spoolRoot, 'completions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(this.options.spoolRoot);
    const objects: GrantedArtifact[] = [];
    const copyGrant = async (grant: GrantedArtifact): Promise<void> => {
      const bytes = await readFile(grant.path);
      if (bytes.length !== grant.sizeBytes || sha256Bytes(bytes) !== grant.digest) throw new JobBrokerError('ARTIFACT_DIGEST_MISMATCH', 'Assignment object changed before pin');
      objects.push(await writeGrant(directory, `${grant.digest}.object`, bytes));
    };
    if (assignment.kind === 'BUILD') await copyGrant(assignment.assignment.source);
    else for (const bot of assignment.payload.bots) { await copyGrant(bot.source); if (bot.artifact) await copyGrant(bot.artifact); }
    let artifactRef: GrantedArtifact | undefined;
    let serializable: unknown = validated;
    if ('artifactBytes' in validated) {
      artifactRef = await writeGrant(directory, `${validated.artifact.digest}.object`, validated.artifactBytes);
      const { artifactBytes: _bytes, ...metadata } = validated;
      serializable = metadata;
    }
    const capsule = Buffer.from(JSON.stringify({ version: 1, lease, assignment, validated: serializable, artifactRef, objects, runtimeProfileDigest: this.options.runtimeProfileDigest }));
    const capsuleDigest = sha256Bytes(capsule);
    await writeGrant(directory, `${capsuleDigest}.json`, capsule);
    const native = { version: 1, capsuleDigest, requestDigest };
    if ('evidence' in validated) return { kind: validated.jobType, native, game: { verdict: validated.evidence.disposition, winner: validated.evidence.winner, reason: validated.evidence.reason, actionTraceDigest: validated.actionTraceDigest, replayDigest: capsuleDigest, manifestDigest: validated.manifestDigest, cpuUsec: validated.evidence.cpuUsec ?? '0', wallUsec: validated.evidence.wallUsec ?? '0' } };
    const build: BuildCompletionEvidence = validated.outcome === 'READY'
      ? { outcome: 'READY', stage: validated.stage, toolchain: validated.toolchain, manifestDigest: validated.manifestDigest, artifact: validated.artifact }
      : { outcome: 'SOURCE_REJECTED', stage: validated.stage, toolchain: validated.toolchain, manifestDigest: validated.manifestDigest, diagnostic: validated.diagnostic };
    return { kind: 'BUILD', build, native };
  }

  completionPinned(lease: LeaseIdentity): void { this.options.liveProjector?.previewEnd(lease); }

  private async consume(evidence: CompletionEvidence, lease: LeaseIdentity, client: pg.PoolClient): Promise<ResultReceipt['data']> {
    const reference = record(evidence.native);
    if (reference.version !== 1 || !isDigest(reference.capsuleDigest)) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Invalid completion capsule reference');
    const directory = this.options.completionRoot ?? path.join(this.options.spoolRoot, 'completions');
    const bytes = await readFile(path.join(directory, `${reference.capsuleDigest}.json`));
    if (sha256Bytes(bytes) !== reference.capsuleDigest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Completion capsule digest mismatch');
    const capsule = JSON.parse(bytes.toString('utf8')) as { lease: LeaseIdentity; assignment: AssignmentRecord; validated: ValidatedNativeResult | ValidatedBuildResult; artifactRef?: GrantedArtifact; objects: GrantedArtifact[]; runtimeProfileDigest: string };
    if (capsule.lease.jobId !== lease.jobId || capsule.lease.attemptId !== lease.attemptId || capsule.lease.grantId !== lease.grantId || capsule.lease.fencingToken !== lease.fencingToken || capsule.lease.deploymentGeneration !== lease.deploymentGeneration || capsule.runtimeProfileDigest !== this.options.runtimeProfileDigest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Completion provenance mismatch');
    for (const ref of [...capsule.objects, ...(capsule.artifactRef ? [capsule.artifactRef] : [])]) {
      if (!isDigest(ref.digest)) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Invalid object digest');
      const objectBytes = await readFile(path.join(directory, `${ref.digest}.object`));
      if (objectBytes.length !== ref.sizeBytes || sha256Bytes(objectBytes) !== ref.digest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Completion object digest mismatch');
    }
    const input = capsule.validated;
    const assignment = capsule.assignment;
    if (assignment.lease.jobId !== lease.jobId || assignment.lease.attemptId !== lease.attemptId || assignment.lease.grantId !== lease.grantId || assignment.lease.fencingToken !== lease.fencingToken || assignment.lease.deploymentGeneration !== lease.deploymentGeneration || input.attemptId !== lease.attemptId) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Assignment provenance mismatch');
    if (assignment.kind !== 'BUILD') {
      if (input.jobType !== assignment.jobType || input.manifestDigest !== assignment.payload.manifestDigest || sha256Bytes(assignment.payload.canonicalManifest) !== input.manifestDigest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Assignment manifest mismatch');
    } else if (input.jobType !== assignment.jobType || input.manifestDigest !== assignment.assignment.manifestDigest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Build manifest mismatch');
    this.assignments.set(lease.attemptId, capsule.assignment);
    if ('outcome' in input) {
      if (input.outcome === 'READY') {
        if (!capsule.artifactRef || capsule.artifactRef.digest !== input.artifact.digest) throw new JobBrokerError('EVIDENCE_CORRUPT', 'Compiled evidence missing');
        Object.assign(input, { artifactBytes: await readFile(path.join(directory, `${capsule.artifactRef.digest}.object`)) });
      }
      await this.acceptBuild(input, client);
      return { kind: 'BUILD', targetId: input.targetId, state: 'ACCEPTED' };
    }
    const nativeExecution = authenticateNativeExecution(lease, input, capsule.runtimeProfileDigest, capsule.assignment.kind === 'BUILD' ? undefined : capsule.assignment.payload);
    if (input.jobType === 'TEST_GAME') {
      await this.acceptPrivateTest(input, nativeExecution, client);
      return { kind: 'TEST_GAME', targetId: input.gameId, state: 'ACCEPTED' };
    }
    try { await this.accept(input, nativeExecution, client); }
    catch (error) { if (!(error instanceof ResultAlreadyAcceptedError)) throw error; await this.scheduler.handleGameCompletion(input.gameId, client); }
    const accepted = await this.results.getAcceptedResultSummary(input.gameId, client);
    if (!accepted) throw new JobBrokerError('ACCEPTED_RESULT_MISSING', 'Accepted result missing after consumption');
    return { kind: 'GAME', targetId: input.gameId, resultVersionId: accepted.resultVersionId, state: 'ACCEPTED' };
  }

  /**
   * Records a validated game result through the same service the development executor uses. The
   * optional client is the pinned completion transaction, so acceptance, progression and the
   * terminal job bookkeeping commit together and a crash cannot separate them.
   */
  async accept(input: ValidatedNativeResult, nativeExecution: AuthenticatedNativeExecution, client?: pg.PoolClient): Promise<CompletionEvidence> {
    await this.results.recordResult({ gameId: input.gameId, attemptId: input.attemptId, evidence: input.evidence, manifestDigest: input.manifestDigest, mapDescriptor: input.mapDescriptor, maxTurns: MAX_GAME_TURNS, nativeExecution, client });
    await this.scheduler.handleGameCompletion(input.gameId, client);
    const accepted = await this.results.getAcceptedResultSummary(input.gameId, client);
    if (!accepted) throw new JobBrokerError('ACCEPTED_RESULT_MISSING', 'Result acceptance missing');
    await this.release(input.attemptId, client);
    return { kind: 'GAME', game: accepted.evidence };
  }

  /**
   * Records a validated private test: the match is re-proven against the board this gateway pinned
   * and lands on the snapshot row only — no accepted result, no rating, no receipt ordinal, no
   * frozen candidate. The opponent and the map come from the assignment, never from the worker.
   */
  async acceptPrivateTest(input: ValidatedNativeResult, nativeExecution: AuthenticatedNativeExecution, client?: pg.PoolClient): Promise<CompletionEvidence> {
    const assignment = this.assignments.get(input.attemptId);
    if (!assignment || assignment.kind !== 'TEST_GAME' || assignment.gameId !== input.gameId) {
      throw new JobBrokerError('ASSIGNMENT_MISSING', 'No matching private-test assignment');
    }
    // Inside a pinned completion transaction the read must use that same session: a second pooled
    // connection would hold a second slot and can contend with the row this transaction touches.
    const existing = await statementRunner(client ?? this.db)<{ replay_digest: string }>(`SELECT replay_digest FROM test_snapshots WHERE id=$1 AND result_payload IS NOT NULL AND status='COMPLETED'`, [assignment.testId]);
    if (existing.rows[0]) {
      await this.release(input.attemptId, client);
      return { kind: 'TEST_GAME', game: { verdict: input.evidence.disposition, reason: input.evidence.reason, actionTraceDigest: input.actionTraceDigest, replayDigest: existing.rows[0].replay_digest, manifestDigest: input.manifestDigest, cpuUsec: input.evidence.cpuUsec ?? '0', wallUsec: input.evidence.wallUsec ?? '0' } };
    }
    const recorded = await this.privateTests.recordVerified({
      testId: assignment.testId,
      attemptId: input.attemptId,
      manifestDigest: input.manifestDigest,
      rulesRevision: assignment.rulesRevision,
      mapDescriptor: input.mapDescriptor,
      map: assignment.mapRef,
      opponent: assignment.opponent,
      maxTurns: MAX_GAME_TURNS,
      evidence: input.evidence,
      nativeExecution,
      ...(client === undefined ? {} : { client }),
    });
    await this.release(input.attemptId, client);
    return { kind: 'TEST_GAME', game: recorded.evidence };
  }

  /**
   * Accepts a validated build: the compiled artifact is made durable *before* the DB transition,
   * then the receipt/snapshot moves in one transaction. A SOURCE_REJECTED is a completed job — the
   * verdict belongs to the student — while any infrastructure fault thrown here leaves the lease to
   * expire and retry, never a rejection.
   */
  async acceptBuild(input: ValidatedBuildResult, client?: pg.PoolClient): Promise<CompletionEvidence> {
    if (client) return this.acceptBuildOn(client, input);
    return this.db.withTransaction(async (own) => {
      await this.broker.assertAcceptanceFence(own);
      await own.query('SELECT pg_advisory_xact_lock_shared(1868657748, 26)');
      return this.acceptBuildOn(own, input);
    });
  }

  /** The acceptance itself, on a client whose transaction and backup barrier the caller already holds. */
  private async acceptBuildOn(client: pg.PoolClient, input: ValidatedBuildResult): Promise<CompletionEvidence> {
    const assignment = this.assignments.get(input.attemptId);
    if (!assignment || assignment.kind !== 'BUILD' || assignment.targetId !== input.targetId) {
      throw new JobBrokerError('ASSIGNMENT_MISSING', 'No matching build assignment');
    }
    const target = BUILD_TARGETS[assignment.jobType];
    const status = input.outcome === 'READY' ? target.ready : target.rejected;

    if (input.outcome === 'READY') {
      await this.options.compiledArtifacts.promote({
        key: input.artifact.key,
        bytes: input.artifactBytes,
        entrypoint: input.artifact.entrypoint,
        language: assignment.assignment.language,
        sourceDigest: assignment.assignment.manifestDigest,
        toolchain: input.toolchain,
      });
    }
    const updated = await client.query<{ status: string }>(
      `UPDATE ${target.table}
       SET status = $2, build_error = $3, built_at = clock_timestamp()
       WHERE id = $1 AND status IN ('COMPILING', 'SMOKE_TESTING')
       RETURNING status`,
      [input.targetId, status, input.outcome === 'SOURCE_REJECTED' ? input.diagnostic : null]
    );
    if (updated.rows.length === 0) {
      const current = await client.query<{ status: string }>(`SELECT status FROM ${target.table} WHERE id = $1`, [input.targetId]);
      const row = current.rows[0];
      if (!row) throw new JobBrokerError('BUILD_TARGET_NOT_FOUND', 'Build target disappeared before acceptance');
      // A replay of an already-published verdict is not a fault: the artifact is durable, the
      // verdict is recorded, and refusing here would strand the job in COMPLETION_PENDING.
      if (row.status !== status) throw new JobBrokerError('BUILD_STATE_CONFLICT', `Build target is ${row.status}, not a buildable state`);
      // The verdict was already published; the retry still owns this attempt's spool.
      await this.release(input.attemptId, client);
      return this.buildEvidence(input);
    }
    await client.query(
      `INSERT INTO audit_events (action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4)`,
      [
        input.outcome === 'READY' ? 'BUILD_ACCEPTED' : 'BUILD_REJECTED',
        target.resourceType,
        input.targetId,
        JSON.stringify(
          input.outcome === 'READY'
            ? { status, language: assignment.assignment.language, outcome: input.outcome, stage: input.stage, artifactDigest: input.artifact.digest }
            : { status, language: assignment.assignment.language, outcome: input.outcome, stage: input.stage, reason: input.diagnostic, diagnosticDigest: sha256Bytes(input.diagnostic) }
        ),
      ]
    );

    // The control plane owns the handoff: an accepted private-test build enqueues its execution job
    // itself (03 §174), in the very transaction that published the verdict, so a crash cannot lose
    // the handoff and a replayed verdict cannot buy a second practice run.
    if (input.outcome === 'READY' && assignment.jobType === 'TEST_BUILD') {
      await this.broker.enqueueInTransaction(client, 'TEST_GAME', input.targetId, TEST_GAME_JOB_PRIORITY, {});
    }

    await this.release(input.attemptId, client);
    return this.buildEvidence(input);
  }

  /**
   * A build pins its own evidence shape (03 §173): outcome, stage, toolchain, manifest and either
   * the artifact it produced or the diagnostic that rejected the source — never a game verdict.
   */
  private buildEvidence(input: ValidatedBuildResult): CompletionEvidence {
    const build: BuildCompletionEvidence =
      input.outcome === 'READY'
        ? {
            outcome: 'READY',
            stage: input.stage,
            toolchain: input.toolchain,
            manifestDigest: input.manifestDigest,
            artifact: input.artifact,
            ...(input.diagnosticsRef === undefined ? {} : { diagnosticsRef: input.diagnosticsRef }),
          }
        : {
            outcome: 'SOURCE_REJECTED',
            stage: input.stage,
            toolchain: input.toolchain,
            manifestDigest: input.manifestDigest,
            diagnostic: input.diagnostic,
            ...(input.diagnosticsRef === undefined ? {} : { diagnosticsRef: input.diagnosticsRef }),
          };
    return { kind: 'BUILD', build };
  }

  /**
   * Drops an attempt whose lease is gone: its pinned bytes must not outlive the lease, and a
   * private-test claim must not outlive it either — a snapshot whose worker died goes back to
   * COMPLETED (unless this attempt already recorded its result) instead of staying RUNNING.
   */
  async abandon(identity: LeaseIdentity): Promise<void> {
    const assignment = this.assignments.get(identity.attemptId);
    if (!assignment || assignment.lease.grantId !== identity.grantId || assignment.lease.fencingToken !== identity.fencingToken) return;
    await this.release(identity.attemptId);
  }

  /** Follows a heartbeat so an abandoned attempt is recognised without waiting for a process restart. */
  extend(identity: LeaseIdentity, expiresAt: string): void {
    const assignment = this.assignments.get(identity.attemptId);
    if (!assignment || assignment.lease.grantId !== identity.grantId) return;
    assignment.leaseExpiresAt = Date.parse(expiresAt);
  }

  /**
   * Deletes one attempt spool, releases the private-test claim it still holds and forgets the
   * assignment. Releasing the claim is a no-op once the attempt recorded its result, so every path
   * that ends an attempt — acceptance, an abandoned lease, an expiry sweep — is safe here.
   */
  private async release(attemptId: string, client?: pg.PoolClient): Promise<void> {
    const assignment = this.assignments.get(attemptId);
    if (!assignment) return;
    if (assignment.kind === 'GAME') this.options.liveProjector?.abandon(assignment.lease);
    this.assignments.delete(attemptId);
    await rm(assignment.attemptDirectory, { recursive: true, force: true, maxRetries: 2 });
    // Inside a completion transaction the release must run on that same session: a second
    // connection would wait for the row this transaction just wrote, and the transaction is
    // waiting for this call — a self-deadlock. After the acceptance the row is already settled,
    // so the guarded statement matches nothing.
    if (assignment.kind === 'TEST_GAME') {
      const statement = client ? statementRunner(client) : undefined;
      await releasePrivateTestSnapshot(
        statement ? { query: (text: string, params?: readonly unknown[]) => statement(text, params) } : this.db,
        assignment.testId
      );
    }
  }

  /**
   * Deletes the spools of attempts whose lease has run out while this process was alive. The worker
   * heartbeats every few seconds, so a lease that expired without a heartbeat belongs to a worker
   * that is gone; the reconciler will requeue the job as a *new* attempt with its own spool.
   */
  private async sweepAbandoned(): Promise<void> {
    const now = Date.now();
    const abandoned = [...this.assignments].filter(([, assignment]) => assignment.leaseExpiresAt <= now);
    for (const [attemptId] of abandoned) await this.release(attemptId);
  }

  private requireAssignment(lease: LeaseIdentity): AssignmentRecord {
    const assignment = this.assignments.get(lease.attemptId);
    // The lease is rebuilt from the wire frame, so compare fields, never object identity or order.
    if (
      !assignment ||
      assignment.lease.jobId !== lease.jobId ||
      assignment.lease.grantId !== lease.grantId ||
      assignment.lease.fencingToken !== lease.fencingToken ||
      assignment.lease.deploymentGeneration !== lease.deploymentGeneration
    ) {
      throw new JobBrokerError('ASSIGNMENT_MISSING', 'No matching assignment');
    }
    return assignment;
  }

  private toolchainFor(language: BotLanguage): BuildToolchain {
    const toolchain = this.options.toolchains.find((candidate) => candidate.language === language);
    if (!toolchain) throw new JobBrokerError('TOOLCHAIN_PROFILE_MISSING', `Runtime profile has no ${language} toolchain`);
    return toolchain;
  }

  private boundManifest(gameId: string, attemptId: string, map: MapDescriptor, rulesRevision: string, bots: readonly GameBotAssignment[]): string {
    return JSON.stringify({ ...JSON.parse(canonicalGameManifest(gameId, attemptId, map, MAX_GAME_TURNS)), provenance: {
      rulesRevision, runtimeProfileDigest: this.options.runtimeProfileDigest, toolchains: this.options.toolchains,
      bots: bots.map((bot) => ({ ...bot, source: { digest: bot.source.digest, sizeBytes: bot.source.sizeBytes }, ...(bot.artifact ? { artifact: { digest: bot.artifact.digest, sizeBytes: bot.artifact.sizeBytes, entrypoint: bot.artifact.entrypoint } } : {}), toolchain: this.toolchainFor(bot.language) })),
    } });
  }
  private async prepareGame(lease: JobLease): Promise<GameAssignment> {
    const result = await this.db.query<{ id: string; map_descriptor: MapDescriptor; rules_revision: string; tournament_id: string; white_team_id: string; black_team_id: string }>(
      `SELECT g.id, g.map_descriptor, g.rules_revision, e.tournament_id, g.white_team_id, g.black_team_id
       FROM games g JOIN encounters e ON e.id = g.encounter_id JOIN tournaments t ON t.id = e.tournament_id
       WHERE g.id = $1 AND g.status IN ('PENDING','RUNNING') AND t.state = 'RUNNING'`, [lease.targetId]);
    const game = result.rows[0];
    if (!game) throw new JobBrokerError('GAME_NOT_RUNNABLE', 'Game is not runnable');
    const attemptDirectory = await createAttemptDirectory(this.options.spoolRoot, lease.identity.attemptId);
    try {
      const bots: GameBotAssignment[] = [];
      for (const [side, team] of [[1, game.white_team_id], [2, game.black_team_id]] as const) {
        const source = await this.db.query<{ receiptId: string; source_digest: Digest; language: BotLanguage; entrypoint: string }>(
          `SELECT s.id AS "receiptId", s.source_digest, s.language, s.entrypoint FROM tournament_entries e
           JOIN submissions s ON s.id = e.frozen_submission_id
           WHERE e.tournament_id = $1 AND e.team_id = $2 AND s.status = 'READY'`, [game.tournament_id, team]);
        const candidate = source.rows[0];
        if (!candidate) throw new JobBrokerError('FROZEN_ARTIFACT_REQUIRED', 'Native execution requires a frozen READY artifact');
        bots.push(await this.grantStoredBot(attemptDirectory, side, candidate));
      }
      const map = game.map_descriptor;
      const canonicalManifest = this.boundManifest(game.id, lease.identity.attemptId, map, game.rules_revision, bots);
      const manifestDigest = createHash('sha256').update(canonicalManifest).digest('hex');
      const payload: GameAssignment = {
        version: 1,
        jobType: 'GAME',
        targetId: game.id,
        canonicalManifest,
        manifestDigest,
        runtimeProfileDigest: this.options.runtimeProfileDigest,
        gameId: game.id,
        rulesRevision: game.rules_revision,
        maxTurns: MAX_GAME_TURNS,
        bots,
      };
      // A restart drops authority for unfinished assignments; lease expiry/reconciliation must reissue them.
      this.assignments.set(lease.identity.attemptId, {
        kind: 'GAME', jobType: 'GAME', lease: lease.identity, leaseExpiresAt: Date.parse(lease.expiresAt), attemptDirectory,
        gameId: game.id, rulesRevision: game.rules_revision, map, manifestDigest, payload,
      });
      await this.options.liveProjector?.open(lease.identity, game.id, map);
      return payload;
    } catch (error: unknown) {
      await rm(attemptDirectory, { recursive: true, force: true, maxRetries: 2 });
      throw error;
    }
  }

  private async grantCompiledArtifact(attemptDirectory: string, side: 1 | 2, language: BotLanguage, sourceDigest: Digest): Promise<GrantedArtifact & { entrypoint: string }> {
    const compiled = await this.options.compiledArtifacts.resolve(language, sourceDigest, this.toolchainFor(language));
    // The store re-hashes on read, so `undefined` covers both a missing build and an artifact whose
    // bytes no longer match their record: neither may reach a match.
    if (!compiled || !ARTIFACT_ENTRYPOINT.test(compiled.record.entrypoint)) {
      throw new JobBrokerError('BUILD_ARTIFACT_UNAVAILABLE', `No verified compiled artifact for the frozen ${language} source`);
    }
    const grant = await writeGrant(attemptDirectory, `bot-${side}-artifact.bin`, compiled.bytes);
    return { ...grant, entrypoint: compiled.record.entrypoint };
  }

  /**
   * Pins one bot side from a stored source artifact: the ZIP is re-validated and re-hashed against
   * the digest the receipt/snapshot recorded, granted as a per-attempt spool file, and — for a
   * compile language — accompanied by the compiled artifact its build produced. A missing source, a
   * digest that no longer matches, or an artifact that cannot be verified is refused here, so no
   * side ever reaches a match as something it is not.
   */
  private async grantStoredBot(
    attemptDirectory: string,
    side: 1 | 2,
    source: { readonly receiptId?: string; readonly source_digest: Digest; readonly language: BotLanguage; readonly entrypoint: string }
  ): Promise<GameBotAssignment> {
    const stored = await this.artifacts.getSource(source.source_digest);
    if (!stored) throw new JobBrokerError('ARTIFACT_MISSING', 'Source artifact is missing');
    const extracted = parseAndValidateZip(stored.zipBuffer, source.language, source.entrypoint);
    const canonical = computeCanonicalManifest(extracted.files, source.language, source.entrypoint, extracted.expandedBytes);
    if (canonical.digest !== source.source_digest) throw new JobBrokerError('ARTIFACT_DIGEST_MISMATCH', 'Source digest mismatch');
    const sourceGrant = await writeGrant(attemptDirectory, `bot-${side}.zip`, stored.zipBuffer);
    // A compile language runs the artifact its build produced — no compiler runs at match time — and
    // a side whose artifact is missing or fails its digest check is refused, never played from source.
    const artifact = COMPILE_LANGUAGES.includes(source.language)
      ? await this.grantCompiledArtifact(attemptDirectory, side, source.language, source.source_digest)
      : undefined;
    return {
      side,
      ...(source.receiptId ? { receiptId: source.receiptId } : {}),
      sourceDigest: source.source_digest,
      language: source.language,
      entrypoint: source.entrypoint,
      source: sourceGrant,
      ...(artifact === undefined ? {} : { artifact }),
    };
  }

  /**
   * Pins the repo baseline bot as the black side of a private test. The worker materializes a
   * granted source through the intake's own ZIP validator, so the repository file is packaged here —
   * with the project manifest recomputed from the packaged bytes — instead of handing the worker a
   * host path it could read for itself. The baseline has no build step, so it never carries an
   * artifact.
   */
  private async grantBaselineBot(attemptDirectory: string, side: 1 | 2): Promise<GameBotAssignment> {
    const entrypoint = path.basename(this.baselineBotPath);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.baselineBotPath);
    } catch (error: unknown) {
      throw new JobBrokerError('BASELINE_BOT_MISSING', `Cannot read the baseline bot ${this.baselineBotPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const zip = storeZip([{ name: entrypoint, data: bytes }]);
    let sourceDigest: Digest;
    try {
      const extracted = parseAndValidateZip(zip, BASELINE_BOT_LANGUAGE, entrypoint);
      sourceDigest = computeCanonicalManifest(extracted.files, BASELINE_BOT_LANGUAGE, entrypoint, extracted.expandedBytes).digest;
    } catch (error: unknown) {
      throw new JobBrokerError('BASELINE_BOT_INVALID', `The baseline bot does not package as a valid ${BASELINE_BOT_LANGUAGE} source: ${error instanceof Error ? error.message : String(error)}`);
    }
    const source = await writeGrant(attemptDirectory, `bot-${side}.zip`, zip);
    return { side, sourceDigest, language: BASELINE_BOT_LANGUAGE, entrypoint, source };
  }

  /**
   * Builds the assignment for one private test: the snapshot's own bot plays white against the
   * opponent this control plane picks — the team's latest READY receipt for the tournament, else the
   * repo baseline — on the board the dev runner would have played. Claiming the snapshot is part of
   * building the assignment: the row moves to RUNNING here, conditionally, so a second claim loses
   * instead of playing the same row twice.
   */
  private async prepareTestGame(lease: JobLease): Promise<TestGameAssignment> {
    const testId = lease.targetId;
    const result = await this.db.query<{
      id: string;
      tournament_id: string;
      team_id: string;
      source_digest: Digest;
      language: BotLanguage;
      entrypoint: string;
      status: string;
      result_payload: unknown;
      rules_revision: string;
    }>(
      `SELECT ts.id, ts.tournament_id, ts.team_id, ts.source_digest, ts.language, ts.entrypoint,
              ts.status, ts.result_payload, t.rules_revision
       FROM test_snapshots ts
       JOIN tournaments t ON t.id = ts.tournament_id
       WHERE ts.id = $1`,
      [testId]
    );
    const snapshot = result.rows[0];
    if (!snapshot) throw new JobBrokerError('TEST_NOT_FOUND', 'Test snapshot does not exist');
    // Only a build-accepted snapshot that has never played is runnable: a rejected build, an
    // already-recorded verdict, or a run in flight must never be replayed. A RUNNING row with no
    // result is another attempt's claim — the very state this method is about to create.
    if (snapshot.status !== 'COMPLETED' || snapshot.result_payload !== null) {
      const inFlight = snapshot.status === 'RUNNING' && snapshot.result_payload === null;
      throw new JobBrokerError(
        inFlight ? 'TEST_ALREADY_CLAIMED' : 'TEST_NOT_RUNNABLE',
        inFlight ? 'Test snapshot is already being run' : `Test snapshot is ${snapshot.status}, expected COMPLETED with no result`
      );
    }
    // The conditional claim is the race-safe half of the same rule: a read that happened before a
    // competing claim cannot hand this attempt a snapshot the other one already took.
    if (!(await claimPrivateTestSnapshot(this.db, testId))) {
      throw new JobBrokerError('TEST_ALREADY_CLAIMED', 'Test snapshot is already being run');
    }

    let attemptDirectory: string | undefined;
    try {
      attemptDirectory = await createAttemptDirectory(this.options.spoolRoot, lease.identity.attemptId);
      const map = await resolvePrivateTestMap(this.db, snapshot.tournament_id);
      const bots: GameBotAssignment[] = [await this.grantStoredBot(attemptDirectory, 1, snapshot)];
      const candidate = await loadLatestReadySubmission(this.db, snapshot.tournament_id, snapshot.team_id);
      const opponent: TestOpponentRef = candidate
        ? { kind: 'OWN_SUBMISSION', label: `submission #${candidate.receipt_ordinal}` }
        : { kind: 'BASELINE', label: path.basename(this.baselineBotPath) };
      bots.push(
        candidate
          ? await this.grantStoredBot(attemptDirectory, 2, candidate)
          : await this.grantBaselineBot(attemptDirectory, 2)
      );
      const canonicalManifest = this.boundManifest(testId, lease.identity.attemptId, map.descriptor, snapshot.rules_revision, bots);
      const payload: TestGameAssignment = {
        version: 1,
        jobType: 'TEST_GAME',
        targetId: testId,
        testId,
        rulesRevision: snapshot.rules_revision,
        canonicalManifest,
        manifestDigest: createHash('sha256').update(canonicalManifest).digest('hex'),
        runtimeProfileDigest: this.options.runtimeProfileDigest,
        maxTurns: MAX_GAME_TURNS,
        bots,
        opponent,
      };
      // A restart drops authority for unfinished assignments; lease expiry/reconciliation reissues them.
      this.assignments.set(lease.identity.attemptId, {
        kind: 'TEST_GAME', jobType: 'TEST_GAME', lease: lease.identity, leaseExpiresAt: Date.parse(lease.expiresAt),
        attemptDirectory, testId, gameId: testId, rulesRevision: snapshot.rules_revision, map: map.descriptor,
        mapRef: map.ref, opponent, manifestDigest: payload.manifestDigest, payload,
      });
      return payload;
    } catch (error: unknown) {
      // No evidence was submitted, so the claim is released rather than stranded: the snapshot goes
      // back to COMPLETED and the retried job can claim it, instead of staying RUNNING with no worker.
      if (attemptDirectory !== undefined) await rm(attemptDirectory, { recursive: true, force: true, maxRetries: 2 });
      await releasePrivateTestSnapshot(this.db, testId);
      throw error;
    }
  }

  private async prepareBuild(lease: JobLease): Promise<BuildAssignment> {
    const kind: BuildTargetKind = lease.jobType === 'TEST_BUILD' ? 'TEST_BUILD' : 'BUILD';
    const target = BUILD_TARGETS[kind];
    const result = await this.db.query<{ id: string; source_digest: string; language: BotLanguage; entrypoint: string; status: string }>(
      `SELECT id, source_digest, language, entrypoint, status FROM ${target.table} WHERE id = $1`, [lease.targetId]);
    const row = result.rows[0];
    if (!row) throw new JobBrokerError('BUILD_TARGET_NOT_FOUND', 'Build target does not exist');
    if (!target.buildable.includes(row.status)) throw new JobBrokerError('BUILD_TARGET_UNASSIGNABLE', `Build target is ${row.status}`);
    const toolchain = this.toolchainFor(row.language);
    const stored = await this.artifacts.getSource(row.source_digest);
    if (!stored) throw new JobBrokerError('ARTIFACT_MISSING', 'Build source missing');
    const extracted = parseAndValidateZip(stored.zipBuffer, row.language, row.entrypoint);
    const canonical = computeCanonicalManifest(extracted.files, row.language, row.entrypoint, extracted.expandedBytes);
    if (canonical.digest !== row.source_digest) throw new JobBrokerError('ARTIFACT_DIGEST_MISMATCH', 'Build source digest mismatch');
    const attemptDirectory = await createAttemptDirectory(this.options.spoolRoot, lease.identity.attemptId);
    try {
      const source = await writeGrant(attemptDirectory, 'source.zip', stored.zipBuffer);
      const assignment: BuildAssignment = {
        version: 1,
        jobType: kind,
        targetId: row.id,
        language: row.language,
        entrypoint: row.entrypoint,
        manifestDigest: row.source_digest,
        toolchain,
        source,
        limits: { ...BUILD_LIMITS },
      };
      // The lease is the build in flight, so the state the queue declares is real for this path too.
      await this.db.query(`UPDATE ${target.table} SET status = 'COMPILING' WHERE id = $1 AND status = ANY($2::text[])`, [row.id, [...target.startable]]);
      this.assignments.set(lease.identity.attemptId, {
        kind: 'BUILD', jobType: kind, lease: lease.identity, leaseExpiresAt: Date.parse(lease.expiresAt), attemptDirectory, targetId: row.id, assignment,
      });
      return assignment;
    } catch (error: unknown) {
      await rm(attemptDirectory, { recursive: true, force: true, maxRetries: 2 });
      throw error;
    }
  }

  /**
   * Validates a GAME/TEST_GAME completion against the assignment this gateway handed out for that
   * attempt, and returns the evidence plus the supervisor observations the recording service
   * authenticates. A private test is held to exactly the same bar as an official game.
   */
  private async validateGameRun(run: GameRunRecord, lease: LeaseIdentity, value: unknown): Promise<ValidatedNativeResult> {
    const input = record(value);
    if (input.manifestDigest !== run.manifestDigest) throw new JobBrokerError('MANIFEST_MISMATCH', 'Manifest mismatch');
    const game = record(input.gameEvidence);
    const winner = uint(game.winner);
    if (winner > 2 || typeof game.reason !== 'string' || game.reason.length > 128 || !['DECISIVE', 'DRAW', 'NO_CONTEST'].includes(String(game.disposition)) || !['COMPLETED', 'BOT_FORFEIT'].includes(String(game.executionStatus))) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid game outcome');
    if (!Array.isArray(game.trace) || game.trace.length > MAX_GAME_TURNS) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid trace');
    const trace: ActionTraceStep[] = game.trace.map((raw: unknown) => {
      const step = record(raw), move = record(step.move), target = record(move.targetPos);
      if (typeof target.x !== 'number' || !Number.isSafeInteger(target.x) || typeof target.y !== 'number' || !Number.isSafeInteger(target.y)) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid target');
      return { ply: uint(step.ply), side: uint(step.side), move: { pieceId: uint(move.pieceId), targetPos: { x: target.x, y: target.y } } };
    });
    if (!Array.isArray(input.observations) || input.observations.length > MAX_GAME_TURNS + 3) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid observations');
    const observations: NativeExecutionObservation[] = input.observations.map((raw: unknown) => {
      const observation = record(raw);
      if (observation.side !== 1 && observation.side !== 2) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid observation side');
      if (observation.kind !== 'RESPONSE' && observation.kind !== 'PROTOCOL_ERROR' && observation.kind !== 'CPU_TIMEOUT' && observation.kind !== 'WALL_TIMEOUT' && observation.kind !== 'OUTPUT_LIMIT') throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid observation kind');
      if (typeof observation.freezeConfirmed !== 'boolean' || typeof observation.terminationConfirmed !== 'boolean') throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid lifecycle observation');
      let responseNdjson: string | undefined;
      if (observation.kind === 'RESPONSE') {
        if (typeof observation.responseNdjson !== 'string' || Buffer.byteLength(observation.responseNdjson) > 16384 || !observation.responseNdjson.endsWith('\n')) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid raw response');
        responseNdjson = observation.responseNdjson;
      }
      return { side: observation.side, ply: uint(observation.ply), kind: observation.kind, cpuUsec: decimal(observation.cpuUsec), wallUsec: decimal(observation.wallUsec), freezeConfirmed: observation.freezeConfirmed, terminationConfirmed: observation.terminationConfirmed, ...(responseNdjson === undefined ? {} : { responseNdjson }) };
    });
    const evidence: GameResultEvidence = { gameId: run.gameId, winner, reason: game.reason, disposition: game.disposition === 'DECISIVE' ? 'DECISIVE' : game.disposition === 'DRAW' ? 'DRAW' : 'NO_CONTEST', executionStatus: game.executionStatus === 'COMPLETED' ? 'COMPLETED' : 'BOT_FORFEIT', rulesRevision: run.rulesRevision, totalPly: uint(game.totalPly), trace,
      cpuUsec: observations.reduce((sum, observation) => sum + BigInt(observation.cpuUsec), 0n).toString(), wallUsec: observations.reduce((sum, observation) => sum + BigInt(observation.wallUsec), 0n).toString() };
    return { jobType: run.jobType, gameId: run.gameId, attemptId: lease.attemptId, manifestDigest: run.manifestDigest, actionTraceDigest: createHash('sha256').update(JSON.stringify(trace)).digest('hex'), mapDescriptor: run.map, evidence, observations };
  }

  private async validateBuild(assignment: BuildAssignmentRecord, lease: LeaseIdentity, value: unknown): Promise<ValidatedBuildResult> {
    const input = record(value);
    const outcome = input.outcome;
    if (outcome !== 'READY' && outcome !== 'SOURCE_REJECTED') throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid build outcome');
    if (input.stage !== 'COMPILE' && input.stage !== 'INIT_SMOKE') throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid build stage');
    const toolchain = parseToolchain(input.toolchain);
    if (!toolchain) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid build toolchain');
    if (!sameToolchain(toolchain, assignment.assignment.toolchain)) throw new JobBrokerError('TOOLCHAIN_MISMATCH', 'Build toolchain is not the operator toolchain of this assignment');
    if (input.manifestDigest !== assignment.assignment.manifestDigest) throw new JobBrokerError('MANIFEST_MISMATCH', 'Manifest mismatch');
    const diagnosticsRef = input.diagnosticsRef;
    if (diagnosticsRef !== undefined && (typeof diagnosticsRef !== 'string' || diagnosticsRef.length === 0 || diagnosticsRef.length > 512)) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid diagnostics reference');

    if (outcome === 'SOURCE_REJECTED') {
      if (input.artifact !== undefined) throw new JobBrokerError('INVALID_EVIDENCE', 'A rejected source ships no artifact');
      return {
        jobType: assignment.jobType, targetId: assignment.targetId, attemptId: lease.attemptId, outcome, stage: input.stage,
        toolchain, manifestDigest: assignment.assignment.manifestDigest, diagnostic: sanitiseDiagnostic(input.diagnostic),
        ...(diagnosticsRef === undefined ? {} : { diagnosticsRef }),
      };
    }

    const raw = record(input.artifact);
    if (!isDigest(raw.digest)) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid artifact digest');
    if (typeof raw.sizeBytes !== 'number' || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes <= 0 || raw.sizeBytes > MAX_COMPILED_BYTES) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid artifact size');
    if (typeof raw.entrypoint !== 'string' || !ARTIFACT_ENTRYPOINT.test(raw.entrypoint)) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid artifact entrypoint');
    if (typeof raw.key !== 'string' || raw.key.length === 0 || raw.key.length > 512) throw new JobBrokerError('INVALID_EVIDENCE', 'Invalid artifact key');
    const expectedKey = compiledArtifactKey(assignment.assignment.language, assignment.assignment.manifestDigest, assignment.assignment.toolchain);
    if (raw.key !== expectedKey) throw new JobBrokerError('ARTIFACT_KEY_MISMATCH', 'Artifact key is not the key of this build');
    const artifact: CompiledArtifact = { key: raw.key, digest: raw.digest, sizeBytes: raw.sizeBytes, entrypoint: raw.entrypoint };

    const staged = assignment.staged;
    if (!staged || !staged.complete) throw new JobBrokerError('ARTIFACT_NOT_STAGED', 'The compiled artifact was not staged for this attempt');
    if (staged.digest !== artifact.digest || staged.sizeBytes !== artifact.sizeBytes || staged.entrypoint !== artifact.entrypoint) {
      throw new JobBrokerError('ARTIFACT_DIGEST_MISMATCH', 'Staged artifact is not the artifact this completion claims');
    }
    const bytes = await readFile(staged.path).catch(() => undefined);
    if (!bytes || bytes.length !== artifact.sizeBytes || sha256Bytes(bytes) !== artifact.digest) {
      throw new JobBrokerError('ARTIFACT_DIGEST_MISMATCH', 'Staged artifact bytes do not match their digest');
    }
    return {
      jobType: assignment.jobType, targetId: assignment.targetId, attemptId: lease.attemptId, outcome, stage: input.stage,
      toolchain, manifestDigest: assignment.assignment.manifestDigest, artifact, artifactBytes: bytes,
      ...(diagnosticsRef === undefined ? {} : { diagnosticsRef }),
    };
  }
}
