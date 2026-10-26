//! Materialization: the per-attempt workspace must be fresh, private, verified after every write,
//! and removed when it is dropped. Nothing is written until every grant has been proven, and the
//! OCI bundles must bind the workload to the operator's rootfs and the operator's cgroup —
//! nothing from the payload may name a host path or a command.
mod worker_support;

use arena_supervisor::materialize::{
    materialize, materialize_build, parse_assignment, parse_build_assignment, MaterializedAttempt,
    MaterializedBuild,
};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use worker_support::{
    assignment, build_assignment, cpp_assignment, spool, sha256_hex, TempDir, ATTEMPT, GAME,
    PROFILE,
};

fn mode(path: &Path) -> u32 {
    fs::metadata(path).expect("path exists").permissions().mode() & 0o777
}

fn bundle(path: &Path) -> Value {
    assert!(path.is_dir(), "runsc --bundle receives a directory, not a config file");
    serde_json::from_slice(&fs::read(path.join("config.json")).expect("OCI config.json")).expect("bundle is JSON")
}

fn prepare() -> (TempDir, TempDir, TempDir) {
    (TempDir::new("attempts"), TempDir::new("cgroups"), TempDir::new("rootfs"))
}

fn materialized(attempts: &TempDir, cgroups: &TempDir, rootfs: &TempDir) -> (TempDir, Value, MaterializedAttempt) {
    let spool = TempDir::new("game-spool");
    let (payload, _) = assignment(spool.path());
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let attempt = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path()).expect("materializes");
    (spool, payload, attempt)
}

#[test]
fn writes_a_private_attempt_and_the_run_bundle() {
    let (attempts, cgroups, rootfs) = prepare();
    let (_spool, payload, attempt) = materialized(&attempts, &cgroups, &rootfs);
    let root = attempt.root().to_path_buf();
    assert_eq!(root, attempts.path().join(ATTEMPT));
    assert_eq!(mode(&root), 0o700);
    assert_eq!(attempt.manifest.game_id, GAME);

    for side in [1_u8, 2] {
        let layout = attempt.layout(side).expect("both sides materialize");
        assert_eq!(mode(&layout.workspace), 0o700);
        assert_eq!(mode(&layout.state), 0o700);
        assert!(layout.output.is_none(), "an interpreted side runs no artifact");
        let source = layout.workspace.join("main.py");
        assert_eq!(mode(&source), 0o600);
        // The workspace holds exactly what the granted ZIP declared, extracted and verified.
        let zip_path = payload["bots"][(side - 1) as usize]["source"]["path"].as_str().expect("grant path");
        let zip = fs::read(zip_path).expect("spooled ZIP");
        assert_eq!(&zip[..4], &0x0403_4b50_u32.to_le_bytes(), "the grant is the source ZIP itself");
        let expected: &[u8] = if side == 1 { b"# white\nprint('ready')\n" } else { b"# black\nprint('ready')\n" };
        assert_eq!(fs::read(&source).expect("source"), expected);
        assert_eq!(layout.program, vec!["/usr/bin/python3", "/workspace/main.py"]);

        let config = bundle(&layout.bundle);
        assert_eq!(config["ociVersion"], "1.0.0");
        assert_eq!(config["root"]["path"], rootfs.path().to_string_lossy().as_ref());
        assert_eq!(config["root"]["readonly"], true);
        assert_eq!(config["process"]["cwd"], "/workspace");
        assert_eq!(config["process"]["args"][0], "/usr/bin/python3");
        assert_eq!(config["process"]["args"][1], "/workspace/main.py");
        assert_eq!(config["process"]["user"]["uid"], 0);
        assert_eq!(config["process"]["user"]["gid"], 0);
        assert_eq!(config["linux"]["uidMappings"], serde_json::json!([{"containerID": 0, "hostID": unsafe { libc::geteuid() }, "size": 1}]));
        assert_eq!(config["linux"]["gidMappings"], serde_json::json!([{"containerID": 0, "hostID": unsafe { libc::getegid() }, "size": 1}]));
        assert!(config["linux"]["namespaces"].as_array().unwrap().iter().any(|ns| ns["type"] == "user"));
        assert_eq!(config["linux"]["resources"]["memory"]["limit"], 268435456);
        assert_eq!(config["linux"]["resources"]["memory"]["swap"], 268435456);
        assert_eq!(config["linux"]["resources"]["pids"]["limit"], 32);
        assert_eq!(config["linux"]["resources"]["cpu"]["quota"], 100000);
        assert_eq!(config["linux"]["resources"]["cpu"]["period"], 100000);
        assert_eq!(config["process"]["noNewPrivileges"], true);
        assert_eq!(config["process"]["capabilities"]["bounding"].as_array().map(Vec::len), Some(0));
        assert_eq!(config["linux"]["cgroupsPath"], layout.cgroup.to_string_lossy().as_ref());
        assert!(layout.cgroup.starts_with(cgroups.path()));
        let mounts = config["mounts"].as_array().expect("mounts");
        let workspace_mount = mounts
            .iter()
            .find(|mount| mount["destination"] == "/workspace")
            .expect("workspace mount");
        assert_eq!(workspace_mount["source"], layout.workspace.to_string_lossy().as_ref());
        let options = workspace_mount["options"].as_array().expect("options");
        assert!(options.contains(&Value::String("ro".to_owned())));
        assert!(options.contains(&Value::String("bind".to_owned())));
        assert!(mounts.iter().all(|mount| mount["destination"] != "/out"));
    }
    assert_ne!(attempt.bots[0].cgroup, attempt.bots[1].cgroup);
}

