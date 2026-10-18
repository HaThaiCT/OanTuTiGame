use std::io::Cursor;
use arena_execution::{envelope::Message, Envelope, StartGame};
use arena_runner::session::{open_session, OpenOutcome, PROTOCOL_VERSION};
use prost::Message as _;
use serde_json::json;
use sha2::{Digest, Sha256};

fn manifest_json(initial_terminal: bool) -> Vec<u8> {
    let pieces = if initial_terminal {
        json!([
            {"id":1,"owner":"WHITE","type":"ROCK","x":2,"y":2,"alive":true},
            {"id":2,"owner":"BLACK","type":"PAPER","x":0,"y":0,"alive":true}
        ])
    } else {
        json!([
            {"id":1,"owner":"WHITE","type":"ROCK","x":1,"y":2,"alive":true},
            {"id":2,"owner":"BLACK","type":"PAPER","x":1,"y":0,"alive":true}
        ])
    };
    serde_json::to_vec(&json!({
        "gameId":"game-1",
        "attemptId":"attempt-1",
        "map":{
            "name":"session",
            "width":3,
            "height":3,
            "validTiles":[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]],
            "whiteThrone":[0,0],
            "blackThrone":[2,2]
        },
        "pieces":pieces,
        "maxPly":50
    })).unwrap()
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut output = (payload.len() as u32).to_be_bytes().to_vec();
    output.extend_from_slice(payload);
    output
}

fn start_envelope(manifest: &[u8], digest: &[u8; 32]) -> Envelope {
    Envelope {
        protocol_version: PROTOCOL_VERSION,
        game_id: "game-1".into(),
        attempt_id: "attempt-1".into(),
        sequence: 0,
        request_id: "00000000-0000-0000-0000-000000000001".into(),
        manifest_sha256: digest.to_vec(),
        message: Some(Message::StartGame(StartGame {
            canonical_game_manifest: manifest.to_vec(),
        })),
    }
}

#[test]
fn initial_terminal_session_emits_engine_evidence_without_bot_turn() {
    let manifest = manifest_json(true);
    let digest: [u8; 32] = Sha256::digest(&manifest).into();
    let input = frame(&start_envelope(&manifest, &digest).encode_to_vec());
    let mut output = Vec::new();
    let result = open_session(&mut Cursor::new(input), &mut output).expect("session opens");
    match result {
        OpenOutcome::InitialTerminal { outcome, evidence } => {
            assert_eq!(outcome.reason, Some(arena_engine::VictoryReason::InvalidStartBothSides));
            let text = String::from_utf8(evidence).unwrap();
            assert!(text.contains("InvalidStartBothSides") || text.contains("INVALID_START_BOTH_SIDES"));
        }
        OpenOutcome::Ready(_) => panic!("expected initial terminal"),
    }
    let length = u32::from_be_bytes(output[..4].try_into().unwrap()) as usize;
    let reply = Envelope::decode(&output[4..4 + length]).expect("reply decodes");
    assert_eq!(reply.sequence, 1);
    assert!(matches!(reply.message, Some(Message::GameFinished(_))));
}

#[test]
fn nonterminal_session_returns_state_without_writing() {
    let manifest = manifest_json(false);
    let digest: [u8; 32] = Sha256::digest(&manifest).into();
    let input = frame(&start_envelope(&manifest, &digest).encode_to_vec());
    let mut output = Vec::new();
    let result = open_session(&mut Cursor::new(input), &mut output).expect("session opens");
    assert!(matches!(result, OpenOutcome::Ready(_)));
    assert!(output.is_empty());
}

#[test]
fn wrong_manifest_digest_is_rejected_before_state_creation() {
    let manifest = manifest_json(false);
    let digest = [0u8; 32];
    let input = frame(&start_envelope(&manifest, &digest).encode_to_vec());
    let mut output = Vec::new();
    assert!(open_session(&mut Cursor::new(input), &mut output).is_err());
}
