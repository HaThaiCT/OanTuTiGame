//! Synthetic cgroup files only: no runsc or host cgroup mutation.
mod worker_support;
use std::{fs, io::Read, os::{fd::OwnedFd, unix::net::UnixStream}, process::{Command, Stdio}, time::{Duration, Instant}};
use worker_support::TempDir;

#[test]
fn independent_reaper_cleans_up_after_its_exclusive_worker_writer_disappears() {
    let group = TempDir::new("reaper-group");
    for (name, contents) in [("cgroup.freeze", "0"), ("cgroup.kill", "0"),
        ("cpu.stat", "usage_usec 200\n"), ("cgroup.events", "populated 0\nfrozen 1\n")] {
        fs::write(group.child(name), contents).unwrap();
    }
    let state = TempDir::new("reaper-state");
    let (mut worker, reaper) = UnixStream::pair().unwrap();
    worker.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_arena-reaper"))
        .arg("/unavailable-runsc").arg(state.path()).arg("attempt-white").arg(group.path())
        .stdin(Stdio::from(OwnedFd::from(reaper))).spawn().unwrap();
    let mut ready = [1];
    worker.read_exact(&mut ready).unwrap();
    assert_eq!(ready, [0]);
    drop(worker); // Equivalent to worker SIGKILL: no thread/drop cleanup can run there.
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(status.success()); break; }
        if start.elapsed() > Duration::from_secs(4) { let _ = child.kill(); panic!("reaper did not acknowledge cleanup"); }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fs::read_to_string(group.child("cgroup.kill")).unwrap(), "1");
}

#[test]
fn independent_reaper_refuses_cleanup_ack_when_runtime_delete_is_unavailable() {
    let group = TempDir::new("reaper-failed-group");
    for (name, contents) in [("cgroup.freeze", "0"), ("cgroup.kill", "0"),
        ("cpu.stat", "usage_usec 200\n"), ("cgroup.events", "populated 0\nfrozen 1\n")] {
        fs::write(group.child(name), contents).unwrap();
    }
    let state = TempDir::new("reaper-failed-state");
    fs::create_dir(state.child("attempt-white")).unwrap();
    let (mut worker, reaper) = UnixStream::pair().unwrap();
    worker.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_arena-reaper"))
        .arg("/unavailable-runsc").arg(state.path()).arg("attempt-white").arg(group.path())
        .stdin(Stdio::from(OwnedFd::from(reaper))).spawn().unwrap();
    worker.read_exact(&mut [0]).unwrap();
    drop(worker);
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(!status.success()); break; }
        if start.elapsed() > Duration::from_secs(4) { let _ = child.kill(); panic!("reaper failed to terminate"); }
        std::thread::sleep(Duration::from_millis(5));
    }
}
