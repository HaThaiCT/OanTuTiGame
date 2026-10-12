/**
 * Match Service for OanTuTi Arena
 * Coordinates match execution, live event emission, and replay persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  MapDescriptor,
  PlayerSide,
  WinReason,
  parsePieceType,
  parsePlayerSide,
  playerSideToString,
} from '@oantuti/engine';
import { MatchOrchestrator, TurnRecord, MatchResult } from '@oantuti/runner';
import {
  encodeValidTilesBitmask,
  encodeMatchInitFrame,
  encodeTurnDeltaFrame,
  encodeMatchEndFrame,
  encodeWebSocketFrame,
  packReplay,
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
  WebSocketMessageType,
} from '@oantuti/protocol';
import { Database, MatchRow } from './db.js';

export interface ActiveMatchState {
  readonly matchId: string;
  readonly mapDescriptor: MapDescriptor;
  readonly whiteBotName: string;
  readonly blackBotName: string;
  readonly initFrameBytes: Uint8Array;
  readonly deltaFrameBytes: Uint8Array[];
  endFrameBytes?: Uint8Array;
  replayBinary?: Uint8Array;
  isFinished: boolean;
  result?: MatchResult;
}

export class MatchService extends EventEmitter {
  private readonly db: Database;
  private readonly activeMatches = new Map<string, ActiveMatchState>();
  private readonly mapsDir: string;
  private readonly replaysDir: string;

  constructor(db: Database, mapsDir?: string, replaysDir?: string) {
    super();
    this.db = db;
    this.mapsDir = mapsDir ?? path.resolve(process.cwd(), 'docs/specs/maps');
    this.replaysDir = replaysDir ?? path.resolve(process.cwd(), 'storage/replays');

    if (!fs.existsSync(this.replaysDir)) {
      fs.mkdirSync(this.replaysDir, { recursive: true });
    }
  }

  getAvailableMaps(): { id: string; name: string; width: number; height: number; validTilesCount: number }[] {
    const maps: { id: string; name: string; width: number; height: number; validTilesCount: number }[] = [];
    if (!fs.existsSync(this.mapsDir)) return maps;

    const files = fs.readdirSync(this.mapsDir).filter((f) => f.endsWith('.map.json'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(this.mapsDir, f), 'utf-8');
        const desc = JSON.parse(content) as MapDescriptor;
        const id = f.replace('.map.json', '');
        maps.push({
          id,
          name: desc.mapName,
          width: desc.width,
          height: desc.height,
          validTilesCount: desc.validTiles.length,
        });
      } catch {
        // Skip invalid files
      }
    }
    return maps;
  }

  getMapDescriptor(mapId: string): MapDescriptor {
    const mapFile = mapId.endsWith('.map.json') ? mapId : `${mapId}.map.json`;
    const fullPath = path.join(this.mapsDir, mapFile);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Map "${mapId}" not found at ${fullPath}`);
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    return JSON.parse(content) as MapDescriptor;
  }

  getActiveMatch(matchId: string): ActiveMatchState | undefined {
    return this.activeMatches.get(matchId);
  }

  async startMatch(params: {
    mapId: string;
    whiteBotId: string;
    blackBotId: string;
    maxTurns?: number;
  }): Promise<{ matchId: string; activeState: ActiveMatchState }> {
    const whiteBot = this.db.getBotById(params.whiteBotId);
    const blackBot = this.db.getBotById(params.blackBotId);

    if (!whiteBot) throw new Error(`White bot "${params.whiteBotId}" not found`);
    if (!blackBot) throw new Error(`Black bot "${params.blackBotId}" not found`);

    const whitePath = whiteBot.file_path ?? 'bots/greedy-bot.ts';
    const blackPath = blackBot.file_path ?? 'bots/random-bot.ts';

    const mapDescriptor = this.getMapDescriptor(params.mapId);
    const matchRow = this.db.createMatch({
      mapId: params.mapId,
      whiteBotId: whiteBot.id,
      blackBotId: blackBot.id,
    });

    const matchId = matchRow.id;
    const maxTurns = params.maxTurns ?? 300;

    // Build MatchInitFrame
    const bitmask = encodeValidTilesBitmask(
      mapDescriptor.width,
      mapDescriptor.height,
      mapDescriptor.validTiles
    );

    const initFrameMsg: MatchInitFrameMessage = {
      matchId,
      map: {
        width: mapDescriptor.width,
        height: mapDescriptor.height,
        validTilesBitmask: bitmask,
        whiteThrone: { x: mapDescriptor.whiteThrone[0], y: mapDescriptor.whiteThrone[1] },
        blackThrone: { x: mapDescriptor.blackThrone[0], y: mapDescriptor.blackThrone[1] },
        mapName: mapDescriptor.mapName,
      },
      pieces: mapDescriptor.startingPieces.map((p) => ({
        id: p.id,
        owner: parsePlayerSide(p.owner),
        type: parsePieceType(p.type),
        pos: { x: p.pos[0], y: p.pos[1] },
        isAlive: true,
      })),
      maxTurns,
      turnTimeLimitMs: 100,
      whiteBotName: whiteBot.name,
      blackBotName: blackBot.name,
    };

    const initProtobuf = encodeMatchInitFrame(initFrameMsg);
    const initFrameBytes = encodeWebSocketFrame(WebSocketMessageType.MSG_INIT, initProtobuf);

    const activeState: ActiveMatchState = {
      matchId,
      mapDescriptor,
      whiteBotName: whiteBot.name,
      blackBotName: blackBot.name,
      initFrameBytes,
      deltaFrameBytes: [],
      isFinished: false,
    };

    this.activeMatches.set(matchId, activeState);
    const deltaMsgs: TurnDeltaFrameMessage[] = [];

    // Run asynchronously
    const orchestrator = new MatchOrchestrator({
      matchId,
      mapDescriptor,
      whiteBotConfig: { path: whitePath },
      blackBotConfig: { path: blackPath },
      maxTurns,
      onTurn: (record: TurnRecord) => {
        const deltaMsg: TurnDeltaFrameMessage = {
          turnNumber: record.turnNumber,
          activePlayer: record.player,
          action:
            record.action.action === 'MOVE'
              ? {
                  pieceId: record.action.pieceId,
                  targetPos: { x: record.action.target[0], y: record.action.target[1] },
                }
              : undefined,
          capture: record.capture
            ? {
                attackerId: record.capture.attackerId,
                victimId: record.capture.victimId,
                victimType: record.capture.victimType,
                pos: { x: record.capture.pos.x, y: record.capture.pos.y },
              }
            : undefined,
          timeConsumedNs: BigInt(Math.round(record.durationMs * 1_000_000)),
          isGameOver: false,
        };

        deltaMsgs.push(deltaMsg);

        const deltaProtobuf = encodeTurnDeltaFrame(deltaMsg);
        const wsFrame = encodeWebSocketFrame(WebSocketMessageType.MSG_DELTA, deltaProtobuf);
        activeState.deltaFrameBytes.push(wsFrame);

        this.emit('match:delta', { matchId, frame: wsFrame, delta: deltaMsg });
      },
    });

    // Execute match in background
    (async () => {
      try {
        const result = await orchestrator.runMatch();
        activeState.result = result;
        activeState.isFinished = true;

        const winnerSide =
          result.winner === PlayerSide.WHITE
            ? 'WHITE'
            : result.winner === PlayerSide.BLACK
            ? 'BLACK'
            : 'DRAW';

        const winnerBotId =
          result.winner === PlayerSide.WHITE
            ? whiteBot.id
            : result.winner === PlayerSide.BLACK
            ? blackBot.id
            : undefined;

        const endFrameMsg: MatchEndFrameMessage = {
          matchId,
          winner: result.winner,
          reason: result.winReason,
          totalTurns: result.totalTurns,
          whiteRemainingPieces: result.whitePiecesRemaining,
          blackRemainingPieces: result.blackPiecesRemaining,
        };

        const endProtobuf = encodeMatchEndFrame(endFrameMsg);
        const endFrameBytes = encodeWebSocketFrame(WebSocketMessageType.MSG_END, endProtobuf);
        activeState.endFrameBytes = endFrameBytes;

        // Pack full replay
        const replayBinary = packReplay(initFrameMsg, deltaMsgs, endFrameMsg);
        activeState.replayBinary = replayBinary;

        // Save replay to disk & DB
        const replayFileName = `${matchId}.oantuti`;
        const replayFilePath = path.join(this.replaysDir, replayFileName);
        fs.writeFileSync(replayFilePath, replayBinary);

        const checksum = crypto.createHash('sha256').update(replayBinary).digest('hex');

        this.db.updateMatchResult(matchId, {
          winnerBotId,
          winnerSide,
          winReason: WinReason[result.winReason] ?? String(result.winReason),
          totalTurns: result.totalTurns,
        });

        this.db.saveReplay({
          matchId,
          filePath: replayFilePath,
          fileSizeBytes: replayBinary.length,
          checksumSha256: checksum,
          replayData: replayBinary,
        });

        this.emit('match:end', { matchId, frame: endFrameBytes, result });
      } catch (err) {
        this.emit('match:error', { matchId, error: err });
      }
    })();

    return { matchId, activeState };
  }
}
