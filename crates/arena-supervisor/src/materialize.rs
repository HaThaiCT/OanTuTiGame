//! Assignment validation and per-attempt materialization for official native work.
//!
//! Nothing here trusts the broker payload. The canonical manifest digest is recomputed, every
//! granted file is read exactly once and proven against its pinned size and SHA-256 *before* a
//! single byte reaches the disk, the pinned ZIP is re-validated against the intake rules the
//! control plane enforces, every path is proven relative and non-traversing, sizes are capped, and
//! the on-disk layout is created with restrictive permissions. The operator configuration —
//! attempt root, delegated cgroup root, runtime/toolchain rootfs and the artifact output root — is
//! the only thing that decides where a workload runs and what it runs from; no payload field can
//! name a command, a host path or a cgroup.
//!
//! Layout created per attempt (never reused):
//!
//! ```text
//! <attempt root>/<attempt id>/<side>/workspace/...      materialized Bot source, mode 0600
//! <attempt root>/<attempt id>/<side>/bundle/*.json      OCI bundles referencing a rootfs
//! <attempt root>/<attempt id>/<side>/state/             runsc state directory
//! <cgroup root>/<attempt id>/<side>/                    workload cgroup named by the bundle
//! ```
//!
//! Two shapes are supported, both from the frozen `jobs.ts` contract:
//!
//! * GAME — two sides. An interpreted language materializes the granted source ZIP and runs it
//!   through the operator rootfs interpreter; a compile language (CPP) never compiles here, it runs
//!   the granted compiled artifact from a read-only `/out` mount, which is
//!   `<attempt root>/<attempt id>/<side>/output/` (mode 0700).
//! * BUILD/TEST_BUILD — one side plus a *compile bundle* whose process is the operator-fixed
//!   toolchain command and whose `/out` mount is the only writable path: the artifact directory is
//!   `<artifact output root>/<attempt id>/1/`, a fresh 0700 directory. Namespace root maps to the
//!   supervisor host identity, so no other host identity needs access. Removed with the attempt.

use arena_runner::manifest::{parse_manifest, ParsedManifest};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Mirrors the intake caps enforced by the control plane's artifact store.
pub const MAX_REGULAR_FILES: usize = 128;
pub const MAX_FILE_BYTES: usize = 256 * 1024;
pub const MAX_EXPANDED_BYTES: usize = 4 * 1024 * 1024;
/// Mirrors `artifact-store.ts` `MAX_ZIP_BYTES`: a submission ZIP is never larger.
pub const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
/// Longest compiled artifact the worker will read, hash and upload. Mirrors the control plane's
/// `MAX_COMPILED_BYTES`, so the worker refuses a too-large artifact instead of uploading one the
/// gateway would reject.
pub const MAX_ARTIFACT_BYTES: u64 = 8 * 1024 * 1024;
/// Longest accepted relative path inside a Bot workspace.
pub const MAX_PATH_CHARS: usize = 512;
/// Longest accepted game, mirroring the broker's own trace bound.
pub const MAX_TURNS: u32 = 300;
/// Longest diagnostic accepted into build evidence (mirrors the control plane's limit).
pub const MAX_DIAGNOSTIC_CHARS: usize = 2000;

/// Compiled or otherwise non-source artifacts are never part of a Bot workspace.
const FORBIDDEN_EXTENSIONS: [&str; 13] = [
    ".exe", ".so", ".dll", ".dylib", ".bin", ".pyc", ".pyo", ".pyd", ".o", ".a", ".obj", ".class",
    ".jar",
];

const WORKSPACE_DIR: &str = "workspace";
const OUTPUT_DIR: &str = "output";
const BUNDLE_DIR: &str = "bundle";
const STATE_DIR: &str = "state";
const RUN_BUNDLE: &str = "run";
const COMPILE_BUNDLE: &str = "compile";
const TOOLCHAIN_BUNDLE: &str = "toolchain";

/// Container-absolute paths the bundles are built from. The sandbox sees only these.
pub const WORKSPACE_MOUNT: &str = "/workspace";
pub const OUTPUT_MOUNT: &str = "/out";
/// Name of the compiled artifact inside the output directory, mirroring the dev pipeline's
/// `<workDir>/bot`.
pub const ARTIFACT_NAME: &str = "bot";
/// Rootless sandbox identity maps to the supervisor; output stays host-private.
const OUTPUT_DIR_MODE: u32 = 0o700;

/// Structured validation/materialization failure. The code is a stable identifier for logs and
/// for the agent that owns the attempt; the message is never derived from Bot input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeError {
    code: &'static str,
    message: String,
}

impl MaterializeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for MaterializeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MaterializeError {}

impl From<io::Error> for MaterializeError {
    fn from(error: io::Error) -> Self {
        Self::new("io", format!("{error}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Python,
    TypeScript,
    Cpp,
}

impl Language {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "PYTHON" => Some(Self::Python),
            "TYPESCRIPT" => Some(Self::TypeScript),
            "CPP" => Some(Self::Cpp),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Python => "PYTHON",
            Self::TypeScript => "TYPESCRIPT",
            Self::Cpp => "CPP",
        }
    }

    /// Whether the language has a compile step at all. TYPESCRIPT has none: a syntax error there
    /// surfaces as an INIT smoke failure, which is the same gate a match would apply. PYTHON's
    /// step is a syntax check whose bytecode cache is not the program that runs.
    pub fn has_compile_step(self) -> bool {
        !matches!(self, Self::TypeScript)
    }

    /// Whether the compile step produces a runnable artifact in the output directory. Only a
    /// native compile does; an interpreted language's "artifact" is the granted source itself.
    pub fn produces_artifact(self) -> bool {
        matches!(self, Self::Cpp)
    }

    fn accepts_entrypoint(self, entrypoint: &str) -> bool {
        match self {
            Self::Python => entrypoint.ends_with(".py"),
            Self::TypeScript => entrypoint.ends_with(".ts") || entrypoint.ends_with(".js"),
            Self::Cpp => entrypoint.ends_with(".cpp"),
        }
    }

    /// Interpreter/compiler path inside the operator-provided rootfs image. `execve` does not
    /// search `PATH`, so the path is absolute and the image must provide it.
    pub fn interpreter(self) -> &'static str {
        match self {
            Self::Python => "/usr/bin/python3",
            Self::TypeScript => "/usr/bin/node",
            Self::Cpp => "/usr/bin/g++",
        }
    }

    /// Container argv that runs one materialized program. Interpreted languages get their
    /// interpreter; a compiled artifact is executed directly (no shell, no `PATH` lookup).
    pub fn run_argv(self, container_path: &str) -> Vec<String> {
        match self {
            Self::Python | Self::TypeScript => {
                vec![self.interpreter().to_owned(), container_path.to_owned()]
            }
            Self::Cpp => vec![container_path.to_owned()],
        }
    }

    /// Container argv of the compile step. `flags` are the operator's canonical flags; the source
    /// path and the artifact path are appended by the worker, never by a payload.
    pub fn compile_argv(self, flags: &[String], source_path: &str, artifact_path: &str) -> Vec<String> {
        if !self.has_compile_step() {
            return Vec::new();
        }
        let mut argv = vec![self.interpreter().to_owned()];
        argv.extend(flags.iter().cloned());
        match self {
            Self::Python => argv.push(source_path.to_owned()),
            Self::Cpp => {
                // The extraction root joins the include path exactly as the dev pipeline does, so a
                // bot that `#include "sibling.hpp"` compiles the same way.
                argv.push("-I".to_owned());
                argv.push(WORKSPACE_MOUNT.to_owned());
                argv.push(source_path.to_owned());
                argv.push("-o".to_owned());
                argv.push(artifact_path.to_owned());
            }
            Self::TypeScript => unreachable!("a language without a compile step returns above"),
        }
        argv
    }

    /// Container argv of the toolchain identity probe, run before any compile so the reported
    /// `toolchain.version` is measured inside the sandbox rather than echoed from configuration.
    pub fn version_argv(self) -> Vec<String> {
        vec![self.interpreter().to_owned(), "--version".to_owned()]
    }
}

/// A file the trusted gateway pinned for this attempt. The worker may read exactly this path and
/// must verify size then SHA-256 before the bytes are used for anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub path: PathBuf,
    pub digest: [u8; 32],
    pub size_bytes: u64,
}

impl Grant {
    /// Read the granted file with a hard bound, verifying length and digest before returning.
    ///
    /// A mismatch is never repairable: the caller aborts the attempt without submitting anything.
    pub fn read(&self, limit: u64) -> Result<Vec<u8>, MaterializeError> {
        if !self.path.is_absolute() {
            return Err(MaterializeError::new("GRANT_PATH_UNSAFE", "granted path must be absolute"));
        }
        if self.size_bytes == 0 || self.size_bytes > limit {
            return Err(MaterializeError::new("GRANT_SIZE_LIMIT", "granted size is out of the accepted range"));
        }
        let metadata = fs::symlink_metadata(&self.path)
            .map_err(|error| MaterializeError::new("GRANT_UNREADABLE", format!("{error}")))?;
        if !metadata.file_type().is_file() {
            return Err(MaterializeError::new("GRANT_UNREADABLE", "granted path is not a regular file"));
        }
        let file = File::open(&self.path).map_err(|error| MaterializeError::new("GRANT_UNREADABLE", format!("{error}")))?;
        let mut bytes = Vec::with_capacity(self.size_bytes.min(limit) as usize);
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| MaterializeError::new("GRANT_UNREADABLE", format!("{error}")))?;
        if bytes.len() as u64 != self.size_bytes {
            return Err(MaterializeError::new("GRANT_SIZE_MISMATCH", "granted file length disagrees with the grant"));
        }
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        if digest != self.digest {
            return Err(MaterializeError::new("GRANT_DIGEST_MISMATCH", "granted file digest disagrees with the grant"));
        }
        Ok(bytes)
    }
}

/// A granted compiled artifact: the pinned bytes plus the name the runtime should exec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactGrant {
    pub grant: Grant,
    pub entrypoint: String,
}

/// One side of a game, exactly as the gateway pinned it for this attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameBot {
    pub side: u8,
    pub language: Language,
    /// Source entrypoint inside the granted ZIP.
    pub entrypoint: String,
    /// The control plane's canonical project-manifest digest; shape-checked here because its
    /// canonical serialization belongs to the control plane.
    pub source_digest: [u8; 32],
    pub source: Grant,
    /// Compiled output for a compile language; absent when the language has no build step.
    pub artifact: Option<ArtifactGrant>,
}

