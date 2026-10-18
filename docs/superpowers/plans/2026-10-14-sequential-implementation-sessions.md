# OanTuTi Arena v2 — kế hoạch triển khai theo phiên tuần tự


> **2026-10-17 — SUPERSEDED / NOT_ACCEPTED:** các dấu complete/contract-handoff và report trước rebuild không được kế thừa làm acceptance. Mọi checkbox dưới đây là tiêu chí phải chứng minh lại, không kết quả đã quan sát. S01 đang thực hiện trong workspace rebuild; G0/G1 chưa đóng, G1–G4 vẫn pending. Giữ report gốc làm lịch sử; không đổi số canonical S01–S17 để khớp tên report sai.
> **For agentic workers:** REQUIRED SUB-SKILL khi thực thi: `subagent-driven-development` hoặc `executing-plans`. Đây là lịch chia phiên của kế hoạch T0–T12, không thay baseline hoặc tự xác nhận task đã hoàn tất.

**Goal:** Triển khai từng increment có evidence, tiếp nối được giữa các phiên, đến sản phẩm đủ G0–G4; không bỏ scope khi một phiên bị chặn.
**Architecture:** Một Linux host chạy Next/Fastify/PostgreSQL/local durable objects; Rust engine/native runner/supervisor, cùng Rust engine qua WASM browser. Supervisor qua UID-bound Unix socket, compiler và mỗi Bot gVisor riêng; native runner không đặc quyền, không fallback thực thi Bot native. Không cluster/remote workers/replication hoặc execution VM mặc định.


**Tech Stack:** Ubuntu Server24.04LTS amd64/GA6.8, PostgreSQL16, Fastify/TypeScript, Rust, Node24 baseline, Next/React, Canvas/Monaco, shadcn/Tailwind/brackets-viewer. Exact patches/digests phải resolve và review thực tế, không floating latest.

**Spec:** [Index canonical](../../specs/v2/README.md), [kế hoạch kỹ thuật T0–T12](2026-10-13-production-upgrade.md), [deployment inputs/gates](../../specs/v2/05-SECURITY-OPERATIONS-QUALITY.md). Signatures, test paths và commands dùng đúng contract registry trong kế hoạch kỹ thuật; không định nghĩa API thứ hai ở đây.

## Global Constraints

- Thực hiện S01→S17 lần lượt. Phiên là **đơn vị phạm vi và nghiệm thu**, không hứa mỗi phiên vừa một lượt chat hoặc một ngày. Phiên chưa đạt exit gate tiếp tục cùng số phiên, không báo done hoặc nhảy qua dependency.
- Không deploy public, nhận source không tin cậy hoặc chạy canary thù địch ngoài sandbox trước G1; development fixtures dùng môi trường cô lập, không dữ liệu/service production.
- Giữ đủ bốn format, LAN/ONLINE, mộtADMIN, ba ngôn ngữ multi-file, private tests mọi phase, deadline/drain/frozenBot, public viewer và UI esports đã chốt.
- Designer-defaults/policy IDs và limits theo01/02/05, không chỉnh để tests dễ pass. Rule changes phải revision hợp lệ, không sửa giải đã mở/locked.
- Được reuse code giao diện theo quyền người dùng xác nhận; ghi provenance/notices, không suy quyền với ảnh/logo/font/dependency. Không mua template hoặc thêm Bootstrap/WordPress stack.
- Mỗi phiên: đọc handoff+spec liên quan → kiểm prerequisite → implement smallest complete behavior → targeted checks → smoke thật → review → docs/changelog → handoff. Code/API migration sạch, không shim/stub/mock được gọi là completed deliverable.
- Không destructive migration/deletion/service interference hoặc external side effect nếu chưa có quyền đúng target. Không secret/source/PII trong chat, reports, commits.
- Full suite/build/load tổng hợp ởS16/S17 sau integration; targeted checks theo changed path từng phiên. Smoke UI bằng browser thật, CLI bằng chương trình thật, sandbox bằng Bot thật; tests không thay smoke.

## Review Focus

1. G0 cần inputs nhưng chưa thể có capacity/restore evidence từ code chưa triển khai: tách config completeness và certification, không vòng phụ thuộc — S01/S02/S15/S16.
2. T3 cần T4/T5/T6: T3a chỉ bàn giao contracts/persistence, T3b nghiệm thu thực sau providers — S05→S06→S07→S08/S09→S10.
3. Receipt/cutoff/drain/lost ack có thể khóa sai Bot: regressions + restart smoke — S05/S10.
4. Durable pending completion không được mất evidence sau crash và không double-score: fsync trước pin, independent reconciler — S07/S15.
5. UI/permissions/LANoffline có thể trông đúng nhưng bypass hoặc mất dữ liệu: server checks, cold-browser/offline/private-cache/keyboard proof — S03/S04/S12–S15.

## 1. Thứ tự và ownership

