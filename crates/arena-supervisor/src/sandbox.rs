//! Trusted launcher primitives: one `runsc` spawn site, two consumers.
//!
//! * The **Bot** mode (`Sandbox::launch` / `exchange`) drives the NDJSON Bot protocol with the
//!   freeze/counter/watchdog accounting the runner session and the server-side verifier expect.
//! * The **command** mode (`Sandbox::run_command`) runs exactly one operator-fixed command — the
//!   toolchain identity probe or the compile step of a build — to completion and reports its exit
//!   status plus a bounded diagnostic. Its bundle decides what runs; no path or argv comes from a
//!   payload.
//!
//! Both modes share the same launch lifecycle: validate the container id, open the delegated
//! cgroup, confirm it is empty, freeze it, arm the watchdog, spawn `runsc` **once**, and confirm
//! termination (cgroup empty, runtime deleted) on the way out. A launch, cgroup, counter or
//! termination fault is an `Err` and callers must treat it as infrastructure — never as a verdict
//! about a submission.
//!
//! The operator names the runtime path and every rootfs; nothing here guesses a default.
use crate::cgroup::CgroupSnapshot;
use crate::control::CgroupControl;
use crate::response::{accept_frozen_response, ResponseFailure};
use crate::watchdog::{Budget, StopReason, Watchdog};
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Longest cgroup transition the launcher will wait for.
pub const TRANSITION: Duration = Duration::from_secs(1);
const CLEANUP: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(1);
const LINE_MAX: usize = 16 * 1024;
const STDOUT_MAX: usize = 1024 * 1024;
const COMBINED_MAX: usize = 2 * 1024 * 1024;
const STDERR_MAX: usize = 64 * 1024;
const REQUEST_MAX: usize = 256 * 1024;
/// Longest diagnostic prefix a one-shot command may leave behind. The reader keeps draining (so the
/// command never blocks on a full pipe) but never retains more than this.
pub const COMMAND_DIAGNOSTIC_MAX: usize = 64 * 1024;

pub struct Observation {
    /// One UTF-8 NDJSON wire line, including its LF delimiter.
    pub response: Vec<u8>,
    pub cpu_usec: u64,
    pub wall_usec: u64,
}

/// What one operator command did inside the sandbox. Everything that is not a fact about the
/// command — a launch, cgroup, counter or termination fault — is an `Err` from `run_command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOutcome {
    /// The command ran and exited by itself. `status` is its exit status.
    Exited { status: i32, diagnostic: Vec<u8>, truncated: bool },
    /// The aggregate command cgroup exceeded the pinned compile CPU budget and was reaped.
    CpuExpired { diagnostic: Vec<u8>, truncated: bool },
    /// The command exceeded the wall limit and was killed; the workload is confirmed gone.
    WallExpired { diagnostic: Vec<u8>, truncated: bool },
    /// The command produced more output than the sandbox bounds and was killed.
    OutputLimit { diagnostic: Vec<u8> },
}

impl CommandOutcome {
    /// The retained diagnostic prefix, whatever the outcome.
    pub fn diagnostic(&self) -> &[u8] {
        match self {
            Self::Exited { diagnostic, .. } | Self::WallExpired { diagnostic, .. } | Self::CpuExpired { diagnostic, .. } => diagnostic,
            Self::OutputLimit { diagnostic } => diagnostic,
        }
    }
}

/// Startup/turn budgets a Bot workload is measured against.
///
/// `game()` is the contract the runner session and the server-side verifier enforce for a match. A
/// build smoke test instead uses the assignment's own INIT limits, so a build is never failed by a
/// bound the assignment did not declare.
#[derive(Clone, Copy)]
pub struct Budgets {
    pub startup: Budget,
    pub turn: Budget,
}

impl Budgets {
    pub const fn game() -> Self {
        Self {
            startup: Budget { cpu_usec: 500_000, wall: Duration::from_secs(1) },
            turn: Budget { cpu_usec: 100_000, wall: Duration::from_secs(1) },
        }
    }

    pub const fn init(cpu_usec: u64, wall: Duration) -> Self {
        Self { startup: Budget { cpu_usec, wall }, turn: Budget { cpu_usec: 100_000, wall: Duration::from_secs(1) } }
    }
}

#[derive(Debug)]
pub enum BotOutputFault { OutputLimit, ProtocolViolation }

