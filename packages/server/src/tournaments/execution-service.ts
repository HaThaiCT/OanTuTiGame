/**
 * Development-only tournament match executor.
 *
 * ============================ WARNING: UNSANDBOXED ============================
 * These are DEVELOPMENT executions. Bot sources are fetched from the artifact store and
 * run as ordinary child processes of the API server, with the server's own uid, cwd,
 * environment, file system and network access. There is no container, jail, seccomp
 * filter, cgroup, namespace or file-system isolation, and no per-bot CPU/memory quota:
 * running an untrusted submission here is equivalent to handing it a shell on the host.
 *
 * The whole service therefore refuses to do anything unless the operator has explicitly
 * opted in with `OANTUTI_DEV_EXECUTION=1`. Production deployments MUST leave the flag
 * unset; every entry point then fails fast with HTTP 409 `DEV_EXECUTION_DISABLED`.
 *
 * The spool (`options.spoolDir`, default `storage/execution`) is created lazily with mode
 * 0700 and holds, per game, the extracted bot workspaces
 * (`<spool>/<gameId>/{white,black}/…`, files mode 0600) and the per-source-digest C++
 * binary cache (`<spool>/cpp/<sourceDigest>/bot`).
 *
 * Durability: a game is only ever executed under a `GAME` job lease
 * (claim → execute → prepareCompletion → complete). The lease is heartbeated while the match
 * runs, a faulted game leaves its lease to expire so the reconciler requeues it, and a game
 * whose result is already recorded reports ALREADY_COMPLETED instead of recording a second
 * version.
 * ==============================================================================
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  applyMoveV2,
  createInitialGameState,
  createMapTopology,
  evaluateVictoryV2,
  isLegalMove,
  PlayerSide,
  WinReason,
  type MapDescriptor,
  type MoveAction,
  type V2Outcome,
} from '@oantuti/engine';
import { MatchOrchestrator, type BotConfig, type MatchResult, type TurnRecord } from '@oantuti/runner';
import type {
  ActionTraceStep,
  BotLanguage,
  Digest,
  GameResultEvidence,
  JobLease,
  ProjectManifest,
  ReconcilerIdentity,
  WorkerIdentity,
} from '@oantuti/protocol';
import { JobBrokerError, LEASE_HEARTBEAT_SECONDS, type JobBroker } from '../jobs/broker.js';
import { LiveMatchHub, type LiveResult, type LiveTurnInput } from '../live/live-match-hub.js';
import { enqueueMissingGameJobs, listRunnableGames } from '../jobs/game-jobs.js';
import { PROCESS_RECONCILER_IDENTITY, PROCESS_WORKER_IDENTITY } from '../jobs/identity.js';
import type { PostgresDatabase } from '../persistence/db.js';
import type { ReplayStore } from '../results/replay-store.js';
import {
  ResultAlreadyAcceptedError,
  type AcceptedResultSummary,
  type ResultService,
} from '../results/service.js';
import type { ArtifactStore } from '../submissions/artifact-store.js';
import {
  SourceCompileError,
  SourceMaterializationError,
  compileCppBinary,
  describeError,
  materializeSource,
  resolveLaunch,
} from '../submissions/source-materializer.js';
import type { MapService } from './map-service.js';
import type { TournamentSchedulerService } from './scheduler-service.js';

/** Games executed per call when the caller does not ask for a specific cap. */
export const DEFAULT_EXECUTION_LIMIT = 8;
/** Hard upper bound on the per-call cap, keeping a single request time-boxed. */
export const MAX_EXECUTION_LIMIT = 32;
/** Turn budget used for the match and for the evidence replay (TraceVerifier default). */
export const MAX_MATCH_TURNS = 300;

const CPP_COMPILE_TIMEOUT_MS = 30_000;

/**
 * RESULT published when a run faults before the match produced an outcome (bot spawn failure,
 * evidence or recording fault): spectators get a terminal frame instead of a game that stays
 * RUNNING forever.
 */
const LIVE_EXECUTION_FAILED_RESULT: LiveResult = Object.freeze({ winner: null, reason: 'EXECUTION_FAILED' });

/**
 * Lease renewal period: a third of the TTL, so two heartbeats can be lost before a running
 * game's lease could be stolen. Unref'd, so it never keeps the process alive.
 */
const HEARTBEAT_INTERVAL_MS = LEASE_HEARTBEAT_SECONDS * 1_000;

