# LAN Client-Server Architecture, Role-Based Access Control (Admin/Player) & Anti-Spoiler Tournament Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiplayer tournament hosting across a local area network (LAN) where participants connect from their own browsers to register and submit bot code, while a default seeded Admin organizes the tournament and projects matches without leaking future match outcomes to player screens.

**Architecture:** The Fastify backend and Vite web frontend listen on `0.0.0.0` with dynamic WebSocket/HTTP origin detection. A two-tier RBAC (`ADMIN` and `PLAYER`) seeds a default administrator on database startup and enforces `403 Forbidden` on tournament creation/locking for player accounts. An Anti-Spoiler Gate tracks server-side projection progress (`projectedIndex`) so player screens advance standings and visible match replays in lockstep with the Admin's projector.

**Tech Stack:** Node.js 24, TypeScript 5.7, Fastify 5, SQLite (`node:sqlite`), React 18, Vite 6, Vitest 2.1.

**Spec:** `docs/superpowers/specs/2026-10-13-lan-client-rbac-design.md`

## Global Constraints

- Runtime: Node.js 24.21.0 on Linux x64 with `node:sqlite`.
- All tests must pass: `npm test` must maintain 100% pass rate (currently 100/100 tests).
- Password security: scrypt key derivation with random 16-byte salt via `packages/server/src/auth.ts`.
- Two-tier role enum: `role` must be strictly `'ADMIN' | 'PLAYER'`.
- Default admin credentials: username `admin`, password fallback `admin123` (overrideable via `ADMIN_PASSWORD` env var).
- Zero client-side toolchain requirement: Player clients only need a modern web browser; compilation and execution occur strictly on the host server.
- Source code privacy: `GET /api/bots/:id` and IDE editing endpoints require owner match (`bot.user_id === user.id`); competitor code is never exposed via API.

## Review Focus

1. **Player registration privilege escalation attempt:** A player passing `{ role: 'ADMIN' }` in `POST /api/auth/register` payload must still be assigned role `'PLAYER'`.
2. **Unauthorized tournament lifecycle mutation:** A player invoking `POST /api/tournaments`, `POST /api/tournaments/:id/lock`, or `POST /api/tournaments/:id/project-next` must receive HTTP 403 Forbidden.
3. **Anti-spoiler outcome leakage prevention:** When a tournament completes in background, a player querying `GET /api/tournaments/:id` before matches are projected must only see revealed matches (`index <= projectedIndex`) and standings computed exclusively from those revealed matches.
4. **LAN dynamic host resolution:** WebSocket client connection on web frontend must dynamically construct its URL from `window.location.host` and `window.location.protocol` without hardcoded `localhost:3001`.
5. **Idempotent default admin seeding:** Repeated restarts with persistent SQLite database must not duplicate or corrupt the `usr_admin_default` account.

---

### Task 1: Update Specification Documents (`docs/specs/`)

**Files:**
- Modify: `docs/specs/01-PRD-GDD.md`
- Modify: `docs/specs/02-SYSTEM-ARCHITECTURE.md`
- Modify: `docs/specs/05-DATA-MODELS-DATABASE-SPEC.md`
- Modify: `docs/specs/06-UI-UX-VISUALIZER-SPEC.md`
- Modify: `docs/specs/07-TEST-PLAN-QA-SPEC.md`
- Modify: `docs/specs/08-PROJECT-ROADMAP-WBS.md`
- Test: `tests/specs-validation.test.ts`

**Interfaces:**
- Consumes: Existing spec layout in `docs/specs/`
- Produces: Updated specifications reflecting LAN network model, 2-tier RBAC (`ADMIN` vs `PLAYER`), seeded admin account, and anti-spoiler projection gate.

- [ ] **Step 1: Update `docs/specs/01-PRD-GDD.md`**
Add Section 1.4: "Mô Hình Thi Đấu Mạng Nội Bộ (LAN) & Phân Quyền Người Dùng", documenting the Admin host vs Player participant user journeys.

