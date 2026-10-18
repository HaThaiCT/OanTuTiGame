use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use arena_engine::{apply_move_v2, Coord, GameState, MapTopology, MoveAction, Piece, PlayerSide};
use serde_json::{json, Value};

/// Development-only process launcher. **UNSAFE_LOCAL**: no sandbox, no CPU
/// accounting, no network/secret isolation. Never reachable in production;
/// official execution must use the supervisor's gVisor path.
pub struct LocalBot {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Debug)]
pub enum LocalError {
    Spawn(std::io::Error),
    Protocol,
    BotExit,
    Rejected,
}

impl LocalBot {
    pub fn spawn(mut command: Command) -> Result<Self, LocalError> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(LocalError::Spawn)?;
        let stdin = child.stdin.take().ok_or_else(|| LocalError::Spawn(std::io::Error::other("stdin")))?;
        let stdout = child.stdout.take().ok_or_else(|| LocalError::Spawn(std::io::Error::other("stdout")))?;
        Ok(Self { child, stdin, stdout: BufReader::new(stdout) })
    }

    fn exchange(&mut self, request: &Value) -> Result<Value, LocalError> {
        let mut bytes = serde_json::to_vec(request).map_err(|_| LocalError::Protocol)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).map_err(|_| LocalError::BotExit)?;
        self.stdin.flush().map_err(|_| LocalError::BotExit)?;
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).map_err(|_| LocalError::BotExit)?;
        if read == 0 || line.len() > 16 * 1024 {
            return Err(LocalError::BotExit);
        }
        serde_json::from_str(&line).map_err(|_| LocalError::Protocol)
    }
}

impl Drop for LocalBot {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct LocalManifest {
    pub map: MapTopology,
    pub pieces: Vec<Piece>,
    pub max_ply: u32,
}

fn side_name(side: PlayerSide) -> &'static str {
    match side {
        PlayerSide::White => "WHITE",
        PlayerSide::Black => "BLACK",
    }
}

fn pieces_json(state: &GameState) -> Value {
    json!(state.pieces.iter().map(|piece| json!({
        "id": piece.id,
        "owner": side_name(piece.owner),
        "type": piece.piece_type.to_str(),
        "x": piece.pos.x,
        "y": piece.pos.y,
        "is_alive": piece.is_alive,
    })).collect::<Vec<_>>())
}

fn init_request(state: &GameState, side: PlayerSide) -> Value {
    json!({
        "type": "INIT",
        "match_id": state.map.map_name,
        "my_side": side_name(side),
        "map": {
            "name": state.map.map_name,
            "width": state.map.width,
            "height": state.map.height,
            "valid_tiles": state.map.valid_tiles.iter().map(|(x, y)| json!([x, y])).collect::<Vec<_>>(),
            "white_throne": [state.map.white_throne.x, state.map.white_throne.y],
            "black_throne": [state.map.black_throne.x, state.map.black_throne.y],
        },
        "pieces": pieces_json(state),
        "turn_time_limit_ms": 100,
        "max_turns": state.max_turns,
    })
}

pub fn run_local_match(
    manifest: LocalManifest,
    white: Command,
    black: Command,
) -> Result<arena_engine::VictoryOutcome, LocalError> {
    let mut state = GameState::try_new(manifest.map, manifest.pieces, manifest.max_ply)
        .map_err(|_| LocalError::Rejected)?;
    let mut white_bot = LocalBot::spawn(white)?;
    let mut black_bot = LocalBot::spawn(black)?;
    for (bot, side) in [(&mut white_bot, PlayerSide::White), (&mut black_bot, PlayerSide::Black)] {
        let ready = bot.exchange(&init_request(&state, side))?;
        if ready.get("status").and_then(Value::as_str) != Some("READY") {
            return Err(LocalError::Protocol);
        }
    }
    let mut ply = 0u32;
    while !state.outcome().is_game_over {
        if ply >= manifest.max_ply {
            return Err(LocalError::Protocol);
        }
        let side = state.active_player;
        let request = json!({
            "type": "TURN",
            "turn_number": state.turn_number,
            "time_remaining_ms": 100,
            "pieces": pieces_json(&state),
        });
        let reply = match side {
            PlayerSide::White => white_bot.exchange(&request)?,
            PlayerSide::Black => black_bot.exchange(&request)?,
        };
        if reply.get("action").and_then(Value::as_str) != Some("MOVE") {
            return Err(LocalError::Protocol);
        }
        let piece_id = reply.get("piece_id").and_then(Value::as_u64).ok_or(LocalError::Protocol)? as u32;
        let target = reply.get("target").ok_or(LocalError::Protocol)?;
        let x = target.get("x").and_then(Value::as_i64).ok_or(LocalError::Protocol)? as i32;
        let y = target.get("y").and_then(Value::as_i64).ok_or(LocalError::Protocol)? as i32;
        let action = MoveAction { piece_id, target_pos: Coord::new(x, y) };
        apply_move_v2(&mut state, &action).map_err(|_| LocalError::Protocol)?;
        ply += 1;
    }
    Ok(state.outcome())
}
