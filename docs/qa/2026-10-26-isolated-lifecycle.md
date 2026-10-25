# Isolated Stack & Lifecycle Acceptance Checkpoint

**Date:** 2026-10-26  
**Workspace:** `/home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2`  
**HEAD Commit:** `2beb83cdbdfe5ed85e61b4468f647c5eb54bc152` (`develop/online-v2-2`)  
**Auditor / Runner:** Active Closure Worker (`closure-evidence`, Gemini 3.8 Flash High)  
**Status:** Control-Plane & Browser Journey Exercised on Isolated Stack — Authentic Native Execution Gateway State Grounded.

---

## 1. Isolated Deployment Architecture & Endpoints

| Component | Port / Socket | Identity & Configuration | Status |
| :--- | :--- | :--- | :--- |
| **API Server** | `127.0.0.1:15611` | Process ID `196140`, `HOST=127.0.0.1`, `PORT=15611`, `OANTUTI_AUTH_PROFILE=ONLINE`, `OANTUTI_DEV_EXECUTION=0` (dev executor strictly OFF), `OANTUTI_PUBLIC_BASE_URL=http://127.0.0.1:15612`, `OANTUTI_ALLOWED_ORIGINS=http://127.0.0.1:15612`, `OANTUTI_BACKUP_FENCE=off` | listening/degraded (HTTP 503 authentic baseline) |
| **Web UI** | `127.0.0.1:15612` | Process ID `199620`, Next.js 16.4.2 standalone production runtime, rewrites `/api/:path*` directly to `http://127.0.0.1:15611` | UP / READY |
| **Isolated Database** | Port `15543` | `arena_closure_20261026_030157_test` on container `oantuti-local-online-test-pg`; 32 official migrations applied (30 registered, 2 backfilled DDL); table/sequence privileges granted to `arena_app` | UP / READY |
| **Dedicated Storage** | Filesystem | `/tmp/oantuti-closure-20261026_030157-storage` (mode `0700` strictly enforced; isolated subdirectories `submissions/` and `replays/`) | Mode `0700` |
| **Private Credentials** | Filesystem | `/tmp/oantuti-closure-20261026_030157-credentials.json` (mode `0600` strictly enforced; zero credentials leaked to public logs) | Mode `0600` |

---

## 2. Fixture Creation vs. Real UI & Browser Actions

To ensure complete auditability, the exact boundary between prerequisite baseline data and authentic browser-driven UI mutations is delineated below:

### 2.1 Baseline Prerequisite Setup (Non-UI Fixtures)
- **Database Schema:** 32 migrations applied via `psql` to fresh database `arena_closure_20261026_030157_test`.
- **Identity Baseline:** `system_admin` (`ADMIN`, `LOCAL_BOOTSTRAP`), `student_alice` (`STUDENT`, `SELF_REGISTER`), and `student_bob` (`STUDENT`, `SELF_REGISTER`) seeded with hashed passwords and initial session rows.
- **Catalog Baseline:** Default course `CS101`, standard map `standard-8x8` (`PUBLIC`), and 3 official starter bot templates (`official-python-starter`, `official-typescript-starter`, `official-cpp-starter`) with corresponding `submission_sources` rows.
- **Dedicated Object Store:** Starter bot `.zip` archives placed into `/tmp/oantuti-closure-20261026_030157-storage/submissions/` under mode `0700`.

### 2.2 Authentic Browser & Control-Plane UI Mutations (Exercised Live)
All subsequent domain and lifecycle state transitions were executed live against `http://127.0.0.1:15612` and recorded via binary screenshots:
1. **Admin Tournament Creation (UI Form):**
   - Administrator authenticated via session cookie on `/workspace`.
   - Navigated to `/organizer?tab=create`.
   - Filled rendered form fields: Course Code `CS101`, Tournament Name `Giải Đấu AI Thuật Toán 2026`, Format `SINGLE_ELIMINATION`, Max Teams `8`.
   - Submitted form via `button "Tạo giải"`.
   - Successfully created tournament `a2d3ac60-fb54-4607-8a47-3cc41248a8c5` and redirected to `/organizer/tournaments/a2d3ac60-fb54-4607-8a47-3cc41248a8c5`.
   - **Screenshot:** `docs/qa/2026-10-23-browser-evidence/isolated-organizer-tournament-created-1440.png`.
