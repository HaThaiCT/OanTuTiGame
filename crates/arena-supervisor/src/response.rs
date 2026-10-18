//! Acceptance of measured resource usage, not JSON/game-action validity. Caller
//! must bind this frozen snapshot to the outstanding attempt and keep it frozen.
use crate::{cgroup::{cpu_delta, CgroupSnapshot}, watchdog::{evaluate, Budget, StopReason}};
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum ResponseFailure { CpuTimeout, WallTimeout, UnresolvedInfra }

#[derive(Debug, PartialEq, Eq)]
pub struct AcceptedUsage {
    pub cpu_usec: u64,
    pub elapsed: Duration,
}

pub fn accept_frozen_response(
    baseline: u64,
    frozen: &CgroupSnapshot,
    elapsed: Duration,
    budget: Budget,
) -> Result<AcceptedUsage, ResponseFailure> {
    if !frozen.frozen {
        return Err(ResponseFailure::UnresolvedInfra);
    }
    match evaluate(baseline, frozen.usage_usec, elapsed, budget) {
        Some(StopReason::CpuTimeout) => Err(ResponseFailure::CpuTimeout),
        Some(StopReason::WallTimeout) => Err(ResponseFailure::WallTimeout),
        Some(StopReason::CounterUnavailable) => Err(ResponseFailure::UnresolvedInfra),
        None => Ok(AcceptedUsage {
            cpu_usec: cpu_delta(baseline, frozen.usage_usec).map_err(|_| ResponseFailure::UnresolvedInfra)?,
            elapsed,
        }),
    }
}
