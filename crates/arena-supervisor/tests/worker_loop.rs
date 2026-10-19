//! The native workload loop end to end, with a framed fake gateway and scripted workloads:
//! claim → validate → materialize → launch → observe → prepare → complete, plus every fail-closed
//! branch (nothing is submitted unless the engine's verdict and the worker's own measurements
//! agree).
mod worker_support;

use arena_supervisor::materialize::parse_assignment;
use arena_supervisor::worker::{
    completion_evidence, parse_session_evidence, Observation, Worker, WorkerConfig,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use worker_support::{
    assignment, claim, config, cpp_assignment, winning_black, winning_white, FakeBroker, FakeFactory,
    Step, TempDir, ATTEMPT, COMPLETION, GAME, PROFILE, READY,
};

fn submitted(broker: &FakeBroker) -> Value {
    broker.submitted_evidence().expect("the worker prepared a completion")
}

fn worker_for<'a>(
    broker: &FakeBroker,
    attempts: &TempDir,
    cgroups: &TempDir,
    rootfs: &TempDir,
    factory: FakeFactory,
) -> Worker<FakeFactory> {
    Worker::with_factory(config(broker.socket(), attempts, cgroups, rootfs), factory).expect("worker configuration")
}

#[test]
fn claims_materializes_observes_and_completes() {
    let spool = TempDir::new("loop-spool");
    let (payload, digest) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("loop-attempts");
    let cgroups = TempDir::new("loop-cgroups");
    let rootfs = TempDir::new("loop-rootfs");
    let factory = FakeFactory::new(winning_white(), winning_black());
    let factory_state = Arc::clone(&factory.state);
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);

    let report = worker.run_once().expect("the attempt runs").expect("one attempt was claimed");
    assert_eq!(report.target_id, GAME);
    assert_eq!(report.job_type, "GAME");
    assert_eq!(report.detail, "THRONE_BREACH");
    assert_eq!(report.outcome, "COMPLETED");
    assert_eq!(report.observations, 5);
    assert!(!attempts.path().join(ATTEMPT).exists(), "the workspace is removed after the attempt");

    // The engine's session machinery really drove the game: both INITs first, then one turn at a
    // time, and both workloads were terminated with a confirmed empty cgroup.
    {
        let state = factory_state.lock().expect("factory state");
        let requests = state.requests.clone();
        assert_eq!(requests.len(), 5);
        assert_eq!(requests[0].0, 1);
        assert!(requests[0].1, "the first exchange is the startup");
        assert!(requests[0].2.contains("\"type\":\"INIT\""), "{}", requests[0].2);
        assert!(requests[0].2.contains("\"my_side\":\"WHITE\""), "{}", requests[0].2);
        assert!(requests[1].2.contains("\"my_side\":\"BLACK\""), "{}", requests[1].2);
        assert!(!requests[2].1, "the first turn is not a startup");
        assert!(requests[2].2.contains("\"type\":\"TURN\""), "{}", requests[2].2);
        assert!(requests[2].2.contains("\"turn_number\":1"), "{}", requests[2].2);
        assert_eq!(state.launched, vec![1, 2]);
        assert_eq!(state.stopped, vec![1, 2]);
    }

    // The game budgets are the contract the runner session verifies, not a build's INIT limits.
    assert_eq!(
        factory_state.lock().expect("factory state").budgets,
        vec![
            worker_support::BudgetKey { startup_cpu_usec: 500_000, startup_wall_ms: 1_000 },
            worker_support::BudgetKey { startup_cpu_usec: 500_000, startup_wall_ms: 1_000 },
        ]
    );

    // Slot offer and narrowing exactly as the operator and the gateway require.
    let claim_request = broker.request("claim").expect("claim was sent");
    assert_eq!(claim_request["parameters"]["capacity"]["buildSlots"], 0);
    assert_eq!(claim_request["parameters"]["capacity"]["gameSlots"], 2);
    assert_eq!(claim_request["parameters"]["capacity"]["runtimeProfileDigest"], PROFILE);
    assert_eq!(claim_request["parameters"]["options"]["jobTypes"], json!(["GAME", "TEST_GAME"]));

    // The lease was kept alive while the match ran, and the completion followed the lease.
    let operations = broker.operations();
    assert_eq!(operations.first().map(String::as_str), Some("claim"));
    assert!(operations.iter().any(|operation| operation == "heartbeat"));
    assert!(operations.iter().any(|operation| operation == "prepareCompletion"));
    assert_eq!(operations.last().map(String::as_str), Some("complete"));
    let live = broker.request("liveTurn").expect("official committed turns publish a preview");
    assert_eq!(live["parameters"]["seq"], 1);
    assert_eq!(live["parameters"]["turnNumber"], 1);
    assert_eq!(live["parameters"]["action"], json!({"action":"MOVE","pieceId":1,"target":[1,2]}));

    let evidence = submitted(&broker);
    assert_eq!(evidence["manifestDigest"], digest);
    assert_eq!(evidence["gameEvidence"]["winner"], 1);
    assert_eq!(evidence["gameEvidence"]["reason"], "THRONE_BREACH");
    assert_eq!(evidence["gameEvidence"]["disposition"], "DECISIVE");
    assert_eq!(evidence["gameEvidence"]["executionStatus"], "COMPLETED");
    assert_eq!(evidence["gameEvidence"]["totalPly"], 3);
    assert_eq!(
        evidence["gameEvidence"]["trace"],
        json!([
            { "ply": 1, "side": 1, "move": { "pieceId": 1, "targetPos": { "x": 1, "y": 2 } } },
            { "ply": 2, "side": 2, "move": { "pieceId": 2, "targetPos": { "x": 1, "y": 1 } } },
            { "ply": 3, "side": 1, "move": { "pieceId": 1, "targetPos": { "x": 2, "y": 2 } } },
        ])
    );

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
        assert_eq!(observation["cpuUsec"], "1200");
        assert_eq!(observation["wallUsec"], "2400");
        assert_eq!(observation["freezeConfirmed"], true);
        assert_eq!(observation["terminationConfirmed"], true);
        assert_eq!(observation["responseNdjson"].as_str(), Some(*line));
    }

    let completion = broker.submitted_completion().expect("the completion was submitted");
    assert_eq!(completion["completionId"], COMPLETION);
    assert_eq!(completion["deploymentGeneration"], 7);
    let evidence_digest = completion["evidenceDigest"].as_str().expect("digest");
    assert_eq!(evidence_digest.len(), 64);
    assert!(evidence_digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

#[test]
fn a_cpp_game_runs_the_granted_artifact_and_never_compiles() {
    let spool = TempDir::new("cpp-loop-spool");
    let artifact_bytes = b"\x7fELF the granted compiled bot".to_vec();
    let (payload, _, _) = cpp_assignment(spool.path(), &artifact_bytes);
    let broker = FakeBroker::start(claim(payload.clone(), "GAME", GAME));
    let attempts = TempDir::new("cpp-loop-attempts");
    let cgroups = TempDir::new("cpp-loop-cgroups");
    let rootfs = TempDir::new("cpp-loop-rootfs");
    let factory = FakeFactory::new(winning_white(), winning_black());
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);

    let report = worker.run_once().expect("the attempt runs").expect("one attempt");
    assert_eq!(report.outcome, "COMPLETED");
    assert_eq!(report.observations, 5);

    // A CPP GAME must never compile or reject: no toolchain runner is involved at all, and the
    // granted artifact is what the sandbox would exec.
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let artifact = parsed.bots[0].artifact.as_ref().expect("artifact grant");
    assert_eq!(artifact.entrypoint, "bot");
    assert_eq!(artifact.grant.size_bytes, artifact_bytes.len() as u64);

    // The attempt is gone, so the assertion is on what the worker accepted: an unverifiable
    // artifact grant is refused before any exchange happens.
    let spool2 = TempDir::new("cpp-loop-tampered");
    let (payload2, _, _) = cpp_assignment(spool2.path(), &artifact_bytes);
    let path = payload2["bots"][0]["artifact"]["path"].as_str().expect("path").to_owned();
    fs::write(&path, b"another artifact entirely").expect("tamper");
    let broker = FakeBroker::start(claim(payload2, "GAME", GAME));
    let attempts = TempDir::new("cpp-loop-tampered-attempts");
    let cgroups = TempDir::new("cpp-loop-tampered-cgroups");
    let rootfs = TempDir::new("cpp-loop-tampered-rootfs");
    let factory = FakeFactory::new(winning_white(), winning_black());
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);
    let error = worker.run_once().expect_err("a tampered artifact must abort");
    assert_eq!(error.code(), "GRANT_SIZE_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!attempts.path().join(ATTEMPT).exists());
}

