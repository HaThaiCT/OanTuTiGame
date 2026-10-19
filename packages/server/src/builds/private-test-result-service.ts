/**
 * Private-test results: the state machine and the verified recording of the execution leg.
 *
 * A private test is a real match whose entire outcome lives on the `test_snapshots` row it was
 * launched from (migration 011). The execution leg is
 *
 *   QUEUED → COMPILING → SMOKE_TESTING → COMPLETED → RUNNING → COMPLETED (result_payload)
 *                                                         ↘ FAILED    ({error} in payload)
 *
 * where `COMPLETED` with a NULL payload is the *runnable* state: the control plane claims it to
 * RUNNING when it hands a worker the `TEST_GAME` assignment, and settles it here. Every transition
 * below is one conditional statement, so two workers can never both own a snapshot and a retried
 * job can never rewrite a recorded verdict.
 *
 * Nothing in this module touches an official table: no accepted result, no result version, no
 * rating event, no receipt ordinal, no frozen candidate, not even a `replay_objects` row. The only
 * rows written are the snapshot itself plus — on the verified path — the immutable replay object
 * the snapshot then names, which is promoted *before* the row can name its digest so a stored
 * `replay_digest` always resolves to bytes.
 *
 * The verified path mirrors the official one: the pinned map and the supervisor observations are
 * re-proven by the Rust rules verifier, and the row is settled in a transaction that only succeeds
 * while this attempt still holds the claim.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { MapDescriptor } from '@oantuti/engine';
import type {
  Digest,
  GameResultEvidence,
  ResultEvidence,
  TestOpponentRef,
} from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import { JobBrokerError } from '../jobs/broker.js';
import type { AuthenticatedNativeExecution } from '../jobs/local-transport.js';
import type { ReplayStore } from '../results/replay-store.js';
import { TraceVerifier } from '../results/trace-verifier.js';
import type { PrivateTestMapRef } from './private-test-runner.js';
import type { AcceptanceFence } from '../jobs/broker.js';

/**
 * Error a snapshot carries when the control plane gave up on it. Infrastructure, never a verdict
 * on the student's bot: the build passed, the run never happened.
 */
export const INFRASTRUCTURE_FAILURE = 'INFRASTRUCTURE_FAILURE';

/**
 * Query surface shared by the pool and a transaction client: the same minimal cast
 * `ArtifactStore.storeSource` uses, so a transition can join the caller's transaction.
 */
interface Queryable {
  query: (text: string, params?: readonly unknown[]) => Promise<unknown>;
}

/** Runs one statement and reports how many rows it changed (`RETURNING id` ⇒ the row count). */
async function changedRows(db: Queryable, text: string, params: readonly unknown[]): Promise<number> {
  const result = (await db.query(text, params)) as { rows: unknown[] };
  return result.rows.length;
}

/**
 * Claims the execution leg of one snapshot: `COMPLETED` with no payload becomes RUNNING. The
 * predicate is the entire concurrency control, so a concurrent claim — a duplicated job, a second
 * worker — loses instead of playing the same row twice.
 */
export async function claimPrivateTestSnapshot(db: Queryable, testId: string): Promise<boolean> {
  return (
    (await changedRows(
      db,
      `UPDATE test_snapshots
       SET status = 'RUNNING', started_at = clock_timestamp()
       WHERE id = $1 AND status = 'COMPLETED' AND result_payload IS NULL
       RETURNING id`,
      [testId]
    )) === 1
  );
}

/**
 * Releases a claim whose attempt is gone (lease STOP, expiry, or an assignment that could not be
 * built) before any evidence was submitted: the snapshot returns to `COMPLETED` with `started_at`
 * cleared, so the retried job can claim it again. A snapshot that already carries a result is left
 * alone — releasing a claim must never undo a recorded verdict.
 */
export async function releasePrivateTestSnapshot(db: Queryable, testId: string): Promise<boolean> {
  return (
    (await changedRows(
      db,
      `UPDATE test_snapshots
       SET status = 'COMPLETED', started_at = NULL
       WHERE id = $1 AND status = 'RUNNING' AND result_payload IS NULL
       RETURNING id`,
      [testId]
    )) === 1
  );
}

/**
 * Finalizes a snapshot whose `TEST_GAME` job exhausted its attempts (the reconciler's BLOCKED):
 * no retry will ever come, so the row must not stay RUNNING — or stay runnable — forever. The
 * cause recorded is infrastructure, not a student verdict, and a snapshot that already carries a
 * result keeps it.
 */
export async function failPrivateTestSnapshotExhausted(db: Queryable, testId: string): Promise<boolean> {
  return (
    (await changedRows(
      db,
      `UPDATE test_snapshots
       SET status = 'FAILED', completed_at = clock_timestamp(), result_payload = $2
       WHERE id = $1 AND result_payload IS NULL AND status IN ('RUNNING', 'COMPLETED')
       RETURNING id`,
      [testId, JSON.stringify({ error: INFRASTRUCTURE_FAILURE })]
    )) === 1
  );
}

/** `result_payload` of a finished private test, exactly the shape the team-scoped read model serves. */
export interface PrivateTestResultPayload {
  readonly winner: number;
  readonly reason: string;
  readonly totalTurns: number;
  /** Control-plane fact: the opponent the assignment pinned, never something the worker chose. */
  readonly opponent: TestOpponentRef;
  /** Control-plane fact: which board was pinned, and where it came from. */
  readonly map: PrivateTestMapRef;
  readonly finishedAt: string;
}

