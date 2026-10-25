# Integration & Final Quality Delivery Review

**Date:** 2026-10-26  
**Target Workspace:** `/home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2`  
**Branch:** `develop/online-v2-2`  
**Base Commit / Upstream:** `54f51939886355fecc9cfa586c3c705578ffc119` (`origin/develop/online-v2`)  
**Current HEAD:** `27b2a99abf0b0fd44a48f4001437d2b44e382066` (`docs(qa): record browser and backend audit reports with verification evidence`)  
**Remotes:** `origin https://github.com/HaThaiCT/OanTuTiGame.git (fetch/push)`  
**Status:** Ready for Parent Commit Authorization — No commits or pushes performed.

---

## 1. Branch Ancestry & Exact Pending Changes

### 1.1 Branch Remote Topology
- `develop/online-v2-2` branch HEAD is `27b2a99`, exactly 1 commit ahead of `origin/develop/online-v2` (`54f5193 fix(web): preserve tournament returnTo on guest registration login CTA`).
- Working tree preserves baseline commit `27b2a99` and all user-owned modifications.

### 1.2 Exact Scoped Changes
```text
Modified files:
  QA_AUDIT_REPORT.md                          (+/- updated fresh backend and frontend contrast verification)
  docs/qa/2026-10-23-backend-audit.md         (+/- reconciled backend execution matrix and HTTP receipts)
  packages/server/src/ratings/routes.ts       (1-line guard against undefined db error code)
  packages/web/app/tournaments/[id]/page.tsx  (1-line inline style color override for active tab)

Untracked files & evidence directories:
  docs/qa/2026-10-23-backend-evidence/gated-suites-fixed/   (vitest logs, exit 0 for 5 migration suites)
  docs/qa/2026-10-23-backend-evidence/gated-suites/         (pre-fix vitest logs, exit 1 failure evidence)
  docs/qa/2026-10-23-backend-evidence/post-fix-fresh/       (fresh clean-DB npm test log, 734 passed, exit 0)
  docs/qa/2026-10-23-backend-evidence/post-fix/             (reused-DB fixture log, server typecheck exit 0)
  docs/qa/2026-10-23-backend-evidence/rating-http-fixed.json(native TCP smoke 409 RATING_PAGE_STALE receipt)
  docs/qa/2026-10-23-browser-evidence/registration-fixed-light-1440-axe.json (axe 0 violations, contrast 6.43:1)
  docs/qa/2026-10-23-browser-evidence/registration-stable-light-1440-fixed.png (rendered 1440px light screenshot)
  docs/qa/delivery-status.md                  (initial workstream delivery snapshot)
  docs/qa/evidence-review.md                  (independent hygiene and evidence audit)
  docs/qa/integration-review.md               (this final integration report)
```

---

## 2. Root Cause Analysis & Implemented Fixes

### 2.1 Backend Rating Route Code Guard
- **File:** `packages/server/src/ratings/routes.ts:52`
- **Issue:** When database/domain error causes had `'code' in cause` with an undefined value, `String(cause.code)` produced string `"undefined"`. While HTTP 409 status was preserved, the response body returned `code: "undefined"` instead of domain code `"RATING_PAGE_STALE"`. The test failed with `AssertionError: expected 'undefined' to be 'RATING_PAGE_STALE'`.
- **Fix:** Guarded `typeof cause.code === 'string' ? cause.code : ''`.
- **Verification:**
  - Gated suite `packages/server/tests/global-rating-publication.test.ts` changed from failure (`expected 'undefined' to be 'RATING_PAGE_STALE'`) to passing.
  - All 5 gated migration suites passed: 5 test files, 42 tests passed (`gated-suites-fixed/`).
  - Native HTTP loopback request verified: 200 cursor page followed by direct publication generation replacement yielded HTTP 409 `{"code": "RATING_PAGE_STALE", "message": "RATING_PAGE_STALE"}` (`rating-http-fixed.json`).
  - Fresh clean DB full default suite: 120 files passed, 5 skipped; 734 tests passed, 43 skipped, exit 0 (`post-fix-fresh/`).

### 2.2 Frontend Selected Tab Light Mode Contrast Fix
- **File:** `packages/web/app/tournaments/[id]/page.tsx:280`
- **Root Cause (CSS Cascade Layering):**
  - In Tailwind CSS v4 (`@import "tailwindcss"`), utility classes like `text-[var(--action-text)]` reside inside cascade layers (`@layer utilities`).
  - In `packages/web/app/globals.css:124`, `a { text-decoration: none; color: inherit; }` is declared in unlayered CSS.
  - Per CSS Cascading and Inheritance Level 5, unlayered styles take precedence over layered utility classes regardless of selector specificity.
  - Consequently, `<a className="... text-[var(--action-text)]">` inherited the document body's `--text-primary` color (`#0f1923` in light theme), yielding computed foreground `#0f1923` on background `#b91c2c` (contrast ratio **2.75:1**, failing WCAG 2.2 AA 1.4.3 minimum 4.5:1).
- **Fix:** Added targeted inline style on the active tab:
  ```tsx
  style={isActive ? { color: 'var(--action-text)' } : undefined}
  ```
  Inline styles carry specificity (1, 0, 0, 0) and override both unlayered rules and cascade layers locally without introducing global stylesheet regressions.
