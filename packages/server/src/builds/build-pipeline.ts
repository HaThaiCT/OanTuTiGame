/**
 * Durable build gate for submission receipts and private-test snapshots.
 *
 * A receipt is only usable once it has passed this pipeline, so the state machine the DB has
 * always declared becomes real:
 *
 *   submissions:      VALIDATING ─▶ COMPILING ─▶ SMOKE_TESTING ─▶ READY   (or REJECTED)
 *   test_snapshots:   QUEUED     ─▶ COMPILING ─▶ SMOKE_TESTING ─▶ COMPLETED (or FAILED)
 *
 * Steps, all inside one per-target spool directory that is always removed afterwards:
 *   1. materialize the stored ZIP into a fresh workspace (shared intake validator, digest
 *      equality, entrypoint resolution — see submissions/source-materializer.ts),
 *   2. compile when the language has a compile step (PYTHON `python3 -m py_compile`, CPP
 *      `g++ -O2 -std=c++20`), TYPESCRIPT has none,
 *   3. smoke-test: launch the bot exactly as a match would (same resolveLaunch command, same
 *      stdin/stdout protocol via BotProcess) and require one clean INIT → `{"status":"READY"}`.
 *
 * A REJECTED build is a *successful job*: the work finished, the verdict is recorded (status,
 * `build_error`, `built_at`, and a `BUILD_REJECTED` audit event). Only infrastructure faults
 * (spawn crash, DB error) propagate and leave the caller's lease to expire.
 *
 * Nothing here is sandboxed: step 3 runs the submitted code with this process's uid, cwd,
 * environment and file system access. It is therefore only reachable from the development
 * worker (`TournamentAutoRunner`), which is inert unless `OANTUTI_DEV_EXECUTION=1`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { BotProcess, DisqualificationError, type BotInitPayload } from '@oantuti/runner';
import type { BotLanguage, Digest, UUID } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import type { ArtifactStore } from '../submissions/artifact-store.js';
import {
  MAX_ERROR_DETAIL_CHARS,
  SourceCompileError,
  compileCppBinary,
  cppBinaryPath,
  describeError,
  materializeSource,
  resolveLaunch,
  type MaterializedSource,
} from '../submissions/source-materializer.js';

const execFileAsync = promisify(execFile);

/** `python3 -m py_compile` ceiling. */
const PY_COMPILE_TIMEOUT_MS = 30_000;
const PY_COMPILE_MAX_BUFFER_BYTES = 1 * 1024 * 1024;
/** INIT handshake budget of the smoke test: a bot that cannot greet in 5 s is not runnable. */
export const SMOKE_INIT_TIMEOUT_MS = 5_000;
/** Turn budget advertised in the synthetic smoke INIT (the handshake is what is gated). */
const SMOKE_MAX_TURNS = 300;
/** Longest rejection reason persisted to `build_error` / the audit event. */
const MAX_REASON_CHARS = 500;

/** Stable digests for a build that produced nothing to hash (idempotent re-report). */
const EMPTY_DIGEST: Digest = createHash('sha256').update('').digest('hex');

/** Which durable build queue a target row belongs to. */
type BuildTargetKind = 'SUBMISSION' | 'TEST_SNAPSHOT';

/** Table backing each kind. Literal identifiers only — never caller-controlled. */
const TARGET_TABLE = {
  SUBMISSION: 'submissions',
  TEST_SNAPSHOT: 'test_snapshots',
} as const;

/** `audit_events.resource_type` recorded for each kind. */
const RESOURCE_TYPE = {
  SUBMISSION: 'SUBMISSION',
  TEST_SNAPSHOT: 'TEST_SNAPSHOT',
} as const;

/** Raised for request-shape faults (unknown target); infrastructure faults are left raw. */
export class BuildPipelineError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'BuildPipelineError';
  }
}

export interface BuildPipelineOptions {
  /** Root of the build spool; one `<kind>-<id>` workspace is created and removed per build. */
  readonly spoolDir: string;
}

export interface BuildOutcomeBase {
  readonly reason?: string;
  /** Digest of the artifact that was built. */
  readonly sourceDigest: Digest;
  /** Digest of the diagnostic text captured while building ('' when both steps were clean). */
  readonly stderrDigest: Digest;
}

/** Result of gating an official submission receipt. */
export interface SubmissionBuildOutcome extends BuildOutcomeBase {
  readonly status: 'READY' | 'REJECTED';
}

/** Result of gating a private-test snapshot. */
export interface TestBuildOutcome extends BuildOutcomeBase {
  readonly status: 'COMPLETED' | 'FAILED';
}

/** Internal verdict of one build attempt, parameterised by the kind's terminal statuses. */
interface BuildAttempt<T extends string> extends BuildOutcomeBase {
  readonly status: T;
}

/** Receipt/target row this pipeline reads and updates. */
interface BuildTargetRow {
  readonly id: string;
  readonly source_digest: string;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly status: string;
  readonly build_error: string | null;
}

