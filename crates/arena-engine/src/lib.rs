pub mod map;
pub mod rules;
pub mod state;
pub mod types;

pub use map::MapTopology;
pub use rules::{apply_move_v2, evaluate_victory_v2, get_legal_moves, is_legal_move};
pub use state::GameState;
pub use types::{
    CaptureEvent, Coord, Disposition, MoveAction, MoveOutcome, Piece, PieceType, PlayerSide,
    VictoryOutcome, VictoryReason,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_map() -> MapTopology {
        let tiles: Vec<(i32, i32)> = (0..3)
            .flat_map(|x| (0..3).map(move |y| (x, y)))
            .collect();
        MapTopology::new("test_3x3", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2))
    }

    #[test]
    fn test_cyclic_capture_rules() {
        assert!(PieceType::Rock.beats(PieceType::Scissors));
        assert!(PieceType::Scissors.beats(PieceType::Paper));
        assert!(PieceType::Paper.beats(PieceType::Rock));

        // False on identical or losing
        assert!(!PieceType::Rock.beats(PieceType::Rock));
        assert!(!PieceType::Rock.beats(PieceType::Paper));
    }

    #[test]
    fn test_throne_breach_victory() {
        let map = create_test_map();
        let pieces = vec![
            Piece {
                id: 1,
                owner: PlayerSide::White,
                piece_type: PieceType::Rock,
                pos: Coord::new(1, 2),
                is_alive: true,
            },
            Piece {
                id: 2,
                owner: PlayerSide::Black,
                piece_type: PieceType::Rock,
                pos: Coord::new(0, 2),
                is_alive: true,
            },
        ];

        let mut state = GameState::new(map, pieces, 100);

        // White moves [1, 2] -> [2, 2] (Black throne!)
        let action = MoveAction {
            piece_id: 1,
            target_pos: Coord::new(2, 2),
        };

        let outcome = apply_move_v2(&mut state, &action).expect("legal move");
        assert!(outcome.victory.is_game_over);
        assert_eq!(outcome.victory.winner, Some(PlayerSide::White));
        assert_eq!(outcome.victory.reason, Some(VictoryReason::ThroneBreach));
    }

    #[test]
    fn test_extinction_victory() {
        let map = create_test_map();
        let pieces = vec![
            Piece {
                id: 1,
                owner: PlayerSide::White,
                piece_type: PieceType::Rock,
                pos: Coord::new(0, 1),
                is_alive: true,
            },
            Piece {
                id: 2,
                owner: PlayerSide::Black,
                piece_type: PieceType::Scissors, // Rock beats Scissors!
                pos: Coord::new(1, 1),
                is_alive: true,
            },
        ];

        let mut state = GameState::new(map, pieces, 100);

        // White Rock captures Black Scissors at [1, 1]
        let action = MoveAction {
            piece_id: 1,
            target_pos: Coord::new(1, 1),
        };

        let outcome = apply_move_v2(&mut state, &action).expect("legal move");
        assert!(outcome.capture.is_some());
        assert_eq!(outcome.capture.unwrap().victim_id, 2);

        // Black lost their only Scissors -> EXTINCTION!
        assert!(outcome.victory.is_game_over);
        assert_eq!(outcome.victory.winner, Some(PlayerSide::White));
        assert_eq!(outcome.victory.reason, Some(VictoryReason::Extinction));
    }

    #[test]
    fn test_illegal_move_rejection() {
        let map = create_test_map();
        let pieces = vec![
            Piece {
                id: 1,
                owner: PlayerSide::White,
                piece_type: PieceType::Rock,
                pos: Coord::new(0, 0),
                is_alive: true,
            },
            Piece {
                id: 2,
                owner: PlayerSide::Black,
                piece_type: PieceType::Paper, // Paper beats Rock, so Rock cannot capture Paper!
                pos: Coord::new(1, 0),
                is_alive: true,
            },
        ];

        let mut state = GameState::new(map, pieces, 100);

        // Rock attempts to capture Paper -> illegal!
        let action = MoveAction {
            piece_id: 1,
            target_pos: Coord::new(1, 0),
        };

        assert!(!is_legal_move(&state, &action));
        assert!(apply_move_v2(&mut state, &action).is_err());
    }
}
