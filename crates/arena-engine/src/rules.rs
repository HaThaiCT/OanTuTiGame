use std::collections::HashSet;
use crate::state::GameState;
use crate::types::{
    CaptureEvent, MoveAction, MoveOutcome, PieceType, PlayerSide, VictoryOutcome, VictoryReason,
};

/// Generates all legal moves for a given player side.
pub fn get_legal_moves(state: &GameState, side: PlayerSide) -> Vec<MoveAction> {
    if state.is_terminal() {
        return Vec::new();
    }
    let mut moves = Vec::new();
    let living_pieces = state.get_living_pieces(side);

    for piece in living_pieces {
        let neighbors = state.map.get_neighbors(piece.pos);
        for target_pos in neighbors {
            if let Some(occupant) = state.get_piece_at(target_pos) {
                if occupant.owner == side {
                    // Blocked by friendly piece
                    continue;
                }

                // Enemy piece: can only move if attacker beats victim under cyclic RPS rules
                if piece.piece_type.beats(occupant.piece_type) {
                    moves.push(MoveAction {
                        piece_id: piece.id,
                        target_pos,
                    });
                }
            } else {
                // Empty valid tile: always legal King move
                moves.push(MoveAction {
                    piece_id: piece.id,
                    target_pos,
                });
            }
        }
    }

    moves
}

/// Checks whether a specific move action is legal in the current state.
pub fn is_legal_move(state: &GameState, action: &MoveAction) -> bool {
    let piece = match state.get_piece_by_id(action.piece_id) {
        Some(p) => p,
        None => return false,
    };

    if piece.owner != state.active_player {
        return false;
    }

    // Must be Chebyshev distance 1 (King-like move)
    if piece.pos.chebyshev_distance(action.target_pos) != 1 {
        return false;
    }

    // Must be on valid tile
    if !state.map.is_valid_tile(action.target_pos.x, action.target_pos.y) {
        return false;
    }

    if let Some(occupant) = state.get_piece_at(action.target_pos) {
        if occupant.owner == piece.owner {
            return false;
        }
        // Cyclic capture check
        piece.piece_type.beats(occupant.piece_type)
    } else {
        true
    }
}

/// Evaluates victory conditions according to OanTuTi v2 specification.
pub fn evaluate_victory_v2(state: &GameState) -> VictoryOutcome {
    if let Some(outcome) = state.terminal_outcome() {
        return outcome.clone();
    }
    let white_pieces = state.get_living_pieces(PlayerSide::White);
    let black_pieces = state.get_living_pieces(PlayerSide::Black);

    // Initial Roster Sets
    let mut white_types = HashSet::new();
    let mut black_types = HashSet::new();
    for p in &state.pieces {
        match p.owner {
            PlayerSide::White => {
                white_types.insert(p.piece_type);
            }
            PlayerSide::Black => {
                black_types.insert(p.piece_type);
            }
        }
    }

    // 1. EXTINCTION: opponent lost all pieces of any piece type
    let white_living_types: HashSet<PieceType> = white_pieces.iter().map(|p| p.piece_type).collect();
    let black_living_types: HashSet<PieceType> = black_pieces.iter().map(|p| p.piece_type).collect();

    let white_extinct = white_types.iter().any(|t| !white_living_types.contains(t));
    let black_extinct = black_types.iter().any(|t| !black_living_types.contains(t));

    if white_extinct && black_extinct {
        return VictoryOutcome::no_contest(VictoryReason::InvalidStartBothSides);
    }
    if white_extinct {
        return VictoryOutcome::decisive(PlayerSide::Black, VictoryReason::Extinction);
    }
    if black_extinct {
        return VictoryOutcome::decisive(PlayerSide::White, VictoryReason::Extinction);
    }

    // 2. THRONE BREACH: enemy stands on throne
    let white_breached = state
        .get_piece_at(state.map.black_throne)
        .map(|p| p.owner == PlayerSide::White)
        .unwrap_or(false);
    let black_breached = state
        .get_piece_at(state.map.white_throne)
        .map(|p| p.owner == PlayerSide::Black)
        .unwrap_or(false);

    if white_breached && black_breached {
        return VictoryOutcome::no_contest(VictoryReason::InvalidStartBothSides);
    }
    if white_breached {
        return VictoryOutcome::decisive(PlayerSide::White, VictoryReason::ThroneBreach);
    }
    if black_breached {
        return VictoryOutcome::decisive(PlayerSide::Black, VictoryReason::ThroneBreach);
    }

    // 3. STALEMATE: active player has zero legal moves
    let legal_moves = get_legal_moves(state, state.active_player);
    if legal_moves.is_empty() {
        return VictoryOutcome::decisive(state.active_player.opponent(), VictoryReason::Stalemate);
    }

    // 4. MAX TURNS REACHED
    if state.turn_number > state.max_turns {
        let material_diff = white_pieces.len() as i32 - black_pieces.len() as i32;
        if material_diff > 0 {
            return VictoryOutcome::decisive(PlayerSide::White, VictoryReason::MaxTurnsMaterial);
        } else if material_diff < 0 {
            return VictoryOutcome::decisive(PlayerSide::Black, VictoryReason::MaxTurnsMaterial);
        }

        // Tie on material -> check proximity score
        let prox_white = state.calculate_proximity_score(PlayerSide::White);
        let prox_black = state.calculate_proximity_score(PlayerSide::Black);
        let prox_diff = prox_white - prox_black;

        if prox_diff > 0 {
            return VictoryOutcome::decisive(PlayerSide::White, VictoryReason::MaxTurnsProximity);
        } else if prox_diff < 0 {
            return VictoryOutcome::decisive(PlayerSide::Black, VictoryReason::MaxTurnsProximity);
        }

        return VictoryOutcome::draw(VictoryReason::MaxTurnsDraw);
    }

    VictoryOutcome::in_progress()
}

/// Applies a move to the game state and evaluates outcome.
pub fn apply_move_v2(
    state: &mut GameState,
    action: &MoveAction,
) -> Result<MoveOutcome, &'static str> {
    if state.is_terminal() {
        return Err("GAME_TERMINATED");
    }
    if !is_legal_move(state, action) {
        return Err("ILLEGAL_MOVE");
    }

    let mut capture_event = None;

    // Check if target tile has an enemy victim
    if let Some(victim) = state.get_piece_at_mut(action.target_pos) {
        victim.is_alive = false;
        capture_event = Some(CaptureEvent {
            attacker_id: action.piece_id,
            victim_id: victim.id,
            victim_type: victim.piece_type,
            pos: action.target_pos,
        });
    }

    // Move attacker
    let piece = state
        .get_piece_by_id_mut(action.piece_id)
        .expect("validated by is_legal_move");
    piece.pos = action.target_pos;

    // Advance turn and switch active player
    state.turn_number += 1;
    state.active_player = state.active_player.opponent();

    // Evaluate victory and freeze terminal outcome against further moves.
    let victory = evaluate_victory_v2(state);
    state.freeze_terminal(victory.clone());

    Ok(MoveOutcome {
        is_legal: true,
        capture: capture_event,
        victory,
    })
}
