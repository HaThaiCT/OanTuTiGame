use arena_supervisor::watchdog::{evaluate, Budget, StopReason, Watchdog};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn budget() -> Budget {
    Budget { cpu_usec: 100_000, wall: Duration::from_millis(1000) }
}

#[test]
fn exact_cpu_budget_is_allowed_but_one_usec_more_is_timeout() {
    assert_eq!(evaluate(10, 100_010, Duration::ZERO, budget()), None);
    assert_eq!(evaluate(10, 100_011, Duration::ZERO, budget()), Some(StopReason::CpuTimeout));
}

#[test]
fn wall_deadline_is_inclusive_and_counter_rollback_is_infrastructure() {
    assert_eq!(evaluate(10, 10, Duration::from_millis(1000), budget()), Some(StopReason::WallTimeout));
    assert_eq!(evaluate(10, 9, Duration::from_millis(1000), budget()), Some(StopReason::CounterUnavailable));
}

#[test]
fn counter_failure_invokes_terminal_callback_on_independent_thread() {
    let (tx, rx) = mpsc::channel();
    let caller = std::thread::current().id();
    let path = PathBuf::from("/nonexistent-oantuti-watchdog-counter");
    let watchdog = Watchdog::arm(path, 0, Instant::now(), budget(), move |reason| {
        tx.send((reason, std::thread::current().id())).unwrap();
    }).unwrap();
    let (reason, thread) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(reason, StopReason::CounterUnavailable);
    assert_ne!(thread, caller);
    watchdog.finish().unwrap();
    assert!(rx.try_recv().is_err());
}

#[test]
fn cancelled_watchdog_does_not_emit_late_terminal_event() {
    // A distant deadline with a valid current cgroup; cancellation must join.
    let relative = std::fs::read_to_string("/proc/self/cgroup").unwrap();
    let suffix = relative.lines().find_map(|line| line.strip_prefix("0::")).unwrap();
    let path = PathBuf::from(format!("/sys/fs/cgroup{suffix}"));
    let baseline = arena_supervisor::cgroup::CgroupSnapshot::read(&path).unwrap().usage_usec;
    let (tx, rx) = mpsc::channel();
    let watchdog = Watchdog::arm(path, baseline, Instant::now(), Budget { cpu_usec: u64::MAX, wall: Duration::from_secs(3600) }, move |event| { let _ = tx.send(event); }).unwrap();
    watchdog.finish().unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(10)).is_err());
}

#[test]
fn wall_expiration_calls_terminal_without_waiting_on_owner() {
    let relative = std::fs::read_to_string("/proc/self/cgroup").unwrap();
    let suffix = relative.lines().find_map(|line| line.strip_prefix("0::")).unwrap();
    let path = PathBuf::from(format!("/sys/fs/cgroup{suffix}"));
    let baseline = arena_supervisor::cgroup::CgroupSnapshot::read(&path).unwrap().usage_usec;
    let (tx, rx) = mpsc::channel();
    let watchdog = Watchdog::arm(path, baseline, Instant::now(), Budget {
        cpu_usec: u64::MAX, wall: Duration::from_millis(5),
    }, move |event| { tx.send(event).unwrap(); }).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), StopReason::WallTimeout);
    watchdog.finish().unwrap();
}
