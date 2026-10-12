/**
 * Server REST API Client & Binary WebSocket Live Stream Consumer
 */

import {
  decodeWebSocketFrame,
  decodeMatchInitFrame,
  decodeTurnDeltaFrame,
  decodeMatchEndFrame,
  WebSocketMessageType,
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
} from '@oantuti/protocol';
import {
  LoadedReplay,
  ReplayTurnSnapshot,
  PieceState,
} from '../replay/player.js';

export interface MapSummary {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly validTilesCount: number;
}

export interface BotSummary {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly elo: number;
  readonly version: number;
  readonly user_id: string;
}
export type BotLanguage = 'PYTHON' | 'TYPESCRIPT' | 'CPP';
export interface PublicUser { id: string; username: string; email: string; role: string }
export interface BotDetail { id: string; name: string; language: BotLanguage; sourceCode: string; version: number; userId: string; isActive: boolean }
export interface BotVersion { version: number; name: string; language: BotLanguage; sourceCode: string; createdAt: string }
export interface BotInput { name: string; language: BotLanguage; sourceCode: string }
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export const SESSION_INVALIDATED = 'oantuti:session-invalidated';
async function requireSuccess(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) window.dispatchEvent(new Event(SESSION_INVALIDATED));
  const body: unknown = await res.json().catch(() => null);
  const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error : `Request failed (${res.status} ${res.statusText})`;
  throw new ApiError(message, res.status);
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  await requireSuccess(res);
  return res.status === 204 ? undefined as T : res.json();
}
export const fetchSession = () => request<{user: PublicUser | null}>('/api/auth/me');
export const login = (username: string, password: string) => request<{user: PublicUser}>('/api/auth/login', 'POST', {username, password});
export const register = (username: string, email: string, password: string) => request<{user: PublicUser}>('/api/auth/register', 'POST', {username, email, password});
export const logout = () => request<void>('/api/auth/logout', 'POST', {});
export const fetchOwnedBots = async () => (await request<{bots: BotSummary[]}>('/api/bots?mine=1')).bots;
export const fetchBot = async (id: string) => (await request<{bot: BotDetail}>('/api/bots/' + encodeURIComponent(id))).bot;
export const fetchBotVersions = async (id: string) => (await request<{versions: BotVersion[]}>('/api/bots/' + encodeURIComponent(id) + '/versions')).versions;
export const saveBot = async (input: BotInput, existing?: {id: string; version: number}) =>
  (await request<{bot: BotDetail}>(existing ? '/api/bots/' + encodeURIComponent(existing.id) : '/api/bots', existing ? 'PUT' : 'POST', {...input, ...(existing ? {version: existing.version} : {})})).bot;
export const deleteBot = (id: string) => request<void>('/api/bots/' + encodeURIComponent(id), 'DELETE');
export const createTestMatch = (input: {mapId: string; opponentBotId: string; language: BotLanguage; sourceCode: string; maxTurns?: number}) =>
  request<{matchId: string; status: 'RUNNING'}>('/api/matches/test', 'POST', input);

export async function fetchMaps(): Promise<MapSummary[]> {
  const res = await fetch('/api/maps');
  if (!res.ok) throw new Error(`Failed to fetch maps: ${res.statusText}`);
  const data = await res.json();
  return data.maps;
}

export async function fetchBots(): Promise<BotSummary[]> {
  const res = await fetch('/api/bots');
  if (!res.ok) throw new Error(`Failed to fetch bots: ${res.statusText}`);
  const data = await res.json();
  return data.bots;
}

export async function createMatch(
  mapId: string,
  whiteBotId: string,
  blackBotId: string,
  maxTurns: number = 300
): Promise<{ matchId: string; status: string }> {
  const res = await fetch('/api/matches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapId, whiteBotId, blackBotId, maxTurns }),
  });
  await requireSuccess(res);
  return res.json();
}

export interface TournamentSummary {
  readonly id: string;
  readonly name: string;
  readonly format: string;
  readonly status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
  readonly created_at: string;
  readonly started_at?: string;
  readonly finished_at?: string;
}

export interface TournamentStanding {
  readonly botId: string;
  readonly botName: string;
  readonly language: string;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly points: number;
  readonly elo: number;
}

export interface TournamentMatch {
  readonly id: string;
  readonly map_id: string;
  readonly white_bot_id: string;
  readonly black_bot_id: string;
  readonly white_bot_name: string;
  readonly black_bot_name: string;
  readonly winner_side?: 'WHITE' | 'BLACK' | 'DRAW';
  readonly win_reason?: string;
  readonly total_turns: number;
  readonly finished_at?: string;
}

export interface TournamentDetailsResponse {
  readonly tournament: TournamentSummary;
  readonly standings: TournamentStanding[];
  readonly matches: TournamentMatch[];
}

export async function fetchTournaments(): Promise<TournamentSummary[]> {
  const res = await fetch('/api/tournaments');
  if (!res.ok) throw new Error(`Failed to fetch tournaments: ${res.statusText}`);
  const data = await res.json();
  return data.tournaments;
}

export async function fetchTournamentDetails(id: string): Promise<TournamentDetailsResponse> {
  const res = await fetch(`/api/tournaments/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch tournament: ${res.statusText}`);
  return res.json();
}

