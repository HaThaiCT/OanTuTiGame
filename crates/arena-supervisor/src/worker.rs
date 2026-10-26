//! Native workload consumer for official GAME, private TEST_GAME and BUILD/TEST_BUILD jobs.
//!
//! One pass of this module is **claim → validate → materialize → run → prepare → complete**, with
//! a fail-closed branch at every step:
//!
//! * `claim` asks the trusted broker gateway for a lease with the operator's slot maxima and
//!   runtime profile; a claim with no assignable work is `None`, not an error. The job types it
//!   offers are exactly the ones it has slots for.
//! * `validate` recomputes the manifest digest, re-hashes every granted file and proves the whole
//!   assignment before any byte reaches the disk (`materialize::parse_assignment` /
//!   `materialize::parse_build_assignment`).
//! * `materialize` writes a fresh per-attempt workspace with mode 0700 plus the OCI bundles that
//!   name the operator's delegated cgroup, then verifies what it wrote.
//! * GAME/TEST_GAME: `play` drives the match through the engine's own session machinery
//!   (`arena_runner::session`) over an in-process bridge that turns every `RunBotTurn` into one
//!   measured Sandbox exchange, records exactly one observation per Bot response and submits only
//!   what the engine's verdict and the sandbox's counters agree on. A private test is the same
//!   match against control-plane-pinned Bots and submits the same evidence shape; the worker adds
//!   nothing about the opponent or the board, which only the control plane pinned.
//! * BUILD/TEST_BUILD: the operator's own toolchain commands run *inside the sandbox* — the
//!   identity probe, the compile step — followed by the same INIT smoke test the dev pipeline
//!   applies. The artifact's digest and size are read back from the output directory by the worker.
//!
//! Fail-closed rules:
//!
//! * A missing runsc, an unusable cgroup, a missing rootfs, an invalid assignment or an
//!   unverifiable digest aborts the attempt with a structured error and **no** completion; the
//!   lease is left to the broker's reconciler.
//! * A sandbox/cgroup/counter/termination fault is infrastructure: it never becomes evidence about
//!   a submission. A compile failure, an INIT that cannot greet, a measured protocol violation and
//!   a budget overrun are verdicts (`SOURCE_REJECTED`) carrying the stage that decided them.
//! * The worker never invents an artifact digest or size: both are computed from the bytes it read
//!   itself, and those bytes are uploaded through `stageArtifact` before any completion is prepared.
//!
//! Operator prerequisites that do not exist on every host (a separate worker uid, a delegated
//! cgroup, a verified runsc, the toolchain rootfs images and the artifact output root) are
//! **required configuration**: nothing here falls back to a guessed path or an unsandboxed
//! shortcut, and a missing prerequisite fails closed.

use crate::broker::BrokerClient;
use crate::materialize::{
    artifact_key, materialize, materialize_build, parse_assignment, parse_build_assignment,
    sanitize_diagnostic, Assignment, BotLayout, BuildAssignment, BuildLayout, Language,
    MaterializeError, MaterializedAttempt, MaterializedBuild, Toolchain, ARTIFACT_NAME,
    MAX_ARTIFACT_BYTES, MAX_SOURCE_BYTES,
};
use crate::sandbox::{BotOutputFault, Budgets, CleanupFailure, CommandOutcome, MeasuredBotFault, Sandbox};
use arena_execution::{
    envelope::Message, Envelope, ExecutionFault, RunBotTurn, StartGame, TurnObservation,
};
use arena_runner::session::{open_session, run_started_session, OpenOutcome, SessionError};
use prost::Message as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Execution wire version (`packages/protocol/proto/execution.proto`).
pub const PROTOCOL_VERSION: u32 = 2;
/// Lease TTL is 30 s; two beats may be lost, so the worker beats every 5 s.
pub const LEASE_HEARTBEAT_SECONDS: u64 = 5;
/// The broker's own frame bound for `BrokerClient` traffic.
const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// `TurnObservation` payload bound for a single Bot response line.
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
/// Decoded payload a single `stageArtifact` frame carries.
const STAGE_CHUNK_BYTES: usize = 512 * 1024;
/// Wall bound of the toolchain identity probe: a bound on the operator's own command, never an
/// assignment limit.
const PROBE_WALL: Duration = Duration::from_secs(5);
/// The turn bound the synthetic INIT smoke board advertises.
const SMOKE_MAX_TURNS: u32 = 300;
/// Reason codes the server-side verifier accepts for a measured Bot forfeit.
const PROTOCOL_VIOLATION: &str = "PROTOCOL_VIOLATION";
const ILLEGAL_MOVE: &str = "ILLEGAL_MOVE";
const FORFEIT: &str = "BOT_FORFEIT";
const DOUBLE_FORFEIT: &str = "DOUBLE_FORFEIT";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerError {
    code: &'static str,
    message: String,
}

impl WorkerError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkerError {}

impl From<MaterializeError> for WorkerError {
    fn from(error: MaterializeError) -> Self {
        Self::new(error.code(), error.message().to_owned())
    }
}

impl From<io::Error> for WorkerError {
    fn from(error: io::Error) -> Self {
        Self::new("io", error.to_string())
    }
}

impl From<SessionError> for WorkerError {
    fn from(error: SessionError) -> Self {
        let code = match error {
            SessionError::InfrastructureFault => "SESSION_INFRASTRUCTURE_FAULT",
            SessionError::BotProtocolViolation => "SESSION_BOT_PROTOCOL_VIOLATION",
            SessionError::Io(_) => "SESSION_IO",
            SessionError::Manifest(_) => "SESSION_MANIFEST",
            _ => "SESSION_REJECTED",
        };
        Self::new(code, format!("{error:?}"))
    }
}

// ---------------------------------------------------------------------------------------------
// Operator configuration
// ---------------------------------------------------------------------------------------------

/// Operator-declared compiler/runtime identity for one language. The assignment must declare the
/// same identity or the build is refused before anything runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolchainProfile {
    pub rootfs: PathBuf,
    /// Rootfs digest the operator pinned for this language.
    pub image_digest: [u8; 32],
    /// Version the operator declares; the sandbox probe must report it.
    pub version: String,
    /// Flags the operator fixed for this language, in canonical order.
    pub flags: Vec<String>,
}

impl ToolchainProfile {
    /// The probe's output must contain the declared version. A compiler banner is not a machine
    /// format, so the check is containment rather than a parse.
    fn matched_version(&self, diagnostic: &[u8]) -> bool {
        let text = String::from_utf8_lossy(diagnostic);
        text.lines().any(|line| line.contains(&self.version))
    }

    fn matches(&self, toolchain: &Toolchain) -> bool {
        self.image_digest == toolchain.image_digest
            && self.version == toolchain.version
            && self.flags == toolchain.flags
    }
}

/// The operator's per-language toolchain document. Every language must be present: a worker that
/// may claim BUILD work may not guess an image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toolchains {
    pub python: ToolchainProfile,
    pub typescript: ToolchainProfile,
    pub cpp: ToolchainProfile,
}

impl Toolchains {
    pub fn profile(&self, language: Language) -> &ToolchainProfile {
        match language {
            Language::Python => &self.python,
            Language::TypeScript => &self.typescript,
            Language::Cpp => &self.cpp,
        }
    }

    /// Parse the operator's toolchain document. Nothing is defaulted: a missing language, a
    /// relative rootfs, a malformed digest or an unbounded flag list is a configuration error.
    pub fn parse(document: &str) -> Result<Self, WorkerError> {
        let value: Value = serde_json::from_str(document)
            .map_err(|error| WorkerError::new("CONFIG_INVALID", format!("toolchains document: {error}")))?;
        value
            .as_object()
            .ok_or_else(|| WorkerError::new("CONFIG_INVALID", "toolchains document must be an object"))?;
        let parse = |name: &str, language: Language| -> Result<ToolchainProfile, WorkerError> {
            let entry = value
                .get(name)
                .ok_or_else(|| WorkerError::new("CONFIG_INVALID", format!("toolchains document has no {name}")))?;
            let rootfs = entry
                .get("rootfs")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkerError::new("CONFIG_INVALID", format!("{name}.rootfs must be a string")))?;
            let rootfs = PathBuf::from(rootfs);
            if !rootfs.is_absolute() {
                return Err(WorkerError::new("CONFIG_INVALID", format!("{name}.rootfs must be absolute")));
            }
            let digest_text = entry
                .get("imageDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkerError::new("CONFIG_INVALID", format!("{name}.imageDigest must be a string")))?;
            let image_digest = decode_hex_digest(digest_text, &format!("{name}.imageDigest"))?;
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkerError::new("CONFIG_INVALID", format!("{name}.version must be a string")))?;
            if version.is_empty() || version.len() > 64 || !version.is_ascii() {
                return Err(WorkerError::new("CONFIG_INVALID", format!("{name}.version must be short ASCII")));
            }
            let flags = entry
                .get("flags")
                .and_then(Value::as_array)
                .ok_or_else(|| WorkerError::new("CONFIG_INVALID", format!("{name}.flags must be an array")))?
                .iter()
                .map(|flag| {
                    let flag = flag.as_str().ok_or_else(|| {
                        WorkerError::new("CONFIG_INVALID", format!("{name}.flags must hold strings"))
                    })?;
                    if flag.is_empty() || flag.len() > 64 || !flag.is_ascii() || flag.contains('\0') {
                        return Err(WorkerError::new("CONFIG_INVALID", format!("{name} flag is not bounded ASCII")));
                    }
                    Ok(flag.to_owned())
                })
                .collect::<Result<Vec<String>, WorkerError>>()?;
            if flags.len() > 16 {
                return Err(WorkerError::new("CONFIG_INVALID", format!("{name}.flags must hold at most 16 entries")));
            }
            if !language.has_compile_step() && !flags.is_empty() {
                return Err(WorkerError::new(
                    "CONFIG_INVALID",
                    format!("{name} has no compile step and must declare no flags"),
                ));
            }
            Ok(ToolchainProfile { rootfs, image_digest, version: version.to_owned(), flags })
        };
        Ok(Self {
            python: parse("PYTHON", Language::Python)?,
            typescript: parse("TYPESCRIPT", Language::TypeScript)?,
            cpp: parse("CPP", Language::Cpp)?,
        })
    }
}

fn decode_hex_digest(text: &str, name: &str) -> Result<[u8; 32], WorkerError> {
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(WorkerError::new("CONFIG_INVALID", format!("{name} must be a lowercase SHA-256")));
    }
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| WorkerError::new("CONFIG_INVALID", format!("{name} is not hexadecimal")))?;
    }
    Ok(digest)
}

/// Operator configuration. Paths have no defaults: the operator names the socket, the runtime
/// rootfs, the runsc binary, the delegated cgroup root, the attempt root, the toolchain images and
/// the artifact output root, and nothing in a claim can change them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerConfig {
    pub broker_socket: PathBuf,
    pub runsc: PathBuf,
    pub runtime_rootfs: PathBuf,
    pub cgroup_root: PathBuf,
    pub attempt_root: PathBuf,
    pub runtime_profile_digest: String,
    pub max_game_slots: u32,
    pub max_build_slots: u32,
    /// Required when this worker offers build slots.
    pub toolchains: Option<Toolchains>,
    /// Required when this worker offers build slots.
    pub artifact_output_root: Option<PathBuf>,
    pub heartbeat: Duration,
    pub poll: Duration,
    pub once: bool,
}

