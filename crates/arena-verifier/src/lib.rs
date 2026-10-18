//! JSON front-end over `arena_engine::replay`.
//!
//! One implementation of the trace-document format is shared by the native `verify-trace`
//! CLI (stdin → stdout) and the WASM verifier (linear memory ABI), so the two cannot drift.
//! Input document:
//!
//! ```json
//! {
//!   "manifest": {
//!     "game_id": "…",
//!     "map": {
//!       "mapName": "…", "width": 8, "height": 8,
//!       "validTiles": [[0, 0]], "whiteThrone": [0, 0], "blackThrone": [7, 7],
//!       "startingPieces": [{ "id": 1, "owner": "WHITE", "type": "ROCK", "pos": [1, 2] }]
//!     },
//!     "pieces": [
//!       { "id": 1, "owner": "WHITE", "piece_type": "ROCK", "pos": { "x": 1, "y": 2 }, "is_alive": true }
//!     ],
//!     "max_ply": 300
//!   },
//!   "actions": [{ "piece_id": 1, "target_pos": [2, 2], "side": "WHITE" }],
//!   "outcome": { "winner": "WHITE", "reason": "THRONE_BREACH" }
//! }
//! ```
//!
//! `manifest.map` is the engine map descriptor as the TypeScript engine serializes it
//! (camelCase, `startingPieces` ignored); `manifest.pieces` is the engine `Piece` shape
//! (Rust field names). `actions[].side` is optional: when omitted the ply's side comes from
//! the alternating turn order the engine enforces (ply 1 = WHITE).
//!
//! Success prints `{"ok":true,"appliedPly":N,"winner":…,"reason":…}` with exit code 0.
//! Every rejection and every malformed input prints `{"ok":false,"error":"…"}` with exit code 2.

use arena_engine::{
    Coord, Disposition, MapTopology, MoveAction, Piece, PieceType, PlayerSide, ReplayAction,
    VictoryOutcome, VictoryReason,
};
use serde::{Deserialize, Serialize};

/// Exit code for every rejected trace and every malformed input.
pub const REJECTED_CODE: u8 = 2;

#[derive(Deserialize)]
struct Input {
    manifest: ManifestInput,
    #[serde(default)]
    actions: Vec<ActionInput>,
    outcome: Option<OutcomeInput>,
}

#[derive(Deserialize)]
struct ManifestInput {
    /// Present in the document but not needed once the pieces are explicit; kept for shape
    /// compatibility with the runner manifest.
    #[serde(rename = "game_id")]
    _game_id: String,
    map: MapInput,
    pieces: Vec<PieceInput>,
    max_ply: u32,
}

/// `MapDescriptor` as serialized by the TypeScript engine. `startingPieces` and any other
/// unknown key are ignored: the manifest's own `pieces` list is authoritative.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapInput {
    map_name: String,
    width: i32,
    height: i32,
    valid_tiles: Vec<[i32; 2]>,
    white_throne: [i32; 2],
    black_throne: [i32; 2],
}

#[derive(Deserialize)]
struct PieceInput {
    id: u32,
    owner: SideInput,
    piece_type: PieceTypeInput,
    pos: CoordInput,
    is_alive: bool,
}

#[derive(Deserialize)]
struct CoordInput {
    x: i32,
    y: i32,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "UPPERCASE")]
enum SideInput {
    White,
    Black,
}

