use arena_engine::{Coord, Disposition, MapTopology, MoveAction, Piece, PieceType, PlayerSide, VictoryOutcome, VictoryReason};
use arena_runner::{run_match, verify_trace, ActionRecord, MatchError, MatchManifest, TraceError};

fn manifest(pieces: Vec<Piece>) -> MatchManifest {
    let tiles: Vec<_> = (0..3).flat_map(|x| (0..3).map(move |y| (x, y))).collect();
    let map = MapTopology::try_new("trace", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2)).unwrap();
    MatchManifest { game_id: "game-1".into(), map, pieces, max_ply: 50 }
}

fn piece(id: u32, owner: PlayerSide, kind: PieceType, x: i32, y: i32) -> Piece {
    Piece { id, owner, piece_type: kind, pos: Coord::new(x, y), is_alive: true }
}

#[test]
fn run_match_stops_at_terminal_and_verify_replays_it() {
    let m = manifest(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 1, 2),
        piece(2, PlayerSide::Black, PieceType::Paper, 1, 0),
    ]);
    let winning = ActionRecord {
        ply: 1,
        side: PlayerSide::White,
        action: MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) },
    };
    let evidence = run_match(&m, |_, _| Some(winning.action)).expect("match runs");
    assert_eq!(evidence.applied_ply, 1);
    assert_eq!(evidence.actions, vec![winning.clone()]);
    assert_eq!(evidence.outcome.winner, Some(PlayerSide::White));
    assert_eq!(evidence.outcome.reason, Some(VictoryReason::ThroneBreach));

    let verified = verify_trace(&m, &[winning], &evidence.outcome).expect("trace verifies");
    assert_eq!(verified, evidence);
}

#[test]
fn verify_rejects_wrong_side_illegal_and_incomplete_traces() {
    let m = manifest(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 1, 2),
        piece(2, PlayerSide::Black, PieceType::Paper, 1, 0),
    ]);
    let wrong_side = [ActionRecord {
        ply: 1,
        side: PlayerSide::Black,
        action: MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) },
    }];
    assert_eq!(verify_trace(&m, &wrong_side, &VictoryOutcome::in_progress()),
        Err(TraceError::WrongSide(1)));

    let illegal = [ActionRecord {
        ply: 1,
        side: PlayerSide::White,
        action: MoveAction { piece_id: 1, target_pos: Coord::new(0, 0) },
    }];
    assert_eq!(verify_trace(&m, &illegal, &VictoryOutcome::in_progress()),
        Err(TraceError::IllegalAction(1)));

    assert_eq!(verify_trace(&m, &[], &VictoryOutcome::in_progress()),
        Err(TraceError::TraceIncomplete));
}

#[test]
fn verify_rejects_trailing_actions_and_claimed_mismatch() {
    let m = manifest(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 1, 2),
        piece(2, PlayerSide::Black, PieceType::Paper, 1, 0),
    ]);
    let winning = ActionRecord {
        ply: 1,
        side: PlayerSide::White,
        action: MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) },
    };
    let trailing = ActionRecord {
        ply: 2,
        side: PlayerSide::Black,
        action: MoveAction { piece_id: 2, target_pos: Coord::new(2, 0) },
    };
    assert_eq!(verify_trace(&m, &[winning.clone(), trailing], &VictoryOutcome::in_progress()),
        Err(TraceError::TrailingActions));

    let fabricated = VictoryOutcome::decisive(PlayerSide::Black, VictoryReason::ThroneBreach);
    assert_eq!(verify_trace(&m, &[winning], &fabricated),
        Err(TraceError::ClaimedOutcomeMismatch));
}

#[test]
fn initial_terminal_accepts_no_actions_and_rejects_any_action() {
    let m = manifest(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 2, 2),
        piece(2, PlayerSide::Black, PieceType::Paper, 0, 0),
    ]);
    let outcome = VictoryOutcome::no_contest(VictoryReason::InvalidStartBothSides);
    let evidence = verify_trace(&m, &[], &outcome).expect("initial terminal");
    assert!(evidence.initial_terminal);
    assert_eq!(evidence.applied_ply, 0);

    let action = ActionRecord {
        ply: 1,
        side: PlayerSide::White,
        action: MoveAction { piece_id: 1, target_pos: Coord::new(2, 2) },
    };
    assert_eq!(verify_trace(&m, &[action], &outcome), Err(TraceError::InitialTerminalWithActions));
}

#[test]
fn run_match_reports_source_exhaustion_before_terminal() {
    let m = manifest(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 0, 0),
        piece(2, PlayerSide::Black, PieceType::Paper, 2, 2),
    ]);
    assert_eq!(run_match(&m, |_, _| None), Err(MatchError::SourceExhausted));
}

#[test]
fn initial_terminal_outcome_is_no_contest() {
    let m = manifest(vec![
        piece(1, PlayerSide::White, PieceType::Rock, 2, 2),
        piece(2, PlayerSide::Black, PieceType::Paper, 0, 0),
    ]);
    let evidence = run_match(&m, |_, _| None).expect("initial terminal");
    assert!(evidence.initial_terminal);
    assert_eq!(evidence.outcome.disposition, Some(Disposition::NoContest));
}