| Phiên | Task gốc | Kết quả bàn giao | Gate trước phiên sau |
|---|---|---|---|
| S01 | T0 | Workspace thực thi, BOM/config inventory, ownership và config gaps chính xác | Config baseline đủ để phát triển cô lập; runtime evidence còn pending được ghi riêng |
| S02 | T1 + Rust delta | Rust engine/native runner/supervisor, sandbox/watchdog/generated IPC thật cho3ngônngữ; native/WASM replay parity **(verified dev host, incl. browser wiring)** | Isolation/accounting/gameplay proof, không unsafe fallback |
| S03 | T2 LAN/core | PostgreSQL/migrations/sessions/oneADMIN/LANaccounts/teams | LAN auth/admission và temporary-password transitions đúng |
| S04 | T2 ONLINE | Verification/reset/mailoutbox/sharedcode và profile isolation | ONLINE real staging mail + LAN không phụ thuộcSMTP |
| S05 | T3a | Immutable source/project receipts/quotas/ACL/manifests | Handoff contracts/schema; **T3 chưa complete** |
| S06 | T4 | Durable dispatcher/lease/fencing/restart/admission | Jobs chạy/resume trên local processes không doubleclaim |
| S07 | T5 | Native trace verifier, một result acceptance authority, typed build/game completion và WASM replay | Durable acceptance/trace/replay + crashproof |
| S08 | T6 maps/lock contract | Map/version/commitment, lock/reveal, start contract handoff | Frozen/reveal/deny-before-start thật; positive start/dispatch đóngS09 |
| S09 | T6 formats/start/seal | Bốnformat, firstdispatch, autoseal/next/rating | Real start idempotent/restart và small tournaments tớiPROVISIONAL |
| S10 | T3b | Full officialsubmission/privateTEST integration | Providers thật; final/archive TEST acceptance đóng tạiS11, chưa ký toànT3 trước đó |
| S11 | T7 | Disputes/correction/rebuild/finalize/announcements | Tournament hoàn tất FINALIZED và correction đúng |
| S12 | T8 | Next public/team portal + esports/IDE/submissionUX | Real DTO, responsive/keyboard/deep link/SSR/privatecache |
| S13 | T9 | Live/replay/bracket/standings/projector | Reconnect/seek/restart/privacy/render thật |
| S14 | T10 | Admin operations/maps/accounts/adjudication | Giảng viên vận hành end-to-end không giữtab |
| S15 | T11 | Linux package/deploy/migration/backup/restore/runbooks | Config preflight + profile-specific operational proof |
| S16 | T12 integration/capacity | Full integration/security review + capacity report | Đủ measured workload/SLO, không chỉ500rows |
| S17 | T12 endurance/release |72hsoak+7dayrehearsal và sign-off G0–G4 | READY hoặc NOT_READY có lý do/evidence, không tự launch |

Integration owner chịu contracts/shared migrations cuối mỗi phiên. Subagents chỉ dùng cho các slice độc lập có ownership rõ; chạy tuần tự giữa các phiên, không đồng thời sửa cùng files. Review mới sau increment quan trọng. Commit checkpoint sau review nếu chính sách repo và quyền user cho phép; không tự push/merge/deploy external.

## 2. Checklist từng phiên

### S01 — Khởi động implementation và G0 config

**Đọc:**01–06, master planT0,05§7.4. **Files:** canonical docs nếu có correction; `deploy/linux/bom.json`, config schema/example khi bắt đầu implementation; secrets ngoài repo. Workspace isolation theo `using-git-worktrees` nếu cần.

**Preparation entry:** [Inventory/prerequisites/provisioning packet](2026-10-14-preimplementation-preparation.md). Snapshot disk305MB/df100% là lịch sử, không current blocker đã xác minh; rebuild đo headroom/inventory mới trước provisioning. Bảo toàn donor và workspace cô lập theo kế hoạch rebuild đã duyệt; packet không đánh dấuS01done.

- [ ] Kiểm trạng thái repo/workspace, giữ nguyên thay đổi người dùng; xác định commit/base và integration owner, không reset/clean.
- [ ] Inventory thực host/tools/source/template permission artifacts có thể truy cập; không lấy thông tin từ memory làm factual state.
- [ ] Resolve/pin exact versions/digests/support sources theo BOM workflow. Kiểm tool prerequisites và paths trước chạy commands; thiếu tool không gọi là regression.
- [ ] Điền inputs phát triển cô lập theo05: profile, OSroles/origins/TLS/data paths/backuptarget/contacts. ONLINE secrets/mail và LAN CA/perimeter theo profile; không hỏi lại dữ kiện tools/repo cung cấp được.
- [ ] Phân biệt `CONFIG_READY`, `PENDING_RUNTIME_PROOF`, `BLOCKED_INPUT`; G1/capacity/restore chưa chạy không được giả complete. Chưa có preflight scriptT11 thì dùng config checklist/schema validation, không chặn T1 vì đợi script chưa tồn tại.
- [ ] Bàn giao BOM/config manifest redacted và blockers cụ thể. Thiếu hạ tầng runtime an toàn ngănS02; các việc reachables hoàn tất, không tự dùng native fallback.

### S02 — Sandbox và IPC


**Owner/files:** masterT1, `crates/arena-engine/`, `crates/arena-runner/`, `crates/arena-supervisor/`, execution.proto và replay-v2.proto; generated Rust/TS contracts dùng chung. Loại Node/TS v2 engine/game-host sau migrate mọi caller; giữ v1 archive reader historical.
- [ ] Implement launch/build/per-Bot isolation, CPU/freezer/process-tree accounting, independent watchdog/reaper, bounded IPC.
- [ ] Chứng minh no-network/no-secret/cleanup/100msCPU+1000mswall/300ply theo05. G1execution failure dừng, không profile downgrade.
- [x] Native/WASM **replay** parity (dev host): the replay loop moved into `arena-engine::replay`, a new `arena-verifier` crate shares the JSON format between the `verify-trace` CLI and the WASM export `oantuti_verify_replay`, and `deploy/linux/verify-replay-parity.ts` reports 634 checked / 634 rust / 634 ts / 634 wasm / 0 mismatch / 68 skippedNoMap on real stored replays (`S02-wasm-replay-parity.json`); browser wiring done as well (`/replays` panel + served wasm asset, verified in headless Chromium).
- [ ] Run targeted Rust/native/WASM conformance và masterT1 checks; real runner consume immutable manifest, initial-terminal trước INIT, startup correlation/observation taxonomy đúng03, smoke starterPython/compiledTS/C++ và canaries cô lập. Không hardcoded moves/map hoặc fake engine evidence.
- [ ] Reviewer đọc evidence/security boundaries; report host/BOM/digests/counters và pass/fail từng constraint. Internal fixtures không mở public submissions; G1 exact target pending đến proof thật.

