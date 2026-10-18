# Session Report: S11 - Submission & Test Integration (T3b)

**Execution Date:** 2026-10-16  
**Baseline & Contracts:** `docs/specs/v2/01-PRODUCT-REQUIREMENTS.md` (§3, §4), `docs/specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md` (§6, §7), `docs/specs/v2/05-SECURITY-OPERATIONS-QUALITY.md`  
**Status:** `COMPLETED` (Contract Handoff & Test Evidence Verified)

---

## 1. Summary of Deliverables

1. **Database Schema & Migrations (`008-private-tests.sql`):**
   - Extended `test_snapshots` with opponent specifications (`opponent_type`, `opponent_submission_id`), map descriptors, simulation verdict and winner side, failure reasons, total turns, private action trace JSON, build logs, execution logs, and `completed_at` timestamps.
   - Added partial index `idx_test_snapshots_quota` on `(team_id, created_at)` for concurrent/daily quota enforcement.
   - Applied cleanly to PostgreSQL 16.

2. **Private Test Service (`PrivateTestService`):**
   - Implements `TestCommands.create` and `TestQueries.result`:
     - Allows private sandbox tests against `BASELINE_GREEDY`, `BASELINE_RANDOM`, or previous `OWN_SUBMISSION`.
     - Permitted across **all** tournament lifecycle states (DRAFT, REGISTRATION_OPEN, LOCKED, RUNNING, PROVISIONAL, FINALIZED, and ARCHIVED).
     - Strictly enforces quotas: maximum 2 concurrent pending requests, maximum 30 private test runs per day UTC.
     - Simulates test match using `@oantuti/engine` (`applyMoveV2`, `evaluateVictoryV2`), saving private action trace and logs.
     - **Inviolable Invariant Protection:**
       - ZERO mutation of official `submissions` table.
       - ZERO mutation of `receipt_ordinal` or active candidate.
       - ZERO mutation of `tournament_entries.frozen_submission_id`.
       - ZERO mutation of official tournament standings or Elo rating ledger.
     - Strict team-level ACL: only team members and administrators can read private test results, logs, and replays (`403 Forbidden` for non-team students).

3. **Official Intake Cutoff & Fallback Guarantees:**
   - Multi-file ZIP submission verified across all three supported languages (Python, TypeScript, C++20).
   - Strict deadline enforcement: when registration closes (`registration_closes_at`) or when tournament enters `LOCKED`/`RUNNING`/`FINALIZED`, official submissions are rejected (`409 Submissions closed`).
   - New failure fallback: if a newly submitted package fails compilation or smoke testing, the previous valid submission (`status = 'READY'`) retains active candidate status.
   - Lock hash consistency: `tournament_entries.frozen_submission_id` guarantees exact artifact hash preservation across all tournament matches.

---

## 2. Test Verification Evidence

- Test file: `packages/server/tests/submission-test-integration.test.ts`
- Total tests: 8 passed (0 failed).
- Full repository regression: 40 test files, 198 tests passing across the workspace.
- TypeScript compiler across all 5 workspace packages: 0 errors.
- Cargo test on Rust supervisor: 45 passed (0 failed).
- Python integration tests: 23 passed (0 failed).
