#pragma once
/**
 * OanTuTi Arena — Official C++20 Header-Only Bot SDK
 * Zero external dependencies, fast STDIO NDJSON I/O, auto-flushing.
 * Adheres strictly to docs/specs/04-BOT-RUNNER-IPC-SPEC.md.
 */

#include <iostream>
#include <string>
#include <vector>
#include <set>
#include <map>
#include <sstream>
#include <cmath>
#include <algorithm>
#include <optional>

namespace oantuti {

struct Coord {
    int x;
    int y;

    auto operator<=>(const Coord&) const = default;
};

inline int chebyshev_distance(int x1, int y1, int x2, int y2) {
    return std::max(std::abs(x1 - x2), std::abs(y1 - y2));
}

inline int chebyshev_distance(const Coord& a, const Coord& b) {
    return chebyshev_distance(a.x, a.y, b.x, b.y);
}

inline bool combat_beats(const std::string& att, const std::string& def) {
    return (att == "ROCK" && def == "SCISSORS") ||
           (att == "SCISSORS" && def == "PAPER") ||
           (att == "PAPER" && def == "ROCK");
}

const Coord KING_DIRECTIONS[] = {
    {-1, -1}, {0, -1}, {1, -1},
    {-1,  0},          {1,  0},
    {-1,  1}, {0,  1}, {1,  1}
};

struct Piece {
    int id;
    std::string owner; // "WHITE" | "BLACK"
    std::string type;  // "ROCK" | "SCISSORS" | "PAPER"
    int x;
    int y;
    bool is_alive;

    Coord pos() const { return {x, y}; }
};

struct GameMap {
    std::string name;
    int width;
    int height;
    std::set<std::pair<int, int>> valid_tiles;
    Coord white_throne;
    Coord black_throne;

    bool is_valid_tile(int x, int y) const {
        return valid_tiles.contains({x, y});
    }

    std::vector<Coord> get_neighbors(int x, int y) const {
        std::vector<Coord> neighbors;
        for (const auto& dir : KING_DIRECTIONS) {
            int nx = x + dir.x;
            int ny = y + dir.y;
            if (is_valid_tile(nx, ny)) {
                neighbors.push_back({nx, ny});
            }
        }
        return neighbors;
    }
};

struct MoveAction {
    int piece_id;
    Coord target;
};

struct InitContext {
    std::string match_id;
    std::string my_side;
    GameMap game_map;
    std::vector<Piece> starting_pieces;
    int turn_time_limit_ms;
    int max_turns;

    Coord my_throne() const {
        return my_side == "WHITE" ? game_map.white_throne : game_map.black_throne;
    }

    Coord enemy_throne() const {
        return my_side == "WHITE" ? game_map.black_throne : game_map.white_throne;
    }
};

struct TurnContext {
    int turn_number;
    int time_remaining_ms;
    std::vector<Piece> pieces;
    std::string my_side;
    const GameMap& game_map;

    std::vector<Piece> my_pieces() const {
        std::vector<Piece> result;
        for (const auto& p : pieces) {
            if (p.is_alive && p.owner == my_side) result.push_back(p);
        }
        return result;
    }

    std::vector<Piece> enemy_pieces() const {
        std::vector<Piece> result;
        for (const auto& p : pieces) {
            if (p.is_alive && p.owner != my_side) result.push_back(p);
        }
        return result;
    }

    std::vector<MoveAction> get_legal_moves() const {
        std::map<std::pair<int, int>, const Piece*> grid;
        for (const auto& p : pieces) {
            if (p.is_alive) grid[{p.x, p.y}] = &p;
        }

        std::vector<MoveAction> moves;
        for (const auto& piece : my_pieces()) {
            for (const auto& next_pos : game_map.get_neighbors(piece.x, piece.y)) {
                auto it = grid.find({next_pos.x, next_pos.y});
                if (it == grid.end()) {
                    moves.push_back({piece.id, next_pos});
                } else if (it->second->owner != my_side) {
                    if (combat_beats(piece.type, it->second->type)) {
                        moves.push_back({piece.id, next_pos});
                    }
                }
            }
        }
        return moves;
    }
};

// Fast and lightweight JSON helper for NDJSON lines
namespace json_lite {
    inline std::string extract_string(const std::string& line, const std::string& key) {
        std::string pattern = "\"" + key + "\":";
        size_t pos = line.find(pattern);
        if (pos == std::string::npos) {
            pattern = "\"" + key + "\" :";
            pos = line.find(pattern);
        }
        if (pos == std::string::npos) return "";

        size_t quote_start = line.find('"', pos + pattern.size());
        if (quote_start == std::string::npos) return "";
        size_t quote_end = line.find('"', quote_start + 1);
        if (quote_end == std::string::npos) return "";
        return line.substr(quote_start + 1, quote_end - quote_start - 1);
    }

    inline int extract_int(const std::string& line, const std::string& key, int default_val = 0) {
        std::string pattern = "\"" + key + "\":";
        size_t pos = line.find(pattern);
        if (pos == std::string::npos) {
            pattern = "\"" + key + "\" :";
            pos = line.find(pattern);
        }
        if (pos == std::string::npos) return default_val;

        size_t start = pos + pattern.size();
        while (start < line.size() && (line[start] == ' ' || line[start] == '\t')) start++;
        size_t end = start;
        while (end < line.size() && (isdigit(line[end]) || line[end] == '-')) end++;
        if (start == end) return default_val;
        return std::stoi(line.substr(start, end - start));
    }
}

class Bot {
protected:
    std::string my_side_;
    GameMap game_map_;

public:
    virtual ~Bot() = default;

