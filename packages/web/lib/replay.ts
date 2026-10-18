/**
 * Browser-side decoding of the canonical `OANTUTI2` replay object.
 *
 * Layout (`packages/server/src/results/replay-store.ts`):
 *
 *   "OANTUTI2" (8 ASCII) | version uint32 BE (=2) | manifestDigestLen uint16 BE
 *   | manifestDigest UTF-8 | payloadJsonLen uint32 BE | payload JSON
 *   | SHA-256 (32 raw bytes) over every preceding byte
 *
 * The payload is decoded eagerly so the move list can render even when no board descriptor was
 * stored; the trailing checksum is verified separately (and asynchronously) with `crypto.subtle`,
 * because the viewer must be able to say "chưa kiểm tra được" or "không khớp" instead of silently
 * treating unverified bytes as authentic.
 *
 * Board reconstruction lives here rather than in `@oantuti/engine`: that package ships TypeScript
 * sources whose internal re-exports use `./x.js` specifiers, which the Next bundler cannot resolve
 * from a web app, and `next.config.ts` is out of scope for this change. The rules reproduced below
 * are exactly the ones the engine applies — king-step movement over `validTiles`, cyclic
 * rock-paper-scissors dominance for captures — and every ply that does not satisfy them is
 * annotated instead of being applied silently.
 */

export const REPLAY_MAGIC = 'OANTUTI2';
export const REPLAY_VERSION = 2;
/** Trailing raw SHA-256 over everything before it. */
export const REPLAY_TRAILER_BYTES = 32;
const MIN_REPLAY_BYTES = 8 + 4 + 2 + 4 + REPLAY_TRAILER_BYTES;

export type ReplayPieceKind = 'ROCK' | 'SCISSORS' | 'PAPER';
export type ReplayOwner = 'WHITE' | 'BLACK';

/** One starting piece of the board descriptor carried by the payload. */
export interface ReplayMapPiece {
  readonly id: number;
  readonly owner: ReplayOwner;
  readonly type: ReplayPieceKind;
  readonly pos: [number, number];
}

/**
 * Full board descriptor, structurally identical to `MapDescriptor` of `@oantuti/engine`
 * (`packages/engine/src/graph.ts`). Older replay objects never stored one.
 */
export interface ReplayMapDescriptor {
  readonly mapName: string;
  readonly width: number;
  readonly height: number;
  readonly validTiles: [number, number][];
  readonly whiteThrone: [number, number];
  readonly blackThrone: [number, number];
  readonly startingPieces: ReplayMapPiece[];
}

/** One ply of `payload.trace` (`ActionTraceStep` of `@oantuti/protocol`). */
export interface ReplayMoveStep {
  readonly ply: number;
  readonly side: number;
  readonly move: {
    readonly pieceId: number;
    readonly targetPos: { readonly x: number; readonly y: number };
  };
}

export interface ReplayPayload {
  readonly gameId: string;
  readonly attemptId: string;
  readonly mapId: string;
  readonly rulesRevision: string;
  readonly manifestDigest: string;
  readonly totalTurns: number;
  /** 0 = hòa/không thắng, 1 = WHITE, 2 = BLACK — the official-results convention. */
  readonly winner: number;
  readonly reason: string;
  readonly disposition: string;
  readonly trace: readonly ReplayMoveStep[];
  readonly map?: ReplayMapDescriptor;
}

export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayFormatError';
  }
}

