//! Replay/verification core shared by the native runner and the WASM verifier.
//!
//! The engine crate owns the rules; this module owns the one canonical replay loop so the
//! native `verify-trace` binary, the server-side adjudication path and the browser/WASM
//! verifier cannot drift apart. Adapters (JSON parsing in `arena-verifier`, the server
//! trace verifier) only translate their input into [`ReplayAction`] and compare the result.

use crate::map::MapTopology;
use crate::rules::apply_move_v2;
use crate::state::GameState;
use crate::types::{MoveAction, Piece, PlayerSide, VictoryOutcome};

/// One recorded ply: the 1-based ply number, the side that moved and the move itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayAction {
    pub ply: u32,
    pub side: PlayerSide,
    pub action: MoveAction,
}

/// Every way a recorded trace can be rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayError {
    InitialStateRejected,
    InitialTerminalWithActions,
    TrailingActions,
    WrongSide(u32),
    IllegalAction(u32),
    ClaimedOutcomeMismatch,
    TraceIncomplete,
}

impl core::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ReplayError {}

/// The verified outcome of a replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayEvidence {
    pub outcome: VictoryOutcome,
    pub initial_terminal: bool,
    pub applied_ply: u32,
}

/// Replays `actions` from `pieces` on `map` and checks the position reaches `claimed`.
///
/// Rejects, in order: an invalid start position, actions after an initial terminal state,
/// a missing/duplicate/skipped ply, a move by the wrong side, an illegal move, actions after
/// the game already ended, an unfinished trace, and any outcome that differs from `claimed`.
pub fn verify_actions(
    map: MapTopology,
    pieces: Vec<Piece>,
    max_ply: u32,
    actions: &[ReplayAction],
    claimed: &VictoryOutcome,
) -> Result<ReplayEvidence, ReplayError> {
    let mut state = GameState::try_new(map, pieces, max_ply).map_err(|_| ReplayError::InitialStateRejected)?;
    let initial = state.outcome();
    if initial.is_game_over {
        if !actions.is_empty() {
            return Err(ReplayError::InitialTerminalWithActions);
        }
        if initial != *claimed {
            return Err(ReplayError::ClaimedOutcomeMismatch);
        }
        return Ok(ReplayEvidence {
            outcome: initial,
            initial_terminal: true,
            applied_ply: 0,
        });
    }

    let mut applied = 0u32;
    for record in actions {
        if state.outcome().is_game_over {
            return Err(ReplayError::TrailingActions);
        }
        if record.ply != applied + 1 {
            return Err(ReplayError::IllegalAction(record.ply));
        }
        if record.side != state.active_player {
            return Err(ReplayError::WrongSide(record.ply));
        }
        apply_move_v2(&mut state, &record.action).map_err(|_| ReplayError::IllegalAction(record.ply))?;
        applied = record.ply;
    }

    let outcome = state.outcome();
    if !outcome.is_game_over {
        return Err(ReplayError::TraceIncomplete);
    }
    if outcome != *claimed {
        return Err(ReplayError::ClaimedOutcomeMismatch);
    }
    Ok(ReplayEvidence {
        outcome,
        initial_terminal: false,
        applied_ply: applied,
    })
}
