//! Private worker watchdog process. Heartbeat is an exclusive inherited Unix socket on stdin.
use arena_supervisor::{control::CgroupControl, reaper::monitor};
use std::{io::{self, Write}, os::fd::AsFd, os::unix::net::UnixStream, path::PathBuf, process::{Command, Stdio}, time::{Duration, Instant}};

fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 { return Err(io::Error::other("expected runsc, state, id, cgroup")); }
    let runsc = PathBuf::from(&args[0]);
    let state = PathBuf::from(&args[1]);
    let id = args[2].to_str().filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .ok_or_else(|| io::Error::other("invalid runtime id"))?;
    let cgroup = PathBuf::from(&args[3]);
    let mut control = CgroupControl::open(&cgroup)?;
    let mut heartbeat = UnixStream::from(io::stdin().as_fd().try_clone_to_owned()?);
    heartbeat.local_addr()?;
    heartbeat.write_all(&[0])?;
    monitor(heartbeat, Duration::from_secs(3), || {
        let mut failure = if cgroup.try_exists()? { control.kill_and_wait(Duration::from_secs(2)).err() } else { None };
        if state.join(id).try_exists()? {
            let mut delete = Command::new(&runsc).arg("--root").arg(&state)
                .args(["--rootless", "--network=none", "--overlay2=none", "--platform=systrap", "--gofer-network-namespace=new",
                    "--host-settings=check", "--host-uds=none", "--host-fifo=none", "--sidecar-usage-policy=STRICT",
                    "--sidecar-release-enforcement-policy=ALWAYS", "delete", "--force", id])
                .env_clear().env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin").env("LANG", "C").current_dir("/")
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
            let started = Instant::now();
            loop {
                if let Some(status) = delete.try_wait()? {
                    if !status.success() { failure = Some(io::Error::other("reaper runtime delete failed")); }
                    break;
                }
                if started.elapsed() >= Duration::from_secs(2) {
                    let _ = delete.kill(); let _ = delete.wait();
                    failure = Some(io::Error::other("reaper runtime delete timed out")); break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        if cgroup.try_exists()? {
            if let Err(error) = control.kill_and_wait(Duration::from_secs(2)) { failure = Some(error); }
        }
        match failure { Some(error) => Err(error), None => Ok(()) }
    })?;
    Ok(())
}
