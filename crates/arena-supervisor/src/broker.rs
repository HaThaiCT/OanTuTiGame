//! Linux-only job broker transport. Credentials come exclusively from SO_PEERCRED.
use crate::ipc::{read_frame, write_frame, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

pub struct BrokerClient { socket: std::path::PathBuf }
impl BrokerClient {
    pub fn new(socket: impl Into<std::path::PathBuf>) -> Self { Self { socket: socket.into() } }
    pub fn request(&self, operation: &str, parameters: Value) -> io::Result<Value> {
        let mut stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(15)))?;
        stream.set_write_timeout(Some(Duration::from_secs(15)))?;
        write_frame(&mut stream, &serde_json::to_vec(&json!({"operation": operation, "parameters": parameters}))?)?;
        let mut response = Vec::new();
        if !read_frame(&mut stream, &mut response)? { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "broker closed")); }
        let envelope: Value = serde_json::from_slice(&response)?;
        if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, envelope.get("code").and_then(Value::as_str).unwrap_or("invalid broker response")));
        }
        envelope.get("value").cloned().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing broker result"))
    }
    pub fn claim(&self, capacity: Value, options: Value) -> io::Result<Value> { self.request("claim", json!({"capacity": capacity, "options": options})) }
    pub fn heartbeat(&self, lease: Value) -> io::Result<Value> { self.request("heartbeat", json!({"lease": lease})) }
    pub fn prepare_completion(&self, lease: Value, evidence: Value) -> io::Result<Value> { self.request("prepareCompletion", json!({"lease": lease, "evidence": evidence})) }
    pub fn complete(&self, completion: Value) -> io::Result<Value> { self.request("complete", json!({"completion": completion})) }
}

fn credentials(stream: &UnixStream) -> io::Result<libc::ucred> {
    let mut value = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt writes at most length bytes into a correctly sized ucred.
    let result = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, value.as_mut_ptr().cast(), &mut length) };
    if result != 0 { return Err(io::Error::last_os_error()); }
    if length as usize != std::mem::size_of::<libc::ucred>() { return Err(io::Error::other("invalid peer credentials")); }
    // SAFETY: successful getsockopt initialized the entire structure.
    Ok(unsafe { value.assume_init() })
}

/// The parent owns the inherited pipes. No network client can supply the envelope credentials.
/// The socket's parent directory must be provisioned by the operator; never unlink an existing path.
pub fn serve(socket: &Path, allowed_uid: u32, socket_gid: u32) -> io::Result<()> {
    let listener = UnixListener::bind(socket)?;
    let result = (|| {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(socket.as_os_str().as_bytes())?;
        // SAFETY: path is NUL-terminated and remains alive for chown.
        if unsafe { libc::chown(path.as_ptr(), !0, socket_gid) } != 0 { return Err(io::Error::last_os_error()); }
        std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o660))?;
        let stdin = io::stdin();
        let stdout = io::stdout();
        let mut input = stdin.lock();
        let mut output = stdout.lock();
        write_frame(&mut output, b"{\"ready\":true}")?;
        output.flush()?;
        let mut request = Vec::new();
        let mut response = Vec::new();
        for connection in listener.incoming() {
            let mut stream = connection?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            let peer = credentials(&stream)?;
            if peer.uid != allowed_uid || peer.pid <= 0 { continue; }
            if !matches!(read_frame(&mut stream, &mut request), Ok(true)) { continue; }
            let body: Value = match serde_json::from_slice(&request) { Ok(value) => value, Err(_) => continue };
            let envelope = match serde_json::to_vec(&json!({"uid": peer.uid, "pid": peer.pid, "request": body})) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            // The envelope is larger than the request it wraps, so a request that fits its own
            // frame can still overflow the parent frame. Reject that one connection instead of
            // letting a single worker request terminate the trusted gateway.
            if envelope.len() > MAX_FRAME_BYTES {
                let _ = write_frame(&mut stream, br#"{"ok":false,"code":"REQUEST_TOO_LARGE"}"#);
                continue;
            }
            write_frame(&mut output, &envelope)?;
            output.flush()?;
            if !read_frame(&mut input, &mut response)? { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "broker parent closed")); }
            // A disconnected worker does not terminate the trusted gateway.
            let _ = write_frame(&mut stream, &response);
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(socket);
    result
}
