//! Run in a process outside the supervisor's workload/kill domain. The trusted
//! launcher must keep the heartbeat writer exclusive to the supervisor; inherited
//! writers would mask its death. Cleanup must kill and confirm the owned cgroup.
use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReapCause { Disconnected, LeaseExpired, InvalidHeartbeat, TransportFailure }

pub fn monitor(
    mut heartbeat: UnixStream,
    lease: Duration,
    cleanup: impl FnOnce() -> io::Result<()>,
) -> io::Result<ReapCause> {
    let mut deadline = Instant::now().checked_add(lease)
        .filter(|_| !lease.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid reaper lease"))?;
    let mut byte = [0_u8; 1];
    let cause = loop {
        let now = Instant::now();
        if now >= deadline { break ReapCause::LeaseExpired; }
        // Accepted streams must be dedicated blocking descriptors, not aliases
        // of the supervisor's nonblocking event-loop socket.
        if heartbeat.set_read_timeout(Some(deadline - now)).is_err() {
            break ReapCause::TransportFailure;
        }
        match heartbeat.read(&mut byte) {
            Ok(0) => break ReapCause::Disconnected,
            Ok(_) if byte[0] != 0 => break ReapCause::InvalidHeartbeat,
            Ok(_) => {
                let received = Instant::now();
                if received >= deadline { break ReapCause::LeaseExpired; }
                deadline = received.checked_add(lease).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "reaper deadline overflow"))?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => {
                if Instant::now() >= deadline { break ReapCause::LeaseExpired; }
                // A nonblocking descriptor violates the launch contract. Do not
                // busy-spin or keep the workload alive without valid heartbeats.
                break ReapCause::TransportFailure;
            }
            Err(_) => break ReapCause::TransportFailure,
        }
    };
    cleanup()?;
    Ok(cause)
}
