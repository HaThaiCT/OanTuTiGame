#!/usr/bin/env npx tsx
/**
 * Trace-verifier parity checker.
 *
 * Takes the newest stored replays out of the local PostgreSQL object index, decodes each
 * `OANTUTI2` object, and replays it through:
 *
 *   - `target/debug/verify-trace`        (Rust, `arena_engine::replay` via `arena_verifier`)
 *   - `TraceVerifier.verify()`           (TypeScript, server replay adjudication)
 *   - the WASM verifier, with `--wasm`   (same Rust core compiled to `wasm32-unknown-unknown`)
 *
 * and reports every disagreement in `ok` / `appliedPly` / `winner` / `reason`.
 *
 * Usage:
 *   npx tsx deploy/linux/verify-replay-parity.ts [--limit N] [--rust-bin PATH] [--wasm PATH]
 *
 * Environment (defaults point at the local rebuild dev database):
 *   PGHOST PGPORT PGDATABASE PGUSER
 *
 * Exit code: 0 when every checked replay agrees, 1 on any mismatch or checksum failure,
 * 2 on a usage or connection error.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import pg from 'pg';
import { TraceVerifier } from '../../packages/server/src/results/trace-verifier.js';
import type { MapDescriptor } from '@oantuti/engine';
import type { ActionTraceStep, GameResultEvidence } from '@oantuti/protocol';

const { Client } = pg;

const REPO_ROOT = resolve(__dirname, '..', '..');
/** Where `replay_objects.storage_path` files are expected to live. */
const STORAGE_ROOT = join(REPO_ROOT, 'storage', 'replays');
const DEFAULT_RUST_BIN = join(REPO_ROOT, 'target', 'debug', 'verify-trace');
const DEFAULT_WASM_BIN = join(REPO_ROOT, 'target', 'wasm32-unknown-unknown', 'release', 'arena_engine_wasm.wasm');

/** Keep in step with `TraceVerifier.verify`'s default and the Rust input builder. */
const MAX_PLY = 300;

const DEFAULT_DB = {
  host: '/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/pg16/socket',
  port: 55434,
  database: 'arena_rebuild_c72cd5a74f33',
  user: 'arena_rebuild_migrator',
};

/** Magic + version(4) + digestLen(2) + jsonLen(4) + sha256 trailer(32). */
const MIN_REPLAY_BYTES = 8 + 4 + 2 + 4 + 32;
const REPLAY_MAGIC = 'OANTUTI2';

/**
 * The reasons the v2 engine itself can produce. The result recorder stores a runner
 * `WinReason` (`TIMEOUT`, `ILLEGAL_MOVE`, `CRASH_FORFEIT`, `PROTOCOL_VIOLATION`) instead
 * whenever a trace was recorded as a forfeit, which is the only signal the payload keeps
 * for `evidence.executionStatus`.
 */
const V2_REASONS: Record<string, true> = {
  EXTINCTION: true,
  THRONE_BREACH: true,
  STALEMATE: true,
  'MAX_TURNS_MATERIAL': true,
  'MAX_TURNS_PROXIMITY': true,
  'MAX_TURNS_DRAW': true,
  'INVALID_START_BOTH_SIDES': true,
};

interface ReplayPayload {
  readonly gameId: string;
  readonly attemptId: string;
  readonly mapId: string;
  readonly rulesRevision: string;
  readonly manifestDigest: string;
  readonly totalTurns: number;
  readonly winner: number;
  readonly reason: string;
  readonly disposition: string;
  readonly trace: readonly ActionTraceStep[];
  readonly map?: MapDescriptor;
}

/** What both sides are reduced to before they are compared. */
interface Verdict {
  readonly ok: boolean;
  readonly appliedPly: number | null;
  readonly winner: string | null;
  readonly reason: string | null;
  readonly error?: string;
}

interface Mismatch {
  readonly digest: string;
  readonly fields?: readonly string[];
  readonly rust?: Verdict;
  readonly ts?: Verdict;
  readonly wasm?: Verdict;
  readonly error?: string;
}

