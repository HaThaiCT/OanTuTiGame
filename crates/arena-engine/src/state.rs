use std::collections::HashSet;
use crate::map::MapTopology;
use crate::rules::evaluate_victory_v2;
use crate::types::{Coord, Piece, PlayerSide, ValidationError, VictoryOutcome};

#[derive(Debug, Clone)]
pub struct GameState {
    pub map: MapTopology,
    pub turn_number: u32,
    pub active_player: PlayerSide,
    pub max_turns: u32,
    pub pieces: Vec<Piece>,
    terminal: Option<VictoryOutcome>,
}

impl GameState {
    pub fn try_new(
        map: MapTopology,
        pieces: Vec<Piece>,
        max_turns: u32,
    ) -> Result<Self, ValidationError> {
        if max_turns == 0 || max_turns > 300 {
            return Err(ValidationError::InvalidMaxPly);
        }
        if pieces.len() > map.valid_tiles.len() {
            return Err(ValidationError::PieceLimitExceeded);
        }
        let mut ids = HashSet::with_capacity(pieces.len());
        let mut occupied = HashSet::with_capacity(pieces.len());
        for piece in &pieces {
            if !ids.insert(piece.id) {
                return Err(ValidationError::DuplicatePieceId);
            }
            if !map.is_valid_tile(piece.pos.x, piece.pos.y) {
                return Err(ValidationError::PieceOutOfBounds);
            }
            if piece.is_alive && !occupied.insert((piece.pos.x, piece.pos.y)) {
                return Err(ValidationError::PieceOverlap);
            }
        }
        let mut state = Self {
            map,
            turn_number: 1,
            active_player: PlayerSide::White,
            max_turns,
            pieces,
            terminal: None,
        };
        let initial = evaluate_victory_v2(&state);
        if initial.is_game_over {
            state.terminal = Some(initial);
        }
        Ok(state)
    }

    /// Returns the frozen terminal outcome, or evaluates an in-progress state.
    pub fn outcome(&self) -> VictoryOutcome {
        self.terminal
            .clone()
            .unwrap_or_else(|| evaluate_victory_v2(self))
    }

    pub fn get_living_pieces(&self, side: PlayerSide) -> Vec<&Piece> {
        self.pieces
            .iter()
            .filter(|p| p.is_alive && p.owner == side)
            .collect()
    }

    pub fn get_piece_at(&self, coord: Coord) -> Option<&Piece> {
        self.pieces
            .iter()
            .find(|p| p.is_alive && p.pos == coord)
    }

    pub fn get_piece_at_mut(&mut self, coord: Coord) -> Option<&mut Piece> {
        self.pieces
            .iter_mut()
            .find(|p| p.is_alive && p.pos == coord)
    }

    pub fn get_piece_by_id(&self, id: u32) -> Option<&Piece> {
        self.pieces.iter().find(|p| p.id == id && p.is_alive)
    }

    pub fn get_piece_by_id_mut(&mut self, id: u32) -> Option<&mut Piece> {
        self.pieces.iter_mut().find(|p| p.id == id && p.is_alive)
    }

    /// Calculates aggregate proximity score to enemy throne.
    /// Higher score = closer to breach.
    /// GP-02: sum(floor(25200 / (Chebyshev distance + 1))).
    pub fn calculate_proximity_score(&self, side: PlayerSide) -> i32 {
        let enemy_throne = match side {
            PlayerSide::White => self.map.black_throne,
            PlayerSide::Black => self.map.white_throne,
        };

        self.pieces
            .iter()
            .filter(|piece| piece.is_alive && piece.owner == side)
            .map(|piece| proximity_contribution(piece.pos.chebyshev_distance(enemy_throne)))
            .sum()
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal.is_some()
    }

    pub(crate) fn terminal_outcome(&self) -> Option<&VictoryOutcome> {
        self.terminal.as_ref()
    }

    pub(crate) fn freeze_terminal(&mut self, outcome: VictoryOutcome) {
        if outcome.is_game_over {
            self.terminal = Some(outcome);
        }
    }
}

/// Canonical GP-02 proximity contribution for one living piece.
pub fn proximity_contribution(distance: i32) -> i32 {
    25200 / (distance + 1)
}