/// Which durable game queue an assignment belongs to. Both are matches with the same sandbox and
/// observation rules; a private test additionally pins the opponent and leaves no official trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameJobType {
    Game,
    TestGame,
}

impl GameJobType {
    pub fn name(self) -> &'static str {
        match self {
            Self::Game => "GAME",
            Self::TestGame => "TEST_GAME",
        }
    }
}

/// Which kind of Bot the control plane pinned as a private test's opponent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestOpponentKind {
    /// The testing team's own latest READY submission.
    OwnSubmission,
    /// The repo baseline Bot.
    Baseline,
}

/// The opponent of a private test, exactly as the control plane pinned it. Only its shape is
/// checked here: the opponent is a control-plane fact and never appears in the completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestOpponent {
    pub kind: TestOpponentKind,
    pub label: String,
}

/// A verified assignment for either game queue. The manifest's own game id is the official game id
/// for a GAME and the private test id for a TEST_GAME; everything else is identical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub job_type: GameJobType,
    pub canonical_manifest: Vec<u8>,
    pub manifest_digest: [u8; 32],
    pub game_id: String,
    pub attempt_id: String,
    pub rules_revision: String,
    pub max_turns: u32,
    pub bots: [GameBot; 2],
    /// The opponent the control plane pinned for a private test; always `None` for an official game.
    pub opponent: Option<TestOpponent>,
}

/// Which durable build queue a BUILD job belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildJobType {
    Build,
    TestBuild,
}

impl BuildJobType {
    pub fn name(self) -> &'static str {
        match self {
            Self::Build => "BUILD",
            Self::TestBuild => "TEST_BUILD",
        }
    }
}

/// Compiler/runtime identity a build runs against. It is part of the build cache key, so a later
/// game never runs source that a different toolchain produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toolchain {
    pub language: Language,
    /// Rootfs digest of the image the compiler ran inside.
    pub image_digest: [u8; 32],
    pub version: String,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildLimits {
    pub compile_wall_ms: u64,
    pub init_wall_ms: u64,
    pub init_cpu_usec: u64,
}

impl BuildLimits {
    pub fn compile_wall(&self) -> Duration {
        Duration::from_millis(self.compile_wall_ms)
    }

    pub fn init_wall(&self) -> Duration {
        Duration::from_millis(self.init_wall_ms)
    }
}

/// Assignment the trusted gateway hands the worker for a BUILD/TEST_BUILD job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildAssignment {
    pub job_type: BuildJobType,
    pub target_id: String,
    pub language: Language,
    pub entrypoint: String,
    /// Project-manifest digest of the granted source ZIP; also the artifact key's source segment.
    pub manifest_digest: [u8; 32],
    pub toolchain: Toolchain,
    pub source: Grant,
    pub limits: BuildLimits,
}

/// Per-Bot paths and the operator-supplied cgroup this Bot is confined to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotLayout {
    pub side: u8,
    pub language: Language,
    /// Container argv built by materialization from the operator profile.
    pub program: Vec<String>,
    pub workspace: PathBuf,
    /// Present when the program runs a compiled artifact that must be exec'ed.
    pub output: Option<PathBuf>,
    pub bundle: PathBuf,
    pub state: PathBuf,
    pub cgroup: PathBuf,
}

/// The build half of an attempt: where the source lives, where the compiler writes and which
/// operator-fixed commands the sandbox runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildLayout {
    pub language: Language,
    pub entrypoint: String,
    pub target_id: String,
    pub workspace: PathBuf,
    pub output: PathBuf,
    /// Identity probe bundle (`<interpreter> --version`), always present.
    pub toolchain_bundle: PathBuf,
    /// Compile bundle; absent when the language has no compile step.
    pub compile_bundle: Option<PathBuf>,
    pub state: PathBuf,
    pub cgroup: PathBuf,
}

impl BuildLayout {
    /// Host path of the artifact the compile step produces.
    pub fn artifact_path(&self) -> PathBuf {
        self.output.join(ARTIFACT_NAME)
    }
}

/// A verified game assignment materialized on disk. Dropping it removes the whole attempt, so the
/// workspace never survives a completion, a failure or a panic in the caller.
#[derive(Debug)]
pub struct MaterializedAttempt {
    root: PathBuf,
    pub manifest: ParsedManifest,
    pub bots: [BotLayout; 2],
}

impl MaterializedAttempt {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn layout(&self, side: u8) -> Option<&BotLayout> {
        self.bots.iter().find(|layout| layout.side == side)
    }
}

impl Drop for MaterializedAttempt {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A verified build assignment materialized on disk, plus the run-phase layout the INIT smoke test
/// launches. Dropping it removes the whole attempt and the artifact directory it owns.
#[derive(Debug)]
pub struct MaterializedBuild {
    root: PathBuf,
    output: Option<PathBuf>,
    pub build: BuildLayout,
    pub bot: BotLayout,
}

impl MaterializedBuild {
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for MaterializedBuild {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        if let Some(output) = &self.output {
            // The artifact directory lives in the operator's output root, so it is not inside the
            // attempt tree and has to be removed explicitly.
            if let Some(per_attempt) = output.parent() {
                let _ = fs::remove_dir_all(per_attempt);
            }
        }
    }
}

fn invalid(message: impl Into<String>) -> MaterializeError {
    MaterializeError::new("ASSIGNMENT_INVALID", message)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, MaterializeError> {
    value.get(name).ok_or_else(|| invalid(format!("missing field {name}")))
}

fn text(value: &Value, name: &str) -> Result<String, MaterializeError> {
    value.as_str().map(str::to_owned).ok_or_else(|| invalid(format!("{name} must be a string")))
}

fn hex_digest(value: &Value, name: &str) -> Result<[u8; 32], MaterializeError> {
    let text = value.as_str().ok_or_else(|| invalid(format!("{name} must be a string")))?;
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(invalid(format!("{name} must be a lowercase SHA-256 hex digest")));
    }
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        // Both characters were proven to be lowercase hex above.
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).map_err(|_| invalid("digest"))?;
    }
    Ok(digest)
}

fn uuid(value: &Value, name: &str) -> Result<String, MaterializeError> {
    let text = text(value, name)?;
    if !is_uuid(&text) {
        return Err(invalid(format!("{name} must be a lowercase UUID")));
    }
    Ok(text)
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn uint(value: &Value, name: &str) -> Result<u64, MaterializeError> {
    value.as_u64().ok_or_else(|| invalid(format!("{name} must be an unsigned integer")))
}

/// A path is safe when it is non-empty, at most `MAX_PATH_CHARS`, uses `/` separators only, is
/// relative, and every `/`-separated component is a plain name. The check is done on the raw text
/// so that a normalized-but-odd spelling (`.`, empty, `..`) can never reach the filesystem.
pub fn safe_relative_path(value: &str) -> Result<(), MaterializeError> {
    if value.is_empty() || value.len() > MAX_PATH_CHARS {
        return Err(MaterializeError::new("PATH_UNSAFE", "path length out of range"));
    }
    if value.contains('\0') || value.contains('\\') {
        return Err(MaterializeError::new("PATH_UNSAFE", "path contains a forbidden separator"));
    }
    if Path::new(value).is_absolute() {
        return Err(MaterializeError::new("PATH_UNSAFE", "absolute path rejected"));
    }
    for component in value.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(MaterializeError::new("PATH_UNSAFE", "path component is not a plain name"));
        }
    }
    Ok(())
}

/// A compiled artifact's entrypoint is a plain file name: it is never a path, never has a
/// directory component and never needs an extension.
pub fn safe_artifact_entrypoint(value: &str) -> Result<(), MaterializeError> {
    let mut bytes = value.bytes();
    let first = bytes.next().ok_or_else(|| invalid("artifact entrypoint is empty"))?;
    if !first.is_ascii_alphanumeric() {
        return Err(invalid("artifact entrypoint must start with an alphanumeric character"));
    }
    if value.len() > 64 {
        return Err(invalid("artifact entrypoint is too long"));
    }
    if !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')) {
        return Err(invalid("artifact entrypoint contains a forbidden character"));
    }
    Ok(())
}

fn forbidden_extension(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    FORBIDDEN_EXTENSIONS.iter().any(|extension| lower.ends_with(extension))
}

/// Bounded, sanitised compiler/runtime diagnostic. Control characters other than tab and newline
/// are dropped and the result is truncated on a character boundary, so a hostile banner can never
/// grow the completion frame or the audit trail.
pub fn sanitize_diagnostic(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len().min(MAX_DIAGNOSTIC_CHARS));
    let mut characters = 0_usize;
    for character in text.chars() {
        if characters >= MAX_DIAGNOSTIC_CHARS {
            out.push('…');
            break;
        }
        match character {
            '\n' | '\t' => {}
            character if character.is_control() => {}
            character => out.push(character),
        }
        characters += 1;
    }
    out.trim().to_owned()
}

// ---------------------------------------------------------------------------------------------
// Pinned source ZIPs
// ---------------------------------------------------------------------------------------------

/// The intake rules the control plane applies (`submissions/artifact-store.ts`). The worker
/// re-applies them to the granted ZIP, so a spool file that was tampered with after pinning cannot
/// reach the sandbox as something the control plane would have refused.
pub mod zip {
    use super::{
        forbidden_extension, safe_relative_path, Language, MaterializeError, MAX_EXPANDED_BYTES,
        MAX_FILE_BYTES, MAX_REGULAR_FILES,
    };

    const EOCD_SIGNATURE: u32 = 0x0605_4b50;
    const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
    const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
    const EOCD_MIN_BYTES: usize = 22;
    const MAX_COMMENT_BYTES: usize = 0xffff;
    const METHOD_STORED: u16 = 0;
    const METHOD_DEFLATE: u16 = 8;
    /// Unix mode of a symlink inside the external attributes.
    const SYMLINK_MODE: u32 = 0o120_000;
    /// Longest output a single inflated member may reach.
    const MAX_MEMBER_BYTES: usize = MAX_FILE_BYTES;