interface Summary {
  readonly checked: number;
  readonly rustOk: number;
  readonly tsOk: number;
  readonly wasmChecked: number;
  readonly wasmOk: number;
  readonly mismatches: readonly Mismatch[];
  readonly skippedNoMap: number;
}

interface Options {
  readonly limit: number;
  readonly rustBin: string;
  /** When set, the same documents are also replayed through the WASM verifier. */
  readonly wasmBin: string | null;
}

/** Minimal shape of the WASM module's verifier exports (see `arena-engine-wasm`). */
interface WasmExports {
  readonly memory: WebAssembly.Memory;
  oantuti_alloc(len: number): number;
  oantuti_free(ptr: number, len: number): void;
  oantuti_verify_replay(ptr: number, len: number): number;
  oantuti_result_free(ptr: number): void;
}

/** Loads the WASM verifier and adapts it to the same `Verdict` shape as the other verifiers. */
async function loadWasmVerifier(path: string): Promise<{ verify(input: unknown): Verdict }> {
  const { instance } = await WebAssembly.instantiate(readFileSync(path), {});
  const exports = instance.exports as unknown as WasmExports;
  return {
    verify(input: unknown): Verdict {
      const document = Buffer.from(JSON.stringify(input), 'utf8');
      const inputPtr = exports.oantuti_alloc(document.length);
      new Uint8Array(exports.memory.buffer, inputPtr, document.length).set(document);
      let resultPtr: number;
      try {
        resultPtr = exports.oantuti_verify_replay(inputPtr, document.length);
      } finally {
        exports.oantuti_free(inputPtr, document.length);
      }
      const view = new DataView(exports.memory.buffer);
      const resultLen = view.getUint32(resultPtr, true);
      const json = Buffer.from(new Uint8Array(exports.memory.buffer, resultPtr + 4, resultLen)).toString('utf8');
      exports.oantuti_result_free(resultPtr);
      let parsed: { ok?: unknown; appliedPly?: unknown; winner?: unknown; reason?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(json);
      } catch {
        return { ok: false, appliedPly: null, winner: null, reason: null, error: `WASM_BAD_OUTPUT: ${json.slice(0, 200)}` };
      }
      return {
        ok: parsed.ok === true,
        appliedPly: typeof parsed.appliedPly === 'number' ? parsed.appliedPly : null,
        winner: typeof parsed.winner === 'string' ? parsed.winner : null,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      };
    },
  };
}

function sideName(side: number | undefined): string | null {
  if (side === 1) return 'WHITE';
  if (side === 2) return 'BLACK';
  return null;
}

/** Bounds-checked OANTUTI2 decode with the canonical trailing SHA-256 recomputed. */
function decodeReplay(buffer: Buffer): ReplayPayload {
  if (buffer.length < MIN_REPLAY_BYTES) {
    throw new Error(`TOO_SHORT: ${buffer.length} bytes`);
  }
  const magic = buffer.subarray(0, 8).toString('ascii');
  if (magic !== REPLAY_MAGIC) {
    throw new Error(`BAD_MAGIC: ${JSON.stringify(magic)}`);
  }
  const version = buffer.readUInt32BE(8);
  if (version !== 2) {
    throw new Error(`UNSUPPORTED_VERSION: ${version}`);
  }

  const body = buffer.subarray(0, buffer.length - 32);
  const trailer = buffer.subarray(buffer.length - 32);
  if (!createHash('sha256').update(body).digest().equals(trailer)) {
    throw new Error('CHECKSUM_MISMATCH');
  }

  const digestLen = buffer.readUInt16BE(12);
  let offset = 14;
  if (offset + digestLen > body.length) {
    throw new Error(`TRUNCATED_MANIFEST_DIGEST: len ${digestLen}`);
  }
  offset += digestLen;

  if (offset + 4 > body.length) {
    throw new Error('TRUNCATED_JSON_LENGTH');
  }
  const jsonLen = buffer.readUInt32BE(offset);
  offset += 4;
  if (offset + jsonLen > body.length) {
    throw new Error(`TRUNCATED_JSON_PAYLOAD: len ${jsonLen}, ${body.length - offset} left`);
  }

  return JSON.parse(body.subarray(offset, offset + jsonLen).toString('utf8')) as ReplayPayload;
}