impl WorkerConfig {
    pub fn validate(&self) -> Result<(), WorkerError> {
        for (name, path) in [
            ("broker socket", &self.broker_socket),
            ("runsc", &self.runsc),
            ("runtime rootfs", &self.runtime_rootfs),
            ("cgroup root", &self.cgroup_root),
            ("attempt root", &self.attempt_root),
        ] {
            if !path.is_absolute() {
                return Err(WorkerError::new("CONFIG_INVALID", format!("{name} must be an absolute path")));
            }
        }
        let digest = &self.runtime_profile_digest;
        if digest.len() != 64
            || !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(WorkerError::new("CONFIG_INVALID", "runtime profile digest must be a lowercase SHA-256"));
        }
        if self.max_game_slots == 0 && self.max_build_slots == 0 {
            return Err(WorkerError::new("CONFIG_INVALID", "at least one slot type must be positive"));
        }
        if self.max_build_slots > 0 {
            // A worker that may take build work may not guess a toolchain or an output root.
            if self.toolchains.is_none() {
                return Err(WorkerError::new("CONFIG_INVALID", "build slots require the operator's toolchain profiles"));
            }
            let output_root = self
                .artifact_output_root
                .as_ref()
                .ok_or_else(|| WorkerError::new("CONFIG_INVALID", "build slots require the artifact output root"))?;
            if !output_root.is_absolute() {
                return Err(WorkerError::new("CONFIG_INVALID", "artifact output root must be an absolute path"));
            }
        }
        let heartbeat = self.heartbeat.as_secs();
        if heartbeat == 0 || heartbeat > 25 {
            return Err(WorkerError::new("CONFIG_INVALID", "heartbeat must be 1..=25 seconds"));
        }
        if self.poll.is_zero() {
            return Err(WorkerError::new("CONFIG_INVALID", "poll interval must be positive"));
        }
        Ok(())
    }

    /// The slot offer this worker sends with every claim.
    pub fn capacity(&self) -> Value {
        json!({
            "buildSlots": self.max_build_slots,
            "gameSlots": self.max_game_slots,
            "runtimeProfileDigest": self.runtime_profile_digest,
        })
    }

    /// The job types this worker can actually run, derived from its own slot offer. A private test
    /// is a game, so TEST_GAME shares the game slots: a worker with game slots offers both, and a
    /// worker with none offers neither.
    pub fn job_types(&self) -> Vec<&'static str> {
        let mut types = Vec::with_capacity(4);
        if self.max_game_slots > 0 {
            types.push("GAME");
            types.push("TEST_GAME");
        }
        if self.max_build_slots > 0 {
            types.push("BUILD");
            types.push("TEST_BUILD");
        }
        types
    }

    /// Build the configuration from explicit arguments and environment variables. Every required
    /// value is a path, digest or document the operator must name: there is no fallback and nothing
    /// can come from a claim, the API or the network.
    pub fn from_arguments(
        arguments: impl IntoIterator<Item = String>,
        environment: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, WorkerError> {
        const REQUIRED: [&str; 7] = [
            "broker-socket",
            "runsc",
            "runtime-rootfs",
            "cgroup-root",
            "attempt-root",
            "runtime-profile-digest",
            "max-game-slots",
        ];
        const OPTIONAL: [&str; 5] = [
            "max-build-slots",
            "toolchains",
            "artifact-output-root",
            "heartbeat-seconds",
            "poll-seconds",
        ];
        let mut provided: Vec<(String, String)> = Vec::new();
        let mut once = false;
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            let Some(flag) = argument.strip_prefix("--") else {
                return Err(WorkerError::new("CONFIG_INVALID", format!("unexpected argument {argument}")));
            };
            let (name, inline) = match flag.split_once('=') {
                Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
                None => (flag.to_owned(), None),
            };
            if name == "once" {
                if inline.is_some() {
                    return Err(WorkerError::new("CONFIG_INVALID", "--once takes no value"));
                }
                once = true;
                continue;
            }
            if !REQUIRED.contains(&name.as_str()) && !OPTIONAL.contains(&name.as_str()) {
                return Err(WorkerError::new("CONFIG_INVALID", format!("unknown option --{name}")));
            }
            let value = match inline {
                Some(value) => value,
                None => match arguments.next() {
                    Some(value) => value,
                    None => return Err(WorkerError::new("CONFIG_INVALID", format!("--{name} needs a value"))),
                },
            };
            provided.push((name, value));
        }
        let lookup = |name: &str, variable: &str| -> Result<String, WorkerError> {
            if let Some((_, value)) = provided.iter().find(|(flag, _)| flag == name) {
                return Ok(value.clone());
            }
            environment(variable).ok_or_else(|| {
                WorkerError::new("CONFIG_INVALID", format!("--{name} (or {variable}) is required"))
            })
        };
        let optional = |name: &str, variable: &str| -> Result<Option<String>, WorkerError> {
            if let Some((_, value)) = provided.iter().find(|(flag, _)| flag == name) {
                return Ok(Some(value.clone()));
            }
            Ok(environment(variable))
        };
        let path = |name: &str, variable: &str| -> Result<PathBuf, WorkerError> {
            Ok(PathBuf::from(lookup(name, variable)?))
        };
        let optional_path = |name: &str, variable: &str| -> Result<Option<PathBuf>, WorkerError> {
            Ok(optional(name, variable)?.map(PathBuf::from))
        };
        let seconds = |name: &str, variable: &str, default: u64| -> Result<Duration, WorkerError> {
            let value = match provided.iter().find(|(flag, _)| flag == name) {
                Some((_, value)) => value.clone(),
                None => match environment(variable) {
                    Some(value) => value,
                    None => return Ok(Duration::from_secs(default)),
                },
            };
            let parsed = value
                .parse::<u64>()
                .map_err(|_| WorkerError::new("CONFIG_INVALID", format!("--{name} must be a whole number of seconds")))?;
            Ok(Duration::from_secs(parsed))
        };
        let broker_socket = path("broker-socket", "OANTUTI_WORKER_BROKER_SOCKET")?;
        let runsc = path("runsc", "OANTUTI_WORKER_RUNSC")?;
        let runtime_rootfs = path("runtime-rootfs", "OANTUTI_WORKER_RUNTIME_ROOTFS")?;
        let cgroup_root = path("cgroup-root", "OANTUTI_WORKER_CGROUP_ROOT")?;
        let attempt_root = path("attempt-root", "OANTUTI_WORKER_ATTEMPT_ROOT")?;
        let runtime_profile_digest = lookup("runtime-profile-digest", "OANTUTI_WORKER_RUNTIME_PROFILE_DIGEST")?;
        let max_game_slots = lookup("max-game-slots", "OANTUTI_WORKER_MAX_GAME_SLOTS")?
            .parse::<u32>()
            .map_err(|_| WorkerError::new("CONFIG_INVALID", "--max-game-slots must be a whole number"))?;
        let max_build_slots = match optional("max-build-slots", "OANTUTI_WORKER_MAX_BUILD_SLOTS")? {
            Some(value) => value
                .parse::<u32>()
                .map_err(|_| WorkerError::new("CONFIG_INVALID", "--max-build-slots must be a whole number"))?,
            None => 0,
        };
        let toolchains = match optional("toolchains", "OANTUTI_WORKER_TOOLCHAINS")? {
            Some(path) => {
                let document = fs::read_to_string(&path)
                    .map_err(|error| WorkerError::new("CONFIG_INVALID", format!("toolchains document {path}: {error}")))?;
                Some(Toolchains::parse(&document)?)
            }
            None => None,
        };
        let artifact_output_root = optional_path("artifact-output-root", "OANTUTI_WORKER_ARTIFACT_OUTPUT_ROOT")?;
        let once = once || environment("OANTUTI_WORKER_ONCE").is_some_and(|value| value == "1" || value == "true");
        let config = Self {
            broker_socket,
            runsc,
            runtime_rootfs,
            cgroup_root,
            attempt_root,
            runtime_profile_digest,
            max_game_slots,
            max_build_slots,
            toolchains,
            artifact_output_root,
            heartbeat: seconds("heartbeat-seconds", "OANTUTI_WORKER_HEARTBEAT_SECONDS", LEASE_HEARTBEAT_SECONDS)?,
            poll: seconds("poll-seconds", "OANTUTI_WORKER_POLL_SECONDS", 2)?,
            once,
        };
        config.validate()?;
        Ok(config)
    }
}

// ---------------------------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------------------------

/// One measured Bot response, exactly as the sandbox produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub side: u8,
    pub ply: u32,
    pub kind: &'static str,
    pub cpu_usec: u64,
    pub wall_usec: u64,
    pub response: Option<Vec<u8>>,
}

impl Observation {
    fn response_ndjson(&self) -> Option<String> {
        self.response
            .as_ref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .map(str::to_owned)
    }

    fn is_ready(&self) -> bool {
        if self.kind != "RESPONSE" {
            return false;
        }
        match self.response.as_deref().and_then(parse_object) {
            Some(value) => value.get("status").and_then(Value::as_str) == Some("READY"),
            None => false,
        }
    }

    fn action(&self) -> Option<(u32, i32, i32)> {
        let value = self.response.as_deref().and_then(parse_object)?;
        parse_move(&value)
    }
}

/// One applied action, as the engine recorded it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TraceStep {
    pub ply: u32,
    pub side: u8,
    pub piece_id: u32,
    pub x: i32,
    pub y: i32,
}

/// The engine's terminal verdict plus everything the supervisor observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionResult {
    pub initial_terminal: bool,
    pub winner: Option<u8>,
    pub reason: String,
    pub disposition: String,
    pub trace: Vec<TraceStep>,
    pub observations: Vec<Observation>,
}

/// A runtime workload for one Bot side. The production implementation is a runsc sandbox bound to
/// an operator-supplied cgroup; tests substitute a scripted workload.
pub trait Workload {
    fn exchange(&mut self, request: &[u8], startup: bool) -> io::Result<Exchange>;
    fn stop(&mut self) -> io::Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exchange {
    pub response: Vec<u8>,
    pub cpu_usec: u64,
    pub wall_usec: u64,
}

/// Creates workloads. Nothing here is derived from assignment content: the caller supplies the
/// bundle, the runsc state directory, the cgroup materialization built and the budgets the workload
/// is measured against.
pub trait WorkloadFactory {
    fn launch(&self, layout: &BotLayout, attempt_id: &str, budgets: Budgets) -> io::Result<Box<dyn Workload>>;
}

/// Production factory: the Sandbox primitive over the operator's runsc and rootfs.
pub struct RunscWorkloadFactory {
    runsc: PathBuf,
}

impl RunscWorkloadFactory {
    pub fn new(runsc: impl Into<PathBuf>) -> Self {
        Self { runsc: runsc.into() }
    }
}

fn prepare_workload_leaf(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::OpenOptionsExt;
    match fs::create_dir(path) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::other("unsafe existing workload cgroup"));
    }
    let events_path = path.join("cgroup.events");
    let mut events = std::fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_NOFOLLOW).open(events_path)?;
    let mut contents = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(&mut events, 4096), &mut contents)?;
    if contents.lines().filter(|line| *line == "populated 0").count() != 1
        || contents.lines().filter(|line| line.starts_with("populated ")).count() != 1
        || contents.lines().filter(|line| *line == "frozen 1").count() != 1
        || contents.lines().filter(|line| line.starts_with("frozen ")).count() != 1 {
        return Err(io::Error::other("existing workload cgroup must be empty and frozen"));
    }
    Ok(())
}

impl WorkloadFactory for RunscWorkloadFactory {
    fn launch(&self, layout: &BotLayout, attempt_id: &str, budgets: Budgets) -> io::Result<Box<dyn Workload>> {
        // The delegated cgroup subtree exists (the operator owns the root); the per-attempt child
        // cgroup does not, and must exist before the runtime can be placed in it.
        if let Some(parent) = layout.cgroup.parent() {
            let root = parent.parent().ok_or_else(|| io::Error::other("missing delegated root"))?;
            crate::control::enable_workload_controllers(root)?;
            fs::create_dir_all(parent)?;
            crate::control::enable_workload_controllers(parent)?;
        }
        prepare_workload_leaf(&layout.cgroup)?;
        let id = format!("{attempt_id}-{}", layout.side);
        Ok(Box::new(Sandbox::launch(&self.runsc, &layout.bundle, &layout.state, &id, &layout.cgroup, budgets)?))
    }
}

impl Workload for Sandbox {
    fn exchange(&mut self, request: &[u8], startup: bool) -> io::Result<Exchange> {
        let observation = Sandbox::exchange(self, request, startup)?;
        Ok(Exchange {
            response: observation.response,
            cpu_usec: observation.cpu_usec,
            wall_usec: observation.wall_usec,
        })
    }

    fn stop(&mut self) -> io::Result<()> {
        Sandbox::stop(self)
    }
}

/// Runs one operator-fixed toolchain command inside the operator's toolchain rootfs. The production
/// implementation is the sandbox command primitive; tests script outcomes, which is what lets the
/// build loop's classification be proven without the operator's runsc, uid and cgroups.
pub trait SandboxRunner {
    fn run(&self, bundle: &Path, layout: &BuildLayout, wall: Duration) -> io::Result<CommandOutcome>;
}

/// Production runner over the sandbox command primitive.
pub struct RunscSandboxRunner {
    runsc: PathBuf,
    sequence: AtomicU64,
}

impl RunscSandboxRunner {
    pub fn new(runsc: impl Into<PathBuf>) -> Self {
        Self { runsc: runsc.into(), sequence: AtomicU64::new(0) }
    }
}

