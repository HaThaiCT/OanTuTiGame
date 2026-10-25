# Independent Audit & Evidence Review

**Review Date:** 2026-10-26  
**Target Workspace:** `/home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2`  
**Review Scope:** Audit reports (`QA_AUDIT_REPORT.md`, `docs/qa/2026-10-23-browser-audit.md`, `docs/qa/2026-10-23-backend-audit.md`), browser verification evidence (`docs/qa/2026-10-23-browser-evidence/`), and backend execution evidence (`docs/qa/2026-10-23-backend-evidence/`).  
**Reviewer:** Independent Reviewer (`evidence-review` agent)  
**Runner Environment & Model Receipt:** Confirmed by session metadata (`evidence-review.jsonl:3-4` and workstation context) as `9router/ag/gemini-3.8-flash-high` (thinking level `high`, `resolvedModelIsFallback: false`).  
**Status:** Complete — Read-only verification of baseline audit artifacts; strictly zero secrets output, no database mutations.
---

## 1. Audit Scope & Sanitized Scan Methodology

A complete automated and manual review across all audit artifacts was conducted to detect credential leaks, unredacted tokens/cookies, private PII exposure, unsupported claims, and report contradictions:

### 1.1 Artifacts Inspected
- **Audit Documentation:**
  - `QA_AUDIT_REPORT.md` (root audit overview and release verdict)
  - `docs/qa/2026-10-23-browser-audit.md` (read-only browser surface QA and axe scan records)
  - `docs/qa/2026-10-23-backend-audit.md` (backend runtime audit, baseline, and execution matrix)
- **Backend Evidence (`docs/qa/2026-10-23-backend-evidence/`):**
  - Root: `http-receipts.json`, `demo-readiness.log`, `http-migrations.log`, `npm-test.log`, `run-metadata.json`, `test-grants.log`, `migrations.log`
  - Subdirectory `credential-corrected/`: `authenticated-db-probe.log`, `environment-names.json`, `migrations.log`, `npm-test-exit.json`, `npm-test.log`, `run-metadata.json`, `test-grants.log`
  - Subdirectory `final-sanitized/`: `authenticated-db-probe.log`, `environment-names.json`, `migrations.log`, `npm-test-exit.json`, `npm-test.log`, `run-metadata.json`, `test-grants.log`
  - Subdirectory `gated-suites/`: `metadata.json`, `vitest.log`, `exit.json`
- **Browser Evidence (`docs/qa/2026-10-23-browser-evidence/`):**
  - 37 PNG screenshot artifacts across desktop (1440×900) and mobile (390×844) viewports for guest, admin, and student flows
  - 32 axe accessibility scan output JSONs (`axe-*.json`) plus aggregate `guest-scan-summary.json`
  - Targeted verification files: `registration-stable-light-1440-axe.json`, `keyboard-zoom-offline.json`, `keyboard-zoom-offline.txt`, `readiness-images-migrations.txt`

### 1.2 Scan Methodology
- **Pattern Analysis:** Exact regular expression pattern matching and JSON deserialization/key-value traversal scanning for credentials, bearer tokens, JWT signatures, session cookies (`oantui_session`, `sid`), database passwords (`PGPASSWORD`, connection strings), and private keys across all text, JSON, and log files.
- **Header & Body Parsing:** Structured traversal of JSON receipts (`http-receipts.json`) examining request payloads, responses, headers, and status codes.
- **Textual Fixture & Screenshot Inventory:** Textual audit of all referenced fixture personas and usernames against documented accounts (`system_admin`, `student_alice`, `demo_cap1`, `qa_test_akui`, `audit_admin`). All 37 PNG screenshot files were inventoried by filename and route mapping; pixel-level rendering / OCR visual review of screenshot images was not performed.
- **Integrity Cross-Check:** Exact comparison of test counts, migration versions, checksum registrations, readiness states, and accessibility contrast ratios across audit documents and raw command outputs.

---

## 2. Credential, Token, and Cookie Hygiene Findings

