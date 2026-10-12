/**
 * Match Orchestrator for OanTuTi Arena
 * Coordinates match lifecycle, executes turn loop, and enforces rules and timeouts.
 */

import {
  MapDescriptor,
  createMapTopology,
  createInitialGameState,
  GameState,
  PlayerSide,
  WinReason,
  MoveAction,
  CaptureEvent,
  playerSideToString,
  pieceTypeToString,
  isLegalMove,
  getLegalMoves,
  applyMove,
  getLivingPieces,
} from '@oantuti/engine';
import {
  BotProcess,
  BotInitPayload,
  BotTurnPayload,
  DisqualificationError,
  resolveBotCommand,
} from './ipc-client.js';

export interface BotConfig {
  readonly path: string;
  readonly command?: string;
  readonly args?: string[];
  readonly initTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
}

export interface TurnRecord {
  readonly turnNumber: number;
  readonly player: PlayerSide;
  readonly action: { action: 'MOVE'; pieceId: number; target: [number, number] } | { action: 'PASS' };
  readonly capture?: CaptureEvent;
  readonly durationMs: number;
}

export interface MatchResult {
  readonly matchId: string;
  readonly winner?: PlayerSide;
  readonly winReason: WinReason;
  readonly totalTurns: number;
  readonly whitePiecesRemaining: number;
  readonly blackPiecesRemaining: number;
  readonly turns: readonly TurnRecord[];
  readonly whiteStderr: string;
  readonly blackStderr: string;
}

export interface OrchestratorOptions {
  readonly matchId?: string;
  readonly mapDescriptor: MapDescriptor;
  readonly whiteBotConfig: BotConfig;
  readonly blackBotConfig: BotConfig;
  readonly maxTurns?: number;
  readonly onTurn?: (record: TurnRecord, state: GameState) => void;
}

export class MatchOrchestrator {
  private readonly matchId: string;
  private readonly mapDescriptor: MapDescriptor;
  private readonly whiteConfig: BotConfig;
  private readonly blackConfig: BotConfig;
  private readonly maxTurns: number;
  private readonly onTurn?: (record: TurnRecord, state: GameState) => void;

  constructor(options: OrchestratorOptions) {
    this.matchId = options.matchId ?? `match_${Date.now()}`;
    this.mapDescriptor = options.mapDescriptor;
    this.whiteConfig = options.whiteBotConfig;
    this.blackConfig = options.blackBotConfig;
    this.maxTurns = options.maxTurns ?? 300;
    this.onTurn = options.onTurn;
  }

  private createBotProcess(config: BotConfig): BotProcess {
    if (config.command) {
      return new BotProcess(config.command, config.args ?? []);
    }
    const resolved = resolveBotCommand(config.path);
    return new BotProcess(resolved.command, resolved.args);
  }

  private buildTurnPayload(state: GameState): BotTurnPayload {
    const piecesPayload = Array.from(state.pieces.values()).map((p) => ({
      id: p.id,
      owner: playerSideToString(p.owner),
      type: pieceTypeToString(p.type),
      x: p.pos.x,
      y: p.pos.y,
      is_alive: p.isAlive,
    }));

    return {
      type: 'TURN',
      turn_number: state.turnNumber,
      time_remaining_ms: 100,
      pieces: piecesPayload,
    };
  }

