//! Operator-only transition probe for one fixed-shape transient test cgroup.
//! Never launches a process or accepts general cgroup control commands.
use arena_supervisor::control::CgroupControl;
use std::{fs, io, path::Path, time::Duration};

fn valid_target(path: &str) -> bool {
    let Some(name) = path.strip_prefix("/sys/fs/cgroup/system.slice/oantuti-kernel-smoke-")
        .and_then(|value| value.strip_suffix(".service/trusted-workload")) else { return false; };
    name.len() == 32 && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 || !valid_target(&args[0]) {
        return Err("invalid dedicated smoke cgroup".into());
    }
    let status = fs::read_to_string("/proc/self/status")?;
    let effective_uid = status.lines().find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|values| values.split_whitespace().nth(1));
    if effective_uid != Some("0") { return Err("operator root authentication required".into()); }
    let pid: u32 = args[1].parse()?;
    if pid <= 1 { return Err("invalid trusted child PID".into()); }
    let relative = args[0].strip_prefix("/sys/fs/cgroup").unwrap();
    if fs::read_to_string(format!("/proc/{pid}/cgroup"))?.trim() != format!("0::{relative}") {
        return Err("trusted child cgroup mismatch".into());
    }
    let members = fs::read_to_string(Path::new(&args[0]).join("cgroup.procs"))?;
    if members.split_whitespace().collect::<Vec<_>>() != [args[1].as_str()] {
        return Err("unexpected workload membership".into());
    }
    let mut control = CgroupControl::open(Path::new(&args[0]))?;
    let frozen = control.freeze(Duration::from_secs(3))?;
    if !frozen.populated { return Err("trusted workload disappeared before freeze".into()); }
    control.unfreeze(Duration::from_secs(3))?;
    control.kill_and_wait(Duration::from_secs(3))?;
    println!("{{\"status\":\"PASS\",\"controller\":\"rust\",\"frozenConfirmed\":true,\"unfrozenConfirmed\":true,\"zeroDescendantsConfirmed\":true}}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("KERNEL_PROBE_REJECTED: {}", if error.downcast_ref::<io::Error>().is_some() { "kernel I/O or transition failure".to_string() } else { error.to_string() });
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::valid_target;
    #[test]
    fn only_exact_transient_child_path_is_accepted() {
        assert!(valid_target("/sys/fs/cgroup/system.slice/oantuti-kernel-smoke-0123456789abcdef0123456789abcdef.service/trusted-workload"));
        for value in ["/sys/fs/cgroup", "/sys/fs/cgroup/user.slice", "/sys/fs/cgroup/system.slice/oantuti-kernel-smoke-../trusted-workload", "/sys/fs/cgroup/system.slice/oantuti-kernel-smoke-0123456789abcdef0123456789abcdef.service"] {
            assert!(!valid_target(value));
        }
    }
}
