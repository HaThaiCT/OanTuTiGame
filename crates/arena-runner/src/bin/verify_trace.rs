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
//! On success prints `{"ok":true,"appliedPly":N,"isGameOver":…,"winner":…,"reason":…}` and exits 0.
//! Every rejection and every malformed input prints `{"ok":false,"error":"…"}` and exits 2.
//! The server adapter enforces a wall-clock deadline and output limits. This CLI also
//! bounds stdin to 4 MiB; `prefix_only` validates moves but never proves a runtime fault.

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut raw = Vec::new();
    const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;
    if std::io::stdin().take(MAX_INPUT_BYTES + 1).read_to_end(&mut raw).is_err() {
        println!("{{\"ok\":false,\"error\":\"STDIN_READ_FAILED\"}}");
        return ExitCode::from(arena_verifier::REJECTED_CODE);
    }
    if raw.len() as u64 > MAX_INPUT_BYTES {
        println!("{{\"ok\":false,\"error\":\"INPUT_TOO_LARGE\"}}");
        return ExitCode::from(arena_verifier::REJECTED_CODE);
    }
    let (line, code) = arena_verifier::verify_line(&raw);
    println!("{line}");
    ExitCode::from(code)
}
