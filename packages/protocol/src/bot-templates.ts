/**
 * Starter code for the three supported Bot languages, shared by the workspace IDE
 * (`packages/web/app/workspace/SourceIde.tsx`) and the runner tests that actually execute these
 * templates as submitted code (`packages/runner/tests/editor-template.test.ts`).
 *
 * One copy only: if a template changes, every consumer changes with it.
 */

/**
 * Khung mã khởi đầu cho từng ngôn ngữ — tối thiểu nhưng chạy được, nói đúng giao thức STDIO
 * NDJSON của runner (`packages/runner/src/ipc-client.ts`):
 *   INIT -> {"status":"READY"}
 *   TURN -> {"action":"MOVE","piece_id":N,"target":[x,y]} hoặc {"action":"PASS"}
 * Python và TypeScript tự viết vòng đọc/ghi vì tệp trong zip không kèm được SDK; C++ dùng
 * header-only `sdk/cpp/oantuti.hpp` mà server luôn thêm vào include path khi biên dịch.
 */
export const PYTHON_BOT_TEMPLATE = `#!/usr/bin/env python3
"""Bot khung cho OanTuTi Arena: \u0111\u1ecdc NDJSON tr\u00ean stdin, ghi n\u01b0\u1edbc \u0111i ra stdout."""

import json
import sys

BEATS = {"ROCK": "SCISSORS", "SCISSORS": "PAPER", "PAPER": "ROCK"}
STEPS = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))

my_side = "WHITE"
valid_tiles = set()


def send(payload):
    print(json.dumps(payload), flush=True)


def pick_move(pieces):
    alive = [p for p in pieces if p["is_alive"]]
    grid = {(p["x"], p["y"]): p for p in alive}
    for piece in alive:
        if piece["owner"] != my_side:
            continue
        for dx, dy in STEPS:
            target = (piece["x"] + dx, piece["y"] + dy)
            if target not in valid_tiles:
                continue
            occupant = grid.get(target)
            if occupant is None or (occupant["owner"] != my_side and BEATS[piece["type"]] == occupant["type"]):
                return {"action": "MOVE", "piece_id": piece["id"], "target": list(target)}
    return {"action": "PASS"}


def main():
    global my_side, valid_tiles
    while True:
        line = sys.stdin.readline()
        if line == "":
            break
        line = line.strip()
        if line == "":
            continue
        message = json.loads(line)
        if message["type"] == "INIT":
            my_side = message["my_side"]
            valid_tiles = {tuple(tile) for tile in message["map"]["valid_tiles"]}
            send({"status": "READY"})
        elif message["type"] == "TURN":
            send(pick_move(message["pieces"]))


if __name__ == "__main__":
    main()
`;

export const TYPESCRIPT_BOT_TEMPLATE = `/**
 * Bot khung cho OanTuTi Arena: doc NDJSON tren stdin, ghi nuoc di ra stdout.
 * Giao thuc: INIT -> {"status":"READY"}; TURN -> {"action":"MOVE",...} hoac {"action":"PASS"}.
 */
import * as readline from 'node:readline';

interface Piece {
  id: number;
  owner: string;
  type: string;
  x: number;
  y: number;
  is_alive: boolean;
}

interface InitMessage {
  type: string;
  my_side?: string;
  map?: { valid_tiles?: number[][] };
}

const BEATS: Record<string, string> = { ROCK: 'SCISSORS', SCISSORS: 'PAPER', PAPER: 'ROCK' };
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

let mySide = 'WHITE';
let validTiles = new Set<string>();

function key(x: number, y: number): string {
  return x + ',' + y;
}

function send(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function pickMove(pieces: Piece[]): unknown {
  const alive = pieces.filter((piece) => piece.is_alive);
  const grid = new Map<string, Piece>();
  for (const piece of alive) grid.set(key(piece.x, piece.y), piece);
  for (const piece of alive) {
    if (piece.owner !== mySide) continue;
    for (const [dx, dy] of STEPS) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!validTiles.has(key(x, y))) continue;
      const occupant = grid.get(key(x, y));
      if (occupant === undefined || (occupant.owner !== mySide && BEATS[piece.type] === occupant.type)) {
        return { action: 'MOVE', piece_id: piece.id, target: [x, y] };
      }
    }
  }
  return { action: 'PASS' };
}

const input = readline.createInterface({ input: process.stdin });

input.on('line', (line: string) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  const message = JSON.parse(trimmed) as InitMessage & { pieces?: Piece[] };
  if (message.type === 'INIT') {
    mySide = message.my_side ?? 'WHITE';
    validTiles = new Set<string>((message.map?.valid_tiles ?? []).map((tile) => key(tile[0], tile[1])));
    send({ status: 'READY' });
  } else if (message.type === 'TURN') {
    send(pickMove(message.pieces ?? []));
  }
});
`;

export const CPP_BOT_TEMPLATE = `// Bot khung cho OanTuTi Arena (C++20). SDK header-only lo phan doc/ghi NDJSON:
// server luon bien dich kem "-I sdk/cpp" (packages/server/src/builds/build-pipeline.ts,
// tournaments/execution-service.ts) nen chi can include "oantuti.hpp".
#include "oantuti.hpp"

#include <optional>
#include <vector>

class StarterBot : public oantuti::Bot {
public:
    std::optional<oantuti::MoveAction> on_turn(const oantuti::TurnContext& ctx) override {
        const std::vector<oantuti::MoveAction> moves = ctx.get_legal_moves();
        if (moves.empty()) return std::nullopt;
        return moves.front();
    }
};

int main() {
    StarterBot().run();
    return 0;
}
`;

/** Starter code by `ScriptLanguage`-style key (`PYTHON`/`TYPESCRIPT`/`CPP`). */
export const BOT_TEMPLATES: Record<string, string> = {
  PYTHON: PYTHON_BOT_TEMPLATE,
  TYPESCRIPT: TYPESCRIPT_BOT_TEMPLATE,
  CPP: CPP_BOT_TEMPLATE,
};
