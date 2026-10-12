# Swiss Tournament Engine, C++20 Web IDE & Operator Broadcast Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the final phase of OanTuTi Arena by implementing a multi-round Swiss System tournament pairing engine with bye round handling, C++20 code editing on the Web IDE with automated `g++` compilation diagnostics, an operator broadcast deck with a manual "Next Match" projection button, and a champion trophy celebration ceremony.

**Architecture:** Implement multi-round Swiss pairing in `tournament-service.ts` grouping by score points and avoiding repeat rematches. Extend `BotEditor.tsx` with a third C++20 language tab and compiler diagnostic reporting. Add a tournament queue controller with an operator "Next Match" projector in `LeaderboardView.tsx`, and crown the champion with an animated trophy ceremony.

**Tech Stack:** TypeScript, C++20 (`g++`), Fastify, React 18, Vite, Monaco Editor, Canvas 2D, Web Audio API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-swiss-tournament-cpp-operator.md`

## Global Constraints
- Engine rules ($G=(V, E)$, invariants, combat dominance, 4 victory conditions) must remain 100% intact.
- Existing database schema constraints (`sqlite`) must be preserved without breaking migrations.
- Bot runner must execute C++ binaries with high-resolution 100ms turn enforcement.
- Retain existing progressive logs, Cyberpunk Neon visualizer, hand gestures (✊, ✌️, ✋), and user session persistence.
- Full workspace test suite must maintain 100% pass rate (`npm test`).

## Review Focus
- Swiss pairing must never pair the same two bots twice across multiple rounds in the same tournament.
- Odd number of bots must be granted a single bye (+3.0 pts, 1 win) cleanly without creating invalid match database records.
- C++ compilation failures on the server must return meaningful `stderr` output to the Web Editor rather than crashing or swallowing the error.
- Operator "Next Match" button must cleanly transition match playback on the main Canvas 2D without desynchronizing the playback timeline.
- Champion trophy ceremony must correctly calculate the #1 seed based on points, wins, and ELO, only triggering after the final round completes.

---

### Task 1: C++20 Web Editor Support & Compiler Diagnostic Reporting

**Files:**
- Modify: `packages/web/src/editor/templates.ts`
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/components/BotEditor.tsx`
- Test: `packages/runner/tests/editor-template.test.ts`

**Interfaces:**
- Produces:
  - `CPP_BOT_TEMPLATE: string`
  - `BotLanguage = 'PYTHON' | 'TYPESCRIPT' | 'CPP'`
  - C++ language tab in `BotEditor.tsx`

- [ ] **Step 1: Write failing test verifying C++20 template runs and completes in runner**

Update `packages/runner/tests/editor-template.test.ts` to test `CPP_BOT_TEMPLATE` execution through `MatchOrchestrator`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/runner/tests/editor-template.test.ts`  
Expected: FAIL with "Cannot find name 'CPP_BOT_TEMPLATE'"

- [ ] **Step 3: Export `CPP_BOT_TEMPLATE` and update `client.ts` and `BotEditor.tsx`**

1. In `templates.ts`, export `CPP_BOT_TEMPLATE` implementing clean `oantuti::Bot` logic.
2. In `client.ts`, update `BotLanguage = 'PYTHON' | 'TYPESCRIPT' | 'CPP'`.
3. In `BotEditor.tsx`, add the `[C++]` button in language selector, update Monaco language mode to `'cpp'`, and handle compiler diagnostics on test failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/runner/tests/editor-template.test.ts`  
Expected: PASS (all 3 templates: Python, TS, and C++ pass).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/editor/templates.ts packages/web/src/api/client.ts packages/web/src/components/BotEditor.tsx packages/runner/tests/editor-template.test.ts
git commit -m "feat(web): add C++20 language tab and template in Monaco Bot Editor"
```

---

### Task 2: Multi-Round Swiss System Pairing Algorithm (`tournament-service.ts`)

**Files:**
- Modify: `packages/server/src/tournament-service.ts`
- Test: `packages/server/tests/swiss-pairing.test.ts`

**Interfaces:**
- Produces:
  - `generateSwissPairings(standings: StandingEntry[], previousPairs: Set<string>): { pairings: Pairing[]; byeBotId?: string }`
  - Multi-round tournament execution support in `TournamentService`

- [ ] **Step 1: Write failing unit test for Swiss pairing algorithm**

Create `packages/server/tests/swiss-pairing.test.ts`:
- Asserts round 1 pairs all bots.
- Asserts round 2 pairs winners together and losers together.
- Asserts rematches are prevented.
- Asserts odd bot count assigns one bye (+3.0 pts) without rematching previous bye recipient.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/tests/swiss-pairing.test.ts`  
Expected: FAIL with missing function or incorrect pairing.

