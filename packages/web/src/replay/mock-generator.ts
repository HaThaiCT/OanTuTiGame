/**
 * Built-in Sample Match Generator using @oantuti/engine and @oantuti/protocol.
 * Provides a ready-to-play match out of the box.
 */

import {
  MapDescriptor,
  createMapTopology,
  createInitialGameState,
  applyMove,
  getLegalMoves,
  PlayerSide,
  PieceType,
  parsePieceType,
  parsePlayerSide,
} from '@oantuti/engine';
import {
  encodeValidTilesBitmask,
  packReplay,
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
} from '@oantuti/protocol';
import { LoadedReplay, parseReplayBinary } from './player.js';

export function generateDefaultMatch(): LoadedReplay {
  const mapDesc: MapDescriptor = {
    mapName: 'Donut Citadel',
    width: 8,
    height: 8,
    validTiles: [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0],
      [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1],
      [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2],
      [0, 3], [1, 3], [2, 3],                         [5, 3], [6, 3], [7, 3],
      [0, 4], [1, 4], [2, 4],                         [5, 4], [6, 4], [7, 4],
      [0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5],
      [0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6],
      [0, 7], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7],
    ],
    whiteThrone: [3, 0],
    blackThrone: [4, 7],
    startingPieces: [
      { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, 1] },
      { id: 2, owner: 'WHITE', type: 'SCISSORS', pos: [2, 1] },
      { id: 3, owner: 'WHITE', type: 'PAPER', pos: [3, 1] },
      { id: 4, owner: 'WHITE', type: 'ROCK', pos: [4, 1] },
      { id: 5, owner: 'WHITE', type: 'SCISSORS', pos: [5, 1] },
      { id: 6, owner: 'WHITE', type: 'PAPER', pos: [6, 1] },
      { id: 11, owner: 'BLACK', type: 'ROCK', pos: [1, 6] },
      { id: 12, owner: 'BLACK', type: 'SCISSORS', pos: [2, 6] },
      { id: 13, owner: 'BLACK', type: 'PAPER', pos: [3, 6] },
      { id: 14, owner: 'BLACK', type: 'ROCK', pos: [4, 6] },
      { id: 15, owner: 'BLACK', type: 'SCISSORS', pos: [5, 6] },
      { id: 16, owner: 'BLACK', type: 'PAPER', pos: [6, 6] },
    ],
  };

  const topology = createMapTopology(mapDesc);
  let state = createInitialGameState(topology, mapDesc.startingPieces, 300);

  const bitmask = encodeValidTilesBitmask(mapDesc.width, mapDesc.height, mapDesc.validTiles);

  const initFrame: MatchInitFrameMessage = {
    matchId: 'sample_donut_showcase',
    map: {
      width: mapDesc.width,
      height: mapDesc.height,
      validTilesBitmask: bitmask,
      whiteThrone: { x: mapDesc.whiteThrone[0], y: mapDesc.whiteThrone[1] },
      blackThrone: { x: mapDesc.blackThrone[0], y: mapDesc.blackThrone[1] },
      mapName: mapDesc.mapName,
    },
    pieces: mapDesc.startingPieces.map((p) => ({
      id: p.id,
      owner: parsePlayerSide(p.owner),
      type: parsePieceType(p.type),
      pos: { x: p.pos[0], y: p.pos[1] },
      isAlive: true,
    })),
    maxTurns: 300,
    turnTimeLimitMs: 100,
    whiteBotName: 'GreedyBot (White)',
    blackBotName: 'RandomBot (Black)',
  };

  const deltas: TurnDeltaFrameMessage[] = [];

  // Simulate up to 60 turns
  while (!state.isGameOver && state.turnNumber <= 60) {
    const legalMoves = getLegalMoves(state, state.activePlayer);
    if (legalMoves.length === 0) break;

    // Pick best move (favoring captures or proximity to enemy throne)
    const enemyThrone =
      state.activePlayer === PlayerSide.WHITE ? topology.blackThrone : topology.whiteThrone;

    legalMoves.sort((a, b) => {
      const distA = Math.max(Math.abs(a.targetPos.x - enemyThrone.x), Math.abs(a.targetPos.y - enemyThrone.y));
      const distB = Math.max(Math.abs(b.targetPos.x - enemyThrone.x), Math.abs(b.targetPos.y - enemyThrone.y));
      return distA - distB;
    });

    const chosen = legalMoves[0];
    const turnNum = state.turnNumber;
    const player = state.activePlayer;

    const delta = applyMove(state, chosen);

    deltas.push({
      turnNumber: turnNum,
      activePlayer: player,
      action: {
        pieceId: chosen.pieceId,
        targetPos: chosen.targetPos,
      },
      capture: delta.capture
        ? {
            attackerId: delta.capture.attackerId,
            victimId: delta.capture.victimId,
            victimType: delta.capture.victimType,
            pos: delta.capture.pos,
          }
        : undefined,
      timeConsumedNs: 500_000n,
      isGameOver: delta.nextState.isGameOver,
      winner: delta.nextState.winner,
      winReason: delta.nextState.winReason,
    });

    state = delta.nextState;
  }

  const endFrame: MatchEndFrameMessage = {
    matchId: 'sample_donut_showcase',
    winner: state.winner,
    reason: state.winReason ?? 0,
    totalTurns: deltas.length,
    whiteRemainingPieces: Array.from(state.pieces.values()).filter((p) => p.isAlive && p.owner === PlayerSide.WHITE).length,
    blackRemainingPieces: Array.from(state.pieces.values()).filter((p) => p.isAlive && p.owner === PlayerSide.BLACK).length,
  };

  const binary = packReplay(initFrame, deltas, endFrame);
  return parseReplayBinary(binary);
}