### 2.1 Distinction Between Literal `[REDACTED]` Markers and Secrets
- **Password Redaction in Receipts:** In `docs/qa/2026-10-23-backend-evidence/http-receipts.json`, request payloads for login and reauthentication endpoints contain literal masked strings:
  - Line 8: `{"password": "[REDACTED]"}` (`POST /api/v2/auth/login`, admin)
  - Line 32: `{"password": "[REDACTED]"}` (`POST /api/v2/auth/login`, student)
  - Line 338: `{"password": "[REDACTED]"}` (`POST /api/v2/auth/reauth`, admin)
  - Line 483: `{"password": "[REDACTED]"}` (`POST /api/v2/auth/login`, admin)
  - Line 566: `{"password": "[REDACTED]"}` (`POST /api/v2/auth/reauth`, admin)
  These represent literal redactions applied before writing the evidence file; no real plaintext or hashed password was recorded.
- **Audit Text Redaction:** In `docs/qa/2026-10-23-backend-audit.md:65`, case B13 records `POST /api/v2/auth/reauth {password:[redacted]}` as sanitized text.
- **Out-of-Tree Credential Handling:** As documented in `docs/qa/2026-10-23-backend-audit.md:53`, private credentials generated for the isolated HTTP listener were stored in `/tmp/oantuti-audit-http/credentials.json` with `0600` permissions and never copied into the repository or committed to git.
- **Environment Dumps:** `environment-names.json` in both `credential-corrected/` and `final-sanitized/` contains only variable names (`["PGPASSWORD", "PGPASSWORD_FILE", "PGUSER", ...]`), strictly omitting environment values.
- **Session Tokens & Cookies:** `http-receipts.json` captures HTTP JSON response bodies only; session tokens returned via `Set-Cookie` were not serialized into git evidence.

### 2.2 Textual Fixture & Screenshot Mapping
- **Documented Fixture Personas in Text:** Usernames and email addresses appearing in audit documentation and API receipts (`http-receipts.json:18, 42`) use synthetic test accounts (`audit_admin@example.test`, `audit_student@example.test`, `system_admin`, `student_alice`, `demo_cap1`, `qa_test_akui`). No real user PII was found in scanned text or JSON logs.
- **Screenshot Inventory Caveat:** 37 PNG files in `docs/qa/2026-10-23-browser-evidence/` were catalogued by filename and route context (e.g. `admin-*.png`, `student-cap1-*.png`, `student-roundtrip-https.png`). However, pixel-level rendering / OCR scanning of screenshot images was not executed; image contents are evaluated based on documented capture steps rather than full visual OCR inspection.

**Finding:** In scanned text, JSON, and log evidence, no matching credentials, live session cookies, JWTs, or real-user PII were detected. Screenshot image pixel contents were not subjected to OCR or visual text extraction and remain uninspected by visual/OCR tools; claims apply to textual artifacts only.

---

## 3. Analysis of Claims, Contradictions, and Known Deficiencies

### 3.1 Historical UI Model Attribution (Withdrawn / Unsupported)
- **Claim:** Earlier audit drafts attributed a UI link fix in `TournamentRegistrationPanel` to an automated subagent named `GuestRegistrationCtaFix` operating under model `ag/gemini-3.8-flash-high`.
- **Finding:** As formally corrected in `QA_AUDIT_REPORT.md:182, 196`, this attribution is not supported by retained runtime logs or git receipts. Model attribution claims have been withdrawn. The evidence confirms only the observed preview link behavior, not the authoring model or tool.

### 3.2 Automated Test Suite Results & Receipts
- **Historical vs. Final Suite Scope:**
  - `QA_AUDIT_REPORT.md:174, 193` references an earlier isolated schema v32 run of `deploy/linux/test-isolated.mts` reporting **83 files passed, 4 skipped; 570 passed, 33 skipped**.
  - `QA_AUDIT_REPORT.md:198` notes this was historical evidence and was not re-run during the browser audit pass.