    /// One regular file extracted from the granted ZIP, in central-directory order.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SourceFile {
        pub path: String,
        pub bytes: Vec<u8>,
    }

    fn zip_error(message: &'static str) -> MaterializeError {
        MaterializeError::new("ZIP_INVALID", message)
    }

    fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, MaterializeError> {
        let slice = bytes.get(offset..offset + 2).ok_or_else(|| zip_error("truncated ZIP record"))?;
        Ok(u16::from_le_bytes([slice[0], slice[1]]))
    }

    fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, MaterializeError> {
        let slice = bytes.get(offset..offset + 4).ok_or_else(|| zip_error("truncated ZIP record"))?;
        Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    fn name_at(bytes: &[u8], offset: usize, length: usize) -> Result<String, MaterializeError> {
        let slice = bytes.get(offset..offset + length).ok_or_else(|| zip_error("truncated ZIP name"))?;
        std::str::from_utf8(slice).map(str::to_owned).map_err(|_| zip_error("ZIP name is not UTF-8"))
    }

    /// Extract and validate a granted source ZIP. The returned files are exactly what may be
    /// written into the workspace, in the order the ZIP declared them.
    pub fn extract(bytes: &[u8], language: Language, entrypoint: &str) -> Result<Vec<SourceFile>, MaterializeError> {
        if bytes.len() < EOCD_MIN_BYTES {
            return Err(zip_error("source is too small to be a ZIP"));
        }
        let search_start = bytes.len().saturating_sub(EOCD_MIN_BYTES + MAX_COMMENT_BYTES);
        let mut eocd = None;
        for offset in (search_start..=bytes.len() - EOCD_MIN_BYTES).rev() {
            if u32_at(bytes, offset)? == EOCD_SIGNATURE {
                eocd = Some(offset);
                break;
            }
        }
        let eocd = eocd.ok_or_else(|| zip_error("end of central directory not found"))?;
        let entries = u32::from(u16_at(bytes, eocd + 10)?) as usize;
        let directory_offset = u32_at(bytes, eocd + 16)? as usize;
        if entries == 0 || entries > MAX_REGULAR_FILES {
            return Err(MaterializeError::new("SIZE_LIMIT", "source ZIP file count is out of range"));
        }

        let mut offset = directory_offset;
        let mut files: Vec<SourceFile> = Vec::with_capacity(entries);
        let mut seen: Vec<String> = Vec::with_capacity(entries);
        let mut expanded = 0_usize;
        for _ in 0..entries {
            if u32_at(bytes, offset)? != CENTRAL_SIGNATURE {
                return Err(zip_error("corrupt central directory entry"));
            }
            let method = u16_at(bytes, offset + 10)?;
            let checksum = u32_at(bytes, offset + 16)?;
            let compressed_size = u32_at(bytes, offset + 20)? as usize;
            let uncompressed_size = u32_at(bytes, offset + 24)? as usize;
            let name_length = u16_at(bytes, offset + 28)? as usize;
            let extra_length = u16_at(bytes, offset + 30)? as usize;
            let comment_length = u16_at(bytes, offset + 32)? as usize;
            let external = u32_at(bytes, offset + 38)?;
            let local_offset = u32_at(bytes, offset + 42)? as usize;
            let name = name_at(bytes, offset + 46, name_length)?;
            offset = offset
                .checked_add(46 + name_length + extra_length + comment_length)
                .ok_or_else(|| zip_error("central directory overflow"))?;

            if external >> 16 & 0o170_000 == SYMLINK_MODE {
                return Err(zip_error("source ZIP contains a symlink"));
            }
            let normalized = name.replace('\\', "/");
            if normalized.ends_with('/') {
                continue;
            }
            safe_relative_path(&normalized)?;
            if forbidden_extension(&normalized) {
                return Err(MaterializeError::new("PATH_UNSAFE", "compiled or executable artifact rejected"));
            }
            let lower = normalized.to_ascii_lowercase();
            if seen.iter().any(|existing| existing == &lower) {
                return Err(MaterializeError::new("PATH_UNSAFE", "duplicate or case-colliding path"));
            }
            seen.push(lower);
            if uncompressed_size > MAX_FILE_BYTES {
                return Err(MaterializeError::new("SIZE_LIMIT", "source file exceeds the single-file cap"));
            }
            expanded = expanded
                .checked_add(uncompressed_size)
                .filter(|total| *total <= MAX_EXPANDED_BYTES)
                .ok_or_else(|| MaterializeError::new("SIZE_LIMIT", "expanded source exceeds the cap"))?;

            if u32_at(bytes, local_offset)? != LOCAL_SIGNATURE {
                return Err(zip_error("corrupt local file header"));
            }
            let local_name = u16_at(bytes, local_offset + 26)? as usize;
            let local_extra = u16_at(bytes, local_offset + 28)? as usize;
            let data_start = local_offset
                .checked_add(30 + local_name + local_extra)
                .ok_or_else(|| zip_error("local header overflow"))?;
            let data_end = data_start.checked_add(compressed_size).ok_or_else(|| zip_error("data overflow"))?;
            let stored = bytes.get(data_start..data_end).ok_or_else(|| zip_error("compressed data is out of bounds"))?;
            let data = match method {
                METHOD_STORED => stored.to_vec(),
                METHOD_DEFLATE => inflate(stored)?,
                _ => return Err(zip_error("unsupported compression method")),
            };
            if data.len() != uncompressed_size {
                return Err(zip_error("decompressed size disagrees with the ZIP record"));
            }
            if crc32(&data) != checksum {
                return Err(zip_error("decompressed checksum disagrees with the ZIP record"));
            }
            files.push(SourceFile { path: normalized, bytes: data });
        }

        if files.is_empty() {
            return Err(zip_error("source ZIP contains no regular files"));
        }
        if !files.iter().any(|file| file.path == entrypoint) {
            return Err(MaterializeError::new("ASSIGNMENT_INVALID", "entrypoint is not part of the granted source"));
        }
        if !language.accepts_entrypoint(entrypoint) {
            return Err(MaterializeError::new(
                "ASSIGNMENT_INVALID",
                format!("entrypoint does not match language {}", language.name()),
            ));
        }
        Ok(files)
    }

    /// CRC-32 (IEEE 802.3), as stored in every ZIP entry.
    pub fn crc32(bytes: &[u8]) -> u32 {
        let mut table = [0_u32; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 == 1 { 0xedb8_8320 ^ (value >> 1) } else { value >> 1 };
            }
            *slot = value;
        }
        let mut crc = 0xffff_ffff_u32;
        for byte in bytes {
            crc = table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
        }
        crc ^ 0xffff_ffff
    }

    // ---------------------------------------------------------------------------------------
    // Raw DEFLATE (RFC 1951): stored, fixed-Huffman and dynamic-Huffman blocks.
    // ---------------------------------------------------------------------------------------

    const LENGTH_BASE: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LENGTH_EXTRA: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DISTANCE_BASE: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DISTANCE_EXTRA: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    /// Order the code-length alphabet is declared in.
    const CODE_LENGTH_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    const MAX_BITS: usize = 15;
    const LITLEN_SYMBOLS: usize = 288;
    const DISTANCE_SYMBOLS: usize = 30;
    const END_OF_BLOCK: u16 = 256;

    /// Canonical Huffman decoder: counts per code length plus symbols in canonical order.
    struct Huffman {
        counts: [u16; MAX_BITS + 1],
        symbols: Vec<u16>,
    }

    impl Huffman {
        fn new(lengths: &[u8]) -> Result<Self, MaterializeError> {
            let mut counts = [0_u16; MAX_BITS + 1];
            for length in lengths {
                if *length as usize > MAX_BITS {
                    return Err(zip_error("Huffman code is too long"));
                }
                counts[*length as usize] += 1;
            }
            counts[0] = 0;
            if counts.iter().sum::<u16>() == 0 {
                return Err(zip_error("empty Huffman alphabet"));
            }
            let mut offsets = [0_u16; MAX_BITS + 2];
            for length in 1..=MAX_BITS {
                offsets[length + 1] = offsets[length] + counts[length];
            }
            let mut symbols = vec![0_u16; counts.iter().sum::<u16>() as usize];
            for (symbol, length) in lengths.iter().enumerate() {
                if *length != 0 {
                    symbols[offsets[*length as usize] as usize] = symbol as u16;
                    offsets[*length as usize] += 1;
                }
            }
            Ok(Self { counts, symbols })
        }

        fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, MaterializeError> {
            let mut code: i32 = 0;
            let mut first: i32 = 0;
            let mut index: i32 = 0;
            for length in 1..=MAX_BITS {
                code |= i32::from(reader.bits(1)? as u8);
                let count = i32::from(self.counts[length]);
                if code - first < count {
                    return self
                        .symbols
                        .get((index + code - first) as usize)
                        .copied()
                        .ok_or_else(|| zip_error("Huffman symbol index out of range"));
                }
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            Err(zip_error("invalid Huffman code"))
        }
    }

    fn fixed_tables() -> Result<(Huffman, Huffman), MaterializeError> {
        let mut litlen = [0_u8; LITLEN_SYMBOLS];
        for (symbol, length) in litlen.iter_mut().enumerate() {
            *length = match symbol {
                0..=143 => 8,
                144..=255 => 9,
                256..=279 => 7,
                _ => 8,
            };
        }
        let distance = [5_u8; DISTANCE_SYMBOLS];
        Ok((Huffman::new(&litlen)?, Huffman::new(&distance)?))
    }

    fn dynamic_tables(reader: &mut BitReader<'_>) -> Result<(Huffman, Huffman), MaterializeError> {
        let literals = reader.bits(5)? as usize + 257;
        let distances = reader.bits(5)? as usize + 1;
        let code_lengths = reader.bits(4)? as usize + 4;
        if literals > LITLEN_SYMBOLS || distances > DISTANCE_SYMBOLS {
            return Err(zip_error("dynamic Huffman alphabet is out of range"));
        }
        let mut declared = [0_u8; 19];
        for index in 0..code_lengths {
            declared[CODE_LENGTH_ORDER[index]] = reader.bits(3)? as u8;
        }
        let decoder = Huffman::new(&declared)?;
        let total = literals + distances;
        let mut lengths = vec![0_u8; total];
        let mut index = 0;
        while index < total {
            match decoder.decode(reader)? {
                symbol @ 0..=15 => {
                    lengths[index] = symbol as u8;
                    index += 1;
                }
                16 => {
                    let previous = if index == 0 {
                        return Err(zip_error("repeat code without a previous length"));
                    } else {
                        lengths[index - 1]
                    };
                    let repeat = reader.bits(2)? as usize + 3;
                    for _ in 0..repeat {
                        if index >= total {
                            return Err(zip_error("code length repeat overflows the alphabet"));
                        }
                        lengths[index] = previous;
                        index += 1;
                    }
                }
                17 => {
                    let repeat = reader.bits(3)? as usize + 3;
                    index = zero_fill(&mut lengths, index, repeat)?;
                }
                18 => {
                    let repeat = reader.bits(7)? as usize + 11;
                    index = zero_fill(&mut lengths, index, repeat)?;
                }
                _ => return Err(zip_error("invalid code length symbol")),
            }
        }
        if lengths[END_OF_BLOCK as usize] == 0 {
            return Err(zip_error("dynamic alphabet has no end-of-block code"));
        }
        Ok((Huffman::new(&lengths[..literals])?, Huffman::new(&lengths[literals..])?))
    }

    fn zero_fill(lengths: &mut [u8], mut index: usize, repeat: usize) -> Result<usize, MaterializeError> {
        for _ in 0..repeat {
            if index >= lengths.len() {
                return Err(zip_error("code length repeat overflows the alphabet"));
            }
            lengths[index] = 0;
            index += 1;
        }
        Ok(index)
    }

    fn fixed_or_dynamic(reader: &mut BitReader<'_>, block: u32) -> Result<(Huffman, Huffman), MaterializeError> {
        if block == 1 {
            fixed_tables()
        } else {
            dynamic_tables(reader)
        }
    }

    /// Inflate one raw DEFLATE stream, never producing more than the single-file cap.
    pub fn inflate(input: &[u8]) -> Result<Vec<u8>, MaterializeError> {
        let mut reader = BitReader::new(input);
        let mut out: Vec<u8> = Vec::new();
        let overflow = || MaterializeError::new("SIZE_LIMIT", "inflated member exceeds the file cap");
        loop {
            let last = reader.bits(1)? == 1;
            match reader.bits(2)? {
                0 => {
                    reader.align();
                    let length = reader.bits(16)? as usize;
                    let complement = reader.bits(16)? as usize;
                    if length != (complement ^ 0xffff) {
                        return Err(zip_error("stored block length is invalid"));
                    }
                    for _ in 0..length {
                        out.push(reader.bits(8)? as u8);
                        if out.len() > MAX_MEMBER_BYTES {
                            return Err(overflow());
                        }
                    }
                }
                block @ (1 | 2) => {
                    let (literals, distances) = fixed_or_dynamic(&mut reader, block)?;
                    loop {
                        let symbol = literals.decode(&mut reader)?;
                        match symbol {
                            literal @ 0..=255 => {
                                out.push(literal as u8);
                                if out.len() > MAX_MEMBER_BYTES {
                                    return Err(overflow());
                                }
                            }
                            END_OF_BLOCK => break,
                            symbol => {
                                let length_index = symbol as usize - 257;
                                let length_base = *LENGTH_BASE
                                    .get(length_index)
                                    .ok_or_else(|| zip_error("invalid length symbol"))?;
                                let length = length_base as usize
                                    + reader.bits(u32::from(LENGTH_EXTRA[length_index]))? as usize;
                                let distance_symbol = distances.decode(&mut reader)?;
                                let distance_index = distance_symbol as usize;
                                let distance_base = *DISTANCE_BASE
                                    .get(distance_index)
                                    .ok_or_else(|| zip_error("invalid distance symbol"))?;
                                let distance = distance_base as usize
                                    + reader.bits(u32::from(DISTANCE_EXTRA[distance_index]))? as usize;
                                if distance == 0 || distance > out.len() {
                                    return Err(zip_error("match distance exceeds the decoded output"));
                                }
                                for _ in 0..length {
                                    let byte = out[out.len() - distance];
                                    out.push(byte);
                                    if out.len() > MAX_MEMBER_BYTES {
                                        return Err(overflow());
                                    }
                                }
                            }
                        }
                    }
                }
                _ => return Err(zip_error("reserved deflate block type")),
            }
            if last {
                break;
            }
        }
        Ok(out)
    }

    struct BitReader<'a> {
        input: &'a [u8],
        position: usize,
        buffer: u32,
        available: u32,
    }

    impl<'a> BitReader<'a> {
        fn new(input: &'a [u8]) -> Self {
            Self { input, position: 0, buffer: 0, available: 0 }
        }

        /// Read `count` bits, least-significant first, as DEFLATE lays them out.
        fn bits(&mut self, count: u32) -> Result<u32, MaterializeError> {
            while self.available < count {
                let byte = self.input.get(self.position).ok_or_else(|| zip_error("deflate stream is truncated"))?;
                self.position += 1;
                self.buffer |= u32::from(*byte) << self.available;
                self.available += 8;
            }
            let value = self.buffer & ((1_u32 << count) - 1);
            self.buffer >>= count;
            self.available -= count;
            Ok(value)
        }

        /// Drop the partial byte before a stored block's aligned length field.
        fn align(&mut self) {
            let drop = self.available % 8;
            self.buffer >>= drop;
            self.available -= drop;
        }
    }
}

