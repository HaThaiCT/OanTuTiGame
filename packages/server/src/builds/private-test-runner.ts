/**
 * Private TEST execution: a team's test snapshot plays a real match and leaves no official trace.
 *
 * A private test is a *practice* run. It plays the same frozen source virtually an official game
 * would, against the team's own latest READY submission or the repo baseline bot, on the
 * tournament's pinned map — but nothing it does is allowed to move the tournament: no receipt
 * ordinal, no accepted result, no standings/rating row, no frozen candidate, no replay in the
 * official result tables. Its entire outcome lives on the `test_snapshots` row it was launched
 * from (migration 011):
 *
 *   QUEUED → COMPILING → SMOKE_TESTING → COMPLETED → RUNNING → COMPLETED (result_payload)
 *                                                          ↘ FAILED    ({error} in payload)
 *
 * The build leg (QUEUED → COMPLETED/FAILED) is `BuildPipeline.buildTestSnapshot`; this module owns
 * the execution leg and is only ever reached through a `TEST_GAME` job, which the autonomous
 * worker enqueues once a snapshot's build is accepted.
 *
 * WARNING: nothing here is sandboxed — both bots run as ordinary child processes of this server
 * with its uid, cwd, environment and file system access (same as the dev match executor). It is
 * therefore only reachable from the development worker (`OANTUTI_DEV_EXECUTION=1`).
 *
 * Spooling: one throwaway workspace per run, `<spoolDir>/test-<id>/{own,opponent}`, removed in a
 * `finally` on every path; C++ sources reuse the digest-keyed binary cache at
 * `<spoolDir>/cpp/<digest>/bot`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { PlayerSide, WinReason, type MapDescriptor } from '@oantuti/engine';
import { MatchOrchestrator, type BotConfig, type MatchResult } from '@oantuti/runner';
import type {
  ActionTraceStep,
  Actor,
  BotLanguage,
  Digest,
  Instant,
  UUID,
} from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import type { ReplayStore } from '../results/replay-store.js';
import type { ArtifactStore } from '../submissions/artifact-store.js';
import {
  SourceCompileError,
  compileCppBinary,
  describeError,
  materializeSource,
  resolveLaunch,
} from '../submissions/source-materializer.js';

/** Turn budget of a private test match: the same 300 the official executor advertises. */
const MAX_MATCH_TURNS = 300;
/** Ceiling on any single C++ compile performed for a test's opponent, as the executor uses. */
const CPP_COMPILE_TIMEOUT_MS = 30_000;
/** Longest reason persisted into `result_payload.error`. */
const MAX_REASON_CHARS = 500;
/** Repo bot played when the team has no READY submission for the tournament yet. */
const DEFAULT_BASELINE_BOT = 'bots/greedy-bot.ts';

/** UUID check applied before an id reaches a `uuid`-typed column (Postgres would raise 22P02). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `test_snapshots.status` values a private test can be observed in (009's state machine). */
export type PrivateTestSnapshotStatus =
  | 'QUEUED'
  | 'COMPILING'
  | 'SMOKE_TESTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export interface PrivateTestRunnerOptions {
  /** Root of the run spool: `<spoolDir>/test-<id>` is created and removed per run. */
  readonly spoolDir: string;
  /** Repo baseline bot (TypeScript) used when the team has no READY submission yet. */
  readonly baselineBotPath?: string;
}

export type PrivateTestStatus = 'COMPLETED' | 'FAILED';

/** Verdict of one execution attempt, answered to the `TEST_GAME` job that leased it. */
export interface PrivateTestRunOutcome {
  readonly status: PrivateTestStatus;
  readonly reason?: string;
}

/** Which bot the test snapshot played, as recorded in `result_payload.opponent`. */
export interface PrivateTestOpponentRef {
  readonly kind: 'OWN_SUBMISSION' | 'BASELINE';
  readonly label: string;
  readonly submissionId?: UUID;
}

/** Where the test board came from, as recorded in `result_payload.map`. */
export interface PrivateTestMapRef {
  readonly name: string;
  readonly version?: number;
  readonly source: 'COMMITMENT' | 'LATEST_MAP' | 'SYNTHETIC';
}

/** One team's private test as read back through the API. */
export interface PrivateTestSummary {
  readonly id: UUID;
  readonly status: PrivateTestSnapshotStatus;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly sourceDigest: Digest;
  readonly createdAt: Instant;
  readonly startedAt: Instant | null;
  readonly completedAt: Instant | null;
  /** `result_payload` verbatim: the played match, or `{error}` for a failed run, else null. */
  readonly result: unknown;
  readonly replayDigest: Digest | null;
  /** Compile/smoke rejection detail, when the build stage failed. */
  readonly buildError: string | null;
}