- [ ] **Step 3: Implement Swiss pairing and multi-round execution**

In `packages/server/src/tournament-service.ts`:
1. Calculate `totalRounds = Math.max(1, Math.ceil(Math.log2(bots.length)))`.
2. For each round:
   - Compute current standings.
   - Pair bots with closest score points who have not played each other yet.
   - If odd bot count, award bye to the lowest-ranked eligible bot.
   - Execute all matches in the current round sequentially.
3. Save round fixtures and standings into `config_json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/tests/swiss-pairing.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tournament-service.ts packages/server/tests/swiss-pairing.test.ts
git commit -m "feat(server): implement multi-round Swiss System tournament pairing engine"
```

---

### Task 3: Operator Broadcast Deck & "Next Match" Controls (`LeaderboardView.tsx`)

**Files:**
- Modify: `packages/web/src/components/LeaderboardView.tsx`

**Interfaces:**
- Consumes:
  - `TournamentDetailsResponse` from `packages/web/src/api/client.ts`
- Produces:
  - "Next Match" button in active tournament view
  - Current projected match indicator
  - Round-by-round fixture browser

- [ ] **Step 1: Add Next Match operator state and projector in `LeaderboardView.tsx`**

1. Maintain `projectedMatchIndex: number` in `LeaderboardView.tsx`.
2. Render prominent golden button: **"▶ Trận đấu tiếp theo (Next Match)"**.
3. When clicked:
   - Identify the next unfinished match in queue.
   - Invoke `onPlayMatch(match.id)` to load match onto main Canvas.
   - Advance projected index.
4. Render current round indicator and match status tags.

- [ ] **Step 2: Verify component build**

Run: `npm run build --workspace=@oantuti/web`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/LeaderboardView.tsx
git commit -m "feat(web): add operator tournament broadcast deck and Next Match projection button"
```

---

### Task 4: Champion Trophy Celebration Ceremony (`ChampionOverlay.tsx`)

**Files:**
- Create: `packages/web/src/components/ChampionOverlay.tsx`
- Modify: `packages/web/src/components/LeaderboardView.tsx`
- Test: `packages/web/tests/champion-overlay.test.ts`

**Interfaces:**
- Produces:
  - `<ChampionOverlay champion={StandingEntry} runnerUp?: StandingEntry onDismiss={() => void} />`

- [ ] **Step 1: Write failing test for ChampionOverlay**

Create `packages/web/tests/champion-overlay.test.ts` asserting champion name, points, ELO, and trophy markup render cleanly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/champion-overlay.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `ChampionOverlay.tsx`**

Build a celebration overlay with:
- Golden glowing Trophy 🏆 icon with pulsing light.
- "TOURNAMENT CHAMPION" grand title.
- Champion bot card with avatar, points, wins, and ELO.
- Runner-up (#2) and 3rd place honors.
- Confetti burst on mount.
- Dismiss button.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/champion-overlay.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/ChampionOverlay.tsx packages/web/tests/champion-overlay.test.ts packages/web/src/components/LeaderboardView.tsx
git commit -m "feat(web): implement champion trophy celebration ceremony for tournament winners"
```

---

### Task 5: End-to-End Verification & Full Workspace Quality Gate

**Files:**
- Run: Full test suite across all packages (`npm test`).
- Run: Vitest server integration tests.
- Run: Web production build (`npm run build --workspace=@oantuti/web`).
- Run: Live browser verification via headless browser.

- [ ] **Step 1: Run complete workspace test suite**

Run: `npm test`  
Expected: 100% pass across all test files.

- [ ] **Step 2: Verify Web production build**

Run: `npm run build --workspace=@oantuti/web`  
Expected: Clean build without TypeScript or Vite errors.

- [ ] **Step 3: Verify in live browser**

1. Verify C++ tab in Monaco Editor loads C++ template and tests run.
2. Create an automated Swiss tournament with 4 bots.
3. Use "Next Match" button to project matches onto the Canvas.
4. Verify champion ceremony triggers on tournament conclusion.

---

### Task 6: Final Handover, Commit & Push to GitHub

**Files:**
- All modified and newly created files.

- [ ] **Step 1: Verify git status is clean**

Run: `git status`

- [ ] **Step 2: Commit all pending changes**

```bash
git add .
git commit -m "feat(tournament): complete Swiss pairing engine, C++20 Web IDE, and operator broadcast deck"
```

- [ ] **Step 3: Push to GitHub origin main**

```bash
git push origin main
```
