use arena_engine::{
    apply_move_v2, Coord, Disposition, GameState, MapTopology, MoveAction, Piece, PieceType,
    PlayerSide, VictoryReason,
};

fn tiles_4x4() -> Vec<(i32, i32)> {
    (0..4).flat_map(|x| (0..4).map(move |y| (x, y))).collect()
}

fn state_4x4(pieces: Vec<Piece>) -> GameState {
    let map = MapTopology::try_new("contract", 4, 4, &tiles_4x4(), Coord::new(0, 0), Coord::new(3, 3))
        .expect("valid map");
    GameState::try_new(map, pieces, 300).expect("valid state")
}

fn piece(id: u32, owner: PlayerSide, kind: PieceType, x: i32, y: i32) -> Piece {
    Piece { id, owner, piece_type: kind, pos: Coord::new(x, y), is_alive: true }
}

#[test]
fn proximity_uses_canonical_integer_reciprocal_not_linear_distance() {
    let state = state_4x4(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 2, 2),
        piece(2, PlayerSide::White, PieceType::Paper, 0, 1),
        piece(3, PlayerSide::Black, PieceType::Rock, 3, 2),
    ]);
    assert_eq!(state.calculate_proximity_score(PlayerSide::White), 12600 + 6300);
    assert_eq!(state.calculate_proximity_score(PlayerSide::Black), 6300);
}

#[test]
fn map_constructor_rejects_duplicate_out_of_bounds_and_invalid_thrones() {
    let duplicate = [(0, 0), (0, 0), (3, 3)];
    assert!(MapTopology::try_new("duplicate", 4, 4, &duplicate, Coord::new(0, 0), Coord::new(3, 3)).is_err());
    let outside = [(0, 0), (4, 3), (3, 3)];
    assert!(MapTopology::try_new("outside", 4, 4, &outside, Coord::new(0, 0), Coord::new(3, 3)).is_err());
    let tiles = tiles_4x4();
    assert!(MapTopology::try_new("bad-throne", 4, 4, &tiles, Coord::new(0, 0), Coord::new(0, 0)).is_err());
    assert!(MapTopology::try_new("tiny", 2, 2, &[(0, 0), (1, 1)], Coord::new(0, 0), Coord::new(1, 1)).is_err());
}

#[test]
fn game_constructor_rejects_piece_overlap_ids_and_invalid_positions() {
    let overlap = vec![
        piece(1, PlayerSide::White, PieceType::Rock, 1, 1),
        piece(2, PlayerSide::Black, PieceType::Paper, 1, 1),
    ];
    let map = MapTopology::try_new("overlap", 4, 4, &tiles_4x4(), Coord::new(0, 0), Coord::new(3, 3)).unwrap();
    assert!(GameState::try_new(map, overlap, 300).is_err());

    let duplicate_ids = vec![
        piece(1, PlayerSide::White, PieceType::Rock, 1, 1),
        piece(1, PlayerSide::Black, PieceType::Paper, 2, 2),
    ];
    let map = MapTopology::try_new("ids", 4, 4, &tiles_4x4(), Coord::new(0, 0), Coord::new(3, 3)).unwrap();
    assert!(GameState::try_new(map, duplicate_ids, 300).is_err());

    let off_map = vec![piece(1, PlayerSide::White, PieceType::Rock, 9, 9)];
    let map = MapTopology::try_new("offmap", 4, 4, &tiles_4x4(), Coord::new(0, 0), Coord::new(3, 3)).unwrap();
    assert!(GameState::try_new(map, off_map, 300).is_err());
}

#[test]
fn initial_terminal_state_is_evaluated_before_any_turn() {
    let state = state_4x4(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 3, 3),
        piece(2, PlayerSide::Black, PieceType::Paper, 0, 0),
    ]);
    let outcome = state.outcome();
    assert!(outcome.is_game_over);
    assert_eq!(outcome.disposition, Some(Disposition::NoContest));
    assert_eq!(outcome.reason, Some(VictoryReason::InvalidStartBothSides));
}

#[test]
fn terminal_state_rejects_further_moves_without_mutation() {
    let mut state = state_4x4(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 3, 2),
        piece(2, PlayerSide::Black, PieceType::Scissors, 2, 2),
    ]);
    let winning = MoveAction { piece_id: 1, target_pos: Coord::new(3, 3) };
    let outcome = apply_move_v2(&mut state, &winning).expect("winning move");
    assert!(outcome.victory.is_game_over);
    let before = state.clone();
    let extra = MoveAction { piece_id: 2, target_pos: Coord::new(3, 2) };
    assert!(apply_move_v2(&mut state, &extra).is_err());
    assert_eq!(state.turn_number, before.turn_number);
    assert_eq!(state.active_player, before.active_player);
    assert_eq!(state.pieces, before.pieces);
}

#[test]
fn illegal_move_leaves_state_unchanged() {
    let mut state = state_4x4(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 0, 1),
        piece(2, PlayerSide::Black, PieceType::Paper, 1, 1),
    ]);
    let before = state.clone();
    let illegal = MoveAction { piece_id: 1, target_pos: Coord::new(1, 1) };
    assert!(apply_move_v2(&mut state, &illegal).is_err());
    assert_eq!(state.turn_number, before.turn_number);
    assert_eq!(state.active_player, before.active_player);
    assert_eq!(state.pieces, before.pieces);
}

#[test]
fn diagonal_step_is_legal_when_orthogonal_corners_are_missing() {
    let tiles = [(0, 0), (1, 1), (2, 2)];
    let map = MapTopology::try_new("diagonal", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2)).unwrap();
    let mut state = GameState::try_new(map, vec![
        piece(1, PlayerSide::White, PieceType::Rock, 0, 0),
        piece(2, PlayerSide::Black, PieceType::Scissors, 2, 2),
    ], 50).unwrap();
    let action = MoveAction { piece_id: 1, target_pos: Coord::new(1, 1) };
    assert!(apply_move_v2(&mut state, &action).is_ok());
}

#[test]
fn initial_stalemate_only_checks_white_as_first_mover() {
    let map = MapTopology::try_new("stalemate", 3, 3,
        &[(0,0),(0,1),(1,0),(1,1),(2,0)], Coord::new(0, 0), Coord::new(2, 0)).unwrap();
    let state = GameState::try_new(map, vec![
        piece(1, PlayerSide::White, PieceType::Rock, 0, 0),
        piece(2, PlayerSide::White, PieceType::Rock, 0, 1),
        piece(3, PlayerSide::White, PieceType::Rock, 1, 0),
        piece(4, PlayerSide::White, PieceType::Rock, 1, 1),
        piece(5, PlayerSide::Black, PieceType::Paper, 2, 0),
    ], 50).unwrap();
    let outcome = state.outcome();
    assert!(outcome.is_game_over);
    assert_eq!(outcome.winner, Some(PlayerSide::Black));
    assert_eq!(outcome.reason, Some(VictoryReason::Stalemate));
}