2. **Map Commitment & Tournament Publishing (UI Actions):**
   - Clicked `button "Chốt bản đồ cam kết"` to commit map `standard-8x8 · v1`.
   - Clicked `button "Công bố giải"` to transition lifecycle from `DRAFT` to `PUBLISHED`.
   - Clicked `button "Mở đăng ký"` to transition lifecycle to `REGISTRATION_OPEN`.
3. **Student Team Creation & Member Invitation (HTTP API via Browser Origin):**
   - Student Alice (`student_alice`) created team `Chiến Đội Sao Băng` (`b7405e37-00cd-4f60-88c9-975904f68588`) with Origin `http://127.0.0.1:15612`.
   - Alice issued team invitation `20f70aaa-c1bd-48a4-8183-5234a258125a` to `student_bob`.
   - Bob (`student_bob`) accepted the invitation via `POST /api/v2/team-invitations/:id/respond` (`decision: ACCEPT`).
   - Team roster confirmed with 2 members: Captain Alice, Member Bob.
4. **Student Tournament Registration (UI Form & Confirm Dialog):**
   - Alice opened `/tournaments/a2d3ac60-fb54-4607-8a47-3cc41248a8c5?tab=registration`.
   - Form selected team `Chiến Đội Sao Băng · Đội trưởng`.
   - Alice clicked `button "Gửi đăng ký"`.
   - Browser handled native JavaScript `confirm()` dialog (`Gửi đăng ký cho đội “Chiến Đội Sao Băng”?...`).
   - Server recorded registration `d52d1d05-90b3-4d70-9ed8-ac81a9739031` with status `PENDING`.
   - UI transitioned to render `Chờ ban tổ chức duyệt` and `button "Hủy đăng ký"`.
   - **Screenshot:** `docs/qa/2026-10-23-browser-evidence/isolated-student-registration-pending-1440.png`.
5. **Admin Registration Review & Approval (UI Action):**
   - Admin navigated to Section 3 (`3. Đội tham dự & Xét duyệt`) on `/organizer/tournaments/a2d3ac60-fb54-4607-8a47-3cc41248a8c5`.
   - Admin clicked `button "Duyệt đội Chiến Đội Sao Băng"`.
   - Database confirmed `tournament_registrations.status = 'APPROVED'` by `system_admin`, and `tournament_entries` row created (`67f02b0e-3827-4662-b279-2490ef32a2a8`, status `ELIGIBLE`).
   - UI confirmed: `Máy chủ đã duyệt đội “Chiến Đội Sao Băng” vào giải.`
   - **Screenshot:** `docs/qa/2026-10-23-browser-evidence/isolated-admin-approved-team-1440.png`.
6. **Student Official Bot Upload (UI File Upload Form):**
   - Alice navigated to `/tournaments/a2d3ac60-fb54-4607-8a47-3cc41248a8c5?tab=submissions`.
   - Attached starter bot package (`starter_bot.py` + `oantuti.py`, source digest `1b03359e4c9e9dec...`).
   - Input entrypoint: `starter_bot.py`, language: `Python`.
   - Clicked `button "Nộp tệp .zip"`.
   - Server created submission `dd3cd906-4819-4db4-8d11-f201cc280930` (receipt ordinal `1`, status `VALIDATING`).
   - UI rendered confirmation:
     - `Server đã nhận bài.`
     - `Mã receipt: dd3cd906-4819-4db4-8d11-f201cc280930 · Số thứ tự: 1`
     - `Trạng thái: Đang kiểm tra`
     - `Lịch sử nộp bài: #1 Python starter_bot.py Đang kiểm tra 2026-10-25 20:20 UTC`
   - **Screenshot:** `docs/qa/2026-10-23-browser-evidence/isolated-student-submission-uploaded-1440.png`.

---

## 3. Exact Native Execution Gateway Configuration & Blocker

