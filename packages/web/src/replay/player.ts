/**
 * Replay & Match State Player for OanTuTi Arena
 * Parses .oantuti binary replays and computes state snapshots at any turn.
 */

import {
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
  unpackReplay,
} from '@oantuti/protocol';
import {
  PieceType,
  PlayerSide,
  WinReason,
  Coord,
} from '@oantuti/engine';

export interface PieceState {
  readonly id: number;
  readonly owner: PlayerSide;
  readonly type: PieceType;
  readonly x: number;
  readonly y: number;
  readonly isAlive: boolean;
}

export interface ReplayTurnSnapshot {
  readonly turnNumber: number;
  readonly activePlayer: PlayerSide;
  readonly pieces: PieceState[];
  readonly lastMove?: {
    readonly pieceId: number;
    readonly from: Coord;
    readonly to: Coord;
    readonly isCapture: boolean;
    readonly victimId?: number;
  };
  readonly isGameOver: boolean;
  readonly winner?: PlayerSide;
  readonly winReason?: WinReason;
}

export interface LoadedReplay {
  readonly init: MatchInitFrameMessage;
  readonly deltas: readonly TurnDeltaFrameMessage[];
  readonly end: MatchEndFrameMessage;
  readonly snapshots: readonly ReplayTurnSnapshot[];
}

export function buildSnapshotsFromReplay(
  init: MatchInitFrameMessage,
  deltas: readonly TurnDeltaFrameMessage[],
  end: MatchEndFrameMessage
): ReplayTurnSnapshot[] {
  const snapshots: ReplayTurnSnapshot[] = [];

  // Snapshot 0: Initial State
  const initialPieces: PieceState[] = init.pieces.map((p) => ({
    id: p.id,
    owner: p.owner,
    type: p.type,
    x: p.pos.x,
    y: p.pos.y,
    isAlive: p.isAlive,
  }));

  snapshots.push({
    turnNumber: 0,
    activePlayer: PlayerSide.WHITE,
    pieces: initialPieces,
    isGameOver: false,
  });

  let currentPieces = [...initialPieces];

  for (let i = 0; i < deltas.length; i++) {
    const delta = deltas[i];
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

    const isLastTurn = i === deltas.length - 1;

    snapshots.push({
      turnNumber: delta.turnNumber,
      activePlayer: delta.activePlayer,
      pieces: currentPieces,
      lastMove,
      isGameOver: delta.isGameOver || isLastTurn,
      winner: isLastTurn ? end.winner : delta.winner,
      winReason: isLastTurn ? end.reason : delta.winReason,
    });
  }

  return snapshots;
}

export function parseReplayBinary(buffer: Uint8Array): LoadedReplay {
  const magic = new TextDecoder('ascii').decode(buffer.subarray(0, 8));
  if (magic === 'OANTUTI2') {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const manifestLen = view.getUint16(12, false);
    let offset = 14 + manifestLen;
    const jsonLen = view.getUint32(offset, false);
    offset += 4;
    const jsonStr = new TextDecoder('utf8').decode(buffer.subarray(offset, offset + jsonLen));
    const payload = JSON.parse(jsonStr) as {
      gameId: string;
      mapId: string;
      rulesRevision: string;
      manifestDigest: string;
      totalTurns: number;
      winner: number;
      reason: string;
      disposition: string;
      trace: readonly any[];
    };

    const dummyInit: MatchInitFrameMessage = {
      matchId: payload.gameId,
      map: {
        width: 5,
        height: 5,
        validTilesBitmask: new Uint8Array([0xff]),
        whiteThrone: { x: 0, y: 0 },
        blackThrone: { x: 4, y: 4 },
        mapName: payload.mapId,
      },
      pieces: [],
      maxTurns: 300,
      turnTimeLimitMs: 50,
      whiteBotName: 'Side A',
      blackBotName: 'Side B',
    };

    const dummyEnd: MatchEndFrameMessage = {
      matchId: payload.gameId,
      winner: payload.winner as any,
      reason: 1,
      whiteRemainingPieces: 0,
      blackRemainingPieces: 0,
      totalTurns: payload.totalTurns,
    };

    return {
      init: dummyInit,
      deltas: [],
      end: dummyEnd,
      snapshots: [],
    };
  }

  const { init, deltas, end } = unpackReplay(buffer);
  const snapshots = buildSnapshotsFromReplay(init, deltas, end);
  return { init, deltas, end, snapshots };
}
