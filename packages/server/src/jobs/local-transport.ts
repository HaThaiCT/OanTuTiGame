import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';
import { lstat, unlink } from 'node:fs/promises';
import type { BuildToolchain, LeaseIdentity, PinnedCompletion, SlotOffer } from '@oantuti/protocol';
import type { Database } from '../persistence/db.js';
import { JobBroker, JobBrokerError, completionJson, type ClaimOptions } from './broker.js';
import type { NativeAssignmentService, StagedArtifactState, ValidatedNativeResult } from './native-assignment.js';

export interface NativeExecutionObservation {
  readonly side: 1 | 2;
  readonly ply: number;
  readonly kind: 'RESPONSE' | 'PROTOCOL_ERROR' | 'CPU_TIMEOUT' | 'WALL_TIMEOUT' | 'OUTPUT_LIMIT';
  readonly cpuUsec: string;
  readonly wallUsec: string;
  readonly freezeConfirmed: boolean;
  readonly terminationConfirmed: boolean;
  readonly responseNdjson?: string;
}
export interface AuthenticatedNativeExecution {
  readonly version: 1;
  readonly lease: LeaseIdentity;
  readonly gameId: string;
  readonly manifestDigest: string;
  readonly runtimeProfileDigest: string;
  readonly actionTraceDigest: string;
  readonly observations: readonly NativeExecutionObservation[];
  readonly assignment?: unknown;
}
const authenticatedExecutions = new WeakSet<object>();
export function isAuthenticatedNativeExecution(value: unknown): value is AuthenticatedNativeExecution {
  return typeof value === 'object' && value !== null && authenticatedExecutions.has(value);
}
/** Gateway-only capability restored from verified durable completion capsules. */
export function authenticateNativeExecution(identity: LeaseIdentity, validated: ValidatedNativeResult, runtimeProfileDigest: string, assignment?: unknown): AuthenticatedNativeExecution {
  const authenticated: AuthenticatedNativeExecution = Object.freeze({ version: 1, lease: Object.freeze({ ...identity }), gameId: validated.gameId, manifestDigest: validated.manifestDigest, runtimeProfileDigest, actionTraceDigest: validated.actionTraceDigest, observations: Object.freeze(validated.observations.map((observation) => Object.freeze({ ...observation }))), assignment });
  authenticatedExecutions.add(authenticated);
  return authenticated;
}

