//! Controller for an already provisioned, private workload cgroup. Paths must
//! come from the trusted launcher, never from an API or Bot request.
use crate::cgroup::{parse_snapshot, CgroupSnapshot};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

fn read_snapshot(
    mut events: impl FnMut() -> io::Result<String>,
    mut cpu: impl FnMut() -> io::Result<String>,
) -> io::Result<CgroupSnapshot> {
    // A frozen event must be observed before sampling terminal CPU usage.
    // The lifecycle owner must prevent concurrent unfreeze until accounting ends.
    let events = events()?;
    let cpu = cpu()?;
    parse_snapshot(&cpu, &events)
}

pub struct CgroupControl {
    freeze: File,
    kill: File,
    cpu: File,
    events: File,
}

impl CgroupControl {
    pub fn open(path: &Path) -> io::Result<Self> {
        // Linux O_NOFOLLOW; missing files are never created. Parent-directory
        // ownership and cgroup membership remain launcher prerequisites.
        const O_NOFOLLOW: i32 = 0x20000;
        let read = |name| OpenOptions::new().read(true).custom_flags(O_NOFOLLOW).open(path.join(name));
        let write = |name| OpenOptions::new().write(true).custom_flags(O_NOFOLLOW).open(path.join(name));
        Ok(Self { freeze: write("cgroup.freeze")?, kill: write("cgroup.kill")?, cpu: read("cpu.stat")?, events: read("cgroup.events")? })
    }

    fn snapshot(&mut self) -> io::Result<CgroupSnapshot> {
        fn read(file: &mut File) -> io::Result<String> {
            file.seek(SeekFrom::Start(0))?;
            let mut contents = String::new();
            file.take(65537).read_to_string(&mut contents)?;
            if contents.len() > 65536 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "oversized cgroup counters"));
            }
            Ok(contents)
        }
        read_snapshot(|| read(&mut self.events), || read(&mut self.cpu))
    }

    fn wait(&mut self, timeout: Duration, predicate: impl Fn(&CgroupSnapshot) -> bool) -> io::Result<CgroupSnapshot> {
        let started = Instant::now();
        loop {
            let snapshot = self.snapshot()?;
            if predicate(&snapshot) {
                return Ok(snapshot);
            }
            let remaining = timeout.checked_sub(started.elapsed()).filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "cgroup transition not confirmed"))?;
            thread::sleep(Duration::from_millis(1).min(remaining));
        }
    }

    pub fn freeze(&mut self, timeout: Duration) -> io::Result<CgroupSnapshot> {
        let file = &mut self.freeze;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(b"1")?;
        self.wait(timeout, |state| state.frozen)
    }

    pub fn unfreeze(&mut self, timeout: Duration) -> io::Result<CgroupSnapshot> {
        let file = &mut self.freeze;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(b"0")?;
        self.wait(timeout, |state| !state.frozen)
    }

    pub fn kill_and_wait(&mut self, timeout: Duration) -> io::Result<()> {
        let file = &mut self.kill;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(b"1")?;
        self.wait(timeout, |state| !state.populated)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn confirmed_freeze_counter_includes_cpu_until_freezer_completion() {
        let frozen = Cell::new(false);
        let snapshot = read_snapshot(
            || { frozen.set(true); Ok("populated 1\nfrozen 1\n".into()) },
            || Ok(format!("usage_usec {}\n", if frozen.get() { 100001 } else { 99999 })),
        ).unwrap();
        assert!(snapshot.frozen);
        assert_eq!(snapshot.usage_usec, 100001);
    }
}
