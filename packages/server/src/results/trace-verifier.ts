import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MapDescriptor, PlayerSide } from '@oantuti/engine';
import type { GameResultEvidence } from '@oantuti/protocol';

import { isAuthenticatedNativeExecution, type AuthenticatedNativeExecution, type NativeExecutionObservation } from '../jobs/local-transport.js';
export interface VerificationResult {
  readonly isValid: boolean;
  readonly error?: string;
  readonly verifiedTurns: number;
  /** A legal prefix cannot prove a crash, timeout or protocol fault. */
  readonly requiresSupervisorEvidence?: boolean;
  readonly finalOutcome?: {
    readonly isGameOver: boolean;
    readonly winner?: PlayerSide;
    readonly reason?: string;
    readonly disposition?: string;
  };
}

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_BINARY = fileURLToPath(new URL('../../../../target/debug/verify-trace', import.meta.url));
const FORFEIT_REASONS: Record<string, true> = { BOT_FORFEIT: true, BOT_TIMEOUT: true, TIMEOUT: true, TIMEOUT_FORFEIT: true, CRASH_FORFEIT: true, PROTOCOL_VIOLATION: true, ILLEGAL_MOVE: true, OUTPUT_LIMIT: true };
const REASONS: Record<string, true> = { EXTINCTION: true, THRONE_BREACH: true, STALEMATE: true, MAX_TURNS_MATERIAL: true, MAX_TURNS_PROXIMITY: true, MAX_TURNS_DRAW: true, INVALID_START_BOTH_SIDES: true };

export class TraceVerifier {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;

  constructor(options: { readonly binaryPath?: string; readonly timeoutMs?: number } = {}) {
    this.binaryPath = options.binaryPath ?? process.env.OANTUTI_VERIFIER_BIN ?? DEFAULT_BINARY;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('INVALID_VERIFIER_TIMEOUT');
  }