/**
 * Raised for request-shape faults and access faults of the private-test surface. Carries
 * `statusCode`/`code` so the route layer's error funnel can render them like SubmissionError.
 */
export class PrivateTestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PrivateTestError';
  }
}

interface SnapshotRow {
  readonly id: string;
  readonly tournament_id: string;
  readonly team_id: string;
  readonly source_digest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly status: PrivateTestSnapshotStatus;
  readonly rules_revision: string;
  /** Non-null once the snapshot has played; distinguishes "built" from "built and played". */
  readonly result_payload: unknown;
}

interface CandidateRow {
  readonly id: string;
  readonly receipt_ordinal: number;
  readonly source_digest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
}

interface SummaryRow {
  readonly id: string;
  readonly team_id: string;
  readonly status: PrivateTestSnapshotStatus;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly source_digest: Digest;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly result_payload: unknown;
  readonly replay_digest: Digest | null;
  readonly build_error: string | null;
}

const SUMMARY_SELECT = `SELECT id, team_id, status, language, entrypoint, source_digest,
       created_at, started_at, completed_at, result_payload, replay_digest, build_error
  FROM test_snapshots`;

/**
 * Deterministic fallback board when neither a commitment nor any map exists: the same tiny 3×3
 * the build smoke test uses, so a private test is always playable. It is not a tournament board.
 */
const SYNTHETIC_TEST_MAP: MapDescriptor = {
  mapName: 'private_test_3x3',
  width: 3,
  height: 3,
  validTiles: [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [1, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ],
  whiteThrone: [0, 0],
  blackThrone: [2, 2],
  startingPieces: [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 1] },
  ],
};

const toIso = (value: Date | string): Instant =>
  value instanceof Date ? value.toISOString() : String(value);

