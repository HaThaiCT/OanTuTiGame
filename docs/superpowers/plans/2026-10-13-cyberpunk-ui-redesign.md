# Cyberpunk Neon Battle Arena & UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the OanTuTi Arena Web Visualizer into a high-energy Cyberpunk Neon esports strategy game interface featuring Web Audio sound synthesis, screen-shake impacts, floating combat text, celebration confetti, a 1.5s Versus Intro overlay, Theater/Fullscreen mode, and global keyboard shortcuts.

**Architecture:** Extend the 6-layer Canvas 2D rendering pipeline with screen-shake translation, holographic gridlines, and animated floating combat text. Encapsulate procedural audio synthesis in a zero-asset Web Audio API module (`sound-effects.ts`). Wrap the visualizer in global keyboard controls, a theater layout mode, and a skippable versus intro overlay.

**Tech Stack:** React 18, Vite, TypeScript, Canvas 2D, Web Audio API, Lucide React, `canvas-confetti`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-cyberpunk-ui-redesign.md`

## Global Constraints
- Pure integer deterministic calculations in `@oantuti/engine` must remain untouched.
- Protobuf wire format and `.oantuti` binary replay specifications must remain intact.
- Sound synthesis must use native Web Audio API oscillators/gain nodes without external audio asset downloads so it functions 100% offline and in Docker.
- Retain existing progressive match turn logs, token hand gestures (✊, ✌️, ✋), and Monaco Editor functionality.
- Workspace test suite must stay 100% green (`npm test`).

## Review Focus
- Web Audio context creation must handle browser autoplay policy (suspended until user interaction) without throwing unhandled exceptions.
- Screen-shake and floating combat text must clean up and decay smoothly back to zero without leaking memory or accumulating unbounded arrays.
- Versus Intro Overlay must pause turn playback during its display and automatically dismiss or skip on user click/keypress without desynchronizing replay snapshots.
- Theater Mode must properly expand the Canvas viewport to 100% width while keeping top match telemetry and bottom timeline controls accessible.
- Confetti celebration and victory fanfare must only trigger on decisive wins (`winner !== undefined`), never on draws (`winner === undefined`).

---

### Task 1: Web Audio Procedural Sound Synthesizer (`sound-effects.ts`)

**Files:**
- Create: `packages/web/src/audio/sound-effects.ts`
- Test: `packages/web/tests/sound-effects.test.ts`

**Interfaces:**
- Produces:
  - `soundManager: SoundManager`
  - `soundManager.playMove(): void`
  - `soundManager.playCapture(): void`
  - `soundManager.playVictory(): void`
  - `soundManager.playDraw(): void`
  - `soundManager.playClick(): void`
  - `soundManager.toggleMute(): boolean`
  - `soundManager.isMuted(): boolean`

- [ ] **Step 1: Write the failing unit tests for SoundManager**

Create `packages/web/tests/sound-effects.test.ts` testing sound manager instantiation, mute toggling, localStorage persistence, and calling audio synthesis methods with mock AudioContext.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/sound-effects.test.ts`  
Expected: FAIL with "Cannot find module '../src/audio/sound-effects.js'"

- [ ] **Step 3: Implement `SoundManager` in `packages/web/src/audio/sound-effects.ts`**

Implement `SoundManager` class using native `AudioContext`, custom oscillator nodes (sine and sawtooth), biquad filters, and gain ramps. Guard against suspended audio context with auto-resume on first interaction. Save mute state to `localStorage`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/sound-effects.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/audio/sound-effects.ts packages/web/tests/sound-effects.test.ts
git commit -m "feat(web): implement procedural web audio synthesizer for combat sound fx"
```

---

### Task 2: Screen-Shake, Floating Combat Text & Holographic Canvas FX (`renderer.ts`)

**Files:**
- Modify: `packages/web/src/canvas/renderer.ts`
- Test: `packages/web/tests/combat-effects.test.ts`

**Interfaces:**
- Consumes:
  - `ViewportTransform` from `packages/web/src/canvas/viewport.ts`
  - `RenderState` from `packages/web/src/canvas/renderer.ts`
- Produces:
  - `FloatingCombatText` interface: `{ text: string; x: number; y: number; color: string; alpha: number; yOffset: number; life: number; maxLife: number; }`
  - `addFloatingText(texts: FloatingCombatText[], text: string, screenX: number, screenY: number, color?: string): void`
  - `updateFloatingTexts(texts: FloatingCombatText[]): void`
  - `triggerScreenShake(durationMs?: number, intensity?: number): void`

- [ ] **Step 1: Write the failing tests for floating combat text and screen shake logic**

Create `packages/web/tests/combat-effects.test.ts` asserting creation, upward drift, alpha fade decay, and cleanup of floating text items.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/combat-effects.test.ts`  
Expected: FAIL with missing exports in `renderer.ts`.

