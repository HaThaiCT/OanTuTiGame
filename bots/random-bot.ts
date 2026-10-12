/**
 * Random AI Bot for OanTuTi Arena
 * Adheres strictly to docs/specs/04-BOT-RUNNER-IPC-SPEC.md STDIO NDJSON.
 */

import * as readline from 'readline';

interface PieceData {
  id: number;
  owner: 'WHITE' | 'BLACK';
  type: 'ROCK' | 'SCISSORS' | 'PAPER';
  x: number;
  y: number;
  is_alive: boolean;
}

interface InitMessage {
  type: 'INIT';
  match_id: string;
  my_side: 'WHITE' | 'BLACK';
  map: {
    name: string;
    width: number;
    height: number;
    valid_tiles: [number, number][];
    white_throne: [number, number];
    black_throne: [number, number];
  };
  pieces: PieceData[];
  turn_time_limit_ms: number;
  max_turns: number;
}

interface TurnMessage {
  type: 'TURN';
  turn_number: number;
  time_remaining_ms: number;
  pieces: PieceData[];
}

const KING_DIRECTIONS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

const RPS_BEATS: Record<string, 'ROCK' | 'SCISSORS' | 'PAPER'> = {
  ROCK: 'SCISSORS',
  SCISSORS: 'PAPER',
  PAPER: 'ROCK',
};

let mySide: 'WHITE' | 'BLACK' = 'WHITE';
const validTiles = new Set<string>();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (rawLine: string) => {
  const line = rawLine.trim();
  if (!line) return;

  let msg: InitMessage | TurnMessage;
  try {
    msg = JSON.parse(line) as InitMessage | TurnMessage;
  } catch {
    return;
  }

  if (msg.type === 'INIT') {
    mySide = msg.my_side;
    validTiles.clear();
    for (const [x, y] of msg.map.valid_tiles) {
      validTiles.add(`${x},${y}`);
    }
    process.stdout.write(JSON.stringify({ status: 'READY' }) + '\n');
  } else if (msg.type === 'TURN') {
    const pieces = msg.pieces;
    const myLivingPieces = pieces.filter((p) => p.owner === mySide && p.is_alive);
    const grid = new Map<string, PieceData>();

    for (const p of pieces) {
      if (p.is_alive) {
        grid.set(`${p.x},${p.y}`, p);
      }
    }

    interface CandidateMove {
      pieceId: number;
      target: [number, number];
    }

    const legalMoves: CandidateMove[] = [];

    for (const p of myLivingPieces) {
      for (const [dx, dy] of KING_DIRECTIONS) {
        const tx = p.x + dx;
        const ty = p.y + dy;
        const targetKey = `${tx},${ty}`;

        if (!validTiles.has(targetKey)) continue;

        const occupant = grid.get(targetKey);
        if (!occupant) {
          // Empty tile: legal move
          legalMoves.push({ pieceId: p.id, target: [tx, ty] });
        } else if (occupant.owner !== mySide) {
          // Enemy piece: must dominate (attacker beats defender)
          if (RPS_BEATS[p.type] === occupant.type) {
            legalMoves.push({ pieceId: p.id, target: [tx, ty] });
          }
        }
      }
    }

    if (legalMoves.length === 0) {
      process.stdout.write(JSON.stringify({ action: 'PASS' }) + '\n');
    } else {
      const selectedIndex = Math.floor(Math.random() * legalMoves.length);
      const chosen = legalMoves[selectedIndex];
      process.stdout.write(
        JSON.stringify({
          action: 'MOVE',
          piece_id: chosen.pieceId,
          target: chosen.target,
        }) + '\n'
      );
    }
  }
});