fn parse_grant(value: &Value, name: &str, limit: u64) -> Result<Grant, MaterializeError> {
    let path = text(field(value, "path")?, &format!("{name}.path"))?;
    if !Path::new(&path).is_absolute() {
        return Err(MaterializeError::new("GRANT_PATH_UNSAFE", "granted path must be absolute"));
    }
    let digest = hex_digest(field(value, "digest")?, &format!("{name}.digest"))?;
    let size_bytes = uint(field(value, "sizeBytes")?, &format!("{name}.sizeBytes"))?;
    if size_bytes == 0 || size_bytes > limit {
        return Err(MaterializeError::new("SIZE_LIMIT", "granted size is out of the accepted range"));
    }
    Ok(Grant { path: PathBuf::from(path), digest, size_bytes })
}

fn parse_bot(value: &Value, side: u8) -> Result<GameBot, MaterializeError> {
    let object = value.as_object().ok_or_else(|| invalid("bot must be an object"))?;
    if !object.contains_key("side") || uint(field(value, "side")?, "bot.side")? != u64::from(side) {
        return Err(invalid(format!("bot side {side} expected")));
    }
    let language_name = text(field(value, "language")?, "bot.language")?;
    let language = Language::parse(&language_name)
        .ok_or_else(|| MaterializeError::new("LANGUAGE_UNSUPPORTED", format!("unknown language {language_name}")))?;
    let entrypoint = text(field(value, "entrypoint")?, "bot.entrypoint")?;
    safe_relative_path(&entrypoint)?;
    if !language.accepts_entrypoint(&entrypoint) {
        return Err(invalid(format!("entrypoint does not match language {}", language.name())));
    }
    let source_digest = hex_digest(field(value, "sourceDigest")?, "bot.sourceDigest")?;
    let source = parse_grant(field(value, "source")?, "bot.source", MAX_SOURCE_BYTES)?;
    let artifact = match value.get("artifact") {
        None | Some(Value::Null) => None,
        Some(artifact) => {
            if language != Language::Cpp {
                return Err(invalid("only a compile language may carry a compiled artifact"));
            }
            let entrypoint = text(field(artifact, "entrypoint")?, "bot.artifact.entrypoint")?;
            safe_artifact_entrypoint(&entrypoint)?;
            Some(ArtifactGrant {
                grant: parse_grant(artifact, "bot.artifact", MAX_ARTIFACT_BYTES)?,
                entrypoint,
            })
        }
    };
    if language == Language::Cpp && artifact.is_none() {
        // A compile language is never compiled at match time: the assignment must carry the
        // artifact the build gate already produced, stored and digest-verified.
        return Err(MaterializeError::new("ARTIFACT_MISSING", "a compile language requires a compiled artifact grant"));
    }
    Ok(GameBot { side, language, entrypoint, source_digest, source, artifact })
}

fn parse_toolchain(value: &Value) -> Result<Toolchain, MaterializeError> {
    let language_name = text(field(value, "language")?, "toolchain.language")?;
    let language = Language::parse(&language_name)
        .ok_or_else(|| MaterializeError::new("LANGUAGE_UNSUPPORTED", format!("unknown language {language_name}")))?;
    let image_digest = hex_digest(field(value, "imageDigest")?, "toolchain.imageDigest")?;
    let version = text(field(value, "version")?, "toolchain.version")?;
    if version.is_empty() || version.len() > 64 || !version.is_ascii() {
        return Err(invalid("toolchain.version must be short ASCII"));
    }
    let flags = field(value, "flags")?
        .as_array()
        .ok_or_else(|| invalid("toolchain.flags must be an array"))?
        .iter()
        .map(|flag| text(flag, "toolchain.flags[]"))
        .collect::<Result<Vec<String>, MaterializeError>>()?;
    if flags.len() > 16 {
        return Err(invalid("toolchain.flags must hold at most 16 entries"));
    }
    for flag in &flags {
        if flag.is_empty() || flag.len() > 64 || !flag.is_ascii() || flag.contains('\0') {
            return Err(invalid("toolchain flag is not bounded ASCII"));
        }
    }
    Ok(Toolchain { language, image_digest, version, flags })
}

