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
}

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
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to create match');
  }
  return res.json();
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