### S03 — PostgreSQL và LAN identity/teams

**Owner/files:** masterT2 core migrations, identity/teams/authorization và contracts identity/commands.

- [ ] Migrate durable state/transactions, session revoke/CSRF, singletonADMIN/bootstrap, limits.
- [ ] S03 sở hữu **tournament admission substrate thật** trong001-control-plane.sql: tournament/rule-revision identifiers, DRAFT/PUBLISHED/REGISTRATION_OPEN state/window/version, per-tournamentlimits/admissions/entries và Admincreate/publish/open API hoặc maintenanceCLI cóvalidation/audit. Smoke tạo giải thật→directenroll, khôngstubtournament. S08/S09 mởrộng maps/lock/stages/formats cùngtables, không tạo provider thứhai; opening kiểm policy fields bất biến theo01/02, fixture map/profile pinned không fakecertification.
- [ ] LANbulk unique temporarypassword→limitedsession→firstchange→normal; Adminassign/directenroll, student roster changes denied.
- [ ] Smoke thật account/team/role/admission và race/capacity/nooversubscription; ADMINsource policy chuẩn bị repositoryscope, không expose draft.
- [ ] Bàn giao Actor/CommandContext/Receipt canonical; không copy clientActor.

### S04 — ONLINE identity và recovery

**Owner/files:** masterT2 remaining token/outbox/sharedcode/profile contracts.

- [ ] Register/verify/resend/login/reset/re-auth với oneusepurposeboundtokens/revoke; sharedcode rotation/admissionatomic.
- [ ] Probe staging mailbox được operator sở hữu/cho phép, không gửi production hoặc activatepending khi SMTPfail.
- [ ] Tests profile spoof/cross-team/publiccache; LAN tiếp tục khôngSMTP/emailwall. T2 complete sau cảS03/S04, không tuyên bố ONLINEready nếu chỉ mock mail.

### S05 — Source pipeline T3a

**Owner/files:** masterT3a source store/project manifest/receipts/testsnapshots/ACL/quota + contracts submissions/tests.

- [x] Whole project hashes/ZIP validation/128 files/256KiB per file/4MiB expanded/2MiB ZIP, immutable fsync receipt/ordinal/cutoff/quota: `source-limits.test.ts` (6 test biên) + `submission-quotas.test.ts` và `submission-lifecycle.test.ts`.
- [x] Draft/Test/Submit tách, own team/ADMIN submitted-source read audit; private test snapshot không official ordinal (test hiện có + live 403 đội khác / 401 ẩn danh).
- [x] Real upload→durable receipt→readback/hash/restart/ACL/cutoff deny smoke: live 200 receipt ordinal 1 → source readback manifest `fileCount 2` → object trên đĩa byte/hash-identical với ZIP upload → 403/401 → 409 khi quá hạn (TEST vẫn 200) → sau cold restart vẫn đọc được; payload handoff queue đã có trong `build-pipeline.test.ts`.
- [x] Không fake READY/test result (receipt chỉ READY qua build gate). Đây là **T3a handoff**; T3 integrated cases vẫn thuộc S10 nên S05 không ký T3 complete.

### S06 — Durable jobs

**Owner/files:** masterT4 migrations/jobs broker/reconciler/scheduler/admission, contracts/jobs.

- [ ] UDS UID identity (03 §193): chưa có ở cả server và `crates/arena-supervisor/src/control.rs` (không kiểm SO_PEERCRED); consumer là supervisor sandbox thật nên thuộc biên S02 → **BLOCKED**.
- [x] SKIP LOCKED/unique keys, lease30s/**heartbeat5s**/reconcile≤10s/fences/generation: `LEASE_TTL_SECONDS=30`, `LEASE_HEARTBEAT_SECONDS=5` (dùng chung execution-service + auto-runner; trước đó là TTL/3=10s), reap mỗi tick 5s, fence/generation có test trong `durable-jobs.test.ts`.
- [x] Slots/reserve/build official > TEST priority (GAME/BUILD 100 vs TEST_GAME 50), 3 infra attempts/backoff 5s-15s/BLOCKED; retry không biến infra thành Bot forfeit (`durable-jobs.test.ts`).
- [ ] Local 2-supervisor smoke (claim/restart/old fence/recover) — phụ thuộc supervisor sandbox thật (S02), giữ mở; không đánh dấu T5.

### S07 — Engine/result/replay

**Owner/files:** masterT5, server results/verifier/outbox, `crates/arena-runner` inspect adapter, `packages/protocol/proto/{completion-v2,replay-v2,public-stream-v2}.proto`, SDK và browser WASM paths. S02 sở hữu engine/runner semantics; S07 sở hữu một acceptance path, không implement TS verifier thứ hai.

