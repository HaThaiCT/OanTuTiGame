use std::time::Instant;
use arena_engine::{
    apply_move_v2, evaluate_victory_v2, Coord, GameState, MapTopology, MoveAction, Piece,
    PieceType, PlayerSide,
};

fn main() {
    println!("=======================================================");
    println!("     OanTuTi Arena Native Rust Match Runner (v2)       ");
    println!("=======================================================");

    let start = Instant::now();

    // 1. Initialize Map
    let tiles: Vec<(i32, i32)> = (0..5)
        .flat_map(|x| (0..5).map(move |y| (x, y)))
        .collect();
    let map = MapTopology::new("native_arena_5x5", 5, 5, &tiles, Coord::new(0, 0), Coord::new(4, 4));

    // 2. Initialize Pieces (Standard 5x5 R/S/P setup)
    let pieces = vec![
        // White pieces
        Piece { id: 1, owner: PlayerSide::White, piece_type: PieceType::Rock, pos: Coord::new(0, 1), is_alive: true },
        Piece { id: 2, owner: PlayerSide::White, piece_type: PieceType::Scissors, pos: Coord::new(0, 2), is_alive: true },
        Piece { id: 3, owner: PlayerSide::White, piece_type: PieceType::Paper, pos: Coord::new(0, 3), is_alive: true },
        // Black pieces
        Piece { id: 4, owner: PlayerSide::Black, piece_type: PieceType::Rock, pos: Coord::new(4, 1), is_alive: true },
        Piece { id: 5, owner: PlayerSide::Black, piece_type: PieceType::Scissors, pos: Coord::new(4, 2), is_alive: true },
        Piece { id: 6, owner: PlayerSide::Black, piece_type: PieceType::Paper, pos: Coord::new(4, 3), is_alive: true },
    ];

    let mut state = GameState::new(map, pieces, 100);
    println!("Initial state ready. Max turns: {}", state.max_turns);

    // 3. Run moves sequentially
    let moves = [
        MoveAction { piece_id: 1, target_pos: Coord::new(1, 1) }, // White Rock advances
        MoveAction { piece_id: 5, target_pos: Coord::new(3, 2) }, // Black Scissors advances
        MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) }, // White Rock advances
        MoveAction { piece_id: 5, target_pos: Coord::new(2, 2) }, // Black Scissors attacks White Rock -> Cyclic block/illegal!
    ];

    let mut move_count = 0;
    for action in &moves[0..3] {
        match apply_move_v2(&mut state, action) {
            Ok(outcome) => {
                move_count += 1;
                println!(
                    "Turn {}: Piece {} moved to ({}, {}) - Capture: {:?}",
                    state.turn_number - 1,
                    action.piece_id,
                    action.target_pos.x,
                    action.target_pos.y,
                    outcome.capture.map(|c| c.victim_id)
                );
            }
            Err(e) => {
                println!("Illegal move rejected by Rust engine: {}", e);
            }
        }
    }

    let victory = evaluate_victory_v2(&state);
    let duration = start.elapsed();

    println!("Simulation finished in {:?}. Total moves: {}", duration, move_count);
    println!("Game status: in_progress={}, winner={:?}", !victory.is_game_over, victory.winner.map(|w| w.to_str()));
    println!("=======================================================");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_native_runner_execution() {
        let tiles = vec![(0, 0), (0, 1), (1, 0), (1, 1)];
        let map = MapTopology::new("mini_2x2", 2, 2, &tiles, Coord::new(0, 0), Coord::new(1, 1));
        let pieces = vec![
            Piece { id: 1, owner: PlayerSide::White, piece_type: PieceType::Rock, pos: Coord::new(0, 1), is_alive: true },
            Piece { id: 2, owner: PlayerSide::Black, piece_type: PieceType::Scissors, pos: Coord::new(1, 0), is_alive: true },
        ];
        let mut state = GameState::new(map, pieces, 50);

        // White moves to (1, 1) - Black throne!
        let action = MoveAction { piece_id: 1, target_pos: Coord::new(1, 1) };
        let outcome = apply_move_v2(&mut state, &action).expect("legal move");
        assert!(outcome.victory.is_game_over);
    }
}