#[test]
fn a_compile_side_materializes_the_granted_artifact_instead_of_compiling() {
    let (attempts, cgroups, rootfs) = prepare();
    let spool = TempDir::new("cpp-spool");
    let bytes = b"\x7fELF a granted artifact".to_vec();
    let (payload, _, artifact_digest) = cpp_assignment(spool.path(), &bytes);
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let attempt = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path()).expect("materializes");
    let layout = attempt.layout(1).expect("side 1");
    let output = layout.output.as_ref().expect("a compiled side has an output directory");
    let artifact = output.join("bot");
    assert_eq!(mode(&artifact), 0o700, "the artifact must be executable by its owner");
    assert_eq!(fs::read(&artifact).expect("artifact"), bytes);
    assert_eq!(sha256_hex(&bytes), artifact_digest);
    assert!(!layout.workspace.join("main.cpp").exists(), "a compiled side materializes no source");
    assert_eq!(layout.program, vec!["/out/bot"]);

    let config = bundle(&layout.bundle);
    assert_eq!(config["process"]["args"][0], "/out/bot");
    let mounts = config["mounts"].as_array().expect("mounts");
    let output_mount = mounts
        .iter()
        .find(|mount| mount["destination"] == "/out")
        .expect("output mount");
    assert_eq!(output_mount["source"], output.to_string_lossy().as_ref());
    let options = output_mount["options"].as_array().expect("options");
    assert!(options.contains(&Value::String("ro".to_owned())));
    assert!(!options.contains(&Value::String("noexec".to_owned())), "pinned C++ artifact must execute");
}

#[test]
fn dropping_the_attempt_removes_the_whole_workspace() {
    let (attempts, cgroups, rootfs) = prepare();
    let root = {
        let (_spool, _payload, attempt) = materialized(&attempts, &cgroups, &rootfs);
        attempt.root().to_path_buf()
    };
    assert!(!root.exists(), "the workspace must not survive the attempt");
    assert!(attempts.path().exists(), "the operator root itself must be kept");
}