const MAX_FRAME = 1024 * 1024;
export interface LocalJobBrokerOptions {
  readonly executable: string;
  readonly socketPath: string;
  readonly workerUid: number;
  readonly socketGid: number;
  readonly deploymentGeneration: number;
  readonly runtimeProfileDigest: string;
  readonly maxBuildSlots: number;
  readonly maxGameSlots: number;
  /** Gateway-owned parent of the per-attempt spool directories (absolute). */
  readonly spoolRoot: string;
  /** Durable store root for compiled build artifacts (absolute). */
  readonly compiledArtifactsDir: string;
  /** Immutable completion capsules; defaults to `<spoolRoot>/completions` when unset. */
  readonly completionRoot?: string;
  /** Operator-declared toolchain identity, one entry per supported language. */
  readonly toolchains: readonly BuildToolchain[];
  /** Operator-declared grant GID for group-accessible spool attempts (required for distinct worker UID). */
  readonly grantGid: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobBrokerError('INVALID_REQUEST', 'Expected object');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new JobBrokerError('INVALID_REQUEST', 'Expected unsigned integer');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new JobBrokerError('INVALID_REQUEST', 'Expected string');
  return value;
}
function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new JobBrokerError('INVALID_REQUEST', 'Expected UUID');
  return result;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new JobBrokerError('INVALID_REQUEST', 'Expected SHA-256');
  return result;
}
function lease(value: unknown): LeaseIdentity {
  const data = object(value);
  const fencingToken = text(data.fencingToken);
  if (!/^[0-9]{1,19}$/.test(fencingToken)) throw new JobBrokerError('INVALID_REQUEST', 'Invalid fence');
  return { jobId: uuid(data.jobId), attemptId: uuid(data.attemptId), grantId: uuid(data.grantId), fencingToken, deploymentGeneration: integer(data.deploymentGeneration) };
}
/** Native helper is the only producer of credential envelopes; never expose dispatch on HTTP. */
export class LocalJobBrokerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private healthy = false;
  private socketInode?: number;
  private readonly workers = new Map<string, { capacity: SlotOffer; seenAt: number }>();
  async capabilities(): Promise<{ officialGame: boolean; build: boolean; privateTest: boolean }> {
    let build = false, game = false;
    if (this.healthy) for (const worker of this.workers.values()) {
      if (Date.now() - worker.seenAt > 30_000 || worker.capacity.runtimeProfileDigest !== this.options.runtimeProfileDigest) continue;
      build ||= worker.capacity.buildSlots > 0;
      game ||= worker.capacity.gameSlots > 0;
    }
    return { officialGame: game, build, privateTest: build && game };
  }
  constructor(private readonly db: Database, private readonly broker: JobBroker, private readonly options: LocalJobBrokerOptions, private readonly assignments: NativeAssignmentService) {
    if (process.platform !== 'linux' || !isAbsolute(options.executable) || !isAbsolute(options.socketPath)) throw new Error('Local broker requires Linux and absolute executable/socket paths');
    if (!isAbsolute(options.spoolRoot) || !isAbsolute(options.compiledArtifactsDir)) throw new Error('Native spool and compiled artifact roots must be absolute paths');
    if (!Array.isArray(options.toolchains) || options.toolchains.length === 0) throw new Error('Runtime profile must declare at least one toolchain');
    for (const value of [options.workerUid, options.socketGid, options.grantGid, options.deploymentGeneration, options.maxBuildSlots, options.maxGameSlots]) integer(value);
    if (options.workerUid === process.getuid?.()) throw new Error('Native worker must have a separate UID');
    if (options.deploymentGeneration === 0) throw new Error('Deployment generation must be positive');
    digest(options.runtimeProfileDigest);
  }
  isReady(): boolean { return this.healthy; }
  async start(): Promise<void> {
    if (this.child) throw new Error('Local broker already started');
    const directory = await lstat(dirname(this.options.socketPath));
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) throw new Error('Broker socket directory must be API-owned and not writable by other identities');
    // Before the worker can claim anything: prepare the spool root and delete attempt directories
    // that a previous process left behind (a restart drops authority over them).
    await this.assignments.start();
    const child = spawn(this.options.executable, [this.options.socketPath, String(this.options.workerUid), String(this.options.socketGid)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => { this.healthy = false; child.kill(); });
    child.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      let pending = Buffer.alloc(0);
      let chain = Promise.resolve();
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local broker readiness timeout')); }, 5000);
      const fail = (error: Error) => { this.healthy = false; clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', () => fail(new Error('Local broker exited')));
      child.stdout.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const size = pending.readUInt32BE(0);
          if (size === 0 || size > MAX_FRAME) { child.kill(); fail(new Error('Invalid native broker frame')); return; }
          if (pending.length < size + 4) break;
          const frame = pending.subarray(4, size + 4);
          pending = pending.subarray(size + 4);
          chain = chain.then(async () => {
            const envelope: unknown = JSON.parse(frame.toString('utf8'));
            if (!this.healthy) {
              if (object(envelope).ready !== true) throw new Error('Invalid native broker readiness');
              this.socketInode = (await lstat(this.options.socketPath)).ino;
              this.healthy = true; clearTimeout(timer); resolve(); return;
            }
            let result: unknown;
            try { result = { ok: true, value: await this.dispatch(envelope) }; }
            catch (error: unknown) { result = { ok: false, code: error instanceof JobBrokerError ? error.code : 'BROKER_ERROR' }; }
            const body = Buffer.from(JSON.stringify(result));
            if (body.length > MAX_FRAME) throw new Error('Broker response exceeds frame limit');
            const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
            await new Promise<void>((done, failed) => child.stdin.write(Buffer.concat([header, body]), (error) => error ? failed(error) : done()));
          }).catch((error: unknown) => { child.kill(); fail(error instanceof Error ? error : new Error('Native broker protocol failure')); });
        }
      });
    });
  }
  async stop(): Promise<void> {
    this.healthy = false;
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    const socket = await lstat(this.options.socketPath).catch(() => undefined);
    if (socket?.isSocket() && socket.ino === this.socketInode) await unlink(this.options.socketPath);
  }

  private async owned(identity: LeaseIdentity, workerId: string): Promise<void> {
    if (identity.deploymentGeneration !== this.options.deploymentGeneration) throw new JobBrokerError('GENERATION_MISMATCH', 'Generation mismatch');
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM job_attempts WHERE id = $1 AND job_id = $2 AND worker_id = $3 AND grant_id = $4 AND fencing_token = $5`,
      [identity.attemptId, identity.jobId, workerId, identity.grantId, identity.fencingToken]);
    if (result.rows.length !== 1) throw new JobBrokerError('WORKER_MISMATCH', 'Lease not owned by peer');
  }
  private async dispatch(value: unknown): Promise<unknown> {
    const envelope = object(value);
    const uid = integer(envelope.uid), pid = integer(envelope.pid);
    if (uid !== this.options.workerUid || pid === 0) throw new JobBrokerError('PEER_DENIED', 'Peer denied');
    const workerId = `native-uid-${uid}`;
    const persistedId = `${workerId}:${pid}`;
    const request = object(envelope.request), parameters = object(request.parameters);
    switch (request.operation) {
      case 'claim': {
        const input = object(parameters.capacity);
        const capacity: SlotOffer = { buildSlots: integer(input.buildSlots), gameSlots: integer(input.gameSlots), runtimeProfileDigest: digest(input.runtimeProfileDigest) };
        if (capacity.buildSlots > this.options.maxBuildSlots || capacity.gameSlots > this.options.maxGameSlots || capacity.runtimeProfileDigest !== this.options.runtimeProfileDigest) throw new JobBrokerError('POLICY_MISMATCH', 'Slot or runtime policy mismatch');
        this.workers.set(persistedId, { capacity, seenAt: Date.now() });
        const narrowing = object(parameters.options ?? {});
        let targetIds: string[] | undefined;
        if (narrowing.targetIds !== undefined) {
          if (!Array.isArray(narrowing.targetIds) || narrowing.targetIds.length > 1000) throw new JobBrokerError('INVALID_REQUEST', 'Invalid targets');
          targetIds = narrowing.targetIds.map(uuid);
        }
        let jobTypes: ClaimOptions['jobTypes'];
        if (narrowing.jobTypes !== undefined) {
          if (!Array.isArray(narrowing.jobTypes)) throw new JobBrokerError('INVALID_REQUEST', 'Invalid job types');
          jobTypes = narrowing.jobTypes.map((type: unknown) => {
            if (type !== 'BUILD' && type !== 'TEST_BUILD' && type !== 'GAME' && type !== 'TEST_GAME') throw new JobBrokerError('INVALID_REQUEST', 'Invalid job type');
            return type;
          });
        }
        // Every queue this gateway can build an assignment for: official games, both build queues
        // and the private-test execution leg. A job type without an assignment builder is never
        // leased, because a leased job whose payload cannot be built only strands its lease.
        const assignable: ClaimOptions['jobTypes'] = ['GAME', 'BUILD', 'TEST_BUILD', 'TEST_GAME'];
        jobTypes = jobTypes ? jobTypes.filter((type) => assignable.includes(type)) : assignable;
        if (jobTypes.length === 0) return null;
        const active = await this.db.query<{ builds: number; games: number }>(
          `SELECT count(*) FILTER (WHERE j.job_type IN ('BUILD', 'TEST_BUILD'))::int AS builds,
                  count(*) FILTER (WHERE j.job_type IN ('GAME', 'TEST_GAME'))::int AS games
           FROM job_attempts a JOIN jobs j ON j.id = a.job_id
           WHERE a.worker_id LIKE $1 AND a.state = 'ACTIVE'`, [`${workerId}:%`]);
        // An ACTIVE attempt is a slot in use until the reclaimer expires it, not until its lease
        // timestamp passes: otherwise a peer that simply stops heartbeating would stop being counted
        // and could exceed its own slot budget. The window is bounded by the reclaimer (the API runs
        // one whenever the development executor is off, and the dev poller reconciles otherwise).
        if ((active.rows[0].builds >= this.options.maxBuildSlots && capacity.buildSlots > 0) || (active.rows[0].games >= this.options.maxGameSlots && capacity.gameSlots > 0)) throw new JobBrokerError('CAPACITY_EXHAUSTED', 'Worker slot limit reached');
        const claimed = await this.broker.claim({ workerId, pid, uid }, capacity, { targetIds, jobTypes });
        if (!claimed) return claimed;
        return { ...claimed, payload: await this.assignments.prepare(claimed) };
      }
      case 'heartbeat': {
        const identity = lease(parameters.lease); await this.owned(identity, persistedId);
        const worker = this.workers.get(persistedId); if (worker) worker.seenAt = Date.now();
        const status = await this.broker.heartbeat(identity);
        // A STOP means this worker no longer owns the attempt: its pinned spool must go with the
        // lease. An ACTIVE beat moves the abandonment horizon so an expired worker is swept.
        if (status.status === 'STOP') await this.assignments.abandon(identity);
        else this.assignments.extend(identity, status.expiresAt);
        return status;
      }
      case 'stageArtifact': {
        const identity = lease(parameters.lease); await this.owned(identity, persistedId);
        // Compiled output from a build attempt: verified bytes travel in bounded chunks and land in
        // the attempt spool this gateway owns. No worker-supplied path is ever read back.
        const staged: StagedArtifactState = await this.assignments.stage(identity, parameters.chunk);
        return staged;
      }
      case 'prepareCompletion': {
        const identity = lease(parameters.lease); await this.owned(identity, persistedId);
        const requestDigest = createHash('sha256').update(completionJson(parameters.evidence)).digest('hex');
        const prior = await this.db.query<{ id: string; evidence_digest: string; created_at: Date; evidence_payload: { native?: { requestDigest?: string } } }>(`SELECT id,evidence_digest,created_at,evidence_payload FROM job_completions WHERE job_id=$1 AND attempt_id=$2 AND fencing_token=$3 AND deployment_generation=$4`, [identity.jobId,identity.attemptId,identity.fencingToken,identity.deploymentGeneration]);
        if (prior.rows[0]) {
          const row = prior.rows[0];
          if (row.evidence_payload.native?.requestDigest !== requestDigest) throw new JobBrokerError('COMPLETION_CONFLICT', 'Attempt already pinned different evidence');
          return { receiptId: row.id, timestamp: row.created_at.toISOString(), data: { completionId: row.id, evidenceDigest: row.evidence_digest, state: 'COMPLETION_PENDING' } };
        }
        const validated = await this.assignments.validate(identity, parameters.evidence);
        const evidence = await this.assignments.materialize(identity, validated, requestDigest);
        const receipt = await this.broker.prepareCompletion(identity, evidence);
        this.assignments.completionPinned(identity);
        return receipt;
      }
      case 'liveTurn': {
        const identity = lease(parameters.lease); await this.owned(identity, persistedId);
        if ((await this.broker.heartbeat(identity)).status !== 'ACTIVE') throw new JobBrokerError('FENCE_STALE_OR_EXPIRED', 'Live lease is no longer active');
        this.assignments.liveTurn(identity, parameters);
        return { accepted: true };
      }
      case 'complete': {
        const input = object(parameters.completion);
        const completion: PinnedCompletion = { completionId: uuid(input.completionId), evidenceDigest: digest(input.evidenceDigest), deploymentGeneration: integer(input.deploymentGeneration) };
        if (completion.deploymentGeneration !== this.options.deploymentGeneration) throw new JobBrokerError('GENERATION_MISMATCH', 'Generation mismatch');
        const owner = await this.db.query<{ id: string }>(`SELECT c.id FROM job_completions c JOIN job_attempts a ON a.id = c.attempt_id WHERE c.id = $1 AND a.worker_id = $2`, [completion.completionId, persistedId]);
        if (owner.rows.length !== 1) throw new JobBrokerError('WORKER_MISMATCH', 'Completion not owned by peer');
        return this.broker.complete(completion, { reconcilerId: workerId, pid, uid });
      }
      default: throw new JobBrokerError('INVALID_REQUEST', 'Unknown operation');
    }
  }
}