- **Verification:**
  - `npm run test:web`: 11 test files passed, 35 tests passed (exit 0).
  - Web TypeScript typecheck `npx tsc --noEmit -p packages/web/tsconfig.json`: exit 0.
  - Production build `npm --prefix packages/web run build`: Turbopack build succeeded, exit 0.
  - Rendered preview on local Next.js preview port 15602 backed by an isolated local mock API fixture on port 15603 (mock tournament payload; NOT connected to the demo environment):
    - Light theme element computed styles: foreground `rgb(255, 255, 255)`, background `rgb(185, 28, 44)`.
    - Measured contrast ratio: **6.43:1** (exceeds WCAG 2.2 AA 4.5:1 minimum).
    - Injected axe-core 4.10.2: scoped target node check on the active tab element (`a.bg-[var(--action)]`) passed with 0 violations for rule `color-contrast` (`registration-fixed-light-1440-axe.json`). This is a scoped single-node check, not a full-page scan claim.
    - Visual rendering captured in binary-verified screenshot `registration-stable-light-1440-fixed.png` (PNG image data, 1800 x 1125, magic bytes `89 50 4E 47`). Note on visual proof scope: the screenshot was rendered against the isolated mock fixture API and displays intentional mock messages (e.g. 'Không tải được dữ liệu rating (HTTP 500)'); visual evidence is strictly limited to proving the selected tab element contrast (`#ffffff` on `#b91c2c`), NOT successful domain data journeys or full-page WCAG conformance.
    - Frontend verification command logs and exit codes recorded in `docs/qa/2026-10-23-browser-evidence/` (`web-test.log`, `web-typecheck.log`, `web-build.log`, `web-exits.txt`).
  - Distinction: This fix is active in the local source tree and verified on port 15602 with the local mock fixture. The separate demo container (`172.20.0.3` / `14301`) remains at the pre-fix state until redeployed.

---

## 3. Secrets and Credential Hygiene Scan

- **Scope:** Complete automated regular expression and pattern scan across all 18 new and modified artifacts (`docs/qa/`, `QA_AUDIT_REPORT.md`, `packages/server/src/ratings/routes.ts`, `packages/web/app/tournaments/[id]/page.tsx`).
- **Patterns Checked:** Private keys, AWS keys, JWTs, active session cookies (`oantui_session`), raw passwords, API tokens, connection string passwords.
- **Results:**
  - 0 private keys.
  - 0 live session cookies or bearer tokens.
  - 0 exposed passwords.
  - All request bodies in test receipts use literal redaction markers: `{"password": "[REDACTED]"}`.
  - Ephemeral database credentials used during test listeners were restricted to `/tmp/`, permissioned 0600, and destroyed.
  - No matching credentials, live session cookies, JWTs, or real-user PII were detected in scanned text, JSON, and log files. Screenshot image pixel contents were not subjected to OCR or visual text extraction and remain uninspected by visual/OCR tools; claims apply to textual artifacts only.

---

## 4. Unsupported Claims, Known Gaps & Blockers

1. **Model Attribution:**
   - Previous audit drafts attributed an earlier tournament CTA link fix to `GuestRegistrationCtaFix` / `ag/gemini-3.8-flash-high`. That attribution was unsupported by retained runtime receipts and was formally withdrawn in `QA_AUDIT_REPORT.md`.
   - The current local contrast fix was authored and verified in this session under runner model `9router/ag/gemini-3.8-flash-high`.
2. **Production Readiness Baseline:**
   - `GET /api/health/ready` returns HTTP 503 degraded (`productionReady: false`).
   - Native execution gateway is unconfigured (`executionGateway: false`).
   - Complete authenticated native worker capacity is absent (`workers: false`).
   - Backup freshness enforcement is disabled (`OANTUTI_BACKUP_FENCE=off`).
3. **Database Migration Checksums:**
   - `schema_migrations` records versions 1 through 32 (latest `032-starter-bot-seed-author.sql`).
   - `migration_checksums` contains rows for versions 1 through 30 only; versions 31 and 32 lack recorded checksums in the database.
4. **Environment Separation:**
   - Local workspace fix in `packages/web` is verified locally; the demo environment (`172.20.0.3:3000`) has not been mutated or restarted.
5. **Remaining Scope:**
   - Real sandboxed game compilation and execution across official rounds was not run against native workers.
   - Overall release verdict remains **Incomplete — sampled control-plane paths verified; not execution-ready or production-approved**.

---

## 5. Verification Checklist & Gate Status

| Verification Check | Target | Observed Outcome | Status |
|---|---|---|---|
| Full default test suite | Clean DB `arena_audit_postfix_20261026_test` | 120 files passed, 5 skipped; 734 passed, 43 skipped | **PASS** |
| Gated migration suites | 5 rating/migration test files | 5 files passed, 42 tests passed (exit 0) | **PASS** |
| Native HTTP rating smoke | TCP loopback port | HTTP 409 `RATING_PAGE_STALE` on outdated cursor | **PASS** |
| Server TypeScript check | `packages/server/tsconfig.json` | `tsc --noEmit` exit 0 | **PASS** |
| Web unit test suite | `packages/web` | 11 files passed, 35 tests passed (exit 0) | **PASS** |
| Web TypeScript check | `packages/web/tsconfig.json` | `tsc --noEmit` exit 0 | **PASS** |
| Web production build | `next build` (Turbopack) | Exit 0 | **PASS** |
| Rendered tab contrast | Port 15602 (mock fixture API), stable light mode | Computed 6.43:1 vs 4.5:1 required, scoped axe tab node 0 violations | **PASS** |
| Secrets hygiene | All new/modified text files | 0 matching leaks in scanned text/JSON, literal [REDACTED] only (pixel OCR excluded) | **PASS** |
| Git cleanliness | Branch `develop/online-v2-2` | No commits or pushes performed without authorization | **PASS** |