#[test]
fn a_refused_teardown_quarantines_the_worker() {
    // The match plays to a verdict, but the workload's cgroup never empties: nothing is submitted
    // and the host stops claiming.
    let spool = TempDir::new("game-teardown-spool");
    let (payload, _) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("game-teardown-attempts");
    let cgroups = TempDir::new("game-teardown-cgroups");
    let rootfs = TempDir::new("game-teardown-rootfs");
    let factory = FakeFactory::new(winning_white(), winning_black());
    factory.fail_teardown();
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);

    let error = worker.run_once().expect_err("a refused teardown is infrastructure");
    assert_eq!(error.code(), "SANDBOX_TERMINATION_UNCONFIRMED");
    assert!(worker.quarantined());
    assert_eq!(broker.submitted_evidence(), None);
    assert_eq!(broker.submitted_completion(), None);
}

#[test]
fn reports_idle_when_the_gateway_has_nothing_assignable() {
    let broker = FakeBroker::start(Value::Null);
    let attempts = TempDir::new("idle-attempts");
    let cgroups = TempDir::new("idle-cgroups");
    let rootfs = TempDir::new("idle-rootfs");
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, FakeFactory::new(Vec::new(), Vec::new()));
    assert!(worker.run_once().expect("idle is not an error").is_none());
    assert_eq!(broker.operations(), vec!["claim".to_owned()]);
}

