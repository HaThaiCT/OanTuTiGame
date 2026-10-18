//! Private development match reaper. Receives heartbeat on inherited Unix stdin.
use arena_supervisor::{control::CgroupControl, reaper::monitor};
use std::{io, os::fd::AsFd, os::unix::net::UnixStream, path::PathBuf, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 1 { return Err("expected owned match group".into()); }
    let suffix = args[0].strip_prefix("/sys/fs/cgroup/system.slice/oantuti-match-")
        .and_then(|value| value.strip_suffix(".service")).ok_or("invalid match group")?;
    if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid match group".into()); }
    let group = PathBuf::from(&args[0]);
    let heartbeat = UnixStream::from(io::stdin().as_fd().try_clone_to_owned()?);
    heartbeat.local_addr()?;
    let cause = monitor(heartbeat, Duration::from_secs(3), || {
        let mut failure = None;
        for name in ["white", "black"] {
            let leaf = group.join(name);
            // runsc may already have removed its owned, empty group on normal
            // completion. A still-existing group must explicitly confirm empty.
            if leaf.try_exists()? {
                let result = CgroupControl::open(&leaf).and_then(|mut control| control.kill_and_wait(Duration::from_secs(2)));
                if let Err(error) = result { failure = Some(error); }
            }
        }
        match failure { Some(error) => Err(error), None => Ok(()) }
    })?;
    println!("MATCH_REAPER_CLEANUP_CONFIRMED cause={cause:?}");
    Ok(())
}