export interface RecordPrivateTestResultInput {
  readonly testId: string;
  readonly attemptId: string;
  /** Manifest digest of the assignment this attempt was built from. */
  readonly manifestDigest: Digest;
  readonly rulesRevision: string;
  /** Board the control plane pinned; the Rust verifier proves the outcome against it. */
  readonly mapDescriptor: MapDescriptor;
  readonly map: PrivateTestMapRef;
  readonly opponent: TestOpponentRef;
  readonly maxTurns: number;
  readonly evidence: GameResultEvidence;
  readonly nativeExecution?: AuthenticatedNativeExecution;
  /** Pinned transaction of a native completion; absent when this module owns the transaction. */
  readonly client?: pg.PoolClient;
}

/** What a recorded private test pinned: the replay object, the row payload and the job evidence. */
export interface RecordedPrivateTestResult {
  readonly replayDigest: Digest;
  readonly payload: PrivateTestResultPayload;
  readonly evidence: ResultEvidence;
}

export class PrivateTestResultService {
  private acceptanceFence?: AcceptanceFence;
  setAcceptanceFence(fence: AcceptanceFence): void { this.acceptanceFence = fence; }
  constructor(
    private readonly db: PostgresDatabase,
    private readonly replayStore: ReplayStore,
    private readonly traceVerifier: TraceVerifier = new TraceVerifier()
  ) {}

  /**
   * Records one verified private-test match as its own transaction. Called by the development
   * runner and by direct tests; the native completion consumer passes its pinned transaction
   * instead, so the row settles atomically with the terminal job bookkeeping.
   */
  async recordVerified(input: RecordPrivateTestResultInput): Promise<RecordedPrivateTestResult> {
    if (input.client) return this.recordOn(input.client, input);
    return this.db.withTransaction(async (client) => {
      await this.acceptanceFence?.(client);
      await client.query('SELECT pg_advisory_xact_lock_shared(1868657748, 26)');
      return this.recordOn(client, input);
    });
  }

  /** The recording itself, on a client whose transaction and backup barrier the caller already holds. */
  private async recordOn(client: pg.PoolClient, input: RecordPrivateTestResultInput): Promise<RecordedPrivateTestResult> {
    const { testId, attemptId, evidence, mapDescriptor } = input;
    const verification = await this.traceVerifier.verify(
      mapDescriptor,
      evidence,
      input.maxTurns,
      input.nativeExecution
    );
    if (!verification.isValid) {
      throw new JobBrokerError('EVIDENCE_VERIFICATION_FAILED', `Trace verification failed: ${verification.error}`);
    }
    if (verification.requiresSupervisorEvidence) {
      throw new JobBrokerError('SUPERVISOR_EVIDENCE_REQUIRED', 'A legal trace does not prove a runtime forfeit');
    }

    const payload: PrivateTestResultPayload = {
      winner: evidence.winner,
      reason: evidence.reason,
      totalTurns: evidence.totalPly,
      opponent: input.opponent,
      map: input.map,
      finishedAt: new Date().toISOString(),
    };

    // The replay object is promoted before the row names its digest, so a stored digest always
    // resolves to bytes; the row update below is the settlement and must affect exactly one row.
    // A private test carries no verifier turn count (that is an official replay's field), so the
    // payload's own turn count is what the row records.
    const staged = this.replayStore.stageReplay(
      `replays/tests/${testId}_${attemptId}_${Date.now()}.oantuti`,
      this.replayStore.serializeReplayV2({
        gameId: testId,
        attemptId,
        mapId: mapDescriptor.mapName,
        rulesRevision: input.rulesRevision,
        manifestDigest: input.manifestDigest,
        totalTurns: evidence.totalPly,
        winner: evidence.winner,
        reason: evidence.reason,
        disposition: evidence.disposition,
        trace: evidence.trace,
        map: mapDescriptor,
        nativeExecution: input.nativeExecution,
      })
    );
    const stored = this.replayStore.promoteStagedReplay(staged.stagingPath, staged.digest);

    const updated = await client.query<{ id: string }>(
      `UPDATE test_snapshots
       SET status = 'COMPLETED',
           completed_at = clock_timestamp(),
           replay_digest = $2,
           result_payload = $3
       WHERE id = $1 AND status = 'RUNNING' AND result_payload IS NULL
       RETURNING id`,
      [testId, stored.digest, JSON.stringify(payload)]
    );
    const replayDigest = stored.digest;
    if (updated.rows.length !== 1) {
      throw new JobBrokerError('TEST_SNAPSHOT_STATE_CONFLICT', 'The private-test claim is no longer running');
    }

    // Job evidence: which snapshot ran, its verdict and where its replay lives. As with builds, the
    // trace/replay digests are the digest of this payload itself — a private test's moves are stored
    // on the snapshot, never as an official version.
    const details = {
      testId,
      status: 'COMPLETED',
      winner: evidence.winner,
      reason: evidence.reason,
      totalTurns: evidence.totalPly,
      replayDigest,
      opponent: input.opponent,
      map: input.map,
    };
    const digest = createHash('sha256').update(JSON.stringify(details)).digest('hex');
    return {
      replayDigest,
      payload,
      evidence: {
        verdict: evidence.winner === 0 ? 'DRAW' : 'DECISIVE',
        winner: evidence.winner,
        reason: 'COMPLETED',
        actionTraceDigest: digest,
        replayDigest,
        manifestDigest: input.manifestDigest,
        cpuUsec: evidence.cpuUsec ?? '0',
        wallUsec: evidence.wallUsec ?? '0',
        details,
      },
    };
  }
}
