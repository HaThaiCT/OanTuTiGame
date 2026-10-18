use std::collections::HashSet;
use crate::types::{Coord, ValidationError};

#[derive(Debug, Clone)]
pub struct MapTopology {
    pub map_name: String,
    pub width: i32,
    pub height: i32,
    pub valid_tiles: HashSet<(i32, i32)>,
    pub white_throne: Coord,
    pub black_throne: Coord,
}

impl MapTopology {
    pub fn try_new(
        map_name: impl Into<String>,
        width: i32,
        height: i32,
        valid_tiles_list: &[(i32, i32)],
        white_throne: Coord,
        black_throne: Coord,
    ) -> Result<Self, ValidationError> {
        if !(3..=64).contains(&width) || !(3..=64).contains(&height) {
            return Err(ValidationError::InvalidDimensions);
        }
        if valid_tiles_list.is_empty() || valid_tiles_list.len() > 4096 {
            return Err(ValidationError::InvalidCellCount);
        }
        let mut valid_tiles = HashSet::with_capacity(valid_tiles_list.len());
        for &(x, y) in valid_tiles_list {
            if x < 0 || x >= width || y < 0 || y >= height {
                return Err(ValidationError::TileOutOfBounds);
            }
            if !valid_tiles.insert((x, y)) {
                return Err(ValidationError::DuplicateTile);
            }
        }
        let throne_in_bounds = |throne: Coord| {
            valid_tiles.contains(&(throne.x, throne.y))
        };
        if !throne_in_bounds(white_throne) || !throne_in_bounds(black_throne) {
            return Err(ValidationError::InvalidThrone);
        }
        if white_throne == black_throne {
            return Err(ValidationError::DuplicateThrone);
        }
        Ok(Self {
            map_name: map_name.into(),
            width,
            height,
            valid_tiles,
            white_throne,
            black_throne,
        })
    }

    #[inline]
    pub fn is_valid_tile(&self, x: i32, y: i32) -> bool {
        self.valid_tiles.contains(&(x, y))
    }

    #[inline]
    pub fn chebyshev_distance(&self, a: Coord, b: Coord) -> i32 {
        a.chebyshev_distance(b)
    }

    /// King-like 8-directional neighbor coordinates
    pub fn get_neighbors(&self, coord: Coord) -> Vec<Coord> {
        let mut neighbors = Vec::with_capacity(8);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = coord.x + dx;
                let ny = coord.y + dy;
                if self.is_valid_tile(nx, ny) {
                    neighbors.push(Coord::new(nx, ny));
                }
            }
        }
        neighbors
    }
}