impl std::fmt::Display for BotOutputFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self { Self::OutputLimit => "Bot output limit", Self::ProtocolViolation => "Bot output protocol violation" })
    }
}
impl std::error::Error for BotOutputFault {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeasuredFaultKind { CpuTimeout, WallTimeout, OutputLimit, ProtocolViolation }

impl MeasuredFaultKind {
    pub fn observation_kind(self) -> &'static str {
        match self { Self::CpuTimeout => "CPU_TIMEOUT", Self::WallTimeout => "WALL_TIMEOUT",
            Self::OutputLimit => "OUTPUT_LIMIT", Self::ProtocolViolation => "PROTOCOL_ERROR" }
    }
}

#[derive(Debug)]
pub struct MeasuredBotFault {
    pub kind: MeasuredFaultKind,
    pub cpu_usec: u64,
    pub wall_usec: u64,
}
impl std::fmt::Display for MeasuredBotFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "measured {}", self.kind.observation_kind()) }
}
impl std::error::Error for MeasuredBotFault {}

#[derive(Debug)]
pub struct CleanupFailure(pub String);
impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for CleanupFailure {}

struct Shared {
    stop: AtomicBool,
    combined: AtomicUsize,
    failure: AtomicU8,
    alarm: AtomicU8,
    kill_failed: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            combined: AtomicUsize::new(0),
            failure: AtomicU8::new(0),
            alarm: AtomicU8::new(0),
            kill_failed: AtomicBool::new(false),
        }
    }

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

/// Bounded diagnostic retention for a one-shot command.
struct Diagnostics {
    retained: Mutex<Vec<u8>>,
    truncated: AtomicBool,
}

impl Diagnostics {
    fn new() -> Self {
        Self { retained: Mutex::new(Vec::with_capacity(4096)), truncated: AtomicBool::new(false) }
    }

    fn retain(&self, bytes: &[u8]) {
        let mut retained = self.retained.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let room = COMMAND_DIAGNOSTIC_MAX.saturating_sub(retained.len());
        if room < bytes.len() {
            self.truncated.store(true, Ordering::Release);
        }
        retained.extend_from_slice(&bytes[..room.min(bytes.len())]);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.retained.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

enum Sink {
    Bot(mpsc::SyncSender<Vec<u8>>),
    Diagnostic(Arc<Diagnostics>),
}

struct ReaperGuard {
    stop: Arc<AtomicBool>,
    heartbeat: Option<JoinHandle<()>>,
    child: Child,
}

impl ReaperGuard {
    fn start(runsc: &Path, state: &Path, id: &str, cgroup: &Path) -> io::Result<Self> {
        let executable = std::env::current_exe()?.with_file_name("arena-reaper");
        let (mut writer, reader) = UnixStream::pair()?;
        writer.set_read_timeout(Some(CLEANUP))?;
        writer.set_write_timeout(Some(CLEANUP))?;
        let mut command = Command::new(executable);
        command.arg(runsc).arg(state).arg(id).arg(cgroup).env_clear()
            .stdin(Stdio::from(std::os::fd::OwnedFd::from(reader))).stdout(Stdio::null()).stderr(Stdio::inherit());
        // Separate session survives worker process-group death; CLOEXEC keeps the writer exclusive.
        unsafe { command.pre_exec(|| { if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) } }); }
        let child = command.spawn()?;
        let stop = Arc::new(AtomicBool::new(false));
        let mut guard = Self { stop: Arc::clone(&stop), heartbeat: None, child };
        let mut ready = [1];
        if let Err(error) = writer.read_exact(&mut ready) {
            drop(writer);
            guard.finish()?;
            return Err(error);
        }
        if ready != [0] {
            drop(writer);
            guard.finish()?;
            return Err(io::Error::other("reaper did not acknowledge readiness"));
        }
        guard.heartbeat = Some(thread::Builder::new().name("arena-reaper-heartbeat".into()).spawn(move || {
            while !stop.load(Ordering::Acquire) {
                if writer.write_all(&[0]).is_err() { break; }
                thread::sleep(Duration::from_millis(100));
            }
        })?);
        Ok(guard)
    }

    fn finish(&mut self) -> io::Result<()> {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.heartbeat.take() { let _ = thread.join(); }
        let started = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait()? {
                return if status.success() { Ok(()) } else { Err(io::Error::other(CleanupFailure("independent reaper cleanup failed".into()))) };
            }
            if started.elapsed() >= Duration::from_secs(8) {
                return Err(io::Error::other(CleanupFailure("independent reaper cleanup unconfirmed".into())));
            }
            thread::sleep(POLL);
        }
    }
}

