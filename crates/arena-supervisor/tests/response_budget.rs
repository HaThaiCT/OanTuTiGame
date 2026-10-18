use arena_supervisor::{cgroup::CgroupSnapshot, response::{accept_frozen_response, ResponseFailure}, watchdog::Budget};
use std::time::Duration;

fn snapshot(cpu: u64, frozen: bool) -> CgroupSnapshot {
    CgroupSnapshot { usage_usec: cpu, frozen, populated: true }
}
fn budget() -> Budget { Budget { cpu_usec: 100000, wall: Duration::from_secs(1) } }

#[test]
fn response_cannot_win_race_against_watchdog_with_excess_final_cpu() {
    assert_eq!(accept_frozen_response(10, &snapshot(100011, true), Duration::from_millis(20), budget()), Err(ResponseFailure::CpuTimeout));
    assert_eq!(accept_frozen_response(10, &snapshot(100010, true), Duration::from_millis(20), budget()).unwrap().cpu_usec, 100000);
}

#[test]
fn unconfirmed_freeze_or_counter_rollback_is_infrastructure_not_bot_timeout() {
    assert_eq!(accept_frozen_response(10, &snapshot(200000, false), Duration::from_secs(2), budget()), Err(ResponseFailure::UnresolvedInfra));
    assert_eq!(accept_frozen_response(10, &snapshot(9, true), Duration::ZERO, budget()), Err(ResponseFailure::UnresolvedInfra));
}

#[test]
fn response_at_wall_deadline_is_rejected() {
    assert_eq!(accept_frozen_response(0, &snapshot(1, true), Duration::from_secs(1), budget()), Err(ResponseFailure::WallTimeout));
}