- [x] Versioned semantics/init/action trace (`rulesRevision` trong evidence, `TraceVerifier`), build/smoke parity cho cả 3 ngôn ngữ (PYTHON/TYPESCRIPT/CPP — CPP compile thật bằng `g++`), phân biệt runtime verdict vs infra trong `executionStatus`/`disposition`.
- [x] Evidence fsync (file + parent) trước khi pin `COMPLETION_PENDING`, staging refs/GC hold, reconciler promote/accept bất biến + outbox: `results-durability.test.ts` (fsync→promote, tamper/checksum, accept một lần) + `durable-jobs.test.ts` (promote orphan).
- [x] Real game → verify → accept → download → replay: LIVE 2 đội upload starter bot → worker build READY → `MAP_REQUIRED` rồi `RUNNING` sau khi commit map → runner tự đánh 4 ván → `PROVISIONAL`; 4/4 replay tải theo digest (`OANTUTI2`, `sha256 == digest`) và `verify-replay-parity --limit 8` cho 0 mismatch (Rust/TS/WASM). Kill/lost-ack/stale-fence/no-double-score phủ bởi `durable-jobs` + `results-durability`.
- [ ] Consistent off-host backup/restore còn PENDING_PROVIDER_T11 tớiS15; S07khép crash/restart/localdurability, chưa ký toànG2restore. Không yêu cầu backup pipeline chưa implement trước khi sangS08, khôngbỏ nghiệmthu release.
- [x] Private TEST engine chạy thật (starter bot, replay riêng) nhưng API journey đầy đủ vẫn thuộc S10; V1 archive đọc được (`results-durability.test.ts` giữ read-compatibility OANTUTI1).

### S08 — Map/version/lock/start

**Owner/files:** masterT6 maps and lifecycle, T3repositories consumed; T6soleTournamentCommands.lockowner.

- [~] Admin map authoring/version đã có; **pool management** (admin + state-guard + audit + POOL_UNDER_FOUR) và panel organizer đã có; warnings validator có. Initial-terminal evaluation đã có (warning `INITIAL_TERMINAL`/`INITIAL_STATE_UNVERIFIED` bằng chính engine). Còn: resource validation trên host release và map editor usability thật.
- [x] PUBLIC/HIDDEN commitment policy + private TEST hidden-map denial (`MAP_POOL_TOO_SMALL` bổ sung cho pool tối thiểu): `resolveMap` chỉ nhận map `PUBLIC` hoặc đã reveal (ưu tiên commitment), test `private-test-runner.test.ts` chứng minh map HIDDEN không bị dùng cho buổi practice; reveal ở lock là một UPDATE trong cùng transaction (`lifecycle-service` L129).
- [x] Atomic frozen inputs/lock/reveal + start authorization contract: lock là một transaction (drain `INTAKE_DRAINING`, freeze receipt mới nhất per đội, đội không có receipt → EXCLUDED, reveal map HIDDEN của pool); start ADMIN-only (STUDENT bị từ chối, test `tournament-lifecycle`), sai state → 409 (double click), thiếu map → `MAP_REQUIRED`/`MAP_POOL_TOO_SMALL`, slug lệch commitment → `MAP_COMMITMENT_MISMATCH`; không có game nào được tạo trước start (live: bracket 0 game trước start, 4 game sau). **CONTRACT_HANDOFF**: positive start→first dispatch đã có bằng chứng live, S09 nghiệm thu chính thức.
- [x] Pool tối thiểu được **thực thi**: `start` trả `MAP_POOL_TOO_SMALL` khi pool < 4 (knockout) hoặc < 1 (RR/Elo) — trước đó route chỉ *cảnh báo* `POOL_UNDER_FOUR`; test `tournament-lifecycle` (pool hợp luật + ca 1 map bị từ chối).
- [x] 4 ván của một series knockout dùng **4 map version khác nhau** từ pool: `020-map-pool-version` pin version khi vào pool + lock re-pin, `resolveStageMapPool` đọc pool theo thứ tự pin, `persistSchedule` gán `pool[(ordinal-1) % size]` cho knockout (RR/Elo giữ 1 map/encounter, không pool thì giữ descriptor caller); test `four-formats` §6 + live `distinct_maps 4`.
- [x] Real API map create→warnings→pool→lock→reveal→start: `tournament-lifecycle.test.ts` (create PUBLIC/HIDDEN + warnings, pool add/dedupe/remove, freeze `MAP_FREEZE_LOCKED`, lock reveal) và live journey S07 (start 200 sau khi có commitment + pool, runner tự đánh vòng 1). Full map editor vẫn thuộc S14; S08 không ký T6 complete.

### S09 — Four formats

**Owner/files:** masterT6 policies/reducer/pairing/elo; consumeS08frozeninputs/S07ledger.

