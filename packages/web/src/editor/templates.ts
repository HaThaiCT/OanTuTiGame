/**
 * Ready-to-code Bot Templates for Monaco In-Browser IDE
 */

export const PYTHON_BOT_TEMPLATE = `import sys
import json

# =======================================================
# OanTuTi Arena — Python 3 Competitive Bot
# Budget: 1,000ms for INIT | 100ms for TURN
# =======================================================

RPS_BEATS = {
    "ROCK": "SCISSORS",
    "SCISSORS": "PAPER",
    "PAPER": "ROCK"
}

KING_DIRECTIONS = [
    (-1, -1), (0, -1), (1, -1),
    (-1,  0),          (1,  0),
    (-1,  1), (0,  1), (1,  1)
]

def chebyshev_distance(a, b):
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))

class ArenaBot:
    def __init__(self):
        self.my_side = "WHITE"
        self.valid_tiles = set()
        self.enemy_throne = (0, 0)

    def on_init(self, data):
        self.my_side = data["my_side"]
        map_info = data["map"]
        self.valid_tiles = {tuple(t) for t in map_info["valid_tiles"]}
        self.enemy_throne = tuple(
            map_info["black_throne"] if self.my_side == "WHITE" else map_info["white_throne"]
        )
        # Tra ve READY xac nhan hoan tat khoi tao
        return {"status": "READY"}

    def on_turn(self, data):
        pieces = data["pieces"]
        my_pieces = [p for p in pieces if p["owner"] == self.my_side and p["is_alive"]]
        grid = {(p["x"], p["y"]): p for p in pieces if p["is_alive"]}

        legal_moves = []
        for p in my_pieces:
            px, py = p["x"], p["y"]
            for dx, dy in KING_DIRECTIONS:
                tx, ty = px + dx, py + dy
                if (tx, ty) not in self.valid_tiles:
                    continue

                occupant = grid.get((tx, ty))
                if occupant is None:
                    legal_moves.append({"piece_id": p["id"], "target": [tx, ty], "mover": p})
                elif occupant["owner"] != self.my_side:
                    if RPS_BEATS.get(p["type"]) == occupant["type"]:
                        legal_moves.append({"piece_id": p["id"], "target": [tx, ty], "mover": p})

        if not legal_moves:
            return {"action": "PASS"}

        # Heuristic Scorer:
        # 1. Chiem o chot doi phuong (+100000)
        # 2. An quan doi phuong (+5000)
        # 3. Ap sat o chot doi phuong (+delta * 100)
        best_move = legal_moves[0]
        best_score = -999999

        for m in legal_moves:
            tx, ty = m["target"]
            p = m["mover"]
            score = 0

            if (tx, ty) == self.enemy_throne:
                score += 100000

            occupant = grid.get((tx, ty))
            if occupant and occupant["owner"] != self.my_side:
                score += 5000

            cur_dist = chebyshev_distance((p["x"], p["y"]), self.enemy_throne)
            new_dist = chebyshev_distance((tx, ty), self.enemy_throne)
            score += (cur_dist - new_dist) * 100 - new_dist

            if score > best_score:
                best_score = score
                best_move = m

        return {
            "action": "MOVE",
            "piece_id": best_move["piece_id"],
            "target": best_move["target"]
        }

if __name__ == "__main__":
    bot = ArenaBot()
    for raw in sys.stdin:
        line = raw.strip()
        if not line: continue
        msg = json.loads(line)
        if msg.get("type") == "INIT":
            res = bot.on_init(msg)
            sys.stdout.write(json.dumps(res) + "\\n")
            sys.stdout.flush()
        elif msg.get("type") == "TURN":
            res = bot.on_turn(msg)
            sys.stdout.write(json.dumps(res) + "\\n")
            sys.stdout.flush()
`;

