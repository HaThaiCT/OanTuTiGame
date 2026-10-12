/**
 * Protobuf Coders and Decoders for OanTuTi Arena Frames
 */

import {
  MatchInitFrameType,
  TurnDeltaFrameType,
  MatchEndFrameType,
  WebSocketEnvelopeType,
} from './schema.js';
import {
  MatchInitFrameMessage,
  PieceMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
} from './types.js';

export function encodeMatchInitFrame(frame: MatchInitFrameMessage): Uint8Array {
  const errMsg = MatchInitFrameType.verify(frame);
  if (errMsg) {
    throw new Error(`MatchInitFrame verification failed: ${errMsg}`);
  }
  const message = MatchInitFrameType.create(frame);
  return MatchInitFrameType.encode(message).finish();
}

export function decodeMatchInitFrame(buffer: Uint8Array): MatchInitFrameMessage {
  const decoded = MatchInitFrameType.decode(buffer);
  const obj = MatchInitFrameType.toObject(decoded, {
    bytes: Uint8Array,
    enums: Number,
    defaults: true,
  });

  return {
    matchId: obj.matchId,
    map: {
      width: obj.map.width,
      height: obj.map.height,
      validTilesBitmask: obj.map.validTilesBitmask,
      whiteThrone: { x: obj.map.whiteThrone.x, y: obj.map.whiteThrone.y },
      blackThrone: { x: obj.map.blackThrone.x, y: obj.map.blackThrone.y },
      mapName: obj.map.mapName,
    },
    pieces: (obj.pieces ?? []).map((p: PieceMessage) => ({
      id: p.id,
      owner: p.owner,
      type: p.type,
      pos: { x: p.pos.x, y: p.pos.y },
      isAlive: p.isAlive,
    })),
    maxTurns: obj.maxTurns,
    turnTimeLimitMs: obj.turnTimeLimitMs,
    whiteBotName: obj.whiteBotName,
    blackBotName: obj.blackBotName,
  };
}

export function encodeTurnDeltaFrame(frame: TurnDeltaFrameMessage): Uint8Array {
  const normalized = {
    ...frame,
    timeConsumedNs:
      typeof frame.timeConsumedNs === 'bigint'
        ? Number(frame.timeConsumedNs)
        : frame.timeConsumedNs,
  };
  const errMsg = TurnDeltaFrameType.verify(normalized);
  if (errMsg) {
    throw new Error(`TurnDeltaFrame verification failed: ${errMsg}`);
  }
  const message = TurnDeltaFrameType.create(normalized);
  return TurnDeltaFrameType.encode(message).finish();
}

export function decodeTurnDeltaFrame(buffer: Uint8Array): TurnDeltaFrameMessage {
  const decoded = TurnDeltaFrameType.decode(buffer);
  const obj = TurnDeltaFrameType.toObject(decoded, {
    longs: Number,
    enums: Number,
    defaults: false,
  });

  return {
    turnNumber: obj.turnNumber ?? 0,
    activePlayer: obj.activePlayer ?? 0,
    action: obj.action
      ? {
          pieceId: obj.action.pieceId,
          targetPos: { x: obj.action.targetPos.x, y: obj.action.targetPos.y },
        }
      : undefined,
    capture: obj.capture
      ? {
          attackerId: obj.capture.attackerId,
          victimId: obj.capture.victimId,
          victimType: obj.capture.victimType,
          pos: { x: obj.capture.pos.x, y: obj.capture.pos.y },
        }
      : undefined,
    timeConsumedNs: BigInt(obj.timeConsumedNs ?? 0),
    isGameOver: Boolean(obj.isGameOver),
    winner: obj.winner,
    winReason: obj.winReason,
  };
}

export function encodeMatchEndFrame(frame: MatchEndFrameMessage): Uint8Array {
  const errMsg = MatchEndFrameType.verify(frame);
  if (errMsg) {
    throw new Error(`MatchEndFrame verification failed: ${errMsg}`);
  }
  const message = MatchEndFrameType.create(frame);
  return MatchEndFrameType.encode(message).finish();
}

export function decodeMatchEndFrame(buffer: Uint8Array): MatchEndFrameMessage {
  const decoded = MatchEndFrameType.decode(buffer);
  const obj = MatchEndFrameType.toObject(decoded, {
    enums: Number,
    defaults: true,
  });

  return {
    matchId: obj.matchId,
    winner: obj.winner,
    reason: obj.reason,
    totalTurns: obj.totalTurns,
    whiteRemainingPieces: obj.whiteRemainingPieces,
    blackRemainingPieces: obj.blackRemainingPieces,
  };
}

export function encodeWebSocketEnvelope(type: number, payload: Uint8Array): Uint8Array {
  const message = WebSocketEnvelopeType.create({ type, payload });
  return WebSocketEnvelopeType.encode(message).finish();
}

export function decodeWebSocketEnvelope(buffer: Uint8Array): { type: number; payload: Uint8Array } {
  const decoded = WebSocketEnvelopeType.decode(buffer);
  const obj = WebSocketEnvelopeType.toObject(decoded, {
    bytes: Uint8Array,
    enums: Number,
  });
  return {
    type: obj.type,
    payload: obj.payload,
  };
}