- [x] Exact matching/timeout `BLOCKED_PAIRING`: solver blossom (`formats/matching.ts`, port networkx, **differential 260 ca / 0 mismatch**, N=500 trong 3.1s), trọng số §79/§102 (`pairing-weights.ts`), Swiss+Elo dùng exact matcher (Elo history = count + bye counts), blocker durable `ROUND_SEAL_BLOCKED {BLOCKED_PAIRING}` rồi retry xanh (`pairing-blocker.test.ts`), regression 97 < greedy 99 (`exact-pairing.test.ts`).
- [ ] Còn nit: tie-break giữa các optimum **cùng trọng số** hiện là deterministic canonical ordering, chưa phải lexicographically-smallest sorted pair list đúng chữ; optimality theo trọng số là exact.
- [ ] S09/T6 sở hữu durable lastTerminalAt/sealEligibleAt, grace10min, autoseal khi no blockers và next-round/Swissplayoff/Eloepochcommit dispatch. Realclockgrace/restart smoke; blocker state được persist từđầu, S11 thêm dispute/correction paths khôngimplementationautosealthứhai.
- [x] Đóng S08 positive acceptance: Admin start → atomic RUNNING gate → real first round/jobs/game (live S07: 4 game thật), **double click/lost ack same receipt** (`command_receipts` + `Idempotency-Key`, live trả cùng receiptId), `expectedVersion` → `STALE_VERSION`, restart không tự start (runner chỉ tick RUNNING).
- [ ] Còn mở (S16): capacity proof bằng fixture workload thật measured slots, không giả 500 đội.
- [ ] Bye/walkover/EMPTY/NO_CONTEST/NO_CHAMPION/withdrawal/DQ/dependency handling; nofakegames/rating.
- [x] N2/3/4/5/10/16/64 fixtures (policy level): `format-field-sizes.test.ts` — knockout width/byes, Swiss R/T + không rematch ở vòng 2, RR mọi cặp đúng một lần, Elo E + pairing mỗi epoch, ca N < cutoff.
- [x] e2e Swiss→playoff tự động và Elo tới PROVISIONAL trên DB thật: `four-formats.test.ts` §7 — 4 đội Swiss chạy đúng R=2 vòng rồi tự vào PLAYOFF (không start lần 2), chung kết có winner, đúng một `TOURNAMENT_PROVISIONAL`; 4 đội Elo chạy đủ 8 epoch, có `rating_events`, tự tới PROVISIONAL. Vòng lặp play→`markTerminalRounds`→`sealEligibleRounds` đúng như worker thật.
- [ ] S09 không tựfinalize: providerS11; schedulerN500 khôngcapacitycertification.

### S10 — Submission/privateTEST end-to-end T3b

**Owner/files:** masterT3b integrateS05–S09, không duplicate lockimplementation.

- [x] Three languages multi-file → build → INIT smoke → READY: `build-pipeline.test.ts` (TS import, Python import, C++ header include, g++ thật); ordinal ordering/fallback/cutoff/drain (`INTAKE_DRAINING`)/infra `BLOCKED` đã có test tương ứng.
- [x] Lock hash same every official game: live 4/4 accepted results tái tạo đúng `sha256({rulesRevision, white, black})` từ **materialized frozen manifests** (A-white → `6876…`, B-white → `c4cb…`), frozen source digests = submitted digests; OFFICIAL deny sau cutoff ✓, TEST sau cutoff ✓ (live). TEST sau **final/archive** thuộc S11 (đóng cùng finalization).
- [x] TEST_BUILD/TEST_GAME → private board/replay/log không đổi ordinal/candidate/rating/frozen (`private-test-runner.test.ts` 7 test, kèm ca HIDDEN map).
- [ ] T3 integrated acceptance: **PENDING** — final/archive TEST journey đóng ở S11 trước S12; không ký T3 ở S10.
- [ ] Chỉ ký T3 integrated acceptance sau mọi official/TEST journey đạt; final/archive journey đóngS11 trướcS12, chưa đủ evidence thì PENDING, không partial pass thành complete.

### S11 — Corrections/disputes/finalization

**Owner/files:** masterT7 corrections/rebuild/disputes/announcements/contracts.

- [x] preview/apply digest/version + re-auth: preview digest canonical, apply từ chối stale/tampered, apply atomic + result_version mới + ledger, invalidate descendants; RR/Elo rebuild phủ bởi `invalidate.test.ts` + `corrections-and-finalization.test.ts` (replay apply = digest+version gate → 409, không áp hai lần).
- [x] Grace 10min + appeal 0–10080 (default 1440) + serialize dispute/finalize, không auto-finalize, chỉ final stage cần cổng tay: `grace-autoseal.test.ts`, `appeal-and-announcements.test.ts`, `corrections-and-finalization.test.ts`.
- [x] PROVISIONAL → Admin finalize → FINALIZED, reopen/correction tường minh; private TEST sau **FINALIZED** chạy đường durable (`createPrivateTest` → TEST_BUILD → TEST_GAME + replay riêng), không đổi ordinal/entries/ratings/standings, official vẫn 409 (`private-test-runner.test.ts`). ARCHIVED chưa có lệnh chuyển state → S15.
- [x] Public replay route chỉ phục vụ replay có `result_versions` (private TEST replay theo digest bị 404); xác minh sống.
- [x] Private TEST create rate 10/rolling minute (kể cả request sai payload) + bảng `test_create_attempts`; xác minh sống.
- [x] Announcement công khai đã trim `reason` của TEAM_WITHDRAWN (DQ reason vẫn công khai theo quyết định).
- [x] Một đường direct-enroll duy nhất: alias `/enrollments` gọi `admission.enrollTeam`; bản legacy bị xoá; course isolation + team-size window áp cho cả enroll đơn và bulk.
- [x] EMPTY-slot bracket: structural slot width persisted (`018-round-slot-count`), no fabricated winners, playoff keeps policy width, `EMPTY_FINAL` NO_CHAMPION. Đã đóng: `format-field-sizes.test.ts` phủ N2/3/4/5/10/16/64 cộng ca T=8 chỉ còn 3 đội active (giữ 4 slot, chỉ 3 row bye, không tạo cặp đấu giả), và bracket UI render `ô trống (EMPTY)` với fixture 5 đội/8 slot trên Chromium headless.
- [x] Disqualification void-stage + rebuild (với route `…/teams/:teamId/disqualify`, panel adjudication, outbox/audit, walkover trước đó).
- [x] DQ đúng §118/§122/§124: encounter chưa start → walkover cho đối thủ còn active (hoặc double withdrawal); cả hai finalist bị DQ → `PROVISIONAL` + `TOURNAMENT_NO_CHAMPION`, không tạo vô địch; "started" = game đã được claim (helper `encounter-state.ts`), game/job của encounter đã quyết bị huỷ/block; round rebuild xoá row chưa chơi nên mỗi slot bracket chỉ còn 1 row. Xác minh: `dq-finalists.test.ts`, `disqualification.test.ts`, `withdraw.test.ts` + live HTTP; **232 tests**.
- [x] Backend correction/finalization contracts + G2 correctness evidence (append-only, ledger, gates, không editable winner) đã có test; **full G2 vẫn chờ restore proof S15** — S11 không ký toàn G2.

