use arena_engine::{Coord, GameState, MoveAction};
use serde::Deserialize;
use crate::SideInput;

/// Observations are authenticated by the native UID broker before reaching this adapter.
/// Rust proves the observation actually supports the host's proposed fault classification.
#[derive(Deserialize)]
pub(crate) struct FaultInput {
    side: SideInput,
    ply: u32,
    kind: String,
    reason: String,
    response_ndjson: Option<String>,
    cpu_usec: u64,
    wall_usec: u64,
}

pub(crate) fn verify_fault(state: &GameState, fault: &FaultInput) -> Result<(), String> {
    let side = fault.side.to_player();
    if fault.ply == 0 {
        if state.turn_number != 1 { return Err("FAULT_STARTUP_PLY".into()); }
    } else if fault.ply != state.turn_number || side != state.active_player {
        return Err("FAULT_TURN_BINDING".into());
    }
    let valid = match fault.kind.as_str() {
        "CPU_TIMEOUT" => fault.reason == "TIMEOUT" && fault.cpu_usec > (if fault.ply == 0 { 500_000 } else { 100_000 }),
        "WALL_TIMEOUT" => fault.reason == "TIMEOUT" && fault.wall_usec >= 1_000_000,
        "OUTPUT_LIMIT" => fault.reason == "OUTPUT_LIMIT",
        "PROTOCOL_ERROR" => fault.reason == "PROTOCOL_VIOLATION",
        "RESPONSE" => {
            if fault.cpu_usec > (if fault.ply == 0 { 500_000 } else { 100_000 }) || fault.wall_usec >= 1_000_000 {
                return Err("FAULT_RESPONSE_OVER_BUDGET".into());
            }
            let raw = fault.response_ndjson.as_deref().ok_or("FAULT_RESPONSE_MISSING")?;
            let parsed = if raw.len() <= 16_384 && raw.ends_with('\n') && !raw[..raw.len()-1].contains('\n') {
                serde_json::from_str::<serde_json::Value>(raw).ok()
            } else { None };
            match parsed {
                None => fault.reason == "PROTOCOL_VIOLATION",
                Some(value) if fault.ply == 0 => fault.reason == "PROTOCOL_VIOLATION" && value.get("status").and_then(|v| v.as_str()) != Some("READY"),
                Some(value) => {
                    let action = value.get("action").and_then(|v| v.as_str());
                    let id = value.get("piece_id").and_then(|v| v.as_u64()).and_then(|v| u32::try_from(v).ok());
                    let target = value.get("target").and_then(|v| v.as_array()).filter(|v| v.len() == 2);
                    let coord = target.and_then(|v| Some(Coord::new(i32::try_from(v[0].as_i64()?).ok()?, i32::try_from(v[1].as_i64()?).ok()?)));
                    match (action, id, coord) {
                        (Some("MOVE"), Some(piece_id), Some(target_pos)) => fault.reason == "ILLEGAL_MOVE" && !arena_engine::is_legal_move(state, &MoveAction { piece_id, target_pos }),
                        (Some("PASS"), _, _) => fault.reason == "ILLEGAL_MOVE",
                        _ => fault.reason == "PROTOCOL_VIOLATION",
                    }
                }
            }
        }
        _ => false,
    };
    if !valid { return Err("FAULT_NOT_PROVEN".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena_engine::{MapTopology, Piece, PieceType, PlayerSide};

    #[test]
    fn ready_response_cannot_be_relabelled_as_a_startup_fault() {
        let tiles: Vec<(i32, i32)> = (0..3).flat_map(|x| (0..3).map(move |y| (x, y))).collect();
        let map = MapTopology::try_new("fault", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2)).unwrap();
        let state = GameState::try_new(map, vec![
            Piece { id: 1, owner: PlayerSide::White, piece_type: PieceType::Rock, pos: Coord::new(1, 2), is_alive: true },
            Piece { id: 2, owner: PlayerSide::Black, piece_type: PieceType::Rock, pos: Coord::new(0, 2), is_alive: true },
        ], 10).unwrap();
        let mut fault = FaultInput { side: SideInput::White, ply: 0, kind: "RESPONSE".into(), reason: "PROTOCOL_VIOLATION".into(), response_ndjson: Some("{\"status\":\"READY\"}\n".into()), cpu_usec: 1, wall_usec: 1 };
        assert!(verify_fault(&state, &fault).is_err());
        fault.response_ndjson = Some("malformed\n".into());
        assert!(verify_fault(&state, &fault).is_ok());
        fault.kind = "WALL_TIMEOUT".into();
        fault.reason = "TIMEOUT".into();
        fault.wall_usec = 999_999;
        assert!(verify_fault(&state, &fault).is_err());
        fault.wall_usec = 1_000_000;
        assert!(verify_fault(&state, &fault).is_ok());
    }
}