impl SandboxRunner for RunscSandboxRunner {
    fn run(&self, bundle: &Path, layout: &BuildLayout, wall: Duration) -> io::Result<CommandOutcome> {
        // The delegated cgroup subtree exists (the operator owns the root); the per-attempt child
        // cgroup does not, and must exist before the runtime can be placed in it. A second command
        // in the same attempt finds it already there.
        if let Some(parent) = layout.cgroup.parent() {
            let root = parent.parent().ok_or_else(|| io::Error::other("missing delegated root"))?;
            crate::control::enable_workload_controllers(root)?;
            fs::create_dir_all(parent)?;
            crate::control::enable_workload_controllers(parent)?;
        }
        prepare_workload_leaf(&layout.cgroup)?;
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let id = format!("{}-{sequence}", layout.target_id);
        Sandbox::run_command(&self.runsc, bundle, &layout.state, &id, &layout.cgroup, wall)
    }
}

fn sandbox_worker_error(code: &'static str, error: io::Error) -> WorkerError {
    let code = if error.get_ref().is_some_and(|cause| cause.is::<CleanupFailure>()) {
        "SANDBOX_TERMINATION_UNCONFIRMED"
    } else { code };
    WorkerError::new(code, error.to_string())
}

/// Classification of unmeasured exchange failures. These diagnostics cannot become match evidence.
fn classify_exchange_failure(error: &io::Error) -> (&'static str, String) {
    if let Some(cause) = error.get_ref().and_then(|cause| cause.downcast_ref::<BotOutputFault>()) {
        return match cause {
            BotOutputFault::OutputLimit => ("BOT_OUTPUT_LIMIT", "Bot exceeded the output limit".to_owned()),
            BotOutputFault::ProtocolViolation => {
                ("BOT_PROTOCOL_VIOLATION", "Bot broke the response protocol".to_owned())
            }
        };
    }
    match error.kind() {
        io::ErrorKind::TimedOut => {
            let message = error.to_string();
            let code = if message.contains("CPU") {
                "BOT_CPU_TIMEOUT"
            } else if message.contains("wall") {
                "BOT_WALL_TIMEOUT"
            } else {
                // A budget failure the sandbox could not attribute and for which no counters were
                // returned: not provable, so not claimable.
                "BOT_BUDGET_UNMEASURED"
            };
            (code, message)
        }
        _ => ("SANDBOX_FAILURE", error.to_string()),
    }
}

fn parse_object(response: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(response).ok().filter(Value::is_object)
}

/// The Bot wire format carries the target as a pair: `{"action":"MOVE","piece_id":N,"target":[x,y]}`
/// (`docs/specs/04-BOT-RUNNER-IPC-SPEC.md` §57, the reference Bot SDK and the server-side verifier
/// all read that shape). Only that shape is accepted from a Bot.
fn parse_move(value: &Value) -> Option<(u32, i32, i32)> {
    if value.get("action").and_then(Value::as_str) != Some("MOVE") {
        return None;
    }
    let piece_id = u32::try_from(value.get("piece_id")?.as_u64()?).ok()?;
    let target = value.get("target")?.as_array()?;
    if target.len() != 2 {
        return None;
    }
    let x = i32::try_from(target[0].as_i64()?).ok()?;
    let y = i32::try_from(target[1].as_i64()?).ok()?;
    Some((piece_id, x, y))
}

/// `arena_runner::session` parses the engine's own object form of the same action, so the
/// dispatcher translates the transport form while the observation keeps the Bot's exact bytes.
fn engine_turn_response(action: (u32, i32, i32)) -> Vec<u8> {
    let (piece_id, x, y) = action;
    let mut line = serde_json::to_vec(&json!({
        "action": "MOVE",
        "piece_id": piece_id,
        "target": { "x": x, "y": y },
    }))
    .expect("engine response serializes");
    line.push(b'\n');
    line
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn uuid_from(digest: &[u8; 32]) -> String {
    let text = hex(digest);
    format!("{}-{}-{}-{}-{}", &text[0..8], &text[8..12], &text[12..16], &text[16..20], &text[20..32])
}

/// Standard base64 with padding, as the gateway's `stageArtifact` op expects.
pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = chunk.get(1).copied().map(u32::from).unwrap_or(0);
        let third = chunk.get(2).copied().map(u32::from).unwrap_or(0);
        let combined = (first << 16) | (second << 8) | third;
        text.push(TABLE[((combined >> 18) & 63) as usize] as char);
        text.push(TABLE[((combined >> 12) & 63) as usize] as char);
        text.push(if chunk.len() > 1 { TABLE[((combined >> 6) & 63) as usize] as char } else { '=' });
        text.push(if chunk.len() > 2 { TABLE[(combined & 63) as usize] as char } else { '=' });
    }
    text
}

// ---------------------------------------------------------------------------------------------
// In-process execution bridge
// ---------------------------------------------------------------------------------------------

/// What the bridge is driving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    /// A real match: every turn is one measured sandbox exchange on a real Bot.
    Match,
    /// A build smoke test: only side 1 exists. Any other side is answered with a protocol fault so
    /// the engine terminates the session immediately after the submission's INIT. Nothing is
    /// measured for the counterparty because there is no counterparty — no counter is fabricated.
    InitSmoke,
}

/// The game host (`arena_runner::session`) and the sandbox dispatcher in one process: every frame
/// the host writes is a `RunBotTurn`/`TurnCommitted`/`GameFinished`, and every `RunBotTurn` is
/// answered with exactly one measured exchange against that side's sandbox.
struct Bridge<'a> {
    factory: &'a dyn WorkloadFactory,
    attempt_id: String,
    game_id: String,
    canonical_manifest: Vec<u8>,
    manifest_digest: [u8; 32],
    layouts: [BotLayout; 2],
    role: Role,
    budgets: Budgets,
    workloads: [Option<Box<dyn Workload>>; 2],
    observations: Vec<Observation>,
    pending: VecDeque<Vec<u8>>,
    inbound: Vec<u8>,
    host_sequence: u64,
    reply_sequence: u64,
    evidence: Option<Vec<u8>>,
    failure: Option<WorkerError>,
    lease_lost: Arc<AtomicBool>,
    live: Option<(&'a BrokerClient, Value)>,
}

impl<'a> Bridge<'a> {
    #[allow(clippy::too_many_arguments)]
    fn new(
        game_id: String,
        attempt_id: String,
        canonical_manifest: Vec<u8>,
        manifest_digest: [u8; 32],
        layouts: [BotLayout; 2],
        role: Role,
        budgets: Budgets,
        factory: &'a dyn WorkloadFactory,
        lease_lost: Arc<AtomicBool>,
    ) -> Self {
        let mut bridge = Self {
            factory,
            attempt_id,
            game_id,
            canonical_manifest,
            manifest_digest,
            layouts,
            role,
            budgets,
            workloads: [None, None],
            observations: Vec::new(),
            pending: VecDeque::new(),
            inbound: Vec::new(),
            host_sequence: 1,
            reply_sequence: 1,
            evidence: None,
            failure: None,
            lease_lost,
            live: None,
        };
        bridge.queue_start_game();
        bridge
    }

    /// The trusted dispatcher hands the host exactly the manifest the worker validated, so the
    /// host's own digest check re-verifies it a second time.
    fn queue_start_game(&mut self) {
        let envelope = Envelope {
            protocol_version: PROTOCOL_VERSION,
            game_id: self.game_id.clone(),
            attempt_id: self.attempt_id.clone(),
            sequence: 0,
            request_id: uuid_from(&self.manifest_digest),
            manifest_sha256: self.manifest_digest.to_vec(),
            message: Some(Message::StartGame(StartGame {
                canonical_game_manifest: self.canonical_manifest.clone(),
            })),
        };
        self.push_frame(&envelope.encode_to_vec());
    }

    fn push_frame(&mut self, payload: &[u8]) {
        let mut frame = Vec::with_capacity(payload.len() + 4);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        self.pending.push_back(frame);
    }

    fn fail(&mut self, code: &'static str, message: impl Into<String>) -> io::Error {
        let error = WorkerError::new(code, message);
        let reported = error.to_string();
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        io::Error::other(reported)
    }

