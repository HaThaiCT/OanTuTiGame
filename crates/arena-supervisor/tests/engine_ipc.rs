use arena_supervisor::ipc::{read_frame, write_frame, MAX_FRAME_BYTES};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::net::UnixStream;

#[test]
fn oversized_header_is_rejected_without_payload_read_or_buffer_growth() {
    struct HeaderOnly(Cursor<[u8; 4]>);
    impl Read for HeaderOnly {
        fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
            assert!(self.0.position() < 4, "oversized frame attempted payload read");
            self.0.read(dst)
        }
    }
    let mut source = HeaderOnly(Cursor::new(((MAX_FRAME_BYTES + 1) as u32).to_be_bytes()));
    let mut buffer = Vec::new();
    let result = read_frame(&mut source, &mut buffer);
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    assert_eq!(buffer.capacity(), 0);
}

#[test]
fn clean_eof_is_distinct_from_truncated_header() {
    assert!(!read_frame(&mut Cursor::new([]), &mut Vec::new()).unwrap());
    assert_eq!(read_frame(&mut Cursor::new([0, 0]), &mut Vec::new()).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
}

#[test]
fn empty_and_oversized_writes_emit_no_bytes() {
    for payload in [Vec::new(), vec![0; MAX_FRAME_BYTES + 1]] {
        let mut wire = Vec::new();
        assert_eq!(write_frame(&mut wire, &payload).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert!(wire.is_empty());
    }
}

#[test]
fn zero_length_header_is_invalid() {
    assert_eq!(read_frame(&mut Cursor::new([0; 4]), &mut Vec::new()).unwrap_err().kind(), io::ErrorKind::InvalidData);
}

#[test]
fn truncated_payload_is_not_a_complete_message() {
    let mut wire = Cursor::new([0, 0, 0, 3, 1, 2]);
    assert_eq!(read_frame(&mut wire, &mut Vec::new()).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
}

#[test]
fn max_frame_and_following_frame_cross_actual_unix_socket() {
    let (mut sender, mut receiver) = UnixStream::pair().unwrap();
    let task = std::thread::spawn(move || {
        write_frame(&mut sender, &vec![42; MAX_FRAME_BYTES]).unwrap();
        write_frame(&mut sender, b"next").unwrap();
    });
    let mut buffer = Vec::new();
    assert!(read_frame(&mut receiver, &mut buffer).unwrap());
    assert!(buffer.iter().all(|b| *b == 42));
    assert_eq!(buffer.len(), MAX_FRAME_BYTES);
    assert!(read_frame(&mut receiver, &mut buffer).unwrap());
    assert_eq!(buffer, b"next");
    assert!(!read_frame(&mut receiver, &mut buffer).unwrap());
    task.join().unwrap();
}

#[test]
fn wire_prefix_is_big_endian() {
    let mut wire = Vec::new();
    write_frame(&mut wire, b"abc").unwrap();
    assert_eq!(wire, [0, 0, 0, 3, b'a', b'b', b'c']);
}

#[test]
fn fragmented_header_and_payload_are_reassembled() {
    let (mut sender, mut receiver) = UnixStream::pair().unwrap();
    let task = std::thread::spawn(move || {
        for byte in [0, 0, 0, 2, 9, 8] {
            sender.write_all(&[byte]).unwrap();
        }
    });
    let mut buffer = Vec::new();
    assert!(read_frame(&mut receiver, &mut buffer).unwrap());
    assert_eq!(buffer, [9, 8]);
    task.join().unwrap();
}
