//! Assignment validation: nothing from the broker is trusted before every digest, path, grant and
//! size has been re-proven. Every rejection is fail-closed (the caller must abort the attempt).
mod worker_support;

use arena_supervisor::materialize::{
    parse_assignment, parse_build_assignment, safe_artifact_entrypoint, safe_relative_path, Language,
};
use serde_json::json;
use std::path::PathBuf;
use worker_support::{
    assignment, build_assignment, cpp_assignment, toolchain_entry, TempDir, GAME, PROFILE,
};

fn game_code(payload: &serde_json::Value) -> &'static str {
    parse_assignment(payload, PROFILE).expect_err("payload must be rejected").code()
}

fn build_code(payload: &serde_json::Value) -> &'static str {
    parse_build_assignment(payload).expect_err("payload must be rejected").code()
}

#[test]
fn accepts_the_control_plane_game_assignment() {
    let spool = TempDir::new("assign-game");
    let (payload, digest) = assignment(spool.path());
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    assert_eq!(parsed.game_id, GAME);
    assert_eq!(parsed.attempt_id, worker_support::ATTEMPT);
    assert_eq!(parsed.rules_revision, "rules-2026.1");
    assert_eq!(parsed.max_turns, 300);
    assert_eq!(worker_support::sha256_hex(&parsed.canonical_manifest), digest);
    assert_eq!(parsed.bots[0].side, 1);
    assert_eq!(parsed.bots[1].side, 2);
    assert_eq!(parsed.bots[0].language, Language::Python);
    assert_eq!(parsed.bots[0].entrypoint, "main.py");
    assert!(parsed.bots[0].artifact.is_none());
    // The grant is the spool path plus the pinned digest and size, and nothing else.
    let source = payload["bots"][0]["source"].as_object().expect("source grant");
    assert_eq!(source.len(), 3);
    assert_eq!(parsed.bots[0].source.path, PathBuf::from(source["path"].as_str().expect("path")));
    assert_eq!(parsed.bots[0].source.size_bytes, source["sizeBytes"].as_u64().expect("size"));
}

#[test]
fn receipt_provenance_is_accepted_and_covered_by_the_manifest_digest() {
    let spool = TempDir::new("assign-provenance");
    let (mut payload, _) = assignment(spool.path());
    let mut manifest: serde_json::Value = serde_json::from_str(payload["canonicalManifest"].as_str().unwrap()).unwrap();
    manifest["provenance"] = json!({"rulesRevision":"rules-2026.1","runtimeProfileDigest":PROFILE,
        "bots":[{"side":1,"receiptId":"frozen-receipt","sourceDigest":"pinned-source"}],"toolchains":[]});
    let canonical = serde_json::to_string(&manifest).unwrap();
    payload["manifestDigest"] = json!(worker_support::sha256_hex(canonical.as_bytes()));
    payload["canonicalManifest"] = json!(canonical);
    assert!(parse_assignment(&payload, PROFILE).is_ok());
    manifest["provenance"]["bots"][0]["receiptId"] = json!("tampered-receipt");
    payload["canonicalManifest"] = json!(serde_json::to_string(&manifest).unwrap());
    assert_eq!(game_code(&payload), "MANIFEST_DIGEST");
}

#[test]
fn accepts_a_cpp_assignment_that_ships_the_compiled_artifact() {
    let spool = TempDir::new("assign-cpp");
    let (payload, digest, artifact_digest) = cpp_assignment(spool.path(), b"\x7fELF compiled bytes");
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    assert_eq!(worker_support::sha256_hex(&parsed.canonical_manifest), digest);
    let artifact = parsed.bots[0].artifact.as_ref().expect("artifact grant");
    assert_eq!(artifact.entrypoint, "bot");
    assert_eq!(worker_support::hex(&artifact.grant.digest), artifact_digest);
    assert_eq!(artifact.grant.size_bytes, b"\x7fELF compiled bytes".len() as u64);
}