    fn read_bytes(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.pending.front_mut() {
                Some(frame) if frame.is_empty() => {
                    self.pending.pop_front();
                }
                Some(frame) => {
                    let take = frame.len().min(buffer.len());
                    buffer[..take].copy_from_slice(&frame[..take]);
                    frame.drain(..take);
                    return Ok(take);
                }
                None => {
                    return Err(match &self.failure {
                        Some(failure) => io::Error::other(failure.to_string()),
                        None => io::Error::other("execution host asked for a frame the dispatcher never produced"),
                    })
                }
            }
        }
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.inbound.len() + bytes.len() > MAX_FRAME_BYTES + 4 {
            return Err(self.fail("HOST_FRAME_OVERSIZE", "host frame exceeds the transport bound"));
        }
        self.inbound.extend_from_slice(bytes);
        while let Some(frame) = self.take_frame()? {
            self.handle_frame(&frame)?;
        }
        Ok(())
    }

    fn take_frame(&mut self) -> io::Result<Option<Vec<u8>>> {
        if self.inbound.len() < 4 {
            return Ok(None);
        }
        let length = u32::from_be_bytes([self.inbound[0], self.inbound[1], self.inbound[2], self.inbound[3]]) as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(self.fail("HOST_FRAME_INVALID", "invalid execution frame length"));
        }
        if self.inbound.len() < 4 + length {
            return Ok(None);
        }
        let payload = self.inbound[4..4 + length].to_vec();
        self.inbound.drain(..4 + length);
        Ok(Some(payload))
    }

    fn handle_frame(&mut self, frame: &[u8]) -> io::Result<()> {
        let mut envelope = match Envelope::decode(frame) {
            Ok(envelope) => envelope,
            Err(_) => return Err(self.fail("HOST_FRAME_INVALID", "host envelope did not decode")),
        };
        if envelope.protocol_version != PROTOCOL_VERSION
            || envelope.game_id != self.game_id
            || envelope.attempt_id != self.attempt_id
            || envelope.manifest_sha256 != self.manifest_digest
            || envelope.sequence != self.host_sequence
        {
            return Err(self.fail("HOST_FRAME_REJECTED", "host envelope identity or sequence mismatch"));
        }
        self.host_sequence = match envelope.sequence.checked_add(1) {
            Some(sequence) => sequence,
            None => return Err(self.fail("HOST_FRAME_REJECTED", "host sequence overflow")),
        };
        match envelope.message.take() {
            Some(Message::RunBotTurn(turn)) => self.run_turn(&envelope, &turn),
            Some(Message::GameFinished(finished)) => {
                if finished.canonical_game_evidence.is_empty()
                    || finished.canonical_game_evidence.len() > MAX_FRAME_BYTES
                {
                    return Err(self.fail("HOST_FRAME_REJECTED", "host evidence out of bounds"));
                }
                self.evidence = Some(finished.canonical_game_evidence);
                Ok(())
            }
            // Commits and stop notices carry no supervisor reply.
            Some(Message::TurnCommitted(committed)) => {
                if let Some((broker, lease)) = &self.live {
                    if let Some(observation) = self.observations.last().filter(|observation| observation.ply == committed.ply) {
                        if let Some((piece_id, x, y)) = observation.action() {
                            // Preview is bounded and best-effort; only durable completion publishes RESULT.
                            let _ = broker.request("liveTurn", json!({ "lease": lease, "seq": committed.ply,
                                "turnNumber": committed.ply, "side": observation.side,
                                "action": { "action": "MOVE", "pieceId": piece_id, "target": [x, y] } }));
                        }
                    }
                }
                Ok(())
            }
            Some(Message::StopGame(_)) => Ok(()),
            _ => Err(self.fail("HOST_FRAME_REJECTED", "host sent a supervisor-only message")),
        }
    }

    fn reply(&mut self, request: &Envelope, message: Message) -> io::Result<()> {
        let sequence = self.reply_sequence;
        let envelope = Envelope {
            protocol_version: PROTOCOL_VERSION,
            game_id: self.game_id.clone(),
            attempt_id: self.attempt_id.clone(),
            sequence,
            request_id: request.request_id.clone(),
            manifest_sha256: self.manifest_digest.to_vec(),
            message: Some(message),
        };
        self.reply_sequence = match sequence.checked_add(1) {
            Some(sequence) => sequence,
            None => return Err(self.fail("HOST_FRAME_REJECTED", "reply sequence overflow")),
        };
        self.push_frame(&envelope.encode_to_vec());
        Ok(())
    }

    fn run_turn(&mut self, request: &Envelope, turn: &RunBotTurn) -> io::Result<()> {
        if !matches!(turn.side, 1 | 2) {
            return Err(self.fail("HOST_FRAME_REJECTED", "turn side out of range"));
        }
        let side = turn.side;
        let ply = turn.ply;
        if self.lease_lost.load(Ordering::Acquire) {
            return Err(self.fail("LEASE_LOST", "lease was lost while the workload was running"));
        }
        if self.role == Role::InitSmoke && side != 1 {
            // The smoke harness's counterparty: it is not a Bot, nothing is measured for it, and the
            // only honest answer is a protocol fault that ends the session.
            return self.reply(request, Message::ExecutionFault(ExecutionFault { kind: 1, side }));
        }
        let startup = ply == 0;
        let index = (side - 1) as usize;
        if self.workloads[index].is_none() {
            if !startup {
                return Err(self.fail("HOST_FRAME_REJECTED", "turn before the Bot was initialized"));
            }
            let launched = self.factory.launch(&self.layouts[index], &self.attempt_id, self.budgets);
            let workload = match launched {
                Ok(workload) => workload,
                Err(error) => {
                    let failure = sandbox_worker_error("WORKLOAD_LAUNCH_FAILED", error);
                    return Err(self.fail(failure.code(), failure.message()));
                }
            };
            self.workloads[index] = Some(workload);
        }
        if self.workloads[index].is_none() {
            return Err(self.fail("WORKLOAD_MISSING", "workload was not created"));
        }
        let workload = self.workloads[index]
            .as_mut()
            .expect("workload presence was checked immediately above");
        let exchange = workload.exchange(&turn.request_ndjson, startup);
        let exchange = match exchange {
            Ok(exchange) => exchange,
            Err(error) => {
                if let Some(fault) = error.get_ref().and_then(|cause| cause.downcast_ref::<MeasuredBotFault>()) {
                    self.observations.push(Observation { side: side as u8, ply,
                        kind: fault.kind.observation_kind(), cpu_usec: fault.cpu_usec,
                        wall_usec: fault.wall_usec, response: None });
                    return self.reply(request, Message::ExecutionFault(ExecutionFault { kind: 1, side }));
                }
                if error.get_ref().is_some_and(|cause| cause.is::<CleanupFailure>()) {
                    return Err(self.fail("SANDBOX_TERMINATION_UNCONFIRMED", error.to_string()));
                }
                // No structured measurement survived this failure. Preserve the diagnostic but
                // never turn an unavailable counter or ambiguous timeout into a Bot verdict.
                let (code, message) = classify_exchange_failure(&error);
                return Err(self.fail(code, message));
            }
        };
        if exchange.response.len() > MAX_RESPONSE_BYTES || !exchange.response.ends_with(b"\n") {
            return Err(self.fail("SANDBOX_RESPONSE_INVALID", "sandbox returned an unbounded response"));
        }
        // A Bot violation the sandbox *did* measure stays a Bot violation; forwarding a payload the
        // engine session would reject mid-flight would otherwise tear the whole attempt down.
        let parsed = parse_object(&exchange.response);
        let action = if startup { None } else { parsed.as_ref().and_then(parse_move) };
        let usable = if startup { parsed.is_some() } else { action.is_some() };
        if !usable {
            self.observations.push(Observation {
                side: side as u8,
                ply,
                kind: "PROTOCOL_ERROR",
                cpu_usec: exchange.cpu_usec,
                wall_usec: exchange.wall_usec,
                response: None,
            });
            return self.reply(request, Message::ExecutionFault(ExecutionFault { kind: 1, side }));
        }
        self.observations.push(Observation {
            side: side as u8,
            ply,
            kind: "RESPONSE",
            cpu_usec: exchange.cpu_usec,
            wall_usec: exchange.wall_usec,
            // The Bot's own bytes, exactly as the server-side verifier will read them back.
            response: Some(exchange.response.clone()),
        });
        let forwarded = match action {
            Some(action) => engine_turn_response(action),
            None => exchange.response,
        };
        self.reply(
            request,
            Message::TurnObservation(TurnObservation {
                side,
                ply,
                response_ndjson: forwarded,
                cpu_usage_usec: exchange.cpu_usec,
                wall_elapsed_usec: exchange.wall_usec,
                // The sandbox accepted this response from a confirmed-frozen cgroup: that is the
                // only freeze confirmation the supervisor has, and it is what it reports.
                freeze_confirmed: true,
            }),
        )
    }

    /// Stopping every workload is the only thing that can confirm termination: `stop()` returns
    /// `Ok` only when the cgroup is empty, the runtime exited and `runsc delete` succeeded.
    fn stop_workloads(&mut self) -> Result<(), WorkerError> {
        let mut failure = None;
        for workload in self.workloads.iter_mut().flatten() {
            if let Err(error) = workload.stop() {
                if failure.is_none() {
                    failure = Some(WorkerError::new("SANDBOX_TERMINATION_UNCONFIRMED", error.to_string()));
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// One `io::Read + io::Write` endpoint over the shared bridge. `arena_runner`'s session functions
/// take the host endpoints by reference and never re-enter them, so the shared cell is only ever
/// borrowed for the duration of a single call.
struct BridgeDuplex<'a>(Rc<RefCell<Bridge<'a>>>);

impl Read for BridgeDuplex<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        self.0.borrow_mut().read_bytes(buffer)
    }
}

impl Write for BridgeDuplex<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().write_bytes(bytes)?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The session ended, and whatever the bridge measured.
struct BridgeRun {
    evidence: Option<Vec<u8>>,
    observations: Vec<Observation>,
}

/// Drive one session through the engine's own machinery and report what the bridge observed.
///
/// A returned `Err` is either a sandbox/infrastructure fault or a session protocol mismatch; the
/// caller classifies it. Termination is always confirmed before returning.
fn drive_session(bridge: &Rc<RefCell<Bridge<'_>>>) -> Result<BridgeRun, WorkerError> {
    let outcome = {
        let mut reader = BridgeDuplex(Rc::clone(bridge));
        let mut writer = BridgeDuplex(Rc::clone(bridge));
        open_session(&mut reader, &mut writer)
    };
    let opened = match outcome {
        Ok(OpenOutcome::InitialTerminal { evidence, .. }) => Some(evidence),
        Ok(OpenOutcome::Ready(session)) => {
            let mut io = BridgeDuplex(Rc::clone(bridge));
            match run_started_session(&mut io, session) {
                Ok(run) => Some(run.evidence),
                Err(error) => {
                    let recorded = bridge.borrow().failure.clone();
                    let _ = bridge.borrow_mut().stop_workloads();
                    return Err(recorded.unwrap_or_else(|| WorkerError::from(error)));
                }
            }
        }
        Err(error) => {
            let recorded = bridge.borrow().failure.clone();
            let _ = bridge.borrow_mut().stop_workloads();
            return Err(recorded.unwrap_or_else(|| WorkerError::from(error)));
        }
    };
    // Termination must be confirmed before anything is submitted.
    let stopped = bridge.borrow_mut().stop_workloads();
    let (observations, recorded) = {
        let mut bridge = bridge.borrow_mut();
        let observations = std::mem::take(&mut bridge.observations);
        (observations, bridge.failure.take())
    };
    stopped?;
    if let Some(error) = recorded {
        return Err(error);
    }
    Ok(BridgeRun { evidence: opened, observations })
}

struct Played {
    evidence: Vec<u8>,
    observations: Vec<Observation>,
}

/// Drive one match through the session machinery and the sandbox primitives.
fn play(
    assignment: &Assignment,
    attempt: &MaterializedAttempt,
    factory: &dyn WorkloadFactory,
    lease_lost: Arc<AtomicBool>,
    live: Option<(&BrokerClient, Value)>,
) -> Result<Played, WorkerError> {
    let bridge = Rc::new(RefCell::new(Bridge::new(
        assignment.game_id.clone(),
        assignment.attempt_id.clone(),
        assignment.canonical_manifest.clone(),
        assignment.manifest_digest,
        attempt.bots.clone(),
        Role::Match,
        Budgets::game(),
        factory,
        lease_lost,
    )));
    bridge.borrow_mut().live = live;
    let run = drive_session(&bridge)?;
    match run.evidence {
        Some(evidence) => Ok(Played { evidence, observations: run.observations }),
        None => Err(WorkerError::new("EVIDENCE_MISSING", "the session ended without terminal evidence")),
    }
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/// Parse the engine's canonical evidence document. Everything the worker submits about the game
/// itself comes from this document, which the engine produced, not from the worker's own view.
pub fn parse_session_evidence(evidence: &[u8], observations: Vec<Observation>) -> Result<SessionResult, WorkerError> {
    let unreadable = |message: &str| WorkerError::new("EVIDENCE_UNREADABLE", message.to_owned());
    let value: Value = serde_json::from_slice(evidence).map_err(|_| unreadable("terminal evidence is not JSON"))?;
    let initial_terminal = value
        .get("initialTerminal")
        .and_then(Value::as_bool)
        .ok_or_else(|| unreadable("terminal evidence has no initialTerminal flag"))?;
    let outcome = value
        .get("outcome")
        .and_then(Value::as_object)
        .ok_or_else(|| unreadable("terminal evidence has no outcome"))?;
    if outcome.get("isGameOver").and_then(Value::as_bool) != Some(true) {
        return Err(unreadable("terminal evidence is not a finished game"));
    }
    let winner = match outcome.get("winner").and_then(Value::as_str) {
        Some("WHITE") => Some(1),
        Some("BLACK") => Some(2),
        None | Some("null") => None,
        _ => return Err(unreadable("terminal evidence winner is invalid")),
    };
    let reason = outcome
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty() && reason.len() <= 128 && reason.is_ascii())
        .ok_or_else(|| unreadable("terminal evidence reason is invalid"))?
        .to_owned();
    let disposition = outcome
        .get("disposition")
        .and_then(Value::as_str)
        .ok_or_else(|| unreadable("terminal evidence disposition is invalid"))?
        .to_owned();
    if disposition != derived_disposition(&reason) {
        return Err(WorkerError::new("EVIDENCE_MISMATCH", "disposition disagrees with its reason"));
    }
    let actions = value
        .get("actionTrace")
        .and_then(Value::as_array)
        .ok_or_else(|| unreadable("terminal evidence has no action trace"))?;
    if actions.len() > 300 {
        return Err(unreadable("action trace exceeds the turn bound"));
    }
    let mut trace = Vec::with_capacity(actions.len());
    for (index, step) in actions.iter().enumerate() {
        let ply = step
            .get("ply")
            .and_then(Value::as_u64)
            .and_then(|ply| u32::try_from(ply).ok())
            .ok_or_else(|| unreadable("trace step has no ply"))?;
        // The engine's own evidence document numbers the trace sides (`arena_runner::session`),
        // while names appear in the outcome; accept either spelling of the same side.
        let side = match step.get("side") {
            Some(Value::Number(number)) => match number.as_u64() {
                Some(1) => 1_u8,
                Some(2) => 2_u8,
                _ => return Err(unreadable("trace step has an invalid side")),
            },
            Some(Value::String(name)) => match name.as_str() {
                "WHITE" => 1_u8,
                "BLACK" => 2_u8,
                _ => return Err(unreadable("trace step has an invalid side")),
            },
            _ => return Err(unreadable("trace step has an invalid side")),
        };
        if ply != index as u32 + 1 || side != if ply % 2 == 1 { 1 } else { 2 } {
            return Err(WorkerError::new("EVIDENCE_MISMATCH", "trace steps are not in the engine's order"));
        }
        let action = step
            .get("action")
            .ok_or_else(|| unreadable("trace step has no action"))?;
        let piece_id = action
            .get("pieceId")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| unreadable("trace step has no piece id"))?;
        let target = action
            .get("target")
            .ok_or_else(|| unreadable("trace step has no target"))?;
        let x = target
            .get("x")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| unreadable("trace step target is invalid"))?;
        let y = target
            .get("y")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| unreadable("trace step target is invalid"))?;
        trace.push(TraceStep { ply, side, piece_id, x, y });
    }
    if initial_terminal && !trace.is_empty() {
        return Err(WorkerError::new("EVIDENCE_MISMATCH", "an initial-terminal game cannot have actions"));
    }
    Ok(SessionResult { initial_terminal, winner, reason, disposition, trace, observations })
}

