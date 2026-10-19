//! A private test (TEST_GAME) end to end: the same grant verification, materialization, sandbox
//! budgets and measured counters as an official game, against the two Bots the control plane pinned.
//!
//! The Bots are the control plane's: white is the testing team's snapshot source and black is the
//! opponent it pinned, which for a compile language arrives as a compiled artifact and is therefore
//! never compiled at match time. The opponent itself is a control-plane fact, so the completion
//! carries the GAME evidence shape and nothing of the worker's own.
mod worker_support;

use arena_supervisor::materialize::{materialize, parse_assignment, GameJobType, TestOpponentKind};
use arena_supervisor::worker::Worker;
use serde_json::{json, Value};
use std::fs;
use std::sync::Arc;
use worker_support::{
    assignment, build_config, claim, config, hex, sha256, test_assignment, winning_black, winning_white,
    BudgetKey, FakeBroker, FakeFactory, ScriptedRunner, TempDir, ATTEMPT, GAME, PROFILE, READY, TEST,
};

fn submitted(broker: &FakeBroker) -> Value {
    broker.submitted_evidence().expect("the worker prepared a completion")
}

fn sorted_keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn a_private_test_runs_both_pinned_bots_and_submits_the_game_evidence_shape() {
    let spool = TempDir::new("private-spool");
    let artifact_bytes = b"\x7fELF the granted opponent artifact".to_vec();
    let (payload, digest, artifact_digest) = test_assignment(spool.path(), &artifact_bytes);
    let broker = FakeBroker::start(claim(payload.clone(), "TEST_GAME", TEST));
    let attempts = TempDir::new("private-attempts");
    let cgroups = TempDir::new("private-cgroups");
    let rootfs = TempDir::new("private-rootfs");

    let factory = FakeFactory::new(winning_white(), winning_black());
    let factory_state = Arc::clone(&factory.state);
    // The runner has no script at all: the first toolchain command would fault the attempt, so a
    // private test that compiled its compile-language opponent could not reach a verdict here.
    let runner = ScriptedRunner::new(Vec::new());
    let runner_state = Arc::clone(&runner.state);
    let worker = Worker::with_runner(config(broker.socket(), &attempts, &cgroups, &rootfs), factory, runner)
        .expect("worker configuration");

    let report = worker.run_once().expect("the attempt runs").expect("one attempt was claimed");
    assert_eq!(report.job_type, "TEST_GAME");
    assert_eq!(report.target_id, TEST);
    assert_eq!(report.outcome, "COMPLETED");
    assert!(!broker.operations().iter().any(|operation| operation == "liveTurn"), "private tests never publish live preview");
    assert_eq!(report.detail, "THRONE_BREACH");
    assert_eq!(report.observations, 5);
    assert!(!attempts.path().join(ATTEMPT).exists(), "the workspace is removed after the attempt");
    assert!(runner_state.lock().expect("runner").calls.is_empty(), "a match never compiles");

    // Both granted Bots were materialized exactly as they were pinned: the snapshot as source, the
    // opponent as source *and* compiled artifact.
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    assert_eq!(parsed.job_type, GameJobType::TestGame);
    assert_eq!(parsed.game_id, TEST);
    assert_eq!(
        parsed.opponent.as_ref().map(|opponent| (opponent.kind, opponent.label.as_str())),
        Some((TestOpponentKind::OwnSubmission, "team-latest-submission"))
    );
    assert!(parsed.bots[0].artifact.is_none(), "an interpreted side runs its source");
    let artifact = parsed.bots[1].artifact.as_ref().expect("the compile side's granted artifact");
    assert_eq!(artifact.grant.size_bytes, artifact_bytes.len() as u64);
    assert_eq!(hex(&artifact.grant.digest), artifact_digest);

    // The match played through the same bridge, the same startup order and the same game budgets an
    // official game uses: a private test is not a cheaper match.
    {
        let state = factory_state.lock().expect("factory state");
        assert_eq!(state.launched, vec![1, 2]);
        assert_eq!(state.stopped, vec![1, 2]);
        assert_eq!(state.requests.len(), 5);
        assert!(state.requests[0].1, "the first exchange is the startup");
        assert!(state.requests[0].2.contains("\"type\":\"INIT\""), "{}", state.requests[0].2);
        assert_eq!(
            state.budgets,
            vec![
                BudgetKey { startup_cpu_usec: 500_000, startup_wall_ms: 1_000 },
                BudgetKey { startup_cpu_usec: 500_000, startup_wall_ms: 1_000 },
            ]
        );
    }

    // The completion is the GAME shape, with no field of the worker's own.
    let evidence = submitted(&broker);
    assert_eq!(evidence["manifestDigest"], digest);
    assert_eq!(sorted_keys(&evidence), vec!["gameEvidence", "manifestDigest", "observations"]);
    assert_eq!(
        sorted_keys(&evidence["gameEvidence"]),
        vec!["disposition", "executionStatus", "reason", "totalPly", "trace", "winner"]
    );
    assert_eq!(evidence["gameEvidence"]["winner"], 1);
    assert_eq!(evidence["gameEvidence"]["reason"], "THRONE_BREACH");
    assert_eq!(evidence["gameEvidence"]["disposition"], "DECISIVE");
    assert_eq!(evidence["gameEvidence"]["executionStatus"], "COMPLETED");
    assert_eq!(evidence["gameEvidence"]["totalPly"], 3);
    let text = evidence.to_string();
    assert!(!text.contains("opponent"), "the pinned opponent is never restated: {text}");
    assert!(!text.contains("testId"), "the test id is not evidence about the match: {text}");
    assert!(!text.contains("\"map\""), "the pinned board is not the worker's to report: {text}");

    let observations = evidence["observations"].as_array().expect("observations");
    assert_eq!(observations.len(), 5);
    let expected = [
        (1_u64, 0_u64, READY),
        (2, 0, READY),
        (1, 1, "{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[1,2]}\n"),
        (2, 2, "{\"action\":\"MOVE\",\"piece_id\":2,\"target\":[1,1]}\n"),
        (1, 3, "{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[2,2]}\n"),
    ];
    for (index, (side, ply, line)) in expected.iter().enumerate() {
        let observation = &observations[index];
        assert_eq!(observation["side"].as_u64(), Some(*side), "observation {index} side");
        assert_eq!(observation["ply"].as_u64(), Some(*ply), "observation {index} ply");
        assert_eq!(observation["kind"], "RESPONSE");
        assert_eq!(observation["freezeConfirmed"], true);
        assert_eq!(observation["terminationConfirmed"], true);
        assert_eq!(observation["responseNdjson"].as_str(), Some(*line));
        assert_eq!(observation["cpuUsec"], "1200");
        assert_eq!(observation["wallUsec"], "2400");
    }
}