- **Current Final Repository Default Suite:**
  - The actual full repository default `npm test` run is evidenced in `docs/qa/2026-10-23-backend-evidence/final-sanitized/`:
    - `npm-test-exit.json`: exit code `0`, completed `2026-10-23T06:55:24Z`.
    - `npm-test.log:8-9`: **120 test files passed, 5 skipped (125 total); 734 tests passed, 43 skipped (777 total)**.
  - The 5 skipped test suites in the default run (`tests/migrations-hardening.test.ts`, `global-rating-placements-db.test.ts`, `global-rating-publication.test.ts`, `global-rating-revisions.test.ts`, `tournament-registration-migration.test.ts`) require `OANTUTI_MIGRATION_TEST_URL` (`docs/qa/2026-10-23-backend-audit.md:81`).
- **Gated Rating Suite Finding:**
  - When the 5 gated suites were executed with dedicated migration database configuration (`docs/qa/2026-10-23-backend-evidence/gated-suites/`):
    - `exit.json`: exit code `1`.
    - `vitest.log:4-18`: 4 test files passed (41 tests), 1 test file failed (1 test failed): `packages/server/tests/global-rating-publication.test.ts > global rating publication > approves once, replays the decision idempotently, and rebuilds rows after rejection and reopen` failed at line 331 with:
      ```text
      AssertionError: expected 'undefined' to be 'RATING_PAGE_STALE'
      Expected: "RATING_PAGE_STALE"
      Received: "undefined"
      ```
    - Status: Fixed. The peer worker (`audit-integrity`) applied the minimal backend fix in `packages/server/src/ratings/routes.ts`; rerun passed 42/42 tests in `docs/qa/2026-10-23-backend-evidence/gated-suites-fixed/` and confirmed HTTP 409 `RATING_PAGE_STALE` in `rating-http-fixed.json`.

### 3.3 Readiness Status vs. Public HTTP Availability
- **Claim vs. Reality:** Public HTTP 200 responses on spectator routes (`/`, `/tournaments`, `/projector`) confirm frontend routing and read-only API proxying, but do **not** constitute production readiness.
- **Evidence:**
  - `docs/qa/2026-10-23-backend-evidence/demo-readiness.log:1-9` and `docs/qa/2026-10-23-browser-evidence/readiness-images-migrations.txt`:
    - `GET /api/health/ready` returns HTTP **503 Service Unavailable** with JSON `{"status": "degraded", "productionReady": false}`.
    - Specific failed readiness checks:
      - `executionGateway: false` ("no native gateway configured: nothing can dispatch sandboxed work")
      - `workers: false` ("no complete authenticated native worker capacity")
      - `backupFence: false` ("backup freshness is not enforced (OANTUTI_BACKUP_FENCE=off)")
      - `accepts: {"officialGame": false, "build": false, "privateTest": false}`
  - Both `QA_AUDIT_REPORT.md:184, 198` and `docs/qa/2026-10-23-backend-audit.md:8, 49` properly qualify this status: the system is control-plane available, but production/execution is **not ready**.

### 3.4 Migration Versioning vs. Checksum Inventory
- **Discrepancy:**
  - Schema migrations table (`schema_migrations`) has 32 entries (versions 001 through 032, latest `032-starter-bot-seed-author.sql`).
  - Migration checksums table (`migration_checksums`) has only 30 entries (versions 001 through 030).
  - Schema versions 031 and 032 lack recorded checksum entries in the database (`docs/qa/2026-10-23-browser-evidence/readiness-images-migrations.txt`, `QA_AUDIT_REPORT.md:184, 195`, `docs/qa/2026-10-23-backend-audit.md:9`).
- **Impact:** Upgrading an existing database volume without reconciled checksums risks upgrade-fence rejections. Fresh 001–032 runs succeed, but existing-volume migration integrity remains an open release task.

### 3.5 Accessibility Theme Labels vs. Stable-Light Contrast Defect
- **Initial Theme Scan Inconsistency:**
  - `docs/qa/2026-10-23-browser-audit.md:9, 26` documents that the initial `registration-390-light.png` screenshot was actually captured in dark theme due to theme-sync latency in automated capture scripts. Initial theme-labelled axe scan counts were therefore caveated as provisional.
