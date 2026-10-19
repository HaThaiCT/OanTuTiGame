/**
 * Development-only autonomous round driver and durable-job worker.
 *
 * After the single organizer `start`, rounds must advance without further admin actions.
 * Each tick this worker:
 *   1. reconciles expired leases (`JobReconciler.reconcile`), so work stranded by a crashed
 *      or restarted process comes back with backoff,
 *   2. claims and executes up to `buildsPerTick` BUILD/TEST_BUILD jobs through BuildPipeline —
 *      a receipt is only usable once it has been compiled and smoke-tested, and the pool is
 *      drained before any match is claimed,
 *   3. claims and executes up to `testsPerTick` TEST_GAME jobs through PrivateTestRunner — a
 *      private test whose build was accepted plays its own match and writes its own result, so
 *      it leaves no official trace at all; a FAILED verdict is still a finished job,
 *   4. bootstraps a GAME job for every runnable game that has none (pre-existing dev data,
 *      rounds persisted before this pipeline existed, jobs lost to a crash),
 *   5. seals every round whose post-round grace window has elapsed (a round whose last encounter
 *      went terminal at least `grace_period_minutes` ago and has no open dispute), dispatching
 *      its next round, so the games created here are claimable in this same tick,
 *   6. claims and executes up to `gamesPerTick` GAME jobs through MatchExecutionService — the
 *      unsandboxed development executor, which itself refuses to run unless
 *      `OANTUTI_DEV_EXECUTION=1`.
 *
 * Sealing runs before any game is claimed and outside the `gamesPerTick` budget: a worker
 * configured with `gamesPerTick: 0` still advances every round that is ready to seal.
 *
 * Private tests are drained between builds and official games: they are the lowest-priority
 * queue (priority 50, below GAME's 100), so practice runs must never delay a round.
 *
 * The runner is inert (no timer, no polling) unless that same flag is set, so importing it in
 * production composition is side-effect free.
 *
 * Pause gate: claims are narrowed to games of tournaments in state RUNNING (see
 * `listRunnableGames`), so a PAUSED tournament's jobs stay QUEUED and un-leased: they keep
 * their attempts and the work resumes by itself when the tournament resumes. The alternative
 * — claiming and skipping — would burn one of the job's three attempts per tick and end up
 * BLOCKED, i.e. it would lose the job. Private tests carry no tournament-state gate: a test may
 * be requested — and played — in any tournament state, exactly like `createPrivateTest` allows.
 */

import { createHash } from 'node:crypto';
import type { CompletionEvidence, Digest, JobLease } from '@oantuti/protocol';
import type { BuildPipeline } from '../builds/build-pipeline.js';
import type { PrivateTestRunner } from '../builds/private-test-runner.js';
import { LEASE_HEARTBEAT_SECONDS, type JobBroker } from '../jobs/broker.js';
import {
  DEFAULT_RUNNABLE_GAMES_LIMIT,
  enqueueMissingGameJobs,
  listRunnableGames,
  type RunnableGameRef,
} from '../jobs/game-jobs.js';
import { PROCESS_RECONCILER_IDENTITY, PROCESS_WORKER_IDENTITY } from '../jobs/identity.js';
import type { JobReconciler } from '../jobs/reconciler.js';
import type { RetentionService } from '../operations/retention-service.js';
import type { PostgresDatabase } from '../persistence/db.js';
import type { LeasedGameRun, MatchExecutionService } from './execution-service.js';
import type { TournamentSchedulerService } from './scheduler-service.js';

/** Env flag that arms both the dev executor and this driver. Anything but '1' leaves it off. */
const DEV_EXECUTION_FLAG = 'OANTUTI_DEV_EXECUTION';

const DEFAULT_INTERVAL_MS = 5_000;

/** Retention is a daily-ish duty: six hours keeps the dev worker from re-scanning constantly. */
const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GAMES_PER_TICK = 4;
const DEFAULT_BUILDS_PER_TICK = 4;
const DEFAULT_TESTS_PER_TICK = 4;

/**
 * Priority of a private-test execution job: below GAME (100), so practice never delays a round,
 * and equal to the spec'd `enqueueIfAbsent('TEST_GAME', testId, 50, {})`.
 */
