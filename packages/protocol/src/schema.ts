/**
 * In-memory Protocol Buffers Schema Definition for OanTuTi Arena
 * Embedded directly from docs/specs/proto/oantuti.proto for zero-I/O runtime performance.
 */

import protobufPkg from 'protobufjs';

function resolveProtobufNamespace(): typeof protobufPkg {
  const raw: unknown = protobufPkg;
  if (raw && typeof raw === 'object') {
    if ('Root' in raw) {
      return raw as typeof protobufPkg;
    }
    if ('default' in raw && raw.default && typeof raw.default === 'object' && 'Root' in raw.default) {
      return raw.default as typeof protobufPkg;
    }
  }
  return protobufPkg;
}

const protobuf = resolveProtobufNamespace();
export const PROTO_ROOT_JSON: protobuf.INamespace = {
  nested: {
    oantuti: {
      nested: {
        PieceType: {
          values: {
            PIECE_TYPE_UNSPECIFIED: 0,
            ROCK: 1,
            SCISSORS: 2,
            PAPER: 3,
          },
        },
        PlayerSide: {
          values: {
            PLAYER_UNSPECIFIED: 0,
            WHITE: 1,
            BLACK: 2,
          },
        },
        WinReason: {
          values: {
            WIN_REASON_UNSPECIFIED: 0,
            EXTINCTION: 1,
            THRONE_BREACH: 2,
            STALEMATE: 3,
            TIMEOUT: 4,
            ILLEGAL_MOVE: 5,
            CRASH_FORFEIT: 6,
            MAX_TURNS_DRAW: 7,
            PROTOCOL_VIOLATION: 8,
          },
        },
        Coord: {
          fields: {
            x: { type: 'int32', id: 1 },
            y: { type: 'int32', id: 2 },
          },
        },
        MapLayout: {
          fields: {
            width: { type: 'int32', id: 1 },
            height: { type: 'int32', id: 2 },
            validTilesBitmask: { type: 'bytes', id: 3 },
            whiteThrone: { type: 'Coord', id: 4 },
            blackThrone: { type: 'Coord', id: 5 },
            mapName: { type: 'string', id: 6 },
          },
        },
        Piece: {
          fields: {
            id: { type: 'int32', id: 1 },
            owner: { type: 'PlayerSide', id: 2 },
            type: { type: 'PieceType', id: 3 },
            pos: { type: 'Coord', id: 4 },
            isAlive: { type: 'bool', id: 5 },
          },
        },
        MoveAction: {
          fields: {
            pieceId: { type: 'int32', id: 1 },
            targetPos: { type: 'Coord', id: 2 },
          },
        },
        CaptureEvent: {
          fields: {
            attackerId: { type: 'int32', id: 1 },
            victimId: { type: 'int32', id: 2 },
            victimType: { type: 'PieceType', id: 3 },
            pos: { type: 'Coord', id: 4 },
          },
        },
        MatchInitFrame: {
          fields: {
            matchId: { type: 'string', id: 1 },
            map: { type: 'MapLayout', id: 2 },
            pieces: { rule: 'repeated', type: 'Piece', id: 3 },
            maxTurns: { type: 'int32', id: 4 },
            turnTimeLimitMs: { type: 'int32', id: 5 },
            whiteBotName: { type: 'string', id: 6 },
            blackBotName: { type: 'string', id: 7 },
          },
        },
        TurnDeltaFrame: {
          fields: {
            turnNumber: { type: 'int32', id: 1 },
            activePlayer: { type: 'PlayerSide', id: 2 },
            action: { type: 'MoveAction', id: 3 },
            capture: { type: 'CaptureEvent', id: 4 },
            timeConsumedNs: { type: 'int64', id: 5 },
            isGameOver: { type: 'bool', id: 6 },
            winner: { type: 'PlayerSide', id: 7 },
            winReason: { type: 'WinReason', id: 8 },
          },
        },
        MatchEndFrame: {
          fields: {
            matchId: { type: 'string', id: 1 },
            winner: { type: 'PlayerSide', id: 2 },
            reason: { type: 'WinReason', id: 3 },
            totalTurns: { type: 'int32', id: 4 },
            whiteRemainingPieces: { type: 'int32', id: 5 },
            blackRemainingPieces: { type: 'int32', id: 6 },
          },
        },
        WebSocketEnvelope: {
          fields: {
            type: { type: 'MessageType', id: 1 },
            payload: { type: 'bytes', id: 2 },
          },
          nested: {
            MessageType: {
              values: {
                MSG_INIT: 0,
                MSG_DELTA: 1,
                MSG_END: 2,
                MSG_ERROR: 3,
                MSG_PING: 4,
                MSG_PONG: 5,
              },
            },
          },
        },
      },
    },
  },
};

export const protoRoot: protobuf.Root = protobuf.Root.fromJSON(PROTO_ROOT_JSON);

export const MatchInitFrameType: protobuf.Type = protoRoot.lookupType('oantuti.MatchInitFrame');
export const TurnDeltaFrameType: protobuf.Type = protoRoot.lookupType('oantuti.TurnDeltaFrame');
export const MatchEndFrameType: protobuf.Type = protoRoot.lookupType('oantuti.MatchEndFrame');
export const WebSocketEnvelopeType: protobuf.Type = protoRoot.lookupType('oantuti.WebSocketEnvelope');