#[test]
fn a_private_test_materializes_the_pinned_source_and_artifact_on_disk() {
    let spool = TempDir::new("private-materialize-spool");
    let artifact_bytes = b"\x7fELF the granted opponent artifact".to_vec();
    let (payload, _, artifact_digest) = test_assignment(spool.path(), &artifact_bytes);
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let attempts = TempDir::new("private-materialize-attempts");
    let cgroups = TempDir::new("private-materialize-cgroups");
    let rootfs = TempDir::new("private-materialize-rootfs");

    let attempt = materialize(&parsed, attempts.path(), cgroups.path(), rootfs.path()).expect("materializes");

    // The snapshot runs the source extracted from its granted ZIP.
    let snapshot = attempt.layout(1).expect("side 1");
    assert!(snapshot.output.is_none(), "an interpreted side has no artifact to exec");
    assert!(snapshot.workspace.join("bot.py").exists(), "the snapshot source is materialized");

    // The opponent runs the granted artifact bytes, verbatim, from its own output directory: the
    // worker neither compiles nor invents an artifact.
    let opponent = attempt.layout(2).expect("side 2");
    let output = opponent.output.clone().expect("the compile side materialized the granted artifact");
    let bytes = fs::read(output.join("bot")).expect("the artifact is on disk");
    assert_eq!(bytes, artifact_bytes);
    assert_eq!(hex(&sha256(&bytes)), artifact_digest);
}

