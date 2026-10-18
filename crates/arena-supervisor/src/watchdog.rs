//! Independent alarm thread. The terminal callback must freeze/kill through the
//! lifecycle controller; an alarm alone is not enforcement or readiness proof.
use crate::cgroup::{cpu_delta, CgroupSnapshot};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct Budget {
    pub cpu_usec: u64,
    pub wall: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    CpuTimeout,
    WallTimeout,
    CounterUnavailable,
}

pub fn evaluate(baseline: u64, current: u64, elapsed: Duration, budget: Budget) -> Option<StopReason> {
    let used = match cpu_delta(baseline, current) {
        Ok(used) => used,
        Err(_) => return Some(StopReason::CounterUnavailable),
    };
    if used > budget.cpu_usec {
        Some(StopReason::CpuTimeout)
    } else if elapsed >= budget.wall {
        Some(StopReason::WallTimeout)
    } else {
        None
    }
}

pub struct Watchdog {
    cancelled: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    pub fn arm(
        cgroup: PathBuf,
        baseline: u64,
        started: Instant,
        budget: Budget,
        terminal: impl FnOnce(StopReason) + Send + 'static,
    ) -> io::Result<Self> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let state = Arc::clone(&cancelled);
        let thread = thread::Builder::new().name("arena-watchdog".into()).spawn(move || {
            loop {
                if state.load(Ordering::Acquire) {
                    return;
                }
                let reason = match CgroupSnapshot::read(&cgroup) {
                    Ok(snapshot) => evaluate(baseline, snapshot.usage_usec, started.elapsed(), budget),
                    Err(_) => Some(StopReason::CounterUnavailable),
                };
                if let Some(reason) = reason {
                    // A concurrent finish may already have linearized cancellation.
                    if state.swap(true, Ordering::AcqRel) {
                        return;
                    }
                    terminal(reason);
                    return;
                }
                if state.load(Ordering::Acquire) {
                    return;
                }
                let remaining = budget.wall.saturating_sub(started.elapsed());
                thread::park_timeout(Duration::from_millis(1).min(remaining));
            }
        })?;
        Ok(Self { cancelled, thread: Some(thread) })
    }

    pub fn finish(mut self) -> thread::Result<()> {
        self.stop_and_join()
    }

    fn stop_and_join(&mut self) -> thread::Result<()> {
        self.cancelled.store(true, Ordering::Release);
        match self.thread.take() {
            Some(thread) => {
                thread.thread().unpark();
                thread.join()
            }
            None => Ok(()),
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        // Callback implementations must be finite and must not wait on this owner.
        let _ = self.stop_and_join();
    }
}