  async runMatch(): Promise<MatchResult> {
    const topology = createMapTopology(this.mapDescriptor);
    let state = createInitialGameState(
      topology,
      this.mapDescriptor.startingPieces,
      this.maxTurns
    );

    const whiteBot = this.createBotProcess(this.whiteConfig);
    const blackBot = this.createBotProcess(this.blackConfig);

    const turns: TurnRecord[] = [];

    const teardown = (
      winner: PlayerSide | undefined,
      winReason: WinReason
    ): MatchResult => {
      whiteBot.kill();
      blackBot.kill();

      const whitePieces = getLivingPieces(state, PlayerSide.WHITE).length;
      const blackPieces = getLivingPieces(state, PlayerSide.BLACK).length;

      return {
        matchId: this.matchId,
        winner,
        winReason,
        totalTurns: turns.length,
        whitePiecesRemaining: whitePieces,
        blackPiecesRemaining: blackPieces,
        turns,
        whiteStderr: whiteBot.getStderr(),
        blackStderr: blackBot.getStderr(),
      };
    };

    // Phase 1: Handshake INIT -> READY
    const commonMapPayload = {
      name: this.mapDescriptor.mapName,
      width: this.mapDescriptor.width,
      height: this.mapDescriptor.height,
      valid_tiles: this.mapDescriptor.validTiles,
      white_throne: this.mapDescriptor.whiteThrone,
      black_throne: this.mapDescriptor.blackThrone,
    };

    const initialPiecesPayload = Array.from(state.pieces.values()).map((p) => ({
      id: p.id,
      owner: playerSideToString(p.owner),
      type: pieceTypeToString(p.type),
      x: p.pos.x,
      y: p.pos.y,
      is_alive: p.isAlive,
    }));

    const whiteInit: BotInitPayload = {
      type: 'INIT',
      match_id: this.matchId,
      my_side: 'WHITE',
      map: commonMapPayload,
      pieces: initialPiecesPayload,
      turn_time_limit_ms: 100,
      max_turns: this.maxTurns,
    };

    const blackInit: BotInitPayload = {
      type: 'INIT',
      match_id: this.matchId,
      my_side: 'BLACK',
      map: commonMapPayload,
      pieces: initialPiecesPayload,
      turn_time_limit_ms: 100,
      max_turns: this.maxTurns,
    };

    try {
      await whiteBot.sendInit(whiteInit, this.whiteConfig.initTimeoutMs ?? 1000);
    } catch (err) {
      const reason =
        err instanceof DisqualificationError ? err.reason : WinReason.CRASH_FORFEIT;
      return teardown(PlayerSide.BLACK, reason);
    }

    try {
      await blackBot.sendInit(blackInit, this.blackConfig.initTimeoutMs ?? 1000);
    } catch (err) {
      const reason =
        err instanceof DisqualificationError ? err.reason : WinReason.CRASH_FORFEIT;
      return teardown(PlayerSide.WHITE, reason);
    }

    // Phase 2: Turn Loop
    while (!state.isGameOver) {
      const activePlayer = state.activePlayer;
      const activeBot = activePlayer === PlayerSide.WHITE ? whiteBot : blackBot;
      const opponentPlayer =
        activePlayer === PlayerSide.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE;
      const turnTimeoutMs =
        activePlayer === PlayerSide.WHITE
          ? (this.whiteConfig.turnTimeoutMs ?? 100)
          : (this.blackConfig.turnTimeoutMs ?? 100);

      const turnPayload = this.buildTurnPayload(state);

      let turnResponse: { action: { action: 'MOVE' | 'PASS'; piece_id?: number; target?: [number, number] }; timeConsumedMs: number };
      try {
        turnResponse = await activeBot.sendTurn(turnPayload, turnTimeoutMs);
      } catch (err) {
        const reason =
          err instanceof DisqualificationError ? err.reason : WinReason.CRASH_FORFEIT;
        return teardown(opponentPlayer, reason);
      }

      const { action, timeConsumedMs } = turnResponse;

      if (action.action === 'PASS') {
        const legalMoves = getLegalMoves(state, activePlayer);
        if (legalMoves.length === 0) {
          // Genuine stalemate: opponent wins
          turns.push({
            turnNumber: state.turnNumber,
            player: activePlayer,
            action: { action: 'PASS' },
            durationMs: timeConsumedMs,
          });
          return teardown(opponentPlayer, WinReason.STALEMATE);
        } else {
          // Illegal pass when legal moves exist: forfeit
          return teardown(opponentPlayer, WinReason.ILLEGAL_MOVE);
        }
      }

      if (action.action === 'MOVE') {
        if (
          action.piece_id === undefined ||
          action.target === undefined ||
          action.target.length !== 2
        ) {
          return teardown(opponentPlayer, WinReason.PROTOCOL_VIOLATION);
        }

        const moveAction: MoveAction = {
          pieceId: action.piece_id,
          targetPos: { x: action.target[0], y: action.target[1] },
        };

        if (!isLegalMove(state, moveAction, activePlayer)) {
          return teardown(opponentPlayer, WinReason.ILLEGAL_MOVE);
        }

        const delta = applyMove(state, moveAction);
        const record: TurnRecord = {
          turnNumber: state.turnNumber,
          player: activePlayer,
          action: {
            action: 'MOVE',
            pieceId: action.piece_id,
            target: [action.target[0], action.target[1]],
          },
          capture: delta.capture,
          durationMs: timeConsumedMs,
        };
        turns.push(record);
        this.onTurn?.(record, delta.nextState);

        state = delta.nextState;

        if (state.isGameOver) {
          return teardown(state.winner, state.winReason ?? WinReason.WIN_REASON_UNSPECIFIED);
        }
      }
    }

    return teardown(state.winner, state.winReason ?? WinReason.WIN_REASON_UNSPECIFIED);
  }
}