const TEST_GAME_JOB_PRIORITY = 50;

/** Lease renewal period while a private test plays; a third of the TTL, like the executor's. */
const HEARTBEAT_INTERVAL_MS = LEASE_HEARTBEAT_SECONDS * 1_000;

/** Grouping key for outcomes whose job carried no resolvable tournament. */
const UNKNOWN_TOURNAMENT = 'UNKNOWN';

export interface TournamentAutoRunnerOptions {
  /** Poll period between ticks. */
  readonly intervalMs?: number;
  /** GAME jobs claimed and executed per tick, across any tournament. */
  readonly gamesPerTick?: number;
  /** BUILD/TEST_BUILD jobs claimed and executed per tick, before any GAME job. */
  readonly buildsPerTick?: number;
  /** TEST_GAME jobs claimed and executed per tick, after builds and before GAME jobs. */
  readonly testsPerTick?: number;
  /**
   * Retention sweeper. TTL classes are swept at most every `retentionIntervalMs`, not every tick.
   */
  readonly retentionService?: RetentionService;
  /** How often the retention sweep may run. Defaults to 6 hours (env override available). */
  readonly retentionIntervalMs?: number;
  /** Cap on the runnable-game scan per tick (bootstrap and claim filter). */
  readonly runnableGamesLimit?: number;
  readonly controlPlaneManaged?: boolean;
}

/** One tournament's outcome inside a tick. `failed` counts games the executor rejected. */
export interface AutoRunnerTournamentResult {
  readonly tournamentId: string;
  readonly ran: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface AutoRunnerStats {
  /** Whether the dev execution flag is set (the runner only polls when it is). */
  readonly enabled: boolean;
  readonly intervalMs: number;
  /** True while a tick is in flight. */
  readonly running: boolean;
  /** ISO timestamp of the last completed tick, or null if it never ran. */
  readonly lastTickAt: string | null;
  /** Per-tournament results of the last completed tick. */
  readonly lastResults: readonly AutoRunnerTournamentResult[];
  /** Configured interval between automatic retention sweeps, in milliseconds. */
  readonly retentionIntervalMs: number;
  /** ISO timestamp of the last automatic retention sweep, or null if none ran yet. */
  readonly lastRetentionSweepAt: string | null;
  /** What the last automatic sweep did, per retention class. */
  readonly lastRetentionSweep: {
    readonly at: string;
    readonly actions: readonly { readonly className: string; readonly rows: number }[];
  } | null;
  /** GAME jobs created by the bootstrap, cumulative since process start. */
  readonly jobsEnqueued: number;
  /** GAME jobs completed — or found already complete — cumulative since process start. */
  readonly jobsCompleted: number;
  /** BUILD/TEST_BUILD jobs finished with an accepted receipt (READY/COMPLETED). */
  readonly buildsCompleted: number;
  /** BUILD/TEST_BUILD jobs finished with a rejection (REJECTED/FAILED). */
  readonly buildsRejected: number;
  /** TEST_GAME jobs whose private test finished COMPLETED. */
  readonly testsCompleted: number;
  /** TEST_GAME jobs whose private test finished FAILED — still a successfully finished job. */
  readonly testsFailed: number;
  /** Leases requeued by the reconciler, cumulative since process start. */
  readonly leasesRequeued: number;
  /** REGISTRATION_OPEN tournaments auto-closed after their deadline passed, cumulative since process start. */
  readonly registrationsClosed: number;
}

interface TournamentTickStat {
  pending: number;
  ran: number;
  failed: number;
  claimed: number;
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class TournamentAutoRunner {
  private readonly intervalMs: number;
  private readonly gamesPerTick: number;
  private readonly buildsPerTick: number;
  private readonly testsPerTick: number;
  private readonly runnableGamesLimit: number;
  private readonly controlPlaneManaged: boolean;

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastTickAt: Date | null = null;
  private readonly retentionService?: RetentionService;
  private readonly retentionIntervalMs: number;
  private lastRetentionSweepAt: Date | null = null;
  private lastRetentionSweep: {
    at: string;
    actions: { className: string; rows: number }[];
  } | null = null;
  private lastResults: AutoRunnerTournamentResult[] = [];
  private jobsEnqueued = 0;
  private jobsCompleted = 0;
  private buildsCompleted = 0;
  private buildsRejected = 0;
  private testsCompleted = 0;
  private testsFailed = 0;
  private leasesRequeued = 0;
  private registrationsClosed = 0;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly executionService: MatchExecutionService,
    private readonly jobBroker: JobBroker,
    private readonly reconciler: JobReconciler,
    /** Compile + smoke-test gate every receipt passes before a match may freeze it. */
    private readonly buildPipeline: BuildPipeline,
    /** Executes a private test once its build was accepted; leaves no official trace. */
    private readonly privateTestRunner: PrivateTestRunner,
    /** Seals rounds whose grace window elapsed, so the next round's games become claimable. */
    private readonly scheduler: TournamentSchedulerService,
    options: TournamentAutoRunnerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.controlPlaneManaged = options.controlPlaneManaged ?? false;
    this.retentionService = options.retentionService;
    const envInterval = Number(process.env.OANTUTI_RETENTION_INTERVAL_MS ?? '');
    this.retentionIntervalMs =
      options.retentionIntervalMs ??
      (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_RETENTION_INTERVAL_MS);
    this.gamesPerTick = options.gamesPerTick ?? DEFAULT_GAMES_PER_TICK;
    this.buildsPerTick = options.buildsPerTick ?? DEFAULT_BUILDS_PER_TICK;
    this.testsPerTick = options.testsPerTick ?? DEFAULT_TESTS_PER_TICK;
    this.runnableGamesLimit = options.runnableGamesLimit ?? DEFAULT_RUNNABLE_GAMES_LIMIT;
  }