- [ ] **Step 3: Update `renderer.ts` with floating text, screen shake, and holographic gridlines**

Add `floatingTexts: FloatingCombatText[]` to `RenderState`. In `renderCanvasFrame`:
1. Apply canvas translation jitter if `screenShakeOffset` is active.
2. Render holographic gridlines in Layer 1 with subtle cyan glow `#06b6d418`.
3. Render Layer 6.5: Floating combat texts above pieces with bold glowing typography.
4. Export helper functions `createFloatingText`, `updateFloatingTexts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/combat-effects.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/canvas/renderer.ts packages/web/tests/combat-effects.test.ts
git commit -m "feat(web): add screen-shake, holographic grid, and floating combat text to canvas renderer"
```

---

### Task 3: Versus Intro Splash Overlay (`VersusOverlay.tsx`)

**Files:**
- Create: `packages/web/src/components/VersusOverlay.tsx`
- Test: `packages/web/tests/versus-overlay.test.ts`

**Interfaces:**
- Produces:
  - `<VersusOverlay whiteBotName={string} blackBotName={string} whiteElo?: number blackElo?: number mapName={string} onDismiss={() => void} />`

- [ ] **Step 1: Write the failing test for VersusOverlay component**

Create `packages/web/tests/versus-overlay.test.ts` checking overlay renders bot names, map name, handles dismiss on click/keypress, and cleans up timers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/versus-overlay.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `VersusOverlay.tsx`**

Build a cyberpunk matchup overlay in `packages/web/src/components/VersusOverlay.tsx` with:
- Centered glowing "VS" badge with golden neon pulse.
- White Bot Card on left with Cyan neon gradient and ✊ emblem.
- Black Bot Card on right with Crimson neon gradient and ✋ emblem.
- Match Map badge at top.
- 1.5s auto-dismiss timer plus click/Escape/Space key dismiss listener.
- Skippable prompt: "Click or press any key to skip".

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/versus-overlay.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/VersusOverlay.tsx packages/web/tests/versus-overlay.test.ts
git commit -m "feat(web): implement 1.5s versus intro splash overlay with skippable action"
```

---

### Task 4: Global Keyboard Controls Hook (`useKeyboardControls.ts`)

**Files:**
- Create: `packages/web/src/hooks/useKeyboardControls.ts`
- Test: `packages/web/tests/keyboard-controls.test.ts`

**Interfaces:**
- Produces:
  - `useKeyboardControls(handlers: { onPlayPause: () => void; onStepPrev: () => void; onStepNext: () => void; onToggleMute: () => void; onToggleTheater: () => void; })`

- [ ] **Step 1: Write failing test for keyboard controls hook**

Create `packages/web/tests/keyboard-controls.test.ts` asserting that `Space` triggers `onPlayPause`, `ArrowLeft` triggers `onStepPrev`, `ArrowRight` triggers `onStepNext`, `KeyM` triggers `onToggleMute`, and `KeyF` triggers `onToggleTheater`, while ignoring keystrokes when typing inside `<input>`, `<textarea>`, or Monaco editor.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/keyboard-controls.test.ts`  
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `useKeyboardControls` hook**

Implement `packages/web/src/hooks/useKeyboardControls.ts` attaching a global `keydown` event listener on `window`. Verify `event.target` is not an active editable input/textarea before invoking callbacks. Prevent default on `Space` to avoid browser page scroll.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/keyboard-controls.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useKeyboardControls.ts packages/web/tests/keyboard-controls.test.ts
git commit -m "feat(web): add global keyboard controls for play, pause, stepping, audio, and theater mode"
```

---

### Task 5: Cyberpunk Header Refit with Audio & Theater Mode Controls (`Header.tsx`)

**Files:**
- Modify: `packages/web/src/components/Header.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes:
  - `soundManager` from `../audio/sound-effects.js`