  /** Adapts protocol evidence to the existing Rust engine. No TS engine fallback. */
  async verify(map: MapDescriptor, evidence: GameResultEvidence, maxTurns = 300, nativeExecution?: AuthenticatedNativeExecution): Promise<VerificationResult> {
    const reject = (error: string): VerificationResult => ({ isValid: false, error, verifiedTurns: 0 });
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 300) return reject('INVALID_MAX_TURNS');
    if (!Array.isArray(evidence.trace) || evidence.trace.length > maxTurns || evidence.totalPly !== evidence.trace.length) return reject('INVALID_TOTAL_PLY');
    if (![0, 1, 2].includes(evidence.winner)) return reject('INVALID_WINNER');
    if (evidence.executionStatus !== 'COMPLETED' && evidence.executionStatus !== 'BOT_FORFEIT') return reject('INVALID_EXECUTION_STATUS');
    const prefix = evidence.executionStatus === 'BOT_FORFEIT';
    if (prefix && (FORFEIT_REASONS[evidence.reason] !== true || evidence.winner === 0 || evidence.disposition !== 'DECISIVE')) return reject('INVALID_FORFEIT_CLAIM');
    if (!prefix && REASONS[evidence.reason] !== true) return reject('INVALID_COMPLETED_REASON');
    const disposition = evidence.reason === 'MAX_TURNS_DRAW' ? 'DRAW' : evidence.reason === 'INVALID_START_BOTH_SIDES' ? 'NO_CONTEST' : 'DECISIVE';
    if (evidence.disposition !== disposition) return reject('DISPOSITION_MISMATCH');
    for (const [i, step] of evidence.trace.entries()) {
      if (step.ply !== i + 1 || step.side !== (i % 2 === 0 ? 1 : 2)) return reject(`INVALID_PLY_OR_SIDE_${i + 1}`);
      if (!Number.isInteger(step.move?.pieceId) || !Number.isInteger(step.move?.targetPos?.x) || !Number.isInteger(step.move?.targetPos?.y)) return reject(`INVALID_MOVE_${i + 1}`);
    }
    let fault: NativeExecutionObservation | undefined;
    if (nativeExecution !== undefined) {
      if (!isAuthenticatedNativeExecution(nativeExecution) || nativeExecution.gameId !== evidence.gameId) return reject('UNAUTHENTICATED_NATIVE_EXECUTION');
      const observations = nativeExecution.observations;
      const expected = [{ side: 1, ply: 0 }, { side: 2, ply: 0 }, ...evidence.trace.map((step) => ({ side: step.side, ply: step.ply }))];
      const successfulCount = prefix ? observations.length - 1 : observations.length;
      if (successfulCount < 0 || successfulCount > expected.length || (!prefix && successfulCount !== expected.length && !(evidence.trace.length === 0 && successfulCount === 0))) return reject('OBSERVATION_SEQUENCE_LENGTH');
      for (let i = 0; i < successfulCount; i++) {
        const observation = observations[i];
        if (observation.kind !== 'RESPONSE' || !observation.freezeConfirmed || observation.side !== expected[i].side || observation.ply !== expected[i].ply) return reject('OBSERVATION_SEQUENCE_MISMATCH');
        if (!/^\d{1,20}$/.test(observation.cpuUsec) || !/^\d{1,20}$/.test(observation.wallUsec)
          || BigInt(observation.cpuUsec) > (observation.ply === 0 ? 500000n : 100000n)
          || BigInt(observation.wallUsec) >= 1000000n) return reject('OBSERVATION_RESOURCE_BUDGET');
        try {
          const raw = observation.responseNdjson;
          if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384 || !raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) return reject('OBSERVATION_RESPONSE_FRAMING');
          const response: unknown = JSON.parse(raw);
          if (!response || typeof response !== 'object' || Array.isArray(response)) return reject('OBSERVATION_RESPONSE_SCHEMA');
          const value = response as Record<string, unknown>;
          if (i < 2) { if (value.status !== 'READY') return reject('OBSERVATION_INIT_NOT_READY'); }
          else {
            const move = evidence.trace[i - 2].move;
            if (value.action !== 'MOVE' || value.piece_id !== move.pieceId || !Array.isArray(value.target) || value.target.length !== 2 || value.target[0] !== move.targetPos.x || value.target[1] !== move.targetPos.y) return reject('OBSERVATION_TRACE_MISMATCH');
          }
        } catch { return reject('OBSERVATION_RESPONSE_JSON'); }
      }
      if (prefix) {
        fault = observations.at(-1);
        if (!fault || !fault.freezeConfirmed || !fault.terminationConfirmed || fault.side !== (evidence.winner === 1 ? 2 : 1)) return reject('FAULT_OBSERVATION_UNCONFIRMED');
        const expectedFault = expected[successfulCount] ?? { side: evidence.trace.length % 2 === 0 ? 1 : 2, ply: evidence.trace.length + 1 };
        if (fault.side !== expectedFault.side || fault.ply !== expectedFault.ply || (successfulCount < 2 && evidence.trace.length !== 0) || (successfulCount >= 2 && successfulCount !== expected.length)) return reject('FAULT_OBSERVATION_POSITION');
        if (!/^\d{1,20}$/.test(fault.cpuUsec) || !/^\d{1,20}$/.test(fault.wallUsec)) return reject('FAULT_RESOURCE_COUNTER');
        if (!Number.isSafeInteger(Number(fault.cpuUsec)) || !Number.isSafeInteger(Number(fault.wallUsec))) return reject('FAULT_RESOURCE_COUNTER_RANGE');
      }
    }
    let input: string;
    try {
      input = JSON.stringify({
        manifest: {
          game_id: evidence.gameId, map, max_ply: maxTurns,
          pieces: map.startingPieces.map((piece) => ({ id: piece.id, owner: piece.owner, piece_type: piece.type, pos: { x: piece.pos[0], y: piece.pos[1] }, is_alive: true })),
        },
        prefix_only: prefix,
        fault: fault ? { side: fault.side === 1 ? 'WHITE' : 'BLACK', ply: fault.ply, kind: fault.kind, reason: evidence.reason, response_ndjson: fault.responseNdjson, cpu_usec: Number(fault.cpuUsec), wall_usec: Number(fault.wallUsec) } : undefined,
        actions: evidence.trace.map((step) => ({ ply: step.ply, side: step.side === 1 ? 'WHITE' : 'BLACK', piece_id: step.move.pieceId, target_pos: [step.move.targetPos.x, step.move.targetPos.y] })),
        outcome: prefix ? null : { winner: evidence.winner === 1 ? 'WHITE' : evidence.winner === 2 ? 'BLACK' : null, reason: evidence.reason },
      });
    } catch { return reject('INVALID_VERIFIER_INPUT'); }
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) return reject('VERIFIER_INPUT_TOO_LARGE');
    try {
      const { stdout, code } = await this.run(input);
      const value: unknown = JSON.parse(stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('RUST_VERIFIER_SCHEMA');
      const result = value as Record<string, unknown>;
      if (code === 2 && result.ok === false && typeof result.error === 'string') return reject(result.error);
      if (code !== 0 || result.ok !== true || !Number.isInteger(result.appliedPly) || result.appliedPly !== evidence.totalPly || typeof result.isGameOver !== 'boolean' || typeof result.faultVerified !== 'boolean' || result.faultVerified !== Boolean(fault) || ![null, 'WHITE', 'BLACK'].includes(result.winner as string | null) || !(result.reason === null || (typeof result.reason === 'string' && REASONS[result.reason] === true))) return reject('RUST_VERIFIER_SCHEMA');
      if (prefix ? result.isGameOver || result.reason !== null || result.winner !== null : !result.isGameOver || result.reason !== evidence.reason || result.winner !== (evidence.winner === 1 ? 'WHITE' : evidence.winner === 2 ? 'BLACK' : null)) return reject('RUST_VERIFIER_OUTCOME_MISMATCH');
      return {
        isValid: true, verifiedTurns: evidence.totalPly + 1,
        requiresSupervisorEvidence: prefix && !fault,
        finalOutcome: { isGameOver: result.isGameOver, winner: result.winner === 'WHITE' ? 1 : result.winner === 'BLACK' ? 2 : undefined, reason: typeof result.reason === 'string' ? result.reason : undefined, disposition: prefix ? undefined : disposition },
      };
    } catch (error) { return reject(`RUST_VERIFIER_PROCESS: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private run(input: string): Promise<{ stdout: string; code: number | null }> {
    // The shared compiler lib is ES2022 (no Promise.withResolvers declaration).
    return new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const child = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderrBytes = 0;
      let failure: Error | undefined;
      const fail = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
      // Covers writing stdin, execution and draining output; SIGKILL cannot be ignored.
      const timer = setTimeout(() => fail('TIMEOUT'), this.timeoutMs);
      child.on('error', (error) => { failure ??= error; });
      child.stdin.on('error', (error) => { failure ??= error; });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) fail('STDOUT_LIMIT'); else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT_BYTES) fail('STDERR_LIMIT'); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure); else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code });
      });
      child.stdin.end(input);
    });
  }
}
