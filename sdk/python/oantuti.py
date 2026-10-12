"""
OanTuTi Arena — Official Python 3 Bot SDK
Zero external dependencies, fast STDIO NDJSON I/O, auto-flushing.
Adheres strictly to docs/specs/04-BOT-RUNNER-IPC-SPEC.md.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple
import json
import sys

RPS_BEATS: Dict[str, str] = {
    "ROCK": "SCISSORS",
    "SCISSORS": "PAPER",
    "PAPER": "ROCK",
}

KING_DIRECTIONS: Tuple[Tuple[int, int], ...] = (
    (-1, -1), (0, -1), (1, -1),
    (-1,  0),          (1,  0),
    (-1,  1), (0,  1), (1,  1),
)


def chebyshev_distance(a: Tuple[int, int], b: Tuple[int, int]) -> int:
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def combat_dominance(att: str, def_: str) -> int:
    if att == def_:
        return 0
    if RPS_BEATS.get(att) == def_:
        return 1
    return -1


@dataclass(frozen=True)
class Piece:
    id: int
    owner: str  # 'WHITE' | 'BLACK'
    type: str   # 'ROCK' | 'SCISSORS' | 'PAPER'
    x: int
    y: int
    is_alive: bool

    @property
    def pos(self) -> Tuple[int, int]:
        return (self.x, self.y)


@dataclass
class GameMap:
    name: str
    width: int
    height: int
    valid_tiles: Set[Tuple[int, int]]
    white_throne: Tuple[int, int]
    black_throne: Tuple[int, int]

    def is_valid_tile(self, x: int, y: int) -> bool:
        return (x, y) in self.valid_tiles

    def get_neighbors(self, pos: Tuple[int, int]) -> List[Tuple[int, int]]:
        x, y = pos
        return [(x + dx, y + dy) for dx, dy in KING_DIRECTIONS if (x + dx, y + dy) in self.valid_tiles]


@dataclass
class InitContext:
    match_id: str
    my_side: str  # 'WHITE' | 'BLACK'
    game_map: GameMap
    starting_pieces: List[Piece]
    turn_time_limit_ms: int
    max_turns: int

    @property
    def my_throne(self) -> Tuple[int, int]:
        return self.game_map.white_throne if self.my_side == "WHITE" else self.game_map.black_throne

    @property
    def enemy_throne(self) -> Tuple[int, int]:
        return self.game_map.black_throne if self.my_side == "WHITE" else self.game_map.white_throne


@dataclass
class TurnContext:
    turn_number: int
    time_remaining_ms: int
    pieces: List[Piece]
    my_side: str
    game_map: GameMap

    @property
    def my_pieces(self) -> List[Piece]:
        return [p for p in self.pieces if p.owner == self.my_side and p.is_alive]

    @property
    def enemy_pieces(self) -> List[Piece]:
        return [p for p in self.pieces if p.owner != self.my_side and p.is_alive]

    def get_piece_at(self, x: int, y: int) -> Optional[Piece]:
        for p in self.pieces:
            if p.is_alive and p.x == x and p.y == y:
                return p
        return None

    def get_legal_moves(self) -> List[dict]:
        """
        Calculates all legal moves for my living pieces adhering to:
        - Topology boundary
        - Chebyshev distance == 1
        - No friendly fire
        - No same-type blocking
        - No suicide against dominant enemy
        """
        grid: Dict[Tuple[int, int], Piece] = {p.pos: p for p in self.pieces if p.is_alive}
        moves: List[dict] = []

        for piece in self.my_pieces:
            for nx, ny in self.game_map.get_neighbors(piece.pos):
                target_pos = (nx, ny)
                occupant = grid.get(target_pos)

                if occupant is None:
                    moves.append({"action": "MOVE", "piece_id": piece.id, "target": [nx, ny]})
                elif occupant.owner != self.my_side:
                    # Can only move into enemy if we beat them
                    if RPS_BEATS.get(piece.type) == occupant.type:
                        moves.append({"action": "MOVE", "piece_id": piece.id, "target": [nx, ny]})

        return moves


class Bot:
    """Base class for building OanTuTi Arena bots in Python."""

    def __init__(self) -> None:
        self.my_side: str = "WHITE"
        self.game_map: Optional[GameMap] = None

    def on_init(self, ctx: InitContext) -> None:
        """Called once during the 1,000ms handshake period."""
        pass

    def on_turn(self, ctx: TurnContext) -> dict:
        """
        Called each turn with 100ms time limit.
        Return: {"action": "MOVE", "piece_id": id, "target": [x, y]} or {"action": "PASS"}
        """
        legal = ctx.get_legal_moves()
        if legal:
            return legal[0]
        return {"action": "PASS"}

    def run(self) -> None:
        """Main STDIO NDJSON loop."""
        for line in sys.stdin:
            raw = line.strip()
            if not raw:
                continue

            try:
                msg = json.loads(raw)
            except Exception as e:
                sys.stderr.write(f"JSON Parse Error: {e}\n")
                sys.stderr.flush()
                continue

            msg_type = msg.get("type")

            if msg_type == "INIT":
                self.my_side = msg["my_side"]
                map_data = msg["map"]
                self.game_map = GameMap(
                    name=map_data["name"],
                    width=map_data["width"],
                    height=map_data["height"],
                    valid_tiles={tuple(tile) for tile in map_data["valid_tiles"]},
                    white_throne=tuple(map_data["white_throne"]),
                    black_throne=tuple(map_data["black_throne"]),
                )
                pieces = [
                    Piece(
                        id=p["id"],
                        owner=p["owner"],
                        type=p["type"],
                        x=p["x"],
                        y=p["y"],
                        is_alive=p["is_alive"],
                    )
                    for p in msg.get("pieces", [])
                ]

                ctx = InitContext(
                    match_id=msg.get("match_id", ""),
                    my_side=self.my_side,
                    game_map=self.game_map,
                    starting_pieces=pieces,
                    turn_time_limit_ms=msg.get("turn_time_limit_ms", 100),
                    max_turns=msg.get("max_turns", 300),
                )
                self.on_init(ctx)

                sys.stdout.write(json.dumps({"status": "READY"}) + "\n")
                sys.stdout.flush()

            elif msg_type == "TURN":
                if not self.game_map:
                    continue

                pieces = [
                    Piece(
                        id=p["id"],
                        owner=p["owner"],
                        type=p["type"],
                        x=p["x"],
                        y=p["y"],
                        is_alive=p["is_alive"],
                    )
                    for p in msg.get("pieces", [])
                ]

                ctx = TurnContext(
                    turn_number=msg.get("turn_number", 1),
                    time_remaining_ms=msg.get("time_remaining_ms", 100),
                    pieces=pieces,
                    my_side=self.my_side,
                    game_map=self.game_map,
                )

                response = self.on_turn(ctx)
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