- [ ] **Step 2: Update `docs/specs/02-SYSTEM-ARCHITECTURE.md`**
Add LAN Network Architecture diagram, `0.0.0.0` binding, client IP dynamic resolution, RBAC authorization layer, and Anti-Spoiler Projection Gate.

- [ ] **Step 3: Update `docs/specs/05-DATA-MODELS-DATABASE-SPEC.md`**
Update `users` table schema with `role TEXT NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('ADMIN', 'PLAYER'))` and seeded admin record `usr_admin_default`. Document `projected_index` tracking in tournament config.

- [ ] **Step 4: Update `docs/specs/06-UI-UX-VISUALIZER-SPEC.md`**
Add UI specifications for Role Badges (`👑 Admin` vs `🎮 Player`), Admin Operator Console (Projector View) vs Player Participant Screen (Registration & Masked Standings).

- [ ] **Step 5: Update `docs/specs/07-TEST-PLAN-QA-SPEC.md` & `08-PROJECT-ROADMAP-WBS.md`**
Add QA test matrix for RBAC security (403 verification, anti-spoiler masking, default admin login) and WBS work package for LAN RBAC.

- [ ] **Step 6: Verify spec integrity test**
Run: `npx vitest run tests/specs-validation.test.ts`
Expected: PASS (all docs present, non-empty, and valid).

- [ ] **Step 7: Commit**
```bash
git add docs/specs/
git commit -m "docs(specs): update specifications for LAN client-server and RBAC architecture"
```

---

### Task 2: Database Schema & Default Admin Seeding (`packages/server/src/db.ts`)

**Files:**
- Modify: `packages/server/src/db.ts:93-102,190-205,234-250`
- Test: `packages/server/tests/db-rbac.test.ts`

**Interfaces:**
- Consumes: `scrypt` hashing via `packages/server/src/auth.ts` or `node:crypto`
- Produces: `ensureAdminUser(passwordHash: string): void`, `updateTournamentProjectedIndex(id: string, index: number): void`, updated `UserRow.role: 'ADMIN' | 'PLAYER'`.

- [ ] **Step 1: Write failing test in `packages/server/tests/db-rbac.test.ts`**
Test that `Database` automatically seeds `admin` user with role `ADMIN`, that `createUser` defaults to role `PLAYER`, and that `updateTournamentProjectedIndex` persists `projectedIndex`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run packages/server/tests/db-rbac.test.ts`
Expected: FAIL (types or methods missing).

- [ ] **Step 3: Implement database updates in `packages/server/src/db.ts`**
1. Update `UserRow` interface: `role: 'ADMIN' | 'PLAYER'`.
2. Update `users` table schema: `role TEXT NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('ADMIN', 'PLAYER'))`.
3. In `initSchema()`: implement `ensureAdminUser(hash)` checking `SELECT id FROM users WHERE username = 'admin'`. If missing, insert `usr_admin_default`, `admin`, `admin@oantuti.arena`, `hash`, role `'ADMIN'`.
4. In `createUser`: ensure `role` defaults to `'PLAYER'`.
5. Add `updateTournamentProjectedIndex(id: string, index: number): void`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run packages/server/tests/db-rbac.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/server/src/db.ts packages/server/tests/db-rbac.test.ts
git commit -m "feat(server): add default admin seed and player role enforcement in db"
```

---

### Task 3: Backend RBAC Authorization & Anti-Spoiler Protection Gate (`packages/server/src/auth.ts`, `app.ts`, `tournament-service.ts`)

**Files:**
- Modify: `packages/server/src/auth.ts:37,59-63,76-87`
- Modify: `packages/server/src/app.ts:184-230`
- Modify: `packages/server/src/tournament-service.ts`
- Test: `packages/server/tests/rbac-authorization.test.ts`

**Interfaces:**
- Consumes: `Database`, `UserRow.role`
- Produces: `AuthService.requireAdmin(request): UserRow`, `POST /api/tournaments/:id/project-next`, Anti-Spoiler masked `GET /api/tournaments/:id`.