function runRust(rustBin: string, input: unknown): Verdict {
  const result = spawnSync(rustBin, [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, appliedPly: null, winner: null, reason: null, error: `RUST_SPAWN_FAILED: ${result.error.message}` };
  }
  if (result.status !== 0 && result.status !== 2) {
    const detail = (result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    return { ok: false, appliedPly: null, winner: null, reason: null, error: `RUST_EXIT_${result.status}: ${detail}` };
  }
  let parsed: { ok?: unknown; appliedPly?: unknown; winner?: unknown; reason?: unknown; error?: unknown };
  try {
    parsed = JSON.parse((result.stdout ?? '').trim());
  } catch {
    return { ok: false, appliedPly: null, winner: null, reason: null, error: `RUST_BAD_OUTPUT: ${JSON.stringify((result.stdout ?? '').slice(0, 200))}` };
  }
  return {
    ok: parsed.ok === true,
    appliedPly: typeof parsed.appliedPly === 'number' ? parsed.appliedPly : null,
    winner: typeof parsed.winner === 'string' ? parsed.winner : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
  };
}

function runTypeScript(map: MapDescriptor, evidence: GameResultEvidence, verifier: TraceVerifier): Verdict {
  const result = verifier.verify(map, evidence, MAX_PLY);
  return {
    ok: result.isValid,
    // `verifiedTurns` is the 1-based `turnNumber` reached, i.e. applied plies + 1.
    appliedPly: result.verifiedTurns - 1,
    winner: sideName(result.finalOutcome?.winner),
    reason: result.finalOutcome?.reason ?? null,
    ...(result.error ? { error: result.error } : {}),
  };
}

function compare(rust: Verdict, ts: Verdict): string[] {
  const fields: string[] = [];
  if (rust.ok !== ts.ok) fields.push('ok');
  if (rust.ok && ts.ok) {
    if (rust.appliedPly !== ts.appliedPly) fields.push('appliedPly');
    if (rust.winner !== ts.winner) fields.push('winner');
    if (rust.reason !== ts.reason) fields.push('reason');
  }
  return fields;
}

class UsageError extends Error {}

function parseOptions(argv: readonly string[]): Options {
  let limit = 10;
  let rustBin = DEFAULT_RUST_BIN;
  let wasmBin: string | null = DEFAULT_WASM_BIN;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.split('=');
    const value = inline ?? argv[++index];
    if (flag === '--limit') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new UsageError(`--limit must be a positive integer, got ${JSON.stringify(value)}`);
      }
      limit = parsed;
    } else if (flag === '--rust-bin') {
      if (!value) throw new UsageError('--rust-bin requires a path');
      rustBin = resolve(value);
    } else if (flag === '--wasm') {
      if (!value) throw new UsageError('--wasm requires a path');
      wasmBin = resolve(value);
    } else if (flag === '--no-wasm') {
      wasmBin = null;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { limit, rustBin, wasmBin };
}