/// The server derives the disposition from the reason; the worker derives it the same way so the
/// two can never disagree about what was played. `DOUBLE_FORFEIT` keeps the engine's own
/// no-contest disposition even though the broker cannot represent a winner-0 forfeit at all.
fn derived_disposition(reason: &str) -> &'static str {
    match reason {
        "MAX_TURNS_DRAW" => "DRAW",
        "INVALID_START_BOTH_SIDES" | "DOUBLE_FORFEIT" => "NO_CONTEST",
        _ => "DECISIVE",
    }
}

/// Position `index` of the observation sequence the server validates:
/// `[(1,0), (2,0), (1,1), (2,2), (1,3), …]`.
fn expected_position(index: usize) -> (u8, u32) {
    if index < 2 {
        ((index + 1) as u8, 0)
    } else {
        let ply = (index - 1) as u32;
        (if ply % 2 == 1 { 1 } else { 2 }, ply)
    }
}

/// The successful observations of an attempt must be exactly the engine's trace, position for
/// position. A startup forfeit leaves at most one successful INIT observation and no trace.
fn observations_match_prefix(observations: &[Observation], trace: &[TraceStep]) -> Result<(), WorkerError> {
    let startup = trace.is_empty() && observations.len() < 2;
    if !startup && observations.len() != trace.len() + 2 {
        return Err(WorkerError::new("EVIDENCE_MISMATCH", "observations do not cover the applied trace"));
    }
    for index in 0..observations.len().min(2) {
        let observation = &observations[index];
        if !observation.is_ready() || (observation.side, observation.ply) != expected_position(index) {
            return Err(WorkerError::new("EVIDENCE_MISMATCH", "a startup observation was not a measured READY"));
        }
    }
    for (offset, step) in trace.iter().enumerate() {
        let observation = &observations[offset + 2];
        if observation.kind != "RESPONSE" || (observation.side, observation.ply) != expected_position(offset + 2) {
            return Err(WorkerError::new("EVIDENCE_MISMATCH", "observation order disagrees with the trace"));
        }
        let action = observation
            .action()
            .ok_or_else(|| WorkerError::new("EVIDENCE_MISMATCH", "a measured response was not a move"))?;
        if action != (step.piece_id, step.x, step.y) {
            return Err(WorkerError::new("EVIDENCE_MISMATCH", "observation disagrees with the trace"));
        }
    }
    Ok(())
}

fn observation_json(observation: &Observation) -> Value {
    let mut document = json!({
        "side": observation.side,
        "ply": observation.ply,
        "kind": observation.kind,
        "cpuUsec": observation.cpu_usec.to_string(),
        "wallUsec": observation.wall_usec.to_string(),
        "freezeConfirmed": true,
        // Only ever set after every workload's `stop()` confirmed an empty cgroup.
        "terminationConfirmed": true,
    });
    if observation.kind == "RESPONSE" {
        if let Some(response) = observation.response_ndjson() {
            document["responseNdjson"] = Value::String(response);
        }
    }
    document
}

/// Build the exact `evidence` object `prepareCompletion` expects, or fail closed.
pub fn completion_evidence(assignment: &Assignment, result: &SessionResult) -> Result<Value, WorkerError> {
    let mismatch = |message: &str| WorkerError::new("EVIDENCE_MISMATCH", message.to_owned());
    let trace: Vec<Value> = result
        .trace
        .iter()
        .map(|step| {
            json!({
                "ply": step.ply,
                "side": step.side,
                "move": { "pieceId": step.piece_id, "targetPos": { "x": step.x, "y": step.y } },
            })
        })
        .collect();
    let submitted: Vec<Observation>;
    let execution_status: &'static str;
    let reason: String;
    let disposition: String;
    let winner: u8;
    match result.reason.as_str() {
        FORFEIT => {
            let winner_side = result
                .winner
                .filter(|side| *side == 1 || *side == 2)
                .ok_or_else(|| mismatch("a forfeit must name the winning side"))?;
            let fault_side = 3 - winner_side;
            let startup = result.trace.is_empty()
                && result
                    .observations
                    .iter()
                    .position(|observation| observation.side == fault_side && observation.ply == 0)
                    .is_some_and(|index| !result.observations[index].is_ready());
            let fault_index = if startup {
                result
                    .observations
                    .iter()
                    .position(|observation| observation.side == fault_side && observation.ply == 0)
                    .ok_or_else(|| mismatch("a startup forfeit has no INIT observation"))?
            } else {
                2 + result.trace.len()
            };
            let fault = result
                .observations
                .get(fault_index)
                .ok_or_else(|| mismatch("a forfeit has no failing observation"))?;
            if (fault.side, fault.ply) != expected_position(fault_index) || fault.side != fault_side {
                return Err(mismatch("the failing observation is not the engine's next turn"));
            }
            observations_match_prefix(&result.observations[..fault_index], &result.trace)?;
            reason = match (fault.kind, fault.ply) {
                // A response the sandbox measured but the host could not use.
                ("PROTOCOL_ERROR", _) => PROTOCOL_VIOLATION.to_owned(),
                ("CPU_TIMEOUT" | "WALL_TIMEOUT", _) => "TIMEOUT".to_owned(),
                ("OUTPUT_LIMIT", _) => "OUTPUT_LIMIT".to_owned(),
                // An INIT that never said READY: measured, and provably a protocol violation.
                ("RESPONSE", 0) => PROTOCOL_VIOLATION.to_owned(),
                // A syntactically valid move the engine rejected as illegal.
                ("RESPONSE", _) => ILLEGAL_MOVE.to_owned(),
                (kind, _) => {
                    return Err(WorkerError::new(
                        "UNPROVABLE_FORFEIT",
                        format!("no measured counters support a {kind} forfeit"),
                    ))
                }
            };
            submitted = result.observations[..=fault_index].to_vec();
            execution_status = "BOT_FORFEIT";
            disposition = "DECISIVE".to_owned();
            winner = winner_side;
        }
        DOUBLE_FORFEIT => {
            // Both Bots failed before the first turn. The broker's contract has no winner-0
            // forfeit and calling it INVALID_START_BOTH_SIDES would blame the map, so the attempt
            // cannot be represented and is aborted instead of mislabelled.
            return Err(WorkerError::new("DOUBLE_FORFEIT_UNREPRESENTABLE", "both Bots failed to initialize"));
        }
        _ => {
            if result.initial_terminal {
                if !result.observations.is_empty() {
                    return Err(mismatch("an initial-terminal game observed a Bot response"));
                }
            } else {
                observations_match_prefix(&result.observations, &result.trace)?;
            }
            reason = result.reason.clone();
            disposition = result.disposition.clone();
            winner = result.winner.unwrap_or(0);
            submitted = result.observations.clone();
            execution_status = "COMPLETED";
        }
    }
    let observations: Vec<Value> = submitted.iter().map(observation_json).collect();
    Ok(json!({
        "manifestDigest": hex(&assignment.manifest_digest),
        "gameEvidence": {
            "winner": winner,
            "reason": reason,
            "disposition": disposition,
            "executionStatus": execution_status,
            "totalPly": trace.len(),
            "trace": trace,
        },
        "observations": observations,
    }))
}

// ---------------------------------------------------------------------------------------------
// BUILD: toolchain probe, compile, INIT smoke and the artifact
// ---------------------------------------------------------------------------------------------

/// The canonical manifest of the INIT smoke board: one ROCK per side on a 3x3 map, exactly the
/// position the dev build pipeline advertises. It proves the bot greets at all and scores nothing.
fn smoke_manifest(game_id: &str, attempt_id: &str) -> Vec<u8> {
    let document = json!({
        "gameId": game_id,
        "attemptId": attempt_id,
        "map": {
            "name": "build_smoke_3x3",
            "width": 3,
            "height": 3,
            "validTiles": [
                [0, 0], [1, 0], [2, 0],
                [0, 1], [1, 1], [2, 1],
                [0, 2], [1, 2], [2, 2],
            ],
            "whiteThrone": [0, 0],
            "blackThrone": [2, 2],
        },
        "pieces": [
            { "id": 1, "owner": "WHITE", "type": "ROCK", "x": 0, "y": 1, "alive": true },
            { "id": 2, "owner": "BLACK", "type": "ROCK", "x": 2, "y": 1, "alive": true },
        ],
        "maxPly": SMOKE_MAX_TURNS,
    });
    serde_json::to_vec(&document).expect("smoke manifest serializes")
}

/// What the INIT smoke test concluded about the submission.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SmokeOutcome {
    Ready,
    Rejected(String),
}

/// The measured INIT of the submission, driven through the runner session with the assignment's
/// own INIT limits.
///
/// The gate is the bridge's own observation of side 1's INIT: a freeze-confirmed, single JSON
/// object whose status is READY. The sandbox enforces the assignment's `initCpuUsec`/`initWallMs`,
/// so those are the bounds a build is actually held to.
fn run_init_smoke(
    build: &BuildAssignment,
    attempt_id: &str,
    attempt: &MaterializedBuild,
    factory: &dyn WorkloadFactory,
    lease_lost: Arc<AtomicBool>,
) -> Result<SmokeOutcome, WorkerError> {
    let manifest = smoke_manifest(&build.target_id, attempt_id);
    let digest: [u8; 32] = Sha256::digest(&manifest).into();
    // The same layout twice: side 2 is never launched (the smoke role answers it); it only keeps
    // the bridge's fixed two-side shape honest for the engine's own session machinery.
    let layouts = [attempt.bot.clone(), attempt.bot.clone()];
    let bridge = Rc::new(RefCell::new(Bridge::new(
        build.target_id.clone(),
        attempt_id.to_owned(),
        manifest,
        digest,
        layouts,
        Role::InitSmoke,
        Budgets::init(build.limits.init_cpu_usec, build.limits.init_wall()),
        factory,
        lease_lost,
    )));
    let run = match drive_session(&bridge) {
        Ok(run) => run,
        Err(error) => return classify_smoke_failure(&error, &bridge.borrow().observations),
    };
    let observations = run.observations;
    classify_smoke_observation(&observations)
}

/// The INIT smoke's classification of a sandbox failure.
///
/// Only a *measured* violation is a verdict, and the measured path never reaches this function: a
/// `MeasuredBotFault` is recorded as an observation with its counters and classified by
/// [`classify_smoke_observation`]. Everything arriving here is an unmeasured failure — a missing
/// counter, an ambiguous launcher EOF, a launch/cgroup/termination fault — and must retry or block
/// as infrastructure instead of becoming a rejection the submission did not earn.
fn classify_smoke_failure(error: &WorkerError, _observations: &[Observation]) -> Result<SmokeOutcome, WorkerError> {
    Err(error.clone())
}

/// The INIT smoke's classification of what was measured. The submission's INIT must be a single
/// JSON object whose status is READY.
fn classify_smoke_observation(observations: &[Observation]) -> Result<SmokeOutcome, WorkerError> {
    let Some(observation) = observations.first() else {
        return Err(WorkerError::new("SMOKE_UNMEASURED", "the INIT produced no measured exchange"));
    };
    if (observation.side, observation.ply) != (1, 0) {
        return Err(WorkerError::new("SMOKE_UNMEASURED", "the first measured exchange was not the INIT"));
    }
    if observation.is_ready() {
        return Ok(SmokeOutcome::Ready);
    }
    match observation.response_ndjson() {
        Some(line) => Ok(SmokeOutcome::Rejected(format!("INIT did not answer READY: {}", excerpt(&line)))),
        None => Ok(SmokeOutcome::Rejected("INIT did not answer with a JSON object".to_owned())),
    }
}

/// A bounded, sanitised excerpt of Bot output that goes into a rejection diagnostic.
fn excerpt(line: &str) -> String {
    let sanitized = sanitize_diagnostic(line.as_bytes());
    let mut out: String = sanitized.chars().take(256).collect();
    if sanitized.chars().count() > 256 {
        out.push('…');
    }
    out
}

/// A bounded, sanitised compiler diagnostic, or an explicit "nothing was produced".
fn command_diagnostic(diagnostic: &[u8]) -> String {
    let retained = sanitize_diagnostic(diagnostic);
    if retained.is_empty() {
        "the compiler produced no diagnostic".to_owned()
    } else {
        retained
    }
}

/// The bytes and identity of the artifact a build produced.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Artifact {
    key: String,
    digest: [u8; 32],
    size_bytes: u64,
    entrypoint: String,
}

