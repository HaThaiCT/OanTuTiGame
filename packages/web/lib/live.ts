/**
 * Wire protocol of the public live spectator socket (`GET /api/v2/live/:gameId`) plus the single
 * place the socket base URL is derived.
 *
 * Everything here is deliberately honest about unknown data: a frame this module cannot recognise is
 * dropped and reported by the caller instead of being half-read into the board state.
 */

import { asRecord, isFiniteNumber, isMapDescriptor, type ReplayMapDescriptor, type ReplayPly } from './replay';

/** Path of the live route, relative to the API root. */
export const LIVE_WS_PATH = '/api/v2/live';
/** Port the Fastify API listens on locally — the same one `/api/*` is rewritten to in dev. */
export const LIVE_WS_DEFAULT_PORT = '4301';

/**
 * Base URL (`ws://host:port` / `wss://host:port`) the live socket is dialled at.
 *
 * `next.config.ts` rewrites only HTTP `/api/:path*` calls to the Fastify API, and a rewrite cannot
 * carry a WebSocket upgrade: dialling `ws://<next-host>/api/v2/live/…` would hit the Next server,
 * which has no such route. The socket therefore has to name the API host itself — either through
 * `NEXT_PUBLIC_LIVE_WS_BASE` (used verbatim, e.g. `wss://arena.example.com` behind a TLS proxy) or,
 * by default, the host the page was opened on with the API port. Only the client calls this; the
 * `127.0.0.1` branch just keeps the helper total under SSR.
 */
export function liveSocketBase(): string {
  const configured = process.env.NEXT_PUBLIC_LIVE_WS_BASE?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  if (typeof window !== 'undefined') {
    const secure = window.location.protocol === 'https:';
    if (window.location.port === '14443' || window.location.port === '443' || !window.location.port) {
      return `${secure ? 'wss' : 'ws'}://${window.location.host}`;
    }
  }

  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const hostname = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname;
  const port = process.env.NEXT_PUBLIC_API_PORT?.trim() || LIVE_WS_DEFAULT_PORT;
  return `${secure ? 'wss' : 'ws'}://${hostname}:${port}`;
}

/** Full socket URL of one game's live stream. */
export function liveSocketUrl(gameId: string): string {
  return `${liveSocketBase()}${LIVE_WS_PATH}/${encodeURIComponent(gameId)}`;
}

export type LiveStatus = 'RUNNING' | 'PREVIEW_ENDED' | 'FINISHED';

export interface LiveIdentity {
  readonly gameId: string;
  readonly attemptId: string;
  readonly fencingToken: string;
  readonly deploymentGeneration: number;
}

export function sameLiveIdentity(a: LiveIdentity, b: LiveIdentity): boolean {
  return a.gameId === b.gameId && a.attemptId === b.attemptId && a.fencingToken === b.fencingToken && a.deploymentGeneration === b.deploymentGeneration;
}

export interface LiveTeam {
  readonly id: string;
  readonly name: string;
}

/** One action as the stream sends it: a move with its target, or an explicit pass. */
export type LiveAction =
  | { readonly action: 'MOVE'; readonly pieceId: number; readonly target: readonly [number, number] }
  | { readonly action: 'PASS' };

/** One ply of the game: the snapshot's history entries and the per-ply `EVENT` messages. */
export interface LivePly {
  /** Parsed sequence; malformed or missing values are rejected at the message boundary. */
  readonly seq: number | null;
  readonly turnNumber: number;
  readonly side: number;
  readonly action: LiveAction;
}

export interface LiveOutcome {
  readonly winner: number | null;
  readonly reason: string;
}

export interface LiveSnapshot extends LiveIdentity {
  readonly tournamentId?: string;
  readonly seq: number;
  readonly historyComplete: boolean;
  readonly status: LiveStatus;
  /** `null` when the server sent no usable board descriptor — the viewer must say so, not guess. */
  readonly map: ReplayMapDescriptor | null;
  readonly whiteTeam: LiveTeam | null;
  readonly blackTeam: LiveTeam | null;
  /** Everything played so far; the snapshot is the authoritative history (also after a reconnect). */
  readonly events: readonly LivePly[];
  readonly outcome: LiveOutcome | null;
}

export type LiveMessage =
  | { readonly type: 'SNAPSHOT'; readonly snapshot: LiveSnapshot }
  | { readonly type: 'EVENT'; readonly identity: LiveIdentity; readonly ply: LivePly }
  | { readonly type: 'RESULT'; readonly identity: LiveIdentity; readonly outcome: LiveOutcome }
  | { readonly type: 'PREVIEW_ENDED'; readonly identity: LiveIdentity }
  | { readonly type: 'PING' };

function normalizeTeam(value: unknown): LiveTeam | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    id: typeof record.id === 'string' ? record.id : '',
    name: typeof record.name === 'string' ? record.name : '',
  };
}