/** Env flag that arms the unsandboxed development executor. Anything but '1' leaves it off. */
const DEV_EXECUTION_FLAG = 'OANTUTI_DEV_EXECUTION';

/**
 * Raised when the unsandboxed development executor has not been explicitly armed.
 * Carries `statusCode`/`code` so the route layer can surface 409 DEV_EXECUTION_DISABLED.
 */
export class DevExecutionDisabledError extends Error {
  readonly statusCode = 409;
  readonly code = 'DEV_EXECUTION_DISABLED';

  constructor() {
    super('DEV_EXECUTION_DISABLED');
    this.name = 'DevExecutionDisabledError';
  }
}

/** Request-shape errors of the executor (mirrors the MapError/TournamentError convention). */
export class MatchExecutionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'MatchExecutionError';
  }
}

export interface MatchExecutionOptions {
  /** Scratch root for extracted bot workspaces and compiled binaries. */
  readonly spoolDir: string;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

export interface RunPendingGamesOptions {
  readonly limit?: number;
}

export interface FailedGameExecution {
  readonly gameId: string;
  readonly error: string;
}

export interface RunPendingGamesResult {
  /** Games that produced an accepted result and had round progression notified. */
  readonly ran: number;
  readonly failed: readonly FailedGameExecution[];
  /**
   * Pending games of the tournament that this call left unexecuted: the per-call cap was
   * reached, the tournament is not RUNNING, or no job could be claimed for them. Call again
   * to continue the queue.
   */
  readonly skipped: number;
}

/** Outcome of executing exactly one game end-to-end. */
export interface GameExecutionResult {
  /**
   * COMPLETED: this call recorded the accepted result.
   * ALREADY_COMPLETED: the game already had one (a reclaimed lease after a crash/restart).
   */
  readonly status: 'COMPLETED' | 'ALREADY_COMPLETED';
  /** The accepted result plus the evidence a job completion pins for it. */
  readonly accepted: AcceptedResultSummary;
}

export type LeasedGameStatus = 'COMPLETED' | 'ALREADY_COMPLETED' | 'FAILED' | 'SKIPPED' | 'LEASE_LOST';

/** Outcome of one broker claim, keyed by the game the claimed job targeted. */
export interface LeasedGameRun {
  readonly gameId: string;
  readonly tournamentId: string | null;
  readonly status: LeasedGameStatus;
  readonly error?: string;
}

export interface RunLeasedGamesOptions {
  /** Maximum jobs claimed in this call. */
  readonly limit: number;
  /**
   * Restrict claims to these game ids (what the caller considers runnable right now).
   * Omitted → any queued GAME job is claimable.
   */
  readonly targetIds?: readonly string[];
  /** Claim identity; defaults to this process's worker identity. */
  readonly worker?: WorkerIdentity;
  /** Completion actor identity; defaults to this process's reconciler identity. */
  readonly reconciler?: ReconcilerIdentity;
}

/** Game row needed to prepare both bots, run the match and record the result. */
interface ExecutableGameRow {
  readonly id: string;
  readonly encounter_id: string;
  readonly tournament_id: string;
  readonly game_ordinal: number;
  readonly white_team_id: string;
  readonly black_team_id: string;
  /** Team display names, joined here so the live snapshot needs no second query. */
  readonly white_team_name: string;
  readonly black_team_name: string;
  readonly map_descriptor: MapDescriptor;
  readonly rules_revision: string;
  readonly status: string;
}

interface CandidateRow {
  readonly id: string;
  readonly source_digest: Digest;
  readonly language: BotLanguage;
  readonly entrypoint: string;
}

interface PreparedBot {
  readonly manifest: ProjectManifest;
  readonly config: BotConfig;
}

/** One orchestrator ply in wire terms: the frozen action shape plus the capture record. */
function toLiveTurnEvent(record: TurnRecord): LiveTurnInput {
  const action = record.action;
  return {
    turnNumber: record.turnNumber,
    side: record.player === PlayerSide.WHITE ? 1 : 2,
    action:
      action.action === 'MOVE'
        ? { action: 'MOVE', pieceId: action.pieceId, target: [action.target[0], action.target[1]] }
        : { action: 'PASS' },
    // Absent on PASS plies: a frame carries a capture only when one happened.
    ...(record.capture ? { capture: record.capture } : {}),
  };
}

/** The runner's verdict in wire terms; an unspecified winner is published as null. */
function toLiveResult(result: MatchResult): LiveResult {
  return {
    winner: result.winner === PlayerSide.WHITE ? 1 : result.winner === PlayerSide.BLACK ? 2 : null,
    reason: WinReason[result.winReason] ?? 'WIN_REASON_UNSPECIFIED',
  };
}

export class MatchExecutionService {
  private readonly defaultLimit: number;
  private readonly maxLimit: number;

