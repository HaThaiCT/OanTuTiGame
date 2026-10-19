# LAN-first Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement task-by-task. Checkboxes are acceptance work, not claims of completion.

> **Ưu tiên mới nhất:** thực hiện [core UX theo role U0–U5](2026-10-18-core-role-ux-first.md) và người dùng duyệt trước khi triển khai L1–L10. L0 chỉ làm phần kiểm kê/test isolation cần cho UX. Không gian đội thành danh sách giải gọn và trang riêng đội–giải; ADMIN có console giải riêng; Ban tổ chức/official Replay chỉ ADMIN. Chính sách replay công khai cũ phải được sửa ở cả UI/API theo kế hoạch UX, không chỉ ẩn menu. Ngoại lệ private TEST replay cần chốt trước code.

**Goal:** Hoàn tất website thi đấu OanTuTi dùng trong mạng LAN, hoạt động không cần WAN, chạy Bot không tin cậy an toàn, đúng luật, khôi phục được và ổn định; chỉ phát triển ONLINE tiếp sau khi LAN được nghiệm thu và người dùng đồng ý.

**Architecture:** Một máy Linux chạy Next.js/Fastify/PostgreSQL/local durable objects và Rust supervisor. Per-job gVisor cho compiler/Bot, broker Unix socket xác thực UID, Rust là authority xác minh kết quả. Trình duyệt client kết nối qua HTTPS LAN với CA nội bộ; không native desktop/mobile app, không cluster/remote worker bắt buộc.

**Tech Stack:** Existing Next/React/Tailwind, Fastify/TS, PostgreSQL16, Rust/Protobuf, runsc/cgroupv2, SDK Python/TypeScript/C++20; no new infrastructure unless required by the approved baseline.

**Spec:** `../../specs/v2/01-PRODUCT-REQUIREMENTS.md`, `../../specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md`, `../../specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md`, `../../specs/v2/05-SECURITY-OPERATIONS-QUALITY.md`; canonical sessions `2026-10-14-sequential-implementation-sessions.md`; gap inventory `2026-10-18-deferred-deployment-and-remaining-work.md`.

## Global constraints

- User priority: LAN first; ONLINE is deferred, not deleted or silently marked complete. Existing ONLINE code stays regression-safe but no SMTP/provider/public VPS/domain feature development now.
- Planning only in this session. Previous deployment pause remains effective: no host installation, kernel change/reboot, public listener, production migration or enabling external intake without explicit authorization. LAN commissioning below is a future, separately authorized activity, not a loophole around that pause.
- Approved baseline: Ubuntu Server24.04LTS amd64, GA Linux6.8, systemd/cgroupv2, PostgreSQL16, gVisor/runsc. Current host kernel7.0.0-38 is not certified by declaration; inspect actual supported runtime and request an approved baseline change or suitable host if required. Do not downgrade the user's machine automatically.
- LAN does NOT make submitted code trusted. No native/runc/dev-execution fallback; no user code inside API. Missing isolation/readiness means no job claim.
- LAN_OFFLINE: one ADMIN; admin-issued unique temporary passwords + mandatory first change; admin assigns teams and direct-enrolls. No self-registration, shared entry code, SMTP or fake email verification in LAN. Source inspection is submitted work only; private TEST/drafts stay team-only including against ADMIN.
- HTTPS required in LAN, cold clients trust the local CA/SAN. Exact mutation/WS origins; no wildcard credentials or insecure production cookie workaround.
- Match/compile resource limits, quotas, map rules, four tournament formats, frozen receipts and appeal/grace semantics remain the canonical spec. No reduced RR/field size/epochs just to pass a benchmark.
- 500 teams/1000 viewers are targets requiring measured mixed workload, not guaranteed capacity of this laptop. If the selected host cannot support them, stop and obtain a product/hardware decision; do not redefine LAN completion as a smaller demo.
- Release targets remain RPO≤5min, RTO≤30min, 72h soak AND separate 7-day rehearsal. A local second folder is not off-host backup; LAN can use encrypted removable storage always available during competition.
- No destructive data reset, demo-DB suite run, auto `audit fix --force`, push/merge or deployment inferred from approval to write code. Use isolated test DB/object roots.

