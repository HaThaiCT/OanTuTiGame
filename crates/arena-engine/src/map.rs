use std::collections::HashSet;
use crate::types::Coord;

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
    pub fn new(
        map_name: impl Into<String>,
        width: i32,
        height: i32,
        valid_tiles_list: &[(i32, i32)],
        white_throne: Coord,
        black_throne: Coord,
    ) -> Self {
        let valid_tiles: HashSet<(i32, i32)> = valid_tiles_list.iter().copied().collect();
        Self {
            map_name: map_name.into(),
            width,
            height,
            valid_tiles,
            white_throne,
            black_throne,
        }
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
