#!/usr/bin/env python3
"""
Starter Bot in Python 3 using OanTuTi SDK
Strategy:
1. Immediate Throne Breach if adjacent to enemy throne
2. Dominant Capture if enemy in reach
3. Move advancing towards enemy throne
4. Fallback to any legal move
"""

from oantuti import Bot, InitContext, TurnContext, chebyshev_distance


class HeuristicBot(Bot):
    def __init__(self) -> None:
        super().__init__()
        self.enemy_throne = (0, 0)

    def on_init(self, ctx: InitContext) -> None:
        self.enemy_throne = ctx.enemy_throne

    def on_turn(self, ctx: TurnContext) -> dict:
        legal_moves = ctx.get_legal_moves()
        if not legal_moves:
            return {"action": "PASS"}

        grid = {p.pos: p for p in ctx.pieces if p.is_alive}

        best_move = None
        best_score = -999999

        for move in legal_moves:
            tx, ty = move["target"]
            piece_id = move["piece_id"]
            mover = next(p for p in ctx.my_pieces if p.id == piece_id)

            score = 0

            # 1. Immediate Throne Breach
            if (tx, ty) == self.enemy_throne:
                score += 100000

            # 2. Capture
            occupant = grid.get((tx, ty))
            if occupant and occupant.owner != self.my_side:
                score += 5000

            # 3. Throne Proximity Delta
            curr_dist = chebyshev_distance(mover.pos, self.enemy_throne)
            new_dist = chebyshev_distance((tx, ty), self.enemy_throne)
            dist_delta = curr_dist - new_dist
            score += dist_delta * 100 - new_dist

            if score > best_score:
                best_score = score
                best_move = move

        return best_move if best_move else legal_moves[0]


if __name__ == "__main__":
    HeuristicBot().run()
