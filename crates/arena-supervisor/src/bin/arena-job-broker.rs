#[cfg(target_os = "linux")]
fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "usage: arena-job-broker SOCKET ALLOWED_UID SOCKET_GID")); }
    let number = |value: &str| value.parse::<u32>().map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid uid/gid"));
    arena_supervisor::broker::serve(std::path::Path::new(&args[1]), number(&args[2])?, number(&args[3])?)
}
#[cfg(not(target_os = "linux"))]
fn main() { panic!("SO_PEERCRED broker requires Linux"); }