#[test]
fn refuses_to_reuse_an_attempt_directory() {
    let (attempts, cgroups, rootfs) = prepare();
    let spool = TempDir::new("reuse-spool");
    let (payload, _) = assignment(spool.path());
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let stale = attempts.path().join(ATTEMPT);
    fs::create_dir(&stale).expect("stale attempt");
    fs::write(stale.join("marker"), b"previous attempt").expect("marker");
    let error = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path())
        .expect_err("an existing attempt must not be reused");
    assert_eq!(error.code(), "ATTEMPT_ROOT_REUSED");
    assert!(stale.join("marker").exists(), "a refused attempt leaves the old tree untouched");
}

#[test]
fn refuses_operator_paths_it_cannot_trust() {
    let (attempts, cgroups, rootfs) = prepare();
    let spool = TempDir::new("untrusted-spool");
    let (payload, _) = assignment(spool.path());
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");

    let error = materialize(&parsed, attempts.path(), cgroups.path(), &rootfs.path().join("missing"))
        .expect_err("the rootfs must exist");
    assert_eq!(error.code(), "ROOTFS_UNAVAILABLE");

    fs::set_permissions(attempts.path(), fs::Permissions::from_mode(0o770)).expect("loosen attempt root");
    let error = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path())
        .expect_err("a group-writable attempt root must be refused");
    assert_eq!(error.code(), "ATTEMPT_ROOT_UNUSABLE");
    fs::set_permissions(attempts.path(), fs::Permissions::from_mode(0o700)).expect("restore attempt root");

    let error = materialize(&parsed, Path::new("relative-root"), cgroups.path(), rootfs.path())
        .expect_err("relative operator paths must be refused");
    assert_eq!(error.code(), "ATTEMPT_ROOT_UNUSABLE");

    let error = materialize(&parsed, attempts.path(), &cgroups.path().join("missing"), rootfs.path())
        .expect_err("a missing delegated cgroup root must be refused");
    assert_eq!(error.code(), "CGROUP_ROOT_UNUSABLE");
}

#[test]
fn a_grant_that_does_not_match_its_pinned_bytes_is_refused_before_any_write() {
    // A spool file rewritten after the grant was pinned: the digest no longer matches.
    let (attempts, cgroups, rootfs) = prepare();
    let spool = TempDir::new("tampered-spool");
    let (payload, _) = assignment(spool.path());
    let path = payload["bots"][0]["source"]["path"].as_str().expect("path").to_owned();
    fs::write(&path, b"tampered bytes of another length").expect("tamper");
    let parsed = parse_assignment(&payload, PROFILE).expect("the shape is still valid");
    let error = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path())
        .expect_err("a tampered grant must never be materialized");
    assert_eq!(error.code(), "GRANT_SIZE_MISMATCH");
    assert!(!attempts.path().join(ATTEMPT).exists(), "a tampered grant writes nothing");

    // Same length, different bytes: the digest check is what catches it.
    let (attempts, cgroups, rootfs) = prepare();
    let spool = TempDir::new("tampered-same-length");
    let (payload, _) = assignment(spool.path());
    let path = payload["bots"][0]["source"]["path"].as_str().expect("path").to_owned();
    let mut bytes = fs::read(&path).expect("grant");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    fs::write(&path, &bytes).expect("tamper");
    let parsed = parse_assignment(&payload, PROFILE).expect("the shape is still valid");
    let error = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path())
        .expect_err("a tampered grant must never be materialized");
    assert_eq!(error.code(), "GRANT_DIGEST_MISMATCH");
    assert!(!attempts.path().join(ATTEMPT).exists());

    // A missing grant file and a symlink instead of a regular file are both refused.
    for kind in ["missing", "symlink"] {
        let (attempts, cgroups, rootfs) = prepare();
        let spool = TempDir::new("grant-kind-spool");
        let (payload, _) = assignment(spool.path());
        let path = payload["bots"][0]["source"]["path"].as_str().expect("path").to_owned();
        fs::remove_file(&path).expect("remove grant");
        if kind == "symlink" {
            std::os::unix::fs::symlink("/etc/hostname", &path).expect("symlink");
        }
        let parsed = parse_assignment(&payload, PROFILE).expect("shape is still valid");
        let error = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path())
            .expect_err("an unreadable grant must be refused");
        assert_eq!(error.code(), "GRANT_UNREADABLE", "{kind}");
        assert!(!attempts.path().join(ATTEMPT).exists());
    }
}

