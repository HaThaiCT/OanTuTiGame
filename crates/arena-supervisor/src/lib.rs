//! Native execution-plane components; no workload launcher is exposed yet.
pub mod ipc;
pub mod cgroup;
pub mod watchdog;
pub mod control;
pub mod output;
pub mod session;
pub mod reaper;
pub mod response;
pub mod sandbox;

pub use arena_execution as execution;