export async function createTournament(params: {
  name: string;
  format?: 'ROUND_ROBIN' | 'SWISS';
  mapId: string;
  botIds: string[];
  maxTurns?: number;
  doubleRound?: boolean;
}): Promise<TournamentSummary> {
  const res = await fetch('/api/tournaments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  await requireSuccess(res);
  const data = await res.json();
  return data.tournament;
}

export interface LiveMatchCallbacks {
  onInit: (init: MatchInitFrameMessage, replay: LoadedReplay) => void;
  onDelta: (delta: TurnDeltaFrameMessage, snapshot: ReplayTurnSnapshot, replay: LoadedReplay) => void;
  onEnd: (end: MatchEndFrameMessage, replay: LoadedReplay) => void;
  onError: (err: Error) => void;
}

export function subscribeLiveMatch(
  matchId: string,
  callbacks: LiveMatchCallbacks
): { disconnect: () => void } {
  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const proto = isHttps ? 'wss:' : 'ws:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
  const wsUrl = `${proto}//${host}/ws/matches/${matchId}`;

  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';

  let currentInit: MatchInitFrameMessage | null = null;
  const currentDeltas: TurnDeltaFrameMessage[] = [];
  const currentSnapshots: ReplayTurnSnapshot[] = [];
  let currentPieces: PieceState[] = [];
  let currentEnd: MatchEndFrameMessage | null = null;

  socket.onmessage = (event: MessageEvent) => {
    try {
      if (!(event.data instanceof ArrayBuffer)) return;
      const buffer = new Uint8Array(event.data);
      if (buffer.length < 5) return;

      const { type, payload } = decodeWebSocketFrame(buffer);

      if (type === WebSocketMessageType.MSG_INIT) {
        currentInit = decodeMatchInitFrame(payload);

        const initialPieces: PieceState[] = currentInit.pieces.map((p) => ({
          id: p.id,
          owner: p.owner,
          type: p.type,
          x: p.pos.x,
          y: p.pos.y,
          isAlive: p.isAlive,
        }));

        currentPieces = [...initialPieces];
        currentSnapshots.length = 0;
        currentSnapshots.push({
          turnNumber: 0,
          activePlayer: currentInit.pieces[0]?.owner ?? 1,
          pieces: initialPieces,
          isGameOver: false,
        });

        const replay: LoadedReplay = {
          init: currentInit,
          deltas: currentDeltas,
          end: currentEnd ?? {
            matchId: currentInit.matchId,
            reason: 0,
            totalTurns: 0,
            whiteRemainingPieces: 0,
            blackRemainingPieces: 0,
          },
          snapshots: currentSnapshots,
        };

        callbacks.onInit(currentInit, replay);
      } else if (type === WebSocketMessageType.MSG_DELTA) {
        if (!currentInit) return;

        const delta = decodeTurnDeltaFrame(payload);
        currentDeltas.push(delta);

        let lastMove: ReplayTurnSnapshot['lastMove'] | undefined;
        if (delta.action) {
          const moverId = delta.action.pieceId;
          const targetPos = delta.action.targetPos;
          const mover = currentPieces.find((p) => p.id === moverId);

          if (mover) {
            lastMove = {
              pieceId: moverId,
              from: { x: mover.x, y: mover.y },
              to: { x: targetPos.x, y: targetPos.y },
              isCapture: Boolean(delta.capture),
              victimId: delta.capture?.victimId,
            };
          }

          currentPieces = currentPieces.map((p) => {
            if (delta.capture && p.id === delta.capture.victimId) {
              return { ...p, isAlive: false };
            }
            if (p.id === moverId) {
              return { ...p, x: targetPos.x, y: targetPos.y };
            }
            return p;
          });
        }

        const snapshot: ReplayTurnSnapshot = {
          turnNumber: delta.turnNumber,
          activePlayer: delta.activePlayer,
          pieces: currentPieces,
          lastMove,
          isGameOver: delta.isGameOver,
          winner: delta.winner,
          winReason: delta.winReason,
        };

        currentSnapshots.push(snapshot);

        const replay: LoadedReplay = {
          init: currentInit,
          deltas: currentDeltas,
          end: currentEnd ?? {
            matchId: currentInit.matchId,
            reason: 0,
            totalTurns: currentDeltas.length,
            whiteRemainingPieces: 0,
            blackRemainingPieces: 0,
          },
          snapshots: currentSnapshots,
        };

        callbacks.onDelta(delta, snapshot, replay);
      } else if (type === WebSocketMessageType.MSG_END) {
        if (!currentInit) return;
        currentEnd = decodeMatchEndFrame(payload);

        const replay: LoadedReplay = {
          init: currentInit,
          deltas: currentDeltas,
          end: currentEnd,
          snapshots: currentSnapshots,
        };

        callbacks.onEnd(currentEnd, replay);
      } else if (type === WebSocketMessageType.MSG_ERROR) {
        const text = new TextDecoder().decode(payload);
        callbacks.onError(new Error(text));
      }
    } catch (err) {
      callbacks.onError(err as Error);
    }
  };

  socket.onerror = () => {
    callbacks.onError(new Error('WebSocket connection error'));
  };

  return {
    disconnect: () => {
      try {
        socket.close();
      } catch {
        // Ignore
      }
    },
  };
}