### S12 — Next public/team portal

**Owner/files:** masterT8 Nextcutover/designsystem/IDE/upload/APIclient/routes.

- [x] Real routes/SSR/public DTO: Next app là portal duy nhất (không còn Vite trong workspace); trang công khai SSR không cần JS (curl 200 + nội dung thật, 404 cho id/route lạ), private pages gọi API thật, không mock.
- [x] Dark navy/violet/cyan + **light theme tùy chọn**: đủ token §4.1 cho cả hai theme, toggle header + pre-paint script + `localStorage`; WASM/asset self-host, không CDN/font ngoài; editor đa tệp + upload + mobile có sẵn.
- [x] Browser thật: guest deep-link/noJS/404; team upload+submit qua UI → receipt `037f…` ordinal 1 → `READY` kèm digest/history; session hết hạn → chỉ cổng đăng nhập; theme đổi **giữ draft** (`DRAFT-CODE-42`), reload giữ theme, mobile 390×844 ẩn nav desktop; screenshot + network.
- [x] Không pin chữ UI bằng test; bằng chứng là browser + network + semantic server contracts hiện có; portal dùng dữ liệu thật.

### S13 — Live/replay/standings/bracket/projector

**Owner/files:** masterT9 boundedgateway/chunks/live/publicreader/features.

- [x] WS seq/attempt/gap/snapshot/reconnect: heartbeat 20s, stale close 60s (4408), cap `bufferedAmount > 1 MiB` (`ws-hub.ts`), viewer gap → reconnect snapshot; `live-match-hub.test.ts` phủ late-join/RESULT một lần/unsubscribe idempotent/buffer+ceiling/grace.
- [x] Replay checksum/seek + frame-vs-result: browser xác minh SHA-256 trailer + WASM replay (`Engine WASM chấp nhận trace · 8 nước · THRONE_BREACH`), seek tới ply 8; **ACL live: owner 200/200, đội ngoài 403/403, ADMIN 403/403, ẩn danh 401/401**.
- [~] Public bracket có EMPTY slot + nhãn BYE/WALKOVER/DOUBLE_WITHDRAWAL (server trả `rounds.slotCount`); public standings Swiss/Elo có; còn: EMPTY trong projector, brackets-viewer client-only, kiểm tra bàn phím/mobile thật.
- [x] Browser thật: seek + step controls, projector SSR không JS, fullscreen/copy-link có mặt, offline→online projector tự cập nhật lại (`06:26:32 → 06:26:42`), mobile 390×844 (S12); screenshot + network. Ghi chú: chưa chạy kịch bản ngắt WS cưỡng bức trên trình duyệt — đường gap→reconnect có code + test.

### S14 — Admin operations và usability

**Owner/files:** masterT10 maps/accountprovisioning/wizard/ops/adjudication/tutorials.

- [~] Map editor verified live: dựng map trên lưới → `POST /organizer/maps 201` + warnings (`UNBALANCED_PIECES`) lưu nguyên văn, `POST …/versions 201` → v2; role guard (STUDENT: không có console, API 403); audit `MAP_CREATED` / `MAP_VERSION_PUBLISHED` (đã bổ sung); keyboard `Space` trên ô + mobile 390px (đã sửa tràn header) + desktop không đổi. LAN bulk preview/direct enroll + capacity ✓; auto N/R/T/E preview ✓; **ONLINE shared-code UX** ✓ verified live. Còn: instructor walkthrough, bulk self-registration theo mã, usability/screen-reader proof.
- [x] ADMIN source/log read-only **audited** (`SUBMISSION_SOURCE_READ` + `ADMIN_INSPECT_SOURCE`, S11), start/pause/resume/close-registration/finalize/reopen/appeal-window/grace/apply-correction đều qua re-auth 10 phút (403 `REAUTH_REQUIRED` khi thiếu, S08) với prompt inline trên portal; extension chỉ mở intake đang mở và chỉ khi `serverNow <` cutoff hiện tại (S10/S11).
- [~] Instructor real journey + student reason/log/replay explanation: **PENDING_EXTERNAL_EVIDENCE** — cần người thật, không thể chứng minh trong phiên này (đã có đường code + evidence máy ở S09/S11/S13).
- [~] Usability targets 04 với students/lecturers + keyboard/screen-reader proof thật: **PENDING_EXTERNAL_EVIDENCE** (keyboard/mobile đã có evidence máy ở S14; screen-reader + người thật chưa có). Thiếu participants giữ PENDING_EXTERNAL_EVIDENCE; reachable implementation không thay human sign-off.

### S15 — Deployment/migration/recovery

**Owner/files:** masterT11 `deploy/linux/`, migrations/archive/operations/runbooks/CI/Dockerfiles/README.