impl SideInput {
    fn to_player(self) -> PlayerSide {
        match self {
            Self::White => PlayerSide::White,
            Self::Black => PlayerSide::Black,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum PieceTypeInput {
    Rock,
    Scissors,
    Paper,
}

impl PieceTypeInput {
    fn to_piece_type(self) -> PieceType {
        match self {
            Self::Rock => PieceType::Rock,
            Self::Scissors => PieceType::Scissors,
            Self::Paper => PieceType::Paper,
        }
    }
}

#[derive(Deserialize)]
struct ActionInput {
    piece_id: u32,
    target_pos: [i32; 2],
    /// Optional; omitted means "the side whose turn this ply is".
    #[serde(default)]
    side: Option<SideInput>,
}

#[derive(Deserialize)]
struct OutcomeInput {
    winner: Option<SideInput>,
    reason: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub ok: bool,
    pub applied_ply: u32,
    pub winner: Option<&'static str>,
    pub reason: Option<&'static str>,
}

#[derive(Serialize)]
pub struct Rejected<'a> {
    pub ok: bool,
    pub error: &'a str,
}

/// Verifies one trace document, returning either the verified verdict or the rejection text.
pub fn verify_json(raw: &[u8]) -> Result<Verified, String> {
    let input: Input =
        serde_json::from_slice(raw).map_err(|error| format!("INVALID_INPUT_JSON: {error}"))?;
    let claimed = claimed_outcome(&input.outcome)?;
    let (map, pieces, max_ply) = to_manifest(input.manifest)?;
    let actions = to_actions(&input.actions)?;

    match arena_engine::verify_actions(map, pieces, max_ply, &actions, &claimed) {
        Ok(evidence) => Ok(Verified {
            ok: true,
            applied_ply: evidence.applied_ply,
            winner: evidence.outcome.winner.map(PlayerSide::to_str),
            reason: evidence.outcome.reason.map(VictoryReason::to_str),
        }),
        Err(error) => Err(format!("TRACE_REJECTED: {error}")),
    }
}

/// Verifies one document and renders the single-line JSON response plus its exit code, which
/// is exactly what both the native CLI and the WASM export return.
pub fn verify_line(raw: &[u8]) -> (String, u8) {
    match verify_json(raw) {
        Ok(verified) => (
            serde_json::to_string(&verified).unwrap_or_else(|error| {
                format!("{{\"ok\":false,\"error\":\"SERIALIZATION_FAILED: {error}\"}}")
            }),
            0,
        ),
        Err(message) => (
            serde_json::to_string(&Rejected {
                ok: false,
                error: &message,
            })
            .unwrap_or_else(|error| format!("{{\"ok\":false,\"error\":\"SERIALIZATION_FAILED: {error}\"}}")),
            REJECTED_CODE,
        ),
    }
}

fn claimed_outcome(input: &Option<OutcomeInput>) -> Result<VictoryOutcome, String> {
    let input = input
        .as_ref()
        .ok_or("MISSING_CLAIMED_OUTCOME: outcome must not be null")?;
    let raw_reason = input
        .reason
        .as_deref()
        .ok_or("MISSING_CLAIMED_OUTCOME: outcome.reason must not be null")?;
    let reason = parse_reason(raw_reason)?;
    Ok(VictoryOutcome {
        is_game_over: true,
        winner: input.winner.map(SideInput::to_player),
        reason: Some(reason),
        disposition: Some(disposition_for(reason)),
    })
}

/// The disposition the engine pairs with each victory reason (see `VictoryOutcome`'s
/// constructors): draws and no-contests are the only non-decisive outcomes.
fn disposition_for(reason: VictoryReason) -> Disposition {
    match reason {
        VictoryReason::MaxTurnsDraw => Disposition::Draw,
        VictoryReason::InvalidStartBothSides => Disposition::NoContest,
        _ => Disposition::Decisive,
    }
}

fn parse_reason(raw: &str) -> Result<VictoryReason, String> {
    Ok(match raw {
        "EXTINCTION" => VictoryReason::Extinction,
        "THRONE_BREACH" => VictoryReason::ThroneBreach,
        "STALEMATE" => VictoryReason::Stalemate,
        "MAX_TURNS_MATERIAL" => VictoryReason::MaxTurnsMaterial,
        "MAX_TURNS_PROXIMITY" => VictoryReason::MaxTurnsProximity,
        "MAX_TURNS_DRAW" => VictoryReason::MaxTurnsDraw,
        "INVALID_START_BOTH_SIDES" => VictoryReason::InvalidStartBothSides,
        "BOT_FORFEIT" => VictoryReason::BotForfeit,
        "DOUBLE_FORFEIT" => VictoryReason::DoubleForfeit,
        other => return Err(format!("UNKNOWN_WIN_REASON: {other}")),
    })
}

fn to_manifest(input: ManifestInput) -> Result<(MapTopology, Vec<Piece>, u32), String> {
    let ManifestInput {
        _game_id: _,
        map,
        pieces,
        max_ply,
    } = input;
    let MapInput {
        map_name,
        width,
        height,
        valid_tiles,
        white_throne,
        black_throne,
    } = map;

    let tiles: Vec<(i32, i32)> = valid_tiles.iter().map(|[x, y]| (*x, *y)).collect();
    let topology = MapTopology::try_new(
        map_name,
        width,
        height,
        &tiles,
        Coord::new(white_throne[0], white_throne[1]),
        Coord::new(black_throne[0], black_throne[1]),
    )
    .map_err(|error| format!("INVALID_MAP: {error}"))?;

    let pieces = pieces
        .into_iter()
        .map(|piece| Piece {
            id: piece.id,
            owner: piece.owner.to_player(),
            piece_type: piece.piece_type.to_piece_type(),
            pos: Coord::new(piece.pos.x, piece.pos.y),
            is_alive: piece.is_alive,
        })
        .collect();
    Ok((topology, pieces, max_ply))
}

fn to_actions(input: &[ActionInput]) -> Result<Vec<ReplayAction>, String> {
    let mut actions = Vec::with_capacity(input.len());
    for (index, action) in input.iter().enumerate() {
        let ply = u32::try_from(index + 1).map_err(|_| "TOO_MANY_ACTIONS".to_string())?;
        let side = match action.side {
            Some(side) => side.to_player(),
            None if index % 2 == 0 => PlayerSide::White,
            None => PlayerSide::Black,
        };
        actions.push(ReplayAction {
            ply,
            side,
            action: MoveAction {
                piece_id: action.piece_id,
                target_pos: Coord::new(action.target_pos[0], action.target_pos[1]),
            },
        });
    }
    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "manifest": {
            "game_id": "t",
            "map": {"mapName":"m","width":3,"height":3,
                    "validTiles":[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]],
                    "whiteThrone":[0,0],"blackThrone":[2,2]},
            "pieces": [
                {"id":1,"owner":"WHITE","piece_type":"ROCK","pos":{"x":1,"y":2},"is_alive":true},
                {"id":2,"owner":"BLACK","piece_type":"ROCK","pos":{"x":0,"y":2},"is_alive":true}
            ],
            "max_ply": 10
        },
        "actions": [{"piece_id":1,"target_pos":[2,2],"side":"WHITE"}],
        "outcome": {"winner":"WHITE","reason":"THRONE_BREACH"}
    }"#;

