use arena_supervisor::cgroup::{cpu_delta, parse_snapshot};
use std::io::ErrorKind;

#[test]
fn aggregate_cpu_uses_exact_u64_and_strict_budget_boundary() {
    let snapshot = parse_snapshot("usage_usec 9007199254840992\nuser_usec 1\nsystem_usec 2\n", "populated 1\nfrozen 1\n").unwrap();
    assert_eq!(snapshot.usage_usec, 9007199254840992);
    assert!(snapshot.frozen);
    assert!(snapshot.populated);
    assert_eq!(cpu_delta(400, 100400).unwrap(), 100000);
    assert_eq!(cpu_delta(400, 100401).unwrap(), 100001);
}

#[test]
fn counter_rollback_is_infrastructure_error_not_zero_cpu() {
    assert_eq!(cpu_delta(500, 499).unwrap_err().kind(), ErrorKind::InvalidData);
}

#[test]
fn missing_duplicate_or_overflowed_counter_is_not_accepted() {
    for cpu in ["user_usec 1\n", "usage_usec 1\nusage_usec 2\n", "usage_usec -1\n", "usage_usec 18446744073709551616\n", "usage_usec 1 trailing\n"] {
        assert_eq!(parse_snapshot(cpu, "frozen 0\npopulated 0\n").unwrap_err().kind(), ErrorKind::InvalidData);
    }
}

#[test]
fn freezer_and_population_require_unambiguous_boolean_values() {
    for events in ["populated 1\n", "frozen 2\npopulated 1\n", "frozen 0\nfrozen 1\npopulated 1\n"] {
        assert_eq!(parse_snapshot("usage_usec 1\n", events).unwrap_err().kind(), ErrorKind::InvalidData);
    }
}
