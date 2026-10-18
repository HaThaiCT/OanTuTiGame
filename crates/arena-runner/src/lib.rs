use arena_engine::{
    apply_move_v2, GameState, MapTopology, MoveAction, Piece, PlayerSide, VictoryOutcome,
};

pub mod manifest;
pub mod session;
pub mod dev_bot;

#[derive(Debug, Clone)]
pub struct MatchManifest {
    pub game_id: String,
    pub map: MapTopology,
    pub pieces: Vec<Piece>,
    pub max_ply: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionRecord {
    pub ply: u32,
    pub side: PlayerSide,
    pub action: MoveAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchEvidence {
    pub outcome: VictoryOutcome,
    pub actions: Vec<ActionRecord>,
    pub initial_terminal: bool,
    pub applied_ply: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchError {
    InitialStateRejected,
    SourceExhausted,
    IllegalAction(u32),
    WrongSide(u32),
    PlyLimitExceeded,
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for MatchError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceError {
    InitialStateRejected,
    InitialTerminalWithActions,
    TrailingActions,
    WrongSide(u32),
    IllegalAction(u32),
    ClaimedOutcomeMismatch,
    TraceIncomplete,
}

impl std::fmt::Display for TraceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for TraceError {}

/// Runs a game to a terminal outcome using a trusted action source.
/// The source is the only source of actions; no Bot privileges are involved here.
pub fn run_match<F>(manifest: &MatchManifest, mut source: F) -> Result<MatchEvidence, MatchError>
where
    F: FnMut(&GameState, u32) -> Option<MoveAction>,
{
    let mut state = GameState::try_new(
        manifest.map.clone(),
        manifest.pieces.clone(),
        manifest.max_ply,
    )
    .map_err(|_| MatchError::InitialStateRejected)?;
    if state.outcome().is_game_over {
        return Ok(MatchEvidence {
            outcome: state.outcome(),
            actions: Vec::new(),
            initial_terminal: true,
            applied_ply: 0,
        });
    }

    let mut actions = Vec::new();
    let mut ply = 0u32;
    while !state.outcome().is_game_over {
        if ply >= manifest.max_ply {
            return Err(MatchError::PlyLimitExceeded);
        }
        let side = state.active_player;
        let action = source(&state, ply + 1).ok_or(MatchError::SourceExhausted)?;
        let recorded = ActionRecord { ply: ply + 1, side, action };
        apply_move_v2(&mut state, &action).map_err(|_| MatchError::IllegalAction(recorded.ply))?;
        actions.push(recorded);
        ply += 1;
    }

    Ok(MatchEvidence {
        outcome: state.outcome(),
        actions,
        initial_terminal: false,
        applied_ply: ply,
    })
}

/// Replays a claimed action trace and checks it reaches the claimed outcome.
/// Trailing actions after a terminal position are rejected.
pub fn verify_trace(
    manifest: &MatchManifest,
    actions: &[ActionRecord],
    claimed: &VictoryOutcome,
) -> Result<MatchEvidence, TraceError> {
    // One replay loop lives in `arena_engine::replay`; this wrapper only maps its errors so
    // the native runner, the JSON verifier and the WASM verifier cannot drift apart.
    let replay_actions: Vec<arena_engine::ReplayAction> = actions
        .iter()
        .map(|record| arena_engine::ReplayAction {
            ply: record.ply,
            side: record.side,
            action: record.action,
        })
        .collect();
    let evidence = arena_engine::verify_actions(
        manifest.map.clone(),
        manifest.pieces.clone(),
        manifest.max_ply,
        &replay_actions,
        claimed,
    )
    .map_err(map_replay_error)?;
    Ok(MatchEvidence {
        outcome: evidence.outcome,
        actions: actions.to_vec(),
        initial_terminal: evidence.initial_terminal,
        applied_ply: evidence.applied_ply,
    })
}

fn map_replay_error(error: arena_engine::ReplayError) -> TraceError {
    match error {
        arena_engine::ReplayError::InitialStateRejected => TraceError::InitialStateRejected,
        arena_engine::ReplayError::InitialTerminalWithActions => TraceError::InitialTerminalWithActions,
        arena_engine::ReplayError::TrailingActions => TraceError::TrailingActions,
        arena_engine::ReplayError::WrongSide(ply) => TraceError::WrongSide(ply),
        arena_engine::ReplayError::IllegalAction(ply) => TraceError::IllegalAction(ply),
        arena_engine::ReplayError::ClaimedOutcomeMismatch => TraceError::ClaimedOutcomeMismatch,
        arena_engine::ReplayError::TraceIncomplete => TraceError::TraceIncomplete,
    }
}