/// The verdict of a build that ran to the end of its gates.
enum BuildVerdict {
    /// The submission passed; these are the artifact bytes the worker measured itself.
    Ready { artifact: Artifact, bytes: Vec<u8> },
    /// A verdict about the submission. Nothing was uploaded.
    Rejected { stage: &'static str, diagnostic: String },
}

fn artifact_json(artifact: &Artifact) -> Value {
    json!({
        "key": artifact.key,
        "digest": hex(&artifact.digest),
        "sizeBytes": artifact.size_bytes,
        "entrypoint": artifact.entrypoint,
    })
}

/// Toolchain identity as the frozen contract spells it.
fn toolchain_json(language: Language, toolchain: &Toolchain) -> Value {
    json!({
        "language": language.name(),
        "imageDigest": hex(&toolchain.image_digest),
        "version": toolchain.version,
        "flags": toolchain.flags,
    })
}

fn ready_evidence(build: &BuildAssignment, artifact: &Artifact) -> Value {
    json!({
        "outcome": "READY",
        "stage": "INIT_SMOKE",
        "toolchain": toolchain_json(build.language, &build.toolchain),
        "manifestDigest": hex(&build.manifest_digest),
        "artifact": artifact_json(artifact),
    })
}

fn rejected_evidence(build: &BuildAssignment, stage: &str, diagnostic: &str) -> Value {
    let diagnostic = if diagnostic.is_empty() { "the build produced no diagnostic".to_owned() } else { diagnostic.to_owned() };
    json!({
        "outcome": "SOURCE_REJECTED",
        "stage": stage,
        "toolchain": toolchain_json(build.language, &build.toolchain),
        "manifestDigest": hex(&build.manifest_digest),
        "diagnostic": diagnostic,
    })
}

// ---------------------------------------------------------------------------------------------
// Claim / heartbeat / completion
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub job_type: String,
    pub lease: Value,
    pub attempt_id: String,
    pub deployment_generation: u64,
    pub target_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    pub attempt_id: String,
    pub target_id: String,
    pub job_type: String,
    /// GAME: the submitted execution status. BUILD: `READY` or `SOURCE_REJECTED`.
    pub outcome: String,
    /// GAME: the submitted reason. BUILD: the stage that decided the outcome.
    pub detail: String,
    /// GAME: the number of submitted observations.
    pub observations: usize,
    /// BUILD: the size of the staged artifact in bytes.
    pub bytes: u64,
}

fn required<'a>(value: &'a Value, name: &str) -> Result<&'a Value, WorkerError> {
    value
        .get(name)
        .ok_or_else(|| WorkerError::new("BROKER_MALFORMED", format!("response has no {name}")))
}

fn parse_claim(value: Value) -> Result<Claim, WorkerError> {
    let malformed = |message: &str| WorkerError::new("BROKER_MALFORMED", message.to_owned());
    value.as_object().ok_or_else(|| malformed("claim is not an object"))?;
    let job_type = match value.get("jobType").and_then(Value::as_str) {
        Some("GAME") => "GAME",
        Some("TEST_GAME") => "TEST_GAME",
        Some("BUILD") => "BUILD",
        Some("TEST_BUILD") => "TEST_BUILD",
        _ => return Err(WorkerError::new("JOB_TYPE_UNSUPPORTED", "this worker does not run that job type")),
    }
    .to_owned();
    let lease = required(&value, "identity")?.clone();
    let attempt_id = required(&lease, "attemptId")?
        .as_str()
        .filter(|text| text.len() == 36)
        .ok_or_else(|| malformed("lease attempt id is not a UUID"))?
        .to_owned();
    let deployment_generation = required(&lease, "deploymentGeneration")?
        .as_u64()
        .ok_or_else(|| malformed("lease generation is not an integer"))?;
    if required(&lease, "fencingToken")?
        .as_str()
        .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .is_none()
    {
        return Err(malformed("lease fence is not numeric"));
    }
    let target_id = required(&value, "targetId")?
        .as_str()
        .ok_or_else(|| malformed("claim has no target"))?
        .to_owned();
    let payload = value
        .get("payload")
        .cloned()
        .ok_or_else(|| WorkerError::new("ASSIGNMENT_MISSING", "claim carried no assignment"))?;
    Ok(Claim { job_type, lease, attempt_id, deployment_generation, target_id, payload })
}

