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
  validateMapTopology,
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
import { Database } from './db.js';

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
  error?: Error;
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

  registerActiveMatch(state: ActiveMatchState): void {
    this.activeMatches.set(state.matchId, state);
  }
  async startMatch(params: {
    mapId: string;
    whiteBotId: string;
    blackBotId: string;
    maxTurns?: number;
    tournamentId?: string;
  }): Promise<{ matchId: string; activeState: ActiveMatchState }> {
    const whiteBot = this.db.getBotById(params.whiteBotId);
    const blackBot = this.db.getBotById(params.blackBotId);
    if (!whiteBot?.is_active || !whiteBot.file_path) throw new Error('White bot is unavailable');
    if (!blackBot?.is_active || !blackBot.file_path) throw new Error('Black bot is unavailable');
    const mapDescriptor = this.getMapDescriptor(params.mapId);
    const validation = validateMapTopology(mapDescriptor);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    const matchRow = this.db.createMatch({
      tournamentId: params.tournamentId,
      mapId: params.mapId,
      whiteBotId: whiteBot.id,
      blackBotId: blackBot.id,
    });
    return this.launchMatch({
      matchId: matchRow.id,
      mapDescriptor,
      maxTurns: params.maxTurns ?? 300,
      whiteName: whiteBot.name,
      blackName: blackBot.name,
      whitePath: whiteBot.file_path,
      blackPath: blackBot.file_path,
      persistResult: (result, replayBinary) => {
        const winnerSide = result.winner === PlayerSide.WHITE ? 'WHITE' : result.winner === PlayerSide.BLACK ? 'BLACK' : 'DRAW';
        const winnerBotId = result.winner === PlayerSide.WHITE ? whiteBot.id : result.winner === PlayerSide.BLACK ? blackBot.id : undefined;
        const replayFilePath = path.join(this.replaysDir, result.matchId + '.oantuti');
        fs.writeFileSync(replayFilePath, replayBinary);
        this.db.updateMatchResult(result.matchId, { winnerBotId, winnerSide, winReason: WinReason[result.winReason], totalTurns: result.totalTurns });
        this.db.saveReplay({ matchId: result.matchId, filePath: replayFilePath, fileSizeBytes: replayBinary.length, checksumSha256: crypto.createHash('sha256').update(replayBinary).digest('hex'), replayData: replayBinary });
      },
    });
  }

  async startTestMatch(params: {
    mapId: string;
    opponentBotId: string;
    language: 'PYTHON' | 'TYPESCRIPT' | 'CPP';
    sourceCode: string;
    maxTurns?: number;
  }): Promise<{ matchId: string; activeState: ActiveMatchState }> {
    const opponent = this.db.getBotById(params.opponentBotId);
    if (!opponent?.is_active || !opponent.file_path) throw new Error('Opponent bot is unavailable');
    if (!params.sourceCode.trim()) throw new Error('Source code is required');
    const mapDescriptor = this.getMapDescriptor(params.mapId);
    const validation = validateMapTopology(mapDescriptor);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    const directory = fs.mkdtempSync(path.join(this.replaysDir, '.draft-'));
    try {
      const fileName = params.language === 'PYTHON' ? 'bot.py' : params.language === 'CPP' ? 'bot.cpp' : 'bot.ts';
      const sourcePath = path.join(directory, fileName);
      fs.writeFileSync(sourcePath, params.sourceCode, {flag:'wx'});
      return this.launchMatch({
        matchId: 'test_' + crypto.randomUUID(),
        mapDescriptor,
        maxTurns: params.maxTurns ?? 300,
        whiteName: 'Editor draft (unranked)',
        blackName: opponent.name,
        whitePath: sourcePath,
        blackPath: opponent.file_path,
        cleanup: () => fs.rmSync(directory, {recursive:true,force:true}),
      });
    } catch (error) {
      fs.rmSync(directory, {recursive:true,force:true});
      throw error;
    }
  }

  private launchMatch(options: {
    matchId: string;
    mapDescriptor: MapDescriptor;
    maxTurns: number;
    whiteName: string;
    blackName: string;
    whitePath: string;
    blackPath: string;
    persistResult?: (result: MatchResult, replay: Uint8Array) => void;
    cleanup?: () => void;
  }): { matchId: string; activeState: ActiveMatchState } {
    const {matchId,mapDescriptor,maxTurns,whiteName,blackName,whitePath,blackPath} = options;
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
      whiteBotName: whiteName,
      blackBotName: blackName,
    };

    const initProtobuf = encodeMatchInitFrame(initFrameMsg);
    const initFrameBytes = encodeWebSocketFrame(WebSocketMessageType.MSG_INIT, initProtobuf);

    const activeState: ActiveMatchState = {
      matchId,
      mapDescriptor,
      whiteBotName: whiteName,
      blackBotName: blackName,
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
      onTurn: (record: TurnRecord, nextState) => {
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
          isGameOver: nextState.isGameOver,
          winner: nextState.winner,
          winReason: nextState.winReason,
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

        options.persistResult?.(result, replayBinary);

        this.emit('match:end', { matchId, frame: endFrameBytes, result });
      } catch (error) {
        activeState.error = error instanceof Error ? error : new Error(String(error));
        activeState.isFinished = true;
        this.emit('match:error', { matchId, error: activeState.error });
      } finally {
        options.cleanup?.();
      }
    })();

    return { matchId, activeState };
  }

  waitForMatch(matchId: string): Promise<MatchResult> {
    const active = this.activeMatches.get(matchId);
    if (!active) return Promise.reject(new Error(`Active match ${matchId} not found`));
    if (active.error) return Promise.reject(active.error);

    if (active.isFinished && active.result) {
      return Promise.resolve(active.result);
    }

    return new Promise<MatchResult>((resolve, reject) => {
      const onEnd = (event: { matchId: string; result: MatchResult }) => {
        if (event.matchId === matchId) {
          this.off('match:end', onEnd);
          this.off('match:error', onError);
          resolve(event.result);
        }
      };
      const onError = (event: { matchId: string; error: unknown }) => {
        if (event.matchId === matchId) {
          this.off('match:end', onEnd);
          this.off('match:error', onError);
          reject(event.error);
        }
      };
      this.on('match:end', onEnd);
      this.on('match:error', onError);
    });
  }
}
