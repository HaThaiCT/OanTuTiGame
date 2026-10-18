use std::io::{self, Read, Write};
use arena_engine::{apply_move_v2, GameState, MoveAction, PlayerSide, VictoryOutcome};
use arena_execution::{envelope::Message, Envelope, GameFinished, StartGame};
use prost::Message as _;
use serde_json::json;
use sha2::{Digest, Sha256};
use crate::manifest::{parse_manifest, ManifestError};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug)]
pub enum SessionError {
    Io(io::Error),
    InvalidFrame,
    Decode,
    ExpectedStart,
    Manifest(ManifestError),
    InvalidState,
    IdentityMismatch,
    InfrastructureFault,
    BotProtocolViolation,
}

impl From<io::Error> for SessionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub struct StartedSession {
    pub game_id: String,
    pub attempt_id: String,
    pub state: GameState,
    pub manifest_digest: [u8; 32],
    pub request_id: String,
    pub next_sequence: u64,
    pub next_reply_sequence: u64,
}

pub enum OpenOutcome {
    InitialTerminal { outcome: VictoryOutcome, evidence: Vec<u8> },
    Ready(StartedSession),
}

fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, SessionError> {
    let mut header = [0u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(SessionError::InvalidFrame);
    }
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame(writer: &mut impl Write, payload: &[u8]) -> Result<(), SessionError> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(SessionError::InvalidFrame);
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

fn evidence(outcome: &VictoryOutcome, initial_terminal: bool, actions: &[serde_json::Value]) -> Vec<u8> {
    json!({
        "initialTerminal": initial_terminal,
        "outcome": {
            "isGameOver": outcome.is_game_over,
            "winner": outcome.winner.map(|side| side.to_str()),
            "reason": outcome.reason.map(|reason| reason.to_str()),
            "disposition": outcome.disposition.map(|value| value.to_str()),
        },
        "actionTrace": actions,
    }).to_string().into_bytes()
}

pub fn open_session(reader: &mut impl Read, writer: &mut impl Write) -> Result<OpenOutcome, SessionError> {
    let frame = read_frame(reader)?.ok_or(SessionError::ExpectedStart)?;
    let start = Envelope::decode(frame.as_slice()).map_err(|_| SessionError::Decode)?;
    if start.protocol_version != PROTOCOL_VERSION {
        return Err(SessionError::IdentityMismatch);
    }
    let message = start.message.ok_or(SessionError::ExpectedStart)?;
    let Message::StartGame(StartGame { canonical_game_manifest }) = message else {
        return Err(SessionError::ExpectedStart);
    };
    let manifest = parse_manifest(&canonical_game_manifest, &start.manifest_sha256)
        .map_err(SessionError::Manifest)?;
    if manifest.game_id != start.game_id || manifest.attempt_id != start.attempt_id {
        return Err(SessionError::IdentityMismatch);
    }
    let state = GameState::try_new(manifest.map, manifest.pieces, manifest.max_ply)
        .map_err(|_| SessionError::InvalidState)?;
    let outcome = state.outcome();
    if outcome.is_game_over {
        let evidence = evidence(&outcome, true, &[]);
        let finish = Envelope {
            protocol_version: PROTOCOL_VERSION,
            game_id: start.game_id,
            attempt_id: start.attempt_id,
            sequence: start.sequence + 1,
            request_id: start.request_id,
            manifest_sha256: start.manifest_sha256,
            message: Some(Message::GameFinished(GameFinished { canonical_game_evidence: evidence.clone() })),
        };
        write_frame(writer, &finish.encode_to_vec())?;
        return Ok(OpenOutcome::InitialTerminal { outcome, evidence });
    }
    Ok(OpenOutcome::Ready(StartedSession {
        game_id: start.game_id,
        attempt_id: start.attempt_id,
        state,
        manifest_digest: start.manifest_sha256[..].try_into().map_err(|_| SessionError::IdentityMismatch)?,
        request_id: start.request_id,
        next_sequence: start.sequence + 1,
        next_reply_sequence: 1,
    }))
}

pub fn canonical_state_hash(state: &GameState) -> [u8; 32] {
    let pieces: Vec<_> = state.pieces.iter().map(|piece| json!({
        "id": piece.id,
        "owner": piece.owner.to_str(),
        "type": piece.piece_type.to_str(),
        "x": piece.pos.x,
        "y": piece.pos.y,
        "alive": piece.is_alive,
    })).collect();
    let canonical = json!({
        "turn": state.turn_number,
        "active": state.active_player.to_str(),
        "pieces": pieces,
    }).to_string();
    Sha256::digest(canonical.as_bytes()).into()
}

fn request_id_for(sequence: u64) -> String {
    let digest = Sha256::digest(format!("oantuti-request-{sequence}").as_bytes());
    let hex: String = digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn send_message(
    io: &mut (impl Read + Write),
    session: &mut StartedSession,
    message: Message,
) -> Result<Envelope, SessionError> {
    let sequence = session.next_sequence;
    let expected_reply = session.next_reply_sequence;
    let request_id = request_id_for(sequence);
    let envelope = Envelope {
        protocol_version: PROTOCOL_VERSION,
        game_id: session.game_id.clone(),
        attempt_id: session.attempt_id.clone(),
        sequence,
        request_id: request_id.clone(),
        manifest_sha256: session.manifest_digest.to_vec(),
        message: Some(message),
    };
    write_frame(io, &envelope.encode_to_vec())?;
    let frame = read_frame(io)?.ok_or(SessionError::Io(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "supervisor closed during turn",
    )))?;
    let reply = Envelope::decode(frame.as_slice()).map_err(|_| SessionError::Decode)?;
    if reply.protocol_version != PROTOCOL_VERSION
        || reply.game_id != session.game_id
        || reply.attempt_id != session.attempt_id
        || reply.manifest_sha256[..] != session.manifest_digest[..]
        || reply.sequence != expected_reply
        || reply.request_id != request_id
    {
        return Err(SessionError::IdentityMismatch);
    }
    session.next_sequence = sequence + 1;
    session.next_reply_sequence = expected_reply + 1;
    Ok(reply)
}

fn send_only(
    io: &mut (impl Read + Write),
    session: &mut StartedSession,
    message: Message,
) -> Result<(), SessionError> {
    let sequence = session.next_sequence;
    let envelope = Envelope {
        protocol_version: PROTOCOL_VERSION,
        game_id: session.game_id.clone(),
        attempt_id: session.attempt_id.clone(),
        sequence,
        request_id: request_id_for(sequence),
        manifest_sha256: session.manifest_digest.to_vec(),
        message: Some(message),
    };
    write_frame(io, &envelope.encode_to_vec())?;
    session.next_sequence = sequence + 1;
    Ok(())
}

pub enum TurnReply {
    Readiness,
    Action(serde_json::Value),
    BotFault,
}

fn exchange_turn(
    io: &mut (impl Read + Write),
    session: &mut StartedSession,
    side: PlayerSide,
    ply: u32,
    request: serde_json::Value,
    startup: bool,
) -> Result<TurnReply, SessionError> {
    let side_number = match side {
        PlayerSide::White => 1,
        PlayerSide::Black => 2,
    };
    let mut request_ndjson = serde_json::to_vec(&request).expect("request serializes");
    request_ndjson.push(b'\n');
    let reply = send_message(
        io,
        session,
        Message::RunBotTurn(arena_execution::RunBotTurn {
            side: side_number,
            ply,
            request_ndjson,
        }),
    )?;
    match reply.message {
        Some(Message::TurnObservation(observation)) => {
            if observation.side != side_number
                || observation.ply != ply
                || !observation.freeze_confirmed
                || observation.response_ndjson.len() > 16 * 1024
                || !observation.response_ndjson.ends_with(b"\n")
                || observation.response_ndjson[..observation.response_ndjson.len() - 1].contains(&b'\n')
            {
                return Ok(TurnReply::BotFault);
            }
            let (cpu_limit, wall_limit) = if startup {
                (500_000u64, 1_000_000u64)
            } else {
                (100_000u64, 1_000_000u64)
            };
            if observation.cpu_usage_usec > cpu_limit || observation.wall_elapsed_usec >= wall_limit {
                return Ok(TurnReply::BotFault);
            }
            let response: serde_json::Value = serde_json::from_slice(&observation.response_ndjson)
                .map_err(|_| SessionError::Decode)?;
            if startup {
                if response.get("status").and_then(|value| value.as_str()) == Some("READY") {
                    Ok(TurnReply::Readiness)
                } else {
                    Ok(TurnReply::BotFault)
                }
            } else {
                Ok(TurnReply::Action(response))
            }
        }
        Some(Message::ExecutionFault(fault)) => {
            if fault.side != side_number {
                return Err(SessionError::IdentityMismatch);
            }
            match fault.kind {
                1 | 2 | 3 | 4 => Ok(TurnReply::BotFault),
                _ => Err(SessionError::InfrastructureFault),
            }
        }
        _ => Err(SessionError::Decode),
    }
}

fn side_json(side: PlayerSide) -> &'static str {
    match side {
        PlayerSide::White => "WHITE",
        PlayerSide::Black => "BLACK",
    }
}

