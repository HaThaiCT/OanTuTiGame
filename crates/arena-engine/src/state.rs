use crate::map::MapTopology;
use crate::types::{Coord, Piece, PlayerSide};

#[derive(Debug, Clone)]
pub struct GameState {
    pub map: MapTopology,
    pub turn_number: u32,
    pub active_player: PlayerSide,
    pub max_turns: u32,
    pub pieces: Vec<Piece>,
}

impl GameState {
    pub fn new(map: MapTopology, pieces: Vec<Piece>, max_turns: u32) -> Self {
        Self {
            map,
            turn_number: 1,
            active_player: PlayerSide::White,
            max_turns,
            pieces,
        }
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
    /// Formula: sum of (100 - chebyshev_distance(piece, enemy_throne))
    pub fn calculate_proximity_score(&self, side: PlayerSide) -> i32 {
        let enemy_throne = match side {
            PlayerSide::White => self.map.black_throne,
            PlayerSide::Black => self.map.white_throne,
        };

        self.get_living_pieces(side)
            .iter()
            .map(|p| (100 - p.pos.chebyshev_distance(enemy_throne)).max(0))
            .sum()
    }
}