  constructor(
    private readonly db: PostgresDatabase,
    /** Part of the declared service dependency surface (composition-root parity). */
    private readonly mapService: MapService,
    private readonly artifactStore: ArtifactStore,
    /** Same instance ResultService commits through (composition-root parity). */
    private readonly replayStore: ReplayStore,
    private readonly resultService: ResultService,
    private readonly scheduler: TournamentSchedulerService,
    /** Durable queue this service claims GAME jobs from and completes them through. */
    private readonly jobBroker: JobBroker,
    private readonly options: MatchExecutionOptions,
    /**
     * Spectator fan-out the games are published to. Defaulted so a service built outside the
     * composition root (tests, one-off tooling) still has a private, subscriber-less hub rather
     * than special-casing "no live streaming"; the API always passes the instance its route uses.
     */
    private readonly liveHub: LiveMatchHub = new LiveMatchHub()
  ) {
    this.defaultLimit = options.defaultLimit ?? DEFAULT_EXECUTION_LIMIT;
    this.maxLimit = options.maxLimit ?? MAX_EXECUTION_LIMIT;
  }

  /**
   * Executes up to `options.limit` pending games of a tournament through the job broker, in
   * schedule order, recording each accepted result and notifying the scheduler so the round
   * can advance. Answers in the shape the organizer route has always returned.
   *
   * A thin wrapper over {@link runLeasedGames}: it bootstraps the tournament's missing GAME
   * jobs (so an explicit organizer request works even when the autonomous worker never
   * ticked) and narrows the claims to that tournament's runnable games.
   *
   * Refuses outright (409 DEV_EXECUTION_DISABLED) unless `OANTUTI_DEV_EXECUTION=1`: this is
   * an unsandboxed development path.
   */
  async runPendingGames(
    tournamentId: string,
    runOptions: RunPendingGamesOptions = {}
  ): Promise<RunPendingGamesResult> {
    this.assertDevExecutionEnabled();
    const limit = this.resolveLimit(runOptions.limit);

    // Games are materialized as RUNNING by TournamentSchedulerService.persistSchedule
    // (games.status CHECK in 004-results.sql has no QUEUED state), so both PENDING and
    // RUNNING games count as pending here.
    const totalRes = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM games g
       JOIN encounters e ON e.id = g.encounter_id
       WHERE e.tournament_id = $1 AND g.status IN ('PENDING', 'RUNNING')`,
      [tournamentId]
    );
    const totalPending = Number.parseInt(totalRes.rows[0]?.count ?? '0', 10);

    await enqueueMissingGameJobs(this.db, this.jobBroker, { tournamentId, limit: totalPending });
    const runnable = await listRunnableGames(this.db, { tournamentId });

    const runs = await this.runLeasedGames({
      limit,
      targetIds: runnable.map((game) => game.gameId),
    });

    let ran = 0;
    const failed: FailedGameExecution[] = [];
    for (const run of runs) {
      if (run.status === 'COMPLETED' || run.status === 'ALREADY_COMPLETED') ran++;
      else if (run.status === 'FAILED') failed.push({ gameId: run.gameId, error: run.error ?? 'UNKNOWN' });
    }

    return { ran, failed, skipped: Math.max(0, totalPending - ran - failed.length) };
  }

  /**
   * Executes exactly one game: extracts both frozen submissions, runs the match, records the
   * verified result and notifies the scheduler. Every leased GAME job goes through here.
   *
   * Never records a second accepted result. A game that already has one — this lease was
   * reclaimed after a crash between recording and completing — reports ALREADY_COMPLETED and
   * still runs round progression, which is what heals an interrupted round advance.
   */
  async executeGameById(gameId: string): Promise<GameExecutionResult> {
    this.assertDevExecutionEnabled();
    const game = await this.loadGame(gameId);

    let accepted = await this.resultService.getAcceptedResultSummary(gameId);
    let status: GameExecutionResult['status'] = 'ALREADY_COMPLETED';
    if (!accepted) {
      try {
        await this.executeGame(game);
        status = 'COMPLETED';
      } catch (err) {
        if (!(err instanceof ResultAlreadyAcceptedError)) throw err;
        // Lost the race against another recorder; the guard rejected the second version.
      }
      accepted = await this.resultService.getAcceptedResultSummary(gameId);
      if (!accepted) {
        throw new MatchExecutionError(500, `ACCEPTED_RESULT_MISSING: game ${gameId} produced no accepted result`);
      }
    }

    await this.scheduler.handleGameCompletion(gameId);
    return { status, accepted };
  }

  /**
   * Claims and executes up to `options.limit` GAME jobs, one at a time:
   * `broker.claim` → execute → `broker.prepareCompletion` → `broker.complete`.
   *
   * Failures are reported per game as {@link LeasedGameRun} values instead of thrown, so one
   * bad game cannot abort a worker tick.
   */
  async runLeasedGames(options: RunLeasedGamesOptions): Promise<LeasedGameRun[]> {
    this.assertDevExecutionEnabled();
    const worker = options.worker ?? PROCESS_WORKER_IDENTITY;
    const reconciler = options.reconciler ?? PROCESS_RECONCILER_IDENTITY;
    const runs: LeasedGameRun[] = [];

    for (let index = 0; index < options.limit; index++) {
      const lease = await this.jobBroker.claim(
        worker,
        { buildSlots: 0, gameSlots: 1 },
        options.targetIds ? { targetIds: options.targetIds } : undefined
      );
      if (!lease) break;
      runs.push(await this.runLeasedGame(lease, reconciler));
    }
    return runs;
  }

  /** One claim → execute → pin → complete cycle, with the lease heartbeated while it runs. */
  private async runLeasedGame(lease: JobLease, reconciler: ReconcilerIdentity): Promise<LeasedGameRun> {
    const tournamentId = await this.resolveTournamentId(lease);

    // Pause gate: a game of a tournament that is not RUNNING must not be executed. The
    // worker's claim filter already leaves PAUSED tournaments' jobs un-leased — they keep
    // their attempts and stay QUEUED, so nothing is lost. This catches the narrow race where
    // the tournament was paused between filtering and claiming: there we skip without
    // completing, and the lease expiring hands the job back to the reconciler with backoff.
    if (tournamentId && !(await this.isTournamentRunning(tournamentId))) {
      return { gameId: lease.targetId, tournamentId, status: 'SKIPPED', error: 'TOURNAMENT_NOT_RUNNING' };
    }

    const stopHeartbeat = this.startHeartbeat(lease);
    try {
      const { status, accepted } = await this.executeGameById(lease.targetId);
      const completion = await this.jobBroker.prepareCompletion(lease.identity, accepted.evidence);
      await this.jobBroker.complete(
        {
          completionId: completion.data.completionId,
          evidenceDigest: completion.data.evidenceDigest,
          deploymentGeneration: lease.identity.deploymentGeneration,
        },
        reconciler
      );
      return { gameId: lease.targetId, tournamentId, status };
    } catch (err) {
      if (err instanceof JobBrokerError) {
        // Lease fencing refused our evidence: this lease is stale/expired or the job was
        // already completed, so the game belongs to another worker now. Never record again.
        return {
          gameId: lease.targetId,
          tournamentId,
          status: 'LEASE_LOST',
          error: `${err.code}: ${err.message}`,
        };
      }
      // Genuine execution fault (bot crash, missing submission, unverifiable trace): do not
      // complete. The lease expires, the reconciler requeues the job with backoff, and the
      // error is reported to the caller.
      return { gameId: lease.targetId, tournamentId, status: 'FAILED', error: describeError(err) };
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Renews the lease while a match runs (C++ compilation plus up to MAX_MATCH_TURNS plies can
   * exceed LEASE_TTL_SECONDS) and returns the stop function. Failures are only logged: a lease
   * that really is gone is caught by prepareCompletion's fencing check.
   */
  private startHeartbeat(lease: JobLease): () => void {
    const timer = setInterval(() => {
      void this.jobBroker
        .heartbeat(lease.identity)
        .then((status) => {
          if (status.status === 'STOP') {
            console.warn(`[execution] lease lost for job ${lease.identity.jobId}: ${status.reason}`);
          }
        })
        .catch((err: unknown) => {
          console.warn(`[execution] heartbeat failed for job ${lease.identity.jobId}: ${describeError(err)}`);
        });
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Tournament a claimed job belongs to: from its payload, else from the target game row. */
  private async resolveTournamentId(lease: JobLease): Promise<string | null> {
    const payload = lease.payload as { tournamentId?: unknown } | null | undefined;
    if (payload && typeof payload.tournamentId === 'string') return payload.tournamentId;

    const res = await this.db.query<{ tournament_id: string }>(
      `SELECT e.tournament_id
       FROM games g
       JOIN encounters e ON e.id = g.encounter_id
       WHERE g.id = $1`,
      [lease.targetId]
    );
    return res.rows[0]?.tournament_id ?? null;
  }

  private async isTournamentRunning(tournamentId: string): Promise<boolean> {
    const res = await this.db.query<{ state: string }>('SELECT state FROM tournaments WHERE id = $1', [tournamentId]);
    return res.rows[0]?.state === 'RUNNING';
  }

  /** Loads the game a job targets, rejecting rows that cannot be played. */
  private async loadGame(gameId: string): Promise<ExecutableGameRow> {
    const res = await this.db.query<ExecutableGameRow>(
      `SELECT g.id, g.encounter_id, e.tournament_id, g.game_ordinal, g.white_team_id, g.black_team_id,
              wt.name AS white_team_name, bt.name AS black_team_name,
              g.map_descriptor, g.rules_revision, g.status
       FROM games g
       JOIN encounters e ON e.id = g.encounter_id
       JOIN teams wt ON wt.id = g.white_team_id
       JOIN teams bt ON bt.id = g.black_team_id
       WHERE g.id = $1`,
      [gameId]
    );
    const game = res.rows[0];
    if (!game) throw new MatchExecutionError(404, `GAME_NOT_FOUND: ${gameId}`);
    if (game.status === 'CANCELLED') {
      throw new MatchExecutionError(409, `GAME_CANCELLED: ${gameId} cannot be executed`);
    }
    return game;
  }

  /**
   * Prepares both bot workspaces, runs the match and records the verified result. Round
   * progression is the caller's step (`executeGameById`), so a crash between the two is
   * healed by replaying the job.
   *
   * The run is published live: the channel is opened once both bots are ready, every ply is
   * pushed as it is played, and the channel is finished in the `finally` so spectators see a
   * result even when the run faults after the match (evidence/recording failures included).
   * Opening only after both bots materialized keeps a failed preparation from leaving a
   * RUNNING channel behind — the hub never sees a game that did not start.
   */
  private async executeGame(game: ExecutableGameRow): Promise<void> {
    const white = await this.prepareBot(game.tournament_id, game.white_team_id, game.id, 'white');
    const black = await this.prepareBot(game.tournament_id, game.black_team_id, game.id, 'black');

    const manifestDigest = this.computeManifestDigest(game.rules_revision, white.manifest, black.manifest);

    this.liveHub.openGame({
      gameId: game.id,
      map: game.map_descriptor,
      whiteTeam: { id: game.white_team_id, name: game.white_team_name },
      blackTeam: { id: game.black_team_id, name: game.black_team_name },
    });

    const startedAt = process.hrtime.bigint();
    let liveResult: LiveResult | null = null;
    try {
      const result = await new MatchOrchestrator({
        matchId: game.id,
        mapDescriptor: game.map_descriptor,
        whiteBotConfig: white.config,
        blackBotConfig: black.config,
        maxTurns: MAX_MATCH_TURNS,
        onTurn: (record: TurnRecord) => this.liveHub.publishTurn(game.id, toLiveTurnEvent(record)),
      }).runMatch();
      liveResult = toLiveResult(result);

      const wallUsec = ((process.hrtime.bigint() - startedAt) / 1000n).toString();
      const evidence = this.buildEvidence(game, result, wallUsec);

      await this.resultService.recordResult({
        gameId: game.id,
        attemptId: randomUUID(),
        evidence,
        manifestDigest,
        mapDescriptor: game.map_descriptor,
      });
    } finally {
      // RESULT carries the match outcome, not the recording outcome: it is published as soon as
      // the match is decided. A run that faulted before producing one closes the game flat with
      // a null winner rather than leaving spectators on a game that will never play another ply.
      this.liveHub.finishGame(game.id, liveResult ?? LIVE_EXECUTION_FAILED_RESULT);
    }
  }

  /**
   * Freezes the team's candidate submission (latest READY receipt, mirroring the lock-time
   * freeze in TournamentLifecycleService), extracts it into the spool and resolves the
   * per-language launch command.
   */
  private async prepareBot(
    tournamentId: string,
    teamId: string,
    gameId: string,
    side: 'white' | 'black'
  ): Promise<PreparedBot> {
    const candidate = await this.loadCandidate(tournamentId, teamId, side);
    const rootDir = path.join(this.options.spoolDir, gameId, side);

    // Extraction, intake limits, digest equality and entrypoint resolution are shared with the
    // build pipeline (submissions/source-materializer.ts), so the workspace a READY receipt was
    // smoke-tested in is exactly the workspace it runs matches in.
    try {
      const materialized = await materializeSource({
        artifactStore: this.artifactStore,
        sourceDigest: candidate.source_digest,
        language: candidate.language,
        entrypoint: candidate.entrypoint,
        spoolDir: rootDir,
      });

      return {
        manifest: materialized.manifest,
        config: await this.buildBotConfig(candidate, materialized.workDir, materialized.entryPath),
      };
    } catch (err) {
      // ArtifactError from the intake validator keeps propagating unchanged, as it always did.
      if (err instanceof SourceMaterializationError) throw new MatchExecutionError(err.statusCode, err.message);
      throw err;
    }
  }

  private async loadCandidate(tournamentId: string, teamId: string, side: string): Promise<CandidateRow> {
    // Official games must play the artifact frozen at lock time (same hash for every game of the
    // tournament). The latest-READY fallback only covers entries that predate the freeze.
    const frozen = await this.db.query<CandidateRow>(
      `SELECT s.id, s.source_digest, s.language, s.entrypoint
       FROM tournament_entries e
       JOIN submissions s ON s.id = e.frozen_submission_id
       WHERE e.tournament_id = $1 AND e.team_id = $2
       LIMIT 1`,
      [tournamentId, teamId]
    );
    if (frozen.rows[0]) return frozen.rows[0];

    const res = await this.db.query<CandidateRow>(
      `SELECT id, source_digest, language, entrypoint
       FROM submissions
       WHERE tournament_id = $1 AND team_id = $2 AND status = 'READY'
       ORDER BY receipt_ordinal DESC
       LIMIT 1`,
      [tournamentId, teamId]
    );
    const candidate = res.rows[0];
    if (!candidate) {
      throw new MatchExecutionError(
        409,
        `NO_READY_SUBMISSION: ${side} team ${teamId} has no READY submission for tournament ${tournamentId}`
      );
    }
    return candidate;
  }

  /** Builds the per-language launch command; C++ sources are compiled first, cached per digest. */
  private async buildBotConfig(
    candidate: CandidateRow,
    rootDir: string,
    entrypointPath: string
  ): Promise<BotConfig> {
    if (candidate.language === 'CPP') {
      const binaryPath = await this.compileCpp(candidate.source_digest, rootDir, entrypointPath);
      const launch = resolveLaunch('CPP', entrypointPath, rootDir, { cppBinaryPath: binaryPath });
      return { path: launch.executablePath, command: launch.command, args: [...launch.args] };
    }

    const launch = resolveLaunch(candidate.language, entrypointPath, rootDir);
    return { path: launch.executablePath, command: launch.command, args: [...launch.args] };
  }

  /**
   * Compiles a C++ submission once per source digest into the spool. The OanTuTi C++ SDK is
   * header-only (`sdk/cpp/oantuti.hpp`), so the repo SDK directory is on the include path
   * alongside the extracted workspace.
   */
  private async compileCpp(sourceDigest: Digest, rootDir: string, sourcePath: string): Promise<string> {
    const binaryPath = path.join(this.options.spoolDir, 'cpp', sourceDigest, 'bot');
    if (existsSync(binaryPath)) return binaryPath;

    try {
      await compileCppBinary({
        sourcePath,
        workDir: rootDir,
        binaryPath,
        includeDirs: [path.resolve(process.cwd(), 'sdk/cpp')],
        timeoutMs: CPP_COMPILE_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof SourceCompileError) throw new MatchExecutionError(500, err.message);
      throw err;
    }
    return binaryPath;
  }

  /**
   * Builds the evidence exactly as TraceVerifier expects it.
   *
   * The runner decides the match with the v1 rules, while the verifier re-adjudicates with
   * the v2 rules: the outcome (winner/reason/disposition) is therefore re-derived here by
   * replaying the trace through the v2 engine, so the recorded evidence is precisely what
   * the verifier recomputes. When the trace is not a v2-terminal game the runner stopped on
   * a bot fault (crash, timeout, illegal move, protocol violation) and the result is
   * recorded as a forfeit win for the surviving side.
   */
  private buildEvidence(game: ExecutableGameRow, result: MatchResult, wallUsec: string): GameResultEvidence {
    const trace: ActionTraceStep[] = [];
    for (const turn of result.turns) {
      const action = turn.action;
      // The runner only records PASS for a genuine stalemate, which is already terminal.
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

    const outcome = this.replayTrace(game.map_descriptor, trace);
    if (outcome.isGameOver) {
      return {
        gameId: game.id,
        winner: outcome.winner === PlayerSide.WHITE ? 1 : outcome.winner === PlayerSide.BLACK ? 2 : 0,
        reason: outcome.reason ?? 'WIN_REASON_UNSPECIFIED',
        disposition: outcome.disposition ?? 'DECISIVE',
        executionStatus: 'COMPLETED',
        rulesRevision: game.rules_revision,
        totalPly: trace.length,
        trace,
        wallUsec,
      };
    }

    const winner = result.winner === PlayerSide.WHITE ? 1 : result.winner === PlayerSide.BLACK ? 2 : 0;
    if (winner === 0) {
      throw new MatchExecutionError(
        500,
        `FORFEIT_WITHOUT_WINNER: match ${game.id} ended with ${WinReason[result.winReason]} but no winning side`
      );
    }
    return {
      gameId: game.id,
      winner,
      reason: WinReason[result.winReason] ?? 'WIN_REASON_UNSPECIFIED',
      disposition: 'DECISIVE',
      executionStatus: 'BOT_FORFEIT',
      rulesRevision: game.rules_revision,
      totalPly: trace.length,
      trace,
      wallUsec,
    };
  }

  /**
   * Replays a move trace with the v2 rules and returns the terminal outcome.
   *
   * Mirrors TraceVerifier.verify() step for step — same engine calls, same break on the
   * first v2-terminal state, same final evaluateVictoryV2() — so the evidence produced
   * above is accepted by the verifier. Keep both loops in lockstep.
   */
  private replayTrace(mapDescriptor: MapDescriptor, trace: readonly ActionTraceStep[]): V2Outcome {
    const topology = createMapTopology(mapDescriptor);
    let state = createInitialGameState(topology, mapDescriptor.startingPieces, MAX_MATCH_TURNS);

    for (const step of trace) {
      const moveAction: MoveAction = {
        pieceId: step.move.pieceId,
        targetPos: { x: step.move.targetPos.x, y: step.move.targetPos.y },
      };
      if (!isLegalMove(state, moveAction)) {
        throw new MatchExecutionError(
          500,
          `TRACE_ILLEGAL_MOVE: ply ${step.ply} piece ${step.move.pieceId} to (${step.move.targetPos.x}, ${step.move.targetPos.y})`
        );
      }
      const applied = applyMoveV2(state, moveAction);
      state = applied.nextState;
      if (applied.outcome.isGameOver) break;
    }

    return evaluateVictoryV2(state);
  }

  /**
   * Deterministic digest identifying the exact pair of bot builds that produced a result:
   * SHA-256 over `{"rulesRevision":…,"white":<manifest>,"black":<manifest>}`, JSON stringified
   * with a fixed key order. Both manifests come from ArtifactStore's
   * computeCanonicalManifest (files sorted by ascending path, stable key order) and are never
   * re-read from JSONB, so the digest is reproducible from the two source ZIPs plus the
   * rules revision alone.
   */
  private computeManifestDigest(
    rulesRevision: string,
    white: ProjectManifest,
    black: ProjectManifest
  ): Digest {
    const canonical = JSON.stringify({ rulesRevision, white, black });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private resolveLimit(requested?: number): number {
    if (requested === undefined) return this.defaultLimit;
    if (!Number.isInteger(requested) || requested <= 0 || requested > this.maxLimit) {
      throw new MatchExecutionError(400, `INVALID_LIMIT: limit must be an integer between 1 and ${this.maxLimit}`);
    }
    return requested;
  }

  private assertDevExecutionEnabled(): void {
    if (process.env[DEV_EXECUTION_FLAG] !== '1') throw new DevExecutionDisabledError();
  }
}