/// Validate a `claim` payload for a GAME/TEST_GAME job against the operator's runtime profile.
///
/// Both queues are the same match — the same manifest, the same two granted Bots, the same grant
/// verification — so they are validated by one function: a GAME names `gameId`, a TEST_GAME names
/// `testId` and the pinned `opponent`, and both must agree with the claim's `targetId`.
///
/// Every rejection is fail-closed: the caller must abort the attempt without submitting anything.
pub fn parse_assignment(payload: &Value, expected_runtime_profile_digest: &str) -> Result<Assignment, MaterializeError> {
    payload.as_object().ok_or_else(|| invalid("assignment must be an object"))?;
    if uint(field(payload, "version")?, "version")? != 1 {
        return Err(MaterializeError::new("VERSION_UNSUPPORTED", "assignment version must be 1"));
    }
    // An official game names its own game id; a private test names its snapshot id and the opponent
    // the control plane pinned for it. Everything after this point is identical: the same manifest,
    // the same two granted Bots and the same evidence.
    let job_type = match text(field(payload, "jobType")?, "jobType")?.as_str() {
        "GAME" => GameJobType::Game,
        "TEST_GAME" => GameJobType::TestGame,
        _ => return Err(MaterializeError::new("JOB_TYPE_UNSUPPORTED", "assignment is not a game")),
    };
    let (game_id, opponent) = match job_type {
        GameJobType::Game => (uuid(field(payload, "gameId")?, "gameId")?, None),
        GameJobType::TestGame => (uuid(field(payload, "testId")?, "testId")?, Some(parse_opponent(payload)?)),
    };
    let target_id = uuid(field(payload, "targetId")?, "targetId")?;
    if game_id != target_id {
        return Err(invalid("targetId and the assignment's own id must agree"));
    }
    let canonical_manifest = text(field(payload, "canonicalManifest")?, "canonicalManifest")?.into_bytes();
    if canonical_manifest.is_empty() || canonical_manifest.len() > 1024 * 1024 {
        return Err(MaterializeError::new("SIZE_LIMIT", "canonical manifest size out of range"));
    }
    let manifest_digest = hex_digest(field(payload, "manifestDigest")?, "manifestDigest")?;
    let recomputed: [u8; 32] = Sha256::digest(&canonical_manifest).into();
    if recomputed != manifest_digest {
        return Err(MaterializeError::new("MANIFEST_DIGEST", "canonical manifest digest mismatch"));
    }
    let profile = text(field(payload, "runtimeProfileDigest")?, "runtimeProfileDigest")?;
    if profile != *expected_runtime_profile_digest {
        return Err(MaterializeError::new("RUNTIME_PROFILE_MISMATCH", "assignment runtime profile is not this worker's"));
    }
    let rules_revision = text(field(payload, "rulesRevision")?, "rulesRevision")?;
    if rules_revision.is_empty() || rules_revision.len() > 128 || !rules_revision.is_ascii() {
        return Err(invalid("rulesRevision must be short ASCII"));
    }
    let max_turns = uint(field(payload, "maxTurns")?, "maxTurns")?;
    if max_turns == 0 || max_turns > u64::from(MAX_TURNS) {
        return Err(invalid("maxTurns must be 1..=300"));
    }
    // The manifest is the engine's own contract: parsing it proves the game identity, the turn
    // bound and the board independent of the payload's own claims.
    let manifest = parse_manifest(&canonical_manifest, &manifest_digest)
        .map_err(|error| MaterializeError::new("MANIFEST_INVALID", format!("{error:?}")))?;
    if manifest.game_id != game_id {
        return Err(MaterializeError::new("MANIFEST_MISMATCH", "manifest game id disagrees with the payload"));
    }
    if u64::from(manifest.max_ply) != max_turns {
        return Err(MaterializeError::new("MANIFEST_MISMATCH", "manifest turn bound disagrees with the payload"));
    }
    let attempt_id = uuid_owned(&manifest.attempt_id)?;
    let bots = field(payload, "bots")?.as_array().ok_or_else(|| invalid("bots must be an array"))?;
    if bots.len() != 2 {
        return Err(invalid("exactly two bots are required"));
    }
    let first = parse_bot(&bots[0], 1)?;
    let second = parse_bot(&bots[1], 2)?;
    Ok(Assignment {
        job_type,
        canonical_manifest,
        manifest_digest,
        game_id,
        attempt_id,
        rules_revision,
        max_turns: max_turns as u32,
        bots: [first, second],
        opponent,
    })
}

/// The opponent of a private test, shape-checked against the two kinds this control plane pins. The
/// label is bounded ASCII so it can never be a carrier: nothing here reaches the filesystem, the
/// sandbox or the completion.
fn parse_opponent(payload: &Value) -> Result<TestOpponent, MaterializeError> {
    let opponent = field(payload, "opponent")?;
    let kind = match text(field(opponent, "kind")?, "opponent.kind")?.as_str() {
        "OWN_SUBMISSION" => TestOpponentKind::OwnSubmission,
        "BASELINE" => TestOpponentKind::Baseline,
        _ => return Err(invalid("opponent.kind is not one a private test may pin")),
    };
    let label = text(field(opponent, "label")?, "opponent.label")?;
    if label.is_empty() || label.len() > 128 || !label.is_ascii() {
        return Err(invalid("opponent.label must be short ASCII"));
    }
    Ok(TestOpponent { kind, label })
}

fn uuid_owned(value: &str) -> Result<String, MaterializeError> {
    if !is_uuid(value) {
        return Err(invalid("manifest attempt id must be a lowercase UUID"));
    }
    Ok(value.to_owned())
}

/// Validate a `claim` payload for a BUILD/TEST_BUILD job.
pub fn parse_build_assignment(payload: &Value) -> Result<BuildAssignment, MaterializeError> {
    payload.as_object().ok_or_else(|| invalid("assignment must be an object"))?;
    if uint(field(payload, "version")?, "version")? != 1 {
        return Err(MaterializeError::new("VERSION_UNSUPPORTED", "assignment version must be 1"));
    }
    let job_type = match text(field(payload, "jobType")?, "jobType")?.as_str() {
        "BUILD" => BuildJobType::Build,
        "TEST_BUILD" => BuildJobType::TestBuild,
        _ => return Err(MaterializeError::new("JOB_TYPE_UNSUPPORTED", "assignment is not a build")),
    };
    let target_id = uuid(field(payload, "targetId")?, "targetId")?;
    let language_name = text(field(payload, "language")?, "language")?;
    let language = Language::parse(&language_name)
        .ok_or_else(|| MaterializeError::new("LANGUAGE_UNSUPPORTED", format!("unknown language {language_name}")))?;
    let entrypoint = text(field(payload, "entrypoint")?, "entrypoint")?;
    safe_relative_path(&entrypoint)?;
    if !language.accepts_entrypoint(&entrypoint) {
        return Err(invalid(format!("entrypoint does not match language {}", language.name())));
    }
    let manifest_digest = hex_digest(field(payload, "manifestDigest")?, "manifestDigest")?;
    let toolchain = parse_toolchain(field(payload, "toolchain")?)?;
    if toolchain.language != language {
        return Err(MaterializeError::new("TOOLCHAIN_MISMATCH", "toolchain language disagrees with the assignment"));
    }
    if !language.has_compile_step() && !toolchain.flags.is_empty() {
        return Err(MaterializeError::new("TOOLCHAIN_MISMATCH", "a language without a compile step declares no flags"));
    }
    let source = parse_grant(field(payload, "source")?, "source", MAX_SOURCE_BYTES)?;
    let limits = {
        let limits = field(payload, "limits")?;
        let compile_wall_ms = uint(field(limits, "compileWallMs")?, "limits.compileWallMs")?;
        let init_wall_ms = uint(field(limits, "initWallMs")?, "limits.initWallMs")?;
        let init_cpu_usec = uint(field(limits, "initCpuUsec")?, "limits.initCpuUsec")?;
        if compile_wall_ms == 0 || compile_wall_ms > 600_000 {
            return Err(invalid("limits.compileWallMs must be 1..=600000"));
        }
        if init_wall_ms == 0 || init_wall_ms > 60_000 {
            return Err(invalid("limits.initWallMs must be 1..=60000"));
        }
        if init_cpu_usec == 0 || init_cpu_usec > 60_000_000 {
            return Err(invalid("limits.initCpuUsec must be 1..=60000000"));
        }
        BuildLimits { compile_wall_ms, init_wall_ms, init_cpu_usec }
    };
    Ok(BuildAssignment { job_type, target_id, language, entrypoint, manifest_digest, toolchain, source, limits })
}

/// An operator-provisioned directory that must exist, must be a real directory (not a symlink)
/// and must not be writable by any other identity.
pub fn require_private_directory(path: &Path, code: &'static str) -> Result<(), MaterializeError> {
    if !path.is_absolute() {
        return Err(MaterializeError::new(code, "operator path must be absolute"));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| MaterializeError::new(code, format!("{path:?}: {error}")))?;
    if !metadata.file_type().is_dir() {
        return Err(MaterializeError::new(code, "operator path is not a directory"));
    }
    if metadata.mode() & 0o022 != 0 {
        return Err(MaterializeError::new(code, "operator path is writable by another identity"));
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::other("write target has no parent"))?;
    let name = path.file_name().ok_or_else(|| io::Error::other("write target has no name"))?;
    let mut temporary = std::ffi::OsString::from(".");
    temporary.push(name);
    temporary.push(format!(".tmp-{}", std::process::id()));
    let temporary = parent.join(temporary);
    let mut file = OpenOptions::new().write(true).create_new(true).mode(mode).open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    // Durability of the rename itself: the directory entry must survive a crash.
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn verify_written(path: &Path, expected: &[u8; 32]) -> io::Result<()> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => hasher.update(&buffer[..count]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    let actual: [u8; 32] = hasher.finalize().into();
    if actual != *expected {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "materialized file digest mismatch"));
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    DirBuilder::new().mode(0o700).create(path)
}

fn create_output_directory(path: &Path) -> io::Result<()> {
    DirBuilder::new().mode(OUTPUT_DIR_MODE).create(path)?;
    // Preserve the private mode even under an operator-provided umask.
    fs::set_permissions(path, fs::Permissions::from_mode(OUTPUT_DIR_MODE))
}

