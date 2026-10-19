#![cfg(target_os = "linux")]
use arena_supervisor::{broker::BrokerClient, ipc::{read_frame, write_frame, MAX_FRAME_BYTES}};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn native_client_binds_all_operations_to_kernel_identity() {
    let root = std::env::temp_dir().join(format!("arena-broker-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let socket = root.join("broker.sock");
    // SAFETY: getuid/getgid have no preconditions.
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let mut child = Command::new(env!("CARGO_BIN_EXE_arena-job-broker"))
        .args([socket.to_str().unwrap(), &uid.to_string(), &gid.to_string()])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut frame = Vec::new();
    assert!(read_frame(&mut output, &mut frame).unwrap());
    assert_eq!(serde_json::from_slice::<Value>(&frame).unwrap(), json!({"ready": true}));
    let relay = std::thread::spawn(move || {
        for expected in ["claim", "heartbeat", "prepareCompletion", "complete"] {
            assert!(read_frame(&mut output, &mut frame).unwrap());
            let envelope: Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(envelope["uid"], uid);
            assert_eq!(envelope["pid"], std::process::id());
            assert_eq!(envelope["request"]["operation"], expected);
            // Forged body identities remain body data, never transport credentials.
            assert_ne!(envelope["uid"], envelope["request"]["parameters"]["uid"]);
            write_frame(&mut input, br#"{"ok":true,"value":{"accepted":true}}"#).unwrap();
            input.flush().unwrap();
        }
    });
    let client = BrokerClient::new(&socket);
    for operation in ["claim", "heartbeat", "prepareCompletion", "complete"] {
        assert_eq!(client.request(operation, json!({"uid": uid.saturating_add(1)})).unwrap(), json!({"accepted": true}));
    }
    relay.join().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

/// A request that fits its own frame can still overflow the parent frame once the gateway wraps it
/// with kernel-provided credentials. That must reject the single connection, never the gateway.
#[test]
fn oversized_request_is_rejected_without_terminating_the_gateway() {
    use std::os::unix::net::UnixStream;
    let root = std::env::temp_dir().join(format!("arena-broker-oversize-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let socket = root.join("broker.sock");
    // SAFETY: getuid/getgid have no preconditions.
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let mut child = Command::new(env!("CARGO_BIN_EXE_arena-job-broker"))
        .args([socket.to_str().unwrap(), &uid.to_string(), &gid.to_string()])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut frame = Vec::new();
    assert!(read_frame(&mut output, &mut frame).unwrap());
    assert_eq!(serde_json::from_slice::<Value>(&frame).unwrap(), json!({"ready": true}));

    // Valid JSON, inside the frame limit, larger than the frame once wrapped.
    let prefix = br#"{"operation":"claim","parameters":{"pad":""#;
    let suffix = br#""}}"#;
    let mut body = Vec::with_capacity(MAX_FRAME_BYTES);
    body.extend_from_slice(prefix);
    body.resize(MAX_FRAME_BYTES - suffix.len(), b'A');
    body.extend_from_slice(suffix);
    assert_eq!(body.len(), MAX_FRAME_BYTES);
    let mut oversized = UnixStream::connect(&socket).unwrap();
    oversized.set_read_timeout(Some(std::time::Duration::from_secs(15))).unwrap();
    write_frame(&mut oversized, &body).unwrap();
    let mut reply = Vec::new();
    assert!(read_frame(&mut oversized, &mut reply).unwrap());
    assert_eq!(serde_json::from_slice::<Value>(&reply).unwrap(), json!({"ok": false, "code": "REQUEST_TOO_LARGE"}));

    let relay = std::thread::spawn(move || {
        assert!(read_frame(&mut output, &mut frame).unwrap());
        let envelope: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(envelope["request"]["operation"], "claim");
        write_frame(&mut input, br#"{"ok":true,"value":{"accepted":true}}"#).unwrap();
        input.flush().unwrap();
    });
    let client = BrokerClient::new(&socket);
    assert_eq!(client.request("claim", json!({"pad": "small"})).unwrap(), json!({"accepted": true}));
    relay.join().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
