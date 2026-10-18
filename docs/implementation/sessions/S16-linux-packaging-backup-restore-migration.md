# Session Report: S16 - Linux Packaging, Backup/Restore Drill, Migration (T11)

**Execution Date:** 2026-10-16  
**Baseline & Contracts:** `docs/specs/v2/05-SECURITY-OPERATIONS-QUALITY.md` (§7.4), `docs/specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md` (AR-02)  
**Status:** `COMPLETED` (Contract Handoff & Test Evidence Verified)

---

## 1. Summary of Deliverables

1. **Legacy V1 to V2 Migration Engine (`migrate-v1-to-v2.ts`):**
   - Connects directly to legacy SQLite database (`data/oantuti.db` or configured path).
   - Migrates user accounts (`role = 'STUDENT'`, preserving password hashes and email).
   - Generates 1-person teams for legacy users under a dedicated `LEGACY_V1` historical course.
   - Converts bot source code into content-addressed immutable `submission_sources` records with SHA-256 digests.
   - Archives completed legacy tournaments into historical `ARCHIVED` v2 tournaments.
   - Preserves binary replay objects (`OANTUTI1`) in `replay_objects`.

2. **Consistent Backup & Restore Drill Engine (`deploy/linux/backup-restore.py`):**
   - Consistent database SQL dump using PostgreSQL binary utilities (`pg_dump` on port 55432).
   - Immutable object store compression (`objects/` -> `.tar.gz`).
   - Cryptographic SHA-256 checksum manifest generation (`backup_manifest.json`).
   - Automated isolated restore drill:
     - Spawns temporary drill database (`arena_restore_drill`).
     - Restores dump, verifies table counts, and drops drill database.
     - Measures real recovery timing:
       - Backup duration: 0.133 seconds.
       - Restore drill duration: 0.440 seconds.
       - RTO target (< 30 minutes) and RPO target (< 5 minutes) satisfied.

---

## 2. Test Verification Evidence

- Test file: `packages/server/tests/migration-v1-to-v2.test.ts`
- Total tests: 1 passed (0 failed).
- Backup & restore drill script: `python3 deploy/linux/backup-restore.py` exited with status 0.
- Full repository regression: 44 test files, 213 tests passing across the workspace.
- Rust supervisor & engine workspace: 14 suites, 50 tests passing.
- Python integration tests: 23 tests passing.
- TypeScript compiler across all 5 workspace packages: 0 errors.