#[test]
fn rejects_a_version_or_manifest_it_cannot_verify() {
    let spool = TempDir::new("assign-manifest");
    let (payload, _) = assignment(spool.path());

    let mut version = payload.clone();
    version["version"] = json!(2);
    assert_eq!(game_code(&version), "VERSION_UNSUPPORTED");

    let mut digest = payload.clone();
    digest["manifestDigest"] = json!("0".repeat(64));
    assert_eq!(game_code(&digest), "MANIFEST_DIGEST");

    let mut edited = payload.clone();
    let manifest = edited["canonicalManifest"]
        .as_str()
        .expect("manifest")
        .replace("maxPly", "maxPlies");
    edited["canonicalManifest"] = json!(manifest);
    assert_eq!(game_code(&edited), "MANIFEST_DIGEST");

    let mut unusable = payload.clone();
    let manifest = format!("{{\"gameId\":\"{GAME}\"}}");
    unusable["canonicalManifest"] = json!(manifest);
    unusable["manifestDigest"] = json!(worker_support::sha256_hex(manifest.as_bytes()));
    assert_eq!(game_code(&unusable), "MANIFEST_INVALID");
}

#[test]
fn refuses_a_profile_game_or_turn_bound_that_disagrees() {
    let spool = TempDir::new("assign-bounds");
    let (payload, _) = assignment(spool.path());

    let mut profile = payload.clone();
    profile["runtimeProfileDigest"] = json!("c".repeat(64));
    assert_eq!(game_code(&profile), "RUNTIME_PROFILE_MISMATCH");

    let mut target = payload.clone();
    target["targetId"] = json!("77777777-7777-4777-8777-777777777777");
    assert_eq!(game_code(&target), "ASSIGNMENT_INVALID");

    let mut game = payload.clone();
    game["gameId"] = json!("66666666-6666-4666-8666-666666666666");
    assert_eq!(game_code(&game), "ASSIGNMENT_INVALID");

    let mut turns = payload.clone();
    turns["maxTurns"] = json!(299);
    assert_eq!(game_code(&turns), "MANIFEST_MISMATCH");

    let mut zero = payload.clone();
    zero["maxTurns"] = json!(0);
    assert_eq!(game_code(&zero), "ASSIGNMENT_INVALID");
}

#[test]
fn requires_exactly_two_bots_on_sides_one_and_two() {
    let spool = TempDir::new("assign-sides");
    let (payload, _) = assignment(spool.path());

    let mut empty = payload.clone();
    empty["bots"] = json!([]);
    assert_eq!(game_code(&empty), "ASSIGNMENT_INVALID");

    let mut duplicate = payload.clone();
    let first = duplicate["bots"][0].clone();
    duplicate["bots"] = json!(vec![first.clone(), first.clone(), first]);
    assert_eq!(game_code(&duplicate), "ASSIGNMENT_INVALID");

    let mut wrong_side = payload.clone();
    wrong_side["bots"][1]["side"] = json!(1);
    assert_eq!(game_code(&wrong_side), "ASSIGNMENT_INVALID");
}

#[test]
fn grants_must_be_absolute_regular_files_with_a_bounded_size() {
    let spool = TempDir::new("assign-grants");
    let (payload, _) = assignment(spool.path());

    let mut relative = payload.clone();
    relative["bots"][0]["source"]["path"] = json!("spool/white.zip");
    assert_eq!(game_code(&relative), "GRANT_PATH_UNSAFE");

    let mut empty = payload.clone();
    empty["bots"][0]["source"]["sizeBytes"] = json!(0);
    assert_eq!(game_code(&empty), "SIZE_LIMIT");

    let mut oversized = payload.clone();
    oversized["bots"][0]["source"]["sizeBytes"] = json!(2 * 1024 * 1024 + 1);
    assert_eq!(game_code(&oversized), "SIZE_LIMIT");

    let mut digest = payload.clone();
    digest["bots"][0]["source"]["digest"] = json!("not a digest");
    assert_eq!(game_code(&digest), "ASSIGNMENT_INVALID");

    let mut missing = payload.clone();
    missing["bots"][0]["source"]
        .as_object_mut()
        .expect("grant")
        .remove("digest");
    assert_eq!(game_code(&missing), "ASSIGNMENT_INVALID");
}

