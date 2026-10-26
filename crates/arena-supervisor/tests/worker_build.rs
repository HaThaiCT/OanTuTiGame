//! The BUILD/TEST_BUILD loop end to end: toolchain probe, compile step, INIT smoke test, artifact
//! measurement and staging — with every classification boundary the frozen contract names.
mod worker_support;

use arena_supervisor::materialize::{artifact_key, parse_build_assignment, Language};
use arena_supervisor::sandbox::CommandOutcome;
use arena_supervisor::worker::{SandboxRunner, Worker, WorkerConfig};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use worker_support::{
    build_assignment, build_config, claim, hex, sha256, sha256_hex, FakeBroker, FakeFactory,
    RunnerStep, ScriptedRunner, Step, TempDir, ATTEMPT, BUILD_TARGET, IMAGE_DIGEST, READY,
};

const CPP_SOURCE: &[u8] = b"int main() { return 0; }\n";
const CPP_BINARY: &[u8] = b"\x7fELF a compiled artifact the worker must measure";

fn cpp_worker<'a>(
    broker: &FakeBroker,
    attempts: &TempDir,
    cgroups: &TempDir,
    toolchain_rootfs: &TempDir,
    output_root: &TempDir,
    factory: FakeFactory,
    runner: ScriptedRunner,
) -> Worker<FakeFactory, ScriptedRunner> {
    let config = build_config(broker.socket(), attempts, cgroups, toolchain_rootfs, output_root);
    Worker::with_runner(config, factory, runner).expect("worker configuration")
}

fn submitted(broker: &FakeBroker) -> Value {
    broker.submitted_evidence().expect("the worker prepared a completion")
}

fn with_cpp_assignment(spool: &TempDir) -> Value {
    let (mut payload, _) = build_assignment(spool.path(), "CPP", "main.cpp", &["-O2", "-std=c++20"], "13.2.0");
    // The spooled ZIP carries the real entrypoint the language rules accept.
    payload["source"] = worker_support::spool(
        spool.path(),
        "cpp-source.zip",
        &worker_support::zip_stored(&[("main.cpp", CPP_SOURCE)]),
    );
    payload
}

