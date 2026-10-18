use arena_supervisor::control::CgroupControl;
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn fixture() -> std::path::PathBuf {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("arena-control-{}-{unique}", std::process::id()));
    fs::create_dir(&path).unwrap();
    fs::write(path.join("cpu.stat"), "usage_usec 123\n").unwrap();
    fs::write(path.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
    fs::write(path.join("cgroup.freeze"), "0").unwrap();
    fs::write(path.join("cgroup.kill"), "0").unwrap();
    path
}

#[test]
fn successful_freeze_write_without_confirmation_is_not_success() {
    let path = fixture();
    let mut control = CgroupControl::open(&path).unwrap();
    assert_eq!(control.freeze(Duration::from_millis(3)).unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    assert_eq!(fs::read_to_string(path.join("cgroup.freeze")).unwrap(), "1");
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn cleanup_requires_no_remaining_descendants() {
    let path = fixture();
    let mut control = CgroupControl::open(&path).unwrap();
    assert_eq!(control.kill_and_wait(Duration::from_millis(3)).unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    fs::write(path.join("cgroup.events"), "populated 0\nfrozen 0\n").unwrap();
    control.kill_and_wait(Duration::from_millis(10)).unwrap();
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn control_does_not_create_missing_kernel_files() {
    let path = fixture();
    fs::remove_file(path.join("cgroup.freeze")).unwrap();
    assert!(CgroupControl::open(&path).is_err());
    assert!(!path.join("cgroup.freeze").exists());
    fs::remove_dir_all(path).unwrap();
}
