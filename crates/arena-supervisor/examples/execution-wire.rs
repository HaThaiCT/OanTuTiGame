//! Trusted codec probe, not a workload executor. Reads one framed envelope from
//! stdin, decodes/re-encodes with generated Prost, writes one frame to stdout.
use arena_supervisor::{execution::Envelope, ipc::{read_frame, write_frame}};
use prost::Message;
use std::io;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut payload = Vec::new();
    if !read_frame(&mut io::stdin().lock(), &mut payload)? {
        return Err("missing envelope".into());
    }
    let decoded = Envelope::decode(payload.as_slice())?;
    write_frame(&mut io::stdout().lock(), &decoded.encode_to_vec())?;
    Ok(())
}