export interface ParsedReplay {
  readonly version: number;
  /** Digest repeated in the header; the payload carries the same value. */
  readonly manifestDigest: string;
  readonly payload: ReplayPayload;
  /** The bytes exactly as received — the last {@link REPLAY_TRAILER_BYTES} are the checksum. */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** JSON guards shared with `lib/live.ts`, which validates the live stream the same strict way. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPosition(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

/**
 * A board descriptor is only usable when every field the renderer touches is present and sane;
 * anything else counts as "không kèm bàn đấu" rather than being rendered from partial data. Exported
 * because the live spectator stream validates its snapshot's `map` with the same rule.
 */
export function isMapDescriptor(value: unknown): value is ReplayMapDescriptor {
  const map = asRecord(value);
  if (!map) return false;
  if (typeof map.mapName !== 'string') return false;
  if (!isFiniteNumber(map.width) || !isFiniteNumber(map.height)) return false;
  if (!Array.isArray(map.validTiles) || map.validTiles.length === 0) return false;
  if (!map.validTiles.every(isPosition)) return false;
  if (!isPosition(map.whiteThrone) || !isPosition(map.blackThrone)) return false;
  if (!Array.isArray(map.startingPieces)) return false;
  return map.startingPieces.every((piece) => {
    const entry = asRecord(piece);
    if (!entry) return false;
    if (!isFiniteNumber(entry.id)) return false;
    if (entry.owner !== 'WHITE' && entry.owner !== 'BLACK') return false;
    if (entry.type !== 'ROCK' && entry.type !== 'SCISSORS' && entry.type !== 'PAPER') return false;
    return isPosition(entry.pos);
  });
}

function normalizeStep(value: unknown): ReplayMoveStep | null {
  const step = asRecord(value);
  if (!step) return null;
  const move = asRecord(step.move);
  if (!move) return null;
  const targetPos = asRecord(move.targetPos);
  if (!targetPos || !isFiniteNumber(targetPos.x) || !isFiniteNumber(targetPos.y)) return null;
  if (!isFiniteNumber(move.pieceId)) return null;
  return {
    ply: isFiniteNumber(step.ply) ? step.ply : 0,
    side: isFiniteNumber(step.side) ? step.side : 0,
    move: { pieceId: move.pieceId, targetPos: { x: targetPos.x, y: targetPos.y } },
  };
}

/**
 * Unpacks the binary. Throws {@link ReplayFormatError} when the container is not a v2 replay;
 * a trace entry that is structurally broken is dropped (the viewer keeps the rest of the game).
 */
export function parseReplayBinary(input: ArrayBuffer): ParsedReplay {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < MIN_REPLAY_BYTES) {
    throw new ReplayFormatError(`Tệp replay quá ngắn để có cấu trúc OANTUTI2 (${bytes.byteLength} byte).`);
  }

  const decoder = new TextDecoder();
  const magic = decoder.decode(bytes.subarray(0, 8));
  if (magic !== REPLAY_MAGIC) {
    throw new ReplayFormatError(`Sai chữ ký replay: "${magic}" (cần "${REPLAY_MAGIC}").`);
  }

  const view = new DataView(input);
  const version = view.getUint32(8, false);
  if (version !== REPLAY_VERSION) {
    throw new ReplayFormatError(`Không hỗ trợ replay phiên bản ${version} (cần ${REPLAY_VERSION}).`);
  }

  const manifestLength = view.getUint16(12, false);
  const jsonLengthOffset = 14 + manifestLength;
  if (jsonLengthOffset + 4 > bytes.byteLength - REPLAY_TRAILER_BYTES) {
    throw new ReplayFormatError('Phần header của replay bị cắt cụt.');
  }
  const manifestDigest = decoder.decode(bytes.subarray(14, jsonLengthOffset));

  const jsonLength = view.getUint32(jsonLengthOffset, false);
  const jsonOffset = jsonLengthOffset + 4;
  if (jsonOffset + jsonLength > bytes.byteLength - REPLAY_TRAILER_BYTES) {
    throw new ReplayFormatError('Phần payload của replay bị cắt cụt.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes.subarray(jsonOffset, jsonOffset + jsonLength)));
  } catch {
    throw new ReplayFormatError('Payload replay không phải JSON hợp lệ.');
  }

  const payloadRecord = asRecord(raw);
  if (!payloadRecord) {
    throw new ReplayFormatError('Payload replay không phải đối tượng JSON.');
  }
  if (!Array.isArray(payloadRecord.trace)) {
    throw new ReplayFormatError('Payload replay thiếu mảng trace (danh sách nước đi).');
  }

  const payload: ReplayPayload = {
    gameId: typeof payloadRecord.gameId === 'string' ? payloadRecord.gameId : '',
    attemptId: typeof payloadRecord.attemptId === 'string' ? payloadRecord.attemptId : '',
    mapId: typeof payloadRecord.mapId === 'string' ? payloadRecord.mapId : '',
    rulesRevision: typeof payloadRecord.rulesRevision === 'string' ? payloadRecord.rulesRevision : '',
    manifestDigest: typeof payloadRecord.manifestDigest === 'string' ? payloadRecord.manifestDigest : manifestDigest,
    totalTurns: isFiniteNumber(payloadRecord.totalTurns) ? payloadRecord.totalTurns : 0,
    winner: isFiniteNumber(payloadRecord.winner) ? payloadRecord.winner : 0,
    reason: typeof payloadRecord.reason === 'string' ? payloadRecord.reason : '',
    disposition: typeof payloadRecord.disposition === 'string' ? payloadRecord.disposition : '',
    trace: payloadRecord.trace.map(normalizeStep).filter((step): step is ReplayMoveStep => step !== null),
    map: isMapDescriptor(payloadRecord.map) ? payloadRecord.map : undefined,
  };

  return { version, manifestDigest, payload, bytes };
}

export type ReplayChecksumStatus =
  | { readonly kind: 'verified' }
  | { readonly kind: 'mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Recomputes the trailing SHA-256 with `crypto.subtle`.
 *
 * `crypto.subtle` only exists in a secure context, so a projector opened over plain
 * `http://<lan-ip>` reports `unavailable` — that is deliberately a third state, never a pass.
 */
export async function verifyReplayChecksum(bytes: Uint8Array<ArrayBuffer>): Promise<ReplayChecksumStatus> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (!subtle) {
    return {
      kind: 'unavailable',
      reason:
        'Trình duyệt không cung cấp crypto.subtle (thường do trang chạy trên HTTP không bảo mật) nên không thể tính lại SHA-256.',
    };
  }
  if (bytes.byteLength <= REPLAY_TRAILER_BYTES) {
    return { kind: 'unavailable', reason: 'Tệp replay không đủ dài để chứa checksum.' };
  }

  const body = bytes.subarray(0, bytes.byteLength - REPLAY_TRAILER_BYTES);
  const trailer = bytes.subarray(bytes.byteLength - REPLAY_TRAILER_BYTES);
  try {
    const computed = new Uint8Array(await subtle.digest('SHA-256', body));
    const expected = hex(trailer);
    const actual = hex(computed);
    return expected === actual ? { kind: 'verified' } : { kind: 'mismatch', expected, actual };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : 'Lỗi không xác định khi tính SHA-256.',
    };
  }
}

/* ---------------------------------------------------------------------------------------------
 * Board reconstruction — the position after each ply, for the animation.
 * ------------------------------------------------------------------------------------------- */

export interface ReplayBoardPiece {
  readonly id: number;
  readonly owner: ReplayOwner;
  readonly kind: ReplayPieceKind;
  x: number;
  y: number;
  alive: boolean;
}

export interface ReplayCapturedPiece {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export interface ReplayFrame {
  /** 0 is the starting position; frame N holds the board after ply N. */
  readonly index: number;
  readonly ply: number | null;
  readonly side: number | null;
  readonly pieces: readonly ReplayBoardPiece[];
  readonly movedPieceId: number | null;
  readonly captured: ReplayCapturedPiece | null;
  /** Set when the ply broke the engine's rules and the board fell back to raw trace data. */
  readonly note: string | null;
}

export interface ReplayFrames {
  /** Board the frames were reconstructed on — the caller renders it directly. */
  readonly descriptor: ReplayMapDescriptor;
  readonly frames: readonly ReplayFrame[];
  /** Anything the reconstruction could not apply exactly as the engine would. */
  readonly warnings: readonly string[];
}

/** Cyclic dominance of `combatDominance` in `packages/engine/src/rules.ts`: R > S > P > R. */
function beats(attacker: ReplayPieceKind, defender: ReplayPieceKind): boolean {
  return (
    (attacker === 'ROCK' && defender === 'SCISSORS') ||
    (attacker === 'SCISSORS' && defender === 'PAPER') ||
    (attacker === 'PAPER' && defender === 'ROCK')
  );
}

function livingAt(pieces: Map<number, ReplayBoardPiece>, x: number, y: number): ReplayBoardPiece | null {
  for (const piece of pieces.values()) {
    if (piece.alive && piece.x === x && piece.y === y) return piece;
  }
  return null;
}

/**
 * One ply as the reconstruction engine consumes it; `move: null` is a pass, which leaves the
 * position untouched. The binary replay trace never holds a pass (it only records moves), while the
 * live stream reports passes explicitly — hence the nullable move.
 */
export interface ReplayPly {
  readonly ply: number;
  readonly side: number;
  readonly move: {
    readonly pieceId: number;
    readonly targetPos: { readonly x: number; readonly y: number };
  } | null;
}

/**
 * Rebuilds one frame per ply by applying the engine's rules to the starting position: frame 0 is the
 * starting position, frame N is the board after `plies[N - 1]`.
 *
 * This is the single reconstruction engine. The replay viewer feeds it the decoded trace and the
 * live spectator feeds it the events of a running match, so both render the same rules (and the same
 * warnings) instead of a second copy drifting apart.
 *
 * A ply the rules reject (an old v1 trace, or a trace that stops on a bot fault) does not abort the
 * animation: the mover is relocated from the raw data and the frame carries a `note` saying so.
 */
export function buildBoardFrames(
  descriptor: ReplayMapDescriptor,
  plies: readonly ReplayPly[]
): ReplayFrames {
  const validTiles = new Set(descriptor.validTiles.map(([x, y]) => `${x},${y}`));
  const pieces = new Map<number, ReplayBoardPiece>();
  for (const piece of descriptor.startingPieces) {
    pieces.set(piece.id, {
      id: piece.id,
      owner: piece.owner,
      kind: piece.type,
      x: piece.pos[0],
      y: piece.pos[1],
      alive: true,
    });
  }

  const warnings: string[] = [];
  const frames: ReplayFrame[] = [
    {
      index: 0,
      ply: null,
      side: null,
      pieces: [...pieces.values()].map((piece) => ({ ...piece })),
      movedPieceId: null,
      captured: null,
      note: null,
    },
  ];

  for (const step of plies) {
    const move = step.move;
    let captured: ReplayCapturedPiece | null = null;
    let note: string | null = null;
    let movedPieceId: number | null = null;

    if (move === null) {
      // A pass: the board is untouched and the frame only records that the side acted.
    } else {
      const mover = pieces.get(move.pieceId) ?? null;
      const { x, y } = move.targetPos;

      if (!mover || !mover.alive) {
        note = `Nước ${step.ply}: quân #${move.pieceId} không còn trên bàn — bỏ qua nước này.`;
      } else {
        const occupant = livingAt(pieces, x, y);
        const distance = Math.max(Math.abs(x - mover.x), Math.abs(y - mover.y));
        if (!validTiles.has(`${x},${y}`)) {
          note = `Nước ${step.ply}: ô đích (${x}, ${y}) không nằm trên bàn — bảng vẽ theo dữ liệu thô của ván.`;
        } else if (distance !== 1) {
          note = `Nước ${step.ply}: quân #${mover.id} đi ${distance} ô trong khi luật chỉ cho 1 ô — bảng vẽ theo dữ liệu thô của ván.`;
        } else if (occupant && occupant.owner === mover.owner) {
          note = `Nước ${step.ply}: ô đích (${x}, ${y}) đang có quân cùng phe #${occupant.id} — bảng vẽ theo dữ liệu thô của ván.`;
        } else if (occupant && !beats(mover.kind, occupant.kind)) {
          note = `Nước ${step.ply}: #${mover.id} (${mover.kind}) không thắng được #${occupant.id} (${occupant.kind}) — bảng vẽ theo dữ liệu thô của ván.`;
        }
        if (occupant && occupant.owner !== mover.owner) {
          occupant.alive = false;
          captured = { id: occupant.id, x, y };
        }
        mover.x = x;
        mover.y = y;
        movedPieceId = mover.id;
      }
    }

    if (note) warnings.push(note);
    frames.push({
      index: frames.length,
      ply: step.ply,
      side: step.side,
      pieces: [...pieces.values()].map((piece) => ({ ...piece })),
      movedPieceId,
      captured,
      note,
    });
  }

  return { descriptor, frames, warnings };
}

/**
 * Rebuilds the frames of a decoded `OANTUTI2` payload. Returns `null` when the payload carries no
 * usable board descriptor — the caller then renders an honest notice plus the move list instead of a
 * fabricated board.
 */
export function buildReplayFrames(payload: ReplayPayload): ReplayFrames | null {
  const descriptor = payload.map;
  if (!descriptor) return null;
  return buildBoardFrames(descriptor, payload.trace);
}