function normalizeAction(value: unknown): LiveAction | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.action === 'PASS') return { action: 'PASS' };
  if (record.action !== 'MOVE' || !isFiniteNumber(record.pieceId)) return null;

  const target = record.target;
  if (!Array.isArray(target) || target.length !== 2) return null;
  const [x, y] = target;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  return { action: 'MOVE', pieceId: record.pieceId, target: [x, y] as const };
}

/**
 * A ply is only usable when its turn, side and action are all present; anything else is dropped
 * rather than defaulted, because a fabricated turn number would show up on screen as a real one.
 */
function normalizePly(value: unknown): LivePly | null {
  const record = asRecord(value);
  if (!record || !isFiniteNumber(record.turnNumber) || !isFiniteNumber(record.side)) return null;
  const action = normalizeAction(record.action);
  if (!action) return null;
  // `capture` is present on the wire but deliberately ignored: the board reconstruction derives
  // captures from the engine's dominance rule, so a second source could only disagree with the board.
  return {
    seq: isFiniteNumber(record.seq) ? record.seq : null,
    turnNumber: record.turnNumber,
    side: record.side,
    action,
  };
}

function normalizeOutcome(value: unknown): LiveOutcome | null {
  const record = asRecord(value);
  if (!record) return null;
  const winner = record.winner;
  if (winner !== null && !isFiniteNumber(winner)) return null;
  return { winner: isFiniteNumber(winner) ? winner : null, reason: typeof record.reason === 'string' ? record.reason : '' };
}

function normalizeIdentity(record: Record<string, unknown>): LiveIdentity | null {
  if (typeof record.gameId !== 'string' || typeof record.attemptId !== 'string' || typeof record.fencingToken !== 'string' ||
      !Number.isSafeInteger(record.deploymentGeneration) || (record.deploymentGeneration as number) < 0) return null;
  return { gameId: record.gameId, attemptId: record.attemptId, fencingToken: record.fencingToken, deploymentGeneration: record.deploymentGeneration as number };
}

function normalizeSnapshot(value: unknown): LiveSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const identity = normalizeIdentity(record);
  if (!identity || (record.status !== 'RUNNING' && record.status !== 'PREVIEW_ENDED' && record.status !== 'FINISHED')) return null;
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 0 || typeof record.historyComplete !== 'boolean') return null;
  const events = Array.isArray(record.events) ? record.events : [];
  const plies = events.map(normalizePly);
  if (plies.some((ply) => !ply || !Number.isSafeInteger(ply.seq) || (ply.seq as number) < 1)) return null;
  if (plies.some((ply, i) => i > 0 && ply!.seq !== plies[i - 1]!.seq! + 1)) return null;
  if (plies.length > 0 && plies[plies.length - 1]!.seq !== record.seq) return null;
  if (record.status === 'FINISHED' && !normalizeOutcome(record.result)) return null;
  if (record.historyComplete && (plies.length !== record.seq || (plies.length > 0 && plies[0]!.seq !== 1))) return null;
  return {
    ...identity,
    tournamentId: typeof record.tournamentId === 'string' ? record.tournamentId : undefined,
    seq: record.seq as number,
    historyComplete: record.historyComplete,
    status: record.status,
    map: isMapDescriptor(record.map) ? record.map : null,
    whiteTeam: normalizeTeam(record.whiteTeam),
    blackTeam: normalizeTeam(record.blackTeam),
    events: plies as LivePly[],
    outcome: record.status === 'FINISHED' ? normalizeOutcome(record.result) : null,
  };
}

/** Parses one text frame of the socket; `null` means "not a message this client understands". */
export function parseLiveMessage(raw: unknown): LiveMessage | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.type === 'SNAPSHOT') {
    const snapshot = normalizeSnapshot(record);
    return snapshot ? { type: 'SNAPSHOT', snapshot } : null;
  }
  const identity = normalizeIdentity(record);
  if (record.type !== 'PING' && !identity) return null;
  if (record.type === 'PREVIEW_ENDED') return { type: 'PREVIEW_ENDED', identity: identity! };
  if (record.type === 'EVENT') {
    const ply = normalizePly(record);
    return ply && Number.isSafeInteger(ply.seq) && (ply.seq as number) > 0 ? { type: 'EVENT', identity: identity!, ply } : null;
  }
  if (record.type === 'RESULT') {
    const outcome = normalizeOutcome(record);
    return outcome ? { type: 'RESULT', identity: identity!, outcome } : null;
  }
  if (record.type === 'PING') return { type: 'PING' };
  return null;
}


/**
 * Adapter from a live ply to the reconstruction engine's ply shape (`lib/replay.ts`). The server's
 * `turnNumber` is passed through as the ply label, so reconstruction warnings quote the same turn the
 * stream reported.
 */
export function livePlyToReplayPly(ply: LivePly): ReplayPly {
  const action = ply.action;
  return {
    ply: ply.turnNumber,
    side: ply.side,
    move:
      action.action === 'MOVE'
        ? { pieceId: action.pieceId, targetPos: { x: action.target[0], y: action.target[1] } }
        : null,
  };
}
