//! Shared fixtures for the native workload tests: assignments built exactly the way the control
//! plane builds them (granted source ZIPs plus a framed fake gateway), scripted workloads that
//! stand in for the sandbox and a scripted toolchain runner that stands in for the compile step.
//!
//! The sandbox itself needs runsc, a delegated cgroup and rootfs images this host does not have, so
//! what these tests prove is the *loop*: validation, materialization, classification, evidence and
//! the artifact the worker measured itself.
#![allow(dead_code)]

use arena_supervisor::ipc::{read_frame, write_frame};
use arena_supervisor::materialize::BotLayout;
use arena_supervisor::sandbox::{BotOutputFault, Budgets, CommandOutcome};
use arena_supervisor::worker::{
    Exchange, SandboxRunner, ToolchainProfile, Toolchains, Workload, WorkloadFactory, WorkerConfig,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub const PROFILE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const ATTEMPT: &str = "11111111-1111-4111-8111-111111111111";
pub const GAME: &str = "22222222-2222-4222-8222-222222222222";
pub const LEASE: &str = "33333333-3333-4333-8333-333333333333";
pub const GRANT: &str = "44444444-4444-4444-8444-444444444444";
pub const COMPLETION: &str = "55555555-5555-4555-8555-555555555555";
pub const BUILD_TARGET: &str = "66666666-6666-4666-8666-666666666666";
/// The private test (snapshot) a TEST_GAME job targets; a test's manifest carries the same id.
pub const TEST: &str = "77777777-7777-4777-8777-777777777777";
pub const IMAGE_DIGEST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

static COUNTER: AtomicU32 = AtomicU32::new(1);

/// A private scratch directory that removes itself (nothing here may touch operator paths).
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "arena-worker-test-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("scratch directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("scratch permissions");
        Self { path }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn child(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::new();
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

pub fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for quantum in bytes.chunks(4) {
        let mut values = [0_u32; 4];
        let mut padding = 0;
        for (slot, byte) in quantum.iter().enumerate() {
            values[slot] = match byte {
                b'A'..=b'Z' => u32::from(byte - b'A'),
                b'a'..=b'z' => u32::from(byte - b'a') + 26,
                b'0'..=b'9' => u32::from(byte - b'0') + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    padding += 1;
                    continue;
                }
                _ => return None,
            };
        }
        let combined = values[0] << 18 | values[1] << 12 | values[2] << 6 | values[3];
        output.push((combined >> 16) as u8);
        if padding < 2 {
            output.push((combined >> 8) as u8);
        }
        if padding < 1 {
            output.push(combined as u8);
        }
    }
    Some(output)
}