- Modifies `HeaderProps`:
  - `isMuted: boolean`
  - `isTheaterMode: boolean`
  - `onToggleMute: () => void`
  - `onToggleTheater: () => void`

- [ ] **Step 1: Update Header and App props**

Add mute button (Volume2 / VolumeX icons) and Theater Mode button (Maximize2 / Minimize2 icons) to `packages/web/src/components/Header.tsx`. Apply cyberpunk glassmorphism background with cyan glowing border accents.

- [ ] **Step 2: Build and run web unit tests**

Run: `npm run test:web`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/Header.tsx
git commit -m "feat(web): refit header with cyberpunk aesthetics, volume toggle, and theater mode switch"
```

---

### Task 6: Full Integration: Canvas Audio Triggers, Confetti & Theater Layout (`App.tsx`, `CanvasViewport.tsx`)

**Files:**
- Modify: `packages/web/package.json` (add `canvas-confetti` and `@types/canvas-confetti`)
- Modify: `packages/web/src/components/CanvasViewport.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Integrates `soundManager`, `triggerScreenShake`, `addFloatingText`, `confetti`, `VersusOverlay`, `useKeyboardControls`, and `TheaterMode`.

- [ ] **Step 1: Install `canvas-confetti` dependency**

Run: `npm install --workspace=@oantuti/web canvas-confetti && npm install --workspace=@oantuti/web -D @types/canvas-confetti`

- [ ] **Step 2: Wire combat events in `CanvasViewport.tsx` and `App.tsx`**

1. In `CanvasViewport.tsx`, when `lastMove` changes:
   - If `lastMove.isCapture`, trigger `soundManager.playCapture()`, trigger `triggerScreenShake(250, 4)`, and add floating text `"KILL!"` at target coordinate.
   - Else if ordinary move, trigger `soundManager.playMove()`.
2. When a match ends:
   - If decisive win (`winner !== undefined`), trigger `soundManager.playVictory()` and fire `confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } })`. Add floating text `"VICTORY!"` or `"THRONE BREACH!"`.
   - If draw, trigger `soundManager.playDraw()` and add floating text `"DRAW!"`.
3. In `App.tsx`, integrate `isTheaterMode`:
   - When active, set right panel style to `display: 'none'`, maximizing Canvas to 100% width.
4. Mount `VersusOverlay` when launching a new match or loading a replay for the first time.
5. Hook up `useKeyboardControls` to timeline and header handlers.

- [ ] **Step 3: Build Web and verify full test suite**

Run: `npm run build --workspace=@oantuti/web && npm test`  
Expected: All 14+ test files pass, Web production bundle builds cleanly.

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json packages/web/src/components/CanvasViewport.tsx packages/web/src/App.tsx package-lock.json
git commit -m "feat(web): integrate screen shake, audio triggers, confetti, versus overlay, and theater mode"
```

---

### Task 7: Browser Visual Verification & Quality Review

**Files:**
- Test: browser end-to-end smoke verification using `agent-browser` or direct interaction.

- [ ] **Step 1: Start dev servers and open browser**

Run: Verify `http://localhost:3000` loads properly with the refreshed Cyberpunk styling.

- [ ] **Step 2: Verify all game feel aspects**

1. Launch a match: observe the 1.5s Versus Overlay with White vs Black cards and ELO badges.
2. Observe turn execution: hear procedural move audio, see sliding piece trails, hear capture impact sound, and see `"KILL!"` floating text drift up with screen shake.
3. Observe victory: hear synthwave victory fanfare and see celebration confetti burst.
4. Test Theater Mode toggle (`F` or Header button): verify sidebar hides and canvas expands.
5. Test Mute toggle (`M` or Header button): verify audio toggles cleanly.
6. Test Spacebar and Arrow keys: verify timeline play/pause and step forward/backward.

- [ ] **Step 3: Run full workspace test suite**

Run: `npm test && npm run test:load`  
Expected: 100% green.

- [ ] **Step 4: Final commit and cleanup**

```bash
git add .
git commit -m "chore(web): finalize cyberpunk neon battle arena ui and interactive combat effects"
```