export const TYPESCRIPT_BOT_TEMPLATE = `import * as readline from 'readline';

// =======================================================
// OanTuTi Arena — TypeScript Competitive Bot
// Budget: 1,000ms for INIT | 100ms for TURN
// =======================================================

const RPS_BEATS: Record<string, string> = {
  ROCK: 'SCISSORS',
  SCISSORS: 'PAPER',
  PAPER: 'ROCK',
};

const KING_DIRECTIONS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

function chebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

interface PieceData {
  id: number;
  owner: string;
  type: string;
  x: number;
  y: number;
  is_alive: boolean;
}

interface CandidateMove {
  piece_id: number;
  target: [number, number];
  mover: PieceData;
}

let mySide = 'WHITE';
let enemyThrone = [0, 0];
const validTiles = new Set<string>();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  const msg = JSON.parse(text);

  if (msg.type === 'INIT') {
    mySide = msg.my_side;
    validTiles.clear();
    for (const [x, y] of msg.map.valid_tiles) {
      validTiles.add(\`\${x},\${y}\`);
    }
    enemyThrone = mySide === 'WHITE' ? msg.map.black_throne : msg.map.white_throne;
    process.stdout.write(JSON.stringify({ status: 'READY' }) + '\\n');
  } else if (msg.type === 'TURN') {
    const pieces: PieceData[] = msg.pieces;
    const myPieces = pieces.filter((p) => p.owner === mySide && p.is_alive);
    const grid = new Map<string, PieceData>();
    for (const p of pieces) {
      if (p.is_alive) grid.set(\`\${p.x},\${p.y}\`, p);
    }

    const legalMoves: CandidateMove[] = [];
    for (const p of myPieces) {
      for (const [dx, dy] of KING_DIRECTIONS) {
        const tx = p.x + dx;
        const ty = p.y + dy;
        if (!validTiles.has(\`\${tx},\${ty}\`)) continue;

        const occupant = grid.get(\`\${tx},\${ty}\`);
        if (!occupant) {
          legalMoves.push({ piece_id: p.id, target: [tx, ty], mover: p });
        } else if (occupant.owner !== mySide && RPS_BEATS[p.type] === occupant.type) {
          legalMoves.push({ piece_id: p.id, target: [tx, ty], mover: p });
        }
      }
    }
    if (legalMoves.length === 0) {
      process.stdout.write(JSON.stringify({ action: 'PASS' }) + '\\n');
      return;
    }

    let bestMove = legalMoves[0];
    let bestScore = -999999;

    for (const m of legalMoves) {
      const [tx, ty] = m.target;
      const p = m.mover;
      let score = 0;

      if (tx === enemyThrone[0] && ty === enemyThrone[1]) {
        score += 100000;
      }

      const occupant = grid.get(\`\${tx},\${ty}\`);
      if (occupant && occupant.owner !== mySide) {
        score += 5000;
      }

      const curDist = chebyshevDistance(p.x, p.y, enemyThrone[0], enemyThrone[1]);
      const newDist = chebyshevDistance(tx, ty, enemyThrone[0], enemyThrone[1]);
      score += (curDist - newDist) * 100 - newDist;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }

    process.stdout.write(
      JSON.stringify({
        action: 'MOVE',
        piece_id: bestMove.piece_id,
        target: bestMove.target,
      }) + '\\n'
    );
  }
});
`;

export const CPP_BOT_TEMPLATE = `// =======================================================
// OanTuTi Arena — C++20 Competitive Bot
// Budget: 1,000ms for INIT | 100ms for TURN
// =======================================================

#include "oantuti.hpp"

class MyArenaBot : public oantuti::Bot {
private:
    oantuti::Coord enemy_throne_{0, 0};

public:
    void on_init(const oantuti::InitContext& ctx) override {
        enemy_throne_ = ctx.enemy_throne();
    }

    std::optional<oantuti::MoveAction> on_turn(const oantuti::TurnContext& ctx) override {
        auto legal_moves = ctx.get_legal_moves();
        if (legal_moves.empty()) {
            return std::nullopt;
        }

        std::map<std::pair<int, int>, const oantuti::Piece*> grid;
        for (const auto& p : ctx.pieces) {
            if (p.is_alive) grid[{p.x, p.y}] = &p;
        }

        std::optional<oantuti::MoveAction> best_move = legal_moves[0];
        int best_score = -999999;

        for (const auto& move : legal_moves) {
            const auto* mover = [&]() -> const oantuti::Piece* {
                for (const auto& p : ctx.my_pieces()) {
                    if (p.id == move.piece_id) return &p;
                }
                return nullptr;
            }();

            if (!mover) continue;

            int score = 0;

            // 1. Immediate Throne Breach
            if (move.target == enemy_throne_) {
                score += 100000;
            }

            // 2. Capture
            auto it = grid.find({move.target.x, move.target.y});
            if (it != grid.end() && it->second->owner != ctx.my_side) {
                score += 5000;
            }

            // 3. Distance Delta towards enemy throne
            int cur_dist = oantuti::chebyshev_distance(mover->pos(), enemy_throne_);
            int new_dist = oantuti::chebyshev_distance(move.target, enemy_throne_);
            int dist_delta = cur_dist - new_dist;
            score += dist_delta * 100 - new_dist;

            if (score > best_score) {
                best_score = score;
                best_move = move;
            }
        }

        return best_move;
    }
};

int main() {
    MyArenaBot bot;
    bot.run();
    return 0;
}
`;