- [ ] ReproducibleBOM/offlinebundle/roles/ACL/CA/TLS/secrets/preflight; managedstartup/readiness, noAPIprivilegedsocket.
- [ ] Consistentv1cloneexport/import/hash/count/FK, nofakeprovenance/runningresume/noSQLiteoverwritev2writes.
- [~] WAL + point-in-time restore drill chạy được (`deploy/linux/wal-restore-drill.py`): base backup 6.6 s/82 MB, restore 1.9 s, marker sau backup sống sót (RPO pass) — `S15-wal-restore-drill.json`, trạng thái NOT_OFF_HOST. Còn: copy off-host, key custody/signed manifest, holds + GC, 35 ngày retention, fencing khi lag > 5 min, drill trên host release.
- [ ] ONLINEstagingmail/reset; LANcoldbrowser noWANentirejourney/localADMINrecovery; oncallalertack+incidentdrills.
- [x] Retention tự chạy trong worker (`sweepAsSystem`, mặc định 6 h, `OANTUTI_RETENTION_INTERVAL_MS`, hiển thị trong runner-status) bên cạnh route ADMIN; retention policy implemented as executable defaults: `GET/PUT/POST /organizer/operations/retention` (report, holds, dry-run sweep) with TTL classes, hold precedence and report-only audit/official-source/official-replay; `retention.test.ts` + live API run. Backup-lag write fence đã có (`OANTUTI_BACKUP_FENCE=enforce`, heartbeat do WAL drill ghi; chặn submission/enroll/lock/start/finalize khi lag > 5 phút). Off-host backup/restore, v1 clone/import và drill trên host release vẫn PENDING_PROVIDER_T11.
- [ ] Validate G0 config and operationalproof; no deploymentpublicproduction transition without user/operator authorization.

### S16 — Full integration và capacity

**Owner/files:** masterT12 fullsuite/build/codegen/deploychecks/loadgenerators/reports; providersS02–S15 complete or explicitexternal-evidenceblocker.

- [ ] Run masterT12 aggregatecommands afterintegration, fixconsumerbehavior failures without narrowingassertions.
- [ ] Independentsecurityreview/adversarialcanaries, frozenpolicy/ACL/ledgercoverage; zero unresolvedcritical/high.
- [~] Probe đo được chạy (`deploy/linux/capacity-probe.ts`): 1 000 spectator 0% drop p99 19.6 ms + 7.4 games/s trên host dev (status DEV_HOST_MEASUREMENT_NOT_CERTIFIED). Còn: workload hỗn hợp 500 đội/1 000 người xem + tie/retry trên host release đã tuyên bố.
- [~] Số đo dev: spectator SLO pass ở 500/1 000 client, RSS 88→180 MB, 7.4 games/s (greedy vs random, 17 lượt/ván). Chưa đo: quota CPU host release, tăng trưởng storage/WAL, TLS, soak nhiều giờ — insufficient capacity vẫn là NOT_READY, không claim thu hẹp phạm vi.

### S17 — Endurance, review và release decision

- [~] Bounded soak chạy được (`deploy/linux/soak-probe.ts`): 5 phút, 149 vòng, 596 request 0 lỗi, 3 725/3 725 WS đóng, RSS 142.8→133.3 MB, FD 33→35, p99 3.9 ms — `S17-bounded-soak.json`. Còn: official/build/private TEST churn, backup rotation trong soak, 72 h + 7 ngày rehearsal, host release.


**Owner/files:** masterT12 soak/rehearsal/evidence/userhelp/changelog/release/runbooks.

- [ ] 72hsoak và7dayrehearsal riêng, realclock/overnight/backup/outage/reconnect/noAdmintab, enoughBot/viewer mix.
- [ ] Recovery/budget/ownership/retention/privacy/accessibility proof, S10final/archiveTESTacceptance complete, migrations rollback compatible.
- [ ] ADMIN/operator/independentreviewer signG0–G4 evidence; summarize READY/NOT_READY+restrictions actual, do not call scaffoldproduction.
- [ ] Only after explicittargetauthorization publish/deploy/enableexternalintake. Failure remainsS17blockedwithreason; fix applicableowner task then rerunaffectedproof, not auto-launch.

## 3. Handoff bắt buộc mỗi phiên

Khi triển khai, tạo report tại `docs/implementation/sessions/SNN-<scope>.md` (không tạo report giả trong phiên planning này). Một report chứa:

- Status `NOT_ACCEPTED`, `PENDING`, `PENDING_EXTERNAL_EVIDENCE`, `BLOCKED`, hoặc `CONTRACT_HANDOFF`/`COMPLETE` chỉ khi evidence mới đủ exit gate. Historical report status không kế thừa tự động.
- Base/end commit nếu có, changedfiles, spec/policy/BOM digests, migrations applied và sharedcontracts delivered.
- Commands thực sự chạy+exitstatus, smoke scenario+observedresult, evidencepaths/screenshot/logredacted; unrun rõ ràng.
- Review findings/resolution, remainingblocker owner, security/privacy/data impact.
- Nextsession prerequisites/firstaction; không TODOimplementation bị giấu hoặc mock pass.