async function checkReplays(options: Options): Promise<Summary> {
  if (!existsSync(options.rustBin)) {
    throw new UsageError(
      `rust binary not found at ${options.rustBin} (build it with: cargo build -p arena-runner --bin verify-trace --offline)`
    );
  }
  if (options.wasmBin && !existsSync(options.wasmBin)) {
    throw new UsageError(
      `wasm module not found at ${options.wasmBin} (build it with: cargo build -p arena-engine-wasm --target wasm32-unknown-unknown --release --offline, or pass --no-wasm)`
    );
  }
  if (!existsSync(STORAGE_ROOT)) {
    throw new UsageError(`storage root not found at ${STORAGE_ROOT}`);
  }

  const client = new Client({
    host: process.env.PGHOST ?? DEFAULT_DB.host,
    port: Number(process.env.PGPORT ?? DEFAULT_DB.port),
    database: process.env.PGDATABASE ?? DEFAULT_DB.database,
    user: process.env.PGUSER ?? DEFAULT_DB.user,
  });
  await client.connect();

  let rows: readonly { digest: string; storage_path: string }[];
  try {
    const result = await client.query<{ digest: string; storage_path: string }>(
      'SELECT digest, storage_path FROM replay_objects ORDER BY created_at DESC, digest DESC'
    );
    rows = result.rows;
  } finally {
    await client.end();
  }

  // Newest first: keep the first `limit` rows whose object file is actually on disk.
  const selected: { digest: string; path: string }[] = [];
  let missingFiles = 0;
  for (const row of rows) {
    if (selected.length >= options.limit) break;
    const candidates = [join(STORAGE_ROOT, basename(row.storage_path)), row.storage_path];
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) {
      missingFiles++;
      continue;
    }
    selected.push({ digest: row.digest, path });
  }
  if (missingFiles > 0) {
    console.error(`note: ${missingFiles} replay_objects rows skipped (object file missing)`);
  }

  const verifier = new TraceVerifier();
  const wasmVerifier = options.wasmBin ? await loadWasmVerifier(options.wasmBin) : null;
  const mismatches: Mismatch[] = [];
  let checked = 0;
  let rustOk = 0;
  let tsOk = 0;
  let wasmChecked = 0;
  let wasmOk = 0;
  let skippedNoMap = 0;

  for (const { digest, path } of selected) {
    let payload: ReplayPayload;
    try {
      payload = decodeReplay(readFileSync(path));
    } catch (error) {
      mismatches.push({ digest, error: `REPLAY_DECODE_FAILED: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    if (!payload.map) {
      skippedNoMap++;
      continue;
    }
    const map = payload.map;

    // A step carrying no move is a PASS ply and is not replayed, exactly as the evidence
    // builders skip it; both verifiers must see the same ply sequence, so filter once.
    const trace = (payload.trace ?? []).filter(
      (step) => step.move != null && step.move.pieceId !== undefined && step.move.targetPos != null
    );

    const evidence: GameResultEvidence = {
      gameId: payload.gameId,
      winner: payload.winner,
      reason: payload.reason,
      disposition: payload.disposition as GameResultEvidence['disposition'],
      executionStatus: V2_REASONS[payload.reason] === true ? 'COMPLETED' : 'BOT_FORFEIT',
      rulesRevision: payload.rulesRevision,
      totalPly: trace.length,
      trace,
    };

    const rustInput = {
      manifest: {
        game_id: payload.gameId,
        map,
        pieces: map.startingPieces.map((piece) => ({
          id: piece.id,
          owner: piece.owner,
          piece_type: piece.type,
          pos: { x: piece.pos[0], y: piece.pos[1] },
          is_alive: true,
        })),
        max_ply: MAX_PLY,
      },
      actions: trace.map((step) => ({
        piece_id: step.move.pieceId,
        target_pos: [step.move.targetPos.x, step.move.targetPos.y],
        side: sideName(step.side),
      })),
      outcome: { winner: sideName(payload.winner), reason: payload.reason },
    };

    checked++;
    const rust = runRust(options.rustBin, rustInput);
    const ts = runTypeScript(map, evidence, verifier);
    if (rust.ok) rustOk++;
    if (ts.ok) tsOk++;
    const wasm = wasmVerifier ? wasmVerifier.verify(rustInput) : null;
    if (wasm) {
      wasmChecked++;
      if (wasm.ok) wasmOk++;
    }

    const fields = [
      ...compare(rust, ts),
      ...(wasm ? compare(rust, wasm).map((field) => `wasm:${field}`) : []),
    ];
    if (fields.length > 0) {
      mismatches.push({ digest, fields, rust, ts, ...(wasm ? { wasm } : {}) });
    }
  }

  return { checked, rustOk, tsOk, wasmChecked, wasmOk, mismatches, skippedNoMap };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(
      'usage: npx tsx deploy/linux/verify-replay-parity.ts [--limit N] [--rust-bin PATH]\n' +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(2);
  }

  try {
    const summary = await checkReplays(options);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.mismatches.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`parity check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

void main();