    #[test]
    fn verifies_a_throne_breach_document() {
        let verified = verify_json(MINIMAL.as_bytes()).expect("valid document");
        assert!(verified.ok);
        assert_eq!(verified.applied_ply, 1);
        assert_eq!(verified.winner, Some("WHITE"));
        assert_eq!(verified.reason, Some("THRONE_BREACH"));
    }

    #[test]
    fn wrong_side_is_rejected() {
        let wrong = MINIMAL.replace("\"side\":\"WHITE\"", "\"side\":\"BLACK\"");
        let error = verify_json(wrong.as_bytes()).expect_err("wrong side rejected");
        assert!(error.starts_with("TRACE_REJECTED"), "{error}");
    }

    #[test]
    fn malformed_json_and_missing_outcome_are_rejected() {
        assert!(verify_json(b"{").expect_err("malformed").starts_with("INVALID_INPUT_JSON"));
        let no_outcome = MINIMAL.replace("\"outcome\": {\"winner\":\"WHITE\",\"reason\":\"THRONE_BREACH\"}", "\"outcome\": null");
        assert!(verify_json(no_outcome.as_bytes())
            .expect_err("missing outcome")
            .starts_with("MISSING_CLAIMED_OUTCOME"));
    }

    #[test]
    fn verify_line_reports_exit_codes() {
        let (ok_line, ok_code) = verify_line(MINIMAL.as_bytes());
        assert_eq!(ok_code, 0);
        assert!(ok_line.contains("\"ok\":true"));
        let (bad_line, bad_code) = verify_line(b"{}");
        assert_eq!(bad_code, REJECTED_CODE);
        assert!(bad_line.contains("\"ok\":false"));
    }
}
