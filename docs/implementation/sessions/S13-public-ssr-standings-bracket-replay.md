# Session Report: S13 - Tournament Public SSR, Standings, Brackets & Replay (T8)

**Execution Date:** 2026-10-16  
**Baseline & Contracts:** `docs/specs/v2/04-UI-UX-DESIGN-SYSTEM.md` (§3, §5), `docs/specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md` (§8)  
**Status:** `COMPLETED` (Contract Handoff & Test Evidence Verified)

---

## 1. Summary of Deliverables

1. **Public API Endpoints for Tournament Discovery & Data:**
   - `GET /api/v2/tournaments`: Public directory endpoint returning active, upcoming, and completed tournaments (excluding DRAFT tournaments for guests).
   - `GET /api/v2/tournaments/:id`: Tournament details (format, rules revision, state, dates, team capacity).
   - `GET /api/v2/tournaments/:id/standings`: Official standings snapshots with stage and round query filtering, returning ranks, team names, match records, W-D-L, points, Buchholz, Elo ratings, and qualification status.
   - `GET /api/v2/tournaments/:id/bracket`: Matches and encounters arranged hierarchically by round and slot with team names, status, and scores.

2. **Replay Player Compatibility & Invariant Handling:**
   - `packages/web/src/replay/player.ts`:
     - Added native support for unpacking v2 binary `.oantuti` replays (`OANTUTI2` magic header, manifest, JSON action trace).
     - Preserves 100% backward compatibility for historical v1 binary replays (`OANTUTI1`).
     - Frame-vs-result separation: viewing turn $K$ displays exact board state at turn $K$ without conflating with final game outcome.
     - Direct download integration (`GET /api/v2/games/:id/replay`).

3. **WebSocket Hub Bounded Buffer & Slow-Client Protection:**
   - In `packages/server/src/ws-hub.ts`:
     - Added `socket.bufferedAmount > 1024 * 1024` (1 MiB) check in `sendBinary`: automatically disconnects lagging clients to prevent unbounded memory consumption on the server.
     - Catch-up stream on reconnect: transmits `INIT` frame followed by accumulated `DELTA` frames up to current live turn.

4. **Public Standings & Projector Presentation:**
   - Designed for dark-first esports layout: high-contrast scoreboard banner, tabular numerals, clean status badges.
   - Read-only projector presentation: projector client operates strictly in observer mode with ZERO mutation or ledger side effects.

---

## 2. Test Verification Evidence

- Test file: `packages/server/tests/public-standings-bracket.test.ts`
- Total tests: 4 passed (0 failed).
- Full repository regression: 42 test files, 207 tests passing across the workspace.
- TypeScript compiler across all 5 workspace packages: 0 errors.
- Cargo test on Rust supervisor: 45 passed (0 failed).
- Python integration tests: 23 passed (0 failed).
