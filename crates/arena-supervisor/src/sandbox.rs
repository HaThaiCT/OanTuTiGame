//! Trusted development launcher. The operator-created OCI bundle MUST name the
//! supplied, empty workload cgroup in linux.cgroupsPath, including all runsc
//! sentry/gofer work. This is not an untrusted-manifest validation boundary.
use crate::cgroup::CgroupSnapshot;
use crate::control::CgroupControl;
use crate::response::{accept_frozen_response, ResponseFailure};
use crate::watchdog::{Budget, StopReason, Watchdog};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const RUNSC: &str = "/usr/local/libexec/oantuti/gvisor-20261005.0/runsc";
const TRANSITION: Duration = Duration::from_secs(1);
const CLEANUP: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(1);
const LINE_MAX: usize = 16 * 1024;
const STDOUT_MAX: usize = 1024 * 1024;
const COMBINED_MAX: usize = 2 * 1024 * 1024;
const STDERR_MAX: usize = 64 * 1024;
const REQUEST_MAX: usize = 256 * 1024;

pub struct Observation {
    /// One UTF-8 NDJSON wire line, including its LF delimiter.
    pub response: Vec<u8>,
    pub cpu_usec: u64,
    pub wall_usec: u64,
}

#[derive(Debug)]
pub enum BotOutputFault { OutputLimit, ProtocolViolation }

impl std::fmt::Display for BotOutputFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self { Self::OutputLimit => "Bot output limit", Self::ProtocolViolation => "Bot output protocol violation" })
    }
}
impl std::error::Error for BotOutputFault {}

struct Shared {
    stop: AtomicBool,
    combined: AtomicUsize,
    failure: AtomicU8,
    alarm: AtomicU8,
    kill_failed: AtomicBool,
}

impl Shared {
    fn fail(&self, code: u8) {
        let _ = self.failure.compare_exchange(0, code, Ordering::AcqRel, Ordering::Acquire);
    }

    fn error(&self) -> Option<io::Error> {
        let alarm = self.alarm.load(Ordering::Acquire);
        if self.kill_failed.load(Ordering::Acquire) {
            return Some(io::Error::other("watchdog could not confirm workload termination"));
        }
        if alarm != 0 {
            return Some(if alarm == 3 {
                io::Error::other("watchdog cgroup accounting unavailable")
            } else {
                io::Error::new(io::ErrorKind::TimedOut, if alarm == 1 { "Bot CPU deadline exceeded" } else { "Bot wall deadline exceeded" })
            });
        }
        match self.failure.load(Ordering::Acquire) {
            0 => None,
            1 => Some(io::Error::new(io::ErrorKind::InvalidData, BotOutputFault::OutputLimit)),
            2 => Some(io::Error::new(io::ErrorKind::InvalidData, BotOutputFault::ProtocolViolation)),
            3 => Some(io::Error::other("Bot output pipe read failed")),
            _ => Some(io::Error::new(io::ErrorKind::UnexpectedEof, "Bot stdout closed before a complete response")),
        }
    }
}

struct Attempt {
    watchdog: Watchdog,
    started: Instant,
    baseline: u64,
    budget: Budget,
}

pub struct Sandbox {
    state: PathBuf,
    id: String,
    cgroup: PathBuf,
    control: CgroupControl,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<Vec<u8>>,
    readers: Vec<JoinHandle<()>>,
    shared: Arc<Shared>,
    attempt: Option<Attempt>,
    first: bool,
    runtime_created: bool,
    stopped: bool,
}

fn command(state: &Path) -> Command {
    let mut command = Command::new(RUNSC);
    command.arg("--root").arg(state)
        .args(["--network=none", "--overlay2=none", "--platform=systrap",
            "--gofer-network-namespace=new", "--host-settings=check", "--host-uds=none",
            "--host-fifo=none", "--sidecar-usage-policy=STRICT",
            "--sidecar-release-enforcement-policy=ALWAYS"])
        .env_clear().env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin").env("LANG", "C").current_dir("/");
    command
}