## Review focus

1. Untrusted Bot survives supervisor death or spoofs worker identity: L2/L3 must reject claims and reap all descendants.
2. Concurrent bootstrap/provision/reset or limited-session request crosses account capacity/ADMIN boundary: L4 transaction tests must enforce invariants.
3. Equal-weight pairing, DQ/rejudge/restore changes champion or ratings nondeterministically: L1/L5 replayable ledger tests and Rust verification must agree.
4. No WAN and cold browser cache breaks Monaco/SDK/WASM/TLS login: L7 tests actual host+clients with WAN denied, not only browser offline simulation.
5. Backup freshness looks healthy before off-host manifest verification, or restore replays accepted jobs: L6/L9 must fence writes and recover exactly once.

## Status and sequencing

All L tasks below start NOT_ACCEPTED. Historical S-session labels and checked todos only prove named dev behavior. Existing code/evidence must be reused, not reimplemented indiscriminately.

Order: L0 → L1; L2 → L3; L4 and L5 can proceed independently after L0; L6 consumes stable result/archive contracts; L7 integrates L3–L6; L8 → L9 → L10. No final acceptance of a consumer before its provider is verified.

| Milestone | Depends on | Deliverable |
|---|---|---|
| M1: LAN feature complete | L0–L5 | Missing logic/security/runtime integration implemented, isolated tests and real sandbox smoke |
| M2: LAN acceptance candidate | L6–L8 | Offline installation workflow, recovery, complete UI journey, security/capacity evidence |
| M3: LAN stable/handed over | L9–L10 | 72h soak + 7-day rehearsal + human sign-off; ONLINE still paused until user says continue |

## L0 — Freeze LAN acceptance inventory and isolated verification

**Files:** update `docs/implementation/rebuild/acceptance-matrix.json`, `execution-context.json`, `progress.md`; inspect `deploy/linux/rebuild-config.mts`, `workspace.schema.json`, `runtime-profile.json`.
**Consumes:** current canonical specs and actual repository evidence, not old capacity/disk summaries.
**Produces:** one LAN acceptance matrix mapping each requirement to code owner, reproducible command/scenario, observed evidence and pending external input.
- [ ] Reconcile stale checklist rows: projector EMPTY, map pools, DQ/autoseal/final TEST already have evidence; keep unresolved tie-break/UID/Rust/mail/archive distinct.
- [ ] Record LAN-only scope and ONLINE deferred. Allocate separate test DB/storage; prove test configuration cannot target demo/production identities/paths before running mutating suites.
- [ ] Inspect host toolchains outside PATH, actual free disk and cgroup/runsc permissions. Produce allowlisted read-only preflight; no privileged changes.
- [ ] Record missing operator inputs for commissioning: target host authorization, LAN CIDR/name, CA trust custodian, external backup device/keys, operator coverage and human reviewers. Missing these must not stop independent code tasks.
**Acceptance:** every LAN spec requirement has an L-task owner; no production-ready claims; test isolation proof and unresolved-host inputs explicit.

## L1 — Exact matching tie-break and final deterministic tournament semantics

**Files:** `packages/server/src/tournaments/formats/{matching,pairing-weights,swiss,elo}.ts`; existing `matching.test.ts`, `exact-pairing.test.ts`, `pairing-blocker.test.ts`, `four-formats.test.ts`; add tie-specific cases there.
**Interface:** preserve `minimumWeightPerfectMatching` return/error contract and injected time budget; no new greedy fallback.
- [ ] Add failing golden cases with several equal-weight optima; assert the lexicographically smallest sorted pair list against an exhaustive small-N oracle, not merely a deterministic output.
- [ ] Implement canonical optimal tie-break while preserving primary objectives and 10s budget, including time spent tie-breaking. Timeout must persist BLOCKED_PAIRING and not partial scheduling.
- [ ] Verify vertex/input permutations, odd bye policy, Swiss rematch priority and Elo encounter counts. Re-run differential checks and N=500 measurement in isolation; no capacity certification from solver alone.
**Acceptance:** oracle agrees on objectives AND tie-break, restart/reordered inputs stable, timeout path unchanged, all four format regressions green.