#[test]
fn refuses_an_assignment_it_cannot_verify() {
    let spool = TempDir::new("bad-spool");
    let (mut payload, _) = assignment(spool.path());
    payload["manifestDigest"] = json!("0".repeat(64));
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("bad-attempts");
    let cgroups = TempDir::new("bad-cgroups");
    let rootfs = TempDir::new("bad-rootfs");
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, FakeFactory::new(winning_white(), winning_black()));

    let error = worker.run_once().expect_err("an unverifiable assignment must abort");
    assert_eq!(error.code(), "MANIFEST_DIGEST");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!broker.operations().iter().any(|operation| operation == "prepareCompletion"));
    assert!(!attempts.path().join(ATTEMPT).exists(), "nothing may be written for a rejected assignment");
}

#[test]
fn refuses_a_lease_that_does_not_match_the_assignment() {
    let spool = TempDir::new("lease-spool");
    let (payload, _) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", "99999999-9999-4999-8999-999999999999"));
    let attempts = TempDir::new("lease-attempts");
    let cgroups = TempDir::new("lease-cgroups");
    let rootfs = TempDir::new("lease-rootfs");
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, FakeFactory::new(winning_white(), winning_black()));
    let error = worker.run_once().expect_err("a foreign target must abort");
    assert_eq!(error.code(), "LEASE_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
}

#[test]
fn refuses_to_launch_without_a_delegated_cgroup() {
    // The production factory over the real Sandbox primitive: a plain directory is not a delegated
    // cgroup, so the launch fails closed before the runsc path is ever reached.
    let spool = TempDir::new("cgroup-spool");
    let (payload, _) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("cgroup-attempts");
    let cgroups = TempDir::new("plain-directory");
    let rootfs = TempDir::new("cgroup-rootfs");
    let worker = Worker::new(config(broker.socket(), &attempts, &cgroups, &rootfs)).expect("worker");

    let error = worker.run_once().expect_err("no usable cgroup must abort");
    assert_eq!(error.code(), "WORKLOAD_LAUNCH_FAILED");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!attempts.path().join(ATTEMPT).exists(), "the attempt is cleaned up after a failed launch");
}

#[test]
fn a_measured_protocol_violation_is_a_forfeit_not_a_forgery() {
    // Side 1 answers its INIT with a line that is not a JSON object. The sandbox measured that
    // response, so the violation is provable and becomes a forfeit with real counters.
    let spool = TempDir::new("fault-spool");
    let (payload, digest) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("fault-attempts");
    let cgroups = TempDir::new("fault-cgroups");
    let rootfs = TempDir::new("fault-rootfs");
    let factory = FakeFactory::new(vec![Step::Response("not json\n")], vec![Step::Response(READY)]);
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);

    let report = worker.run_once().expect("the attempt runs").expect("one attempt");
    assert_eq!(report.outcome, "BOT_FORFEIT");
    assert_eq!(report.detail, "PROTOCOL_VIOLATION");
    assert_eq!(report.observations, 1);

    let evidence = submitted(&broker);
    assert_eq!(evidence["manifestDigest"], digest);
    assert_eq!(evidence["gameEvidence"]["winner"], 2);
    assert_eq!(evidence["gameEvidence"]["reason"], "PROTOCOL_VIOLATION");
    assert_eq!(evidence["gameEvidence"]["disposition"], "DECISIVE");
    assert_eq!(evidence["gameEvidence"]["executionStatus"], "BOT_FORFEIT");
    assert_eq!(evidence["gameEvidence"]["totalPly"], 0);
    assert_eq!(evidence["gameEvidence"]["trace"], json!([]));
    let observations = evidence["observations"].as_array().expect("observations");
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0]["side"], 1);
    assert_eq!(observations[0]["ply"], 0);
    assert_eq!(observations[0]["kind"], "PROTOCOL_ERROR");
    assert_eq!(observations[0]["cpuUsec"], "1200");
    assert_eq!(observations[0]["freezeConfirmed"], true);
    assert_eq!(observations[0]["terminationConfirmed"], true);
}

