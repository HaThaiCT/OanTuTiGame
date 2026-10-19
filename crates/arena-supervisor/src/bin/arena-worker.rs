//! Native supervisor workload consumer for official GAME, private TEST_GAME, BUILD and TEST_BUILD
//! jobs.
//!
//! Claims leases from the trusted job broker gateway and runs them through the sandbox primitives.
//! Every path, digest and document is explicit (flag or environment variable); nothing is guessed
//! and nothing is taken from the API, a claim or the network.
//!
//! The claim offers exactly the job types this worker has slots for: `--max-game-slots` covers both
//! GAME and TEST_GAME (a private test is a game, and shares the game slot budget) and
//! `--max-build-slots` covers BUILD and TEST_BUILD.
//!
//! * GAME/TEST_GAME: `--runtime-rootfs` names the image a Bot runs in. A private test's opponent is
//!   the one the control plane pinned; the worker never chooses it.
//! * BUILD/TEST_BUILD: `--toolchains` names the operator's per-language document (rootfs, image
//!   digest, declared version and fixed flags for PYTHON, TYPESCRIPT and CPP), `--artifact-output-root`
//!   names the directory the compile step writes the artifact into, and `--runsc` names the runtime.
//!   Build slots are only offered when all of those exist; a missing prerequisite is a startup error.
//!
//! See `arena_supervisor::worker` for the claim → validate → materialize → run → prepare → complete
//! contract and for the fail-closed rules.
#[cfg(target_os = "linux")]
fn main() {
    use arena_supervisor::worker::{Worker, WorkerConfig};
    let config = match WorkerConfig::from_arguments(std::env::args().skip(1), |name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("arena-worker configuration {}: {}", error.code(), error.message());
            std::process::exit(2);
        }
    };
    let outcome = Worker::new(config).and_then(|worker| worker.run());
    if let Err(error) = outcome {
        eprintln!("arena-worker stopped {}: {}", error.code(), error.message());
        std::process::exit(2);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("the native supervisor workload requires Linux");
}
