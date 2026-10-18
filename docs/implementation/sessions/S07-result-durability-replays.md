# Session Report: S07 - Result Durability, FS & Replay Objects (T5)

**Execution Date:** 2026-10-15  
**Baseline & Contracts:** `docs/specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md` (AR-02, TR-08), `docs/specs/v2/05-SECURITY-OPERATIONS-QUALITY.md` (§7.4)  
**Status:** `COMPLETED` (Contract Handoff & Test Evidence Verified)

---

## 1. Summary of Deliverables

1. **Database Schema & Migrations (`004-results.sql`):**
   - `encounters`: Round and slot pairings within a tournament.
   - `games`: Individual game records referencing encounters, maps, rules revision, and status.
   - `replay_objects`: Content-addressed immutable binary storage metadata (SHA-256 digest, size in bytes, total turns).
   - `result_versions`: Append-only, immutable game outcomes (game ID, revision, verdict, winner, reason, disposition, CPU/wall microsecond counters, JSON action trace, and cryptographic digests).
   - `accepted_results`: Canonical atomic pointer mapping `game_id -> result_version_id`, preventing double scoring and providing idempotent re-reads.
   - Applied cleanly to PostgreSQL 16 development database (`arena_development`).

2. **Replay Storage & V2 Wire Format (`ReplayStore`):**
   - Canonical `OANTUTI2` binary header layout with uint32 version, UTF-8 manifest digest, canonical JSON payload (turns and trace), and a trailing 32-byte SHA-256 checksum.
   - Durable two-phase file staging: `stageReplay` writes and executes `fsync` on both the temporary file and parent directory.
   - Atomic promotion: `promoteStagedReplay` validates expected SHA-256 digest, performs atomic filesystem rename into immutable objects store, and executes `fsync` on the target directory.
   - Cryptographic tamper detection: single bit flip or corrupt payload is rejected immediately on deserialize.

3. **Game Trace Verifier (`TraceVerifier`):**
   - Independent engine-level validator using `@oantuti/engine` (`createInitialGameState`, `isLegalMove`, `applyMoveV2`, `evaluateVictoryV2`).
   - Plays each ply sequentially against map topology and starting piece descriptors.
   - Validates that the engine outcome matches claimed winner, reason, and disposition.
   - Rejects illegal moves, side turns out-of-order, and fraudulent claims. Supports early bot forfeits (`BOT_FORFEIT`).

4. **Result Service & Atomic Durable Acceptance (`ResultService`):**
   - `recordResult`: Validates trace, serializes and promotes replay binary, and conducts an atomic PostgreSQL transaction:
     - Locks the target game row (`SELECT ... FOR UPDATE`).
     - Computes next revision (`MAX(revision) + 1`).
     - Inserts record into `replay_objects`.
     - Inserts immutable `result_versions`.
     - Upserts canonical `accepted_results` pointer.
     - Sets `games.status = 'COMPLETED'`.
     - Emits `outbox_events` (`topic = 'GAME_RESULT_ACCEPTED'`) for tournament advancement and standings reduction.
     - Returns typed `AcceptedResultReceipt` with cryptographic digest signature.

5. **REST API Endpoints (`registerResultRoutes`):**
   - `GET /api/v2/games/:id/result`: Returns accepted result DTO.
   - `GET /api/v2/games/:id/replay`: Streams `.oantuti` binary replay with content-type `application/octet-stream`, immutable caching, and ETag digest.
   - `GET /api/v2/replays/:digest`: Direct content-addressed replay stream.

6. **Historical V1 Archive Compatibility:**
   - Legacy `OANTUTI1` replays remain 100% readable via `@oantuti/protocol` (`packReplay`, `unpackReplay`).

---

## 2. Test Verification Evidence

- Test file: `packages/server/tests/results-durability.test.ts`
- Total tests: 11 passed (0 failed).
- Full repository regression: 36 test files, 161 tests passing across the workspace.
