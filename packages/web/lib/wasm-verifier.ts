/**
 * In-browser verification of an official replay through the shared Rust engine compiled to
 * `wasm32-unknown-unknown` (`crates/arena-engine-wasm`, export `oantuti_verify_replay`).
 *
 * The WASM module replays the same trace with the same `arena_engine::replay` loop the server and
 * the native `verify-trace` binary use, so a spectator can confirm the published result without
 * trusting the server response. The module is served from `public/wasm/` (see
 * `deploy/linux/build-wasm-verifier.sh`); nothing is fetched from a CDN.
 */
import { isMapDescriptor, type ReplayPayload } from './replay';

export const WASM_VERIFIER_PATH = '/wasm/arena_engine_wasm.wasm';
/** Keep in step with `TraceVerifier`/native CLI default. */
const MAX_PLY = 300;

export interface WasmVerifierVerdict {
  readonly ok: boolean;
  readonly appliedPly: number | null;
  readonly winner: 'WHITE' | 'BLACK' | null;
  readonly reason: string | null;
  readonly error?: string;
}

interface WasmExports {
  readonly memory: WebAssembly.Memory;
  oantuti_alloc(len: number): number;
  oantuti_free(ptr: number, len: number): void;
  oantuti_verify_replay(ptr: number, len: number): number;
  oantuti_result_free(ptr: number): void;
}

let cachedModule: Promise<WasmExports> | null = null;

/** Fetches and instantiates the verifier once per page. */
export function loadWasmVerifier(): Promise<WasmExports> {
  cachedModule ??= (async () => {
    const response = await fetch(WASM_VERIFIER_PATH, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`không tải được ${WASM_VERIFIER_PATH} (HTTP ${response.status})`);
    }
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    return instance.exports as unknown as WasmExports;
  })();
  return cachedModule;
}

function sideName(winner: number): 'WHITE' | 'BLACK' | null {
  if (winner === 1) return 'WHITE';
  if (winner === 2) return 'BLACK';
  return null;
}

/**
 * Builds the trace document the Rust verifier consumes. Returns `null` when the payload carries no
 * usable board descriptor — the caller then says so instead of fabricating a verification.
 */
export function buildTraceDocument(payload: ReplayPayload): unknown | null {
  const map = payload.map;
  if (!isMapDescriptor(map)) return null;

  const trace = (payload.trace ?? []).filter(
    (step) => step.move != null && step.move.pieceId !== undefined && step.move.targetPos != null
  );

  return {
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
}

/** Replays one payload through the WASM verifier; `null` when the payload has no board. */
export async function verifyReplayWithWasm(payload: ReplayPayload): Promise<WasmVerifierVerdict | null> {
  const document = buildTraceDocument(payload);
  if (document === null) return null;

  const exports = await loadWasmVerifier();
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const inputPtr = exports.oantuti_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, inputPtr, bytes.length).set(bytes);
  let resultPtr: number;
  try {
    resultPtr = exports.oantuti_verify_replay(inputPtr, bytes.length);
  } finally {
    exports.oantuti_free(inputPtr, bytes.length);
  }

  const view = new DataView(exports.memory.buffer);
  const length = view.getUint32(resultPtr, true);
  const json = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, resultPtr + 4, length));
  exports.oantuti_result_free(resultPtr);

  const parsed = JSON.parse(json) as {
    ok?: unknown;
    appliedPly?: unknown;
    winner?: unknown;
    reason?: unknown;
    error?: unknown;
  };
  return {
    ok: parsed.ok === true,
    appliedPly: typeof parsed.appliedPly === 'number' ? parsed.appliedPly : null,
    winner: parsed.winner === 'WHITE' ? 'WHITE' : parsed.winner === 'BLACK' ? 'BLACK' : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
  };
}