#[test]
fn a_cpp_build_reports_the_artifact_digest_it_measured_itself() {
    let spool = TempDir::new("build-spool");
    let payload = with_cpp_assignment(&spool);
    let manifest_digest = payload["manifestDigest"].as_str().expect("digest").to_owned();
    let broker = FakeBroker::start(claim(payload.clone(), "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("build-attempts");
    let cgroups = TempDir::new("build-cgroups");
    let toolchain_rootfs = TempDir::new("build-toolchain");
    let output_root = TempDir::new("build-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    let runner = ScriptedRunner::new(vec![
        RunnerStep::version("g++ (GCC) 13.2.0"),
        RunnerStep::Produces(CPP_BINARY.to_vec()),
    ]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let report = worker.run_once().expect("the build runs").expect("one attempt was claimed");
    assert_eq!(report.job_type, "BUILD");
    assert_eq!(report.outcome, "READY");
    assert_eq!(report.detail, "INIT_SMOKE");
    assert_eq!(report.bytes, CPP_BINARY.len() as u64);
    assert!(!attempts.path().join(ATTEMPT).exists(), "the build attempt is removed afterwards");

    // The claim offered exactly the job types this worker can run.
    let claim_request = broker.request("claim").expect("claim was sent");
    assert_eq!(claim_request["parameters"]["capacity"]["buildSlots"], 1);
    assert_eq!(claim_request["parameters"]["capacity"]["gameSlots"], 0);
    assert_eq!(claim_request["parameters"]["options"]["jobTypes"], json!(["BUILD", "TEST_BUILD"]));

    // The evidence names the toolchain the sandbox reported, the assignment's manifest and the
    // artifact the worker hashed itself.
    let evidence = submitted(&broker);
    assert_eq!(evidence["outcome"], "READY");
    assert_eq!(evidence["stage"], "INIT_SMOKE");
    assert_eq!(evidence["toolchain"]["language"], "CPP");
    assert_eq!(evidence["toolchain"]["imageDigest"], IMAGE_DIGEST);
    assert_eq!(evidence["toolchain"]["version"], "13.2.0");
    assert_eq!(evidence["toolchain"]["flags"], json!(["-O2", "-std=c++20"]));
    assert_eq!(evidence["manifestDigest"], manifest_digest);
    assert_eq!(evidence["artifact"]["entrypoint"], "bot");
    assert_eq!(evidence["artifact"]["digest"], sha256_hex(CPP_BINARY));
    assert_eq!(evidence["artifact"]["sizeBytes"], CPP_BINARY.len());
    let expected_key = format!(
        "compiled/CPP/{manifest_digest}/{}",
        hex(&sha256(format!("CPP\n{IMAGE_DIGEST}\n13.2.0\n-O2\n-std=c++20\n").as_bytes()))
    );
    assert_eq!(evidence["artifact"]["key"], expected_key);

    // The bytes the gateway holds are the bytes the compile step wrote, staged before completion.
    let staged = broker.staged();
    assert_eq!(staged.bytes, CPP_BINARY.to_vec());
    assert_eq!(staged.digest, sha256_hex(CPP_BINARY));
    assert_eq!(staged.size_bytes, CPP_BINARY.len() as u64);
    assert_eq!(staged.entrypoint, "bot");
    assert!(staged.chunks >= 1);

    let operations = broker.operations();
    let staged_at = operations.iter().position(|operation| operation == "stageArtifact").expect("staged");
    let prepared_at = operations.iter().position(|operation| operation == "prepareCompletion").expect("prepared");
    let completed_at = operations.iter().position(|operation| operation == "complete").expect("completed");
    assert!(staged_at < prepared_at && prepared_at < completed_at, "{operations:?}");
    assert_eq!(
        broker.submitted_completion().expect("completion")["deploymentGeneration"],
        7
    );
}

#[test]
fn a_large_artifact_is_staged_in_ascending_chunks() {
    let spool = TempDir::new("chunk-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("chunk-attempts");
    let cgroups = TempDir::new("chunk-cgroups");
    let toolchain_rootfs = TempDir::new("chunk-toolchain");
    let output_root = TempDir::new("chunk-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    // One and a half chunks: 512 KiB frames plus a remainder.
    let artifact: Vec<u8> = (0..900 * 1024).map(|index| (index % 251) as u8).collect();
    let runner = ScriptedRunner::new(vec![
        RunnerStep::version("g++ (GCC) 13.2.0"),
        RunnerStep::Produces(artifact.clone()),
    ]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let report = worker.run_once().expect("the build runs").expect("one attempt");
    assert_eq!(report.outcome, "READY");
    let staged = broker.staged();
    assert_eq!(staged.bytes, artifact, "every chunk must reassemble into the artifact");
    assert_eq!(staged.chunks, 2, "900 KiB needs two 512 KiB frames");
    assert_eq!(submitted(&broker)["artifact"]["sizeBytes"], artifact.len());
}

#[test]
fn a_scripted_compile_failure_is_source_rejected_at_the_compile_stage() {
    let spool = TempDir::new("compile-fail-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("compile-fail-attempts");
    let cgroups = TempDir::new("compile-fail-cgroups");
    let toolchain_rootfs = TempDir::new("compile-fail-toolchain");
    let output_root = TempDir::new("compile-fail-output");
    let factory = FakeFactory::new(Vec::new(), Vec::new());
    let runner = ScriptedRunner::new(vec![
        RunnerStep::version("g++ (GCC) 13.2.0"),
        RunnerStep::CompileFailure(b"main.cpp:3:12: error: expected ';' before '}'\n".to_vec()),
    ]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let report = worker.run_once().expect("a rejection is a successful job").expect("one attempt");
    assert_eq!(report.outcome, "SOURCE_REJECTED");
    assert_eq!(report.detail, "COMPILE");
    assert_eq!(report.bytes, 0);

    let evidence = submitted(&broker);
    assert_eq!(evidence["outcome"], "SOURCE_REJECTED");
    assert_eq!(evidence["stage"], "COMPILE");
    assert!(evidence.get("artifact").is_none(), "a rejection carries no artifact");
    let diagnostic = evidence["diagnostic"].as_str().expect("diagnostic");
    assert!(diagnostic.contains("COMPILE_FAILED"), "{diagnostic}");
    assert!(diagnostic.contains("expected ';'"), "{diagnostic}");
    assert!(diagnostic.len() <= 2000);

    // Nothing was uploaded, the compile never reached the smoke test, and the job still completed.
    assert_eq!(broker.staged().chunks, 0);
    let operations = broker.operations();
    assert!(operations.iter().any(|operation| operation == "prepareCompletion"));
    assert_eq!(operations.last().map(String::as_str), Some("complete"));
}

#[test]
fn an_init_that_cannot_greet_is_source_rejected_at_the_init_smoke_stage() {
    // A malformed INIT answer and a well-formed answer that is not READY are both verdicts.
    let cases: [(&str, Vec<Step>); 2] = [
        ("not json\n", vec![Step::Response("not json\n")]),
        ("not ready", vec![Step::Response("{\"status\":\"PLAYING\"}\n")]),
    ];
    for (name, steps) in cases {
        let spool = TempDir::new("smoke-spool");
        let payload = with_cpp_assignment(&spool);
        let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
        let attempts = TempDir::new("smoke-attempts");
        let cgroups = TempDir::new("smoke-cgroups");
        let toolchain_rootfs = TempDir::new("smoke-toolchain");
        let output_root = TempDir::new("smoke-output");
        let factory = FakeFactory::new(steps, Vec::new());
        let runner = ScriptedRunner::new(vec![
            RunnerStep::version("g++ (GCC) 13.2.0"),
            RunnerStep::Produces(CPP_BINARY.to_vec()),
        ]);
        let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

        let report = worker.run_once().expect("a rejection is a successful job").expect("one attempt");
        assert_eq!(report.outcome, "SOURCE_REJECTED", "{name}");
        assert_eq!(report.detail, "INIT_SMOKE", "{name}");
        let evidence = submitted(&broker);
        assert_eq!(evidence["stage"], "INIT_SMOKE", "{name}");
        let diagnostic = evidence["diagnostic"].as_str().expect("diagnostic");
        assert!(diagnostic.contains("INIT_SMOKE_FAILED"), "{name}: {diagnostic}");
        assert!(evidence.get("artifact").is_none(), "{name}");
        assert_eq!(broker.staged().chunks, 0, "{name}");
    }
}

#[test]
fn the_init_smoke_uses_the_assignment_limits_and_the_engine_session() {
    let spool = TempDir::new("limits-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("limits-attempts");
    let cgroups = TempDir::new("limits-cgroups");
    let toolchain_rootfs = TempDir::new("limits-toolchain");
    let output_root = TempDir::new("limits-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    let factory_state = Arc::clone(&factory.state);
    let runner = ScriptedRunner::new(vec![
        RunnerStep::version("g++ (GCC) 13.2.0"),
        RunnerStep::Produces(CPP_BINARY.to_vec()),
    ]);
    let runner_state = Arc::clone(&runner.state);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    worker.run_once().expect("the build runs").expect("one attempt");

    // The smoke's INIT budget is the assignment's, not the match budget.
    assert_eq!(
        factory_state.lock().expect("state").budgets,
        vec![worker_support::BudgetKey { startup_cpu_usec: 500_000, startup_wall_ms: 5_000 }]
    );
    // The INIT document is the engine's own, sent to side 1 only.
    let requests = factory_state.lock().expect("state").requests.clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, 1);
    assert!(requests[0].1, "the smoke exchange is a startup exchange");
    assert!(requests[0].2.contains("\"type\":\"INIT\""), "{}", requests[0].2);
    assert!(requests[0].2.contains("\"my_side\":\"WHITE\""), "{}", requests[0].2);
    assert!(requests[0].2.contains("build_smoke_3x3"), "{}", requests[0].2);

    // The probe runs first with its own bound, the compile second with the assignment's compile
    // limit.
    let calls = runner_state.lock().expect("state").calls.clone();
    assert_eq!(calls.len(), 2, "a probe and one compile step");
    assert!(calls[0].0.ends_with("toolchain"), "{:?}", calls[0].0);
    assert_eq!(calls[0].1, Duration::from_secs(5).as_millis());
    assert!(calls[1].0.ends_with("compile"), "{:?}", calls[1].0);
    assert_eq!(calls[1].1, 30_000);
}

#[test]
fn a_probe_or_compile_sandbox_fault_submits_nothing() {
    let cases: [(&str, Vec<RunnerStep>, &str); 3] = [
        ("probe", vec![RunnerStep::Fault("runsc unavailable")], "TOOLCHAIN_PROBE_FAILED"),
        (
            "compile",
            vec![RunnerStep::version("g++ (GCC) 13.2.0"), RunnerStep::Fault("cgroup unusable")],
            "COMPILE_SANDBOX_FAILED",
        ),
        (
            "probe exit",
            vec![RunnerStep::Outcome(CommandOutcome::Exited {
                status: 2,
                diagnostic: b"runsc: container start failed".to_vec(),
                truncated: false,
            })],
            "TOOLCHAIN_PROBE_FAILED",
        ),
    ];
    for (name, steps, expected) in cases {
        let spool = TempDir::new("fault-build-spool");
        let payload = with_cpp_assignment(&spool);
        let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
        let attempts = TempDir::new("fault-build-attempts");
        let cgroups = TempDir::new("fault-build-cgroups");
        let toolchain_rootfs = TempDir::new("fault-build-toolchain");
        let output_root = TempDir::new("fault-build-output");
        let factory = FakeFactory::new(Vec::new(), Vec::new());
        let worker = cpp_worker(
            &broker,
            &attempts,
            &cgroups,
            &toolchain_rootfs,
            &output_root,
            factory,
            ScriptedRunner::new(steps),
        );
        let error = worker.run_once().expect_err("an infrastructure fault must abort");
        assert_eq!(error.code(), expected, "{name}");
        assert_eq!(broker.submitted_evidence(), None, "{name} must submit nothing");
        assert_eq!(broker.submitted_completion(), None, "{name} must not complete");
        assert_eq!(broker.staged().chunks, 0, "{name} must upload nothing");
        assert!(!attempts.path().join(ATTEMPT).exists(), "{name} must clean up");
    }
}

#[test]
fn a_toolchain_that_disagrees_with_the_operator_profile_is_refused() {
    let spool = TempDir::new("profile-spool");
    let payload = with_cpp_assignment(&spool);
    // The operator's profile declares 13.2.0; the assignment claims another version.
    let mut payload = payload;
    payload["toolchain"]["version"] = json!("12.1.0");
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("profile-attempts");
    let cgroups = TempDir::new("profile-cgroups");
    let toolchain_rootfs = TempDir::new("profile-toolchain");
    let output_root = TempDir::new("profile-output");
    let factory = FakeFactory::new(Vec::new(), Vec::new());
    let runner = ScriptedRunner::new(vec![RunnerStep::version("g++ (GCC) 13.2.0")]);
    let runner_state = Arc::clone(&runner.state);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let error = worker.run_once().expect_err("a foreign toolchain must be refused");
    assert_eq!(error.code(), "TOOLCHAIN_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(
        runner_state.lock().expect("state").calls.is_empty(),
        "nothing may run for a foreign toolchain"
    );
    assert!(!attempts.path().join(ATTEMPT).exists());
}

#[test]
fn a_probe_that_does_not_report_the_declared_version_is_an_operator_fault() {
    let spool = TempDir::new("probe-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("probe-attempts");
    let cgroups = TempDir::new("probe-cgroups");
    let toolchain_rootfs = TempDir::new("probe-toolchain");
    let output_root = TempDir::new("probe-output");
    let factory = FakeFactory::new(Vec::new(), Vec::new());
    let runner = ScriptedRunner::new(vec![RunnerStep::version("g++ (GCC) 11.4.0")]);
    let runner_state = Arc::clone(&runner.state);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let error = worker.run_once().expect_err("a stale toolchain image must not build");
    assert_eq!(error.code(), "TOOLCHAIN_VERSION_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
    assert_eq!(runner_state.lock().expect("state").calls.len(), 1, "the compile step must never run");
}

#[test]
fn a_compile_that_writes_no_artifact_aborts_without_evidence() {
    let spool = TempDir::new("no-artifact-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("no-artifact-attempts");
    let cgroups = TempDir::new("no-artifact-cgroups");
    let toolchain_rootfs = TempDir::new("no-artifact-toolchain");
    let output_root = TempDir::new("no-artifact-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    let runner = ScriptedRunner::new(vec![RunnerStep::version("g++ (GCC) 13.2.0"), RunnerStep::succeeded()]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let error = worker.run_once().expect_err("a missing artifact is an operator fault");
    assert_eq!(error.code(), "ARTIFACT_MISSING");
    assert_eq!(broker.submitted_evidence(), None);
}

#[test]
fn a_gateway_that_does_not_confirm_staging_blocks_the_completion() {
    let spool = TempDir::new("stage-refused-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    broker.refuse_staging("INVALID_REQUEST");
    let attempts = TempDir::new("stage-refused-attempts");
    let cgroups = TempDir::new("stage-refused-cgroups");
    let toolchain_rootfs = TempDir::new("stage-refused-toolchain");
    let output_root = TempDir::new("stage-refused-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    let runner = ScriptedRunner::new(vec![
        RunnerStep::version("g++ (GCC) 13.2.0"),
        RunnerStep::Produces(CPP_BINARY.to_vec()),
    ]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let error = worker.run_once().expect_err("an unconfirmed artifact must not complete");
    assert_eq!(error.code(), "ARTIFACT_STAGE_FAILED");
    assert_eq!(broker.submitted_evidence(), None);
    assert!(!broker.operations().iter().any(|operation| operation == "prepareCompletion"));
}

#[test]
fn an_interpreted_build_reports_the_source_it_already_verified() {
    let spool = TempDir::new("python-build-spool");
    let (mut payload, manifest_digest) =
        build_assignment(spool.path(), "PYTHON", "main.py", &["-m", "py_compile"], "3.12.3");
    let source = worker_support::spool(
        spool.path(),
        "python-source.zip",
        &worker_support::zip_stored(&[("main.py", b"print('ready')\n")]),
    );
    let source_bytes = fs::read(source["path"].as_str().expect("path")).expect("source zip");
    payload["source"] = source;
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("python-build-attempts");
    let cgroups = TempDir::new("python-build-cgroups");
    let toolchain_rootfs = TempDir::new("python-build-toolchain");
    let output_root = TempDir::new("python-build-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    let runner = ScriptedRunner::new(vec![RunnerStep::version("Python 3.12.3"), RunnerStep::succeeded()]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let report = worker.run_once().expect("the build runs").expect("one attempt");
    assert_eq!(report.outcome, "READY");
    assert_eq!(report.bytes, source_bytes.len() as u64);

    let evidence = submitted(&broker);
    assert_eq!(evidence["artifact"]["entrypoint"], "main.py");
    assert_eq!(evidence["artifact"]["digest"], sha256_hex(&source_bytes));
    assert_eq!(evidence["artifact"]["sizeBytes"], source_bytes.len());
    assert_eq!(
        evidence["artifact"]["key"],
        format!(
            "compiled/PYTHON/{manifest_digest}/{}",
            hex(&sha256(format!("PYTHON\n{IMAGE_DIGEST}\n3.12.3\n-m\npy_compile\n").as_bytes()))
        )
    );
    // The staged bytes are the granted source itself, so the gateway can verify them.
    assert_eq!(broker.staged().bytes, source_bytes);
    assert_eq!(broker.staged().chunks, 1);
}

#[test]
fn a_build_claim_that_does_not_match_the_lease_is_refused() {
    let spool = TempDir::new("lease-build-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", "99999999-9999-4999-8999-999999999999"));
    let attempts = TempDir::new("lease-build-attempts");
    let cgroups = TempDir::new("lease-build-cgroups");
    let toolchain_rootfs = TempDir::new("lease-build-toolchain");
    let output_root = TempDir::new("lease-build-output");
    let factory = FakeFactory::new(Vec::new(), Vec::new());
    let runner = ScriptedRunner::new(Vec::new());
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let error = worker.run_once().expect_err("a foreign target must abort");
    assert_eq!(error.code(), "LEASE_MISMATCH");
    assert_eq!(broker.submitted_evidence(), None);
}

#[test]
fn the_build_artifact_key_is_the_one_the_control_plane_recomputes() {
    let spool = TempDir::new("key-spool");
    let payload = with_cpp_assignment(&spool);
    let parsed = parse_build_assignment(&payload).expect("valid build assignment");
    assert_eq!(parsed.language, Language::Cpp);
    let key = artifact_key(parsed.language, &parsed.manifest_digest, &parsed.toolchain);
    assert_eq!(
        key,
        format!(
            "compiled/CPP/{}/{}",
            hex(&parsed.manifest_digest),
            hex(&sha256(format!("CPP\n{IMAGE_DIGEST}\n13.2.0\n-O2\n-std=c++20\n").as_bytes()))
        )
    );
    // A different toolchain never reuses another build's key.
    let mut other = parsed.toolchain.clone();
    other.version = "13.1.0".to_owned();
    assert_ne!(artifact_key(parsed.language, &parsed.manifest_digest, &other), key);
}

#[test]
fn the_production_command_runner_provisions_the_cgroup_and_fails_closed() {
    // The runner must place the runtime inside the delegated cgroup, so the per-attempt child
    // cgroup has to exist before the runtime is spawned. Without a real delegated cgroup the run
    // must fail closed as infrastructure: this host has no cgroup root and no runsc.
    let workspace = TempDir::new("runner-workspace");
    let cgroups = TempDir::new("runner-cgroups");
    let layout = arena_supervisor::materialize::BuildLayout {
        language: Language::Cpp,
        entrypoint: "main.cpp".to_owned(),
        target_id: BUILD_TARGET.to_owned(),
        workspace: workspace.path().clone(),
        output: workspace.path().join("output"),
        toolchain_bundle: workspace.path().join("toolchain.json"),
        compile_bundle: None,
        state: workspace.path().join("state"),
        cgroup: cgroups.path().join(ATTEMPT).join("1"),
    };
    let runner = arena_supervisor::worker::RunscSandboxRunner::new("/nonexistent/runsc");
    let error = runner
        .run(&layout.toolchain_bundle, &layout, Duration::from_secs(5))
        .expect_err("a host without a delegated cgroup cannot run the command");
    let message = error.to_string();
    assert!(!message.is_empty());
    assert!(
        !layout.cgroup.exists(),
        "missing delegated controllers must fail before creating workload leaves"
    );
    assert!(runner.run(&layout.toolchain_bundle, &layout, Duration::from_secs(5)).is_err());
}

#[test]
fn a_refused_build_teardown_quarantines_the_worker() {
    let spool = TempDir::new("teardown-spool");
    let payload = with_cpp_assignment(&spool);
    let broker = FakeBroker::start(claim(payload, "BUILD", BUILD_TARGET));
    let attempts = TempDir::new("teardown-attempts");
    let cgroups = TempDir::new("teardown-cgroups");
    let toolchain_rootfs = TempDir::new("teardown-toolchain");
    let output_root = TempDir::new("teardown-output");
    let factory = FakeFactory::new(vec![Step::Response(READY)], Vec::new());
    factory.fail_teardown();
    let runner = ScriptedRunner::new(vec![
        RunnerStep::version("g++ (GCC) 13.2.0"),
        RunnerStep::Produces(CPP_BINARY.to_vec()),
    ]);
    let worker = cpp_worker(&broker, &attempts, &cgroups, &toolchain_rootfs, &output_root, factory, runner);

    let error = worker.run_once().expect_err("a refused teardown is infrastructure");
    assert_eq!(error.code(), "SANDBOX_TERMINATION_UNCONFIRMED");
    assert!(worker.quarantined(), "a host that may still hold a workload must stop claiming");
    assert_eq!(broker.submitted_evidence(), None);
    assert_eq!(broker.staged().chunks, 0);
    let refused = worker.claim().expect_err("a quarantined worker must not claim");
    assert_eq!(refused.code(), "NODE_QUARANTINED");
}

#[test]
fn a_build_worker_without_its_operator_prerequisites_refuses_to_start() {
    let config = WorkerConfig {
        broker_socket: PathBuf::from("/run/arena/broker.sock"),
        runsc: PathBuf::from("/opt/arena/runsc"),
        runtime_rootfs: PathBuf::from("/opt/arena/rootfs"),
        cgroup_root: PathBuf::from("/sys/fs/cgroup/arena"),
        attempt_root: PathBuf::from("/var/lib/arena/attempts"),
        runtime_profile_digest: "a".repeat(64),
        max_game_slots: 0,
        max_build_slots: 2,
        toolchains: None,
        artifact_output_root: None,
        heartbeat: Duration::from_secs(5),
        poll: Duration::from_secs(1),
        once: true,
    };
    let error = match Worker::with_runner(config, FakeFactory::new(Vec::new(), Vec::new()), ScriptedRunner::new(Vec::new())) {
        Ok(_) => panic!("a build worker must name its toolchains and output root"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "CONFIG_INVALID");
    assert_eq!(worker_support::toolchains().cpp.rootfs, PathBuf::from("/opt/toolchains/cpp"));
    let _ = (ATTEMPT, BUILD_TARGET);
}
