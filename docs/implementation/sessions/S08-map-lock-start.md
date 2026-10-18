# Session Report: S08 - Map/Version/Lock/Start (T6)

**Execution Date:** 2026-10-15  
**Baseline & Contracts:** `docs/specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md` (§3, §4), `docs/specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md` (§6, §7), `docs/specs/v2/05-SECURITY-OPERATIONS-QUALITY.md`  
**Status:** `COMPLETED` (Contract Handoff & Test Evidence Verified)

---

## 1. Summary of Deliverables

1. **Database Schema & Migrations (`005-maps-and-stages.sql`):**
   - `maps`: Content-addressed / slugged map store with dimensions, descriptors, visibility (`PUBLIC` or `HIDDEN`), validation warnings JSON, and `revealed_at` timestamp.
   - `tournament_map_pool`: Relational join mapping tournaments to map pools.
   - `tournament_entries`: Added `frozen_submission_id` foreign key referencing `submissions(id)`.
   - `tournaments`: Added `locked_at`, `registration_closes_at`, and `appeal_window_minutes`.
   - Applied and verified against PostgreSQL 16.

2. **Map Validation Engine (`MapValidator`):**
   - Strictly enforces map invariants: minimum 3x3 dimensions, max 4096 tiles, throne coordinates within bounds, starting pieces on valid tiles.
   - Implements designer-default warnings (not fairness rejections per specification):
     - `UNBALANCED_PIECES`: flags piece asymmetry between White and Black rosters.
     - `OCCUPIED_THRONE`: flags occupied throne at game start.
     - `DISCONNECTED_TILES`: BFS reachability analysis flagging disconnected components.

3. **Map Service & Visibility Access Control (`MapService`):**
   - `createMap`: Admin-only authoring, records map descriptor and validation warnings.
   - `getMap` / `listMaps`: Enforces `HIDDEN` commitment policy. Students/anonymous actors are strictly denied reading `HIDDEN` maps until `revealed_at` is set (`403 Forbidden`).
   - `addMapToPool`: Associates maps with tournaments.

4. **Tournament Lifecycle Service (`TournamentLifecycleService`):**
   - `TournamentCommands.lock`:
     - Authorized to ADMIN only (`403 Forbidden` for students).
     - Checks that intake submissions have drained (raises `409 INTAKE_DRAINING` if pending compiles exist).
     - Selects the latest valid official submission for each admitted team ordered by `receipt_ordinal DESC` (`status = 'READY'`).
     - Freezes `tournament_entries` (`frozen_submission_id`, `status = 'ELIGIBLE'`).
     - Atomically reveals all `HIDDEN` maps in the tournament map pool (`revealed_at = clock_timestamp()`).
     - Transitions state to `READY_TO_START` and emits outbox event `TOURNAMENT_LOCKED`.
   - `TournamentCommands.start`:
     - Authorized to ADMIN only.
     - Requires state to be `READY_TO_START` and at least 2 eligible teams enrolled.
     - Transitions state to `RUNNING`, sets `started_at`, and emits outbox event `TOURNAMENT_STARTED`.
     - Rejects duplicate start on already running tournaments with `409 Conflict`.

5. **REST API Endpoints (`registerTournamentRoutes`):**
   - `POST /api/v2/organizer/maps`: Admin map creation.
   - `GET /api/v2/maps` and `GET /api/v2/maps/:slug`: Map retrieval with visibility filters.
   - `POST /api/v2/organizer/tournaments/:id/lock`: Lock tournament intake and freeze submissions.
   - `POST /api/v2/organizer/tournaments/:id/start`: Start tournament.

---

## 2. Test Verification Evidence

- Test file: `packages/server/tests/tournament-lifecycle.test.ts`
- Total tests: 10 passed (0 failed).
- Full repository regression: 37 test files, 171 tests passing across the workspace.
