use arena_engine::{Coord, MapTopology, MoveAction, Piece, PieceType, PlayerSide};
use arena_runner::{run_match, MatchManifest};

fn main() {
    println!("=======================================================");
    println!("  OanTuTi Arena native match state machine (development) ");
    println!("=======================================================");

    let tiles: Vec<(i32, i32)> = (0..3)
        .flat_map(|x| (0..3).map(move |y| (x, y)))
        .collect();
    let map = MapTopology::try_new("native_arena_3x3", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2))
        .expect("valid demonstration map");
    let manifest = MatchManifest {
        game_id: "development-demo".into(),
        map,
        pieces: vec![
            Piece { id: 1, owner: PlayerSide::White, piece_type: PieceType::Rock, pos: Coord::new(1, 2), is_alive: true },
            Piece { id: 2, owner: PlayerSide::Black, piece_type: PieceType::Paper, pos: Coord::new(1, 0), is_alive: true },
        ],
        max_ply: 50,
    };

    let winning = MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) };
    let evidence = match run_match(&manifest, |_, ply| if ply == 1 { Some(winning) } else { None }) {
        Ok(evidence) => evidence,
        Err(error) => {
            eprintln!("match rejected: {error}");
            std::process::exit(1);
        }
    };

    println!("Game: {}", manifest.game_id);
    println!("Applied plies: {}", evidence.applied_ply);
    println!("Winner: {:?}", evidence.outcome.winner.map(|side| side.to_str()));
    println!("Reason: {:?}", evidence.outcome.reason.map(|reason| reason.to_str()));
    println!("=======================================================");
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena_runner::verify_trace;

    #[test]
    fn demonstration_evidence_verifies_against_its_trace() {
        let tiles: Vec<_> = (0..3).flat_map(|x| (0..3).map(move |y| (x, y))).collect();
        let map = MapTopology::try_new("mini_3x3", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2))
            .expect("valid test map");
        let manifest = MatchManifest {
            game_id: "test".into(),
            map,
            pieces: vec![
                Piece { id: 1, owner: PlayerSide::White, piece_type: PieceType::Rock, pos: Coord::new(1, 2), is_alive: true },
                Piece { id: 2, owner: PlayerSide::Black, piece_type: PieceType::Paper, pos: Coord::new(1, 0), is_alive: true },
            ],
            max_ply: 50,
        };
        let action = MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) };
        let evidence = run_match(&manifest, |_, ply| if ply == 1 { Some(action) } else { None })
            .expect("match runs");
        assert_eq!(verify_trace(&manifest, &evidence.actions, &evidence.outcome), Ok(evidence));
    }
}
