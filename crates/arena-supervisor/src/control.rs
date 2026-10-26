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

/// Fixed ArenaRuntime/v1 limits, shared by OCI generation and kernel enforcement.
#[derive(Clone, Copy)]
pub struct WorkloadLimits {
    pub memory: u64,
    pub pids: u64,
    pub files: u64,
}
impl WorkloadLimits {
    pub const BOT: Self = Self { memory: 268435456, pids: 32, files: 64 };
    pub const COMPILE: Self = Self { memory: 1073741824, pids: 64, files: 128 };

    pub fn apply(self, path: &Path) -> io::Result<()> {
        for (name, expected) in [
            ("cpu.max", "100000 100000".to_owned()),
            ("memory.max", self.memory.to_string()),
            ("memory.swap.max", "0".to_owned()),
            ("pids.max", self.pids.to_string()),
        ] {
            // Never create a missing controller file or follow a substituted symlink.
            let mut file = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW).open(path.join(name))?;
            file.write_all(expected.as_bytes())?;
            file.seek(SeekFrom::Start(0))?;
            let mut actual = String::new();
            file.take(256).read_to_string(&mut actual)?;
            if actual.trim() != expected {
                return Err(io::Error::other(format!("workload limit {name} readback mismatch")));
            }
        }
        Ok(())
    }
}

/// Enable controllers only in an empty internal delegated cgroup.
pub fn enable_workload_controllers(path: &Path) -> io::Result<()> {
    let read = |name| std::fs::read_to_string(path.join(name));
    if !read("cgroup.procs")?.trim().is_empty() {
        return Err(io::Error::other("workload controller parent contains processes"));
    }
    let available = read("cgroup.controllers")?;
    if ["cpu", "memory", "pids"].iter().any(|name| !available.split_whitespace().any(|item| item == *name)) {
        return Err(io::Error::other("required workload controller unavailable"));
    }
    let mut file = OpenOptions::new().write(true).custom_flags(libc::O_NOFOLLOW).open(path.join("cgroup.subtree_control"))?;
    file.write_all(b"+cpu +memory +pids")?;
    let enabled = read("cgroup.subtree_control")?;
    if ["cpu", "memory", "pids"].iter().any(|name| !enabled.split_whitespace().any(|item| item == *name)) {
        return Err(io::Error::other("workload controller enablement not confirmed"));
    }
    Ok(())
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
    fn fixed_workload_limits_match_the_pinned_runtime_profile() {
        let profile: serde_json::Value = serde_json::from_str(include_str!("../../../deploy/linux/runtime-profile.json")).unwrap();
        assert_eq!(profile["revision"], "ArenaRuntime/v1");
        for (name, limits) in [("bot", WorkloadLimits::BOT), ("compile", WorkloadLimits::COMPILE)] {
            assert_eq!(profile[name]["memoryMaxBytes"], limits.memory);
            assert_eq!(profile[name]["memorySwapMaxBytes"], 0);
            assert_eq!(profile[name]["pidsMax"], limits.pids);
            assert_eq!(profile[name]["openFilesMax"], limits.files);
            assert_eq!(profile[name]["cpuMax"]["quotaUsec"], 100000);
            assert_eq!(profile[name]["cpuMax"]["periodUsec"], 100000);
        }
    }

    #[test]
    fn workload_limits_are_written_and_verified_without_creating_kernel_files() {
        let root = std::env::temp_dir().join(format!("arena-limits-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        for name in ["cpu.max", "memory.max", "memory.swap.max", "pids.max"] {
            std::fs::write(root.join(name), "").unwrap();
        }
        WorkloadLimits::BOT.apply(&root).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("memory.max")).unwrap(), "268435456");
        assert_eq!(std::fs::read_to_string(root.join("memory.swap.max")).unwrap(), "0");
        assert_eq!(std::fs::read_to_string(root.join("pids.max")).unwrap(), "32");
        std::fs::write(root.join("cpu.max"), "100000 100000unexpected").unwrap();
        assert!(WorkloadLimits::BOT.apply(&root).is_err(), "unconfirmed kernel value must fail closed");
        std::fs::write(root.join("cpu.max"), "").unwrap();
        WorkloadLimits::COMPILE.apply(&root).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("memory.max")).unwrap(), "1073741824");
        std::fs::remove_file(root.join("pids.max")).unwrap();
        assert!(WorkloadLimits::BOT.apply(&root).is_err());
        assert!(!root.join("pids.max").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn populated_or_missing_controller_parent_is_refused() {
        let root = std::env::temp_dir().join(format!("arena-controller-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("cgroup.procs"), "123\n").unwrap();
        assert!(enable_workload_controllers(&root).unwrap_err().to_string().contains("contains processes"));
        std::fs::write(root.join("cgroup.procs"), "").unwrap();
        std::fs::write(root.join("cgroup.controllers"), "cpu pids").unwrap();
        assert!(enable_workload_controllers(&root).unwrap_err().to_string().contains("unavailable"));
        assert!(!root.join("cgroup.subtree_control").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

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