#[test]
fn a_tampered_private_test_grant_aborts_with_nothing_written() {
    let artifact_bytes = b"\x7fELF the granted opponent artifact".to_vec();
    // One claimed attempt; the borrow of the scratch directories ends with the closure, and the
    // attempt root is returned so the caller can prove nothing survived.
    let refused = |payload: Value| -> (String, FakeBroker, TempDir) {
        let broker = FakeBroker::start(claim(payload, "TEST_GAME", TEST));
        let attempts = TempDir::new("private-tampered-attempts");
        let cgroups = TempDir::new("private-tampered-cgroups");
        let rootfs = TempDir::new("private-tampered-rootfs");
        let worker = Worker::with_factory(
            config(broker.socket(), &attempts, &cgroups, &rootfs),
            FakeFactory::new(winning_white(), winning_black()),
        )
        .expect("worker configuration");
        let error = worker.run_once().expect_err("a tampered grant must abort");
        (error.code().to_owned(), broker, attempts)
    };

    // Same length, different bytes: the granted artifact is not what the control plane pinned.
    let spool = TempDir::new("private-digest-spool");
    let (payload, _, _) = test_assignment(spool.path(), &artifact_bytes);
    let artifact_path = payload["bots"][1]["artifact"]["path"].as_str().expect("path").to_owned();
    fs::write(&artifact_path, vec![b'x'; artifact_bytes.len()]).expect("tamper");
    let (code, broker, attempts) = refused(payload);
    assert_eq!(code, "GRANT_DIGEST_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!broker.operations().iter().any(|operation| operation == "prepareCompletion"));
    assert!(!attempts.path().join(ATTEMPT).exists(), "a refused grant writes nothing");

    // A different length: the grant is refused on size before its bytes are used at all.
    let spool = TempDir::new("private-size-spool");
    let (payload, _, _) = test_assignment(spool.path(), &artifact_bytes);
    let source_path = payload["bots"][1]["source"]["path"].as_str().expect("path").to_owned();
    fs::write(&source_path, b"short").expect("tamper");
    let (code, broker, attempts) = refused(payload);
    assert_eq!(code, "GRANT_SIZE_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!broker.operations().iter().any(|operation| operation == "prepareCompletion"));
    assert!(!attempts.path().join(ATTEMPT).exists(), "a refused grant writes nothing");

    // The snapshot side's own source is verified before it is extracted into a workspace, so a
    // rewritten snapshot writes nothing either.
    let spool = TempDir::new("private-snapshot-spool");
    let (payload, _, _) = test_assignment(spool.path(), &artifact_bytes);
    let snapshot_path = payload["bots"][0]["source"]["path"].as_str().expect("path").to_owned();
    let mut bytes = fs::read(&snapshot_path).expect("grant");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    fs::write(&snapshot_path, &bytes).expect("tamper");
    let (code, broker, attempts) = refused(payload);
    assert_eq!(code, "GRANT_DIGEST_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!attempts.path().join(ATTEMPT).exists(), "a refused grant writes nothing");
}

#[test]
fn private_tests_share_the_game_slot_budget() {
    let spool = TempDir::new("private-slots-spool");
    let artifact_bytes = b"\x7fELF the granted opponent artifact".to_vec();
    let (payload, _, _) = test_assignment(spool.path(), &artifact_bytes);
    let broker = FakeBroker::start(claim(payload, "TEST_GAME", TEST));
    let attempts = TempDir::new("private-slots-attempts");
    let cgroups = TempDir::new("private-slots-cgroups");
    let rootfs = TempDir::new("private-slots-rootfs");
    let worker = Worker::with_factory(
        config(broker.socket(), &attempts, &cgroups, &rootfs),
        FakeFactory::new(winning_white(), winning_black()),
    )
    .expect("worker configuration");
    worker.run_once().expect("the attempt runs").expect("one attempt was claimed");

    // Both game queues are asked for under the one game-slot budget: a private test is not a
    // separate pool, so it can never exceed the operator's game slots.
    let claim_request = broker.request("claim").expect("claim was sent");
    assert_eq!(claim_request["parameters"]["options"]["jobTypes"], json!(["GAME", "TEST_GAME"]));
    assert_eq!(claim_request["parameters"]["capacity"]["gameSlots"], 2);
    assert_eq!(claim_request["parameters"]["capacity"]["buildSlots"], 0);
    assert_eq!(
        sorted_keys(&claim_request["parameters"]["capacity"]),
        vec!["buildSlots", "gameSlots", "runtimeProfileDigest"]
    );

    // A worker with no game slots offers no private tests at all.
    let toolchains_root = TempDir::new("private-slots-toolchains");
    let output_root = TempDir::new("private-slots-output");
    let build_only = build_config(broker.socket(), &attempts, &cgroups, &toolchains_root, &output_root);
    assert_eq!(build_only.job_types(), vec!["BUILD", "TEST_BUILD"]);
    assert_eq!(build_only.capacity()["gameSlots"], json!(0));
}

#[test]
fn an_unknown_claim_job_type_is_refused_before_anything_starts() {
    let spool = TempDir::new("private-unknown-spool");
    let artifact_bytes = b"\x7fELF the granted opponent artifact".to_vec();
    let (payload, _, _) = test_assignment(spool.path(), &artifact_bytes);
    let broker = FakeBroker::start(claim(payload, "TEST_RANKED", TEST));
    let attempts = TempDir::new("private-unknown-attempts");
    let cgroups = TempDir::new("private-unknown-cgroups");
    let rootfs = TempDir::new("private-unknown-rootfs");
    let worker = Worker::with_factory(
        config(broker.socket(), &attempts, &cgroups, &rootfs),
        FakeFactory::new(winning_white(), winning_black()),
    )
    .expect("worker configuration");

    let error = worker.run_once().expect_err("an unknown job type must fail closed");
    assert_eq!(error.code(), "JOB_TYPE_UNSUPPORTED");
    assert_eq!(broker.operations(), vec!["claim".to_owned()]);
    assert_eq!(broker.staged().chunks, 0);
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!attempts.path().join(ATTEMPT).exists());
}

#[test]
fn a_private_test_assignment_is_parsed_strictly_and_bound_to_its_queue() {
    let spool = TempDir::new("private-shape-spool");
    let artifact_bytes = b"\x7fELF the granted opponent artifact".to_vec();
    let (payload, _, _) = test_assignment(spool.path(), &artifact_bytes);
    assert_eq!(parse_assignment(&payload, PROFILE).expect("a private test parses").job_type, GameJobType::TestGame);

    // The test's own id is the only identity a private test may carry, and the pinned opponent is
    // part of its shape: neither is optional.
    let mut mismatched = payload.clone();
    mismatched["testId"] = json!(GAME);
    assert_eq!(parse_assignment(&mismatched, PROFILE).expect_err("ids must agree").code(), "ASSIGNMENT_INVALID");
    let mut missing = payload.clone();
    missing.as_object_mut().expect("object").remove("opponent");
    assert_eq!(parse_assignment(&missing, PROFILE).expect_err("an opponent is required").code(), "ASSIGNMENT_INVALID");
    let mut unknown_kind = payload.clone();
    unknown_kind["opponent"]["kind"] = json!("SOMEONE_ELSE");
    assert_eq!(parse_assignment(&unknown_kind, PROFILE).expect_err("opponent kind").code(), "ASSIGNMENT_INVALID");
    let mut foreign_profile = payload.clone();
    foreign_profile["runtimeProfileDigest"] = json!("f".repeat(64));
    assert_eq!(
        parse_assignment(&foreign_profile, PROFILE).expect_err("another worker's profile").code(),
        "RUNTIME_PROFILE_MISMATCH"
    );

    // The lease's queue and the assignment's own job type must agree, in both directions.
    let cross = |payload: Value, job_type: &str, target: &str| -> String {
        let broker = FakeBroker::start(claim(payload, job_type, target));
        let attempts = TempDir::new("private-cross-attempts");
        let cgroups = TempDir::new("private-cross-cgroups");
        let rootfs = TempDir::new("private-cross-rootfs");
        let worker = Worker::with_factory(
            config(broker.socket(), &attempts, &cgroups, &rootfs),
            FakeFactory::new(winning_white(), winning_black()),
        )
        .expect("worker configuration");
        let error = worker.run_once().expect_err("the queues must agree");
        assert_eq!(broker.submitted_evidence(), None);
        error.code().to_owned()
    };
    let (game_payload, _) = assignment(spool.path());
    assert_eq!(cross(game_payload, "TEST_GAME", GAME), "LEASE_MISMATCH");
    assert_eq!(cross(payload, "GAME", TEST), "LEASE_MISMATCH");
}