impl Drop for ReaperGuard {
    fn drop(&mut self) { let _ = self.finish(); }
}

struct Attempt {
    watchdog: Watchdog,
    started: Instant,
    baseline: u64,
    budget: Budget,
}

/// The one and only place a `runsc` process is spawned, so the runtime arguments, the cleared
/// environment and the working directory can never diverge between the Bot path and the build path.
fn runtime_command(runsc: &Path, state: &Path) -> Command {
    let mut command = Command::new(runsc);
    command.arg("--root").arg(state)
        .args(["--rootless", "--network=none", "--overlay2=none", "--platform=systrap",
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

/// Bounded diagnostic reader: both pipes of a one-shot command feed the same counter and the same
/// retained prefix, and EOF is normal (the command exited) rather than a protocol failure.
fn read_diagnostic(mut pipe: impl Read, shared: Arc<Shared>, diagnostics: Arc<Diagnostics>) {
    let mut bytes = [0_u8; 4096];
    while !shared.stop.load(Ordering::Acquire) {
        match pipe.read(&mut bytes) {
            Ok(0) => return,
            Ok(count) => {
                let previous = shared.combined.fetch_add(count, Ordering::AcqRel);
                if previous > COMBINED_MAX.saturating_sub(count) { shared.fail(1); return; }
                diagnostics.retain(&bytes[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
            Err(_) => { shared.fail(3); return; }
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

fn validated_id(id: &str) -> io::Result<()> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid trusted container id"));
    }
    Ok(())
}

/// A workload cgroup that is confirmed empty and frozen, with the baseline every accounting path
/// needs. Nothing is spawned until [`Prepared::spawn`] is called, so the watchdog is always armed
/// before the runtime exists.
struct Prepared {
    runsc: PathBuf,
    bundle: PathBuf,
    state: PathBuf,
    id: String,
    cgroup: PathBuf,
    control: CgroupControl,
    baseline: u64,
    shared: Arc<Shared>,
}

impl Prepared {
    fn new(runsc: &Path, bundle: &Path, state: &Path, id: &str, cgroup: &Path) -> io::Result<Self> {
        validated_id(id)?;
        let mut control = CgroupControl::open(cgroup)?;
        let snapshot = control.freeze(TRANSITION)?;
        if snapshot.populated {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "workload cgroup must start empty"));
        }
        let document: serde_json::Value = serde_json::from_slice(&std::fs::read(bundle.join("config.json"))?)?;
        let memory = document["linux"]["resources"]["memory"]["limit"].as_u64();
        let limits = match memory {
            Some(268435456) => crate::control::WorkloadLimits::BOT,
            Some(1073741824) => crate::control::WorkloadLimits::COMPILE,
            _ => return Err(io::Error::other("unknown workload resource profile")),
        };
        limits.apply(cgroup)?;
        Ok(Self {
            runsc: runsc.to_owned(),
            bundle: bundle.to_owned(),
            state: state.to_owned(),
            id: id.to_owned(),
            cgroup: cgroup.to_owned(),
            control,
            baseline: snapshot.usage_usec,
            shared: Arc::new(Shared::new()),
        })
    }

    /// The single spawn site. Both consumers reach `runsc` exactly here.
    fn spawn(self, sink: Sink) -> io::Result<Runtime> {
        let Prepared { runsc, bundle, state, id, cgroup, control, baseline: _, shared } = self;
        let mut reaper = ReaperGuard::start(&runsc, &state, &id, &cgroup)?;
        let mut child = match runtime_command(&runsc, &state)
            .arg("run").arg("--bundle").arg(&bundle).arg(&id)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(child) => child,
            Err(error) => { reaper.finish()?; return Err(error); }
        };
        let mut runtime = Runtime {
            runsc,
            state,
            id,
            cgroup,
            control,
            child: None,
            stdin: None,
            readers: Vec::new(),
            shared: Arc::clone(&shared),
            created: true,
            reaper,
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        runtime.child = Some(child);
        let setup = (|| -> io::Result<()> {
        let stdin = stdin.ok_or_else(|| io::Error::other("missing runsc stdin"))?;
        let stdout = stdout.ok_or_else(|| io::Error::other("missing runsc stdout"))?;
        let stderr = stderr.ok_or_else(|| io::Error::other("missing runsc stderr"))?;
        nonblocking(&stdin)?;
        nonblocking(&stdout)?;
        nonblocking(&stderr)?;
        runtime.stdin = Some(stdin);
        match sink {
            Sink::Bot(sender) => {
                let shared = Arc::clone(&runtime.shared);
                let stdout_sender = sender.clone();
                runtime.readers.push(thread::Builder::new().name("arena-stdout".into()).spawn(move || read_output(stdout, true, shared, stdout_sender))?);
                let shared = Arc::clone(&runtime.shared);
                runtime.readers.push(thread::Builder::new().name("arena-stderr".into()).spawn(move || read_output(stderr, false, shared, sender))?);
            }
            Sink::Diagnostic(diagnostics) => {
                let shared = Arc::clone(&runtime.shared);
                let retained = Arc::clone(&diagnostics);
                runtime.readers.push(thread::Builder::new().name("arena-command-stdout".into()).spawn(move || read_diagnostic(stdout, shared, retained))?);
                let shared = Arc::clone(&runtime.shared);
                runtime.readers.push(thread::Builder::new().name("arena-command-stderr".into()).spawn(move || read_diagnostic(stderr, shared, diagnostics))?);
            }
        }
            Ok(())
        })();
        if let Err(error) = setup {
            runtime.teardown(true)?;
            return Err(error);
        }
        Ok(runtime)
    }
}

/// One launched container plus the accounting and termination lifecycle around it.
struct Runtime {
    runsc: PathBuf,
    state: PathBuf,
    id: String,
    cgroup: PathBuf,
    control: CgroupControl,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    readers: Vec<JoinHandle<()>>,
    shared: Arc<Shared>,
    created: bool,
    reaper: ReaperGuard,
}

impl Runtime {
    /// Stop the workload and confirm it is gone: cgroup empty, readers joined, runtime deleted and
    /// the cgroup confirmed empty again after the runtime's own cleanup.
    fn teardown(&mut self, kill: bool) -> io::Result<()> {
        self.shared.stop.store(true, Ordering::Release);
        self.stdin.take();
        let mut failure = self.control.kill_and_wait(CLEANUP).err();
        for reader in self.readers.drain(..) {
            if reader.join().is_err() && failure.is_none() {
                failure = Some(io::Error::other("output reader panicked"));
            }
        }
        if let Some(child) = &mut self.child {
            if let Err(error) = reap(child, kill) {
                if failure.is_none() { failure = Some(error); }
            }
        }
        if self.created {
            match runtime_command(&self.runsc, &self.state).args(["delete", "--force"]).arg(&self.id)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
                Ok(mut delete) => {
                    match reap(&mut delete, false) {
                        Ok(()) => match delete.try_wait() {
                            Ok(Some(status)) if status.success() => self.created = false,
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
            if let Err(error) = self.control.freeze(CLEANUP) {
                if failure.is_none() { failure = Some(error); }
            }
        }
        if let Err(error) = self.reaper.finish() { failure = Some(error); }
        match failure { Some(error) => Err(io::Error::other(CleanupFailure(error.to_string()))), None => Ok(()) }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) { let _ = self.teardown(true); }
}

/// Arm the independent alarm thread. The callback kills through the lifecycle controller; an alarm
/// alone is never enforcement. Arming before the runtime exists is what makes a hung runtime setup
/// recoverable.
fn arm_watchdog(cgroup: &Path, baseline: u64, started: Instant, budget: Budget, shared: Arc<Shared>) -> io::Result<Watchdog> {
    let mut killer = CgroupControl::open(cgroup)?;
    Watchdog::arm(cgroup.to_owned(), baseline, started, budget, move |reason| {
        shared.alarm.store(match reason { StopReason::CpuTimeout => 1, StopReason::WallTimeout => 2, StopReason::CounterUnavailable => 3 }, Ordering::Release);
        if killer.kill_and_wait(CLEANUP).is_err() { shared.kill_failed.store(true, Ordering::Release); }
    })
}

pub struct Sandbox {
    runtime: Runtime,
    responses: mpsc::Receiver<Vec<u8>>,
    attempt: Option<Attempt>,
    budgets: Budgets,
    first: bool,
    stopped: bool,
}

impl Sandbox {
    /// Launch one Bot workload from an operator-built bundle, measured against `budgets`.
    pub fn launch(runsc: &Path, bundle: &Path, state: &Path, id: &str, cgroup: &Path, budgets: Budgets) -> io::Result<Self> {
        let prepared = Prepared::new(runsc, bundle, state, id, cgroup)?;
        let (sender, responses) = mpsc::sync_channel(1);
        // The startup deadline includes runsc spawn/setup, not just the first write.
        let started = Instant::now();
        let baseline = prepared.baseline;
        let watchdog = arm_watchdog(cgroup, baseline, started, budgets.startup, Arc::clone(&prepared.shared))?;
        let runtime = prepared.spawn(Sink::Bot(sender))?;
        Ok(Self {
            runtime,
            responses,
            attempt: Some(Attempt { watchdog, started, baseline, budget: budgets.startup }),
            budgets,
            first: true,
            stopped: false,
        })
    }

    fn command_budget(wall: Duration) -> Budget {
        Budget { cpu_usec: 10_000_000, wall }
    }

    /// Run one operator-fixed command inside the operator's toolchain rootfs and report what it did.
    ///
    /// A returned `Ok` is a fact about the command; a returned `Err` is always an infrastructure
    /// fault (launch, cgroup, counter, termination), which callers must never turn into evidence.
    pub fn run_command(runsc: &Path, bundle: &Path, state: &Path, id: &str, cgroup: &Path, wall: Duration) -> io::Result<CommandOutcome> {
        let prepared = Prepared::new(runsc, bundle, state, id, cgroup)?;
        let baseline = prepared.baseline;
        let diagnostics = Arc::new(Diagnostics::new());
        let started = Instant::now();
        // Aggregate CPU is measured from the frozen cgroup baseline, including compiler children.
        let watchdog = arm_watchdog(cgroup, prepared.baseline, started, Self::command_budget(wall), Arc::clone(&prepared.shared))?;
        let mut runtime = prepared.spawn(Sink::Diagnostic(Arc::clone(&diagnostics)))?;

        let mut populated = false;
        let mut exit: Option<ExitStatus> = None;
        let mut fault = runtime.control.unfreeze(TRANSITION).err();
        if fault.is_none() {
            loop {
                match CgroupSnapshot::read(&runtime.cgroup) {
                    Ok(snapshot) => populated |= snapshot.populated,
                    Err(error) => { fault = Some(error); break; }
                }
                match runtime.child.as_mut().map(Child::try_wait) {
                    Some(Ok(Some(status))) => { exit = Some(status); break; }
                    Some(Ok(None)) => {}
                    Some(Err(error)) => { fault = Some(error); break; }
                    None => { fault = Some(io::Error::other("container process vanished")); break; }
                }
                // The watchdog kills at the wall limit; this is only the backstop for a runtime that
                // refuses to die, and it is an infrastructure fault, not a verdict.
                if started.elapsed() >= wall.saturating_add(CLEANUP) {
                    fault = Some(io::Error::other("command did not terminate after the wall limit"));
                    break;
                }
                thread::sleep(POLL);
            }
        }
        let alarm = runtime.shared.alarm.load(Ordering::Acquire);
        let failure = runtime.shared.failure.load(Ordering::Acquire);
        let kill_failed = runtime.shared.kill_failed.load(Ordering::Acquire);
        if watchdog.finish().is_err() && fault.is_none() {
            fault = Some(io::Error::other("watchdog thread panicked"));
        }
        // Close the gap between the final watchdog sample and a short command's exit.
        let terminal_cpu = runtime.control.freeze(TRANSITION).and_then(|snapshot| {
            snapshot.usage_usec.checked_sub(baseline)
                .ok_or_else(|| io::Error::other("command CPU counter regressed"))
        });
        let diagnostic = diagnostics.snapshot();
        let truncated = diagnostics.truncated.load(Ordering::Acquire);
        let teardown = runtime.teardown(true);
        // Termination must be confirmed before any outcome is reported.
        teardown?;
        if let Some(error) = fault { return Err(error); }
        if kill_failed {
            return Err(io::Error::other(CleanupFailure("watchdog could not confirm workload termination".into())));
        }
        let cpu_expired = terminal_cpu? > Self::command_budget(wall).cpu_usec;
        if cpu_expired { return Ok(CommandOutcome::CpuExpired { diagnostic, truncated }); }
        match alarm {
            // A counter the accounting path cannot read is never attributed to the command.
            3 => return Err(io::Error::other("cgroup accounting unavailable during the command")),
            1 => return Ok(CommandOutcome::CpuExpired { diagnostic, truncated }),
            2 => return Ok(CommandOutcome::WallExpired { diagnostic, truncated }),
            _ => {}
        }
        match failure {
            1 => return Ok(CommandOutcome::OutputLimit { diagnostic }),
            3 => return Err(io::Error::other("command output pipe read failed")),
            _ => {}
        }
        let Some(exit) = exit else {
            return Err(io::Error::other("command did not report an exit status"));
        };
        match exit.code() {
            // A runtime that never populated the cgroup never started the container: that is a
            // launcher fault, not a failing command.
            Some(status) if populated || status == 0 => Ok(CommandOutcome::Exited { status, diagnostic, truncated }),
            Some(_) => Err(io::Error::other("the sandbox never started the command")),
            None => Err(io::Error::other("the container process was terminated by a signal")),
        }
    }

    fn arm(&self, baseline: u64, startup: bool) -> io::Result<Attempt> {
        let budget = if startup { self.budgets.startup } else { self.budgets.turn };
        let started = Instant::now();
        let watchdog = arm_watchdog(&self.runtime.cgroup, baseline, started, budget, Arc::clone(&self.runtime.shared))?;
        Ok(Attempt { watchdog, started, baseline, budget })
    }

    pub fn exchange(&mut self, request: &[u8], startup: bool) -> io::Result<Observation> {
        match self.exchange_inner(request, startup) {
            Ok(observation) => Ok(observation),
            Err(error) => {
                let kind = match (self.runtime.shared.alarm.load(Ordering::Acquire), self.runtime.shared.failure.load(Ordering::Acquire)) {
                    (1, _) => Some(MeasuredFaultKind::CpuTimeout),
                    (2, _) => Some(MeasuredFaultKind::WallTimeout),
                    (3, _) => None,
                    (_, 1) => Some(MeasuredFaultKind::OutputLimit),
                    (_, 2) => Some(MeasuredFaultKind::ProtocolViolation),
                    _ => error.get_ref().and_then(|cause| cause.downcast_ref::<MeasuredBotFault>()).map(|fault| fault.kind),
                };
                let measured = (|| -> io::Result<Option<MeasuredBotFault>> {
                    if self.runtime.shared.kill_failed.load(Ordering::Acquire) {
                        return Err(io::Error::other(CleanupFailure("watchdog cleanup unconfirmed".into())));
                    }
                    if let (Some(kind), Some(attempt)) = (kind, self.attempt.as_ref()) {
                        let snapshot = self.runtime.control.freeze(TRANSITION)?;
                        let cpu_usec = snapshot.usage_usec.checked_sub(attempt.baseline)
                            .ok_or_else(|| io::Error::other("CPU counter regressed"))?;
                        Ok(Some(MeasuredBotFault { kind, cpu_usec, wall_usec: attempt.started.elapsed().as_micros().min(u64::MAX as u128) as u64 }))
                    } else { Ok(None) }
                })();
                self.stop().map_err(|failure| io::Error::other(CleanupFailure(failure.to_string())))?;
                match measured? { Some(fault) => Err(io::Error::other(fault)), None => Err(error) }
            }
        }
    }

    fn exchange_inner(&mut self, request: &[u8], startup: bool) -> io::Result<Observation> {
        if self.stopped || startup != self.first {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid sandbox exchange lifecycle"));
        }
        if request.len() > REQUEST_MAX || !request.ends_with(b"\n") {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "request must be bounded NDJSON"));
        }
        if !self.first {
            let baseline = self.runtime.control.freeze(TRANSITION)?.usage_usec;
            self.attempt = Some(self.arm(baseline, false)?);
        }
        self.first = false;
        if let Some(error) = self.runtime.shared.error() { return Err(error); }
        self.runtime.control.unfreeze(TRANSITION)?;
        let started = self.attempt.as_ref().ok_or_else(|| io::Error::other("missing attempt watchdog"))?.started;
        let mut written = 0;
        while written < request.len() {
            self.check_deadline(started)?;
            let stdin = self.runtime.stdin.as_mut().ok_or_else(|| io::Error::other("runsc stdin unavailable"))?;
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
        let frozen: CgroupSnapshot = self.runtime.control.freeze(TRANSITION)?;
        let elapsed = started.elapsed();
        let attempt = self.attempt.take().ok_or_else(|| io::Error::other("missing attempt watchdog"))?;
        let accepted = accept_frozen_response(attempt.baseline, &frozen, elapsed, attempt.budget);
        attempt.watchdog.finish().map_err(|_| io::Error::other("watchdog thread panicked"))?;
        if let Some(error) = self.runtime.shared.error() {
            let kind = match (self.runtime.shared.alarm.load(Ordering::Acquire), self.runtime.shared.failure.load(Ordering::Acquire)) {
                (1, _) => Some(MeasuredFaultKind::CpuTimeout), (2, _) => Some(MeasuredFaultKind::WallTimeout),
                (3, _) => None, (_, 1) => Some(MeasuredFaultKind::OutputLimit),
                (_, 2) => Some(MeasuredFaultKind::ProtocolViolation), _ => None,
            };
            if !self.runtime.shared.kill_failed.load(Ordering::Acquire) {
                if let Some(kind) = kind {
                    let cpu_usec = frozen.usage_usec.checked_sub(attempt.baseline).ok_or_else(|| io::Error::other("CPU counter regressed"))?;
                    return Err(io::Error::other(MeasuredBotFault { kind, cpu_usec, wall_usec: elapsed.as_micros().min(u64::MAX as u128) as u64 }));
                }
            }
            return Err(error);
        }
        let usage = accepted.map_err(|failure| match failure {
            ResponseFailure::CpuTimeout | ResponseFailure::WallTimeout => io::Error::other(MeasuredBotFault {
                kind: if failure == ResponseFailure::CpuTimeout { MeasuredFaultKind::CpuTimeout } else { MeasuredFaultKind::WallTimeout },
                cpu_usec: frozen.usage_usec.saturating_sub(attempt.baseline),
                wall_usec: elapsed.as_micros().min(u64::MAX as u128) as u64,
            }),
            ResponseFailure::UnresolvedInfra => io::Error::other("frozen response accounting unavailable"),
        })?;
        Ok(Observation { response, cpu_usec: usage.cpu_usec, wall_usec: usage.elapsed.as_micros().min(u64::MAX as u128) as u64 })
    }

    fn check_deadline(&self, started: Instant) -> io::Result<()> {
        if let Some(error) = self.runtime.shared.error() { return Err(error); }
        if self.attempt.as_ref().is_some_and(|attempt| started.elapsed() >= attempt.budget.wall) {
            return Err(io::Error::other(MeasuredBotFault { kind: MeasuredFaultKind::WallTimeout,
                cpu_usec: 0, wall_usec: started.elapsed().as_micros().min(u64::MAX as u128) as u64 }));
        }
        Ok(())
    }

    pub fn stop(&mut self) -> io::Result<()> {
        if self.stopped { return Ok(()); }
        let mut failure = self.runtime.teardown(true).err();
        if let Some(attempt) = self.attempt.take() {
            if attempt.watchdog.finish().is_err() && failure.is_none() {
                failure = Some(io::Error::other("watchdog thread panicked"));
            }
        }
        self.stopped = failure.is_none();
        match failure { Some(error) => Err(error), None => Ok(()) }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) { let _ = self.stop(); }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    #[test]
    fn command_cpu_budget_is_pinned_and_enforced_at_the_boundary() {
        let budget = Sandbox::command_budget(Duration::from_secs(30));
        assert_eq!(budget.cpu_usec, 10_000_000);
        let snapshot = |usage_usec| CgroupSnapshot { usage_usec, frozen: true, populated: true };
        assert!(accept_frozen_response(123, &snapshot(10_000_123), Duration::from_secs(1), budget).is_ok());
        assert!(matches!(accept_frozen_response(123, &snapshot(10_000_124), Duration::from_secs(1), budget), Err(ResponseFailure::CpuTimeout)));
    }
    #[test]
    fn runtime_uses_rootless_without_ignoring_cgroups() {
        let command = runtime_command(Path::new("/runsc"), Path::new("/state"));
        let args: Vec<_> = command.get_args().collect();
        assert!(args.contains(&std::ffi::OsStr::new("--rootless")));
        assert!(!args.contains(&std::ffi::OsStr::new("--ignore-cgroups")));
    }
}

