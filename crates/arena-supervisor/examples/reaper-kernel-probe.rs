//! Dedicated trusted kernel-smoke reaper, not a general privileged daemon.
//! stdin must be a private Unix socket whose writer belongs only to supervisor.
use arena_supervisor::{control::CgroupControl, reaper::monitor};
use std::{fs, io, os::fd::AsFd, os::unix::net::UnixStream, path::Path, time::Duration};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 { return Err("expected dedicated test cgroup and child PID".into()); }
    let name = args[0].strip_prefix("/sys/fs/cgroup/system.slice/oantuti-kernel-smoke-")
        .and_then(|value| value.strip_suffix(".service/trusted-workload"))
        .ok_or("invalid dedicated test cgroup")?;
    if name.len() != 32 || !name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("invalid dedicated test cgroup".into());
    }
    let status = fs::read_to_string("/proc/self/status")?;
    if status.lines().find_map(|line| line.strip_prefix("Uid:")).and_then(|line| line.split_whitespace().nth(1)) != Some("0") {
        return Err("operator root authentication required".into());
    }
    let pid: u32 = args[1].parse()?;
    let relative = args[0].strip_prefix("/sys/fs/cgroup").unwrap();
    if pid <= 1 || fs::read_to_string(format!("/proc/{pid}/cgroup"))?.trim() != format!("0::{relative}") {
        return Err("trusted workload membership mismatch".into());
    }
    if fs::read_to_string(Path::new(&args[0]).join("cgroup.procs"))?.split_whitespace().collect::<Vec<_>>() != [args[1].as_str()] {
        return Err("unexpected cgroup members".into());
    }
    let mut control = CgroupControl::open(Path::new(&args[0]))?;
    let heartbeat = UnixStream::from(io::stdin().as_fd().try_clone_to_owned()?);
    // Verify the inherited descriptor is a Unix socket before arming cleanup.
    heartbeat.local_addr()?;
    let cause = monitor(heartbeat, Duration::from_secs(3), || control.kill_and_wait(Duration::from_secs(3)))?;
    println!("{{\"status\":\"PASS\",\"reaper\":\"rust\",\"cause\":\"{cause:?}\",\"zeroDescendantsConfirmed\":true}}");
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("REAPER_PROBE_REJECTED: invalid binding or cleanup failure");
        std::process::exit(1);
    }
}