fn pieces_json(state: &GameState) -> serde_json::Value {
    json!(state.pieces.iter().map(|piece| json!({
        "id": piece.id,
        "owner": side_json(piece.owner),
        "type": piece.piece_type.to_str(),
        "x": piece.pos.x,
        "y": piece.pos.y,
        "is_alive": piece.is_alive,
    })).collect::<Vec<_>>())
}

fn init_request(state: &GameState, side: PlayerSide) -> serde_json::Value {
    json!({
        "type": "INIT",
        "match_id": state.map.map_name,
        "my_side": side_json(side),
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

fn turn_request(state: &GameState) -> serde_json::Value {
    json!({
        "type": "TURN",
        "turn_number": state.turn_number,
        "time_remaining_ms": 100,
        "pieces": pieces_json(state),
    })
}

pub struct RunResult {
    pub outcome: VictoryOutcome,
    pub evidence: Vec<u8>,
    pub applied_ply: u32,
}

/// Runs a full match through the supervisor transport, including independent
/// startup assessment and per-turn action verification. Infrastructure faults
/// abort without fabricating a result.
pub fn run_started_session(
    io: &mut (impl Read + Write),
    mut session: StartedSession,
) -> Result<RunResult, SessionError> {
    let mut startup_faults = 0u8;
    let mut startup_fault_side = None;
    for side in [PlayerSide::White, PlayerSide::Black] {
        let request = init_request(&session.state, side);
        match exchange_turn(io, &mut session, side, 0, request, true)? {
            TurnReply::Readiness => {}
            TurnReply::BotFault => {
                startup_faults += 1;
                startup_fault_side = Some(side);
            }
            TurnReply::Action(_) => return Err(SessionError::Decode),
        }
    }
    if startup_faults == 2 {
        let outcome = VictoryOutcome::no_contest(arena_engine::VictoryReason::DoubleForfeit);
        let evidence = evidence(&outcome, false, &[]);
        let finish = Envelope {
            protocol_version: PROTOCOL_VERSION,
            game_id: session.game_id,
            attempt_id: session.attempt_id,
            sequence: session.next_sequence,
            request_id: session.request_id,
            manifest_sha256: session.manifest_digest.to_vec(),
            message: Some(Message::GameFinished(GameFinished { canonical_game_evidence: evidence.clone() })),
        };
        write_frame(io, &finish.encode_to_vec())?;
        return Ok(RunResult { outcome, evidence, applied_ply: 0 });
    }
    if startup_faults == 1 {
        let winner = startup_fault_side.expect("one startup fault").opponent();
        let outcome = VictoryOutcome::decisive(winner, arena_engine::VictoryReason::BotForfeit);
        let evidence = evidence(&outcome, false, &[]);
        let finish = Envelope {
            protocol_version: PROTOCOL_VERSION,
            game_id: session.game_id,
            attempt_id: session.attempt_id,
            sequence: session.next_sequence,
            request_id: session.request_id,
            manifest_sha256: session.manifest_digest.to_vec(),
            message: Some(Message::GameFinished(GameFinished { canonical_game_evidence: evidence.clone() })),
        };
        write_frame(io, &finish.encode_to_vec())?;
        return Ok(RunResult { outcome, evidence, applied_ply: 0 });
    }

    let mut trace = Vec::new();
    let mut applied_ply = 0u32;
    while !session.state.outcome().is_game_over {
        let side = session.state.active_player;
        let ply = session.state.turn_number;
        let request = turn_request(&session.state);
        let reply = exchange_turn(io, &mut session, side, ply, request, false)?;
        let action = match reply {
            TurnReply::Action(value) => value,
            TurnReply::BotFault => {
                let winner = side.opponent();
                let outcome = VictoryOutcome::decisive(winner, arena_engine::VictoryReason::BotForfeit);
                let evidence = evidence(&outcome, false, &trace);
                let finish = Envelope {
                    protocol_version: PROTOCOL_VERSION,
                    game_id: session.game_id,
                    attempt_id: session.attempt_id,
                    sequence: session.next_sequence,
                    request_id: session.request_id,
                    manifest_sha256: session.manifest_digest.to_vec(),
                    message: Some(Message::GameFinished(GameFinished { canonical_game_evidence: evidence.clone() })),
                };
                write_frame(io, &finish.encode_to_vec())?;
                return Ok(RunResult { outcome, evidence, applied_ply });
            }
            TurnReply::Readiness => return Err(SessionError::Decode),
        };
        if action.get("action").and_then(|value| value.as_str()) != Some("MOVE") {
            return Err(SessionError::BotProtocolViolation);
        }
        let piece_id = action.get("piece_id").and_then(|value| value.as_u64()).ok_or(SessionError::BotProtocolViolation)? as u32;
        let target = action.get("target").ok_or(SessionError::BotProtocolViolation)?;
        let x = target.get("x").and_then(|value| value.as_i64()).ok_or(SessionError::BotProtocolViolation)? as i32;
        let y = target.get("y").and_then(|value| value.as_i64()).ok_or(SessionError::BotProtocolViolation)? as i32;
        let move_action = MoveAction { piece_id, target_pos: arena_engine::Coord::new(x, y) };
        if apply_move_v2(&mut session.state, &move_action).is_err() {
            let winner = side.opponent();
            let outcome = VictoryOutcome::decisive(winner, arena_engine::VictoryReason::BotForfeit);
            let evidence = evidence(&outcome, false, &trace);
            let finish = Envelope {
                protocol_version: PROTOCOL_VERSION,
                game_id: session.game_id,
                attempt_id: session.attempt_id,
                sequence: session.next_sequence,
                request_id: session.request_id,
                manifest_sha256: session.manifest_digest.to_vec(),
                message: Some(Message::GameFinished(GameFinished { canonical_game_evidence: evidence.clone() })),
            };
            write_frame(io, &finish.encode_to_vec())?;
            return Ok(RunResult { outcome, evidence, applied_ply });
        }
        applied_ply += 1;
        trace.push(json!({
            "ply": applied_ply,
            "side": if side == PlayerSide::White { 1 } else { 2 },
            "action": {"pieceId": piece_id, "target": {"x": x, "y": y}},
        }));
        let hash = canonical_state_hash(&session.state);
        send_only(
            io,
            &mut session,
            Message::TurnCommitted(arena_execution::TurnCommitted { ply: applied_ply, state_sha256: hash.to_vec() }),
        )?;
    }

    let outcome = session.state.outcome();
    let evidence = evidence(&outcome, false, &trace);
    let finish = Envelope {
        protocol_version: PROTOCOL_VERSION,
        game_id: session.game_id,
        attempt_id: session.attempt_id,
        sequence: session.next_sequence,
        request_id: session.request_id,
        manifest_sha256: session.manifest_digest.to_vec(),
        message: Some(Message::GameFinished(GameFinished { canonical_game_evidence: evidence.clone() })),
    };
    write_frame(io, &finish.encode_to_vec())?;
    Ok(RunResult { outcome, evidence, applied_ply })
}