// Linux pipe descriptors only; preserve the other file status flags.
fn nonblocking(fd: &impl AsRawFd) -> io::Result<()> {
    unsafe extern "C" { fn fcntl(fd: i32, cmd: i32, ...) -> i32; }
    let flags = unsafe { fcntl(fd.as_raw_fd(), 3) };
    if flags < 0 || unsafe { fcntl(fd.as_raw_fd(), 4, flags | 0x800) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn read_output(mut pipe: impl Read, stdout: bool, shared: Arc<Shared>, sender: mpsc::SyncSender<Vec<u8>>) {
    let mut bytes = [0_u8; 4096];
    let mut stdout_bytes = 0;
    let mut line = Vec::with_capacity(LINE_MAX);
    let mut stderr = Vec::new();
    while !shared.stop.load(Ordering::Acquire) {
        let count = match pipe.read(&mut bytes) {
            Ok(0) => {
                if stdout { shared.fail(if line.is_empty() { 4 } else { 2 }); }
                return;
            }
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => { thread::sleep(POLL); continue; }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => { shared.fail(3); return; }
        };
        // At most two readers add one bounded read beyond the combined cap.
        let previous = shared.combined.fetch_add(count, Ordering::AcqRel);
        if previous > COMBINED_MAX.saturating_sub(count) { shared.fail(1); return; }
        if !stdout {
            let retain = count.min(STDERR_MAX - stderr.len());
            stderr.extend_from_slice(&bytes[..retain]);
            continue;
        }
        stdout_bytes += count;
        if stdout_bytes > STDOUT_MAX { shared.fail(1); return; }
        for byte in &bytes[..count] {
            if line.len() == LINE_MAX { shared.fail(1); return; }
            line.push(*byte);
            if *byte == b'\n' {
                if std::str::from_utf8(&line).is_err() { shared.fail(2); return; }
                let mut response = std::mem::replace(&mut line, Vec::with_capacity(LINE_MAX));
                loop {
                    match sender.try_send(response) {
                        Ok(()) => break,
                        Err(mpsc::TrySendError::Disconnected(_)) => return,
                        Err(mpsc::TrySendError::Full(returned)) => response = returned,
                    }
                    if shared.stop.load(Ordering::Acquire) { return; }
                    thread::sleep(POLL);
                }
            }
        }
    }
}

fn reap(child: &mut Child, kill: bool) -> io::Result<()> {
    if child.try_wait()?.is_some() { return Ok(()); }
    if kill { child.kill()?; }
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() { return Ok(()); }
        if started.elapsed() >= CLEANUP {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "runsc process did not terminate"));
        }
        thread::sleep(POLL);
    }
}