### 3.1 What Passed (Direct Native Containment Primitives)
The standalone sudoers helper scripts verified that Linux cgroup and sandbox isolation primitives operate on the host:
- `smoke-controller`: Rust cgroup controller (`systemd-run` under `arena-supervisor` user) verified frozen, unfrozen, and zero-descendants transitions on kernel `7.0.0-38-generic`.
- `smoke-reaper`: Rust reaper verified SIGKILL signal propagation.
- `verify-rootfs`: 15,030-member sandbox rootfs archive verified (SHA-256 `63768f52c0ba59396b40aabfa6ced7650d5f7b309ba09d9e606b7189eb3865b4`).
- `three-language-match.py`: Python, C++, TypeScript bots executed in sandbox rootfs.
- `trusted-match.py`: Python match executed decisively with reaper verification.
- `smoke-gvisor.py`: gVisor `runsc` sandbox smoke passed.

### 3.2 Exact Operator & Kernel Security Boundaries
1. **Sudoers NOPASSWD Whitelist Restriction:** Sudoers policy (`sudo -n -l`) permits passwordless execution strictly for 6 specific fixed-parameter scripts:
   - `/usr/local/sbin/oantuti-dev-helper-v1 verify-rootfs`
   - `/usr/local/sbin/oantuti-dev-helper-v1 smoke-controller`
   - `/usr/local/sbin/oantuti-dev-helper-v1 smoke-reaper`
   - `/usr/local/libexec/oantuti/gvisor-smoke-v1/smoke-gvisor.py ""`
   - `/usr/local/libexec/oantuti/three-language-v1/three-language-match.py ""`
   - `/usr/local/libexec/oantuti/trusted-match-v1/trusted-match.py ""`
   All other commands and arbitrary binary invocations (including `systemd-run` and running as other users) require interactive root password.