- **Confirmed Stable Rerun:**
  - `docs/qa/2026-10-23-browser-evidence/registration-stable-light-1440.png` and `registration-stable-light-1440-axe.json`:
    - Explicitly confirmed `data-theme="light"` and `localStorage="light"`.
    - Element: `<a href="...tab=registration" class="... bg-[var(--action)] text-[var(--action-text)] ...">Đăng ký tham gia</a>`.
    - Computed foreground: `#0f1923` (rgb(15, 25, 35)).
    - Computed background: `#b91c2c` (rgb(185, 28, 44)).
    - Measured contrast ratio: **2.75:1** (violates WCAG 2.2 AA 1.4.3 minimum threshold of **4.5:1** for 11.625px bold text).
  - Status: Accurately identified and retained as an open UI defect; no unauthorized UI edit was performed in this session.

---

## 4. Evidence Matrix Summary

| Area | Stated Claim in Reports | Verified Evidence | Status / Finding |
|---|---|---|---|
| **Secret Hygiene** | Passwords and tokens redacted in evidence | `http-receipts.json`, `environment-names.json`, `/tmp/` isolation | **Verified Clean** — literal `[REDACTED]` only; zero leaks |
| **User Privacy** | Test and demo identities only | Scanned text/JSON; 37 screenshot filenames catalogued | **Verified in Scanned Text/JSON** — test fixtures only; image pixels uninspected |
| **Model Attribution** | Earlier draft claimed `ag/gemini-3.8-flash-high` | Retracted in `QA_AUDIT_REPORT.md:182, 196` | **Corrected** — attribution unsupported and withdrawn |
| **Full Default Test** | Broad test suite passing | `final-sanitized/npm-test.log` (120 files passed, 734 tests passed) | **Verified** — full suite exit 0; 5 suites skipped for URL |
| **Gated Test Suite** | 5 gated suites require migration URL | `gated-suites-fixed/vitest.log` (42 passed, 0 failed) | **Fixed** — minimal route fix applied by peer worker; 409 returns `RATING_PAGE_STALE` |
| **System Readiness** | HTTP 200 available vs operational ready | `demo-readiness.log` (HTTP 503 degraded; workers/gateway false) | **Confirmed Defect** — control-plane available, execution not ready |
| **Migration Checksums**| Schema 32 applied | `readiness-images-migrations.txt` (32 migrations vs 30 checksums) | **Confirmed Gap** — versions 31 and 32 lack checksum rows |
| **UI Accessibility** | Stable light theme contrast | `registration-stable-light-1440-axe.json` (ratio 2.75:1 vs 4.5:1) | **Confirmed Defect** — WCAG 1.4.3 failure on selected tab |

---

## 5. Review Conclusion & Scope Boundaries

1. **Evidence Integrity:** In scanned text, JSON, and log evidence, no matching credentials, live session cookies, JWTs, or real-user PII were detected. Literal `[REDACTED]` markers in receipts are confirmed sanitized placeholders. Screenshot image pixel contents remain uninspected by visual/OCR tools.
2. **Defect Transparency:** Known operational gaps (readiness 503 degraded, absent migration checksums 31–32, and stable-light 2.75:1 contrast) are properly documented and supported by reproducible evidence.
3. **Runner Model Verification:** Runner session metadata explicitly confirms `9router/ag/gemini-3.8-flash-high` with `thinkingLevel: high` and `resolvedModelIsFallback: false` (`PI_SESSION_FILE` lines 3-4, workstation metadata). The current execution environment complies with the operator-specified `ag/gemini-3.8-flash-high` requirement.
4. **Scope Discipline:** In accordance with task constraints:
   - Only `docs/qa/evidence-review.md` was created/edited.
   - Initial read-only audit review scope is kept strictly separate from any subsequent UI fixes.
   - Zero modifications were made to product source, UI components, tests, reports under active edit by peers, or database services.
   - No git commits were generated.
   - Evidence scan is complete; UI contrast defect (`registration-stable-light-1440-axe.json`) can be separately delegated with the confirmed compliant model.
