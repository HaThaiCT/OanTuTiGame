# Evidence Reconciliation & Operational Ground Truth Audit

**Date:** 2026-10-26  
**Workspace:** `/home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2`  
**Branch:** `develop/online-v2-2` (HEAD: `2beb83cdbdfe5ed85e61b4468f647c5eb54bc152`)  
**Auditor:** Active Closure Worker (`closure-evidence`, Gemini 3.8 Flash High)  
**Status:** Ground Truth Reconciled — Unsupported Claims Corrected, Actual Artifacts Grounded, No Shared Mutations Applied.

---

## 1. Executive Summary & Reconciliation Matrix

This document reconciles all evidence claims across the test suites, preview deployment, native sandbox helpers, database backup drills, migration checksum status, and binary artifacts against raw execution outputs.

| Dimension | Previous Unsupported / Unchecked Claim | Reconciled Ground Truth |
| :--- | :--- | :--- |
| **Native Execution** | "Native execution suites passed, units absent consequence" | Standalone sudoers native helpers passed (`smoke-controller`, `smoke-reaper`, `verify-rootfs`, `three-language-match.py`, `trusted-match.py`, `smoke-gvisor.py`). These prove host cgroup and sandbox isolation primitives, **but do NOT constitute official queue execution**; queue ingestion via `packages/server` local job broker from the `jobs` table was not yet executed. |
| **Checksum Baseline** | "32 migrations baselined" (implied global) | Baseline attestation (`--baseline`) was executed **strictly on the disposable test database** (`arena_audit_merge_20261026_test`). The **shared demo database** (`arena` on `oantuti-demo-20261022-postgres`) was untouched; its 30-of-32 checksum gap remains unchanged. |
| **Backup Drill** | "Full database and object store recovery verified" | Database SQL table counts matched (30 migrations, 69 users, 546 teams, 10 tournaments, 8 entries, 3 submissions, 5 starter templates). Restored object archive contained 628 files copied from bundled demo assets (`deploy/demo-data/arena_objects.tar.gz`), matching 100% of the **demo DB** references (616 replays, 12 submissions). However, **0 of 121 ephemeral test replays** and only 3 of 16 test submission sources from the dumped test DB were in the archive. **Relational recovery of the dumped test database was incomplete.** |
| **Archive SHA-256** | Manifest listed erroneous hash `fbeae9bc...` | Actual `/tmp/drill_with_objects/objects.tar.gz` is 243,500 bytes with SHA-256 `67ff2ffe4920f73e4070b62e14f7ba5853ce927adec2b753988ca1b979b5561a`. This is clearly distinct from the sandbox rootfs SHA-256 `63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4`. |
| **Preview Deployment** | Redeployed ports 14301 / 14443 | Verified running: web image `4666d20bf65f`, server image `2f5127fef242`. Served selected registration tab contrast measured at **6.43:1** (computed `#ffffff` on `#b91c2c`, axe 0 violations). |
| **Artifact Validity** | Prior text-path placeholder issue | All **45 PNG screenshots** in `docs/qa/2026-10-23-browser-evidence/` were binary-verified with valid magic bytes (`89 50 4E 47`) and valid dimensions. |
| **Secrets Scan** | Fictitious "AST/OCR scan" claims | Replaced with **real regex token and credential pattern matching** across 84 files; **0 leaked secrets** found. |

---

## 2. Git Status & Workspace Ground Truth

A single read-only Git status check confirms the exact repository state:
```text
$ git status -s
 M QA_AUDIT_REPORT.md
?? docs/qa/2026-10-23-browser-evidence/https-served-preview-registration-light-1440.png
?? docs/qa/2026-10-23-browser-evidence/organizer-create-tournament-1440.png
?? docs/qa/2026-10-23-browser-evidence/organizer-entries-review-1440.png
?? docs/qa/2026-10-23-browser-evidence/organizer-portal-admin-1440.png
?? docs/qa/2026-10-23-browser-evidence/organizer-portal-served-1440.png
?? docs/qa/2026-10-23-browser-evidence/organizer-tournament-detail-1440.png
?? docs/qa/2026-10-23-browser-evidence/served-preview-registration-light-1440.png
?? docs/qa/2026-10-26-browser-closure.md
?? docs/qa/2026-10-26-drill-evidence/
```
- Remote branch synchronization: `develop/online-v2` and `develop/online-v2-2` both point to merge commit `2beb83cdbdfe5ed85e61b4468f647c5eb54bc152`.
- All modifications are uncommitted and scoped strictly to evidence documentation and audit receipts.