/// The OCI bundle for one container. `linux.cgroupsPath` names the operator-supplied workload
/// cgroup that the Sandbox primitive freezes, kills and measures; the rootfs is read-only and
/// every Bot path is a read-only bind mount, so a Bot can neither write code nor reach the host.
///
/// `writable_output` is set for exactly one bundle: the compile step, which is an operator-fixed
/// toolchain command (not Bot code) and whose only writable path is the artifact output directory.
fn bundle_document(
    args: &[String],
    workspace: &Path,
    output: Option<&Path>,
    writable_output: bool,
    compile_env: bool,
    rootfs: &Path,
    cgroup: &Path,
) -> Result<Vec<u8>, MaterializeError> {
    let limits = if compile_env { crate::control::WorkloadLimits::COMPILE } else { crate::control::WorkloadLimits::BOT };
    let mut mounts = vec![
        serde_json::json!({
            "destination": "/proc",
            "type": "proc",
            "source": "proc",
            "options": ["nosuid", "noexec", "nodev"],
        }),
        serde_json::json!({
            "destination": "/tmp",
            "type": "tmpfs",
            "source": "tmpfs",
            "options": ["nosuid", "nodev", "size=16777216"],
        }),
        serde_json::json!({
            "destination": WORKSPACE_MOUNT,
            "type": "bind",
            "source": workspace,
            "options": ["bind", "ro", "nosuid", "nodev"],
        }),
    ];
    if let Some(output) = output {
        let options = if writable_output {
            // Only the compile bundle writes output; game artifact mounts remain read-only.
            vec!["bind", "rw", "nosuid", "nodev"]
        } else {
            vec!["bind", "ro", "nosuid", "nodev"]
        };
        mounts.push(serde_json::json!({
            "destination": OUTPUT_MOUNT,
            "type": "bind",
            "source": output,
            "options": options,
        }));
    }
    let environment = if compile_env {
        // A compile step must be able to write its bytecode cache, and the workspace is read-only,
        // so `PYTHONPYCACHEPREFIX` redirects it into the writable output mount.
        serde_json::json!([
            "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG=C",
            "HOME=/tmp",
            "TMPDIR=/tmp",
            format!("PYTHONPYCACHEPREFIX={OUTPUT_MOUNT}"),
        ])
    } else {
        serde_json::json!([
            "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG=C",
            "HOME=/tmp",
            "TMPDIR=/tmp",
            "PYTHONDONTWRITEBYTECODE=1",
            "NODE_OPTIONS=--max-old-space-size=256",
        ])
    };
    let document = serde_json::json!({
        "ociVersion": "1.0.0",
        "root": { "path": rootfs, "readonly": true },
        "process": {
            "terminal": false,
            // Namespace root maps only to the supervisor's unprivileged host identity.
            "user": { "uid": 0, "gid": 0, "additionalGids": [] },
            "args": args,
            "env": environment,
            "cwd": WORKSPACE_MOUNT,
            "noNewPrivileges": true,
            "capabilities": {
                "bounding": [],
                "effective": [],
                "inheritable": [],
                "permitted": [],
                "ambient": [],
            },
            "rlimits": [
                { "type": "RLIMIT_CPU", "hard": if compile_env { 10 } else { 8 }, "soft": if compile_env { 10 } else { 8 } },
                { "type": "RLIMIT_NOFILE", "hard": limits.files, "soft": limits.files },
                { "type": "RLIMIT_NPROC", "hard": limits.pids, "soft": limits.pids },
            ],
            "maskedPaths": [
                "/proc/kcore",
                "/proc/keys",
                "/proc/timer_list",
                "/proc/sched_debug",
                "/sys/firmware",
            ],
            "readonlyPaths": ["/proc/sys", "/proc/sysrq-trigger"],
        },
        "mounts": mounts,
        "linux": {
            "cgroupsPath": cgroup,
            "uidMappings": [{ "containerID": 0, "hostID": unsafe { libc::geteuid() }, "size": 1 }],
            "gidMappings": [{ "containerID": 0, "hostID": unsafe { libc::getegid() }, "size": 1 }],
            "namespaces": [
                { "type": "user" },
                { "type": "pid" },
                { "type": "ipc" },
                { "type": "uts" },
                { "type": "mount" },
                { "type": "network" },
            ],
            "resources": {
                "devices": [{ "allow": false, "access": "rwm" }],
                "cpu": { "quota": 100000, "period": 100000 },
                // OCI swap is memory+swap; equal values prohibit swap.
                "memory": { "limit": limits.memory, "swap": limits.memory },
                "pids": { "limit": limits.pids },
            },
        },
    });
    serde_json::to_vec_pretty(&document).map_err(|error| MaterializeError::new("BUNDLE", format!("{error}")))
}

/// Validate then materialize a game `assignment` under the operator's attempt root.
///
/// The attempt directory is created fresh (an existing directory is an error, so no workspace is
/// ever reused between attempts) with mode 0700, and every artefact is written atomically and
/// re-verified after the write.
pub fn materialize(
    assignment: &Assignment,
    attempt_root: &Path,
    cgroup_root: &Path,
    runtime_rootfs: &Path,
) -> Result<MaterializedAttempt, MaterializeError> {
    require_private_directory(runtime_rootfs, "ROOTFS_UNAVAILABLE")?;
    let root = prepare_attempt_root(&assignment.attempt_id, attempt_root, cgroup_root)?;
    match materialize_game_into(assignment, &root, cgroup_root, runtime_rootfs) {
        Ok((manifest, bots)) => Ok(MaterializedAttempt { root, manifest, bots }),
        Err(error) => {
            let _ = fs::remove_dir_all(&root);
            Err(error)
        }
    }
}

/// Validate then materialize a BUILD/TEST_BUILD assignment: the granted source, the operator
/// toolchain bundles and the writable artifact output directory.
pub fn materialize_build(
    build: &BuildAssignment,
    attempt_id: &str,
    attempt_root: &Path,
    cgroup_root: &Path,
    toolchain_rootfs: &Path,
    artifact_output_root: &Path,
) -> Result<MaterializedBuild, MaterializeError> {
    require_private_directory(toolchain_rootfs, "TOOLCHAIN_ROOTFS_UNAVAILABLE")?;
    require_private_directory(artifact_output_root, "ARTIFACT_OUTPUT_ROOT_UNAVAILABLE")?;
    let root = prepare_attempt_root(attempt_id, attempt_root, cgroup_root)?;
    // The compiler writes into the operator's own output root, in a directory this attempt owns and
    // has never reused, so a stale artifact can never be mistaken for this build's output.
    let output = match prepare_output_directory(artifact_output_root, attempt_id) {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&root);
            return Err(error);
        }
    };
    match materialize_build_into(build, attempt_id, &root, cgroup_root, toolchain_rootfs, &output) {
        Ok((layout, bot)) => Ok(MaterializedBuild { root, output: Some(output), build: layout, bot }),
        Err(error) => {
            let _ = fs::remove_dir_all(&root);
            // The artifact directory lives in the operator's output root, so the per-attempt
            // directory (its parent) is what has to go, not just the writable leaf.
            if let Some(per_attempt) = output.parent() {
                let _ = fs::remove_dir_all(per_attempt);
            }
            Err(error)
        }
    }
}

/// A fresh, private per-attempt directory inside the operator's artifact output root, with the
/// writable leaf the sandbox creates the artifact in.
fn prepare_output_directory(artifact_output_root: &Path, attempt_id: &str) -> Result<PathBuf, MaterializeError> {
    let per_attempt = artifact_output_root.join(attempt_id);
    create_private_directory(&per_attempt)
        .map_err(|error| MaterializeError::new("OUTPUT_ROOT_REUSED", format!("{per_attempt:?}: {error}")))?;
    let output = per_attempt.join("1");
    match create_output_directory(&output) {
        Ok(()) => Ok(output),
        Err(error) => {
            let _ = fs::remove_dir_all(&per_attempt);
            Err(MaterializeError::new("WORKSPACE", format!("{output:?}: {error}")))
        }
    }
}

fn prepare_attempt_root(attempt_id: &str, attempt_root: &Path, cgroup_root: &Path) -> Result<PathBuf, MaterializeError> {
    require_private_directory(attempt_root, "ATTEMPT_ROOT_UNUSABLE")?;
    if !cgroup_root.is_absolute() {
        return Err(MaterializeError::new("CGROUP_ROOT_UNUSABLE", "operator path must be absolute"));
    }
    let cgroup_root_metadata = fs::symlink_metadata(cgroup_root)
        .map_err(|error| MaterializeError::new("CGROUP_ROOT_UNUSABLE", format!("{cgroup_root:?}: {error}")))?;
    if !cgroup_root_metadata.file_type().is_dir() {
        return Err(MaterializeError::new("CGROUP_ROOT_UNUSABLE", "delegated cgroup root is not a directory"));
    }
    if !is_uuid(attempt_id) {
        return Err(invalid("attempt id must be a lowercase UUID"));
    }
    let root = attempt_root.join(attempt_id);
    create_private_directory(&root)
        .map_err(|error| MaterializeError::new("ATTEMPT_ROOT_REUSED", format!("{root:?}: {error}")))?;
    Ok(root)
}

fn materialize_game_into(
    assignment: &Assignment,
    root: &Path,
    cgroup_root: &Path,
    runtime_rootfs: &Path,
) -> Result<(ParsedManifest, [BotLayout; 2]), MaterializeError> {
    let manifest = parse_manifest(&assignment.canonical_manifest, &assignment.manifest_digest)
        .map_err(|error| MaterializeError::new("MANIFEST_INVALID", format!("{error:?}")))?;
    let mut layouts = Vec::with_capacity(2);
    for bot in &assignment.bots {
        let base = root.join(bot.side.to_string());
        let workspace = base.join(WORKSPACE_DIR);
        let bundle = base.join(BUNDLE_DIR);
        let state = base.join(STATE_DIR);
        for directory in [&base, &bundle, &state] {
            create_private_directory(directory)
                .map_err(|error| MaterializeError::new("WORKSPACE", format!("{directory:?}: {error}")))?;
        }
        let cgroup = cgroup_root.join(&assignment.attempt_id).join(bot.side.to_string());
        // Every grant the gateway pinned for the attempt is read and verified, in every language.
        let source = bot.source.read(MAX_SOURCE_BYTES)?;
        let (program, output) = match &bot.artifact {
            // Interpreted: the materialized source is what runs.
            None => {
                create_private_directory(&workspace)
                    .map_err(|error| MaterializeError::new("WORKSPACE", format!("{workspace:?}: {error}")))?;
                let files = zip::extract(&source, bot.language, &bot.entrypoint)?;
                write_workspace(&workspace, &files)?;
                (bot.language.run_argv(&format!("{WORKSPACE_MOUNT}/{}", bot.entrypoint)), None)
            }
            // Compile language: the granted artifact runs; the granted source stays verified proof
            // of what was built and never becomes a workspace file.
            Some(artifact) => {
                create_private_directory(&workspace)
                    .map_err(|error| MaterializeError::new("WORKSPACE", format!("{workspace:?}: {error}")))?;
                let output = base.join(OUTPUT_DIR);
                create_output_directory(&output)
                    .map_err(|error| MaterializeError::new("WORKSPACE", format!("{output:?}: {error}")))?;
                let bytes = artifact.grant.read(MAX_ARTIFACT_BYTES)?;
                materialize_artifact(&output, &artifact.entrypoint, &bytes)?;
                (bot.language.run_argv(&format!("{OUTPUT_MOUNT}/{}", artifact.entrypoint)), Some(output))
            }
        };
        let document = bundle_document(&program, &workspace, output.as_deref(), false, false, runtime_rootfs, &cgroup)?;
        let config = bundle.join(RUN_BUNDLE);
        write_bundle(&config, &document)?;
        layouts.push(BotLayout {
            side: bot.side,
            language: bot.language,
            program,
            workspace,
            output,
            bundle: config,
            state,
            cgroup,
        });
    }
    let bots: [BotLayout; 2] = layouts
        .try_into()
        .map_err(|_| MaterializeError::new("ASSIGNMENT_INVALID", "exactly two sides are required"))?;
    Ok((manifest, bots))
}

