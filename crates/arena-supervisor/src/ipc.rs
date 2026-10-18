//! Length-delimited execution transport; payload semantics belong to execution.proto.
use std::io::{self, Read, Write};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Returns false only for clean EOF before the next header. Any error terminates
/// the transport: callers must not parse or reuse a partially received payload.
pub fn read_frame(reader: &mut impl Read, buffer: &mut Vec<u8>) -> io::Result<bool> {
    let mut header = [0_u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(false),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid execution frame length"));
    }
    buffer.resize(length, 0);
    reader.read_exact(buffer)?;
    Ok(true)
}

pub fn write_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid execution frame length"));
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(payload)
}
