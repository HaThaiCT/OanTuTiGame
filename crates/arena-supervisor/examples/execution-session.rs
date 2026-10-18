//! Read-only trusted envelope probe. Bindings come from operator arguments,
//! never from the incoming envelope; this executable cannot launch workloads.
use arena_supervisor::{execution::Envelope, ipc::read_frame, session::{ExecutionSession, Sender}};
use prost::Message;
use std::io;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 5 { return Err("expected game UUID, attempt UUID, manifest hex, first sequence, sender(game-host|supervisor)".into()); }
    if args[2].len() != 64 || !args[2].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid trusted manifest digest".into());
    }
    let mut digest = [0u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&args[2][index * 2..index * 2 + 2], 16)?;
    }
    let sender = match args[4].as_str() {
        "game-host" => Sender::GameHost,
        "supervisor" => Sender::Supervisor,
        _ => return Err("invalid trusted sender".into()),
    };
    let mut session = ExecutionSession::new(&args[0], &args[1], digest, args[3].parse()?, sender)?;
    let mut frame = Vec::new();
    let mut input = io::stdin().lock();
    let mut accepted = 0;
    while read_frame(&mut input, &mut frame)? {
        session.accept(&Envelope::decode(frame.as_slice())?)?;
        accepted += 1;
    }
    println!("SESSION_HEADERS_ACCEPTED count={accepted}");
    Ok(())
}