#[test]
fn an_illegal_move_forfeits_with_the_measured_response_kept() {
    // Side 1 sends a syntactically valid move the engine rejects (a two-step King move). The
    // response stays in the observation, so the forfeit is provable from the Bot's own bytes.
    let spool = TempDir::new("illegal-spool");
    let (payload, _) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("illegal-attempts");
    let cgroups = TempDir::new("illegal-cgroups");
    let rootfs = TempDir::new("illegal-rootfs");
    let factory = FakeFactory::new(
        vec![
            Step::Response(READY),
            Step::Response("{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[9,9]}\n"),
        ],
        vec![Step::Response(READY)],
    );
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);

    let report = worker.run_once().expect("the attempt runs").expect("one attempt");
    assert_eq!(report.outcome, "BOT_FORFEIT");
    assert_eq!(report.detail, "ILLEGAL_MOVE");
    assert_eq!(report.observations, 3);

    let evidence = submitted(&broker);
    assert_eq!(evidence["gameEvidence"]["winner"], 2);
    assert_eq!(evidence["gameEvidence"]["reason"], "ILLEGAL_MOVE");
    assert_eq!(evidence["gameEvidence"]["executionStatus"], "BOT_FORFEIT");
    assert_eq!(evidence["gameEvidence"]["totalPly"], 0);
    let observations = evidence["observations"].as_array().expect("observations");
    assert_eq!(observations.len(), 3);
    assert_eq!(
        observations[2]["responseNdjson"].as_str(),
        Some("{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[9,9]}\n")
    );
}

#[test]
fn a_sandbox_fault_without_measured_counters_aborts_the_attempt() {
    let steps = [
        (Step::CpuTimeout, "BOT_CPU_TIMEOUT"),
        (Step::WallTimeout, "BOT_WALL_TIMEOUT"),
        (Step::OutputLimit, "BOT_OUTPUT_LIMIT"),
        (Step::ProtocolViolation, "BOT_PROTOCOL_VIOLATION"),
        (Step::UnmeasuredBudget, "BOT_BUDGET_UNMEASURED"),
    ];
    for (step, expected) in steps {
        let spool = TempDir::new("abort-spool");
        let (payload, _) = assignment(spool.path());
        let broker = FakeBroker::start(claim(payload, "GAME", GAME));
        let attempts = TempDir::new("abort-attempts");
        let cgroups = TempDir::new("abort-cgroups");
        let rootfs = TempDir::new("abort-rootfs");
        let factory = FakeFactory::new(vec![Step::Response(READY), step], vec![Step::Response(READY)]);
        let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);
        let error = worker.run_once().expect_err("an unmeasured fault must abort");
        assert_eq!(error.code(), expected);
        assert_eq!(broker.submitted_evidence(), None, "{expected} must not submit");
        assert_eq!(broker.submitted_completion(), None, "{expected} must not complete");
        assert!(!attempts.path().join(ATTEMPT).exists(), "{expected} must clean up the attempt");
    }
}

#[test]
fn a_double_forfeit_is_reported_instead_of_mislabelled() {
    // Both Bots fail their INIT. The broker's contract has no winner-0 forfeit, so the worker
    // refuses to invent one and leaves the lease to the reconciler.
    let spool = TempDir::new("double-spool");
    let (payload, _) = assignment(spool.path());
    let broker = FakeBroker::start(claim(payload, "GAME", GAME));
    let attempts = TempDir::new("double-attempts");
    let cgroups = TempDir::new("double-cgroups");
    let rootfs = TempDir::new("double-rootfs");
    let factory = FakeFactory::new(vec![Step::Response("nope\n")], vec![Step::Response("nope\n")]);
    let worker = worker_for(&broker, &attempts, &cgroups, &rootfs, factory);

    let error = worker.run_once().expect_err("a double forfeit is not representable");
    assert_eq!(error.code(), "DOUBLE_FORFEIT_UNREPRESENTABLE");
    assert_eq!(broker.submitted_evidence(), None);
}