## L2 — Real sandbox execution substrate, LAN untrusted code boundary

**Files:** `crates/arena-supervisor/src/{sandbox,cgroup,watchdog,reaper,session,control}.rs`, supervisor tests/examples; `crates/arena-runner/src/{session,manifest}.rs`; `deploy/linux/{runtime-profile.json,trusted-oci-spec.py,smoke-gvisor.py,three-language-match.py}` and existing scoped-helper files.
**Interface:** runtime readiness/canaries produce evidence bound to exact host/BOM/profile; no API Docker socket or privileged launcher surface.
- [ ] Reuse existing native watchdog/reaper and scoped launch work. Add failing tests for invalid launch identity/profile, stale session and failed cleanup before changes.
- [ ] Complete compiler/Bot per-job runsc, no-network/rootfs/filesystem/UID/capability/cgroup controls and broker-owned evidence permissions; enforce startup/turn CPU/wall/memory/PID/output/storage budgets from spec.
- [ ] Prove Python/TS/C++ valid starters on min/max requests; CPU loop/sleep/fork/output flood/bad protocol; inactive Bot frozen; supervisor SIGKILL reaped externally; cleanup failure quarantines slot. No secrets readable in sandbox.
- [ ] Run actual negative canaries only on authorized compatible host. If unavailable, mark runtime evidence pending but finish reachable implementation; never substitute native demo smoke.
**Acceptance:** G1 execution evidence includes real limits/freeze/accounting/kill/reaper for 3 languages and profile hashes; unsupported host fails closed.

## L3 — UID-bound broker and Rust authoritative result acceptance

**Files:** `packages/server/src/jobs/{broker,identity,reconciler}.ts`, results `{service,trace-verifier}.ts`, tournaments `{auto-runner,execution-service}.ts`, builds pipelines; `crates/arena-supervisor/src/control.rs`, `crates/arena-runner/src/bin/verify_trace.rs`, `packages/protocol/proto/execution.proto` and contracts/jobs/results. New UDS adapter files stay in jobs/ and supervisor/ following existing boundaries.
**Consumes:** L2 sandbox execution and existing leases/fences/durable completion contract.
**Produces:** broker claim/heartbeat/prepareCompletion/complete channel authenticated by OS peer UID; a single Rust-verified production acceptance path. TS/demo verification cannot remain alternate production authority.
- [ ] Contract tests first: allowed/foreign UID, spoofed body identity, socket permissions, stale fence/generation, lease expiry, oversized/partial frame and replayed completion.
- [ ] Implement peer credential check at a boundary capable of reading real OS credentials; do not trust HTTP headers or caller-supplied UID. Maintain 30s lease/5s heartbeat/reconcile≤10s, priorities and 3 infra attempts/backoff.
- [ ] Wire sandboxed native worker through broker and Rust trace verification. Durable evidence fsync+refs/GC hold BEFORE COMPLETION_PENDING pin; reconciler independent of original worker accepts once with ledger/outbox transaction.
- [ ] Exercise two supervisors, crash at each prepare/promote/commit boundary, lost ack, wrong digest/missing evidence; no double score, champion or rating mutation. Verify same SDK/rules on TS tooling/Rust/WASM without a second acceptance authority.
**Acceptance:** real two-process UDS UID proof plus sandbox game→Rust verify→accept→public replay; stale/foreign worker never commits, missing pinned evidence is integrity incident.

## L4 — Complete LAN accounts, sessions and local recovery