struct Heartbeat {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Heartbeat {
    fn start(config: &WorkerConfig, lease: Value, lost: Arc<AtomicBool>) -> Result<Self, WorkerError> {
        let broker = BrokerClient::new(config.broker_socket.clone());
        // The first beat is synchronous: the transport is proven before any work starts, and an
        // unreachable gateway is reported as a lost lease rather than discovered after a match.
        match broker.heartbeat(lease.clone()) {
            Ok(status) => {
                if status.get("status").and_then(Value::as_str) != Some("ACTIVE") {
                    lost.store(true, Ordering::Release);
                }
            }
            Err(_) => lost.store(true, Ordering::Release),
        }
        let period = config.heartbeat;
        let stop = Arc::new(AtomicBool::new(false));
        let stopper = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("arena-lease-heartbeat".into())
            .spawn(move || {
                while !stopper.load(Ordering::Acquire) {
                    match broker.heartbeat(lease.clone()) {
                        Ok(status) => {
                            if status.get("status").and_then(Value::as_str) != Some("ACTIVE") {
                                lost.store(true, Ordering::Release);
                                return;
                            }
                        }
                        Err(_) => {
                            // A lease that cannot be refreshed may already have been stolen.
                            lost.store(true, Ordering::Release);
                            return;
                        }
                    }
                    let mut waited = Duration::ZERO;
                    while waited < period && !stopper.load(Ordering::Acquire) {
                        let slice = Duration::from_millis(50).min(period - waited);
                        thread::sleep(slice);
                        waited += slice;
                    }
                }
            })
            .map_err(|error| WorkerError::new("HEARTBEAT_UNAVAILABLE", error.to_string()))?;
        Ok(Self { stop, thread: Some(thread) })
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The workload consumer. One instance claims, runs and completes one attempt at a time.
pub struct Worker<F: WorkloadFactory = RunscWorkloadFactory, R: SandboxRunner = RunscSandboxRunner> {
    config: WorkerConfig,
    broker: BrokerClient,
    factory: F,
    runner: R,
    quarantined: AtomicBool,
}

impl Worker<RunscWorkloadFactory, RunscSandboxRunner> {
    pub fn new(config: WorkerConfig) -> Result<Self, WorkerError> {
        let factory = RunscWorkloadFactory::new(config.runsc.clone());
        let runner = RunscSandboxRunner::new(config.runsc.clone());
        Self::with_runner(config, factory, runner)
    }
}

impl<F: WorkloadFactory> Worker<F, RunscSandboxRunner> {
    /// A worker with a scripted workload factory and the production toolchain runner.
    pub fn with_factory(config: WorkerConfig, factory: F) -> Result<Self, WorkerError> {
        let runner = RunscSandboxRunner::new(config.runsc.clone());
        Self::with_runner(config, factory, runner)
    }
}

impl<F: WorkloadFactory, R: SandboxRunner> Worker<F, R> {
    pub fn with_runner(config: WorkerConfig, factory: F, runner: R) -> Result<Self, WorkerError> {
        config.validate()?;
        Ok(Self {
            broker: BrokerClient::new(config.broker_socket.clone()),
            config,
            factory,
            runner,
            quarantined: AtomicBool::new(false),
        })
    }

    pub fn config(&self) -> &WorkerConfig {
        &self.config
    }

    /// A refused workload teardown means this host may still hold a workload, so it must not be
    /// handed another attempt.
    pub fn quarantined(&self) -> bool {
        self.quarantined.load(Ordering::Acquire)
    }

    /// Claim one job this worker can run. `Ok(None)` means there is nothing assignable right now.
    pub fn claim(&self) -> Result<Option<Claim>, WorkerError> {
        if self.quarantined() {
            return Err(WorkerError::new("NODE_QUARANTINED", "cleanup was not confirmed; refusing to claim"));
        }
        let claimed = self
            .broker
            .claim(self.config.capacity(), json!({ "jobTypes": self.config.job_types() }))
            .map_err(|error| WorkerError::new("BROKER_CLAIM_FAILED", error.to_string()))?;
        if claimed.is_null() {
            return Ok(None);
        }
        parse_claim(claimed).map(Some)
    }

    /// Claim, run and complete one attempt. Every failure carries a structured code and submits
    /// nothing; the lease is deliberately left for the broker's reconciler.
    pub fn run_once(&self) -> Result<Option<RunReport>, WorkerError> {
        let Some(claim) = self.claim()? else {
            return Ok(None);
        };
        match claim.job_type.as_str() {
            "GAME" | "TEST_GAME" => self.run_game(claim),
            "BUILD" | "TEST_BUILD" => self.run_build(claim),
            // `parse_claim` admits only types this worker offers; anything else is refused rather
            // than guessed into a game or a build.
            other => Err(WorkerError::new("JOB_TYPE_UNSUPPORTED", format!("this worker does not run {other}"))),
        }
    }

    /// GAME/TEST_GAME: one match, driven by the same bridge, budgets and evidence. A private test
    /// differs only in what it is *called*: the control plane pinned its opponent, and its outcome
    /// is recorded on the snapshot rather than as an official result — neither of which the worker
    /// may restate, so nothing about the queue appears in the submitted evidence.
    fn run_game(&self, claim: Claim) -> Result<Option<RunReport>, WorkerError> {
        if self.config.max_game_slots == 0 {
            return Err(WorkerError::new("CONFIG_INVALID", "this worker offers no game slots"));
        }
        let assignment = parse_assignment(&claim.payload, &self.config.runtime_profile_digest)?;
        // The lease's queue and the assignment's own job type must agree: a private test is never
        // played as an official game (or the reverse) on the strength of the claim alone.
        if assignment.job_type.name() != claim.job_type {
            return Err(WorkerError::new("LEASE_MISMATCH", "assignment job type does not match the lease"));
        }
        if assignment.attempt_id != claim.attempt_id {
            return Err(WorkerError::new("LEASE_MISMATCH", "assignment attempt does not match the lease"));
        }
        if assignment.game_id != claim.target_id {
            return Err(WorkerError::new("LEASE_MISMATCH", "assignment game does not match the claimed target"));
        }
        if claim.deployment_generation == 0 {
            return Err(WorkerError::new("LEASE_MISMATCH", "lease generation must be positive"));
        }
        let attempt = materialize(
            &assignment,
            &self.config.attempt_root,
            &self.config.cgroup_root,
            &self.config.runtime_rootfs,
        )?;
        let lease_lost = Arc::new(AtomicBool::new(false));
        let mut heartbeat = Heartbeat::start(&self.config, claim.lease.clone(), Arc::clone(&lease_lost))?;
        let live = if claim.job_type == "GAME" { Some((&self.broker, claim.lease.clone())) } else { None };
        let played = play(&assignment, &attempt, &self.factory, Arc::clone(&lease_lost), live);
        let played = match played {
            Ok(played) => played,
            Err(error) => {
                self.quarantine_when(&error);
                return Err(error);
            }
        };
        if lease_lost.load(Ordering::Acquire) {
            return Err(WorkerError::new("LEASE_LOST", "lease was lost while the match was running"));
        }
        let session = parse_session_evidence(&played.evidence, played.observations)?;
        let evidence = completion_evidence(&assignment, &session)?;
        let execution_status = evidence
            .get("gameEvidence")
            .and_then(|game| game.get("executionStatus"))
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_owned();
        // The submitted reason is what the broker accepted (it may be a measured forfeit code,
        // not the engine's own `BOT_FORFEIT`).
        let reason = evidence
            .get("gameEvidence")
            .and_then(|game| game.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or(&session.reason)
            .to_owned();
        let observation_count = evidence.get("observations").and_then(Value::as_array).map_or(0, Vec::len);
        self.prepare_and_complete(&claim, evidence, &mut heartbeat)?;
        Ok(Some(RunReport {
            attempt_id: claim.attempt_id,
            target_id: claim.target_id,
            job_type: claim.job_type,
            outcome: execution_status,
            detail: reason,
            observations: observation_count,
            bytes: 0,
        }))
    }

    /// BUILD/TEST_BUILD: probe the toolchain, compile when the language has a step, smoke-test the
    /// INIT, then read the artifact's digest and size back from the output directory.
    fn run_build(&self, claim: Claim) -> Result<Option<RunReport>, WorkerError> {
        let build = parse_build_assignment(&claim.payload)?;
        if build.target_id != claim.target_id {
            return Err(WorkerError::new("LEASE_MISMATCH", "assignment target does not match the claimed target"));
        }
        if claim.deployment_generation == 0 {
            return Err(WorkerError::new("LEASE_MISMATCH", "lease generation must be positive"));
        }
        let toolchains = self
            .config
            .toolchains
            .as_ref()
            .ok_or_else(|| WorkerError::new("CONFIG_INVALID", "build slots require the operator's toolchain profiles"))?;
        let output_root = self
            .config
            .artifact_output_root
            .clone()
            .ok_or_else(|| WorkerError::new("CONFIG_INVALID", "build slots require the artifact output root"))?;
        let profile = toolchains.profile(build.language);
        // The assignment declares the identity it expects; anything else is not this worker's work.
        if !profile.matches(&build.toolchain) {
            return Err(WorkerError::new("TOOLCHAIN_MISMATCH", "the assignment declares a different toolchain"));
        }
        let attempt = materialize_build(
            &build,
            &claim.attempt_id,
            &self.config.attempt_root,
            &self.config.cgroup_root,
            &profile.rootfs,
            &output_root,
        )?;
        let lease_lost = Arc::new(AtomicBool::new(false));
        let mut heartbeat = Heartbeat::start(&self.config, claim.lease.clone(), Arc::clone(&lease_lost))?;
        let verdict = self.execute_build(&build, &claim.attempt_id, &attempt, profile, Arc::clone(&lease_lost));
        let verdict = match verdict {
            Ok(verdict) => verdict,
            Err(error) => {
                // A refused teardown means this host may still hold a workload: stop claiming.
                self.quarantine_when(&error);
                return Err(error);
            }
        };
        if lease_lost.load(Ordering::Acquire) {
            return Err(WorkerError::new("LEASE_LOST", "lease was lost while the build was running"));
        }
        let (evidence, outcome, detail, bytes) = match verdict {
            BuildVerdict::Ready { artifact, bytes } => {
                // The bytes travel before the completion: the gateway must hold them before it can
                // accept a READY verdict. Digest and size are the worker's own measurements.
                let size = bytes.len() as u64;
                self.stage_artifact(&claim.lease, &artifact, &bytes)?;
                (ready_evidence(&build, &artifact), "READY".to_owned(), "INIT_SMOKE".to_owned(), size)
            }
            BuildVerdict::Rejected { stage, diagnostic } => (
                rejected_evidence(&build, stage, &diagnostic),
                "SOURCE_REJECTED".to_owned(),
                stage.to_owned(),
                0,
            ),
        };
        self.prepare_and_complete(&claim, evidence, &mut heartbeat)?;
        Ok(Some(RunReport {
            attempt_id: claim.attempt_id,
            target_id: claim.target_id,
            job_type: claim.job_type,
            outcome,
            detail,
            observations: 0,
            bytes,
        }))
    }

    /// Everything between materialization and evidence. A returned `Err` is an infrastructure fault
    /// (no completion, the lease is left to the reconciler); `Ok(Rejected)` is a verdict about the
    /// submission.
    fn execute_build(
        &self,
        build: &BuildAssignment,
        attempt_id: &str,
        attempt: &MaterializedBuild,
        profile: &ToolchainProfile,
        lease_lost: Arc<AtomicBool>,
    ) -> Result<BuildVerdict, WorkerError> {
        self.probe_toolchain(&attempt.build, profile)?;

        // A compiler that fails is a verdict about the submission; a sandbox that fails is
        // infrastructure and submits nothing.
        if let Some(bundle) = attempt.build.compile_bundle.clone() {
            let compile = self
                .runner
                .run(&bundle, &attempt.build, build.limits.compile_wall())
                .map_err(|error| sandbox_worker_error("COMPILE_SANDBOX_FAILED", error))?;
            match compile {
                CommandOutcome::Exited { status: 0, .. } => {}
                CommandOutcome::Exited { status, diagnostic, .. } => {
                    return Ok(BuildVerdict::Rejected {
                        stage: "COMPILE",
                        diagnostic: format!("COMPILE_FAILED: the compiler exited with status {status}: {}", sanitize_diagnostic(&diagnostic)),
                    })
                }
                CommandOutcome::WallExpired { diagnostic, .. } | CommandOutcome::CpuExpired { diagnostic, .. } => {
                    return Ok(BuildVerdict::Rejected {
                        stage: "COMPILE",
                        diagnostic: format!("COMPILE_TIMEOUT: {}", command_diagnostic(&diagnostic)),
                    })
                }
                CommandOutcome::OutputLimit { .. } => {
                    return Ok(BuildVerdict::Rejected {
                        stage: "COMPILE",
                        diagnostic: "COMPILE_OUTPUT_LIMIT: the compiler produced more diagnostics than the sandbox bounds"
                            .to_owned(),
                    })
                }
            }
        }

        // The INIT smoke test, through the engine's own session machinery and the assignment's own
        // INIT limits.
        match run_init_smoke(build, attempt_id, attempt, &self.factory, lease_lost)? {
            SmokeOutcome::Ready => {}
            SmokeOutcome::Rejected(detail) => {
                return Ok(BuildVerdict::Rejected {
                    stage: "INIT_SMOKE",
                    diagnostic: format!("INIT_SMOKE_FAILED: {detail}"),
                })
            }
        }

        self.artifact(build, attempt)
    }

    /// The toolchain identity probe: the version the sandbox reports must contain the version the
    /// operator declared. Any mismatch is an operator fault, never a verdict about a submission.
    fn probe_toolchain(&self, layout: &BuildLayout, profile: &ToolchainProfile) -> Result<(), WorkerError> {
        let probe = self
            .runner
            .run(&layout.toolchain_bundle, layout, PROBE_WALL)
            .map_err(|error| sandbox_worker_error("TOOLCHAIN_PROBE_FAILED", error))?;
        match probe {
            CommandOutcome::Exited { status: 0, diagnostic, .. } if profile.matched_version(&diagnostic) => Ok(()),
            CommandOutcome::Exited { status: 0, .. } => Err(WorkerError::new(
                "TOOLCHAIN_VERSION_MISMATCH",
                "the toolchain image does not report the declared version",
            )),
            CommandOutcome::Exited { status, .. } => Err(WorkerError::new(
                "TOOLCHAIN_PROBE_FAILED",
                format!("the toolchain probe exited with status {status}"),
            )),
            CommandOutcome::WallExpired { .. } | CommandOutcome::CpuExpired { .. } => {
                Err(WorkerError::new("TOOLCHAIN_PROBE_FAILED", "the toolchain probe exceeded its CPU or wall bound"))
            }
            CommandOutcome::OutputLimit { .. } => Err(WorkerError::new(
                "TOOLCHAIN_PROBE_FAILED",
                "the toolchain probe produced unbounded output",
            )),
        }
    }

    /// Read the artifact this build produced. A compile language's artifact is the file the compile
    /// step wrote; an interpreted language's artifact is the granted source the control plane
    /// already holds, identified by the grant's own digest and size.
    fn artifact(&self, build: &BuildAssignment, attempt: &MaterializedBuild) -> Result<BuildVerdict, WorkerError> {
        let key = artifact_key(build.language, &build.manifest_digest, &build.toolchain);
        if build.language.produces_artifact() {
            let path = attempt.build.artifact_path();
            let (bytes, digest) = read_artifact(&path)?;
            let size_bytes = bytes.len() as u64;
            let entrypoint = ARTIFACT_NAME.to_owned();
            Ok(BuildVerdict::Ready {
                artifact: Artifact { key, digest, size_bytes, entrypoint },
                bytes,
            })
        } else {
            // The granted source is read again so the staged bytes are the bytes the gateway pinned.
            let bytes = build.source.read(MAX_SOURCE_BYTES)?;
            if bytes.len() as u64 != build.source.size_bytes {
                return Err(WorkerError::new("ARTIFACT_MISMATCH", "the granted source changed size"));
            }
            Ok(BuildVerdict::Ready {
                artifact: Artifact {
                    key,
                    digest: build.source.digest,
                    size_bytes: build.source.size_bytes,
                    entrypoint: source_artifact_entrypoint(&build.entrypoint)?,
                },
                bytes,
            })
        }
    }

    /// Upload one artifact through the gateway's chunked staging op. Both the digest and the size
    /// are the worker's own measurements; the gateway verifies the whole file against them.
    fn stage_artifact(&self, lease: &Value, artifact: &Artifact, bytes: &[u8]) -> Result<(), WorkerError> {
        if bytes.is_empty() {
            return Err(WorkerError::new("ARTIFACT_EMPTY", "the artifact is empty"));
        }
        if bytes.len() as u64 != artifact.size_bytes {
            return Err(WorkerError::new("ARTIFACT_MISMATCH", "the artifact size changed while staging"));
        }
        let measured: [u8; 32] = Sha256::digest(bytes).into();
        if measured != artifact.digest {
            return Err(WorkerError::new("ARTIFACT_MISMATCH", "the artifact digest changed while staging"));
        }
        let digest = hex(&artifact.digest);
        let mut offset = 0;
        while offset < bytes.len() {
            let end = (offset + STAGE_CHUNK_BYTES).min(bytes.len());
            let response = self
                .broker
                .request(
                    "stageArtifact",
                    json!({
                        "lease": lease,
                        "chunk": {
                            "offset": offset,
                            "data": encode_base64(&bytes[offset..end]),
                            "digest": digest,
                            "sizeBytes": artifact.size_bytes,
                            "entrypoint": artifact.entrypoint,
                        },
                    }),
                )
                .map_err(|error| WorkerError::new("ARTIFACT_STAGE_FAILED", error.to_string()))?;
            let received = response.get("received").and_then(Value::as_u64).unwrap_or(u64::MAX);
            let staged = response.get("staged").and_then(Value::as_bool).unwrap_or(false);
            if end == bytes.len() {
                if !staged || received != artifact.size_bytes {
                    return Err(WorkerError::new(
                        "ARTIFACT_STAGE_INCOMPLETE",
                        "the gateway did not confirm the staged artifact",
                    ));
                }
                if let Some(reported) = response.get("digest").and_then(Value::as_str) {
                    if reported != digest {
                        return Err(WorkerError::new("ARTIFACT_STAGE_MISMATCH", "the gateway reported another digest"));
                    }
                }
            } else if staged || received != end as u64 {
                return Err(WorkerError::new(
                    "ARTIFACT_STAGE_INCOMPLETE",
                    "the gateway reported unexpected staging progress",
                ));
            }
            offset = end;
        }
        Ok(())
    }

    fn prepare_and_complete(&self, claim: &Claim, evidence: Value, heartbeat: &mut Heartbeat) -> Result<(), WorkerError> {
        let pinned = self
            .broker
            .prepare_completion(claim.lease.clone(), evidence)
            .map_err(|error| WorkerError::new("BROKER_PREPARE_FAILED", error.to_string()))?;
        let data = pinned
            .get("data")
            .ok_or_else(|| WorkerError::new("BROKER_MALFORMED", "prepareCompletion returned no data"))?;
        heartbeat.stop(); // The durable prepare pin, not execution/upload, ends lease renewal.
        let completion = json!({
            "completionId": required(data, "completionId")?,
            "evidenceDigest": required(data, "evidenceDigest")?,
            "deploymentGeneration": claim.deployment_generation,
        });
        let receipt = self
            .broker
            .complete(completion)
            .map_err(|error| WorkerError::new("BROKER_COMPLETE_FAILED", error.to_string()))?;
        if receipt.get("data").and_then(|data| data.get("state")).and_then(Value::as_str) != Some("ACCEPTED") {
            return Err(WorkerError::new("COMPLETION_NOT_ACCEPTED", "broker did not accept the completion"));
        }
        Ok(())
    }

    fn quarantine_when(&self, error: &WorkerError) {
        if error.code() == "SANDBOX_TERMINATION_UNCONFIRMED" {
            self.quarantined.store(true, Ordering::Release);
        }
    }

    /// Claim and run until stopped or until a failure that requires an operator.
    pub fn run(&self) -> Result<(), WorkerError> {
        loop {
            match self.run_once() {
                Ok(Some(report)) => {
                    eprintln!(
                        "arena-worker completed attempt={} target={} job={} outcome={} detail={} observations={} bytes={}",
                        report.attempt_id,
                        report.target_id,
                        report.job_type,
                        report.outcome,
                        report.detail,
                        report.observations,
                        report.bytes
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!("arena-worker attempt aborted {} ({})", error.code(), error.message());
                    if self.quarantined() || error.code() == "CONFIG_INVALID" {
                        return Err(error);
                    }
                }
            }
            if self.config.once {
                return Ok(());
            }
            thread::sleep(self.config.poll);
        }
    }
}

/// A compiled artifact's entrypoint is a plain file name, so an interpreted language's nested
/// source entrypoint is reduced to its file name (and must satisfy the same rule).
fn source_artifact_entrypoint(entrypoint: &str) -> Result<String, WorkerError> {
    let name = entrypoint.rsplit('/').next().unwrap_or_default();
    crate::materialize::safe_artifact_entrypoint(name)?;
    Ok(name.to_owned())
}

/// Read the compiled artifact the toolchain wrote into the output directory. The digest and size
/// measured here are the only ones the worker ever reports.
fn read_artifact(path: &Path) -> Result<(Vec<u8>, [u8; 32]), WorkerError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| WorkerError::new("ARTIFACT_MISSING", format!("{path:?}: {error}")))?;
    if !metadata.file_type().is_file() {
        return Err(WorkerError::new("ARTIFACT_MISSING", "the toolchain produced no regular artifact"));
    }
    if metadata.len() == 0 {
        return Err(WorkerError::new("ARTIFACT_EMPTY", "the toolchain produced an empty artifact"));
    }
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(WorkerError::new("ARTIFACT_TOO_LARGE", "the artifact exceeds the accepted bound"));
    }
    let bytes = fs::read(path).map_err(|error| WorkerError::new("ARTIFACT_UNREADABLE", error.to_string()))?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    Ok((bytes, digest))
}

#[cfg(test)]
mod tests {
    #[test]
    fn command_leaf_can_be_reused_for_init_only_when_private_and_empty() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!("arena-leaf-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let leaf = root.join("1");
        // A command can leave an empty frozen leaf behind before INIT uses the same path.
        prepare_workload_leaf(&leaf).unwrap();
        fs::write(leaf.join("cgroup.events"), "populated 0\nfrozen 1\n").unwrap();
        assert!(prepare_workload_leaf(&leaf).is_ok());
        fs::write(leaf.join("cgroup.events"), "populated 1\nfrozen 1\n").unwrap();
        assert!(prepare_workload_leaf(&leaf).is_err());
        fs::write(leaf.join("cgroup.events"), "populated 0\nfrozen 0\n").unwrap();
        assert!(prepare_workload_leaf(&leaf).is_err());
        fs::write(leaf.join("cgroup.events"), "populated 0\nfrozen 1\n").unwrap();
        fs::set_permissions(&leaf, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(prepare_workload_leaf(&leaf).is_err());
        fs::set_permissions(&leaf, fs::Permissions::from_mode(0o700)).unwrap();
        let link = root.join("link");
        symlink(&leaf, &link).unwrap();
        assert!(prepare_workload_leaf(&link).is_err());
        if unsafe { libc::geteuid() } == 0 {
            let path = std::ffi::CString::new(leaf.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::chown(path.as_ptr(), 12345, 12345) }, 0);
            assert!(prepare_workload_leaf(&leaf).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
    use super::*;
    use arena_runner::manifest::parse_manifest;

    fn profile(rootfs: &str, version: &str, flags: &[&str]) -> Value {
        json!({
            "rootfs": rootfs,
            "imageDigest": "ab".repeat(32),
            "version": version,
            "flags": flags,
        })
    }

    fn document() -> String {
        json!({
            "PYTHON": profile("/opt/toolchains/python", "3.12.3", &["-m", "py_compile"]),
            "TYPESCRIPT": profile("/opt/toolchains/node", "22.5.0", &[]),
            "CPP": profile("/opt/toolchains/cpp", "13.2.0", &["-O2", "-std=c++20"]),
        })
        .to_string()
    }

    #[test]
    fn toolchain_documents_are_strict_and_explicit() {
        let toolchains = Toolchains::parse(&document()).expect("valid document");
        assert_eq!(toolchains.profile(Language::Cpp).rootfs, PathBuf::from("/opt/toolchains/cpp"));
        assert_eq!(toolchains.profile(Language::Cpp).flags, vec!["-O2", "-std=c++20"]);
        assert!(toolchains.profile(Language::Python).matched_version(b"Python 3.12.3\n"));
        assert!(!toolchains.profile(Language::Python).matched_version(b"Python 3.11.1\n"));

        let missing = json!({ "PYTHON": profile("/opt/py", "3.12.3", &[]) }).to_string();
        assert_eq!(Toolchains::parse(&missing).expect_err("missing languages").code(), "CONFIG_INVALID");

        let mut relative = json!({
            "PYTHON": profile("relative/py", "3.12.3", &[]),
            "TYPESCRIPT": profile("/opt/node", "22.5.0", &[]),
            "CPP": profile("/opt/cpp", "13.2.0", &[]),
        });
        assert_eq!(Toolchains::parse(&relative.to_string()).expect_err("relative rootfs").code(), "CONFIG_INVALID");

        relative["PYTHON"] = profile("/opt/py", "3.12.3", &[]);
        relative["TYPESCRIPT"] = profile("/opt/node", "22.5.0", &["--experimental"]);
        assert_eq!(
            Toolchains::parse(&relative.to_string())
                .expect_err("flags on a language without a compile step")
                .code(),
            "CONFIG_INVALID"
        );
    }

    #[test]
    fn toolchain_identity_must_match_the_assignment() {
        let toolchains = Toolchains::parse(&document()).expect("valid document");
        let profile = toolchains.profile(Language::Cpp);
        let toolchain = Toolchain {
            language: Language::Cpp,
            image_digest: profile.image_digest,
            version: profile.version.clone(),
            flags: profile.flags.clone(),
        };
        assert!(profile.matches(&toolchain));
        assert!(!profile.matches(&Toolchain { flags: vec!["-O3".to_owned()], ..toolchain.clone() }));
        assert!(!profile.matches(&Toolchain { version: "12.1.0".to_owned(), ..toolchain.clone() }));
        assert!(!profile.matches(&Toolchain { image_digest: [0; 32], ..toolchain }));
    }

    #[test]
    fn smoke_manifest_parses_into_a_non_terminal_board() {
        let manifest = smoke_manifest("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111");
        let digest: [u8; 32] = Sha256::digest(&manifest).into();
        let parsed = parse_manifest(&manifest, &digest).expect("the smoke board is a valid manifest");
        assert_eq!(parsed.pieces.len(), 2);
        assert_eq!(parsed.max_ply, SMOKE_MAX_TURNS);
        assert_eq!(parsed.game_id, "22222222-2222-4222-8222-222222222222");
    }

    #[test]
    fn base64_encoding_matches_the_wire_format() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(&[0xff, 0x00, 0x7f]), "/wB/");
    }

    #[test]
    fn config_requires_every_operator_prerequisite_for_builds() {
        let base = |build_slots: u32, toolchains: Option<Toolchains>, output: Option<PathBuf>| WorkerConfig {
            broker_socket: PathBuf::from("/run/arena/broker.sock"),
            runsc: PathBuf::from("/opt/arena/runsc"),
            runtime_rootfs: PathBuf::from("/opt/arena/rootfs"),
            cgroup_root: PathBuf::from("/sys/fs/cgroup/arena"),
            attempt_root: PathBuf::from("/var/lib/arena/attempts"),
            runtime_profile_digest: "a".repeat(64),
            max_game_slots: 1,
            max_build_slots: build_slots,
            toolchains,
            artifact_output_root: output,
            heartbeat: Duration::from_secs(5),
            poll: Duration::from_secs(1),
            once: true,
        };
        assert!(base(0, None, None).validate().is_ok());
        assert_eq!(base(1, None, None).validate().expect_err("toolchains").code(), "CONFIG_INVALID");
        let parsed = Toolchains::parse(&document()).expect("valid document");
        assert_eq!(
            base(1, Some(parsed.clone()), None).validate().expect_err("output root").code(),
            "CONFIG_INVALID"
        );
        assert!(base(1, Some(parsed), Some(PathBuf::from("/var/lib/arena/artifacts"))).validate().is_ok());
        assert_eq!(base(0, None, None).job_types(), vec!["GAME", "TEST_GAME"]);
        assert_eq!(base(2, None, None).job_types(), vec!["GAME", "TEST_GAME", "BUILD", "TEST_BUILD"]);
    }

    #[test]
    fn artifacts_of_interpreted_languages_use_the_source_identity() {
        let build = |entrypoint: &str| BuildAssignment {
            job_type: crate::materialize::BuildJobType::Build,
            target_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            language: Language::Python,
            entrypoint: entrypoint.to_owned(),
            manifest_digest: [3; 32],
            toolchain: Toolchain {
                language: Language::Python,
                image_digest: [4; 32],
                version: "3.12.3".to_owned(),
                flags: vec!["-m".to_owned(), "py_compile".to_owned()],
            },
            source: crate::materialize::Grant {
                path: PathBuf::from("/var/lib/arena/spool/source.zip"),
                digest: [5; 32],
                size_bytes: 128,
            },
            limits: crate::materialize::BuildLimits {
                compile_wall_ms: 30_000,
                init_wall_ms: 5_000,
                init_cpu_usec: 500_000,
            },
        };
        assert_eq!(source_artifact_entrypoint("main.py").expect("plain"), "main.py");
        assert_eq!(source_artifact_entrypoint("bot/main.py").expect("nested"), "main.py");
        assert_eq!(
            source_artifact_entrypoint("bot/.hidden").expect_err("not a plain name").code(),
            "ASSIGNMENT_INVALID"
        );
        // The artifact key is the same construction the control plane recomputes.
        let build = build("main.py");
        assert_eq!(
            artifact_key(Language::Python, &build.manifest_digest, &build.toolchain),
            format!("compiled/PYTHON/{}/{}", hex(&build.manifest_digest), hex(&Sha256::digest(
                format!("PYTHON\n{}\n3.12.3\n-m\npy_compile\n", hex(&build.toolchain.image_digest)).as_bytes()
            )))
        );
    }

    #[test]
    fn smoke_classification_separates_verdicts_from_infrastructure() {
        let ready = Observation {
            side: 1,
            ply: 0,
            kind: "RESPONSE",
            cpu_usec: 10,
            wall_usec: 20,
            response: Some(b"{\"status\":\"READY\"}\n".to_vec()),
        };
        assert!(matches!(
            classify_smoke_observation(std::slice::from_ref(&ready)).expect("measured"),
            SmokeOutcome::Ready
        ));
        let not_ready = Observation { response: Some(b"{\"status\":\"PLAYING\"}\n".to_vec()), ..ready.clone() };
        assert!(matches!(
            classify_smoke_observation(&[not_ready]).expect("measured"),
            SmokeOutcome::Rejected(detail) if detail.contains("did not answer READY")
        ));
        let malformed = Observation { kind: "PROTOCOL_ERROR", response: None, ..ready.clone() };
        assert!(matches!(
            classify_smoke_observation(&[malformed]).expect("measured"),
            SmokeOutcome::Rejected(_)
        ));
        assert_eq!(classify_smoke_observation(&[]).expect_err("unmeasured").code(), "SMOKE_UNMEASURED");
        // A violation the sandbox measured (counters survived) is a verdict...
        let measured = Observation { kind: "PROTOCOL_ERROR", response: None, cpu_usec: 900, wall_usec: 1200, ..ready.clone() };
        assert!(matches!(
            classify_smoke_observation(&[measured]).expect("measured verdict"),
            SmokeOutcome::Rejected(detail) if detail.contains("JSON object")
        ));
        // ...while an unmeasured failure of the same shape stays infrastructure and retries: it may
        // not become a rejection the submission did not earn.
        let bot_fault = WorkerError::new("BOT_PROTOCOL_VIOLATION", "Bot broke the response protocol");
        assert_eq!(classify_smoke_failure(&bot_fault, &[]).expect_err("unmeasured").code(), "BOT_PROTOCOL_VIOLATION");
        for code in ["WORKLOAD_LAUNCH_FAILED", "SANDBOX_TERMINATION_UNCONFIRMED", "SANDBOX_FAILURE", "LEASE_LOST"] {
            let fault = WorkerError::new(code, "sandbox fault");
            assert_eq!(classify_smoke_failure(&fault, &[]).expect_err("infrastructure").code(), code);
        }
    }
}
