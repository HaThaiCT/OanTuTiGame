//! Session binding and bounded payload shape. Direction, JSON semantics and
//! gameplay ordering remain mandatory lifecycle-dispatcher checks.
use crate::execution::{Envelope, envelope::Message};
use std::io;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "execution session rejected")
}

fn uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' }
        else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
    })
}

fn ndjson(bytes: &[u8], cap: usize) -> bool {
    bytes.len() > 1 && bytes.len() <= cap && bytes.last() == Some(&b'\n')
        && !bytes[..bytes.len() - 1].contains(&b'\n') && std::str::from_utf8(bytes).is_ok()
}

fn payload(message: &Message) -> bool {
    match message {
        Message::StartGame(value) => !value.canonical_game_manifest.is_empty()
            && value.canonical_game_manifest.len() <= 1024 * 1024,
        Message::RunBotTurn(value) => matches!(value.side, 1 | 2)
            && value.ply <= 300 && ndjson(&value.request_ndjson, 256 * 1024),
        Message::TurnObservation(value) => matches!(value.side, 1 | 2) && value.ply <= 300
            && value.freeze_confirmed && ndjson(&value.response_ndjson, 16 * 1024),
        Message::TurnCommitted(value) => value.ply <= 300 && value.state_sha256.len() == 32,
        Message::GameFinished(value) => !value.canonical_game_evidence.is_empty()
            && value.canonical_game_evidence.len() <= 1024 * 1024,
        Message::ExecutionFault(value) => (1..=5).contains(&value.kind) && matches!(value.side, 0..=2),
        Message::StopGame(value) => !value.reason_code.is_empty() && value.reason_code.len() <= 128
            && value.reason_code.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
    }
}

#[derive(Clone, Copy)]
pub enum Sender { GameHost, Supervisor }

fn permitted(sender: Sender, message: &Message) -> bool {
    match sender {
        Sender::GameHost => matches!(message, Message::RunBotTurn(_) | Message::TurnCommitted(_)
            | Message::GameFinished(_) | Message::ExecutionFault(_) | Message::StopGame(_)),
        Sender::Supervisor => matches!(message, Message::StartGame(_) | Message::TurnObservation(_)
            | Message::ExecutionFault(_) | Message::StopGame(_)),
    }
}

pub struct ExecutionSession {
    game: String,
    attempt: String,
    manifest: [u8; 32],
    next: Option<u64>,
    rejected: bool,
    sender: Sender,
}

impl ExecutionSession {
    pub fn new(game: &str, attempt: &str, manifest: [u8; 32], first_sequence: u64, sender: Sender) -> io::Result<Self> {
        if !uuid(game) || !uuid(attempt) { return Err(invalid()); }
        Ok(Self { game: game.into(), attempt: attempt.into(), manifest, next: Some(first_sequence), rejected: false, sender })
    }

    /// Errors are terminal for this stream. Success does not authorize launch,
    /// scoring, or trust payload JSON/turn state without dispatcher validation.
    pub fn accept(&mut self, envelope: &Envelope) -> io::Result<()> {
        if self.rejected || envelope.protocol_version != 2 || envelope.game_id != self.game
            || envelope.attempt_id != self.attempt || envelope.manifest_sha256 != self.manifest
            || !uuid(&envelope.request_id) || self.next != Some(envelope.sequence)
            || !envelope.message.as_ref().is_some_and(|message| payload(message) && permitted(self.sender, message)) {
            self.rejected = true;
            return Err(invalid());
        }
        self.next = envelope.sequence.checked_add(1);
        Ok(())
    }
}