**Files:** identity `{crypto,service,routes}.ts`, `packages/server/src/auth.ts`, persistence migrations (new next numbered migration), teams/admission services; workspace `FirstPasswordChange.tsx`, organizer account controls; existing identity/reauth/bulk/authorization tests. Add a real maintenance CLI under `deploy/linux/`, not the credential-bypass demo helper.
**Known current gaps found during planning:** password helper encodes scrypt while spec requires Argon2id; session constant is 7 days without proof of idle12h/admin12h; bootstrap checks SELECT before INSERT without a visible singleton DB constraint; capacity check occurs before the bulk transaction. These need explicit tests/audit, not an assumption that prior login smoke signed off auth.
- [ ] Add failing tests for simultaneous bootstrap (exactly one ADMIN), provision races at accountCapacity, missing/invalid capacity, cross-course membership, student direct-enroll denied and profile spoofing.
- [ ] Enforce singleton/capacity transactionally. Safe migration: detect duplicate existing ADMIN rows and stop for explicit operator reconciliation; never delete/demote user's accounts silently (test fixtures have previously created duplicates).
- [ ] Implement pinned Argon2id parameters m=64MiB,t=3,p=1/salt≥16 bytes and password12–128 Unicode-character policy. Preserve old hashes only through explicit authenticated rehash-on-login migration, not long-lived alternate APIs; never trim passwords or expose hashes/plaintext.
- [ ] Enforce failed-login limits account10/15min and IP30/15min, idle12h/absolute7days/admin12h, logout/reset/revoke scope checks, limited session change/logout only, reauth≤10min and atomic first change. Verify origin/CSRF and proxy/cookie trust, including LAN NAT workload rather than disabling rate limits.
- [ ] Provide operator-controlled initial ADMIN bootstrap and authorized local recovery: same singleton UUID, random temporary credential delivered once, revoke sessions/tokens, audit OS actor/reason/authorization reference; normal password entry remains secret.
- [ ] Finish organizer bulk account delivery, team assignment/direct enrollment and per-user temp password/first change journey in web UI. LAN has no SMTP or shared-code dependency.
**Acceptance:** fresh and upgraded LAN accounts pass concurrency/security tests; browser first login/reset/revoke works; limited sessions cannot read teams/source/tests; local admin recovery works without WAN and creates no second ADMIN.

## L5 — Archive command and complete correction/dispute/live contracts

**Files:** tournaments lifecycle/routes/scheduler, adjudication services, operations retention, protocol contracts; organizer controls; `live/live-match-hub.ts`, `live-routes.ts`, `LiveViewer.tsx`, replay/bracket/projector components; corresponding existing test suites.
**Interfaces:** add explicit `archive(tournamentId, CommandContext): Promise<Receipt>` to the sole lifecycle owner, routed under organizer commands with existing expectedVersion/idempotency/reauth conventions.
- [ ] Tests first for FINALIZED→ARCHIVED only, role/reauth/version/idempotency, audit/outbox, legal/security/dispute holds. Archive preserves accepted results/replays/source holds; it is not a purge operation.
- [ ] Expose archive in organizer with consequence confirmation. Verify official intake remains closed while team-private TEST remains available in FINALIZED/ARCHIVED without rating/ordinal/frozen side effects.
- [ ] Close corrections/dispute matrix across four formats: stale preview, duplicate apply, descendants played/unplayed, rebracket/dispute linkage, paired rating snapshots, DQ both finalists, no fabricated champion. Replay ledger rebuild after restart matches hashes.
- [ ] Live attempt/generation/seq snapshot validation and forced browser disconnect/reconnect/restart: old attempt cannot repaint authoritative result, slow clients bounded, official RESULT distinct from preview frames. Test actual network interruptions, not projector polling alone.
- [ ] Reconcile explicit brackets-viewer client-only/dispose requirement with current hand-rendered table: implement approved viewer or obtain recorded design amendment; preserve EMPTY/BYE/WALKOVER/DOUBLE_WITHDRAWAL and projector parity.
**Acceptance:** archive usable end-to-end; all format correction and live-recovery cases have evidence; any remaining design-contract deviation is explicit, not a hidden completion exception.

## L6 — Durable LAN data lifecycle and off-host recovery

