/**
 * OanTuTi Arena — Official TypeScript Bot SDK
 * Zero external runtime dependencies, fast STDIO NDJSON I/O, auto-flushing.
 * Adheres strictly to docs/specs/04-BOT-RUNNER-IPC-SPEC.md.
 */

import * as readline from 'readline';

export type PieceType = 'ROCK' | 'SCISSORS' | 'PAPER';
export type PlayerSide = 'WHITE' | 'BLACK';

export const RPS_BEATS: Record<string, PieceType> = {
  ROCK: 'SCISSORS',
  SCISSORS: 'PAPER',
  PAPER: 'ROCK',
};

export const KING_DIRECTIONS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

export function chebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export function combatDominance(att: PieceType, def: PieceType): number {
  if (att === def) return 0;
  if (RPS_BEATS[att] === def) return 1;
  return -1;
}

export interface Piece {
  readonly id: number;
  readonly owner: PlayerSide;
  readonly type: PieceType;
  readonly x: number;
  readonly y: number;
  readonly is_alive: boolean;
}

export interface GameMap {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly validTiles: ReadonlySet<string>;
  readonly whiteThrone: readonly [number, number];
  readonly blackThrone: readonly [number, number];
  isValidTile(x: number, y: number): boolean;
  getNeighbors(x: number, y: number): Array<[number, number]>;
}

export interface InitContext {
  readonly matchId: string;
  readonly mySide: PlayerSide;
  readonly gameMap: GameMap;
  readonly startingPieces: readonly Piece[];
  readonly turnTimeLimitMs: number;
  readonly maxTurns: number;
  readonly myThrone: readonly [number, number];
  readonly enemyThrone: readonly [number, number];
}

export interface MoveAction {
  readonly action: 'MOVE';
  readonly piece_id: number;
  readonly target: [number, number];
}

export interface PassAction {
  readonly action: 'PASS';
}

export type BotAction = MoveAction | PassAction;

export interface TurnContext {
  readonly turnNumber: number;
  readonly timeRemainingMs: number;
  readonly pieces: readonly Piece[];
  readonly mySide: PlayerSide;
  readonly gameMap: GameMap;
  readonly myPieces: readonly Piece[];
  readonly enemyPieces: readonly Piece[];
  getPieceAt(x: number, y: number): Piece | undefined;
  getLegalMoves(): MoveAction[];
}

export interface BotHandler {
  onInit?(ctx: InitContext): void;
  onTurn(ctx: TurnContext): BotAction;
}

interface RawInitMessage {
  type: 'INIT';
  match_id: string;
  my_side: PlayerSide;
  map: {
    name: string;
    width: number;
    height: number;
    valid_tiles: [number, number][];
    white_throne: [number, number];
    black_throne: [number, number];
  };
  pieces: Piece[];
  turn_time_limit_ms: number;
  max_turns: number;
}

interface RawTurnMessage {
  type: 'TURN';
  turn_number: number;
  time_remaining_ms: number;
  pieces: Piece[];
}

export function runBot(handler: BotHandler): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let mySide: PlayerSide = 'WHITE';
  let gameMap: GameMap | null = null;

  rl.on('line', (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      process.stderr.write(`JSON Parse Error: ${(err as Error).message}\n`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return;
    }

    const msgType = parsed.type;
    if (msgType === 'INIT') {
      const initMsg = parsed as RawInitMessage;
      mySide = initMsg.my_side;

      const tileSet = new Set<string>();
      for (const [x, y] of initMsg.map.valid_tiles) {
        tileSet.add(`${x},${y}`);
      }

      gameMap = {
        name: initMsg.map.name,
        width: initMsg.map.width,
        height: initMsg.map.height,
        validTiles: tileSet,
        whiteThrone: initMsg.map.white_throne,
        blackThrone: initMsg.map.black_throne,
        isValidTile: (x, y) => tileSet.has(`${x},${y}`),
        getNeighbors: (x, y) => {
          const neighbors: Array<[number, number]> = [];
          for (const [dx, dy] of KING_DIRECTIONS) {
            const nx = x + dx;
            const ny = y + dy;
            if (tileSet.has(`${nx},${ny}`)) {
              neighbors.push([nx, ny]);
            }
          }
          return neighbors;
        },
      };

      const myThrone = mySide === 'WHITE' ? gameMap.whiteThrone : gameMap.blackThrone;
      const enemyThrone = mySide === 'WHITE' ? gameMap.blackThrone : gameMap.whiteThrone;

      handler.onInit?.({
        matchId: initMsg.match_id,
        mySide,
        gameMap,
        startingPieces: initMsg.pieces,
        turnTimeLimitMs: initMsg.turn_time_limit_ms,
        maxTurns: initMsg.max_turns,
        myThrone,
        enemyThrone,
      });

      process.stdout.write(JSON.stringify({ status: 'READY' }) + '\n');
    } else if (msgType === 'TURN') {
      if (!gameMap) return;

      const turnMsg = parsed as RawTurnMessage;
      const pieces = turnMsg.pieces;
      const myPieces = pieces.filter((p) => p.owner === mySide && p.is_alive);
      const enemyPieces = pieces.filter((p) => p.owner !== mySide && p.is_alive);

      const grid = new Map<string, Piece>();
      for (const p of pieces) {
        if (p.is_alive) {
          grid.set(`${p.x},${p.y}`, p);
        }
      }

      const turnCtx: TurnContext = {
        turnNumber: turnMsg.turn_number,
        timeRemainingMs: turnMsg.time_remaining_ms,
        pieces,
        mySide,
        gameMap,
        myPieces,
        enemyPieces,
        getPieceAt: (x, y) => grid.get(`${x},${y}`),
        getLegalMoves: () => {
          const legal: MoveAction[] = [];
          for (const piece of myPieces) {
            for (const [nx, ny] of gameMap!.getNeighbors(piece.x, piece.y)) {
              const occupant = grid.get(`${nx},${ny}`);
              if (!occupant) {
                legal.push({ action: 'MOVE', piece_id: piece.id, target: [nx, ny] });
              } else if (occupant.owner !== mySide) {
                if (RPS_BEATS[piece.type] === occupant.type) {
                  legal.push({ action: 'MOVE', piece_id: piece.id, target: [nx, ny] });
                }
              }
            }
          }
          return legal;
        },
      };

      const response = handler.onTurn(turnCtx);
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
}
