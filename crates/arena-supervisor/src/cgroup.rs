//! Read-only cgroup-v2 accounting. Missing counters are infrastructure failures.
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

const MAX_COUNTER_FILE_BYTES: u64 = 65536;

#[derive(Debug, PartialEq, Eq)]
pub struct CgroupSnapshot {
    pub usage_usec: u64,
    pub frozen: bool,
    pub populated: bool,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid cgroup accounting data")
}

fn field(text: &str, name: &str) -> io::Result<u64> {
    let mut result = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().ok_or_else(invalid)?;
        let value = parts.next().ok_or_else(invalid)?;
        if parts.next().is_some() {
            return Err(invalid());
        }
        if key == name {
            if result.is_some() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid());
            }
            result = Some(value.parse::<u64>().map_err(|_| invalid())?);
        }
    }
    result.ok_or_else(invalid)
}

pub fn parse_snapshot(cpu_stat: &str, events: &str) -> io::Result<CgroupSnapshot> {
    let frozen = field(events, "frozen")?;
    let populated = field(events, "populated")?;
    if frozen > 1 || populated > 1 {
        return Err(invalid());
    }
    Ok(CgroupSnapshot {
        usage_usec: field(cpu_stat, "usage_usec")?,
        frozen: frozen == 1,
        populated: populated == 1,
    })
}

pub fn cpu_delta(before: u64, after: u64) -> io::Result<u64> {
    after.checked_sub(before).ok_or_else(invalid)
}

fn read_counter(path: &Path) -> io::Result<String> {
    let file = File::open(path)?;
    let mut contents = String::new();
    file.take(MAX_COUNTER_FILE_BYTES + 1).read_to_string(&mut contents)?;
    if contents.len() as u64 > MAX_COUNTER_FILE_BYTES {
        return Err(invalid());
    }
    Ok(contents)
}

impl CgroupSnapshot {
    /// Counters are sampled sequentially, not atomically. Frozen confirmation and
    /// workload ownership must be established by the lifecycle controller.
    pub fn read(path: &Path) -> io::Result<Self> {
        parse_snapshot(&read_counter(&path.join("cpu.stat"))?, &read_counter(&path.join("cgroup.events"))?)
    }
}