impl Sandbox {
    pub fn launch(bundle: &Path, state: &Path, id: &str, cgroup: &Path) -> io::Result<Self> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid trusted container id"));
        }
        let mut control = CgroupControl::open(cgroup)?;
        let snapshot = control.freeze(TRANSITION)?;
        if snapshot.populated {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "workload cgroup must start empty"));
        }
        let shared = Arc::new(Shared { stop: AtomicBool::new(false), combined: AtomicUsize::new(0), failure: AtomicU8::new(0), alarm: AtomicU8::new(0), kill_failed: AtomicBool::new(false) });
        let (sender, responses) = mpsc::sync_channel(1);
        let mut sandbox = Self {
            state: state.to_owned(), id: id.to_owned(), cgroup: cgroup.to_owned(), control,
            child: None, stdin: None, responses, readers: Vec::new(), shared,
            attempt: None, first: true, runtime_created: false, stopped: false,
        };
        // The startup deadline includes runsc spawn/setup, not just the first write.
        sandbox.attempt = Some(sandbox.arm(snapshot.usage_usec, true)?);
        let mut child = command(state).arg("run").arg("--bundle").arg(bundle).arg(id)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        sandbox.runtime_created = true;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        sandbox.child = Some(child);
        let stdin = stdin.ok_or_else(|| io::Error::other("missing runsc stdin"))?;
        let stdout = stdout.ok_or_else(|| io::Error::other("missing runsc stdout"))?;
        let stderr = stderr.ok_or_else(|| io::Error::other("missing runsc stderr"))?;
        nonblocking(&stdin)?;
        nonblocking(&stdout)?;
        nonblocking(&stderr)?;
        sandbox.stdin = Some(stdin);
        let shared = Arc::clone(&sandbox.shared);
        let stdout_sender = sender.clone();
        sandbox.readers.push(thread::Builder::new().name("arena-stdout".into()).spawn(move || read_output(stdout, true, shared, stdout_sender))?);
        let shared = Arc::clone(&sandbox.shared);
        sandbox.readers.push(thread::Builder::new().name("arena-stderr".into()).spawn(move || read_output(stderr, false, shared, sender))?);
        Ok(sandbox)
    }

    fn arm(&self, baseline: u64, startup: bool) -> io::Result<Attempt> {
        let mut killer = CgroupControl::open(&self.cgroup)?;
        let shared = Arc::clone(&self.shared);
        let budget = Budget { cpu_usec: if startup { 500_000 } else { 100_000 }, wall: Duration::from_secs(1) };
        let started = Instant::now();
        let watchdog = Watchdog::arm(self.cgroup.clone(), baseline, started, budget, move |reason| {
            shared.alarm.store(match reason { StopReason::CpuTimeout => 1, StopReason::WallTimeout => 2, StopReason::CounterUnavailable => 3 }, Ordering::Release);
            if killer.kill_and_wait(CLEANUP).is_err() { shared.kill_failed.store(true, Ordering::Release); }
        })?;
        Ok(Attempt { watchdog, started, baseline, budget })
    }

    pub fn exchange(&mut self, request: &[u8], startup: bool) -> io::Result<Observation> {
        let result = self.exchange_inner(request, startup);
        if result.is_err() {
            // A cleanup failure is infrastructure failure, never a fabricated Bot loss.
            self.stop()?;
        }
        result
    }

    fn exchange_inner(&mut self, request: &[u8], startup: bool) -> io::Result<Observation> {
        if self.stopped || startup != self.first {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid sandbox exchange lifecycle"));
        }
        if request.len() > REQUEST_MAX || !request.ends_with(b"\n") {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "request must be bounded NDJSON"));
        }
        if !self.first {
            let baseline = self.control.freeze(TRANSITION)?.usage_usec;
            self.attempt = Some(self.arm(baseline, false)?);
        }
        self.first = false;
        if let Some(error) = self.shared.error() { return Err(error); }
        self.control.unfreeze(TRANSITION)?;
        let started = self.attempt.as_ref().ok_or_else(|| io::Error::other("missing attempt watchdog"))?.started;
        let mut written = 0;
        while written < request.len() {
            self.check_deadline(started)?;
            let stdin = self.stdin.as_mut().ok_or_else(|| io::Error::other("runsc stdin unavailable"))?;
            match stdin.write(&request[written..]) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "runsc stdin closed")),
                Ok(count) => written += count,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
                Err(error) => return Err(error),
            }
        }
        let response = loop {
            self.check_deadline(started)?;
            match self.responses.recv_timeout(POLL) {
                Ok(response) => break response,
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "response reader stopped")),
            }
        };
        let frozen: CgroupSnapshot = self.control.freeze(TRANSITION)?;
        let elapsed = started.elapsed();
        let attempt = self.attempt.take().ok_or_else(|| io::Error::other("missing attempt watchdog"))?;
        let accepted = accept_frozen_response(attempt.baseline, &frozen, elapsed, attempt.budget);
        attempt.watchdog.finish().map_err(|_| io::Error::other("watchdog thread panicked"))?;
        if let Some(error) = self.shared.error() { return Err(error); }
        let usage = accepted.map_err(|failure| match failure {
            ResponseFailure::CpuTimeout | ResponseFailure::WallTimeout => io::Error::new(io::ErrorKind::TimedOut, "response exceeded resource budget"),
            ResponseFailure::UnresolvedInfra => io::Error::other("frozen response accounting unavailable"),
        })?;
        Ok(Observation { response, cpu_usec: usage.cpu_usec, wall_usec: usage.elapsed.as_micros().min(u64::MAX as u128) as u64 })
    }

    fn check_deadline(&self, started: Instant) -> io::Result<()> {
        if let Some(error) = self.shared.error() { return Err(error); }
        if started.elapsed() >= Duration::from_secs(1) {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "Bot wall deadline exceeded"));
        }
        Ok(())
    }

    pub fn stop(&mut self) -> io::Result<()> {
        if self.stopped { return Ok(()); }
        self.shared.stop.store(true, Ordering::Release);
        self.stdin.take();
        // Kill independently of the alarm, then cancel/join its finite callback.
        let mut failure = self.control.kill_and_wait(CLEANUP).err();
        if let Some(attempt) = self.attempt.take() {
            if attempt.watchdog.finish().is_err() && failure.is_none() {
                failure = Some(io::Error::other("watchdog thread panicked"));
            }
        }
        for reader in self.readers.drain(..) {
            if reader.join().is_err() && failure.is_none() { failure = Some(io::Error::other("output reader panicked")); }
        }
        if let Some(child) = &mut self.child {
            if let Err(error) = reap(child, true) { if failure.is_none() { failure = Some(error); } }
        }
        if self.runtime_created {
            match command(&self.state).args(["delete", "--force"]).arg(&self.id)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
                Ok(mut delete) => {
                    match reap(&mut delete, false) {
                        Ok(()) => match delete.try_wait() {
                            Ok(Some(status)) if status.success() => self.runtime_created = false,
                            Ok(_) => { if failure.is_none() { failure = Some(io::Error::other("runsc delete failed")); } }
                            Err(error) => { if failure.is_none() { failure = Some(error); } }
                        },
                        Err(error) => { let _ = reap(&mut delete, true); if failure.is_none() { failure = Some(error); } }
                    }
                }
                Err(error) => { if failure.is_none() { failure = Some(error); } }
            }
        }
        // runsc may have entered the workload cgroup after the initial kill.
        // Confirm emptiness again after both launcher and runtime cleanup.
        if self.cgroup.exists() {
            if let Err(error) = self.control.kill_and_wait(CLEANUP) {
                if failure.is_none() { failure = Some(error); }
            }
        }
        self.stopped = failure.is_none();
        match failure { Some(error) => Err(error), None => Ok(()) }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) { let _ = self.stop(); }
}
