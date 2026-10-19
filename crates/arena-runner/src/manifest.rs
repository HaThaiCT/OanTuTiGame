use arena_engine::{Coord, MapTopology, Piece, PieceType, PlayerSide};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameManifestJson {
    pub game_id: String,
    pub attempt_id: String,
    pub map: MapJson,
    pub pieces: Vec<PieceJson>,
    pub max_ply: u32,
    /// Opaque control-plane receipt provenance, covered by the digest of the complete manifest.
    #[serde(default)]
    pub provenance: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapJson {
    pub name: String,
    pub width: i32,
    pub height: i32,
    pub valid_tiles: Vec<[i32; 2]>,
    pub white_throne: [i32; 2],
    pub black_throne: [i32; 2],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PieceJson {
    pub id: u32,
    pub owner: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: i32,
    pub y: i32,
    pub alive: bool,
}

#[derive(Debug)]
pub struct ParsedManifest {
    pub game_id: String,
    pub attempt_id: String,
    pub map: MapTopology,
    pub pieces: Vec<Piece>,
    pub max_ply: u32,
    pub digest: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestError {
    InvalidJson,
    InvalidDigest,
    InvalidMap,
    InvalidPiece,
}

pub fn parse_manifest(bytes: &[u8], expected_digest: &[u8]) -> Result<ParsedManifest, ManifestError> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    if digest.as_slice() != expected_digest {
        return Err(ManifestError::InvalidDigest);
    }
    let json: GameManifestJson = serde_json::from_slice(bytes).map_err(|_| ManifestError::InvalidJson)?;
    let tiles: Vec<(i32, i32)> = json.map.valid_tiles.iter().map(|[x, y]| (*x, *y)).collect();
    let map = MapTopology::try_new(
        json.map.name,
        json.map.width,
        json.map.height,
        &tiles,
        Coord::new(json.map.white_throne[0], json.map.white_throne[1]),
        Coord::new(json.map.black_throne[0], json.map.black_throne[1]),
    )
    .map_err(|_| ManifestError::InvalidMap)?;
    let mut pieces = Vec::with_capacity(json.pieces.len());
    for piece in json.pieces {
        let owner = match piece.owner.as_str() {
            "WHITE" => PlayerSide::White,
            "BLACK" => PlayerSide::Black,
            _ => return Err(ManifestError::InvalidPiece),
        };
        let kind = match piece.kind.as_str() {
            "ROCK" => PieceType::Rock,
            "SCISSORS" => PieceType::Scissors,
            "PAPER" => PieceType::Paper,
            _ => return Err(ManifestError::InvalidPiece),
        };
        pieces.push(Piece {
            id: piece.id,
            owner,
            piece_type: kind,
            pos: Coord::new(piece.x, piece.y),
            is_alive: piece.alive,
        });
    }
    Ok(ParsedManifest {
        game_id: json.game_id,
        attempt_id: json.attempt_id,
        map,
        pieces,
        max_ply: json.max_ply,
        digest,
    })
}