fn materialize_build_into(
    build: &BuildAssignment,
    attempt_id: &str,
    root: &Path,
    cgroup_root: &Path,
    toolchain_rootfs: &Path,
    output: &Path,
) -> Result<(BuildLayout, BotLayout), MaterializeError> {
    // The granted source is verified before anything is written, then re-validated against the same
    // intake rules the control plane applies.
    let source = build.source.read(MAX_SOURCE_BYTES)?;
    let files = zip::extract(&source, build.language, &build.entrypoint)?;

    let base = root.join("1");
    let workspace = base.join(WORKSPACE_DIR);
    let bundle = base.join(BUNDLE_DIR);
    let state = base.join(STATE_DIR);
    for directory in [&base, &bundle, &state, &workspace] {
        create_private_directory(directory)
            .map_err(|error| MaterializeError::new("WORKSPACE", format!("{directory:?}: {error}")))?;
    }
    write_workspace(&workspace, &files)?;

    let cgroup = cgroup_root.join(attempt_id).join("1");
    let source_path = format!("{WORKSPACE_MOUNT}/{}", build.entrypoint);
    let artifact_path = format!("{OUTPUT_MOUNT}/{ARTIFACT_NAME}");

    // Identity probe: always present, so the reported toolchain version is measured inside the
    // sandbox rather than echoed from configuration.
    let probe = build.language.version_argv();
    let toolchain_bundle = bundle.join(TOOLCHAIN_BUNDLE);
    let document = bundle_document(&probe, &workspace, Some(output), false, true, toolchain_rootfs, &cgroup)?;
    write_bundle(&toolchain_bundle, &document)?;

    let compile_bundle = if build.language.has_compile_step() {
        let compile = build.language.compile_argv(&build.toolchain.flags, &source_path, &artifact_path);
        let path = bundle.join(COMPILE_BUNDLE);
        let document = bundle_document(&compile, &workspace, Some(output), true, true, toolchain_rootfs, &cgroup)?;
        write_bundle(&path, &document)?;
        Some(path)
    } else {
        None
    };

    // The INIT smoke test runs the built program the same way a match would: an interpreted
    // language runs the materialized source, a native language runs the artifact the compile step
    // produced.
    let (program, run_output) = if build.language.produces_artifact() {
        (build.language.run_argv(&artifact_path), Some(output.to_path_buf()))
    } else {
        (build.language.run_argv(&source_path), None)
    };
    let document = bundle_document(&program, &workspace, run_output.as_deref(), false, false, toolchain_rootfs, &cgroup)?;
    let run_bundle = bundle.join(RUN_BUNDLE);
    write_bundle(&run_bundle, &document)?;

    let layout = BuildLayout {
        language: build.language,
        entrypoint: build.entrypoint.clone(),
        target_id: build.target_id.clone(),
        workspace: workspace.clone(),
        output: output.to_path_buf(),
        toolchain_bundle,
        compile_bundle,
        state: state.clone(),
        cgroup: cgroup.clone(),
    };
    let bot = BotLayout {
        side: 1,
        language: build.language,
        program,
        workspace,
        output: run_output,
        bundle: run_bundle,
        state,
        cgroup,
    };
    Ok((layout, bot))
}

/// Write granted artifact bytes into the output directory and prove what landed on disk.
fn materialize_artifact(output: &Path, entrypoint: &str, bytes: &[u8]) -> Result<PathBuf, MaterializeError> {
    safe_artifact_entrypoint(entrypoint)?;
    let target = output.join(entrypoint);
    if !target.starts_with(output) {
        return Err(MaterializeError::new("PATH_UNSAFE", "artifact escapes the output directory"));
    }
    // The artifact is executed, so it must be owner-executable; nothing else may write it.
    atomic_write(&target, bytes, 0o700).map_err(|error| MaterializeError::new("WORKSPACE", format!("{target:?}: {error}")))?;
    let expected: [u8; 32] = Sha256::digest(bytes).into();
    verify_written(&target, &expected).map_err(|error| MaterializeError::new("ARTIFACT_DIGEST", format!("{target:?}: {error}")))?;
    Ok(target)
}

fn write_bundle(path: &Path, document: &[u8]) -> Result<(), MaterializeError> {
    create_private_directory(path).map_err(|error| MaterializeError::new("BUNDLE", error.to_string()))?;
    let config = path.join("config.json");
    let path = config.as_path();
    atomic_write(path, document, 0o600).map_err(|error| MaterializeError::new("BUNDLE", format!("{path:?}: {error}")))?;
    let written = fs::read(path).map_err(|error| MaterializeError::new("BUNDLE", format!("{error}")))?;
    if written != document {
        return Err(MaterializeError::new("BUNDLE", "bundle config did not match the written bytes"));
    }
    Ok(())
}

fn write_workspace(workspace: &Path, files: &[zip::SourceFile]) -> Result<(), MaterializeError> {
    for file in files {
        safe_relative_path(&file.path)?;
        let target = workspace.join(&file.path);
        if !target.starts_with(workspace) {
            return Err(MaterializeError::new("PATH_UNSAFE", "file escapes the workspace"));
        }
        if let Some(parent) = target.parent() {
            if parent != workspace {
                DirBuilder::new().recursive(true).mode(0o700).create(parent).map_err(|error| {
                    MaterializeError::new("WORKSPACE", format!("{parent:?}: {error}"))
                })?;
            }
        }
        atomic_write(&target, &file.bytes, 0o600)
            .map_err(|error| MaterializeError::new("WORKSPACE", format!("{target:?}: {error}")))?;
        let expected: [u8; 32] = Sha256::digest(&file.bytes).into();
        verify_written(&target, &expected)
            .map_err(|error| MaterializeError::new("FILE_DIGEST", format!("{target:?}: {error}")))?;
    }
    Ok(())
}

/// The deterministic artifact key the control plane recomputes from the same inputs: language,
/// source digest and operator toolchain. A build that reports any other key is refused.
pub fn artifact_key(language: Language, source_digest: &[u8; 32], toolchain: &Toolchain) -> String {
    let mut preimage = String::with_capacity(192);
    preimage.push_str(language.name());
    preimage.push('\n');
    preimage.push_str(&hex(&toolchain.image_digest));
    preimage.push('\n');
    preimage.push_str(&toolchain.version);
    preimage.push('\n');
    for flag in &toolchain.flags {
        preimage.push_str(flag);
        preimage.push('\n');
    }
    let digest: [u8; 32] = Sha256::digest(preimage.as_bytes()).into();
    format!("compiled/{}/{}/{}", language.name(), hex(source_digest), hex(&digest))
}