#[test]
fn a_compile_language_must_ship_its_artifact_and_only_it_may() {
    let spool = TempDir::new("assign-artifact");
    let (payload, _) = assignment(spool.path());

    // An interpreted side may not carry an artifact.
    let mut python_artifact = payload.clone();
    python_artifact["bots"][0]["artifact"] = json!({
        "path": "/var/lib/arena/spool/compiled-bot",
        "digest": "d".repeat(64),
        "sizeBytes": 16,
        "entrypoint": "bot",
    });
    assert_eq!(game_code(&python_artifact), "ASSIGNMENT_INVALID");

    // A compile side must carry one.
    let (cpp, _, _) = cpp_assignment(spool.path(), b"\x7fELF compiled bytes");
    let mut without = cpp.clone();
    without["bots"][0]
        .as_object_mut()
        .expect("bot")
        .remove("artifact");
    assert_eq!(game_code(&without), "ARTIFACT_MISSING");

    // The artifact entrypoint is a plain file name, never a path.
    let mut nested = cpp.clone();
    nested["bots"][0]["artifact"]["entrypoint"] = json!("bin/bot");
    assert_eq!(game_code(&nested), "ASSIGNMENT_INVALID");

    // The language/extension agreement still applies to the *source* entrypoint.
    let mut mismatched = cpp;
    mismatched["bots"][0]["entrypoint"] = json!("main.py");
    assert_eq!(game_code(&mismatched), "ASSIGNMENT_INVALID");
}

#[test]
fn accepts_the_control_plane_build_assignment() {
    let spool = TempDir::new("assign-build");
    let (payload, digest) = build_assignment(spool.path(), "CPP", "main.cpp", &["-O2", "-std=c++20"], "13.2.0");
    let parsed = parse_build_assignment(&payload).expect("valid build assignment");
    assert_eq!(parsed.target_id, worker_support::BUILD_TARGET);
    assert_eq!(parsed.language, Language::Cpp);
    assert_eq!(parsed.entrypoint, "main.cpp");
    assert_eq!(worker_support::hex(&parsed.manifest_digest), digest);
    assert_eq!(parsed.toolchain.language, Language::Cpp);
    assert_eq!(parsed.toolchain.version, "13.2.0");
    assert_eq!(parsed.toolchain.flags, vec!["-O2", "-std=c++20"]);
    assert_eq!(parsed.limits.compile_wall_ms, 30_000);
    assert_eq!(parsed.limits.init_wall_ms, 5_000);
    assert_eq!(parsed.limits.init_cpu_usec, 500_000);
    assert_eq!(parsed.source.size_bytes, payload["source"]["sizeBytes"].as_u64().expect("size"));
}

