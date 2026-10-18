use arena_supervisor::execution::{Envelope, StopGame, envelope};
use prost::Message;

#[test]
fn generated_envelope_preserves_uint64_above_javascript_safe_integer() {
    let input = Envelope {
        protocol_version: 2, game_id: "game".into(), attempt_id: "attempt".into(),
        sequence: 9007199254740993, request_id: "request".into(),
        manifest_sha256: vec![7; 32],
        message: Some(envelope::Message::StopGame(StopGame { reason_code: "OPERATOR_STOP".into() })),
    };
    let bytes = input.encode_to_vec();
    assert_eq!(Envelope::decode(bytes.as_slice()).unwrap(), input);
}