---

## 3. Served Preview Deployment Verification

### 3.1 Container Images and Running Services
Containers on network `oantuti-demo-20261022` were verified with zero shared DB or storage mutation:
- **Web Service:** Container `oantuti-qa-web-updated` running image `oantuti-online-v2-web:local` (Image ID `sha256:4666d20bf65f88483b70da79255707cf0f072e18c27b3047cd3d5649855a13e0`), bound to `127.0.0.1:14301->3000/tcp`.
- **Server Service:** Container `oantuti-demo-20261022-server` running image `oantuti-online-v2-server:local` (Image ID `sha256:2f5127fef24239238dd15c981cc2f72b1d0d3d7632a5722d7cfbd6998612154c`), listening on internal port `3001/tcp`.
- **Reverse Proxy:** Container `oantuti-demo-20261022-https` running Nginx, bound to `127.0.0.1:14443->443/tcp`.
- **Shared Postgres:** Container `oantuti-demo-20261022-postgres` (port 5432) remaining in its pre-existing state without mutation.

### 3.2 Served Selected Tab Contrast & Evidence Receipts
- **Target Route:** `/tournaments/9628ef7a-b9e5-404f-8760-40af96c60666?tab=registration` served over HTTP 14301 and HTTPS 14443.
- **Computed Styles:**
  - Foreground color: `rgb(255, 255, 255)` (`#ffffff`) via inline `style={isActive ? { color: 'var(--action-text)' } : undefined}`
  - Background color: `rgb(185, 28, 44)` (`#b91c2c`)
  - Computed Contrast Ratio: **6.43:1** (exceeds WCAG 2.2 AA minimum threshold of 4.5:1).
  - Axe-core check on the active tab element: **0 violations**.
- **Binary Screenshots Grounded:**
  - `docs/qa/2026-10-23-browser-evidence/served-preview-registration-light-1440.png`: 1800×1125, 183,358 bytes, SHA-256 `052c7491fbc6185f0f012218a3c1d0bc86d0f68b771407fc6ec96a0157093546`.
  - `docs/qa/2026-10-23-browser-evidence/https-served-preview-registration-light-1440.png`: 1800×1125, 185,530 bytes, SHA-256 `223152e3c35c8ccdf60f170368facd582b7a6627be32aee897e3d6d83386d824`.

---

## 4. Native Execution & Infrastructure Claims

### 4.1 Host Sandbox Primitives (PASS)
Direct unprivileged `bwrap` returns `Permission denied` due to host kernel user namespace restriction (`/proc/sys/kernel/apparmor_restrict_unprivileged_userns = 1`). Host isolation is mediated through dedicated sudoers helpers:
- `oantuti-dev-helper-v1 verify-rootfs`: 15,030 members verified, archive SHA-256 `63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4`.
- `oantuti-dev-helper-v1 smoke-controller`: Rust cgroup controller executed under systemd-run with user `arena-supervisor`; frozen, unfrozen, zero-descendants transitions confirmed.
- `oantuti-dev-helper-v1 smoke-reaper`: Rust reaper verified SIGKILL signal propagation and process cleanup.
- `three-language-match.py`: Python, C++, TypeScript bots executed in sandbox; decisive 1-ply `THRONE_BREACH` confirmed.
- `trusted-match.py`: Python match executed decisively with reaper verification.
- `smoke-gvisor.py`: gVisor `runsc` sandbox smoke passed.

### 4.2 Queue Integration Distinction (UNRUN)
While standalone helper scripts passed, this tests containment in isolation. It **does NOT constitute official execution gateway or queue worker processing**:
- `packages/server` local job broker was not attached to these helpers.
- Submissions deposited in the `jobs` table were not dispatched through a queue worker in this preview setup.
- Official queue execution remains to be validated on a dedicated isolated application stack.

