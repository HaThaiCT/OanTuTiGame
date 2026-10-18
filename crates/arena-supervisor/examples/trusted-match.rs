//! Fixed development integration driver. Operator-created bundle paths only;
//! not a public API or general-purpose privileged launcher.
use arena_supervisor::{execution::{Envelope, TurnObservation, envelope::Message}, ipc::{read_frame, write_frame}, session::{ExecutionSession, Sender}, sandbox::Sandbox};
use prost::Message as ProstMessage;
use std::{fs, io, os::fd::AsFd, os::unix::net::UnixStream, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 { return Err("expected trusted work directory and delegated cgroup".into()); }
    let work = PathBuf::from(&args[0]);
    let group = PathBuf::from(&args[1]);
    if !work.starts_with("/var/lib/oantuti/development") || !group.starts_with("/sys/fs/cgroup/system.slice") {
        return Err("invalid operator workspace".into());
    }
    let start = Envelope::decode(fs::read(work.join("start.pb"))?.as_slice())?;
    if start.manifest_sha256.len() != 32 { return Err("invalid manifest digest".into()); }
    let manifest: [u8;32] = start.manifest_sha256.as_slice().try_into()?;
    // Operator launcher supplies a private socket to an already unprivileged
    // Node game host. No user-writable Node modules are loaded with root UID.
    let mut socket = UnixStream::from(io::stdin().as_fd().try_clone_to_owned()?);
    socket.local_addr()?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    // stdout is a private heartbeat socket, never inherited by runsc children.
    let mut heartbeat = UnixStream::from(io::stdout().as_fd().try_clone_to_owned()?);
    heartbeat.set_write_timeout(Some(std::time::Duration::from_secs(1)))?;
    let heartbeat_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = heartbeat_stop.clone();
    let heartbeat_thread = std::thread::spawn(move || -> io::Result<()> {
        use std::io::Write;
        while !stopped.load(std::sync::atomic::Ordering::Acquire) {
            heartbeat.write_all(&[0])?;
            std::thread::park_timeout(std::time::Duration::from_millis(250));
        }
        Ok(())
    });
    let mut bots: [Option<Sandbox>; 2] = [None, None];
    let outcome = (|| -> Result<(), Box<dyn std::error::Error>> {
        write_frame(&mut socket, &start.encode_to_vec())?;
        let mut incoming = ExecutionSession::new(&start.game_id, &start.attempt_id, manifest, 0, Sender::GameHost)?;
        let mut sequence = 1_u64;
        let mut frame = Vec::new();
        loop {
            if !read_frame(&mut socket, &mut frame)? { return Err("game host disconnected before result".into()); }
            let command = Envelope::decode(frame.as_slice())?;
            incoming.accept(&command)?;
            match command.message {
                Some(Message::RunBotTurn(turn)) => {
                    let index = match turn.side { 1 => 0, 2 => 1, _ => return Err("invalid side".into()) };
                    if bots[index].is_none() {
                        if turn.ply != 0 { return Err("sandbox INIT required".into()); }
                        let side = if index == 0 { "white" } else { "black" };
                        bots[index] = Some(Sandbox::launch(&work.join(side), &work.join("state"), side, &group.join(side))?);
                    }
                    let payload = match bots[index].as_mut().unwrap().exchange(&turn.request_ndjson, turn.ply == 0) {
                        Ok(observation) => Message::TurnObservation(TurnObservation { side: turn.side, ply: turn.ply,
                            response_ndjson: observation.response, cpu_usage_usec: observation.cpu_usec,
                            wall_elapsed_usec: observation.wall_usec, freeze_confirmed: true }),
                        Err(error) => {
                            use arena_supervisor::sandbox::BotOutputFault;
                            let kind = match error.get_ref().and_then(|cause| cause.downcast_ref::<BotOutputFault>()) {
                                Some(BotOutputFault::OutputLimit) => 4,
                                Some(BotOutputFault::ProtocolViolation) => 1,
                                None => return Err(error.into()),
                            };
                            Message::ExecutionFault(arena_supervisor::execution::ExecutionFault { kind, side: turn.side })
                        }
                    };
                    let response = Envelope { protocol_version: 2, game_id: start.game_id.clone(), attempt_id: start.attempt_id.clone(),
                        sequence, request_id: command.request_id, manifest_sha256: manifest.to_vec(), message: Some(payload) };
                    sequence = sequence.checked_add(1).ok_or("sequence overflow")?;
                    write_frame(&mut socket, &response.encode_to_vec())?;
                }
                Some(Message::TurnCommitted(_)) => {}
                Some(Message::GameFinished(result)) => {
                    fs::write(work.join("game-evidence.json"), &result.canonical_game_evidence)?;
                    return Ok(());
                }
                _ => return Err("unexpected game-host lifecycle message".into()),
            }
        }
    })();
    let mut cleanup_error = None;
    for bot in bots.iter_mut().flatten() { if let Err(error) = bot.stop() { cleanup_error = Some(error); } }
    let _ = socket.shutdown(std::net::Shutdown::Both);
    // Closing this private endpoint stops the Node endpoint on execution error.
    heartbeat_stop.store(true, std::sync::atomic::Ordering::Release);
    heartbeat_thread.thread().unpark();
    let heartbeat_result = heartbeat_thread.join().map_err(|_| "heartbeat thread panic")?;
    heartbeat_result?;
    outcome?;
    if let Some(error) = cleanup_error { return Err(error.into()); }
    Ok(())
}
