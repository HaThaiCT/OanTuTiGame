use std::io::{Cursor, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use parking_lot::Mutex;
use std::thread;

use arena_engine::PlayerSide;
use arena_execution::{
    envelope::Message, Envelope, ExecutionFault, GameFinished, RunBotTurn, TurnObservation,
};
use arena_runner::session::{open_session, run_started_session, OpenOutcome, PROTOCOL_VERSION};
use prost::Message as _;
use serde_json::json;
use sha2::{Digest, Sha256};

fn manifest_json() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "gameId":"game-1",
        "attemptId":"attempt-1",
        "map":{
            "name":"run",
            "width":3,
            "height":3,
            "validTiles":[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]],
            "whiteThrone":[0,0],
            "blackThrone":[2,2]
        },
        "pieces":[
            {"id":1,"owner":"WHITE","type":"ROCK","x":1,"y":2,"alive":true},
            {"id":2,"owner":"BLACK","type":"PAPER","x":1,"y":0,"alive":true}
        ],
        "maxPly":50
    })).unwrap()
}

fn read_frame(stream: &mut UnixStream) -> Envelope {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).unwrap();
    let len = u32::from_be_bytes(header) as usize;
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).unwrap();
    Envelope::decode(payload.as_slice()).unwrap()
}

fn write_reply(stream: &mut UnixStream, sequence: u64, request: &Envelope, message: Message) {
    let reply = Envelope {
        protocol_version: PROTOCOL_VERSION,
        game_id: request.game_id.clone(),
        attempt_id: request.attempt_id.clone(),
        sequence,
        request_id: request.request_id.clone(),
        manifest_sha256: request.manifest_sha256.clone(),
        message: Some(message),
    };
    let bytes = reply.encode_to_vec();
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
    stream.write_all(&bytes).unwrap();
    stream.flush().unwrap();
}

fn started_session(manifest: &[u8]) -> arena_runner::session::StartedSession {
    let digest: [u8; 32] = Sha256::digest(manifest).into();
    let start = Envelope {
        protocol_version: PROTOCOL_VERSION,
        game_id: "game-1".into(),
        attempt_id: "attempt-1".into(),
        sequence: 0,
        request_id: "00000000-0000-0000-0000-000000000001".into(),
        manifest_sha256: digest.to_vec(),
        message: Some(Message::StartGame(arena_execution::StartGame {
            canonical_game_manifest: manifest.to_vec(),
        })),
    };
    let mut framed = (start.encode_to_vec().len() as u32).to_be_bytes().to_vec();
    framed.extend(start.encode_to_vec());
    let mut output = Vec::new();
    match open_session(&mut Cursor::new(framed), &mut output).unwrap() {
        OpenOutcome::Ready(session) => session,
        OpenOutcome::InitialTerminal { .. } => panic!("expected nonterminal"),
    }
}

#[test]
fn session_runs_turns_and_emits_finished_evidence() {
    let manifest = manifest_json();
    let session = started_session(&manifest);
    let (mut runner_io, mut supervisor) = UnixStream::pair().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_clone = seen.clone();
    let fake = thread::spawn(move || {
        let mut reply_sequence = 1u64;
        loop {
            let request = read_frame(&mut supervisor);
            match request.message.as_ref() {
                Some(Message::RunBotTurn(turn)) => {
                    seen_clone.lock().push(format!("turn:{}:{}", turn.side, turn.ply));
                    let ndjson = if turn.ply == 0 {
                        b"{\"status\":\"READY\"}\n".to_vec()
                    } else {
                        b"{\"action\":\"MOVE\",\"piece_id\":1,\"target\":{\"x\":2,\"y\":2}}\n".to_vec()
                    };
                    write_reply(&mut supervisor, reply_sequence, &request, Message::TurnObservation(TurnObservation {
                        side: turn.side,
                        ply: turn.ply,
                        response_ndjson: ndjson,
                        cpu_usage_usec: 10,
                        wall_elapsed_usec: 20,
                        freeze_confirmed: true,
                    }));
                    reply_sequence += 1;
                }
                Some(Message::TurnCommitted(_)) => {
                    seen_clone.lock().push("committed".into());
                }
                Some(Message::GameFinished(finish)) => {
                    seen_clone.lock().push(String::from_utf8(finish.canonical_game_evidence.clone()).unwrap());
                    break;
                }
                other => panic!("unexpected message: {other:?}"),
            }
        }
    });

    let result = run_started_session(&mut runner_io, session).expect("session runs");
    fake.join().unwrap();
    assert_eq!(result.outcome.winner, Some(PlayerSide::White));
    assert_eq!(result.applied_ply, 1);
    let seen = seen.lock();
    assert_eq!(seen[0], "turn:1:0");
    assert_eq!(seen[1], "turn:2:0");
    assert_eq!(seen[2], "turn:1:1");
    assert!(seen.iter().any(|line| line.contains("THRONE_BREACH")));
}

#[test]
fn one_startup_fault_awards_other_side_without_turns() {
    let manifest = manifest_json();
    let session = started_session(&manifest);
    let (mut runner_io, mut supervisor) = UnixStream::pair().unwrap();
    let fake = thread::spawn(move || {
        let mut reply_sequence = 1u64;
        loop {
            let request = read_frame(&mut supervisor);
            match request.message.as_ref() {
                Some(Message::RunBotTurn(turn)) if turn.ply == 0 && turn.side == 1 => {
                    write_reply(&mut supervisor, reply_sequence, &request,
                        Message::ExecutionFault(ExecutionFault { kind: 1, side: 1 }));
                    reply_sequence += 1;
                }
                Some(Message::RunBotTurn(turn)) if turn.ply == 0 && turn.side == 2 => {
                    write_reply(&mut supervisor, reply_sequence, &request,
                        Message::TurnObservation(TurnObservation {
                            side: 2,
                            ply: 0,
                            response_ndjson: b"{\"status\":\"READY\"}\n".to_vec(),
                            cpu_usage_usec: 1,
                            wall_elapsed_usec: 1,
                            freeze_confirmed: true,
                        }));
                    reply_sequence += 1;
                }
                Some(Message::GameFinished(_)) => break,
                other => panic!("unexpected message: {other:?}"),
            }
        }
    });
    let result = run_started_session(&mut runner_io, session).expect("session runs");
    fake.join().unwrap();
    assert_eq!(result.outcome.winner, Some(PlayerSide::Black));
    assert_eq!(result.outcome.reason, Some(arena_engine::VictoryReason::BotForfeit));
    assert_eq!(result.applied_ply, 0);
}

#[test]
fn double_startup_fault_is_no_contest() {
    let manifest = manifest_json();
    let session = started_session(&manifest);
    let (mut runner_io, mut supervisor) = UnixStream::pair().unwrap();
    let fake = thread::spawn(move || {
        let mut reply_sequence = 1u64;
        loop {
            let request = read_frame(&mut supervisor);
            match request.message.as_ref() {
                Some(Message::RunBotTurn(turn)) if turn.ply == 0 => {
                    write_reply(&mut supervisor, reply_sequence, &request,
                        Message::ExecutionFault(ExecutionFault { kind: 1, side: turn.side }));
                    reply_sequence += 1;
                }
                Some(Message::GameFinished(_)) => break,
                other => panic!("unexpected message: {other:?}"),
            }
        }
    });
    let result = run_started_session(&mut runner_io, session).expect("session runs");
    fake.join().unwrap();
    assert_eq!(result.outcome.disposition, Some(arena_engine::Disposition::NoContest));
    assert_eq!(result.outcome.reason, Some(arena_engine::VictoryReason::DoubleForfeit));
}
