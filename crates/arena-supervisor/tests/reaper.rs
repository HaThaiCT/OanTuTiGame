use arena_supervisor::reaper::{monitor, ReapCause};
use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

#[test]
fn supervisor_disconnect_reaps_once() {
    let (reader, mut writer) = UnixStream::pair().unwrap();
    writer.write_all(&[0]).unwrap();
    drop(writer);
    let mut cleanups = 0;
    let cause = monitor(reader, Duration::from_secs(1), || { cleanups += 1; Ok(()) }).unwrap();
    assert_eq!(cause, ReapCause::Disconnected);
    assert_eq!(cleanups, 1);
}

#[test]
fn silent_or_invalid_supervisor_cannot_keep_workload_alive() {
    let (reader, _writer) = UnixStream::pair().unwrap();
    assert_eq!(monitor(reader, Duration::from_millis(5), || Ok(())).unwrap(), ReapCause::LeaseExpired);
    let (reader, mut writer) = UnixStream::pair().unwrap();
    writer.write_all(&[1]).unwrap();
    assert_eq!(monitor(reader, Duration::from_secs(1), || Ok(())).unwrap(), ReapCause::InvalidHeartbeat);
}

#[test]
fn cleanup_failure_is_not_reported_as_reaped() {
    let (reader, writer) = UnixStream::pair().unwrap();
    drop(writer);
    assert_eq!(monitor(reader, Duration::from_secs(1), || Err(io::Error::new(io::ErrorKind::PermissionDenied, "cleanup failed"))).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn disconnected_supervisor_does_not_release_populated_slot() {
    use arena_supervisor::control::CgroupControl;
    use std::fs;
    let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("arena-reaper-{}-{unique}", std::process::id()));
    fs::create_dir(&path).unwrap();
    for (name, contents) in [("cpu.stat", "usage_usec 0\n"), ("cgroup.events", "populated 1\nfrozen 0\n"), ("cgroup.freeze", "0"), ("cgroup.kill", "0")] {
        fs::write(path.join(name), contents).unwrap();
    }
    let mut controller = CgroupControl::open(&path).unwrap();
    let (reader, writer) = UnixStream::pair().unwrap();
    drop(writer);
    let result = monitor(reader, Duration::from_secs(1), || controller.kill_and_wait(Duration::from_millis(3)));
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    assert_eq!(fs::read_to_string(path.join("cgroup.kill")).unwrap(), "1");
    fs::remove_dir_all(path).unwrap();
}