  /** No-op unless `OANTUTI_DEV_EXECUTION=1`; otherwise polls and ticks once right away. */
  start(): void {
    if (process.env[DEV_EXECUTION_FLAG] !== '1' || this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // Never keep the process alive just for the dev poller.
    this.timer.unref();
    void this.runOnce();
  }

  /** Clears the poll timer; safe to call repeatedly (including when never started). */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Executes a single tick: reconcile leases, drain the build queue, bootstrap missing GAME
   * jobs, then claim and execute games. Each phase is isolated so a broker hiccup in one cannot
   * abort the others, and overlapping calls are skipped (reporting the previous tick's results).
   */
  async runOnce(): Promise<readonly AutoRunnerTournamentResult[]> {
    if (this.inFlight) return this.lastResults;
    this.inFlight = true;
    try {
      if (!this.controlPlaneManaged) {
      try {
        const report = await this.reconciler.reconcile(PROCESS_RECONCILER_IDENTITY);
        this.leasesRequeued += report.expiredLeasesReclaimed;
      } catch (err: unknown) {
        console.warn(`[auto-runner] lease reconciliation failed: ${describeError(err)}`);
      }

      // Intake whose deadline passed closes before anything else: builds must drain before lock.
      try {
        this.registrationsClosed += await this.sweepRegistrationDeadlines();
      } catch (err: unknown) {
        console.warn(`[auto-runner] registration deadline sweep failed: ${describeError(err)}`);
      }
      }

      // Builds first: a receipt a match would freeze must already have passed its smoke test,
      // and this is the only thing that moves a receipt out of VALIDATING.
      try {
        await this.runBuildJobs();
      } catch (err: unknown) {
        console.warn(`[auto-runner] build execution failed: ${describeError(err)}`);
      }

      // Private tests next: a snapshot whose build was just accepted plays its match here, so a
      // team sees its result without a practice run ever competing with a round for slots.
      try {
        await this.runTestGameJobs();
      } catch (err: unknown) {
        console.warn(`[auto-runner] private test execution failed: ${describeError(err)}`);
      }

      if (!this.controlPlaneManaged) {
      // Seal every round whose grace window has elapsed before anything is claimed, so the games
      // a seal creates are visible to both the bootstrap below and this tick's claim. Runs outside
      // the `gamesPerTick` budget: a worker that claims no games must still advance rounds.
      try {
        await this.scheduler.sealEligibleRounds();
      } catch (err: unknown) {
        console.warn(`[auto-runner] round sealing failed: ${describeError(err)}`);
      }

      try {
        this.jobsEnqueued += await enqueueMissingGameJobs(this.db, this.jobBroker, {
          limit: this.runnableGamesLimit,
        });
      } catch (err: unknown) {
        console.warn(`[auto-runner] GAME job bootstrap failed: ${describeError(err)}`);
      }

      // Retention is a TTL duty, so it runs at most every `retentionIntervalMs` — not per tick.
      if (this.retentionService) {
        const due =
          !this.lastRetentionSweepAt ||
          Date.now() - this.lastRetentionSweepAt.getTime() >= this.retentionIntervalMs;
        if (due) {
          try {
            const swept = await this.retentionService.sweepAsSystem(false);
            this.lastRetentionSweepAt = new Date();
            this.lastRetentionSweep = {
              at: this.lastRetentionSweepAt.toISOString(),
              actions: swept.actions.map((action) => ({ className: action.className, rows: action.rows })),
            };
          } catch (err: unknown) {
            console.warn(`[auto-runner] retention sweep failed: ${describeError(err)}`);
          }
        }
      }
      }

      try {
        const runnable = await listRunnableGames(this.db, { limit: this.runnableGamesLimit });
        const runs = await this.executionService.runLeasedGames({
          limit: this.gamesPerTick,
          targetIds: runnable.map((game) => game.gameId),
          worker: PROCESS_WORKER_IDENTITY,
          reconciler: PROCESS_RECONCILER_IDENTITY,
        });
        this.lastResults = this.summariseTick(runnable, runs);
      } catch (err: unknown) {
        console.warn(`[auto-runner] game execution failed: ${describeError(err)}`);
      }
      return this.lastResults;
    } finally {
      this.lastTickAt = new Date();
      this.inFlight = false;
    }
  }

  /**
   * Claims and executes up to `buildsPerTick` BUILD/TEST_BUILD jobs, one at a time, before any
   * GAME job is claimed. A rejected build is a *finished* job — the verdict is recorded and the
   * job is completed with evidence — so only infrastructure faults (DB error, lost lease,
   * spawn crash) leave the lease to expire and let the reconciler requeue it.
   */
  private async runBuildJobs(): Promise<void> {
    for (let index = 0; index < this.buildsPerTick; index++) {
      const lease = await this.jobBroker.claim(PROCESS_WORKER_IDENTITY, { buildSlots: 1, gameSlots: 0 });
      if (!lease) return;

      try {
        const outcome =
          lease.jobType === 'TEST_BUILD'
            ? await this.buildPipeline.buildTestSnapshot(lease.targetId)
            : lease.jobType === 'BUILD'
              ? await this.buildPipeline.buildSubmission(lease.targetId)
              : undefined;
        if (!outcome) {
          // GAME/TEST_GAME jobs are not offered to a build-only claim; completing one here would
          // be wrong, so hand it back by letting the lease expire.
          console.warn(`[auto-runner] build claim returned a ${lease.jobType} job ${lease.identity.jobId}`);
          continue;
        }

        const accepted = outcome.status === 'READY' || outcome.status === 'COMPLETED';

        // An accepted private-test build makes the snapshot runnable. Its execution job is
        // enqueued *before* the build job is completed, so a crash in between cannot lose the
        // run; `enqueueIfAbsent` keeps a re-delivered TEST_BUILD job from buying a second one.
        if (lease.jobType === 'TEST_BUILD' && outcome.status === 'COMPLETED') {
          await this.jobBroker.enqueueIfAbsent('TEST_GAME', lease.targetId, TEST_GAME_JOB_PRIORITY, {});
        }

        const completion = await this.jobBroker.prepareCompletion(
          lease.identity,
          this.buildEvidence(outcome.status, outcome.reason, outcome.sourceDigest, outcome.stderrDigest)
        );
        await this.jobBroker.complete(
          {
            completionId: completion.data.completionId,
            evidenceDigest: completion.data.evidenceDigest,
            deploymentGeneration: lease.identity.deploymentGeneration,
          },
          PROCESS_RECONCILER_IDENTITY
        );

        if (accepted) this.buildsCompleted++;
        else this.buildsRejected++;
      } catch (err: unknown) {
        console.warn(`[auto-runner] build job ${lease.identity.jobId} failed: ${describeError(err)}`);
      }
    }
  }

  /**
   * Claims and executes up to `testsPerTick` TEST_GAME jobs, one at a time, after builds and
   * before any official GAME job. The claim is narrowed to `TEST_GAME` so a practice run can never
   * take an official game's slot offer, and both verdicts finish the job: a FAILED private test is
   * still work that completed, with its cause recorded on the snapshot. Only infrastructure faults
   * — a DB error while recording the verdict — leave the lease to expire for the reconciler.
   *
   * The lease is heartbeated while the match plays: up to `MAX_MATCH_TURNS` plies can outlive the
   * 30-second lease, and a stolen lease would let a second worker observe the snapshot mid-run.
   */
  private async runTestGameJobs(): Promise<void> {
    for (let index = 0; index < this.testsPerTick; index++) {
      const lease = await this.jobBroker.claim(
        PROCESS_WORKER_IDENTITY,
        { buildSlots: 0, gameSlots: 1 },
        { jobTypes: ['TEST_GAME'] }
      );
      if (!lease) return;

      const stopHeartbeat = this.startLeaseHeartbeat(lease);
      try {
        const outcome = await this.privateTestRunner.runPrivateTest(lease.targetId);
        const completion = await this.jobBroker.prepareCompletion(
          lease.identity,
          this.testGameEvidence(lease.targetId, outcome.status, outcome.reason)
        );
        await this.jobBroker.complete(
          {
            completionId: completion.data.completionId,
            evidenceDigest: completion.data.evidenceDigest,
            deploymentGeneration: lease.identity.deploymentGeneration,
          },
          PROCESS_RECONCILER_IDENTITY
        );

        if (outcome.status === 'COMPLETED') this.testsCompleted++;
        else this.testsFailed++;
      } catch (err: unknown) {
        console.warn(`[auto-runner] private test job ${lease.identity.jobId} failed: ${describeError(err)}`);
      } finally {
        stopHeartbeat();
      }
    }
  }

  /**
   * Renews a claimed lease while a private test plays and returns the stop function. Failures are
   * only logged: a lease that really is gone is caught by prepareCompletion's fencing check.
   */
  private startLeaseHeartbeat(lease: JobLease): () => void {
    const timer = setInterval(() => {
      void this.jobBroker
        .heartbeat(lease.identity)
        .then((status) => {
          if (status.status === 'STOP') {
            console.warn(`[auto-runner] lease lost for job ${lease.identity.jobId}: ${status.reason}`);
          }
        })
        .catch((err: unknown) => {
          console.warn(`[auto-runner] heartbeat failed for job ${lease.identity.jobId}: ${describeError(err)}`);
        });
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Evidence pinned to a TEST_GAME job's completion: which snapshot ran, its verdict and, for a
   * failure, why. As with builds the trace/replay digests are the digest of this payload itself —
   * a private test's replay is stored on the snapshot, never as an official result.
   */
  private testGameEvidence(testId: string, status: string, reason: string | undefined): CompletionEvidence {
    const details = {
      testId,
      status,
      ...(reason === undefined ? {} : { reason }),
    };
    const digest = createHash('sha256').update(JSON.stringify(details)).digest('hex');

    // The in-process executor hands the private-test service a real match, but only reports its
    // status back: this pin is a summary of the job's verdict, not the engine's trace digests.
    return {
      kind: 'TEST_GAME',
      game: {
        verdict: status === 'COMPLETED' ? 'DECISIVE' : 'NO_CONTEST',
        reason: status,
        actionTraceDigest: digest,
        replayDigest: digest,
        manifestDigest: digest,
        cpuUsec: '0',
        wallUsec: '0',
        details,
      },
    };
  }

  /**
   * Evidence pinned to a development build job's completion. The in-process executor gates source
   * and stores what it built, but it runs no sandbox: there is no image digest, no measured
   * toolchain and no compiled artifact. The verdict is therefore named `DEV_SOURCE_GATE` (03 §173)
   * rather than dressed up as a sandboxed build, and carries exactly the facts it has.
   */
  private buildEvidence(
    status: string,
    reason: string | undefined,
    sourceDigest: Digest,
    diagnosticDigest: Digest
  ): CompletionEvidence {
    return {
      kind: 'BUILD',
      build: {
        outcome: 'DEV_SOURCE_GATE',
        accepted: status === 'READY' || status === 'COMPLETED',
        sourceDigest,
        diagnosticDigest,
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }

  /**
   * Per-tournament view of one tick. `skipped` counts this tournament's runnable games that
   * were not claimed (per-tick cap, or a job that could not be claimed), keeping the
   * pre-broker `{tournamentId, ran, failed, skipped}` shape.
   */
  private summariseTick(
    runnable: readonly RunnableGameRef[],
    runs: readonly LeasedGameRun[]
  ): AutoRunnerTournamentResult[] {
    const stats = new Map<string, TournamentTickStat>();
    const statFor = (tournamentId: string): TournamentTickStat => {
      let stat = stats.get(tournamentId);
      if (!stat) {
        stat = { pending: 0, ran: 0, failed: 0, claimed: 0 };
        stats.set(tournamentId, stat);
      }
      return stat;
    };

    for (const game of runnable) statFor(game.tournamentId).pending++;

    for (const run of runs) {
      const stat = statFor(run.tournamentId ?? UNKNOWN_TOURNAMENT);
      stat.claimed++;
      if (run.status === 'COMPLETED' || run.status === 'ALREADY_COMPLETED') {
        stat.ran++;
        this.jobsCompleted++;
      } else if (run.status === 'FAILED') {
        stat.failed++;
      }
    }

    return [...stats.entries()].map(([tournamentId, stat]) => ({
      tournamentId,
      ran: stat.ran,
      failed: stat.failed,
      skipped: Math.max(0, stat.pending - stat.claimed),
    }));
  }

  stats(): AutoRunnerStats {
    return {
      enabled: process.env[DEV_EXECUTION_FLAG] === '1',
      intervalMs: this.intervalMs,
      running: this.inFlight,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      lastResults: this.lastResults,
      retentionIntervalMs: this.retentionIntervalMs,
      lastRetentionSweepAt: this.lastRetentionSweepAt ? this.lastRetentionSweepAt.toISOString() : null,
      lastRetentionSweep: this.lastRetentionSweep,
      jobsEnqueued: this.jobsEnqueued,
      jobsCompleted: this.jobsCompleted,
      buildsCompleted: this.buildsCompleted,
      buildsRejected: this.buildsRejected,
      testsCompleted: this.testsCompleted,
      testsFailed: this.testsFailed,
      leasesRequeued: this.leasesRequeued,
      registrationsClosed: this.registrationsClosed,
    };
  }

  /**
   * Closes intake for tournaments whose registration deadline has passed
   * (REGISTRATION_OPEN → VALIDATING_SUBMISSIONS) and emits the draining event.
   */
  private async sweepRegistrationDeadlines(): Promise<number> {
    return this.db.withTransaction(async (client) => {
      const closed = await client.query<{ id: string }>(
        `UPDATE tournaments
         SET state = 'VALIDATING_SUBMISSIONS',
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE state = 'REGISTRATION_OPEN'
           AND registration_closes_at IS NOT NULL
           AND registration_closes_at <= clock_timestamp()
         RETURNING id`
      );
      for (const row of closed.rows) {
        await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'REGISTRATION_CLOSED',
          JSON.stringify({ tournamentId: row.id, reason: 'REGISTRATION_DEADLINE' }),
        ]);
        await client.query(`INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`, [
          'TOURNAMENT_DRAINING',
          JSON.stringify({ tournamentId: row.id, reason: 'REGISTRATION_DEADLINE' }),
        ]);
      }
      return closed.rows.length;
    });
  }
}