#[test]
fn creates_nested_source_directories() {
    let (attempts, cgroups, rootfs) = prepare();
    let spool_dir = TempDir::new("nested-spool");
    let source = spool(
        spool_dir.path(),
        "nested.zip",
        &worker_support::zip_stored(&[("bot/main.ts", b"export const x = 1;\n")]),
    );
    let (mut payload, _) = assignment(spool_dir.path());
    payload["bots"][0] = worker_support::game_bot(1, "TYPESCRIPT", "bot/main.ts", source, None);
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let attempt = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path()).expect("materializes");
    let layout = attempt.layout(1).expect("side 1");
    assert_eq!(mode(&layout.workspace.join("bot")), 0o700);
    assert_eq!(mode(&layout.workspace.join("bot/main.ts")), 0o600);
    assert_eq!(layout.program, vec!["/usr/bin/node", "/workspace/bot/main.ts"]);
}

// ---------------------------------------------------------------------------------------------
// BUILD materialization
// ---------------------------------------------------------------------------------------------

fn build_materialized<'a>(
    language: &str,
    entrypoint: &str,
    flags: &[&str],
    version: &str,
    attempts: &TempDir,
    cgroups: &TempDir,
    toolchain_rootfs: &TempDir,
    output_root: &TempDir,
    spool: &TempDir,
) -> (Value, MaterializedBuild) {
    let (payload, _) = build_assignment(spool.path(), language, entrypoint, flags, version);
    let parsed = parse_build_assignment(&payload).expect("valid build assignment");
    let attempt = materialize_build(
        &parsed,
        ATTEMPT,
        attempts.path(),
        cgroups.path(),
        toolchain_rootfs.path(),
        output_root.path(),
    )
    .expect("materializes");
    (payload, attempt)
}