**Files:** operations `{backup-fence,retention-service,routes}.ts`, durable source/result writers/GC; `deploy/linux/{wal-restore-drill,backup-restore-drill,backup-restore}.py`; migrations and provenance tooling.
**Consumes:** L3 accepted-result authority, L5 archive/hold semantics.
- [ ] Finish complete inventory/checkpoint mutation barrier, fsync references, off-host verification/signature/key custody; `lastSuccessfulConsistentCheckpointAt` must be verified restore-point time, not copy completion.
- [ ] Backup every24h + continuous WAL/archive_timeout60s, checkpoint cadence≤60s, backup35days; never prune referenced objects/keys/WAL chain. App cannot alter audit or protected official evidence.
- [ ] Test lag>5min blocks protected writes/admission/execution/finalization, public reads remain available, resume only on verified healthy checkpoint. Holds beat TTL for TEST/source/replay/diagnostics.
- [ ] Authorized LAN external encrypted device/backup storage drill: base/WAL+objects restored into isolated fresh target; compare accepted ledger/digests/frozen entries/receipts/ratings/holds; new generation fences old jobs; requeue only unaccepted work.
- [ ] Optional v1 import if real migration requested: test against a clone with count/hash/FK/provenance and compatible rollback; never use old SQLite as v2 restore source after accepted v2 writes.
**Acceptance:** real RPO≤5min/RTO≤30min includes operator/key retrieval, corrupted/missing key/objects fail closed; a same-disk dump is partial evidence only.

## L7 — Offline web delivery and authorized LAN commissioning

**Files:** Dockerfiles/compose, Next config/nginx, Linux startup/readiness/preflight/bootstrap/migration tools, docs; existing packaging should be reused, not replaced by a second deploy stack.
**Boundary:** implementation and isolated package checks may proceed; physical network/firewall/CA/service installation requires separate user authorization because deploy is paused.
- [ ] Lock supported versions/digests/SBOM/licensing and prepare install/offline assets (images, runtimes, SDKs, Monaco workers/WASM, source deps) without live registry/CDN calls. No private credentials in bundle.
- [ ] Health/readiness checks cover schema+DB, exact config, sandbox canaries, slots, disk, TLS/clock and off-host backup, not HTTP200 alone. Migrations run under lock/checksum with separate DDL role; no startup fallback to SQLite-only “v2 ready”.
- [ ] Authorize and configure LAN bind/CIDR/hostname/localCA trust, HTTPS-only cookies, exact origins/WS, trusted proxy hops, WAN-deny for host AND clean clients. Preserve needed LAN routes/time source; no automatic firewall changes during planning.
- [ ] Cold-client no-cache no-WAN journey: initial login/password change, provisioning/direct enrollment, Monaco multi-file SDK submit/build, private test, start/live/replay/WASM/standings/projector, dispute/finalize/archive/recovery. A warmed browser offline flag is insufficient.
- [ ] Managed boot/restart after API/DB/supervisor death, readiness degraded notices, local audible/console incident alert with acknowledgement≤5min and operator coverage; no SMTP-only alerts.
**Acceptance:** same local LAN bundle supports fresh authorized host install, no runtime Internet requests, no demo credential defaults, clean browser trust; documented start/stop/update/recover works without author/agent.

## L8 — Integrated LAN security, usability and capacity acceptance candidate

**Files:** existing tests/load/, capacity-probe/soak-probe, server/runner/engine suites, acceptance matrix and report artifacts. New mixed-workload driver in tests/load/ if existing drivers cannot exercise required mix.
- [ ] Run complete TS/Rust/Python/protocol/web-build aggregate checks against isolated data and correct runtime profile; keep command versions/results/digests. Existing count421 pass is history, not a required target count.
- [ ] Independent review/adversarial tests of auth/session/UID/sandbox/source/privacy/ledger/backup; zero unresolved critical/high or integrity/source-leak bypass. Dependency audit findings triaged by actual packaged dependency versions (not assume host audit equals image audit).
- [ ] Mixed500teams/1000viewers compile/official/privateTEST/deadline burst/tie/retry with measured slot/control-plane reserve, CPU overshoot/cold-warm starters, memory/FD/process/storage/WAL growth and NAT limits. Prove declared SLO/ETA for each supported preset incl RR249500 baseline games through traceable measurement/simulation, not fake full execution.
- [ ] Instructor/student walkthrough and owner web UI acceptance with keyboard/screen-reader, helpful errors, no source/secret leakage, real replay explanation. No native app requirement.
**Acceptance:** LAN_RC only when all invariants/SLO pass on declared hardware/BOM and owner/reviewer findings resolved. Underpowered hardware stays BLOCKED_CAPACITY; capacity target changes need user approval.

