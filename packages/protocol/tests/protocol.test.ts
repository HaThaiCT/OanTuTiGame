import { describe, it, expect } from 'vitest';
import {
  encodeValidTilesBitmask,
  decodeValidTilesBitmask,
  isTileValidInBitmask,
  encodeMatchInitFrame,
  decodeMatchInitFrame,
  encodeTurnDeltaFrame,
  decodeTurnDeltaFrame,
  encodeMatchEndFrame,
  decodeMatchEndFrame,
  encodeWebSocketFrame,
  decodeWebSocketFrame,
  packReplay,
  unpackReplay,
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
  PieceType,
  PlayerSide,
  WinReason,
  WebSocketMessageType,
} from '../src/index.js';
import sampleDonut from '../../../docs/specs/maps/sample-donut.map.json';

describe('Protocol & Binary Serialization Suite', () => {
  it('compresses map validTiles into bitmask of exactly ceil(W*H/8) bytes', () => {
    const validTiles = sampleDonut.validTiles as [number, number][];
    const bitmask = encodeValidTilesBitmask(8, 8, validTiles);

    // 8x8 = 64 bits = exactly 8 bytes
    expect(bitmask.length).toBe(8);

    // Check valid tile
    expect(isTileValidInBitmask(8, 8, bitmask, 0, 0)).toBe(true);
    expect(isTileValidInBitmask(8, 8, bitmask, 1, 1)).toBe(true);

    // Check hole tiles
    expect(isTileValidInBitmask(8, 8, bitmask, 3, 3)).toBe(false);
    expect(isTileValidInBitmask(8, 8, bitmask, 4, 3)).toBe(false);
    expect(isTileValidInBitmask(8, 8, bitmask, 3, 4)).toBe(false);
    expect(isTileValidInBitmask(8, 8, bitmask, 4, 4)).toBe(false);

    // Roundtrip decoded coordinates match validTiles count (60 tiles in Donut)
    const decodedTiles = decodeValidTilesBitmask(8, 8, bitmask);
    expect(decodedTiles.length).toBe(validTiles.length);
  });

  it('serializes and deserializes MatchInitFrame with Protobuf', () => {
    const validTiles = sampleDonut.validTiles as [number, number][];
    const bitmask = encodeValidTilesBitmask(8, 8, validTiles);

    const initFrame: MatchInitFrameMessage = {
      matchId: 'match_proto_001',
      map: {
        width: 8,
        height: 8,
        validTilesBitmask: bitmask,
        whiteThrone: { x: 3, y: 0 },
        blackThrone: { x: 4, y: 7 },
        mapName: 'Donut Citadel',
      },
      pieces: [
        { id: 1, owner: PlayerSide.WHITE, type: PieceType.ROCK, pos: { x: 1, y: 1 }, isAlive: true },
        { id: 11, owner: PlayerSide.BLACK, type: PieceType.SCISSORS, pos: { x: 1, y: 6 }, isAlive: true },
      ],
      maxTurns: 300,
      turnTimeLimitMs: 100,
      whiteBotName: 'GreedyBot',
      blackBotName: 'RandomBot',
    };

    const encoded = encodeMatchInitFrame(initFrame);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeMatchInitFrame(encoded);
    expect(decoded.matchId).toBe('match_proto_001');
    expect(decoded.map.mapName).toBe('Donut Citadel');
    expect(decoded.map.width).toBe(8);
    expect(decoded.map.validTilesBitmask.length).toBe(8);
    expect(decoded.pieces.length).toBe(2);
    expect(decoded.pieces[0].id).toBe(1);
    expect(decoded.pieces[0].type).toBe(PieceType.ROCK);
  });

  it('satisfies turn delta bandwidth constraint (<= 200 bytes per turn)', () => {
    const deltaFrame: TurnDeltaFrameMessage = {
      turnNumber: 15,
      activePlayer: PlayerSide.WHITE,
      action: {
        pieceId: 1,
        targetPos: { x: 2, y: 3 },
      },
      capture: {
        attackerId: 1,
        victimId: 11,
        victimType: PieceType.SCISSORS,
        pos: { x: 2, y: 3 },
      },
      timeConsumedNs: 1_500_000n,
      isGameOver: false,
    };

    const encoded = encodeTurnDeltaFrame(deltaFrame);
    // Bandwidth invariant: Turn delta frame must be <= 200 bytes
    expect(encoded.length).toBeLessThanOrEqual(200);
    // In practice: typically ~30-45 bytes
    expect(encoded.length).toBeLessThan(60);

    const decoded = decodeTurnDeltaFrame(encoded);
    expect(decoded.turnNumber).toBe(15);
    expect(decoded.activePlayer).toBe(PlayerSide.WHITE);
    expect(decoded.action?.pieceId).toBe(1);
    expect(decoded.action?.targetPos).toEqual({ x: 2, y: 3 });
    expect(decoded.capture?.victimId).toBe(11);
    expect(decoded.timeConsumedNs).toBe(1_500_000n);
  });

  it('serializes and deserializes MatchEndFrame', () => {
    const endFrame: MatchEndFrameMessage = {
      matchId: 'match_end_001',
      winner: PlayerSide.WHITE,
      reason: WinReason.THRONE_BREACH,
      totalTurns: 25,
      whiteRemainingPieces: 6,
      blackRemainingPieces: 4,
    };

    const encoded = encodeMatchEndFrame(endFrame);
    const decoded = decodeMatchEndFrame(encoded);

    expect(decoded.matchId).toBe('match_end_001');
    expect(decoded.winner).toBe(PlayerSide.WHITE);
    expect(decoded.reason).toBe(WinReason.THRONE_BREACH);
    expect(decoded.totalTurns).toBe(25);
  });

  it('encodes and decodes binary WebSocket framing (5-byte fixed header)', () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const frame = encodeWebSocketFrame(WebSocketMessageType.MSG_DELTA, payload);

    expect(frame.length).toBe(5 + 4);
    expect(frame[0]).toBe(WebSocketMessageType.MSG_DELTA);

    const decoded = decodeWebSocketFrame(frame);
    expect(decoded.type).toBe(WebSocketMessageType.MSG_DELTA);
    expect(Array.from(decoded.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('packs and unpacks .oantuti binary replay files', () => {
    const validTiles = sampleDonut.validTiles as [number, number][];
    const bitmask = encodeValidTilesBitmask(8, 8, validTiles);

    const initFrame: MatchInitFrameMessage = {
      matchId: 'replay_test_001',
      map: {
        width: 8,
        height: 8,
        validTilesBitmask: bitmask,
        whiteThrone: { x: 3, y: 0 },
        blackThrone: { x: 4, y: 7 },
        mapName: 'Donut Citadel',
      },
      pieces: [
        { id: 1, owner: PlayerSide.WHITE, type: PieceType.ROCK, pos: { x: 1, y: 1 }, isAlive: true },
        { id: 11, owner: PlayerSide.BLACK, type: PieceType.SCISSORS, pos: { x: 1, y: 6 }, isAlive: true },
      ],
      maxTurns: 300,
      turnTimeLimitMs: 100,
      whiteBotName: 'GreedyBot',
      blackBotName: 'RandomBot',
    };

    const deltaFrames: TurnDeltaFrameMessage[] = [
      {
        turnNumber: 1,
        activePlayer: PlayerSide.WHITE,
        action: { pieceId: 1, targetPos: { x: 2, y: 2 } },
        timeConsumedNs: 1_000_000n,
        isGameOver: false,
      },
      {
        turnNumber: 2,
        activePlayer: PlayerSide.BLACK,
        action: { pieceId: 11, targetPos: { x: 2, y: 5 } },
        timeConsumedNs: 900_000n,
        isGameOver: false,
      },
    ];

    const endFrame: MatchEndFrameMessage = {
      matchId: 'replay_test_001',
      winner: PlayerSide.WHITE,
      reason: WinReason.THRONE_BREACH,
      totalTurns: 2,
      whiteRemainingPieces: 1,
      blackRemainingPieces: 1,
    };

    const packedReplay = packReplay(initFrame, deltaFrames, endFrame);
    expect(packedReplay.length).toBeGreaterThan(20);

    const unpacked = unpackReplay(packedReplay);
    expect(unpacked.init.matchId).toBe('replay_test_001');
    expect(unpacked.deltas.length).toBe(2);
    expect(unpacked.deltas[0].turnNumber).toBe(1);
    expect(unpacked.deltas[1].turnNumber).toBe(2);
    expect(unpacked.end.winner).toBe(PlayerSide.WHITE);
    expect(unpacked.end.reason).toBe(WinReason.THRONE_BREACH);
  });
});