- [ ] **Step 1: Write failing tests in `packages/server/tests/rbac-authorization.test.ts`**
1. Test `POST /api/auth/register` ignoring or rejecting incoming `role: 'ADMIN'` and always issuing `'PLAYER'`.
2. Test `POST /api/tournaments` returning 403 Forbidden for `PLAYER`.
3. Test `POST /api/tournaments/:id/lock` returning 403 Forbidden for `PLAYER`.
4. Test `POST /api/tournaments/:id/project-next` returning 403 Forbidden for `PLAYER` and 200 for `ADMIN`.
5. Test `GET /api/tournaments/:id` for `PLAYER` hiding unprojected matches and masking standings to only projected matches.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run packages/server/tests/rbac-authorization.test.ts`
Expected: FAIL (endpoints allow player or `requireAdmin` missing).

- [ ] **Step 3: Implement RBAC in `auth.ts`**
1. Add `requireAdmin(request: FastifyRequest): UserRow` throwing `HttpError(403, 'Forbidden: Admin privilege required')` if `user.role !== 'ADMIN'`.
2. In `registerRoutes`: strip any `role` field from request body; call `db.createUser({ username, email, password_hash: passwordHash, role: 'PLAYER' })`.

- [ ] **Step 4: Implement Anti-Spoiler and Admin routes in `app.ts` & `tournament-service.ts`**
1. Protect `POST /api/tournaments` with `auth.requireAdmin(req)`.
2. Protect `POST /api/tournaments/:id/lock` with `auth.requireAdmin(req)`.
3. Add `POST /api/tournaments/:id/project-next`: validates `auth.requireAdmin(req)`, increments `projectedIndex` in tournament config, returns updated tournament details.
4. Update `GET /api/tournaments/:id`:
   - Inspect request caller via `auth.user(req)`.
   - If user is not `ADMIN`: filter `details.matches` to only include matches where `index <= projectedIndex`. Compute `standings` exclusively from those revealed matches.

- [ ] **Step 5: Run tests to verify they pass**
Run: `npx vitest run packages/server/tests/rbac-authorization.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/server/src/auth.ts packages/server/src/app.ts packages/server/src/tournament-service.ts packages/server/tests/rbac-authorization.test.ts
git commit -m "feat(server): enforce RBAC on tournament endpoints and add anti-spoiler projection gate"
```

---

### Task 4: LAN Host Binding & Dynamic Host Resolution

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/web/vite.config.mts`
- Modify: `packages/web/src/api/client.ts:180-230`
- Test: `packages/server/tests/lan-network.test.ts`

**Interfaces:**
- Consumes: Environment variables (`HOST`, `PORT`), browser `window.location`
- Produces: `HOST=0.0.0.0` listening for Fastify and Vite, dynamic WebSocket URL `ws://${window.location.host}/ws/matches/${matchId}`.

- [ ] **Step 1: Write test in `packages/server/tests/lan-network.test.ts`**
Verify server default binding configuration is `0.0.0.0` and default admin account is seeded upon server initialization.

- [ ] **Step 2: Run test to verify it fails / passes**
Run: `npx vitest run packages/server/tests/lan-network.test.ts`

- [ ] **Step 3: Update `packages/server/src/index.ts` and `vite.config.mts`**
1. In `packages/server/src/index.ts`: ensure `const host = process.env.HOST || '0.0.0.0'`. Compute default admin scrypt password hash if needed on startup.
2. In `packages/web/vite.config.mts`: set `server: { host: '0.0.0.0', port: 3000 }` so any machine on the LAN can reach the Vite dev server.
3. In `packages/web/src/api/client.ts`: verify `createLiveMatchStream` dynamically computes WebSocket protocol and host:
```typescript
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws/matches/${matchId}`;
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run packages/server/tests/lan-network.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/server/src/index.ts packages/web/vite.config.mts packages/web/src/api/client.ts packages/server/tests/lan-network.test.ts
git commit -m "feat(network): configure 0.0.0.0 host binding and dynamic WebSocket origin for LAN access"
```

---

### Task 5: Web UI Role-Based Rendering & Synchronized Projector Operator Deck

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/components/AccountPanel.tsx`
- Modify: `packages/web/src/components/LeaderboardView.tsx`
- Test: `packages/web/tests/rbac-ui.test.tsx` (or Vitest test)