#[test]
fn configuration_requires_explicit_operator_values() {
    let arguments = [
        "--broker-socket",
        "/run/arena/broker.sock",
        "--runsc",
        "/opt/arena/runsc",
        "--runtime-rootfs",
        "/opt/arena/rootfs",
        "--cgroup-root",
        "/sys/fs/cgroup/arena",
        "--attempt-root",
        "/var/lib/arena/attempts",
        "--runtime-profile-digest",
        PROFILE,
        "--max-game-slots",
        "3",
        "--heartbeat-seconds",
        "4",
        "--poll-seconds",
        "1",
        "--once",
    ]
    .iter()
    .map(|argument| (*argument).to_owned());
    let config = WorkerConfig::from_arguments(arguments, |_| None).expect("explicit configuration");
    assert_eq!(config.max_game_slots, 3);
    assert_eq!(config.max_build_slots, 0);
    assert_eq!(config.runsc, PathBuf::from("/opt/arena/runsc"));
    assert_eq!(config.heartbeat, Duration::from_secs(4));
    assert_eq!(config.poll, Duration::from_secs(1));
    assert!(config.once);
    assert_eq!(config.broker_socket, PathBuf::from("/run/arena/broker.sock"));
    assert_eq!(config.job_types(), vec!["GAME", "TEST_GAME"]);

    // Environment variables are the other explicit source; nothing is ever guessed.
    let environment = |name: &str| match name {
        "OANTUTI_WORKER_BROKER_SOCKET" => Some("/run/arena/broker.sock".to_owned()),
        "OANTUTI_WORKER_RUNSC" => Some("/opt/arena/runsc".to_owned()),
        "OANTUTI_WORKER_RUNTIME_ROOTFS" => Some("/opt/arena/rootfs".to_owned()),
        "OANTUTI_WORKER_CGROUP_ROOT" => Some("/sys/fs/cgroup/arena".to_owned()),
        "OANTUTI_WORKER_ATTEMPT_ROOT" => Some("/var/lib/arena/attempts".to_owned()),
        "OANTUTI_WORKER_RUNTIME_PROFILE_DIGEST" => Some(PROFILE.to_owned()),
        "OANTUTI_WORKER_MAX_GAME_SLOTS" => Some("1".to_owned()),
        _ => None,
    };
    let config = WorkerConfig::from_arguments(Vec::<String>::new(), environment).expect("environment configuration");
    assert_eq!(config.heartbeat, Duration::from_secs(5));
    assert_eq!(config.max_build_slots, 0);
    assert!(!config.once);

    // A worker that offers build slots must be given the toolchain document and the output root.
    let build_slots = [
        "--broker-socket",
        "/run/arena/broker.sock",
        "--runsc",
        "/opt/arena/runsc",
        "--runtime-rootfs",
        "/opt/arena/rootfs",
        "--cgroup-root",
        "/sys/fs/cgroup/arena",
        "--attempt-root",
        "/var/lib/arena/attempts",
        "--runtime-profile-digest",
        PROFILE,
        "--max-game-slots",
        "0",
        "--max-build-slots",
        "2",
    ]
    .iter()
    .map(|argument| (*argument).to_owned());
    let error = WorkerConfig::from_arguments(build_slots.clone(), |_| None)
        .expect_err("build slots require the operator prerequisites");
    assert_eq!(error.code(), "CONFIG_INVALID");

    let incomplete = WorkerConfig::from_arguments(
        ["--broker-socket".to_owned(), "/run/arena/broker.sock".to_owned()],
        |_| None,
    )
    .expect_err("every required value must be provided");
    assert_eq!(incomplete.code(), "CONFIG_INVALID");

    let unknown = WorkerConfig::from_arguments(["--nope".to_owned(), "1".to_owned()], |_| None)
        .expect_err("unknown options must be refused");
    assert_eq!(unknown.code(), "CONFIG_INVALID");

    let relative = WorkerConfig::from_arguments(["--attempt-root".to_owned(), "attempts".to_owned()], |name| {
        match name {
            "OANTUTI_WORKER_BROKER_SOCKET" => Some("/run/arena/broker.sock".to_owned()),
            "OANTUTI_WORKER_RUNSC" => Some("/opt/arena/runsc".to_owned()),
            "OANTUTI_WORKER_RUNTIME_ROOTFS" => Some("/opt/arena/rootfs".to_owned()),
            "OANTUTI_WORKER_CGROUP_ROOT" => Some("/sys/fs/cgroup/arena".to_owned()),
            "OANTUTI_WORKER_RUNTIME_PROFILE_DIGEST" => Some(PROFILE.to_owned()),
            "OANTUTI_WORKER_MAX_GAME_SLOTS" => Some("1".to_owned()),
            _ => None,
        }
    })
    .expect_err("relative operator paths must be refused");
    assert_eq!(relative.code(), "CONFIG_INVALID");
}