/// A ZIP the intake rules accept: every member stored (method 0) with its real CRC-32.
pub fn zip_stored(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for (name, data) in files {
        let offset = out.len();
        let crc = crc32(data);
        out.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
        out.extend_from_slice(&20_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        directory.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
        directory.extend_from_slice(&20_u16.to_le_bytes());
        directory.extend_from_slice(&20_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&crc.to_le_bytes());
        directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
        directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
        directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u16.to_le_bytes());
        directory.extend_from_slice(&0_u32.to_le_bytes());
        directory.extend_from_slice(&(offset as u32).to_le_bytes());
        directory.extend_from_slice(name.as_bytes());
    }
    let directory_offset = out.len();
    out.extend_from_slice(&directory);
    out.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
    out.extend_from_slice(&(directory_offset as u32).to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out
}

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

/// Write one granted spool file and describe it exactly as the gateway grants it.
pub fn spool(directory: &Path, name: &str, bytes: &[u8]) -> Value {
    let path = directory.join(name);
    fs::write(&path, bytes).expect("spool file");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("spool permissions");
    json!({
        "path": path.to_string_lossy(),
        "digest": sha256_hex(bytes),
        "sizeBytes": bytes.len(),
    })
}

/// The engine's canonical manifest as the control plane serializes it.
pub fn canonical_manifest(game: &str, attempt: &str, max_ply: u32) -> String {
    let document = json!({
        "gameId": game,
        "attemptId": attempt,
        "map": {
            "name": "worker-test-3x3",
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
        "maxPly": max_ply,
    });
    serde_json::to_string(&document).expect("manifest serializes")
}

/// One game side, granted exactly as the gateway pins it.
pub fn game_bot(side: u8, language: &str, entrypoint: &str, source: Value, artifact: Option<Value>) -> Value {
    let mut bot = json!({
        "side": side,
        "sourceDigest": PROFILE,
        "language": language,
        "entrypoint": entrypoint,
        "source": source,
    });
    if let Some(artifact) = artifact {
        bot["artifact"] = artifact;
    }
    bot
}

/// A complete, valid GAME assignment with both sides' source ZIPs spooled under `spool_dir`.
pub fn assignment(spool_dir: &Path) -> (Value, String) {
    let manifest = canonical_manifest(GAME, ATTEMPT, 300);
    let digest = sha256_hex(manifest.as_bytes());
    let white = spool(
        spool_dir,
        "white.zip",
        &zip_stored(&[("main.py", b"# white\nprint('ready')\n")]),
    );
    let black = spool(
        spool_dir,
        "black.zip",
        &zip_stored(&[("main.py", b"# black\nprint('ready')\n")]),
    );
    let payload = json!({
        "version": 1,
        "jobType": "GAME",
        "targetId": GAME,
        "canonicalManifest": manifest,
        "manifestDigest": digest,
        "runtimeProfileDigest": PROFILE,
        "gameId": GAME,
        "rulesRevision": "rules-2026.1",
        "maxTurns": 300,
        "bots": [
            game_bot(1, "PYTHON", "main.py", white, None),
            game_bot(2, "PYTHON", "main.py", black, None),
        ],
    });
    (payload, digest)
}

/// A CPP GAME assignment: the granted compiled artifact is what runs.
pub fn cpp_assignment(spool_dir: &Path, artifact_bytes: &[u8]) -> (Value, String, String) {
    let manifest = canonical_manifest(GAME, ATTEMPT, 300);
    let digest = sha256_hex(manifest.as_bytes());
    let source = spool(
        spool_dir,
        "cpp-source.zip",
        &zip_stored(&[("main.cpp", b"int main() { return 0; }\n")]),
    );
    let artifact = spool(spool_dir, "compiled-bot", artifact_bytes);
    let mut artifact = artifact;
    artifact["entrypoint"] = json!("bot");
    let payload = json!({
        "version": 1,
        "jobType": "GAME",
        "targetId": GAME,
        "canonicalManifest": manifest,
        "manifestDigest": digest,
        "runtimeProfileDigest": PROFILE,
        "gameId": GAME,
        "rulesRevision": "rules-2026.1",
        "maxTurns": 300,
        "bots": [
            game_bot(1, "CPP", "main.cpp", source.clone(), Some(artifact.clone())),
            game_bot(2, "CPP", "main.cpp", source, Some(artifact)),
        ],
    });
    (payload, digest, sha256_hex(artifact_bytes))
}

/// A complete TEST_GAME assignment as the control plane pins it: white is the testing team's own
/// snapshot Bot (interpreted source), black is the pinned opponent (a compile language, so the
/// granted artifact is what must run at match time — nothing is compiled). The `opponent` document
/// is the control plane's own fact; the worker only checks its shape.
pub fn test_assignment(spool_dir: &Path, artifact_bytes: &[u8]) -> (Value, String, String) {
    let manifest = canonical_manifest(TEST, ATTEMPT, 300);
    let digest = sha256_hex(manifest.as_bytes());
    let white = spool(
        spool_dir,
        "snapshot.zip",
        &zip_stored(&[("bot.py", b"# snapshot\nprint('ready')\n")]),
    );
    let black = spool(
        spool_dir,
        "opponent.zip",
        &zip_stored(&[("main.cpp", b"int main() { return 0; }\n")]),
    );
    let mut artifact = spool(spool_dir, "opponent-artifact", artifact_bytes);
    artifact["entrypoint"] = json!("bot");
    let payload = json!({
        "version": 1,
        "jobType": "TEST_GAME",
        "targetId": TEST,
        "testId": TEST,
        "canonicalManifest": manifest,
        "manifestDigest": digest,
        "runtimeProfileDigest": PROFILE,
        "rulesRevision": "rules-2026.1",
        "maxTurns": 300,
        "bots": [
            game_bot(1, "PYTHON", "bot.py", white, None),
            game_bot(2, "CPP", "main.cpp", black, Some(artifact)),
        ],
        "opponent": { "kind": "OWN_SUBMISSION", "label": "team-latest-submission" },
    });
    (payload, digest, sha256_hex(artifact_bytes))
}

/// The operator toolchain identity an assignment declares for one language.
pub fn toolchain_entry(language: &str, version: &str, flags: &[&str]) -> Value {
    json!({
        "language": language,
        "imageDigest": IMAGE_DIGEST,
        "version": version,
        "flags": flags,
    })
}

/// A complete, valid BUILD assignment with its source ZIP spooled under `spool_dir`.
pub fn build_assignment(spool_dir: &Path, language: &str, entrypoint: &str, flags: &[&str], version: &str) -> (Value, String) {
    let zip = zip_stored(&[(entrypoint, b"print('ready')\n")]);
    // The control plane's project-manifest digest; the fixture only needs a stable 64-hex value.
    let manifest_digest = sha256_hex(&zip);
    let source = spool(spool_dir, "source.zip", &zip);
    let payload = json!({
        "version": 1,
        "jobType": "BUILD",
        "targetId": BUILD_TARGET,
        "language": language,
        "entrypoint": entrypoint,
        "manifestDigest": manifest_digest,
        "toolchain": toolchain_entry(language, version, flags),
        "source": source,
        "limits": { "compileWallMs": 30_000, "initWallMs": 5_000, "initCpuUsec": 500_000 },
    });
    (payload, manifest_digest)
}

/// The claim the gateway hands back: the lease plus the prepared assignment.
pub fn claim(payload: Value, job_type: &str, target_id: &str) -> Value {
    json!({
        "identity": {
            "jobId": LEASE,
            "attemptId": ATTEMPT,
            "grantId": GRANT,
            "fencingToken": "41",
            "deploymentGeneration": 7,
        },
        "jobType": job_type,
        "targetId": target_id,
        "payload": payload,
        "expiresAt": "2026-10-18T00:00:30.000Z",
    })
}

// ---------------------------------------------------------------------------------------------
// Fake broker
// ---------------------------------------------------------------------------------------------

/// What the gateway received through `stageArtifact`.
#[derive(Debug, Clone, Default)]
pub struct Staged {
    pub bytes: Vec<u8>,
    pub digest: String,
    pub size_bytes: u64,
    pub entrypoint: String,
    pub chunks: usize,
    pub refused: Option<String>,
}

pub struct FakeBroker {
    socket: PathBuf,
    _directory: TempDir,
    log: Arc<Mutex<Vec<Value>>>,
    claim_value: Arc<Mutex<Value>>,
    evidence: Arc<Mutex<Option<Value>>>,
    completion: Arc<Mutex<Option<Value>>>,
    staged: Arc<Mutex<Staged>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeBroker {
    pub fn start(claim_value: Value) -> Self {
        let directory = TempDir::new("broker");
        let socket = directory.child("broker.sock");
        let log: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let claim_value = Arc::new(Mutex::new(claim_value));
        let evidence = Arc::new(Mutex::new(None));
        let completion = Arc::new(Mutex::new(None));
        let staged = Arc::new(Mutex::new(Staged::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let listener = UnixListener::bind(&socket).expect("bind fake broker");
        listener.set_nonblocking(true).expect("nonblocking listener");
        let thread = {
            let log = Arc::clone(&log);
            let claim_value = Arc::clone(&claim_value);
            let evidence = Arc::clone(&evidence);
            let completion = Arc::clone(&completion);
            let staged = Arc::clone(&staged);
            let stop = Arc::clone(&stop);
            thread::Builder::new()
                .name("fake-broker".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        match listener.accept() {
                            Ok((mut stream, _)) => {
                                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                                serve(&mut stream, &log, &claim_value, &evidence, &completion, &staged);
                            }
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(1));
                            }
                            Err(_) => break,
                        }
                    }
                })
                .expect("broker thread")
        };
        Self { socket, _directory: directory, log, claim_value, evidence, completion, staged, stop, thread: Some(thread) }
    }

    pub fn socket(&self) -> PathBuf {
        self.socket.clone()
    }

    pub fn operations(&self) -> Vec<String> {
        self.log
            .lock()
            .expect("log")
            .iter()
            .filter_map(|request| request.get("operation").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }

    pub fn request(&self, operation: &str) -> Option<Value> {
        self.log
            .lock()
            .expect("log")
            .iter()
            .find(|request| request.get("operation").and_then(Value::as_str) == Some(operation))
            .cloned()
    }

    pub fn submitted_evidence(&self) -> Option<Value> {
        self.evidence.lock().expect("evidence").clone()
    }

    pub fn submitted_completion(&self) -> Option<Value> {
        self.completion.lock().expect("completion").clone()
    }

    pub fn staged(&self) -> Staged {
        self.staged.lock().expect("staged").clone()
    }

    /// Make the gateway refuse every staging call, as an out-of-contract gateway would.
    pub fn refuse_staging(&self, code: &str) {
        self.staged.lock().expect("staged").refused = Some(code.to_owned());
    }

    pub fn set_claim(&self, value: Value) {
        *self.claim_value.lock().expect("claim") = value;
    }
}

impl Drop for FakeBroker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve(
    stream: &mut UnixStream,
    log: &Arc<Mutex<Vec<Value>>>,
    claim_value: &Arc<Mutex<Value>>,
    evidence: &Arc<Mutex<Option<Value>>>,
    completion: &Arc<Mutex<Option<Value>>>,
    staged: &Arc<Mutex<Staged>>,
) {
    let mut frame = Vec::new();
    if !read_frame(stream, &mut frame).unwrap_or(false) {
        return;
    }
    let Ok(request) = serde_json::from_slice::<Value>(&frame) else {
        return;
    };
    let operation = request.get("operation").and_then(Value::as_str).unwrap_or_default().to_owned();
    let parameters = request.get("parameters").cloned().unwrap_or(Value::Null);
    log.lock().expect("log").push(request);
    let response = match operation.as_str() {
        "claim" => json!({ "ok": true, "value": claim_value.lock().expect("claim").clone() }),
        "heartbeat" => json!({
            "ok": true,
            "value": { "status": "ACTIVE", "expiresAt": "2026-10-18T00:00:30.000Z" },
        }),
        "prepareCompletion" => {
            let submitted = parameters.get("evidence").cloned().unwrap_or(Value::Null);
            let digest = sha256_hex(serde_json::to_string(&submitted).unwrap_or_default().as_bytes());
            *evidence.lock().expect("evidence") = Some(submitted);
            json!({
                "ok": true,
                "value": {
                    "receiptId": COMPLETION,
                    "timestamp": "2026-10-18T00:00:00.000Z",
                    "data": {
                        "completionId": COMPLETION,
                        "state": "COMPLETION_PENDING",
                        "evidenceDigest": digest,
                    },
                },
            })
        }
        "complete" => {
            *completion.lock().expect("completion") = parameters.get("completion").cloned();
            json!({
                "ok": true,
                "value": {
                    "receiptId": COMPLETION,
                    "timestamp": "2026-10-18T00:00:01.000Z",
                    "data": { "state": "ACCEPTED" },
                },
            })
        }
        "stageArtifact" => stage_artifact(&parameters, staged),
        _ => json!({ "ok": false, "code": "UNKNOWN_OPERATION" }),
    };
    let body = serde_json::to_vec(&response).expect("response serializes");
    let _ = write_frame(stream, &body);
    let _ = stream.flush();
}

/// The gateway's own staging contract: ascending offsets, no gaps, one identity per artifact, and a
/// whole-file SHA-256 check before `staged: true`.
fn stage_artifact(parameters: &Value, staged: &Arc<Mutex<Staged>>) -> Value {
    let mut state = staged.lock().expect("staged");
    if let Some(refused) = &state.refused {
        return json!({ "ok": false, "code": refused });
    }
    let Some(chunk) = parameters.get("chunk") else {
        return json!({ "ok": false, "code": "INVALID_REQUEST" });
    };
    let offset = chunk.get("offset").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let digest = chunk.get("digest").and_then(Value::as_str).unwrap_or_default().to_owned();
    let size_bytes = chunk.get("sizeBytes").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let entrypoint = chunk.get("entrypoint").and_then(Value::as_str).unwrap_or_default().to_owned();
    let Some(data) = chunk.get("data").and_then(Value::as_str).and_then(decode_base64) else {
        return json!({ "ok": false, "code": "INVALID_REQUEST" });
    };
    if state.chunks == 0 {
        state.digest = digest;
        state.size_bytes = size_bytes;
        state.entrypoint = entrypoint;
    } else if state.digest != digest || state.size_bytes != size_bytes || state.entrypoint != entrypoint {
        return json!({ "ok": false, "code": "INVALID_REQUEST" });
    }
    state.chunks += 1;
    if offset as usize == state.bytes.len() {
        state.bytes.extend_from_slice(&data);
    } else if (offset as usize) < state.bytes.len() {
        // A fully repeated chunk is an idempotent retry; anything else is a protocol violation.
        return json!({ "ok": false, "code": "INVALID_REQUEST" });
    } else {
        return json!({ "ok": false, "code": "INVALID_REQUEST" });
    }
    let received = state.bytes.len() as u64;
    if received == state.size_bytes {
        if sha256_hex(&state.bytes) != state.digest {
            state.refused = Some("ARTIFACT_DIGEST_MISMATCH".to_owned());
            return json!({ "ok": false, "code": "ARTIFACT_DIGEST_MISMATCH" });
        }
        return json!({ "ok": true, "value": { "staged": true, "received": received, "digest": state.digest } });
    }
    if received > state.size_bytes {
        return json!({ "ok": false, "code": "INVALID_REQUEST" });
    }
    json!({ "ok": true, "value": { "staged": false, "received": received } })
}

// ---------------------------------------------------------------------------------------------
// Scripted workloads
// ---------------------------------------------------------------------------------------------

/// One scripted Bot response, or the failure the sandbox would report instead.
pub enum Step {
    Response(&'static str),
    OutputLimit,
    ProtocolViolation,
    CpuTimeout,
    WallTimeout,
    UnmeasuredBudget,
}

#[derive(Default)]
pub struct FactoryState {
    pub requests: Vec<(u8, bool, String)>,
    pub stopped: Vec<u8>,
    pub launched: Vec<u8>,
    pub budgets: Vec<BudgetKey>,
}

/// The budgets a workload was launched with, comparable without exposing the sandbox internals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetKey {
    pub startup_cpu_usec: u64,
    pub startup_wall_ms: u128,
}

pub struct FakeFactory {
    steps: [Arc<Mutex<Vec<Step>>>; 2],
    pub state: Arc<Mutex<FactoryState>>,
    fail_teardown: Arc<AtomicBool>,
}

impl FakeFactory {
    pub fn new(white: Vec<Step>, black: Vec<Step>) -> Self {
        Self {
            steps: [Arc::new(Mutex::new(white)), Arc::new(Mutex::new(black))],
            state: Arc::new(Mutex::new(FactoryState::default())),
            fail_teardown: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Make every workload's teardown fail, as a host whose cgroup never empties would.
    pub fn fail_teardown(&self) {
        self.fail_teardown.store(true, Ordering::Release);
    }

    pub fn requests(&self) -> Vec<(u8, bool, String)> {
        self.state.lock().expect("state").requests.clone()
    }

    pub fn budgets(&self) -> Vec<BudgetKey> {
        self.state.lock().expect("state").budgets.clone()
    }

    pub fn launched(&self) -> Vec<u8> {
        self.state.lock().expect("state").launched.clone()
    }

    pub fn stopped(&self) -> Vec<u8> {
        self.state.lock().expect("state").stopped.clone()
    }
}

struct FakeWorkload {
    side: u8,
    steps: Arc<Mutex<Vec<Step>>>,
    state: Arc<Mutex<FactoryState>>,
    fail_teardown: Arc<AtomicBool>,
}

impl Workload for FakeWorkload {
    fn exchange(&mut self, request: &[u8], startup: bool) -> io::Result<Exchange> {
        let text = String::from_utf8_lossy(request).to_string();
        self.state.lock().expect("state").requests.push((self.side, startup, text));
        let step = {
            let mut steps = self.steps.lock().expect("steps");
            if steps.is_empty() {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "script exhausted"));
            }
            steps.remove(0)
        };
        match step {
            Step::Response(body) => Ok(Exchange {
                response: body.as_bytes().to_vec(),
                cpu_usec: 1_200,
                wall_usec: 2_400,
            }),
            Step::OutputLimit => Err(io::Error::new(io::ErrorKind::InvalidData, BotOutputFault::OutputLimit)),
            Step::ProtocolViolation => Err(io::Error::new(io::ErrorKind::InvalidData, BotOutputFault::ProtocolViolation)),
            Step::CpuTimeout => Err(io::Error::new(io::ErrorKind::TimedOut, "Bot CPU deadline exceeded")),
            Step::WallTimeout => Err(io::Error::new(io::ErrorKind::TimedOut, "Bot wall deadline exceeded")),
            Step::UnmeasuredBudget => Err(io::Error::new(io::ErrorKind::TimedOut, "response exceeded resource budget")),
        }
    }

    fn stop(&mut self) -> io::Result<()> {
        self.state.lock().expect("state").stopped.push(self.side);
        if self.fail_teardown.load(Ordering::Acquire) {
            return Err(io::Error::other("workload cgroup did not empty"));
        }
        Ok(())
    }
}

impl WorkloadFactory for FakeFactory {
    fn launch(&self, layout: &BotLayout, _attempt_id: &str, budgets: Budgets) -> io::Result<Box<dyn Workload>> {
        let index = (layout.side - 1) as usize;
        {
            let mut state = self.state.lock().expect("state");
            state.launched.push(layout.side);
            state.budgets.push(BudgetKey {
                startup_cpu_usec: budgets.startup.cpu_usec,
                startup_wall_ms: budgets.startup.wall.as_millis(),
            });
        }
        Ok(Box::new(FakeWorkload {
            side: layout.side,
            steps: Arc::clone(&self.steps[index]),
            state: Arc::clone(&self.state),
            fail_teardown: Arc::clone(&self.fail_teardown),
        }))
    }
}

// ---------------------------------------------------------------------------------------------
// Scripted toolchain runner
// ---------------------------------------------------------------------------------------------

/// One scripted toolchain command.
pub enum RunnerStep {
    /// The command reported this outcome.
    Outcome(CommandOutcome),
    /// A `SOURCE_REJECTED` compile: the compiler wrote this diagnostic and failed.
    CompileFailure(Vec<u8>),
    /// The compile step wrote these bytes as the artifact and succeeded.
    Produces(Vec<u8>),
    /// The sandbox itself faulted.
    Fault(&'static str),
}

impl RunnerStep {
    pub fn succeeded() -> Self {
        Self::Outcome(CommandOutcome::Exited { status: 0, diagnostic: Vec::new(), truncated: false })
    }

    pub fn version(line: &str) -> Self {
        Self::Outcome(CommandOutcome::Exited {
            status: 0,
            diagnostic: format!("{line}\n").into_bytes(),
            truncated: false,
        })
    }
}

#[derive(Default)]
pub struct RunnerState {
    pub calls: Vec<(PathBuf, u128)>,
}

pub struct ScriptedRunner {
    steps: Mutex<Vec<RunnerStep>>,
    pub state: Arc<Mutex<RunnerState>>,
}

impl ScriptedRunner {
    pub fn new(steps: Vec<RunnerStep>) -> Self {
        Self { steps: Mutex::new(steps), state: Arc::new(Mutex::new(RunnerState::default())) }
    }

    pub fn calls(&self) -> Vec<(PathBuf, u128)> {
        self.state.lock().expect("state").calls.clone()
    }
}

impl SandboxRunner for ScriptedRunner {
    fn run(&self, bundle: &Path, layout: &arena_supervisor::materialize::BuildLayout, wall: Duration) -> io::Result<CommandOutcome> {
        self.state
            .lock()
            .expect("state")
            .calls
            .push((bundle.to_path_buf(), wall.as_millis()));
        let step = {
            let mut steps = self.steps.lock().expect("steps");
            if steps.is_empty() {
                return Err(io::Error::other("runner script exhausted"));
            }
            steps.remove(0)
        };
        match step {
            RunnerStep::Outcome(outcome) => Ok(outcome),
            RunnerStep::Fault(message) => Err(io::Error::other(message)),
            RunnerStep::CompileFailure(diagnostic) => Ok(CommandOutcome::Exited {
                status: 1,
                diagnostic,
                truncated: false,
            }),
            RunnerStep::Produces(bytes) => {
                let path = layout.artifact_path();
                fs::write(&path, &bytes).map_err(|error| io::Error::other(error.to_string()))?;
                Ok(CommandOutcome::Exited { status: 0, diagnostic: Vec::new(), truncated: false })
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Configuration fixtures
// ---------------------------------------------------------------------------------------------

/// The operator's toolchain document, matching [`toolchain_entry`].
pub fn toolchains() -> Toolchains {
    let parse = |rootfs: &str, version: &str, flags: &[&str]| ToolchainProfile {
        rootfs: PathBuf::from(rootfs),
        image_digest: hex_decode(IMAGE_DIGEST),
        version: version.to_owned(),
        flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
    };
    Toolchains {
        python: parse("/opt/toolchains/python", "3.12.3", &["-m", "py_compile"]),
        typescript: parse("/opt/toolchains/node", "22.5.0", &[]),
        cpp: parse("/opt/toolchains/cpp", "13.2.0", &["-O2", "-std=c++20"]),
    }
}

/// The same document, pointing at rootfs directories that exist under `root`: materialization
/// requires a real, private directory for the language it is about to run.
pub fn toolchains_at(root: &Path) -> Toolchains {
    let parse = |language: &str, version: &str, flags: &[&str]| ToolchainProfile {
        rootfs: {
            let rootfs = root.join(language.to_ascii_lowercase());
            fs::create_dir_all(&rootfs).expect("toolchain rootfs");
            fs::set_permissions(&rootfs, fs::Permissions::from_mode(0o700)).expect("rootfs mode");
            rootfs
        },
        image_digest: hex_decode(IMAGE_DIGEST),
        version: version.to_owned(),
        flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
    };
    Toolchains {
        python: parse("PYTHON", "3.12.3", &["-m", "py_compile"]),
        typescript: parse("TYPESCRIPT", "22.5.0", &[]),
        cpp: parse("CPP", "13.2.0", &["-O2", "-std=c++20"]),
    }
}

fn hex_decode(text: &str) -> [u8; 32] {
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).expect("hex");
    }
    digest
}

pub fn config(socket: PathBuf, attempts: &TempDir, cgroups: &TempDir, rootfs: &TempDir) -> WorkerConfig {
    WorkerConfig {
        broker_socket: socket,
        runsc: PathBuf::from("/opt/arena/runsc"),
        runtime_rootfs: rootfs.path().clone(),
        cgroup_root: cgroups.path().clone(),
        attempt_root: attempts.path().clone(),
        runtime_profile_digest: PROFILE.to_owned(),
        max_game_slots: 2,
        max_build_slots: 0,
        toolchains: None,
        artifact_output_root: None,
        heartbeat: Duration::from_secs(5),
        poll: Duration::from_millis(10),
        once: true,
    }
}

pub fn build_config(
    socket: PathBuf,
    attempts: &TempDir,
    cgroups: &TempDir,
    toolchains_root: &TempDir,
    output_root: &TempDir,
) -> WorkerConfig {
    WorkerConfig {
        broker_socket: socket,
        runsc: PathBuf::from("/opt/arena/runsc"),
        runtime_rootfs: toolchains_root.path().clone(),
        cgroup_root: cgroups.path().clone(),
        attempt_root: attempts.path().clone(),
        runtime_profile_digest: PROFILE.to_owned(),
        max_game_slots: 0,
        max_build_slots: 1,
        toolchains: Some(toolchains_at(toolchains_root.path())),
        artifact_output_root: Some(output_root.path().clone()),
        heartbeat: Duration::from_secs(5),
        poll: Duration::from_millis(10),
        once: true,
    }
}

/// The three-ply throne breach the acceptance suite proves against the native verifier.
pub const READY: &str = "{\"status\":\"READY\"}\n";

pub fn winning_white() -> Vec<Step> {
    vec![
        Step::Response(READY),
        Step::Response("{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[1,2]}\n"),
        Step::Response("{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[2,2]}\n"),
    ]
}

pub fn winning_black() -> Vec<Step> {
    vec![
        Step::Response(READY),
        Step::Response("{\"action\":\"MOVE\",\"piece_id\":2,\"target\":[1,1]}\n"),
    ]
}
