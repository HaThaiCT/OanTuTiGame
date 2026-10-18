use arena_supervisor::output::{BotOutput, OutputError};

#[test]
fn fragmented_utf8_line_is_delivered_once_without_losing_bytes() {
    let mut output = BotOutput::new();
    let mut lines = Vec::new();
    for bytes in [b"{\"x\":\"\xc3".as_slice(), b"\xa9\"}\n".as_slice()] {
        output.stdout(bytes, |line| lines.push(line.to_owned())).unwrap();
    }
    assert_eq!(lines, ["{\"x\":\"é\"}"]);
    output.finish_stdout().unwrap();
}

#[test]
fn newline_free_output_hits_line_cap_and_failure_stays_terminal() {
    let mut output = BotOutput::new();
    output.stdout(&vec![b'x'; 16383], |_| panic!("no newline yet")).unwrap();
    assert_eq!(output.stdout(b"x", |_| {}), Err(OutputError::OutputLimit));
    assert_eq!(output.stdout(b"\n", |_| panic!("terminal state")), Err(OutputError::OutputLimit));
}

#[test]
fn stderr_truncation_keeps_draining_and_combined_bytes_enforced() {
    let mut output = BotOutput::new();
    output.stderr(&vec![b'e'; 65537]).unwrap();
    assert_eq!(output.retained_stderr().len(), 65536);
    assert!(output.stderr_truncated());
    output.stderr(&vec![b'e'; 2 * 1024 * 1024 - 65537]).unwrap();
    assert_eq!(output.stderr(b"!"), Err(OutputError::OutputLimit));
}

#[test]
fn total_stdout_cap_counts_utf8_bytes_and_newlines() {
    let mut output = BotOutput::new();
    let line = vec![b'\n'; 16384];
    for _ in 0..64 { output.stdout(&line, |_| {}).unwrap(); }
    assert_eq!(output.stdout(b"\n", |_| {}), Err(OutputError::OutputLimit));
}

#[test]
fn malformed_utf8_and_truncated_line_are_protocol_errors() {
    let mut malformed = BotOutput::new();
    assert_eq!(malformed.stdout(&[255, b'\n'], |_| {}), Err(OutputError::InvalidUtf8));
    let mut partial = BotOutput::new();
    partial.stdout(b"{}", |_| {}).unwrap();
    assert_eq!(partial.finish_stdout(), Err(OutputError::IncompleteLine));
}

#[test]
fn combined_limit_counts_both_streams_after_stderr_truncation() {
    let mut output = BotOutput::new();
    output.stderr(&vec![b'e'; 1024 * 1024]).unwrap();
    for _ in 0..64 { output.stdout(&vec![b'\n'; 16384], |_| {}).unwrap(); }
    assert_eq!(output.stderr(b"!"), Err(OutputError::OutputLimit));
    assert!(output.stderr_truncated());
}

#[test]
fn exact_wire_line_limit_accepts_its_newline() {
    let mut output = BotOutput::new();
    let mut line = vec![b'x'; 16383];
    line.push(b'\n');
    let mut delivered = 0;
    output.stdout(&line, |text| { assert_eq!(text.len(), 16383); delivered += 1; }).unwrap();
    assert_eq!(delivered, 1);
}

#[test]
fn stdout_eof_cannot_be_reopened_but_stderr_can_finish_draining() {
    let mut output = BotOutput::new();
    output.stdout(b"{}\n", |_| {}).unwrap();
    output.finish_stdout().unwrap();
    output.finish_stdout().unwrap();
    output.stderr(b"remaining diagnostics").unwrap();
    assert!(output.stdout(b"late\n", |_| panic!("closed stdout delivered a line")).is_err());
}
