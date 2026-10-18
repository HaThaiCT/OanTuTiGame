use arena_supervisor::execution::{Envelope, StopGame, envelope};
use arena_supervisor::session::{ExecutionSession, Sender};

const GAME: &str = "3c4e2380-eaf2-4d1b-950e-dcb98dc2b561";
const ATTEMPT: &str = "0635c740-b5e3-4131-88ab-d28dd2d9a2b5";
fn message(sequence: u64) -> Envelope {
    Envelope { protocol_version: 2, game_id: GAME.into(), attempt_id: ATTEMPT.into(), sequence,
        request_id: "ad13cf2e-257b-44ab-b47e-547e72d0a5b3".into(), manifest_sha256: vec![7; 32],
        message: Some(envelope::Message::StopGame(StopGame { reason_code: "OPERATOR_STOP".into() })) }
}
fn session(first: u64) -> ExecutionSession { ExecutionSession::new(GAME, ATTEMPT, [7; 32], first, Sender::GameHost).unwrap() }

#[test]
fn replay_and_recovery_after_rejection_are_forbidden() {
    let mut session = session(1);
    session.accept(&message(1)).unwrap();
    assert!(session.accept(&message(1)).is_err());
    assert!(session.accept(&message(2)).is_err());
}

#[test]
fn foreign_attempt_and_manifest_cannot_enter_session() {
    let mut foreign = message(0); foreign.attempt_id = GAME.into();
    assert!(session(0).accept(&foreign).is_err());
    let mut foreign = message(0); foreign.manifest_sha256[0] = 8;
    assert!(session(0).accept(&foreign).is_err());
}

#[test]
fn missing_payload_unknown_version_and_invalid_request_are_rejected() {
    let mut missing = message(0); missing.message = None;
    assert!(session(0).accept(&missing).is_err());
    let mut version = message(0); version.protocol_version = 1;
    assert!(session(0).accept(&version).is_err());
    let mut request = message(0); request.request_id = "client-string".into();
    assert!(session(0).accept(&request).is_err());
}

#[test]
fn maximum_sequence_is_accepted_once_without_wrapping() {
    let mut session = session(u64::MAX);
    session.accept(&message(u64::MAX)).unwrap();
    assert!(session.accept(&message(0)).is_err());
}

#[test]
fn unfrozen_observation_cannot_advance_session() {
    let mut value = message(0);
    value.message = Some(envelope::Message::TurnObservation(arena_supervisor::execution::TurnObservation {
        side: 1, ply: 1, response_ndjson: b"{}\n".to_vec(),
        cpu_usage_usec: 10, wall_elapsed_usec: 10, freeze_confirmed: false,
    }));
    assert!(ExecutionSession::new(GAME, ATTEMPT, [7; 32], 0, Sender::Supervisor).unwrap().accept(&value).is_err());
}

#[test]
fn request_payload_cannot_smuggle_multiple_lines_or_exceed_cap() {
    for bytes in [b"{}\n{}\n".to_vec(), vec![b'x'; 256 * 1024 + 1], b"{}".to_vec()] {
        let mut value = message(0);
        value.message = Some(envelope::Message::RunBotTurn(arena_supervisor::execution::RunBotTurn {
            side: 1, ply: 1, request_ndjson: bytes,
        }));
        assert!(session(0).accept(&value).is_err());
    }
}

#[test]
fn unknown_side_and_wrong_state_digest_are_rejected() {
    let mut value = message(0);
    value.message = Some(envelope::Message::RunBotTurn(arena_supervisor::execution::RunBotTurn {
        side: 999, ply: 1, request_ndjson: b"{}\n".to_vec(),
    }));
    assert!(session(0).accept(&value).is_err());
    value.message = Some(envelope::Message::TurnCommitted(arena_supervisor::execution::TurnCommitted {
        ply: 1, state_sha256: vec![1; 31],
    }));
    assert!(session(0).accept(&value).is_err());
}

#[test]
fn observations_are_only_accepted_from_supervisor() {
    let mut value = message(0);
    value.message = Some(envelope::Message::TurnObservation(arena_supervisor::execution::TurnObservation {
        side: 1, ply: 1, response_ndjson: b"{}\n".to_vec(),
        cpu_usage_usec: 1, wall_elapsed_usec: 2, freeze_confirmed: true,
    }));
    assert!(session(0).accept(&value).is_err());
    ExecutionSession::new(GAME, ATTEMPT, [7; 32], 0, Sender::Supervisor).unwrap().accept(&value).unwrap();
}