/** Raised when the smoke test fails, carrying the bot's raw stderr for the evidence digest. */
class SmokeTestFailedError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'SmokeTestFailedError';
  }
}

export class BuildPipeline {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly artifactStore: ArtifactStore,
    private readonly options: BuildPipelineOptions
  ) {}

  /**
   * Compiles and smoke-tests one receipt and moves it to READY (or REJECTED with a reason).
   *
   * Idempotent for finished work: a receipt already READY (or REJECTED) is reported back
   * without re-running anything, so replaying a completed job never rebuilds. A receipt left
   * in COMPILING/SMOKE_TESTING by a crash IS rebuilt — the job lease that found it there is
   * the same one that was interrupted.
   */
  async buildSubmission(submissionId: UUID): Promise<SubmissionBuildOutcome> {
    const row = await this.loadTarget('SUBMISSION', submissionId);
    if (row.status === 'READY') {
      return { status: 'READY', sourceDigest: row.source_digest, stderrDigest: EMPTY_DIGEST };
    }
    if (row.status === 'REJECTED') {
      return {
        status: 'REJECTED',
        reason: row.build_error ?? 'REJECTED',
        sourceDigest: row.source_digest,
        stderrDigest: EMPTY_DIGEST,
      };
    }
    return this.executeBuild('SUBMISSION', row, 'READY', 'REJECTED');
  }

  /** Same gate for a private-test snapshot: QUEUED → COMPILING → SMOKE_TESTING → COMPLETED/FAILED. */
  async buildTestSnapshot(testId: UUID): Promise<TestBuildOutcome> {
    const row = await this.loadTarget('TEST_SNAPSHOT', testId);
    if (row.status === 'COMPLETED') {
      return { status: 'COMPLETED', sourceDigest: row.source_digest, stderrDigest: EMPTY_DIGEST };
    }
    if (row.status === 'FAILED') {
      return {
        status: 'FAILED',
        reason: row.build_error ?? 'FAILED',
        sourceDigest: row.source_digest,
        stderrDigest: EMPTY_DIGEST,
      };
    }
    return this.executeBuild('TEST_SNAPSHOT', row, 'COMPLETED', 'FAILED');
  }

  /**
   * Compiles, smoke-tests and records one target. Every exit path removes the workspace; a
   * build never leaves more than one spool directory behind and never leaves the row in a
   * non-terminal state on the way out (the rejection is recorded instead).
   */
  private async executeBuild<T extends string>(
    kind: BuildTargetKind,
    row: BuildTargetRow,
    okStatus: T,
    badStatus: T
  ): Promise<BuildAttempt<T>> {
    const workDir = path.join(this.options.spoolDir, `${kind === 'SUBMISSION' ? 'submission' : 'test'}-${row.id}`);
    let cleanup = async (): Promise<void> => {
      await rm(workDir, { recursive: true, force: true });
    };
    // Diagnostic text the last completed step produced; becomes the evidence digest.
    let diagnostic = '';

    try {
      await this.setStatus(kind, row.id, 'COMPILING');

      const materialized = await materializeSource({
        artifactStore: this.artifactStore,
        sourceDigest: row.source_digest,
        language: row.language,
        entrypoint: row.entrypoint,
        spoolDir: workDir,
      });
      cleanup = materialized.cleanup;

      diagnostic = await this.compile(row.language, materialized);

      await this.setStatus(kind, row.id, 'SMOKE_TESTING');
      diagnostic = await this.smokeTest(row, materialized);

      return await this.settle(kind, row, okStatus, undefined, diagnostic);
    } catch (err) {
      // A failed compile or smoke test is a verdict, not an infrastructure fault: record it and
      // answer REJECTED/FAILED so the caller can complete the job with evidence.
      const detail = describeError(err);
      const reason = detail.length > MAX_REASON_CHARS ? `${detail.slice(0, MAX_REASON_CHARS)}…` : detail;
      const stderr =
        err instanceof SourceCompileError || err instanceof SmokeTestFailedError ? err.stderr : diagnostic;
      return await this.settle(kind, row, badStatus, reason, stderr);
    } finally {
      await cleanup();
    }
  }

  /**
   * Language compile step, returning whatever the compiler wrote to stderr (usually nothing).
   * TYPESCRIPT has no compile step: a syntax error there surfaces as a spawn failure in the
   * smoke test, which is exactly the gate a match would apply.
   */
  private async compile(language: BotLanguage, materialized: MaterializedSource): Promise<string> {
    if (language === 'PYTHON') {
      try {
        await execFileAsync('python3', ['-m', 'py_compile', materialized.entryPath], {
          cwd: materialized.workDir,
          timeout: PY_COMPILE_TIMEOUT_MS,
          maxBuffer: PY_COMPILE_MAX_BUFFER_BYTES,
        });
        return '';
      } catch (err) {
        const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr ?? '') : '';
        throw new SourceCompileError(
          'PY_COMPILE_FAILED',
          `PY_COMPILE_FAILED: ${(stderr.trim() || describeError(err)).slice(0, MAX_ERROR_DETAIL_CHARS)}`,
          stderr.trim()
        );
      }
    }

    if (language === 'CPP') {
      // The OanTuTi C++ SDK is header-only, so the repo SDK dir joins the include path exactly
      // as it does for a match build.
      await compileCppBinary({
        sourcePath: materialized.entryPath,
        workDir: materialized.workDir,
        binaryPath: cppBinaryPath(materialized.workDir),
        includeDirs: [path.resolve(process.cwd(), 'sdk/cpp')],
      });
      return '';
    }

    return '';
  }

  /**
   * Launches the bot the same way a match does and requires a clean INIT handshake. The
   * process is always killed; the returned string is the bot's captured stderr, which is what
   * the accepted-build evidence digests.
   */
  private async smokeTest(row: BuildTargetRow, materialized: MaterializedSource): Promise<string> {
    const launch = resolveLaunch(row.language, materialized.entryPath, materialized.workDir);
    const bot = new BotProcess(launch.command, [...launch.args]);

    try {
      await bot.sendInit(buildSmokeInit(row.id), SMOKE_INIT_TIMEOUT_MS);
      return bot.getStderr();
    } catch (err) {
      const stderr = bot.getStderr().trim();
      const detail = err instanceof DisqualificationError ? describeError(err) : `spawn failed: ${describeError(err)}`;
      const excerpt = stderr.length > 0 ? ` | stderr: ${stderr.slice(0, 400)}` : '';
      throw new SmokeTestFailedError(`SMOKE_TEST_FAILED: ${detail}${excerpt}`, stderr);
    } finally {
      bot.kill();
    }
  }

  /**
   * Records the verdict: status, `build_error`, `built_at` and a BUILD_ACCEPTED/BUILD_REJECTED
   * audit event, in one transaction so a crash cannot leave a status without its evidence.
   * The caller's `stderrDigest` is the audit trail for a rejection; `reason` is only present
   * when the build was rejected, which is also how the audit action is chosen.
   */
  private async settle<T extends string>(
    kind: BuildTargetKind,
    row: BuildTargetRow,
    status: T,
    reason: string | undefined,
    stderr: string
  ): Promise<BuildAttempt<T>> {
    const stderrDigest = createHash('sha256').update(stderr).digest('hex');

    await this.db.withTransaction(async (client) => {
      await client.query(
        `UPDATE ${TARGET_TABLE[kind]}
         SET status = $2, build_error = $3, built_at = clock_timestamp()
         WHERE id = $1`,
        [row.id, status, reason ?? null]
      );
      await client.query(
        `INSERT INTO audit_events (action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, $4)`,
        [
          reason === undefined ? 'BUILD_ACCEPTED' : 'BUILD_REJECTED',
          RESOURCE_TYPE[kind],
          row.id,
          JSON.stringify({
            status,
            language: row.language,
            ...(reason === undefined ? {} : { reason }),
            stderrDigest,
          }),
        ]
      );
    });

    return {
      status,
      ...(reason === undefined ? {} : { reason }),
      sourceDigest: row.source_digest,
      stderrDigest,
    };
  }

  private async setStatus(kind: BuildTargetKind, id: UUID, status: string): Promise<void> {
    await this.db.query(`UPDATE ${TARGET_TABLE[kind]} SET status = $2 WHERE id = $1`, [id, status]);
  }

  private async loadTarget(kind: BuildTargetKind, id: UUID): Promise<BuildTargetRow> {
    const res = await this.db.query<BuildTargetRow>(
      `SELECT id, source_digest, language, entrypoint, status, build_error
       FROM ${TARGET_TABLE[kind]}
       WHERE id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) throw new BuildPipelineError(404, `${kind}_NOT_FOUND: ${id}`);
    return row;
  }
}

/**
 * Synthetic INIT for the smoke test: a fixed 3x3 board with one piece per side. It exists to
 * prove the bot speaks the protocol at all (`{"status":"READY"}`), not to score anything, so
 * the position is deliberately tiny and the advertised turn budget matches the INIT budget.
 */
function buildSmokeInit(targetId: string): BotInitPayload {
  return {
    type: 'INIT',
    match_id: `build-smoke-${targetId}`,
    my_side: 'WHITE',
    map: {
      name: 'build_smoke_3x3',
      width: 3,
      height: 3,
      valid_tiles: [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
        [0, 2],
        [1, 2],
        [2, 2],
      ],
      white_throne: [0, 0],
      black_throne: [2, 2],
    },
    pieces: [
      { id: 1, owner: 'WHITE', type: 'ROCK', x: 0, y: 1, is_alive: true },
      { id: 2, owner: 'BLACK', type: 'ROCK', x: 2, y: 1, is_alive: true },
    ],
    turn_time_limit_ms: SMOKE_INIT_TIMEOUT_MS,
    max_turns: SMOKE_MAX_TURNS,
  };
}
