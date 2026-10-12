/**
 * TypeScript Data Contracts for OanTuTi Network Protocol
 * Matches schema defined in docs/specs/proto/oantuti.proto.
 */

import { PieceType, PlayerSide, WinReason } from '@oantuti/engine';

export { PieceType, PlayerSide, WinReason };

export enum WebSocketMessageType {
  MSG_INIT = 0x01,
  MSG_DELTA = 0x02,
  MSG_END = 0x03,
  MSG_ERROR = 0x04,
  MSG_PING = 0x09,
  MSG_PONG = 0x0a,
}

export interface CoordMessage {
  readonly x: number;
  readonly y: number;
}

export interface MapLayoutMessage {
  readonly width: number;
  readonly height: number;
  readonly validTilesBitmask: Uint8Array;
  readonly whiteThrone: CoordMessage;
  readonly blackThrone: CoordMessage;
  readonly mapName: string;
}

export interface PieceMessage {
  readonly id: number;
  readonly owner: PlayerSide;
  readonly type: PieceType;
  readonly pos: CoordMessage;
  readonly isAlive: boolean;
}

export interface MoveActionMessage {
  readonly pieceId: number;
  readonly targetPos: CoordMessage;
}

export interface CaptureEventMessage {
  readonly attackerId: number;
  readonly victimId: number;
  readonly victimType: PieceType;
  readonly pos: CoordMessage;
}

export interface MatchInitFrameMessage {
  readonly matchId: string;
  readonly map: MapLayoutMessage;
  readonly pieces: readonly PieceMessage[];
  readonly maxTurns: number;
  readonly turnTimeLimitMs: number;
  readonly whiteBotName: string;
  readonly blackBotName: string;
}

export interface TurnDeltaFrameMessage {
  readonly turnNumber: number;
  readonly activePlayer: PlayerSide;
  readonly action?: MoveActionMessage;
  readonly capture?: CaptureEventMessage;
  readonly timeConsumedNs: bigint | number;
  readonly isGameOver: boolean;
  readonly winner?: PlayerSide;
  readonly winReason?: WinReason;
}

export interface MatchEndFrameMessage {
  readonly matchId: string;
  readonly winner?: PlayerSide;
  readonly reason: WinReason;
  readonly totalTurns: number;
  readonly whiteRemainingPieces: number;
  readonly blackRemainingPieces: number;
}