pub fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::zip::{crc32, extract, inflate};
    use super::*;

    // ---- DEFLATE emitters (tests only). They exist so the decoder under test is exercised with
    // real fixed/dynamic Huffman streams, not just with stored blocks. ------------------------

    struct BitWriter {
        bytes: Vec<u8>,
        buffer: u32,
        bits: u32,
    }

    impl BitWriter {
        fn new() -> Self {
            Self { bytes: Vec::new(), buffer: 0, bits: 0 }
        }

        /// Append `count` bits least-significant first (block headers, extra bits).
        fn bits(&mut self, value: u32, count: u32) {
            self.buffer |= (value & ((1 << count) - 1)) << self.bits;
            self.bits += count;
            while self.bits >= 8 {
                self.bytes.push((self.buffer & 0xff) as u8);
                self.buffer >>= 8;
                self.bits -= 8;
            }
        }

        /// Append a Huffman code most-significant bit first, as RFC 1951 requires.
        fn code(&mut self, value: u32, count: u32) {
            for shift in (0..count).rev() {
                self.bits((value >> shift) & 1, 1);
            }
        }

        fn align(&mut self) {
            if self.bits > 0 {
                self.bytes.push((self.buffer & 0xff) as u8);
                self.buffer = 0;
                self.bits = 0;
            }
        }

        fn finish(mut self) -> Vec<u8> {
            self.align();
            self.bytes
        }
    }

    fn fixed_symbol(writer: &mut BitWriter, symbol: u32) {
        match symbol {
            0..=143 => writer.code(0x30 + symbol, 8),
            144..=255 => writer.code(0x190 + (symbol - 144), 9),
            256..=279 => writer.code(symbol - 256, 7),
            _ => writer.code(0xc0 + (symbol - 280), 8),
        }
    }

    /// Fixed-Huffman block of literals only.
    fn deflate_fixed(data: &[u8]) -> Vec<u8> {
        let mut writer = BitWriter::new();
        writer.bits(1, 1);
        writer.bits(1, 2);
        for byte in data {
            fixed_symbol(&mut writer, u32::from(*byte));
        }
        fixed_symbol(&mut writer, 256);
        writer.finish()
    }

    /// Fixed-Huffman block that copies "abc" and then matches nine bytes at distance three, which
    /// forces an overlapping back-reference copy.
    fn deflate_fixed_match() -> Vec<u8> {
        let mut writer = BitWriter::new();
        writer.bits(1, 1);
        writer.bits(1, 2);
        for byte in b"abc" {
            fixed_symbol(&mut writer, u32::from(*byte));
        }
        // Length 9 is LENGTH_BASE[6]; distance 3 is DISTANCE_BASE[2]; both have zero extra bits.
        fixed_symbol(&mut writer, 263);
        writer.code(2, 5);
        fixed_symbol(&mut writer, 256);
        writer.finish()
    }

    fn deflate_stored(data: &[u8]) -> Vec<u8> {
        assert!(data.len() <= 0xffff);
        let mut writer = BitWriter::new();
        writer.bits(1, 1);
        writer.bits(0, 2);
        writer.align();
        writer.bits(data.len() as u32, 16);
        writer.bits(!(data.len() as u32) & 0xffff, 16);
        for byte in data {
            writer.bits(u32::from(*byte), 8);
        }
        writer.finish()
    }

    /// Dynamic-Huffman block whose alphabet is the literal `A` and end-of-block, with a single
    /// (unused) distance code. Exercises the code-length alphabet and the 17/18 repeat codes.
    fn deflate_dynamic() -> Vec<u8> {
        let mut writer = BitWriter::new();
        writer.bits(1, 1);
        writer.bits(2, 2);
        writer.bits(0, 5); // HLIT  = 257
        writer.bits(0, 5); // HDIST = 1
        writer.bits(15, 4); // HCLEN = 19
        // Symbols 0, 1, 17 and 18 carry length 2; every other code-length symbol is unused.
        let code_length_lengths: [u8; 19] = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2];
        // The order RFC 1951 declares code-length code lengths in.
        const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        for index in ORDER {
            writer.bits(u32::from(code_length_lengths[index]), 3);
        }
        // Canonical codes for the length-2 alphabet {0, 1, 17, 18}: 00, 01, 10, 11.
        let zero = |writer: &mut BitWriter| writer.code(0, 2);
        let one = |writer: &mut BitWriter| writer.code(1, 2);
        let repeat_long = |writer: &mut BitWriter, count: u32| {
            writer.code(3, 2);
            writer.bits(count - 11, 7);
        };
        let repeat_short = |writer: &mut BitWriter, count: u32| {
            writer.code(2, 2);
            writer.bits(count - 3, 3);
        };
        for _ in 0..6 {
            repeat_short(&mut writer, 10);
        }
        repeat_short(&mut writer, 5); // 65 zeros
        one(&mut writer); // literal 'A' has length 1
        for _ in 0..17 {
            repeat_long(&mut writer, 11);
        }
        repeat_short(&mut writer, 3); // 190 zeros
        one(&mut writer); // end-of-block has length 1
        one(&mut writer); // the single distance code has length 1
        assert_eq!(ORDER.len(), code_length_lengths.len());
        // Data: 'A', 'A', end-of-block. Canonical codes are 0 and 1.
        writer.code(0, 1);
        writer.code(0, 1);
        writer.code(1, 1);
        let stream = writer.finish();
        let _ = zero;
        stream
    }

    fn zip_bytes(entries: &[(&str, Vec<u8>, u16, Option<u32>, u32)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();
        for (name, data, method, crc_override, external) in entries {
            let local_offset = out.len();
            let compressed = if *method == 8 { deflate_stored(data) } else { data.clone() };
            let crc = crc_override.unwrap_or_else(|| crc32(data));
            out.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
            out.extend_from_slice(&20_u16.to_le_bytes());
            out.extend_from_slice(&0_u16.to_le_bytes());
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0_u16.to_le_bytes());
            out.extend_from_slice(&0_u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0_u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&compressed);

            directory.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            directory.extend_from_slice(&20_u16.to_le_bytes());
            directory.extend_from_slice(&20_u16.to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&method.to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&crc.to_le_bytes());
            directory.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&external.to_le_bytes());
            directory.extend_from_slice(&(local_offset as u32).to_le_bytes());
            directory.extend_from_slice(name.as_bytes());
        }
        let directory_offset = out.len();
        out.extend_from_slice(&directory);
        out.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
        out.extend_from_slice(&(directory_offset as u32).to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out
    }

    #[test]
    fn crc32_matches_known_answers() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b"The quick brown fox jumps over the lazy dog"), 0x414f_a339);
    }

    #[test]
    fn inflates_fixed_stored_and_dynamic_blocks() {
        let literal = b"hello, deflate";
        assert_eq!(inflate(&deflate_fixed(literal)).expect("fixed block"), literal.to_vec());
        assert_eq!(inflate(&deflate_stored(literal)).expect("stored block"), literal.to_vec());
        assert_eq!(inflate(&deflate_dynamic()).expect("dynamic block"), b"AA".to_vec());
        assert_eq!(
            inflate(&deflate_fixed_match()).expect("overlapping match"),
            b"abcabcabcabc".to_vec()
        );
    }

    #[test]
    fn inflate_refuses_truncated_and_oversized_streams() {
        assert!(inflate(b"").is_err());
        let stream = deflate_fixed(&vec![b'x'; MAX_FILE_BYTES + 8]);
        assert_eq!(
            inflate(&stream).expect_err("cap").code(),
            "SIZE_LIMIT",
            "a member may never inflate past the single-file cap"
        );
    }

    #[test]
    fn extracts_stored_and_deflated_members() {
        let entries = vec![
            ("main.py", b"print('ready')\n".to_vec(), 0, None, 0),
            ("helper.py", b"VALUE = 1\n".to_vec(), 8, None, 0),
        ];
        let files = extract(&zip_bytes(&entries), Language::Python, "main.py").expect("extracts");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "main.py");
        assert_eq!(files[0].bytes, b"print('ready')\n".to_vec());
        assert_eq!(files[1].path, "helper.py");
        assert_eq!(files[1].bytes, b"VALUE = 1\n".to_vec());
    }

    #[test]
    fn refuses_the_intake_rules_the_control_plane_enforces() {
        let cases: Vec<(&str, Vec<u8>, u16, Option<u32>, u32, &str)> = vec![
            ("../escape.py", b"x".to_vec(), 0, None, 0, "PATH_UNSAFE"),
            ("/etc/passwd", b"x".to_vec(), 0, None, 0, "PATH_UNSAFE"),
            ("main.pyc", b"x".to_vec(), 0, None, 0, "PATH_UNSAFE"),
            ("main.py", b"x".to_vec(), 3, None, 0, "ZIP_INVALID"),
            ("main.py", b"x".to_vec(), 0, Some(0), 0, "ZIP_INVALID"),
            ("main.py", b"x".to_vec(), 0, None, 0o120_755 << 16, "ZIP_INVALID"),
        ];
        for (name, data, method, crc, external, expected) in cases {
            let zip = zip_bytes(&[(name, data, method, crc, external)]);
            let error = extract(&zip, Language::Python, "main.py").expect_err(name);
            assert_eq!(error.code(), expected, "entry {name}");
        }
        // A directory entry is skipped; a legal file beside it is extracted.
        let zip = zip_bytes(&[
            ("sub/", Vec::new(), 0, None, 0),
            ("main.py", b"print(1)\n".to_vec(), 0, None, 0),
        ]);
        let files = extract(&zip, Language::Python, "main.py").expect("directory entries are not files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "main.py");
    }

    #[test]
    fn refuses_a_source_whose_entrypoint_is_missing_or_mismatched() {
        let entries = vec![("a.py", b"x".to_vec(), 0, None, 0)];
        let zip = zip_bytes(&entries);
        assert_eq!(
            extract(&zip, Language::Python, "main.py").expect_err("missing entrypoint").code(),
            "ASSIGNMENT_INVALID"
        );
        assert_eq!(
            extract(&zip, Language::TypeScript, "a.py").expect_err("mismatched language").code(),
            "ASSIGNMENT_INVALID"
        );
    }

    #[test]
    fn refuses_a_member_that_expands_past_its_declared_length() {
        // Declared length is smaller than the stored bytes: the mismatch must be refused.
        let mut zip = zip_bytes(&[("main.py", vec![b'a'; 32], 0, None, 0)]);
        // Patch the central directory's uncompressed size (first entry, offset 46 + name len).
        let central = zip
            .windows(4)
            .position(|window| window == 0x0201_4b50_u32.to_le_bytes())
            .expect("central directory");
        zip[central + 24..central + 28].copy_from_slice(&8_u32.to_le_bytes());
        let local = zip
            .windows(4)
            .position(|window| window == 0x0403_4b50_u32.to_le_bytes())
            .expect("local header");
        zip[local + 22..local + 26].copy_from_slice(&8_u32.to_le_bytes());
        assert_eq!(extract(&zip, Language::Python, "main.py").expect_err("length").code(), "ZIP_INVALID");
    }

    #[test]
    fn artifact_entrypoints_are_plain_file_names() {
        for valid in ["bot", "bot.exe", "bot_1-2", "a"] {
            assert!(safe_artifact_entrypoint(valid).is_ok(), "{valid}");
        }
        for invalid in ["", ".bot", "-bot", "sub/bot", "../bot", "b\\ot", &"x".repeat(65), "bot\n"] {
            assert!(safe_artifact_entrypoint(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn diagnostics_are_bounded_and_stripped_of_control_characters() {
        assert_eq!(sanitize_diagnostic(b"  main.cpp:3: error: x  "), "main.cpp:3: error: x");
        let noisy = format!("a\u{0}\u{7}{}b", "x".repeat(MAX_DIAGNOSTIC_CHARS * 2));
        let cleaned = sanitize_diagnostic(noisy.as_bytes());
        assert!(cleaned.chars().count() <= MAX_DIAGNOSTIC_CHARS + 1, "{}", cleaned.chars().count());
        assert!(cleaned.starts_with('a') && cleaned.ends_with('…'), "{cleaned}");
        assert!(!cleaned.chars().any(|character| character.is_control()));
    }

    #[test]
    fn artifact_key_follows_the_frozen_preimage_construction() {
        let toolchain = Toolchain {
            language: Language::Cpp,
            image_digest: [0x11; 32],
            version: "13.2.0".to_owned(),
            flags: vec!["-O2".to_owned(), "-std=c++20".to_owned()],
        };
        let source_digest = [0x22; 32];
        // The preimage is written out here exactly as the control plane builds it: newline-joined
        // fields with one trailing newline, every flag on its own line.
        let preimage = format!("CPP\n{}\n13.2.0\n-O2\n-std=c++20\n", hex(&toolchain.image_digest));
        let expected = format!("compiled/CPP/{}/{}", hex(&source_digest), hex(&Sha256::digest(preimage.as_bytes())));
        assert_eq!(artifact_key(Language::Cpp, &source_digest, &toolchain), expected);

        let no_flags = Toolchain { flags: Vec::new(), ..toolchain };
        let preimage = format!("CPP\n{}\n13.2.0\n", hex(&no_flags.image_digest));
        assert_eq!(
            artifact_key(Language::Cpp, &source_digest, &no_flags),
            format!("compiled/CPP/{}/{}", hex(&source_digest), hex(&Sha256::digest(preimage.as_bytes())))
        );
    }

    #[test]
    fn language_commands_are_operator_fixed() {
        assert_eq!(
            Language::Cpp.compile_argv(&["-O2".to_owned()], "/workspace/main.cpp", "/out/bot"),
            vec!["/usr/bin/g++", "-O2", "-I", "/workspace", "/workspace/main.cpp", "-o", "/out/bot"]
        );
        assert_eq!(
            Language::Python.compile_argv(&["-m".to_owned(), "py_compile".to_owned()], "/workspace/main.py", "/out/bot"),
            vec!["/usr/bin/python3", "-m", "py_compile", "/workspace/main.py"]
        );
        assert!(Language::TypeScript.compile_argv(&[], "/workspace/main.ts", "/out/bot").is_empty());
        assert_eq!(Language::Cpp.run_argv("/out/bot"), vec!["/out/bot"]);
        assert_eq!(Language::Python.run_argv("/workspace/main.py"), vec!["/usr/bin/python3", "/workspace/main.py"]);
    }
}