    virtual void on_init(const InitContext& ctx) {}
    virtual std::optional<MoveAction> on_turn(const TurnContext& ctx) = 0;

    void run() {
        std::ios_base::sync_with_stdio(false);
        std::cin.tie(nullptr);

        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) continue;

            if (line.find("\"INIT\"") != std::string::npos) {
                my_side_ = json_lite::extract_string(line, "my_side");
                game_map_.name = json_lite::extract_string(line, "name");
                game_map_.width = json_lite::extract_int(line, "width", 8);
                game_map_.height = json_lite::extract_int(line, "height", 8);

                // Parse valid_tiles: [[x,y],...]
                size_t vt_pos = line.find("\"valid_tiles\":");
                if (vt_pos != std::string::npos) {
                    size_t start_bracket = line.find('[', vt_pos);
                    size_t end_bracket = line.find("]],", start_bracket);
                    if (end_bracket != std::string::npos) end_bracket += 2;
                    else end_bracket = line.find(']', line.find(']', start_bracket + 1));

                    size_t cur = start_bracket;
                    while ((cur = line.find('[', cur + 1)) != std::string::npos && cur < end_bracket) {
                        size_t comma = line.find(',', cur);
                        size_t close = line.find(']', cur);
                        if (comma != std::string::npos && close != std::string::npos && comma < close) {
                            int x = std::stoi(line.substr(cur + 1, comma - cur - 1));
                            int y = std::stoi(line.substr(comma + 1, close - comma - 1));
                            game_map_.valid_tiles.insert({x, y});
                        }
                    }
                }

                // Parse white_throne & black_throne
                size_t wt_pos = line.find("\"white_throne\":");
                if (wt_pos != std::string::npos) {
                    size_t start = line.find('[', wt_pos);
                    size_t comma = line.find(',', start);
                    size_t close = line.find(']', start);
                    game_map_.white_throne = {
                        std::stoi(line.substr(start + 1, comma - start - 1)),
                        std::stoi(line.substr(comma + 1, close - comma - 1))
                    };
                }

                size_t bt_pos = line.find("\"black_throne\":");
                if (bt_pos != std::string::npos) {
                    size_t start = line.find('[', bt_pos);
                    size_t comma = line.find(',', start);
                    size_t close = line.find(']', start);
                    game_map_.black_throne = {
                        std::stoi(line.substr(start + 1, comma - start - 1)),
                        std::stoi(line.substr(comma + 1, close - comma - 1))
                    };
                }

                InitContext ctx{
                    .match_id = json_lite::extract_string(line, "match_id"),
                    .my_side = my_side_,
                    .game_map = game_map_,
                    .starting_pieces = {},
                    .turn_time_limit_ms = json_lite::extract_int(line, "turn_time_limit_ms", 100),
                    .max_turns = json_lite::extract_int(line, "max_turns", 300)
                };

                on_init(ctx);
                std::cout << "{\"status\":\"READY\"}\n" << std::flush;

            } else if (line.find("\"TURN\"") != std::string::npos) {
                int turn_number = json_lite::extract_int(line, "turn_number", 1);
                int time_remaining = json_lite::extract_int(line, "time_remaining_ms", 100);

                // Parse pieces array
                std::vector<Piece> pieces;
                size_t pieces_pos = line.find("\"pieces\":");
                if (pieces_pos != std::string::npos) {
                    size_t cur = pieces_pos;
                    while ((cur = line.find('{', cur + 1)) != std::string::npos) {
                        size_t end_obj = line.find('}', cur);
                        if (end_obj == std::string::npos) break;
                        std::string piece_str = line.substr(cur, end_obj - cur + 1);

                        Piece p{
                            .id = json_lite::extract_int(piece_str, "id"),
                            .owner = json_lite::extract_string(piece_str, "owner"),
                            .type = json_lite::extract_string(piece_str, "type"),
                            .x = json_lite::extract_int(piece_str, "x"),
                            .y = json_lite::extract_int(piece_str, "y"),
                            .is_alive = piece_str.find("\"is_alive\":true") != std::string::npos ||
                                        piece_str.find("\"is_alive\": true") != std::string::npos
                        };
                        pieces.push_back(p);
                        cur = end_obj;
                    }
                }

                TurnContext ctx{
                    .turn_number = turn_number,
                    .time_remaining_ms = time_remaining,
                    .pieces = pieces,
                    .my_side = my_side_,
                    .game_map = game_map_
                };

                auto action = on_turn(ctx);
                if (action.has_value()) {
                    std::cout << "{\"action\":\"MOVE\",\"piece_id\":" << action->piece_id
                              << ",\"target\":[" << action->target.x << "," << action->target.y << "]}\n"
                              << std::flush;
                } else {
                    std::cout << "{\"action\":\"PASS\"}\n" << std::flush;
                }
            }
        }
    }
};

} // namespace oantuti
