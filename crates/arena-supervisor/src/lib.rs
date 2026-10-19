//! Native execution-plane components. `worker` is the trusted workload consumer that turns a
//! broker GAME lease into a measured, supervised attempt; it is only built where the broker
//! transport and the sandbox launcher exist (Linux).
pub mod ipc;
pub mod cgroup;
pub mod watchdog;
pub mod control;
pub mod output;
pub mod session;
pub mod reaper;
pub mod response;
pub mod sandbox;
#[cfg(target_os = "linux")]
pub mod broker;
#[cfg(target_os = "linux")]
pub mod materialize;
#[cfg(target_os = "linux")]
pub mod worker;

pub use arena_execution as execution;
