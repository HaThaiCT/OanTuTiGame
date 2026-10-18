# Session Report: S10 - Result Correction, Dispute Ledger & Finalization (T7)

**Execution Date:** 2026-10-15  
**Baseline & Contracts:** `docs/specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md` (§4, §6), `docs/specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md` (AR-02, TR-08), `docs/specs/v2/05-SECURITY-OPERATIONS-QUALITY.md`  
**Status:** `COMPLETED` (Contract Handoff & Test Evidence Verified)

---

## 1. Summary of Deliverables

1. **Database Schema & Migrations (`007-disputes-and-corrections.sql`):**
   - `disputes`: Tracks official disputes filed by participants (`OPEN`, `UNDER_REVIEW`, `RESOLVED`, `REJECTED`), storing the reason, adjudicating administrator decision, and timestamps.
   - `result_corrections`: Cryptographically audited ledger of administrative result interventions (`game_id`, `from_result_version_id`, `to_result_version_id`, `action`, `reason`, `authorized_by_user_id`, `preview_digest`, `impact_summary`).
   - `tournaments`: Added `provisional_at` timestamp.
   - Applied and verified against PostgreSQL 16.

2. **Dispute Management Service (`DisputeService`):**
   - `createDispute`: Allows participants (verified team members of the disputed encounter) to file an official appeal. Enforces that tournament must be in `RUNNING` or `PROVISIONAL` state. Emits outbox event `DISPUTE_FILED`.
   - `resolveDispute`: Admin-only adjudication; updates dispute status to `RESOLVED` or `REJECTED` with rationale. Emits outbox event `DISPUTE_RESOLVED`.
   - `listDisputes`: Tournament dispute query API.

3. **Cryptographically Fenced Correction Engine (`CorrectionService`):**
   - `previewCorrection`: Verifies current version matches `expectedRevision`, evaluates blast radius (affected encounters, round rescoring), and generates a cryptographic SHA-256 `previewDigest`.
   - `applyCorrection`: Enforces Admin authorization and verifies `previewDigest` matches recomputed impact. Atomically:
     - Appends an immutable result version to `result_versions` (`verdict = 'NO_CONTEST'`, `revision = nextRevision`).
     - Updates `accepted_results` pointer to the new revision.
     - Logs audit trail in `result_corrections`.
     - Emits outbox event `RESULT_CORRECTED`.
     - Reactively triggers encounter score re-evaluation and standings recomputation through `TournamentSchedulerService`.

4. **Tournament Finalization Gate (`TournamentLifecycleService.finalize`):**
   - Strict gate: tournament must be in `PROVISIONAL` state.
   - Dispute block: strictly checks for unresolved disputes (`OPEN` or `UNDER_REVIEW`). If any exist, blocks finalization with `409 OPEN_DISPUTES_BLOCK_FINALIZATION`.
   - Once all disputes are resolved and appeal criteria are satisfied, transitions state to `FINALIZED`, records `finalized_at`, and emits outbox event `TOURNAMENT_FINALIZED`.

5. **REST API Endpoints (`registerAdjudicationRoutes`):**
   - `POST /api/v2/tournaments/:id/disputes`: File dispute.
   - `GET /api/v2/tournaments/:id/disputes`: List disputes.
   - `POST /api/v2/organizer/disputes/:id/resolve`: Resolve dispute.
   - `POST /api/v2/organizer/games/:id/preview-correction`: Preview correction.
   - `POST /api/v2/organizer/games/:id/apply-correction`: Apply correction.
   - `POST /api/v2/organizer/tournaments/:id/finalize`: Finalize tournament.

---

## 2. Test Verification Evidence

- Test file: `packages/server/tests/corrections-and-finalization.test.ts`
- Total tests: 9 passed (0 failed).
- Full repository regression: 39 test files, 190 tests passing across the workspace.