fn ready(side: u8, ply: u32) -> Observation {
    Observation {
        side,
        ply,
        kind: "RESPONSE",
        cpu_usec: 10,
        wall_usec: 20,
        response: Some(READY.as_bytes().to_vec()),
    }
}

fn move_response(side: u8, ply: u32, line: &str) -> Observation {
    Observation {
        side,
        ply,
        kind: "RESPONSE",
        cpu_usec: 10,
        wall_usec: 20,
        response: Some(line.as_bytes().to_vec()),
    }
}

#[test]
fn evidence_must_agree_with_the_engine_trace() {
    let spool = TempDir::new("evidence-spool");
    let (payload, _) = assignment(spool.path());
    let parsed = parse_assignment(&payload, PROFILE).expect("valid assignment");
    let document = json!({
        "initialTerminal": false,
        "outcome": {
            "isGameOver": true,
            "winner": "WHITE",
            "reason": "THRONE_BREACH",
            "disposition": "DECISIVE",
        },
        "actionTrace": [
            { "ply": 1, "side": "WHITE", "action": { "pieceId": 1, "target": { "x": 1, "y": 2 } } },
        ],
    })
    .to_string();

    // An observation that disagrees with the engine's own action is refused, not submitted.
    let observations = vec![
        ready(1, 0),
        ready(2, 0),
        move_response(1, 1, "{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[9,9]}\n"),
    ];
    let session = parse_session_evidence(document.as_bytes(), observations).expect("evidence parses");
    let error = completion_evidence(&parsed, &session).expect_err("a lying observation must be refused");
    assert_eq!(error.code(), "EVIDENCE_MISMATCH");

    // The same game with the matching observation is shaped exactly like the broker's contract.
    let observations = vec![
        ready(1, 0),
        ready(2, 0),
        move_response(1, 1, "{\"action\":\"MOVE\",\"piece_id\":1,\"target\":[1,2]}\n"),
    ];
    let session = parse_session_evidence(document.as_bytes(), observations).expect("evidence parses");
    let evidence = completion_evidence(&parsed, &session).expect("matching evidence is representable");
    assert_eq!(evidence["gameEvidence"]["totalPly"], 1);
    assert_eq!(evidence["gameEvidence"]["executionStatus"], "COMPLETED");
    assert_eq!(evidence["observations"].as_array().map(Vec::len), Some(3));
}

#[test]
fn unreadable_or_inconsistent_engine_evidence_is_refused() {
    let observations = vec![ready(1, 0), ready(2, 0)];
    assert_eq!(
        parse_session_evidence(b"not json", observations.clone())
            .expect_err("unreadable")
            .code(),
        "EVIDENCE_UNREADABLE"
    );
    let not_finished = json!({
        "initialTerminal": false,
        "outcome": { "isGameOver": false, "winner": null, "reason": "STALEMATE", "disposition": "DECISIVE" },
        "actionTrace": [],
    })
    .to_string();
    assert_eq!(
        parse_session_evidence(not_finished.as_bytes(), observations.clone())
            .expect_err("unfinished")
            .code(),
        "EVIDENCE_UNREADABLE"
    );
    let wrong_order = json!({
        "initialTerminal": false,
        "outcome": { "isGameOver": true, "winner": "BLACK", "reason": "THRONE_BREACH", "disposition": "DECISIVE" },
        "actionTrace": [
            { "ply": 2, "side": "WHITE", "action": { "pieceId": 1, "target": { "x": 1, "y": 2 } } },
        ],
    })
    .to_string();
    assert_eq!(
        parse_session_evidence(wrong_order.as_bytes(), observations)
            .expect_err("out of order")
            .code(),
        "EVIDENCE_MISMATCH"
    );
}