export class PrivateTestRunner {
  private readonly spoolDir: string;
  private readonly baselineBotPath: string;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly artifactStore: ArtifactStore,
    private readonly replayStore: ReplayStore,
    options: PrivateTestRunnerOptions
  ) {
    this.spoolDir = options.spoolDir;
    this.baselineBotPath =
      options.baselineBotPath ?? path.resolve(process.cwd(), DEFAULT_BASELINE_BOT);
  }

  /**
   * Plays one private test match and records its verdict on the snapshot row.
   *
   * Only a snapshot whose build gate accepted it (`COMPLETED`) *and* that has not played yet may
   * run; anything else answers FAILED with the observed status as the reason, which is how a
   * snapshot whose build was rejected — or whose earlier run crashed while RUNNING — is settled
   * without ever replaying it. A snapshot that already carries a result is reported COMPLETED
   * untouched, so a re-delivered job (lease expiry, restart) never plays it twice.
   *
   * Every other fault — a vanished artifact, a failed C++ compile, a spawn crash — is a verdict,
   * not an infrastructure error: the run is recorded FAILED with the cause in
   * `result_payload.error`, so the job completes instead of retrying forever.
   *
   * Never writes to `submissions`, `accepted_results`, `result_versions`, `standings_snapshots`,
   * `rating_events`, `tournament_entries` or any receipt ordinal.
   */
  async runPrivateTest(testId: UUID): Promise<PrivateTestRunOutcome> {
    const snapshot = await this.loadSnapshot(testId);
    if (!snapshot) {
      return { status: 'FAILED', reason: `TEST_NOT_FOUND: no test snapshot ${testId}` };
    }
    if (snapshot.status === 'COMPLETED' && snapshot.result_payload !== null) {
      return { status: 'COMPLETED' };
    }
    if (snapshot.status !== 'COMPLETED') {
      return {
        status: 'FAILED',
        reason: `TEST_NOT_RUNNABLE: snapshot status is ${snapshot.status}, expected COMPLETED`,
      };
    }

    // Conditional claim: the predicates make a duplicate job's attempt a no-op instead of a
    // second concurrent replay of the same row.
    const claimed = await this.db.query<{ id: string }>(
      `UPDATE test_snapshots
       SET status = 'RUNNING', started_at = clock_timestamp()
       WHERE id = $1 AND status = 'COMPLETED' AND result_payload IS NULL
       RETURNING id`,
      [testId]
    );
    if (claimed.rows.length === 0) {
      const current = await this.loadSnapshot(testId);
      if (current?.status === 'COMPLETED' && current.result_payload !== null) {
        return { status: 'COMPLETED' };
      }
      return {
        status: 'FAILED',
        reason: `TEST_NOT_RUNNABLE: snapshot ${testId} is already being run (status ${current?.status ?? 'MISSING'})`,
      };
    }

    const runDir = path.join(this.spoolDir, `test-${testId}`);
    try {
      const map = await this.resolveMap(snapshot.tournament_id);
      const own = await materializeSource({
        artifactStore: this.artifactStore,
        sourceDigest: snapshot.source_digest,
        language: snapshot.language,
        entrypoint: snapshot.entrypoint,
        spoolDir: path.join(runDir, 'own'),
      });
      const ownConfig = await this.buildBotConfig(
        snapshot.language,
        snapshot.source_digest,
        own.workDir,
        own.entryPath
      );
      const opponent = await this.prepareOpponent(snapshot, runDir);

      const matchId = `private-test-${testId}`;
      const result = await new MatchOrchestrator({
        matchId,
        mapDescriptor: map.descriptor,
        whiteBotConfig: ownConfig,
        blackBotConfig: opponent.config,
        maxTurns: MAX_MATCH_TURNS,
      }).runMatch();

      // 1 = WHITE, 2 = BLACK, 0 = no winner (draw): the same convention as official results.
      const winner =
        result.winner === PlayerSide.WHITE ? 1 : result.winner === PlayerSide.BLACK ? 2 : 0;
      const reason = WinReason[result.winReason] ?? 'WIN_REASON_UNSPECIFIED';
      const trace = projectTrace(result);
      const finishedAt = new Date().toISOString();

      // The replay object is promoted before the row names its digest, so a stored
      // `replay_digest` always resolves to bytes.
      const staged = this.replayStore.stageReplay(
        `replays/tests/${testId}.oantuti`,
        this.replayStore.serializeReplayV2({
          gameId: matchId,
          attemptId: randomUUID(),
          mapId: map.descriptor.mapName,
          rulesRevision: snapshot.rules_revision,
          manifestDigest: createHash('sha256').update(JSON.stringify(own.manifest)).digest('hex'),
          totalTurns: result.totalTurns,
          winner,
          reason,
          disposition: winner === 0 ? 'DRAW' : 'DECISIVE',
          trace,
          map: map.descriptor,
        })
      );
      const stored = this.replayStore.promoteStagedReplay(staged.stagingPath, staged.digest);

      await this.db.query(
        `UPDATE test_snapshots
         SET status = 'COMPLETED',
             completed_at = clock_timestamp(),
             replay_digest = $2,
             result_payload = $3
         WHERE id = $1`,
        [
          testId,
          stored.digest,
          JSON.stringify({
            winner,
            reason,
            totalTurns: result.totalTurns,
            opponent: opponent.ref,
            map: map.ref,
            finishedAt,
          }),
        ]
      );

      return { status: 'COMPLETED' };
    } catch (err) {
      const detail = describeError(err);
      const reason =
        detail.length > MAX_REASON_CHARS ? `${detail.slice(0, MAX_REASON_CHARS)}…` : detail;
      await this.db.query(
        `UPDATE test_snapshots
         SET status = 'FAILED', completed_at = clock_timestamp(), result_payload = $2
         WHERE id = $1`,
        [testId, JSON.stringify({ error: reason })]
      );
      return { status: 'FAILED', reason };
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  /**
   * One team's private tests for a tournament, newest first. Access mirrors the submission
   * history: ADMIN, or a FULL-scope session belonging to the team.
   */
  async listTests(
    tournamentId: UUID,
    teamId: UUID,
    actor: Actor
  ): Promise<readonly PrivateTestSummary[]> {
    this.assertTeamAccess(teamId, actor);
    if (!UUID_PATTERN.test(tournamentId)) {
      throw new PrivateTestError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    }

    const tournament = await this.db.query<{ id: string }>('SELECT id FROM tournaments WHERE id = $1', [
      tournamentId,
    ]);
    if (tournament.rows.length === 0) {
      throw new PrivateTestError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    }

    const res = await this.db.query<SummaryRow>(
      `${SUMMARY_SELECT}
       WHERE tournament_id = $1 AND team_id = $2
       ORDER BY created_at DESC, id DESC`,
      [tournamentId, teamId]
    );
    return res.rows.map(toSummary);
  }

  /** One private test, with the same access rules as the team's history. */
  async getTest(testId: UUID, actor: Actor): Promise<PrivateTestSummary> {
    const row = await this.loadSummary(testId);
    this.assertTeamAccess(row.team_id, actor);
    return toSummary(row);
  }

  /** The immutable replay object of a finished test; 404 until one has been stored. */
  async getTestReplay(testId: UUID, actor: Actor): Promise<{ digest: Digest; buffer: Buffer }> {
    const row = await this.loadSummary(testId);
    this.assertTeamAccess(row.team_id, actor);
    if (row.replay_digest === null) {
      throw new PrivateTestError(404, 'REPLAY_NOT_AVAILABLE', 'This private test has no replay');
    }
    return { digest: row.replay_digest, buffer: this.replayStore.readReplay(row.replay_digest) };
  }

  /**
   * Private tests are team-only. The ADMIN source-inspection right covers **submitted** work
   * (01-PRODUCT-REQUIREMENTS §43/§99, 05-SECURITY-OPERATIONS §113/§115); it does not extend to
   * practice snapshots, results or replays, so an organizer session is refused here as well.
   */
  private assertTeamAccess(teamId: UUID, actor: Actor): void {
    if (actor.role === 'ADMIN') {
      throw new PrivateTestError(403, 'FORBIDDEN', 'Private tests are visible to the owning team only');
    }
    if (actor.scope !== 'FULL') {
      throw new PrivateTestError(403, 'FORBIDDEN', 'Session requires full scope to read private tests');
    }
    if (!actor.teamIds.includes(teamId)) {
      throw new PrivateTestError(403, 'FORBIDDEN', 'Forbidden: You do not belong to this team');
    }
  }

  private async loadSummary(testId: UUID): Promise<SummaryRow> {
    if (!UUID_PATTERN.test(testId)) {
      throw new PrivateTestError(404, 'TEST_NOT_FOUND', 'Private test not found');
    }
    const res = await this.db.query<SummaryRow>(`${SUMMARY_SELECT} WHERE id = $1`, [testId]);
    const row = res.rows[0];
    if (!row) {
      throw new PrivateTestError(404, 'TEST_NOT_FOUND', 'Private test not found');
    }
    return row;
  }

  private async loadSnapshot(testId: UUID): Promise<SnapshotRow | null> {
    if (!UUID_PATTERN.test(testId)) return null;
    const res = await this.db.query<SnapshotRow>(
      `SELECT ts.id, ts.tournament_id, ts.team_id, ts.source_digest, ts.language, ts.entrypoint,
              ts.status, ts.result_payload, t.rules_revision
       FROM test_snapshots ts
       JOIN tournaments t ON t.id = ts.tournament_id
       WHERE ts.id = $1`,
      [testId]
    );
    return res.rows[0] ?? null;
  }

  /**
   * The board a private test plays on, most authoritative first:
   *   1. the tournament's committed map, at the exact version it pinned (COMMITMENT),
   *   2. the newest map in the system, at its current version (LATEST_MAP),
   *   3. a synthetic deterministic 3×3 (SYNTHETIC).
   * Which one was used is recorded in `result_payload.map`.
   */
  private async resolveMap(
    tournamentId: string
  ): Promise<{ descriptor: MapDescriptor; ref: PrivateTestMapRef }> {
    const commitment = await this.db.query<{
      name: string;
      version: number;
      descriptor: MapDescriptor;
    }>(
      `SELECT m.display_name AS name, c.map_version AS version, mv.descriptor
       FROM tournament_map_commitments c
       JOIN maps m ON m.id = c.map_id
       JOIN map_versions mv ON mv.map_id = c.map_id AND mv.version = c.map_version
       WHERE c.tournament_id = $1`,
      [tournamentId]
    );
    const committed = commitment.rows[0];
    if (committed) {
      return {
        descriptor: committed.descriptor,
        ref: { name: committed.name, version: committed.version, source: 'COMMITMENT' },
      };
    }

    const latest = await this.db.query<{
      name: string;
      version: number;
      descriptor: MapDescriptor;
    }>(
      // A HIDDEN map that the organizer has not revealed yet must not become a practice board: the
      // team would learn the secret map from its own test run (replay/board/log), which is exactly
      // the leak 02-GAMEPLAY/S08 forbids. Only PUBLIC or already-revealed versions are eligible.
      `SELECT m.display_name AS name, m.current_version AS version, mv.descriptor
       FROM maps m
       JOIN map_versions mv ON mv.map_id = m.id AND mv.version = m.current_version
       WHERE m.visibility = 'PUBLIC' OR m.revealed_at IS NOT NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1`
    );
    const newest = latest.rows[0];
    if (newest) {
      return {
        descriptor: newest.descriptor,
        ref: { name: newest.name, version: newest.version, source: 'LATEST_MAP' },
      };
    }

    return {
      descriptor: SYNTHETIC_TEST_MAP,
      ref: { name: SYNTHETIC_TEST_MAP.mapName, source: 'SYNTHETIC' },
    };
  }

  /**
   * Resolves the opponent: the team's latest READY official receipt for this tournament (the
   * same candidate a match would freeze, materialized through the shared intake path), else the
   * repo baseline bot. A READY receipt that cannot be materialized is a fault, not a reason to
   * silently swap in the baseline — it propagates and fails the run.
   */
  private async prepareOpponent(
    snapshot: SnapshotRow,
    runDir: string
  ): Promise<{ config: BotConfig; ref: PrivateTestOpponentRef }> {
    const candidate = await this.loadReadyCandidate(snapshot.tournament_id, snapshot.team_id);
    if (candidate) {
      const materialized = await materializeSource({
        artifactStore: this.artifactStore,
        sourceDigest: candidate.source_digest,
        language: candidate.language,
        entrypoint: candidate.entrypoint,
        spoolDir: path.join(runDir, 'opponent'),
      });
      return {
        config: await this.buildBotConfig(
          candidate.language,
          candidate.source_digest,
          materialized.workDir,
          materialized.entryPath
        ),
        ref: {
          kind: 'OWN_SUBMISSION',
          label: `submission #${candidate.receipt_ordinal}`,
          submissionId: candidate.id,
        },
      };
    }

    // The baseline bot lives in the repo, so it is launched in place: no workspace to clean up.
    const launch = resolveLaunch('TYPESCRIPT', this.baselineBotPath, path.dirname(this.baselineBotPath));
    return {
      config: { path: launch.executablePath, command: launch.command, args: [...launch.args] },
      ref: { kind: 'BASELINE', label: path.basename(this.baselineBotPath) },
    };
  }

  private async loadReadyCandidate(tournamentId: string, teamId: string): Promise<CandidateRow | null> {
    const res = await this.db.query<CandidateRow>(
      `SELECT id, receipt_ordinal, source_digest, language, entrypoint
       FROM submissions
       WHERE tournament_id = $1 AND team_id = $2 AND status = 'READY'
       ORDER BY receipt_ordinal DESC
       LIMIT 1`,
      [tournamentId, teamId]
    );
    return res.rows[0] ?? null;
  }

  /** Per-language launch, identical to the executor's (`resolveLaunch` + digest-keyed C++ cache). */
  private async buildBotConfig(
    language: BotLanguage,
    sourceDigest: Digest,
    workDir: string,
    entryPointPath: string
  ): Promise<BotConfig> {
    if (language === 'CPP') {
      const binaryPath = path.join(this.spoolDir, 'cpp', sourceDigest, 'bot');
      if (!existsSync(binaryPath)) {
        try {
          await compileCppBinary({
            sourcePath: entryPointPath,
            workDir,
            binaryPath,
            includeDirs: [path.resolve(process.cwd(), 'sdk/cpp')],
            timeoutMs: CPP_COMPILE_TIMEOUT_MS,
          });
        } catch (err) {
          if (err instanceof SourceCompileError) throw new PrivateTestError(500, err.code, err.message);
          throw err;
        }
      }
      const launch = resolveLaunch('CPP', entryPointPath, workDir, { cppBinaryPath: binaryPath });
      return { path: launch.executablePath, command: launch.command, args: [...launch.args] };
    }

    const launch = resolveLaunch(language, entryPointPath, workDir);
    return { path: launch.executablePath, command: launch.command, args: [...launch.args] };
  }
}

function toSummary(row: SummaryRow): PrivateTestSummary {
  return {
    id: row.id,
    status: row.status,
    language: row.language,
    entrypoint: row.entrypoint,
    sourceDigest: row.source_digest,
    createdAt: toIso(row.created_at),
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    result: row.result_payload ?? null,
    replayDigest: row.replay_digest,
    buildError: row.build_error,
  };
}

/**
 * The played moves of a private test match, in the `ActionTraceStep` shape replays carry.
 *
 * A `PASS` is only ever recorded for a genuine stalemate (already terminal) and carries no move,
 * so it is dropped, exactly as the official evidence builder does.
 */
function projectTrace(result: MatchResult): ActionTraceStep[] {
  const trace: ActionTraceStep[] = [];
  for (const turn of result.turns) {
    const action = turn.action;
    if (action.action !== 'MOVE') continue;
    trace.push({
      ply: trace.length + 1,
      side: turn.player === PlayerSide.WHITE ? 1 : 2,
      move: {
        pieceId: action.pieceId,
        targetPos: { x: action.target[0], y: action.target[1] },
      },
    });
  }
  return trace;
}
