//! Trusted development bridge to the actual Node engine host over a private
//! inherited Unix socket. Launches no Bot and grants no cgroup/root authority.
use arena_supervisor::ipc::{read_frame, write_frame};
use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (mut native, child_socket) = UnixStream::pair()?;
    let child_fd: std::os::fd::OwnedFd = child_socket.into();
    let mut child = Command::new("/home/ha-thai/.local/share/oantuti/toolchains/node-24.22.0/bin/node")
        .args(["--import", "tsx", "packages/runner/bin/game-host.ts"])
        .stdin(Stdio::from(child_fd)).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn()?;
    let mut sender = native.try_clone()?;
    let forwarding = std::thread::spawn(move || -> io::Result<()> {
        let mut frame = Vec::new();
        while read_frame(&mut io::stdin().lock(), &mut frame)? {
            write_frame(&mut sender, &frame)?;
        }
        sender.shutdown(std::net::Shutdown::Write)
    });
    let result = (|| -> io::Result<()> {
        let mut frame = Vec::new();
        while read_frame(&mut native, &mut frame)? {
            write_frame(&mut io::stdout().lock(), &frame)?;
            io::stdout().flush()?;
        }
        Ok(())
    })();
    if result.is_err() { let _ = child.kill(); }
    let status = child.wait()?;
    // Process exit terminates a blocked stdin-forwarder on error. Normal callers
    // close input after GameFinished; no lifecycle readiness is implied here.
    if forwarding.is_finished() { forwarding.join().map_err(|_| "forwarder panic")??; }
    result?;
    if !status.success() { return Err("game host failed".into()); }
    Ok(())
}
