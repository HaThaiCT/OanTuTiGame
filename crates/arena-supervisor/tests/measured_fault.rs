use arena_supervisor::sandbox::{MeasuredBotFault, MeasuredFaultKind};
mod worker_support;
use arena_supervisor::worker::{Exchange, Workload, WorkloadFactory, Worker};
use arena_supervisor::{materialize::BotLayout, sandbox::Budgets};
use worker_support::{assignment, claim, config, FakeBroker, TempDir, GAME, READY};
use std::io;

#[test]
fn measured_faults_retain_their_counters_in_typed_errors() {
    for kind in [MeasuredFaultKind::CpuTimeout, MeasuredFaultKind::WallTimeout,
        MeasuredFaultKind::OutputLimit, MeasuredFaultKind::ProtocolViolation] {
        let error = std::io::Error::other(MeasuredBotFault { kind, cpu_usec: 500_001, wall_usec: 1_000_001 });
        let measured = error.get_ref().unwrap().downcast_ref::<MeasuredBotFault>().unwrap();
        assert_eq!(measured.kind, kind);
        assert_eq!(measured.cpu_usec, 500_001);
        assert_eq!(measured.wall_usec, 1_000_001);
    }
}

struct FaultFactory(MeasuredFaultKind);
struct FaultWorkload { kind: MeasuredFaultKind }
impl WorkloadFactory for FaultFactory {
    fn launch(&self, _: &BotLayout, _: &str, _: Budgets) -> io::Result<Box<dyn Workload>> {
        Ok(Box::new(FaultWorkload { kind: self.0 }))
    }
}
impl Workload for FaultWorkload {
    fn exchange(&mut self, _: &[u8], startup: bool) -> io::Result<Exchange> {
        if startup { return Ok(Exchange { response: READY.as_bytes().to_vec(), cpu_usec: 100, wall_usec: 200 }); }
        Err(io::Error::other(MeasuredBotFault { kind: self.kind, cpu_usec: 500_001, wall_usec: 1_000_001 }))
    }
    fn stop(&mut self) -> io::Result<()> { Ok(()) }
}

#[test]
fn every_measured_fault_completes_as_a_forfeit_not_an_infrastructure_retry() {
    for kind in [MeasuredFaultKind::CpuTimeout, MeasuredFaultKind::WallTimeout,
        MeasuredFaultKind::OutputLimit, MeasuredFaultKind::ProtocolViolation] {
        let spool = TempDir::new("measured-spool");
        let (payload, _) = assignment(spool.path());
        let broker = FakeBroker::start(claim(payload, "GAME", GAME));
        let attempts = TempDir::new("measured-attempts");
        let cgroups = TempDir::new("measured-cgroups");
        let rootfs = TempDir::new("measured-rootfs");
        let worker = Worker::with_factory(config(broker.socket(), &attempts, &cgroups, &rootfs), FaultFactory(kind)).unwrap();
        let report = worker.run_once().unwrap().unwrap();
        assert_eq!(report.outcome, "BOT_FORFEIT");
        let evidence = broker.submitted_evidence().unwrap();
        assert_eq!(evidence["gameEvidence"]["winner"], 2);
        assert_eq!(evidence["observations"][2]["kind"], kind.observation_kind());
        assert_eq!(evidence["observations"][2]["cpuUsec"], "500001");
        assert_eq!(evidence["observations"][2]["wallUsec"], "1000001");
    }
}
