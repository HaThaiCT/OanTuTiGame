//! stdin-driven trace verifier for OanTuTi Arena (`verify-trace`).
//!
//! Reads exactly one JSON trace document from stdin and replays it through
//! `arena_engine::replay` (via the shared `arena_verifier` front-end):
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
//! (camelCase); `manifest.pieces` is the engine `Piece` shape (Rust field names).
//! `actions[].side` is optional: when omitted the ply's side is derived from the
//! alternating turn order the engine enforces (ply 1 = WHITE).
//!
//! On success it prints `{"ok":true,"appliedPly":N,"winner":…,"reason":…}` and exits 0.
//! Every rejection and every malformed input prints `{"ok":false,"error":"…"}` and exits 2.

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut raw = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut raw) {
        println!("{{\"ok\":false,\"error\":\"STDIN_READ_FAILED: {error}\"}}");
        return ExitCode::from(arena_verifier::REJECTED_CODE);
    }
    let (line, code) = arena_verifier::verify_line(&raw);
    println!("{line}");
    ExitCode::from(code)
}