#[test]
fn a_cpp_build_writes_a_writable_output_directory_and_operator_commands() {
    let (attempts, cgroups, toolchain_rootfs, output_root) = (
        TempDir::new("build-attempts"),
        TempDir::new("build-cgroups"),
        TempDir::new("build-rootfs"),
        TempDir::new("build-output"),
    );
    let spool = TempDir::new("build-spool");
    let (_payload, attempt) = build_materialized(
        "CPP",
        "main.cpp",
        &["-O2", "-std=c++20"],
        "13.2.0",
        &attempts,
        &cgroups,
        &toolchain_rootfs,
        &output_root,
        &spool,
    );
    let root = attempt.root().to_path_buf();
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&attempt.build.workspace), 0o700);
    assert_eq!(mode(&attempt.build.workspace.join("main.cpp")), 0o600);
    // Single-ID rootless mapping needs no access for unrelated host identities.
    assert_eq!(mode(&attempt.build.output), 0o700);
    assert!(
        attempt.build.output.starts_with(output_root.path()),
        "the output lives inside the operator's artifact output root"
    );
    assert_eq!(attempt.build.output, output_root.path().join(ATTEMPT).join("1"));
    assert_eq!(
        mode(attempt.build.output.parent().expect("per-attempt directory")),
        0o700,
        "only this attempt's owner may reach the writable leaf"
    );
    assert_eq!(attempt.build.artifact_path(), attempt.build.output.join("bot"));
    assert_eq!(attempt.bot.program, vec!["/out/bot"]);

    let probe = bundle(&attempt.build.toolchain_bundle);
    assert_eq!(probe["process"]["args"], serde_json::json!(["/usr/bin/g++", "--version"]));
    let probe_output = probe["mounts"]
        .as_array()
        .expect("mounts")
        .iter()
        .find(|mount| mount["destination"] == "/out")
        .cloned()
        .expect("output mount");
    assert!(
        probe_output["options"].as_array().expect("options").contains(&Value::String("ro".to_owned())),
        "a probe never writes"
    );

    let compile_bundle = attempt.build.compile_bundle.clone().expect("a compile language has a compile step");
    let compile = bundle(&compile_bundle);
    assert_eq!(compile["linux"]["resources"]["memory"]["limit"], 1073741824);
    assert_eq!(compile["linux"]["resources"]["memory"]["swap"], 1073741824);
    assert_eq!(compile["linux"]["resources"]["pids"]["limit"], 64);
    let cpu_limit = compile["process"]["rlimits"].as_array().unwrap().iter()
        .find(|limit| limit["type"] == "RLIMIT_CPU").unwrap();
    assert_eq!(cpu_limit["hard"], 10);
    assert_eq!(cpu_limit["soft"], 10);
    assert_eq!(
        compile["process"]["args"],
        serde_json::json!(["/usr/bin/g++", "-O2", "-std=c++20", "-I", "/workspace", "/workspace/main.cpp", "-o", "/out/bot"])
    );
    let compile_output = compile["mounts"]
        .as_array()
        .expect("mounts")
        .iter()
        .find(|mount| mount["destination"] == "/out")
        .cloned()
        .expect("output mount");
    let compile_options = compile_output["options"].as_array().expect("options");
    assert!(compile_options.contains(&Value::String("rw".to_owned())), "the compiler must write the artifact");
    // A compile bundle must be able to cache bytecode outside the read-only workspace.
    let environment = compile["process"]["env"].as_array().expect("env");
    assert!(environment.contains(&Value::String("PYTHONPYCACHEPREFIX=/out".to_owned())));
    assert!(!environment.contains(&Value::String("PYTHONDONTWRITEBYTECODE=1".to_owned())));

    let run = bundle(&attempt.bot.bundle);
    assert_eq!(run["process"]["args"], serde_json::json!(["/out/bot"]));
    let run_output = run["mounts"]
        .as_array()
        .expect("mounts")
        .iter()
        .find(|mount| mount["destination"] == "/out")
        .cloned()
        .expect("output mount");
    let run_options = run_output["options"].as_array().expect("options");
    assert!(run_options.contains(&Value::String("ro".to_owned())));
    assert!(!run_options.contains(&Value::String("noexec".to_owned())));
    assert_eq!(run["linux"]["cgroupsPath"], attempt.build.cgroup.to_string_lossy().as_ref());

    // The artifact directory lives in the operator's root, so it must be removed with the attempt.
    let output = attempt.build.output.clone();
    drop(attempt);
    assert!(!root.exists(), "the attempt tree is removed");
    assert!(!output.exists(), "the artifact directory is removed");
    assert!(output_root.path().exists(), "the operator's output root itself is kept");
}

#[test]
fn a_python_build_compiles_the_entrypoint_and_smokes_the_source() {
    let (attempts, cgroups, toolchain_rootfs, output_root) = (
        TempDir::new("py-attempts"),
        TempDir::new("py-cgroups"),
        TempDir::new("py-rootfs"),
        TempDir::new("py-output"),
    );
    let spool = TempDir::new("py-spool");
    let (_payload, attempt) = build_materialized(
        "PYTHON",
        "main.py",
        &["-m", "py_compile"],
        "3.12.3",
        &attempts,
        &cgroups,
        &toolchain_rootfs,
        &output_root,
        &spool,
    );
    let compile = bundle(&attempt.build.compile_bundle.clone().expect("compile step"));
    assert_eq!(compile["process"]["args"], serde_json::json!(["/usr/bin/python3", "-m", "py_compile", "/workspace/main.py"]));
    // A build smoke runs the materialized source, never an artifact.
    assert!(attempt.bot.output.is_none());
    let run = bundle(&attempt.bot.bundle);
    assert_eq!(run["process"]["args"], serde_json::json!(["/usr/bin/python3", "/workspace/main.py"]));
    assert!(run["mounts"]
        .as_array()
        .expect("mounts")
        .iter()
        .all(|mount| mount["destination"] != "/out"));
}