Bảng acceptance rebuild (cập nhật 2026-10-18): các giá trị `CONTRACT_HANDOFF` dưới đây nghĩa là phạm vi dev trong workspace `OanTuTi-rebuild` đã được chạy và kiểm chứng thực tế, nhưng exit gate của phiên (sandbox/target thật, mailbox thật, off-host, review độc lập, human sign-off, real-clock) **chưa** đạt — xem bằng chứng chi tiết trong [rebuild progress](../../implementation/rebuild/progress.md). Cách chạy **bộ test đầy đủ** và một **demo đầu-cuối** (seed giải, đấu, xem standings/replay/projector, đăng nhập): [demo và test](../../implementation/rebuild/demo-and-tests.md). Không giá trị nào là `COMPLETE`; liên kết report lịch sử vẫn giữ nguyên tên cũ.

| Phiên canonical | Trạng thái | Evidence hiện tại / điều kiện còn thiếu |
|---|---|---|
| S01 / T0 | BLOCKED | Preservation/config/private PG/Rust/WASM dev đã có bằng chứng trong `progress.md`; exact GA6.8 target, service UID/cgroup và independent review chưa có → `RELEASE_NOT_READY` |
| S02 / T1 | CONTRACT_HANDOFF | Engine/runner suites + WASM smoke + gameplay v2 pass; sandbox gVisor/cgroup/exact-target chưa chạy — engine dev-only |
| S03 / T2 LAN | CONTRACT_HANDOFF | PG migrations, LAN identity, teams, admission, audit verified live; release target chưa chứng nhận |
| S04 / T2 ONLINE | CONTRACT_HANDOFF | Register/verify/login/reset (dev-exposed token) + shared entry code verified live; real mailbox/SMTP provider chưa có |
| S05 / T3a | CONTRACT_HANDOFF | ZIP/limits/fsync/receipts/ordinal/quota/ACL + source-read audit + build gate + intake restart smoke verified; release target/real mailbox ngoài scope |
| S06 / T4 | CONTRACT_HANDOFF | Durable GAME/BUILD/TEST jobs, leases, reconcile, crash/restart và lease reclaim verified; UID-bound broker/supervisor hai tiến trình chưa có |
| S07 / T5 | CONTRACT_HANDOFF | TS acceptance path verified; Rust CLI trace verifier now cross-checks 634/634 real replays (0 mismatch) but write path still TS; supervisor runtime/three-SDK parity/off-host restore chưa đạt |
| S08 / T6 maps/lock | CONTRACT_HANDOFF | Map versions/commitment freeze-at-opening, pinned start, close-drain-lock verified; durable reveal/map pool chưa làm |
| S09 / T6 formats | CONTRACT_HANDOFF | Bốn thể thức + BYE + grace/autoseal/dispute-block + NO_CHAMPION unresolved-final verified (N=64 fixture); N=500/capacity slots chưa chứng minh; withdrawal trước khi bắt đầu + walkover khi đang chạy đã có (DQ void-stage còn mở) |
| S10 / T3b | CONTRACT_HANDOFF | Build→READY, frozen candidate, private TEST vs own/baseline, final/archive TEST verified; infra BLOCKED paths chưa chứng minh |
| S11 / T7 | CONTRACT_HANDOFF | Appeal window, dispute gate, announcements, correction preview/apply, explicit reopen, downstream invalidation/rebracket, RR rescore và Elo epoch rebuild verified live; còn dispute policy after rebracket/other formats chi tiết |
| S12 / T8 Next | CONTRACT_HANDOFF | Next cutover, public/team/organizer, Monaco IDE, ZIP writer, ONLINE screens, mobile overflow fixed, SSR deep-link/404 checked; owner duyệt ba màn chưa có |
| S13 / T9 viewer | CONTRACT_HANDOFF | Replay checksum/seek, bracket/standings, projector (fullscreen/share), live WS + snapshot/resume + heartbeat + seq/gap verified; attempt/PR nuance chưa đủ |
| S14 / T10 admin | CONTRACT_HANDOFF | Map editor, commitments, run controls, adjudication, IDE, bulk LAN chưa đầy đủ; usability/screen-reader human proof chưa có |
| S15 / T11 operations | PENDING_EXTERNAL_EVIDENCE | Fresh DB bootstrap 15 migrations + local backup/restore drill (row-count match, manifest offHost:false) verified; off-host copy, RPO/RTO, retention và managed startup chưa có target |
| S16 / T12 capacity | PENDING_EXTERNAL_EVIDENCE | Suites/benchmark nội bộ pass; independent security review + 500-team/1000-viewer workload trên host declared chưa chạy |
| S17 / T12 endurance | BLOCKED | 72h soak và 7-day rehearsal thực, human G0–G4 sign-off chưa thể thực hiện trong phiên hiện tại |

## 4. Cách bắt đầu và tiếp tục

Lệnh yêu cầu phiên đầu: **“Triển khai S01 theo kế hoạch phiên tuần tự; hoàn tất phạm vi và handoff, không tự deploy production.”** Các phiên sau: **“Tiếp tục phiên kế tiếp từ handoff đã hoàn tất; giữ đúng baseline và gates.”** Đây là prompt mẫu, không thay quyền user ở thực tế.

Mặc định đề xuất thực thi subagent-driven khi có các slice độc lập, integrationowner duy nhất/reviewer mới, tuần tự giữa các phiên. Native cũng hợp lệ với cùngchecks/handoff. Không cần hỏi lại luật/UI đã chốt; chỉ hỏi dữ liệu operator/secret/hardware không thể lấy qua tools hoặc tradeoff thật sự đổi phạm vi.

Không cam kết số ngày/ngân sách từ số phiên: S02sandbox, S16capacity và S17endurance phụ thuộc evidence/hardware/humanreview thực tế. Ước lượng lại sauS02 vàS06. Hoàn thành planning này chưa nghĩa là đã thực hiệnS01.