## L9 — Stability proof: 72h soak and separate 7-day rehearsal

**Consumes:** fixed LAN_RC/BOM from L8; L6 backup + L7 managed operation.
- [ ] Start real-clock72h workload with official/build/privateTEST churn, viewer connect/disconnect, retention/backup rotation and day/quota rollover. Track RSS/FD/process counts/storage/outbox/queue/latency and accepted-ledger invariants.
- [ ] Run separate7-day rehearsal of the intended season with peak workload, overnight/no-admin-tab, scheduled restart/outage/restore and human incident acknowledgement. Keep datasets/probe versions/evidence immutable.
- [ ] Any integrity/isolation/security issue invalidates candidate; fix owning L-task, rerun affected proofs and full endurance when the change invalidates endurance evidence. Do not shorten clocks or sign off from 5-minute probe.
**Acceptance:** both runs finish, no unexplained resource growth/lost jobs/double acceptance, quotas/UTC behavior correct, backup/RPO/RTO/SLO demonstrated, residual findings resolved with reviewer.

## L10 — LAN handover and explicit ONLINE hold

**Deliverables:** final LAN runbook/operator/student guide, release inventory/evidence index, school-owned credential/CA/backup custody, acceptance receipts; no secret values in Git/report.
- [ ] ADMIN/operator/independent reviewer sign LAN G0–G4 against evidence, with target/BOM/digests and exact limitations. All L0–L9 accepted; releaseReady cannot be inferred from Markdown alone.
- [ ] User runs normal operation/recovery from handover guide; receives backups/keys through private custody process and can run without the agent.
- [ ] Record `LAN_COMPLETE_STABLE` only after full acceptance. Mark ONLINE explicitly `DEFERRED_BY_USER`, not a failed LAN dependency.
- [ ] Ask the user whether to begin ONLINE next; only on approval create the ONLINE delta plan (SMTP/email/reset/resend/shared-code, public TLS/domain/VPS hardening, Internet rate abuse, external transport and ONLINE-specific drills). Do not fork game rules/ledger into a separate application.

## Deferred ONLINE scope

Real SMTP/mail consumer/provider delivery and verification/recovery, public self-registration, shared tournament code self-admission, public-domain/VPS release and Internet-specific provider/abuse testing. Preserve existing code but do not require mailbox/VPS purchases to finish LAN. General auth/privacy/isolation/backup correctness is NOT deferred just because ONLINE is paused.

## Completion report format

Each L task records modified files, exact check/scenario, before/after behavior, isolated data roots, evidence artifact, unresolved issue owner and next dependency. Status: NOT_STARTED / IN_PROGRESS / IMPLEMENTED_PENDING_PROOF / ACCEPTED / BLOCKED_EXTERNAL / DEFERRED_ONLINE. Product code absent is not BLOCKED_EXTERNAL. No deployment or release claims unless their actual tests ran.

## Plan validation

Coverage: prior S02/S06/S07→L2/L3; S03 LAN auth gaps→L4; S08/S09→L1/L5; S10/S11 archive/correction→L5; S12/S13/S14→L5/L7/L8; S15 LAN recovery/packaging→L6/L7; S16→L8; S17→L9/L10. ONLINE S04 and shared-code development deferred. Deployment pause reconciled by L7 authorization gate, not ignored. APIs/types cited above preserve current exported contracts except the deliberately new archive command.