---

## 5. Migration Checksum Attestation

### 5.1 Disposable Test Database Baseline
- On `arena_audit_merge_20261026_test`, running `apply-migrations.mts --apply --baseline` recorded checksums for all 30 registered migrations and backfilled versions 017 and 018 into `migration_checksums` (total: 32 rows).
- Tool status output confirms: `32 migrations, 0 pending, 0 applied-but-unregistered, EXIT 0`.

### 5.2 Shared Demo Database Status (GAP UNCHANGED)
- On the shared demo database `arena` (`oantuti-demo-20261022-postgres`), `migration_checksums` has exactly 30 rows (versions 001–030).
- Schema migration versions 031 and 032 are applied in `schema_migrations`, but unrecorded in `migration_checksums`.
- **The shared database was not baselined and remains unmutated.**

---

## 6. Backup & Restore Drill Reconciliation

### 6.1 Database Verification (PASS)
- Source test DB: `arena_audit_merge_20261026_test` dumped to `/tmp/backup_drill_20261026.sql` (547,246 bytes, SHA-256 `90267a0b...`) and `/tmp/drill_with_objects/database.sql` (551,617 bytes, SHA-256 `fbacc05b...`).
- Restored to `arena_restore_drill_complete`: all 7 audited tables matched exact row counts.

### 6.2 Object Archive Equality vs. Relational Recovery (INCOMPLETE_RECOVERY)
- **Archive Metrics:** The archived object bundle `/tmp/drill_with_objects/objects.tar.gz` is 243,500 bytes with SHA-256 `67ff2ffe4920f73e4070b62e14f7ba5853ce927adec2b753988ca1b979b5561a` (628 files total).
- **Demo Database Assets (100% Match):**
  - All 616 replay objects referenced by the demo database `arena` matched bit-for-bit with restored files (616 / 616).
  - All 12 submission source archives referenced by the demo database matched with zip integrity verified (12 / 12).
- **Dumped Test Database Discrepancy (Unrecovered References):**
  - `arena_audit_merge_20261026_test` referenced **121 ephemeral test replays** generated during test suite execution. **0 of 121 are present** in the restored object archive.
  - `arena_audit_merge_20261026_test` referenced 16 submission sources. Only 3 (the built-in starter templates) were present; 13 test submissions pointed to ephemeral `/tmp` test fixtures.
- **Verdict:** The drill demonstrated tar archive extraction and SQL table restoration, but does **not constitute full relational recovery** of the dumped test database.

---

## 7. Artifact Integrity & Secrets Scan Verification

### 7.1 Screenshot Binary Validation
All 45 PNG files in `docs/qa/2026-10-23-browser-evidence/` were validated via binary header inspection:
- Magic bytes `89 50 4E 47 0D 0A 1A 0A` confirmed on 100% of files.
- Dimensions confirmed between 390×900 and 1800×4176.
- Zero text placeholder files or corrupted headers.

### 7.2 Secrets Scan Grounding
- **Method:** Real regular expression token pattern matching covering:
  - Private keys (`-----BEGIN ... PRIVATE KEY-----`)
  - AWS tokens (`AKIA...`)
  - GitHub PATs (`ghp_...`)
  - JWT tokens (`eyJ...`)
  - High-entropy password and secret assignments
- **Scope:** 84 files across `docs/qa/` and root QA audit report.
- **Findings:** **0 leaked credentials or tokens.** Prior claims alleging "AST secret scanning" or "OCR screenshot parsing" are rejected as fictitious.

---

## 8. Summary of Hand-off to Isolated Stack Integration

With all evidence claims reconciled and verified against physical disk artifacts:
1. The preview deployment remains active and healthy on HTTP 14301 / HTTPS 14443 with verified 6.43:1 tab contrast.
2. The shared database remains unmutated with its checksum gap documented.
3. The next phase will execute in the same session: constructing a completely fresh isolated database, dedicated storage directory, and application/web instances with `devExecutor: OFF` to perform authentic end-to-end authenticated browser workflows up to the native execution gateway.