#[test]
fn build_assignments_are_refused_when_anything_disagrees() {
    let spool = TempDir::new("assign-build-bad");
    let (payload, _) = build_assignment(spool.path(), "PYTHON", "main.py", &["-m", "py_compile"], "3.12.3");

    let mut game = payload.clone();
    game["jobType"] = json!("GAME");
    assert_eq!(build_code(&game), "JOB_TYPE_UNSUPPORTED");

    let mut version = payload.clone();
    version["version"] = json!(2);
    assert_eq!(build_code(&version), "VERSION_UNSUPPORTED");

    let mut language = payload.clone();
    language["language"] = json!("RUST");
    assert_eq!(build_code(&language), "LANGUAGE_UNSUPPORTED");

    let mut entrypoint = payload.clone();
    entrypoint["entrypoint"] = json!("main.cpp");
    assert_eq!(build_code(&entrypoint), "ASSIGNMENT_INVALID");

    let mut toolchain = payload.clone();
    toolchain["toolchain"] = toolchain_entry("CPP", "13.2.0", &["-O2"]);
    assert_eq!(build_code(&toolchain), "TOOLCHAIN_MISMATCH");

    let mut digest = payload.clone();
    digest["toolchain"]["imageDigest"] = json!("AB".repeat(32));
    assert_eq!(build_code(&digest), "ASSIGNMENT_INVALID");

    // A language without a compile step declares no flags.
    let (typescript, _) = build_assignment(spool.path(), "TYPESCRIPT", "main.ts", &[], "22.5.0");
    let mut flagged = typescript.clone();
    flagged["toolchain"] = toolchain_entry("TYPESCRIPT", "22.5.0", &["--experimental"]);
    assert_eq!(build_code(&flagged), "TOOLCHAIN_MISMATCH");

    for (path, expected) in [
        (json!({ "path": "relative.zip", "digest": "e".repeat(64), "sizeBytes": 32 }), "GRANT_PATH_UNSAFE"),
        (json!({ "path": "/var/lib/arena/spool/source.zip", "digest": "e".repeat(64), "sizeBytes": 0 }), "SIZE_LIMIT"),
        (json!({ "path": "/var/lib/arena/spool/source.zip", "digest": "e".repeat(64), "sizeBytes": 2 * 1024 * 1024 + 1 }), "SIZE_LIMIT"),
    ] {
        let mut source = payload.clone();
        source["source"] = path;
        assert_eq!(build_code(&source), expected);
    }
}

#[test]
fn build_limits_are_bounded_and_required() {
    let spool = TempDir::new("assign-limits");
    let (payload, _) = build_assignment(spool.path(), "CPP", "main.cpp", &["-O2"], "13.2.0");
    for (field, value) in [
        ("compileWallMs", json!(0)),
        ("compileWallMs", json!(600_001)),
        ("initWallMs", json!(0)),
        ("initWallMs", json!(60_001)),
        ("initCpuUsec", json!(0)),
        ("initCpuUsec", json!(60_000_001)),
    ] {
        let mut limits = payload.clone();
        limits["limits"][field] = value;
        assert_eq!(build_code(&limits), "ASSIGNMENT_INVALID", "{field}");
    }
    let mut missing = payload.clone();
    missing["limits"].as_object_mut().expect("limits").remove("initWallMs");
    assert_eq!(build_code(&missing), "ASSIGNMENT_INVALID");
}

#[test]
fn requires_every_field_of_both_shapes() {
    let spool = TempDir::new("assign-required");
    let (game, _) = assignment(spool.path());
    for name in [
        "version",
        "jobType",
        "targetId",
        "canonicalManifest",
        "manifestDigest",
        "runtimeProfileDigest",
        "gameId",
        "rulesRevision",
        "maxTurns",
        "bots",
    ] {
        let mut payload = game.clone();
        payload.as_object_mut().expect("object").remove(name);
        assert_eq!(game_code(&payload), "ASSIGNMENT_INVALID", "missing {name}");
    }
    let (build, _) = build_assignment(spool.path(), "CPP", "main.cpp", &["-O2"], "13.2.0");
    for name in [
        "version",
        "jobType",
        "targetId",
        "language",
        "entrypoint",
        "manifestDigest",
        "toolchain",
        "source",
        "limits",
    ] {
        let mut payload = build.clone();
        payload.as_object_mut().expect("object").remove(name);
        assert_eq!(build_code(&payload), "ASSIGNMENT_INVALID", "missing {name}");
    }
}

#[test]
fn path_and_artifact_helpers_are_strict() {
    assert!(safe_relative_path("main.py").is_ok());
    assert!(safe_relative_path("sub/dir/main.py").is_ok());
    for path in ["/abs.py", "../x.py", "./x.py", "x/./y.py", "", "x\\y.py"] {
        assert!(safe_relative_path(path).is_err(), "{path:?} must be rejected");
    }
    assert!(safe_artifact_entrypoint("bot").is_ok());
    assert!(safe_artifact_entrypoint("bot.bin").is_ok());
    for entrypoint in ["", "bin/bot", "../bot", "-bot", ".bot", "bot\n"] {
        assert!(safe_artifact_entrypoint(entrypoint).is_err(), "{entrypoint:?} must be rejected");
    }
}