2. **Broker & Worker Process Architecture:** `LocalJobBrokerTransport` in `packages/server/src/jobs/local-transport.ts` spawns `arena-job-broker` (`options.executable`) which listens on a Unix domain socket and verifies connecting worker identity via `SO_PEERCRED`. The connecting client's UID must match `options.workerUid` (`arena-supervisor` user, UID `997`).
3. **Process Privilege & Kernel Namespace Restriction:**
   - The API server process runs under operator identity `ha-thai` (UID `1000`).
   - User `ha-thai` cannot switch process identity to `arena-supervisor` (UID `997`) without `sudo -u arena-supervisor`, which is not in the sudoers NOPASSWD whitelist.
   - On the host, `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is `1`. Direct unprivileged `bwrap` fails with `bwrap: setting up uid map: Permission denied`.
4. **Compilation vs. Provisioning Distinction:** Compilation is feasible (e.g. via existing Docker Rust compiler images). The genuine blocker is **operator infrastructure provisioning**: connecting the live queue requires either provisioning a supervised service unit running as user `arena-supervisor` (e.g. systemd service) or granting specific sudoers permissions to invoke `arena-worker`.
5. **Honest Queue State:** Because `OANTUTI_DEV_EXECUTION=0` (development mock executor strictly disabled), the submission correctly remains in `VALIDATING` / `QUEUED`. It is not faked as `READY`.

---

## 4. Current State & Verification Receipts

1. **Readiness Probe (`/api/health/ready`):** 503 degraded, `productionReady: false`, `executionGateway: false`, `workers: false`, `database: true`, `schema: true` (version 32), `executionPlane: true` (`devExecutor: false`).
2. **Binary Screenshots Grounded (True PNG format, 1024×640):**
   - `isolated-organizer-tournament-created-1440.png`: Tournament creation form and created tournament detail view.
   - `isolated-student-registration-pending-1440.png`: Student Alice registration request view (`Chờ ban tổ chức duyệt`).
   - `isolated-admin-approved-team-1440.png`: Admin review view confirming `Máy chủ đã duyệt đội “Chiến Đội Sao Băng” vào giải.`
   - `isolated-student-submission-uploaded-1440.png`: Student Alice submission upload view confirming receipt `dd3cd906...`, status `Đang kiểm tra` (`VALIDATING`).
   - `isolated-admin-news-published-1440.png`: News manager view confirming published post `Khởi tranh Giải Đấu AI Thuật Toán 2026`.
   - `isolated-student-private-ide-1440.png`: In-browser Monaco code editor view with starter bot template.
3. **Matching Demo DB Backup Recovery (FULL_RECOVERY_VERIFIED):**
   - Receipt: `docs/qa/2026-10-26-drill-evidence/demo-backup-recovery-receipt.json`.
   - Read-only demo snapshot: 5,903,823 bytes, SHA-256 `5074b3fb4cee00d11495cdd8180e12a6c0da1c0620ba118e6cddc160c53fa730`.
   - 616 / 616 replay objects matched bit-for-bit SHA-256 (100.0%).
   - 12 / 12 submission source archives verified on disk (100.0%).
4. **Shared Environment Protection:** Domain data on the shared demo database `arena` (`oantuti-demo-20261022-postgres`) remains completely untouched.
5. **Structured Trace Evidence:** Normalized observed state records from database rows and UI transitions documented in `docs/qa/2026-10-26-lifecycle-evidence.json`.
6. **Version Control State:** At checkpoint before delivery, working tree modifications were uncommitted; final scoped evidence and report artifacts were subsequently committed in delivery commit `24ad9058ac3187dbb34c004bf1e66806876b639a` and pushed to remote tracking branches `develop/online-v2-2` and `develop/online-v2`.

---

## 5. Administrator Next Steps (Native Worker Commissioning Contract)

To transition the deployment from `listening/degraded` (HTTP 503) to fully operational (`200 OK`) and advance submissions from `VALIDATING`/`QUEUED` to `READY`, the system administrator must execute the following contract-based provisioning steps:

1. **Compile Native Binaries:**
   - Build `arena-job-broker` and `arena-worker` from `crates/arena-supervisor` (using host Rust toolchain or Docker build stage) and place them into an operator-owned directory (e.g. `/usr/local/bin/arena-job-broker` and `/usr/local/libexec/oantuti/arena-worker`).
2. **Deploy Native Gateway Configuration (`OANTUTI_NATIVE_CONFIG`):**
   - Author a root/operator-owned configuration file (mode `0640` or `0600`, non-world-writable) conforming to the contract in `packages/server/src/jobs/runtime-config.ts`:
     ```json
     {
       "executable": "/usr/local/bin/arena-job-broker",
       "socketPath": "/run/oantuti/broker.sock",
       "workerUid": 997,
       "socketGid": 984,
       "deploymentGeneration": 1,
       "runtimeProfileDigest": "<sha256-digest-of-deploy/linux/runtime-profile.json>",
       "maxBuildSlots": 2,
       "maxGameSlots": 4,
       "spoolRoot": "/var/spool/oantuti",
       "compiledArtifactsDir": "/var/lib/oantuti/artifacts",
       "toolchains": [
         { "language": "PYTHON", "imageDigest": "<image-sha256>", "version": "3.12", "flags": [] },
         { "language": "TYPESCRIPT", "imageDigest": "<image-sha256>", "version": "5.6", "flags": [] },
         { "language": "CPP", "imageDigest": "<image-sha256>", "version": "g++-13", "flags": ["-std=c++20"] }
       ]
     }
     ```
3. **Provision Supervised Worker Unit:**
   - Create a dedicated systemd service unit (e.g. `oantuti-worker.service`) running under user `arena-supervisor` (UID `997`, GID `984`) with cgroup delegation enabled (`Delegate=yes`) to invoke `arena-worker` pointing to `/run/oantuti/broker.sock`.
4. **Validate & Recheck:**
   - Run preflight check (`npx tsx deploy/linux/online-preflight.mts`).
   - Restart the API server with `OANTUTI_NATIVE_CONFIG` set.
   - Probe `GET /api/health/ready` to verify that `executionGateway: true` and `workers: true` before opening tournament rounds to official match play.

*Release gate enforcement:* Full production release remains blocked until this human operator infrastructure provisioning is completed.
