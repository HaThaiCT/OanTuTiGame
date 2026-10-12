/**
 * Starter Bot in C++20 using OanTuTi SDK
 * Strategy:
 * 1. Immediate Throne Breach if adjacent to enemy throne
 * 2. Dominant Capture if enemy in reach
 * 3. Move advancing towards enemy throne
 * 4. Fallback to any legal move
 */

#include "oantuti.hpp"

class StarterBot : public oantuti::Bot {
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
    StarterBot bot;
    bot.run();
    return 0;
}