**Interfaces:**
- Consumes: `useSession().user`, `projectTournamentNextMatch(id: string)`
- Produces: Role badge in user header (`👑 Admin` vs `🎮 Player`), conditional rendering of tournament creation and roster lock buttons, synchronized `project-next` trigger.

- [ ] **Step 1: Add client API helper in `packages/web/src/api/client.ts`**
```typescript
export const projectTournamentNextMatch = (id: string) =>
  request<TournamentDetailsResponse>(`/api/tournaments/${id}/project-next`, 'POST', {});
```

- [ ] **Step 2: Update `AccountPanel.tsx` with Role Badges**
Render role badge next to username:
- `user.role === 'ADMIN'`: `👑 Admin` in gold (`#facc15`, bg: `rgba(234, 179, 8, 0.2)`).
- `user.role === 'PLAYER'`: `🎮 Player` in cyan (`#38bdf8`, bg: `rgba(56, 189, 248, 0.2)`).

- [ ] **Step 3: Update `LeaderboardView.tsx` with Role Gates**
1. Check `user?.role === 'ADMIN'`.
2. Hide `+ Create` button when user is not Admin.
3. In tournament detail view:
   - If `role === 'ADMIN'`: show "Chốt danh sách & ghép cặp" (when `PENDING`) and Tournament Operator Deck ("Trận đấu tiếp theo (Next Match)"). Clicking "Next Match" calls `projectTournamentNextMatch(t.id)` to advance server-side projection.
   - If `role !== 'ADMIN'`: hide operator deck and lock buttons. Display Participant Box with bot selector and "Nộp bot tham gia".
   - Standings and Match Fixtures reflect the server-masked anti-spoiler data, so spectators on laptops stay in sync with the projector.

- [ ] **Step 4: Build Web to verify compilation**
Run: `npm run build --workspace=@oantuti/web`
Expected: Build succeeds with zero TypeScript / JSX errors.

- [ ] **Step 5: Commit**
```bash
git add packages/web/src/api/client.ts packages/web/src/components/AccountPanel.tsx packages/web/src/components/LeaderboardView.tsx
git commit -m "feat(web): add role badges and role-based tournament controls with synchronized projection"
```

---

### Task 6: End-to-End Verification Across LAN Workflows

**Files:**
- Test: `packages/server/tests/e2e-lan-rbac.test.ts`
- Documentation: `README.md`

**Interfaces:**
- Consumes: Full stack (Fastify Server, Web build, SQLite database)
- Produces: Verified end-to-end multi-user LAN simulation with role separation and updated README documentation.

- [ ] **Step 1: Write comprehensive end-to-end test in `packages/server/tests/e2e-lan-rbac.test.ts`**
1. Seeded admin `admin / admin123` logs in and creates tournament `LAN Champions 2026` with open registration.
2. Player 1 registers `player1`, logs in, uploads bot, submits bot to `LAN Champions 2026`.
3. Player 2 registers `player2`, logs in, uploads bot, submits bot to `LAN Champions 2026`.
4. Player 1 attempts to lock roster -> receives 403 Forbidden.
5. Admin locks roster -> tournament computes matches.
6. Player 1 queries tournament: matches > `projectedIndex` (0) are hidden, standings only show 0 matches.
7. Admin clicks `project-next` -> `projectedIndex` becomes 1.
8. Player 1 queries tournament: match 1 is now revealed, standings reflect match 1 outcome.
9. Verify clean exit and complete data integrity.

- [ ] **Step 2: Run complete workspace test suite**
Run: `npm test && npm run build --workspace=@oantuti/web`
Expected: All tests pass (including existing 100 tests + all new RBAC tests).

- [ ] **Step 3: Update `README.md` with LAN Hosting & Account Instructions**
Document default admin login (`admin / admin123`), how to access from LAN (`http://<LAN_IP>:3000`), player registration, and projector operation.

- [ ] **Step 4: Commit**
```bash
git add packages/server/tests/e2e-lan-rbac.test.ts README.md
git commit -m "docs & test: add end-to-end LAN RBAC simulation and update README instructions"
```