#[test]
fn a_typescript_build_has_no_compile_step_but_still_probes_the_toolchain() {
    let (attempts, cgroups, toolchain_rootfs, output_root) = (
        TempDir::new("ts-attempts"),
        TempDir::new("ts-cgroups"),
        TempDir::new("ts-rootfs"),
        TempDir::new("ts-output"),
    );
    let spool = TempDir::new("ts-spool");
    let (_payload, attempt) = build_materialized(
        "TYPESCRIPT",
        "main.ts",
        &[],
        "22.5.0",
        &attempts,
        &cgroups,
        &toolchain_rootfs,
        &output_root,
        &spool,
    );
    assert!(attempt.build.compile_bundle.is_none(), "TYPESCRIPT has no compile step");
    assert_eq!(bundle(&attempt.build.toolchain_bundle)["process"]["args"], serde_json::json!(["/usr/bin/node", "--version"]));
    assert_eq!(bundle(&attempt.bot.bundle)["process"]["args"], serde_json::json!(["/usr/bin/node", "/workspace/main.ts"]));
}

#[test]
fn build_materialization_refuses_an_unusable_toolchain_or_output_root() {
    let (attempts, cgroups, toolchain_rootfs, output_root) = (
        TempDir::new("bad-attempts"),
        TempDir::new("bad-cgroups"),
        TempDir::new("bad-rootfs"),
        TempDir::new("bad-output"),
    );
    let spool = TempDir::new("bad-build-spool");
    let (payload, _) = build_assignment(spool.path(), "CPP", "main.cpp", &["-O2"], "13.2.0");
    let parsed = parse_build_assignment(&payload).expect("valid build assignment");

    let error = materialize_build(
        &parsed,
        ATTEMPT,
        attempts.path(),
        cgroups.path(),
        &toolchain_rootfs.path().join("missing"),
        output_root.path(),
    )
    .expect_err("a missing toolchain rootfs must be refused");
    assert_eq!(error.code(), "TOOLCHAIN_ROOTFS_UNAVAILABLE");

    let error = materialize_build(
        &parsed,
        ATTEMPT,
        attempts.path(),
        cgroups.path(),
        toolchain_rootfs.path(),
        &output_root.path().join("missing"),
    )
    .expect_err("a missing artifact output root must be refused");
    assert_eq!(error.code(), "ARTIFACT_OUTPUT_ROOT_UNAVAILABLE");
    assert!(!attempts.path().join(ATTEMPT).exists(), "nothing may be written for a refused build");
}

#[test]
fn a_build_grant_that_does_not_match_its_pinned_bytes_writes_nothing() {
    let (attempts, cgroups, toolchain_rootfs, output_root) = (
        TempDir::new("g-attempts"),
        TempDir::new("g-cgroups"),
        TempDir::new("g-rootfs"),
        TempDir::new("g-output"),
    );
    let spool = TempDir::new("g-spool");
    let (payload, _) = build_assignment(spool.path(), "CPP", "main.cpp", &["-O2"], "13.2.0");
    let parsed = parse_build_assignment(&payload).expect("valid build assignment");
    let path = payload["source"]["path"].as_str().expect("path");
    fs::write(path, b"tampered source").expect("tamper");
    let error = materialize_build(
        &parsed,
        ATTEMPT,
        attempts.path(),
        cgroups.path(),
        toolchain_rootfs.path(),
        output_root.path(),
    )
    .expect_err("a tampered grant must be refused");
    assert_eq!(error.code(), "GRANT_SIZE_MISMATCH");
    assert!(!attempts.path().join(ATTEMPT).exists());
    assert_eq!(
        fs::read_dir(output_root.path()).expect("output root").count(),
        0,
        "a refused build leaves nothing behind in the operator's output root"
    );
}
