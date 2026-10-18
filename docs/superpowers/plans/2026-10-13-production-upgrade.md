# OanTuTi Arena v2 Production Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **2026-10-17 rebuild authority:** chủ sản phẩm đã duyệt workspace rebuild bảo toàn donor và S01. Completion/report trước rebuild là **SUPERSEDED / NOT_ACCEPTED**, giữ lịch sử chứ không kế thừa G0–G4. Các checkbox là acceptance pending; chỉnh tài liệu không đóng S01/G0/G1. Delta duy nhất: Rust engine/native runner/WASM thay Node/TS v2 game-host/engine; product/rules/security/UX giữ nguyên.

**Goal:** Nâng v1 thành nền tảng production để tổ chức giải Bot cho 500 đội, tự vận hành nhiều ngày, hỗ trợ bốn preset, khán giả truy cập công khai và quy trình hoàn chỉnh cho đội thi, giảng viên.

**Architecture:** một máy Linux cho LAN và Online/VPS; Fastify/Next/PostgreSQL/local durable artifacts/scheduler, Rust engine/native runner/supervisor với per-Bot gVisor/cgroup isolation. Cùng engine Rust qua WASM cho browser replay/visualization, không browser Bot execution/result acceptance. TypeScript giữ control plane và tournament policies. Không cluster/standby/remoteworker/replication; durablecommit/outbox/idempotency và backup ngoài máy; khôngAPIspawnusercode.

**Tech Stack:** Ubuntu Server24.04LTS amd64 GA6.8/systemd/cgroupv2, PostgreSQL16, Fastify/TS, Rust engine/native runner/supervisor + WASM target/toolchain, Node cho control/web/compiled TS Bot baseline, Next/React, runsc/gVisor, local durable artifacts, shadcn/Tailwind/brackets-viewer. Exact patches/images/checksums/support review trong BOM05§7.4; không floating latest. KhôngVM/Redis/S3/replication/remoteexecution prerequisite. [Research stack](../../research/2026-10-13-v2-tech-stack-evaluation.md) giữ rationale lịch sử; Node/TS engine ownership đã superseded.

**Spec:** [Thiết kế tổng](../specs/2026-10-13-production-upgrade-design.md), [bộ đặc tả canonical](../../specs/v2/README.md), [nghiên cứu](../../research/2026-10-13-v2-platform-research.md).

**Session schedule:** [S01–S17 tuần tự](2026-10-14-sequential-implementation-sessions.md). Tài liệu này giữ task/contracts canonical; session schedule chia execution và handoff, không thay luật hoặc đánh dấu task đã làm. T3a là contract handoff, T3b integrated acceptance; privateTESTfinal/archive proof khép sauT7.

## Global Constraints — Ràng buộc chung

- Đây là baseline thiết kế hoàn thiện, không chứng nhận production và không cấp quyền triển khai trong phiên tài liệu.
- Phạm vi một trường, tối đa500đội/giải là target cần chứng nhận trên máy cụ thể; vận hành nhiều ngày với rehearsal7ngày, không hardstop1–7ngày. Bốn preset `SINGLE_ELIMINATION`, `SWISS_PLAYOFF`, `ROUND_ROBIN`, `ELO_ARENA`.
- LAN_OFFLINE school/personalhost và ONLINEschool/VPS: LANAdminaccounts/directenroll/firstpassword/noSMTP; ONLINEverifiedemail/sharedcode. T2identity/T8profileUI/T11offlinebundle/localCA/firewall/storagebackup/T12noWANrecovery; khôngVMdefault/fakeverified/nativefallback/AI-free/HAclaim.
- Host baseline03/05 Linux-only mộtmáy, khôngVMmặcđịnh/Windows/macOS/WSL/DockerDesktop. UDSUID-boundbroker, dedicatedlauncher/reaper+cgroups, khôngAPIprivileged. LANHTTPSlocalCA/offlinebundle, ONLINEpublicTLS/mail; BrowserclientđaOS. T1 chứngnhận đúng BOM/hardware, không tự đổiprofile.
- Đã duyệt tập trung **một máy Linux cả LAN/ONLINE**, khôngmulti-host/standby/replication bắtbuộc hoặc optionalHA feature trongscope hiện tại. Local fsync/objectpromotion+PostgreSQLdurablecommit+outbox authority; backupconsistent ngoài máy, processrestart vs diskrestoreproof. Khôngzero-loss/HAclaim/unsafeBotfallback.
- Admin-controlled accountCapacity/maxTeams và LANbulkaccounts đãduyệt; unique temporarypassword/first-loginchange mandatory. T2tests limitedpasswordchangesession khôngteam/upload, concurrentcapacityenforcement/nooversubscription, noadmin2; giảmlimit khôngkick existingusers/teams. T6lock tínhN từ eligibleBots, khôngconfiguredcap; T10capacity/roster UI và T12benchmark 500target khôngunlimitedclaim.
- LAN ADMIN cấp account/phân đội và direct-enroll giải, không mã hoặc Join sinh viên; ONLINE selfteam+sharedcode. T2/T8/T10 regression profile server enforcement, malformedbulk/duplicate membership/limits/concurrentenroll/audit, unassigned/unadmitted uploaddenied; student directenroll/mode spoof denied. Không implicit source transfer hoặc sửa roster frozen.
- Mọi format yêu cầu ADMIN explicitstart: LOCKED→READY_TO_START chờ lệnh, không autostarttimer/reveal/restart. Tests trướcstart noofficialjobclaim/execution, STUDENT denied, doubleclick/lostack khôngduplicate, startedAt/by/audit đúng; restart RUNNING resume nhưng READY_TO_START vẫnchờ. T4/T6/T10 cậpnhật startgate/UI/receipt.
- Public official viewing khônglogin; source/PII/log private. Không practice tournament/leaderboard; **đã duyệt workspace private tests** namespace riêng, khôngpoints/Elo/submission/candidate side effects.
- Team limits đãduyệt:min1,max3mặcđịnh; giảngviên chọnmax1–5trướcregistration. Atomic membership/invitation acceptance không vượtmax, mộtstudent/mộtteam/giải; không đổi limits giữa giải.
- Một ADMIN duy nhất/deployment, quản lý mọi giải và đọc source/log bài đã nộp mọi đội, read-only/audit; STUDENT chỉ đội mình, khách denied. Không quyền sửa source/đổi frozen artifact/impersonation. Singleton pending/disabled, bootstrap idempotent, không promote/invite-admin. Regression quyền đọc/tải, private cache, audit không chứa source và deny mọi mutation code từ ADMIN.
- Python/TypeScript/C++20, không Go; source đơn/nhiều tệp, Monaco tree/tabs/entrypoint và ZIPupload. Baseline128files/256KiBfile/4MiBexpanded/2MiBZIP; standardlib+SDK+localimports, fixedbuild, không user scripts/Internetdeps. Canonical sorted-file manifest, wholeproject snapshot; extraction traversal/links/duplicates/bomb và language imports theo01/05.
- Dependency restriction đã duyệt: project sources/standardlib/pinnedSDK only, no externalpackages/networkinstall hoặc vendorpackage bypass. T3/T5 chứng minh valid multi-file imports cả3ngônngữ và reject unavailableimports rõfile/line; TEST/OFFICIAL chungpolicy.
- Upload/IDE chung officialsubmissionpipeline; **test pipeline khác receipt/ordinal**. T3/T5/T8/T9 triển khai TEST_BUILD/TEST_GAME, OwnArtifactOrBaseline only, private HTTP/WS/replay, quota/officialreserve; UI Save/Test/Submit tách. Smoke editdraftduringtest giữtesthash, testcase hoànthànhkhôngcandidate/rating; uploadkhôngMonaco vẫnđược.
- Đã duyệt TEST mọi phase trước/sau deadline/lock/final/archive; không phasegate, vẫn quota/team/admission/readiness. Regression cùng late-project TEST được tạo nhưng OFFICIAL upload denied; TESTsuccess khôngcandidate/frozen/rating/receiptordinal sideeffect; không promote test receivedAt thành deadline receipt.
- Hạn là durable full-source receipt receivedAt server < submissionClosesAt. Đóng intake rồi drain tập đúng hạn tới READY/REJECTED, auto-lock max ordinal READY; readyAt sau hạn hợp lệ, infra pending/BLOCKED hoãn lock/start.
- Người dùng duyệt nộp lại trước khóa và tự chọn bản hợp lệ mới nhất; không captain selection. Sau khóa chỉ một version/artifact toàn giải; bản mới lỗi/pending giữ candidate cũ.
- Swiss/RR/Elo2ván cùng map đổi bên; knockout4–8ván, ADVANCED_ON_SEED sau hòa cuối, không double-forfeit. Swiss tự cấu hình theo02TR-03 baselineR/T, không giảng viên override.
- Loại trực tiếp độc lập tự random draw permutation/bracket/bye sau lock, seed commit/reveal và algorithm pin; không manual/rating seeding hoặc reroll/vòng. Draw index là tie priority. Playoff Swiss theo thứ hạng Swiss; không đổi Swiss/Elo thành random.
- Vòng tròn đã duyệt **cố định một lượt**, mỗi pair một encounter2ván; bỏ double-round config/API/UI.500đội có124.750encounters/249.500ván; regression mỗi unorderedpair xuất hiện đúngmộtlần.
- Swiss/vòng tròn đã duyệt điểm encounter thắng3/hòa1/thua0 sau aggregate2ván; game points1/0,5/0 riêng, Elo không cộng3–1–0. Regression thắng+thua hai ván→hòa encounter→mỗiđội1điểm, không3điểm.
- Runtime: 100 ms CPU mỗi active turn, 1000 ms wall time mỗi turn/startup, tối đa 300 ply; không ponder; gVisor fail-closed. Profile trong đặc tả 05 là nguồn quy định có thẩm quyền.
- Jobs: lease 30 s, heartbeat 5 s, reconcile 10 s; tối đa 3 attempts cho lỗi infra, backoff 5 s/15 s. Bot forfeit không được retry.
- PostgreSQL16 và localdurableobjects theo03AR-02; fsync/promote→durableDBaccept/outbox, khôngLSNpublicationbarrier/secondstore. UDSlocalworkloadidentity, Redis/SQLite khôngruntimeprerequisite.
- BackupconsistentoffhostPGbase/WAL+objectinventory theo05§6; targetRPO≤5min/RTO≤30min phải drill. Backupage>5min stopprotectedwrites/admission/execution/holdfinalize, publicreadonly; nozero-losswholehostclaim.
- Elo reset1200/K32 mỗi giải; E=max(8,4ceil(log2Nlocked)) theo02TR-05 là quyết định thiết kế baseline, không giả user đã chọn từng tham số. Eligibility/tie-break theo02, khôngcarryrating. Benchmark/reservedcapacity quyết ETA, khônghardstop; E+1chặn, retries khôngtăngE, withdrawal/chậm khônggiảmE; capacity thiếuBLOCKED.
- Key tournamentId/entryId, khôngcarry rating; giữarchive. Capacity Eepochs/500đội=250Eencounters/500Egames,trướcretry, khôngfixed14000/7days.
- Production gates: G0 — decisions; G1 — security; G2 — correctness/durability; G3 — capacity/endurance; G4 — operations/release, theo đặc tả 05.
- Migrate sạch mọi caller, test và docs; bỏ projection publication gate, default admin, unsafe production spawn và global casual Elo. Archive reader v1 chỉ đọc lịch sử, không ghi.
- Policy IDs baseline: `ArenaAutoFormat/v1`, `ArenaSwiss/v2`, `ArenaElo/v1`, `ArenaEloPair/v1`; quotas/rules/map/runtime/policy freeze registrationopen, resolvedN/R/T/E/frozenBot lock sau drain. Swiss/Elo exact generalgraph matching/canonical pairlist, khônggreedyfallback; thirdplaceOFF mặcđịnh. Phiên bản solver/draw+vectors phải pin và verify.

## Review Focus — Trọng tâm review

1. Race deadline hoặc sửa/xóa Bot sau lock: receipt đúng hạn được xử lý dù READY sau hạn; drain chưa xong không khóa, frozen artifact không đổi — T3.
2. Worker cũ gửi kết quả sau reclaim hoặc ack bị mất: chỉ có một accepted result, không cộng điểm hai lần — tests T4/T5.
3. Bot silent/flood/multithread và worker quá tải: kết thúc trong giới hạn, phân biệt lỗi Bot với infra, CPU của Bot inactive không tăng — tests T1/T5.
4. Correction sau khi seal Swiss/bracket và Elo hoàn thành không theo thứ tự: invalidation đúng, rating rebuild nhất quán — tests T6/T7.
5. Khách truy cập deep link/cache/private replay và nội dung mobile bị cắt: phạm vi public đúng, không mất control; `scrollWidth` đúng chưa đủ chứng minh UX — tests T8/T9 và bằng chứng kiểm tra thủ công.

---

## 1. Phân kỳ, phụ thuộc và phân công trách nhiệm

| Giai đoạn | Tasks | Kết quả bàn giao hoạt động được | Gate |
|---|---|---|---|
| A — Quyết định và kiểm chứng | T0, T1 | Profile sandbox khả thi; freeze luật và budget | G0, G1 execution |
| B — Control plane | T2, T3, T4 | Tài khoản đội, pipeline nộp bài, durable scheduling | G1 identity, G2 partial |
| C — Official engine | T5, T6, T7 | Game cô lập, 4 formats và correction | G2 |
| D — Trải nghiệm sản phẩm | T8, T9, T10 | Public/team/organizer portal hoàn chỉnh | UX gates |
| E — Launch | T11, T12 | Migration, capacity, recovery và go-live | G3, G4 |

Dependency DAG: G0→T1 vàT2; T1/T2→**T3a contract+source persistence handoff**; T1/T2/T3a→T4; T1/T3a/T4→T5; T3a/T4/T5→T6; T6→T7. **T3b integrated acceptance** sauT6 kiểm compile/TEST/lock với providers thật, không implementation owner thứhai. T3a không được đánh dấu T3 hoànthành; T4/T5 dùng contract handoff không chờ T3b. T6 smoke kết thúc PROVISIONAL và kiểm championcandidate; finalization smoke sauT7. T8shell sauG0, acceptance sauT3b/T7; T9 sauT5/T6/T8; T10 sauT6/T7/T8. T11design sớm, deploymentacceptance sau schema ổnđịnh; T12 sau mọi integratedacceptance. Khôngstub/mockadapter là deliverable hoặc prerequisite vòng tròn.

Không chốt lịch ngày trước khi có bằng chứng kiểm chứng. Baseline đề xuất là đội 4–6 người: 2 backend, 1 systems/security, 1–2 frontend, 1 QA/SRE; product owner là giảng viên, cùng independent security reviewer tham gia các gate. Sprint dài 2 tuần; ước lượng lại sau T1 và T4. Hiện chưa có dữ liệu để cam kết ngày launch hoặc chi phí. Mỗi task là một increment được kiểm chứng riêng; không release công khai tính năng nộp code trước G1.

## 2. Bản đồ tệp và nguyên tắc kiểm thử

Các tệp hiện có cần sửa được liệt kê trong từng task; đường dẫn mới mô tả thiết kế đích, không khẳng định tệp đã tồn tại. Chia `app.ts/db.ts/tournament-service.ts` khi chuyển trách nhiệm; không tạo layer chuyển tiếp để giữ business logic cũ. Migrate semantic contracts của tests hiện có; xóa các test về wording, default hoặc chi tiết implementation đã lỗi thời, không pin lại projection gate.

Quy trình chung cho mọi task: regression hành vi thất bại trước khi sửa → implementation tối thiểu → targeted tests → smoke thực tế qua route/CLI/UI → cập nhật specs/runbook/changelog → commit tập trung sau review. Các command bên dưới là **lệnh dự kiến thực hiện trong tương lai, chưa chạy**. Tên test và assertions mới là contract, không sao chép source text hoặc dùng mock chỉ lặp lại đầu vào. Chỉ T12 chạy full suite/build/load tổng hợp; targeted tests là chu kỳ kiểm thử của từng task, không để các agent chạy nhiều full suites trong lúc cùng sửa tệp.

### Contract registry và lệnh kiểm chứng task

03§6 là signatures/types canonical. T1 sở hữu Rust engine/native runner/supervisor, `execution.proto` và replay DTO/inspection schema; T2 tạo `contracts/{identity,commands}.ts`; T3 `contracts/{submissions,tests}.ts`; T4 `contracts/jobs.ts`; T5 `completion-v2.proto`, replay/public stream schemas và `contracts/results.ts`, phối hợp một integration owner cho generated shared files; T6 `contracts/tournaments.ts`; T7 `contracts/corrections.ts`. Migrate mọi caller/OpenAPI, không handwritten wire enum/song song TS gameplay authority. T3 `SubmissionCommands.create(tournamentId,teamId,source,ctx)`; T6 `TournamentCommands.lock/start`, `PairingPolicy.plan(input)`; T7 `finalize/previewCorrection/applyCorrection`; private queries truyền authenticatedActor, public queries chỉ publicDTO.

Mọi expected PASS dưới đây là **tương lai**, không command đã chạy. Failing-before phải vì behavior còn sai, không module chưa tạo/tool chưa cài/môi trường hỏng. UI không thêm test source-text/mockecho; dùng browser thật + servercontracttests.

| Task | Command target khi implementation | Smoke/evidence bắt buộc |
|---|---|---|
| T0 | `bash deploy/linux/preflight.sh --config deploy/linux/config.env --phase G0` sau T11 cung cấp script; trước đó review input checklist05 | Report thiếuinput/invalidprofile và secretredaction; không báo securitycertified |
| T1 | `cargo test --manifest-path crates/arena-supervisor/Cargo.toml --test sandbox_runtime --test timing_profile --test engine_ipc` | Bot3languages thật, CPU/freezer/cgrouplimits/killcleanup; canaries chỉ trong sandbox |
| T2 | `npx vitest run packages/server/tests/identity-production.test.ts packages/server/tests/teams.test.ts packages/server/tests/scope-privacy.test.ts` | ONLINEmailverify/reset; LANbulk→firstpassword→directenroll→reset, guestdenied |
| T3 | `npx vitest run packages/server/tests/submission-lifecycle.test.ts packages/server/tests/entry-freeze.test.ts packages/server/tests/deadline-quota.test.ts packages/server/tests/private-tests.test.ts` | ZIPmulti-file3languages, receiptdeadline/drainrestart, TESTaftercutoff noofficialeffect |
| T4 | `npx vitest run packages/server/tests/durable-jobs.test.ts packages/server/tests/scheduler-recovery.test.ts` | Local2supervisorprocesses/restart/stalefence/lostack, samehost only |
| T5 | `npx vitest run packages/server/tests/result-durability.test.ts packages/protocol/tests/replay-v2.test.ts` cùng targeted Rust native/WASM parity tests theo S02/S07 rebuild plan | Realgame→native verify→fsync→accept→download→WASM replay; build/game branch parity và crash boundaries, không obsolete TS runner test |
| T6 | `npx vitest run packages/server/tests/formats-500.test.ts packages/server/tests/pairing-policy.test.ts packages/server/tests/elo-epochs.test.ts packages/server/tests/official-maps.test.ts` | Smallreal4formats, N500scheduler/counts not executioncapacityproof |
| T7 | `npx vitest run packages/server/tests/correction-dependencies.test.ts packages/server/tests/finality.test.ts packages/server/tests/notifications.test.ts` | Preview/apply/stalepreview/ledgerrebuild/dispute-finalizerace |
| T8 | Existingaffectedwebtests only: `npm run test:web` nếu migrated suite còn behavioral tests | GuestSSR/noJS/deeplink + teamdraft/upload/receipt ởdesktop/mobile/keyboard |
| T9 | `npx vitest run packages/server/tests/live-resume.test.ts packages/server/tests/public-cache-policy.test.ts` | Disconnect/reconnect/restart/seek, privateTESTACL, bracketkeyboard/mobile |
| T10 | T6/T7/T2 targetedcontracts theo changedpath | Adminexplicitstart/pause/finalize/mapeditor, freshscreenshots/usability |
| T11 | `npx vitest run packages/server/tests/migration-v1.test.ts packages/server/tests/restore-consistency.test.ts` | v1clone migration/consistentrestore/localofflineassets/realalertack |
| T12 | Commands trongT12 cùng `npm run test:load` sau sửa benchmark và mixed-workload runner | Fourformats/fullRR/500teams/1000viewers/72h/7days, declaredhardware/rawreports |

Paths test mới trên là ownership đích, không khẳng định hiện tồn tại. T0 preflight acceptance ban đầu là review checklist/BOM; script chỉ được smoke sau T11, không circular dependency chặnT1. T11 smoke `bash deploy/linux/preflight.sh --config deploy/linux/config.env --phase G0` rồi validate profile/security evidence theo05. Secrets nằm ngoàiversioncontrol.

### T0 — Phê duyệt luật và phạm vi triển khai

**Files:** Review `docs/specs/v2/*`, `docs/research/2026-10-13-v2-platform-research.md`; cập nhật canonical docs và kế hoạch nếu quyết định thay đổi.

**Interfaces:** Nhận baseline01–05; bàn giao deployment configuration/BOM/policy digests, operator inputs validated và ownership G0. Không mở lại quyết định sản phẩm đã chốt nếu không có yêu cầu thay đổi.

- [ ] Đối chiếu baseline với06: bốn preset, Bot freeze/drain, LAN/ONLINE, mộtADMIN, multi-file/tests và UI/code reuse. Ghi riêng designer-defaults02/05; thay đổi cần revision/impact, không coi im lặng là user approval từng tham số.
- [ ] Điền deployment inputs theo03/05: mode, certifiedhost/BOM, origins/TLS, local data path, backup ngoài máy, owner/operator, budget envelope; ONLINE thêm SMTP/verified-sender/secret và thử delivery staging, LAN khôngSMTP/emailwall. Không OIDC/MFA/replication/remote-worker config.
- [ ] Operator và security reviewer kiểm threat model, accounts/files/socket/cgroup boundaries, retention/source notice và plan phục hồi. Chưa có evidence G1 thì chưa nhận code không tin cậy.
- [ ] Validate `DEVELOPMENT_CONFIG_READY` theo05§7.4: cấu hình/BOM/schema/môi trường cô lập đủ để T1 thực thi; evidence runtime/capacity/restore chưa sinh ghi PENDING_RUNTIME_PROOF, không fakehash hoặc yêu cầu completeG1–G4 trướcT1. Secret/provider đủ trước smoke tương ứng. `RELEASE_READY` chỉ sauT11/T12 fullproof; commit redactedBOM/decisionrecord, khôngsecret.

### T1 — Sandbox production và kiểm chứng CPU accounting

**Files:** Rebuild `crates/arena-engine/`, `crates/arena-runner/`, `crates/arena-supervisor/` và behavioral/conformance tests; source `packages/protocol/proto/{execution,replay-v2}.proto`, generated Rust/TS. Inventory references rồi migrate mọi engine/runner callers, tests/CLI/deploy; gỡ Node/TS v2 engine/game-host và obsolete child-spawn sau cutover, không shim/re-export. V1 historical reader giữ read-only.

**Interfaces:** Rust pure engine sở hữu gameplay02, validated state và cùng native/WASM semantics/revision; không IO/DB/identity/process privileges. Native runner consume immutable GameManifest qua private socket FD, initial evaluation trước INIT, correlated lifecycle/observations theo03; không hardcoded map/moves hoặc arbitrary Bot CLI paths. Supervisor nhận Build/RunGame/Terminate, sở hữu Bot FD/gVisor/freezer/accounting/watchdog/reaper, không rules/DB credentials. Generated execution/replay proto, u32BE ≤1MiB execution frame; bounded inspect VERIFY_TRACE/ANALYZE_MAP theo03, không launch Bot.

- [ ] Viết failing regressions: Bot không phản hồi INIT/TURN phải timeout hữu hạn; xử lý thiếu newline và output cap; hủy cả child descendants; production từ chối spawn khi gVisor không khả dụng; CPU của 2 tiến trình inactive/forked phải được freeze; compiler chịu giới hạn no-network/no-secret/read-only; cleanup khi callback lỗi.
- [ ] Chạy targeted Rust engine/native runner/supervisor và native/WASM conformance checks cùng sandbox_runtime/timing_profile/engine_ipc; failing-before vì behavior sai, không thiếu tool/module. Chứng minh GP-01–05, initial/terminal/illegal-move nonmutation, proximity25200/(distance+1), bounded allocation qua instrumentation; không timing/allocation claim chưa đo.
- [ ] Implement Rust engine/runner và launcher/freezer/accounting/watchdog/bounded IPC/spool theo generated contracts03. Watchdog không await runner/upload; host reaper hủy sandbox sau supervisor SIGKILL. INIT ply0/realTURN từ1, typed correlated observations, double startup fault/infra taxonomy. Limits05; pin ba toolchains và WASM; không native/runc/API Bot fallback.
- [ ] Đạt targeted tests trên Linux + cgroup v2 + runsc đã được chứng nhận; chạy starter Python/TS/C++ thực tế và adversarial canaries trên host cô lập. Ghi evidence về cold/warm timing, overhead, CPU overshoot và tài nguyên. Không chạy chương trình thù địch ngoài sandbox.
- [ ] Gate G1 execution do reviewer duyệt: không còn vấn đề critical/high chưa xử lý, CPU profile khả thi. Nếu không đạt 100 ms/1000 ms, dừng và đề xuất sửa spec trước T3, không dùng “best effort”. Cập nhật runbook và commit.

### T2 — PostgreSQL, identity và teams

**Files:** Thay trách nhiệm của `packages/server/src/db.ts`, `auth.ts`; tạo `src/persistence/migrations/001-control-plane.sql`, `src/identity/{service,routes,authorization}.ts`, `src/teams/{service,routes}.ts`; sửa `app.ts`, `index.ts`; tests: `packages/server/tests/identity-production.test.ts`, `teams.test.ts`, `scope-privacy.test.ts`.

**Interfaces:** Actor/CommandContext/Receipt theo03§6, transactional membership/admission/session-revoke và profile-specificauthorization; generatedAPItypes từ OpenAPI. T3/T4/T8/T10 dùng cùngregistry, không client-suppliedActor.
- [ ] T2owns admission substrate trong001-control-plane.sql: tournament/rule_revisions baseids/state/version/registrationwindow/limits/entries/admissions và validatedAdmincreate/publish/openAPI. Teams/admission smoke dùngpersistedgiải thật; T6migration005 chỉexpandmaps/stages/rounds/policies/lifecycle, không tạo lạibase tables. ONLINEcode dựasame substrate; uploadsmoke T2 deferredT3b, T2khép realadmission+scope khôngfakeuploadprovider.

- [ ] Identity regressions: PENDING_EMAIL login đúng password vẫn không session; chỉ verification token đúng purpose/user/emailRevision, chưa hết hạn/chưa dùng, mới ACTIVE; replay/concurrent consume denied; reset không kích hoạt pending; username/email unique; role escalation denied; scoped membership/session revoke.
- [ ] Admission regressions: sharedcode cho nhiều đội, mỗiteam chỉoneadmission; thiếu/sai/revoked/cross-tournament/windowclosed denied; concurrentjoin roster/capacity atomic; chưaadmit uploaddenied; code khôngpublic/logs; rotation codecũdenied/code mớijoinđược/admittedteams giữnguyên. Không per-teamcode paths.
- [ ] Email workflow: register→durable outbox→verify/resend→ACTIVE→login; forgot/reset token expiry/replay/race, no enumeration, session/token revocation, GET link không consume. Mail outage giữ pending/show status, không success giả/bypass; recovery không thay email binding chưa confirmed.
- [ ] Chạy identity/team/scope targetedtests; expected newcontractfailures.
- [ ] Implement PostgreSQL local identity/email verification/reset/outbox/scoped roles/teams/bootstrap và password re-auth; không OIDC/TOTP/MFA tables/routes/dependencies. Session/CSRF/rate-limit đầy đủ.
- [ ] ONLINE realstagingmail register→pendinglogin denied→verify→login→team→sharedcode→persistedadmission; reset→oldsessionrevoked. Upload/private-source end-to-end cases đóngT3b, không fakeuploadprovider để kýT2.
- [ ] Review auth/privacy; smoke organizer verified-email/password+scoped commands/re-auth, unauthorized role assignment denied; cập nhật docs/migration/runbooks và commit. Không scaffolds/stub recovery, không MFA scope.
- [ ] LAN realbulk/uniquetemporarypassword→limitedfirstchange→normal→Adminassign/directenroll→admissionqueries/ACL; studentrosterchangesdenied, resetrevokesessions, singleton/capacityrace. Studentupload được smokeT3b khi providercó, không prereqT2. ADMIN_ISSUED/LOCAL_BOOTSTRAP khôngemailwall/fakeverified, missingSMTP khôngchặnLAN.

### T3 — Submission bất biến, kiểm tra hợp lệ và freeze

**Files:** Thay `packages/server/src/bot-routes.ts`; tạo `src/submissions/{service,routes,artifact-store}.ts`, `src/tests/{commands,queries,routes}.ts`, migration `002-submissions.sql`; sửa match-service. Tests `submission-lifecycle.test.ts`, `entry-freeze.test.ts`, `deadline-quota.test.ts`, `private-tests.test.ts`; T4owns testjobdispatch/T5owns testexecution, T3owns snapshot/receipt/ACL/quota orchestration.

**Interfaces / milestones:** T3a bàn giao SourceUpload/ProjectSnapshot/SubmissionReceipt/TestReceipt, immutable object+receipt/quotas/ACL/schema và jobspec sauT1/T2. T4dispatch/T5execution/T6TournamentCommands.lock là providers riêng. T3owns intake/drain-set/candidate persistence, T6owns duy nhất locktransaction coordinating T3repositories. T3b sauT6 smoke fullpipeline với providers thật; T3 chưacomplete khi chỉcontracthandoff, khôngselectEntry.

- [ ] Regression: receipt ordinal/receivedAt sau full-source durability; upload bắt đầu trước nhưng nhận đủ sau hạn rejected; received đúng hạn READY sau hạn vẫn selected; builds đảo thứ tự khôngghiđè; drainrestart cùng eligible set; pending/infraBLOCKED ngănlock; REJECTED fallback bản READY cũ; sau khóa giữhash; scope/quota/ZIP/idempotency như01.
- [ ] Chạy `npx vitest run packages/server/tests/submission-lifecycle.test.ts packages/server/tests/entry-freeze.test.ts packages/server/tests/deadline-quota.test.ts`; xác nhận FAIL trước implementation.
- [ ] **T3a:** source/artifact persistence, receipt/ordinal/deadline, project/test snapshot+ACL/quota, eligible drainset/candidatequeries và durableenqueue contracts. Smoke realupload→fsyncreceipt→readhash→cutoffdeny/ACL/ZIP, không giảREADY hoặcrunTEST khi provider chưa có. Bàn giao schema/manifest/API choT4/T5, chưacompleteT3.
- [ ] **T3b sauT6:** tích hợp T4dispatch/T5build+INIT/testexecution và T6lock. Smoke uploadv1→READY→v2auto-replace→drain→lock; v3lateOFFICIALdenied, TESTafterlock/archive chạy thật khôngordinal/candidate/rating. Restartdrain/infraBLOCKED/out-of-order và frozenhash/jobinputs khớp; mớiđánh dấuT3complete.
- [ ] Cập nhật hướng dẫn SDK, giới hạn và cách xử lý source; commit. Không chạy compiler trong HTTP event loop.

### T4 — Durable jobs, leases, admission và restart

**Files:** Create `packages/server/src/jobs/{broker,reconciler,scheduler,admission}.ts`, migration003-jobs.sql; modify index/app/tournament wiring; worker entry `crates/arena-supervisor/src/main.rs` và broker.rs, không tạo TSworker cạnh nativeworker; tests durable-jobs/scheduler-recovery.

**Interfaces:** `JobBroker.claim/heartbeat/prepareCompletion/complete`, `LeaseIdentity`, `PinnedCompletion`, `SlotOffer` theo03. Worker chỉ prepare có fence; complete do trusted reconciler, không worker SQL.

- [ ] Failing tests:2schedulers chỉ một round;2workers claimonce; stale lease fence denied;heartbeat5s/lease30s; FIFO/fairness và reserve compile/official; restart byes/pairings/jobs; infra3attempts backoff5/15s→BLOCKED. Không practice queue.
- [ ] Chạy targeted job tests; quan sát FAIL như kỳ vọng.
- [ ] Implement SKIP LOCKED claim, scheduler lease/unique keys, durable transitions và local Unix-socket workload identity theo03; global admission/readiness. Supervisor không DB/API secrets, không privileged API hoặc remote-worker certificate layer.
- [ ] Đạt tests; smoke scheduler thực tế cùng 2 worker processes: dừng một worker giữa claim/complete, restart API/scheduler, quan sát job inputs không đổi, resume đúng và không có duplicate. Không dừng service của người dùng; dùng deployment riêng cho kiểm thử.
- [ ] Tài liệu hóa readiness/drain/emergency và commit; bỏ lifecycle chỉ lưu trong RAM sau khi chuyển toàn bộ caller.

### T5 — Execution có thẩm quyền, result ledger và replay v2

**Files:** `crates/arena-runner` inspect mode/engine trace integration, Rustsupervisor IPC/spool; server results acceptance/verifier/outbox và submissions build acceptance, migration004-results.sql; protocol codecs/replay; `packages/protocol/proto/{execution,completion-v2,replay-v2,public-stream-v2}.proto` và generated Rust/TS; browser Rust WASM replay consumer. V1 proto reader giữ archive, không hai wire authorities. Tests result-durability/replay-v2 và Rust native/WASM manifest parity thay obsolete TS runner test.

**Interfaces:** `CompletionEvidence` BuildCompletion/GameCompletion union và branch receipts theo03§6; một broker/reconciler acceptance, không direct recordResult authority. Server gọi native `inspect VERIFY_TRACE`, browser dùng cùng engine WASM seek/render; không TS gameplay verifier thứhai. Evidence durable trước DBpin, promote toàn objects trước atomic branch commit; không replay/winner/resultVersion giả cho BUILD/TEST_BUILD, infra retry/BLOCKED không SOURCE_REJECTED.

- [ ] Regressions IPCbounds/requestcorrelation/timing/trace/replaychecksum; validprepare và completionpending khôngrecompute; duplicate/lostack/stalefence; crash trước/sau fsync/atomicrename/DBcommit/outbox; acceptedpointer/replayconsistency; diskfull vàcorruptobject noaccept; legacyreplayversion. Khôngstandby/failoverreplicationtests.
- [ ] Crash ngay sau durableDBpinCOMPLETION_PENDING nhưng trướcimmutablepromotion, kill supervisor gốc rồi restartbroker/reconciler: toàn evidence đãfsyncfile+parent và stagingkeys persisted, protectedGC; reconcilerfinishaccept một lần khôngrecompute. Fault trước stagingfsync khôngpinpending; missing/corruptpin làintegrityblocker, khôngfallbackaward.
- [ ] Chạy targetedresult/replay/manifesttests; FAILconsumerbehavior trướcf ix,khôngsourcewiringassertions.
- [ ] Implement single-hostAR-02 localstoragefsync/atomicpromotion+PostgreSQLdurabletransaction+outbox, prepare/deliveryreconcile/stalegenerationchecks. Snapshot/provenance/SDKparity; observercleanup đảm bảo, noLSNpublicationlayer.
- [ ] T5/S07 smoke realpairedgame→accept/download/verify/replay, processkill/crash/lostack/pinnedcompletion recovery và localdurability/counts. **Cross-session acceptance:** consistentoffhostPG+objects backup/restore/hashproof cầnT11provider, đóngT11/S15; chưa kýG2restore trước đó, không fakepass hoặc tạo backup pipeline thứhai. Providerdurabilityhandoff choT6 không phải toànG2done.
- [ ] Cập nhật protocol/SDK docs và third-party notices; bỏ wire enum/schema viết tay song song; commit.

### T6 — Bốn preset và deterministic scheduling

**Files:** Thay `packages/server/src/tournament-service.ts`; tạo `src/tournaments/{commands,pairing,swiss,round-robin,knockout,elo-arena,reducer}.ts`, server `src/maps/` adapter tới Rust native `inspect ANALYZE_MAP`, migration `005-tournaments.sql`; tests: `formats-500.test.ts`, `pairing-policy.test.ts`, `elo-epochs.test.ts`, `official-maps.test.ts`. Tournament policies/exact matching vẫn TypeScript; không TS map/game semantics authority thứhai.
- [ ] Admin mapauthoring/version/pool/hash, hard validation và non-blocking symmetry/imbalance/connectivity warnings. Server `src/maps/{commands,validation,routes}.ts`, maps/map_versions/tournament_maps migration, web `features/organizer/maps/`. Tests asymmetric/disconnected/unequalroster accepted; invalid coords/IDs/IPC bounds rejected; missing-species/initial-terminal behavior02; pool/versions immutable trước intake. Smoke create→warningsconfirm→assign→run/render; publication policy theo task tiếp.
- [ ] Map visibility regressions: PUBLIC_BEFORE_SUBMISSION và REVEAL_AFTER_BOT_LOCK, pool/policy pin trước intake; salted commitment không lộ map IDs/digests; hidden map denied HTTP/WS/SSR/preview/export/download và TEST trước reveal. INIT-smoke dùng fixture công khai. Lock sau drain→durable reveal/salt verification; restart không reveal sớm hoặc đổi pool. Public-history map không được quảng cáo secret. Files/DTO/storageACL/testmapselector cập nhật cùng task; actual guest/team check trước/sau lock.

**Interfaces:** `PairingPolicy.plan`, `PairingInput/PairingPlan`, `TournamentCommands.lock` và sealed round snapshots; nhận frozen entry từ T3, jobs từ T4 và results từ T5.
- [ ] T6owns roundautoseal: persistlastTerminalAt/sealEligibleAt/grace10min, genericdurableblockers, restart/SEALED→nextSwiss/playoff/Elo commit; T7consume/extend blockers với disputes/correction, không duplicate timerowner. T6positiveAdminstart chỉaccept khiformatfirstdispatch thật, trướcđócontracthandoff/denials khôngRUNNINGno-op.

- [ ] Fixtures N2/3/16/500, bracket/byes/singleRRcounts, SwissR/T, finite8gameknockout, objectiveweights sauwithdrawal/timeoutBLOCKED; EloequalratingK32S1→±16, completion permutationssameepochrating, autonomousresume/stopE/eligibility baseline02. Không fake games cho bye/EMPTY; có NO_CHAMPION/disqualification/correction.
- [ ] Baselinepolicyfixtures: Swissbye tuple byeCountasc/pointsasc/seeddesc, topTactive trướcplayoffdraw và EMPTYsaudraw; Elopair minimizepriorcount→microratinggap→drawgap, canonicaltie/10sBLOCKED; eligibility encounters khônggames (N2/E8→8/1,N3/E8→5/2,N500/E36→8/8). Withdraw serialize vớifirstclaim, hoànthành cảencounter đãstart; upheldDQ voidtoànstage và rebuild; INVALID_START_BOTH_SIDES làNO_CONTESTkhôngseedfallback. Map3–64/caprequest256KiB, hardonlyschema/resource; acceptimbalance.
- [ ] Chạy 4 tệp targeted tests; xác nhận FAIL trước implementation.
- [ ] Implement baseline02: Swissautoconfig, singleRR, finiteknockout, Eloepochs với snapshotrating/seal/autonext/eligibility và stopE; khôngfixed4epochs/day. Capacitypreview từbenchmark/budget, khôngrerank theo workercompletion.
- [ ] Smoke giải nhỏ thật từngformat tớiPROVISIONAL/championcandidate, N500scheduler/counts/pairingbenchmark theohardware. SauT7 mới chạyfinalize→FINALIZED toànluồng. Khôngcoi schedulerfixture là fullRRexecution/capacityproof; measure T12.
- [ ] Bỏ quảng bá DoubleElimination, old global Elo và projection gate; cập nhật format docs và commit.

### T7 — Disputes, corrections, finality và announcements

**Files:** Tạo `src/results/{corrections,rebuild,disputes}.ts`, `src/tournaments/announcements.ts`, migration `006-adjudication.sql`; sửa routes; tests: `correction-dependencies.test.ts`, `finality.test.ts`, `notifications.test.ts`.

**Interfaces:** `ResultCommands.previewCorrection(gameId,command,ctx)` / `applyCorrection(gameId,command,previewDigest,ctx)` và `TournamentCommands.finalize(tournamentId,ctx)` theo03§6; ctx cóactor/expectedVersion/idempotencyKey/requestId. T7owns correctiontypes, nhận dependencygraphT6/ledgerT5, bàn giao revision/invalidation/audit/outbox. Khôngcorrectalias/arbitrarywinner.

- [ ] Regression T6autoseal với T7dispute/correctionblockers/restart; finalstagePROVISIONALkhôngautofinalize, STUDENTdenied, ADMINchốt onlyafterwindow/no blockers/ranking; duplicate/lostackreceipt/finalsnapshot. Swiss/bracketinvalidate/RRrescore/Eloepochrebuild/stalerevision/NO_CHAMPION/audit/notifications.
- [ ] Chạy targeted tests; xác nhận FAIL.
- [ ] Implement Admin-configurable finalAppealWindowMinutes trướcregistration,0hợp lệ,immutable/timezone/serverdeadline rõ; nofixed24h/autofinalize. T7test0/positivewindow,clockboundaries,opendispute blocking và create-dispute/finalize race/idempotency; manualfinalize re-auth/evidence/ranking/audit. Notificationwindowkhôngscorechange,correction/rebuild/outbox đầyđủ.
- [ ] `finalAppealWindowMinutes` integer0–10080 default1440, roundgrace10min theo02. Frozenpolicy từregistration, window chỉgia hạn cóaudit/thôngbáo; expiry khôngautoaward; N0eligibleEloNO_CHAMPION thayPROVISIONALvôhạn. Validateboundary/whole-stageDQ/correction và create-dispute/finalize serialization.
- [ ] Đạt tests; smoke organizer preview correction → confirm → audit → rebuild → public revision, cùng notification cho đội. Verify evidence gốc được giữ lại.
- [ ] Cập nhật adjudication runbook và commit. Không có trình sửa điểm thủ công tùy ý.

### T8 — Competition portal, teams và submission UX

**Files:** Chuyển `packages/web` thành một Next app: tạo `src/app/{layout,page}.tsx`, route groups public/workspace/organizer, `src/features/` và design system; cập nhật package.json/tsconfig, tạo next.config.ts; migrate API client, Canvas, Timeline, BotEditor. Gỡ App.tsx/Vite entry/config/index.html khi cutover; không duy trì hai portal. Route paths theo04; public SSR và private no-store.

**Interfaces:** Route/API contracts theo đặc tả 03, tokens/screens theo đặc tả 04; nhận DTO thực từ T2/T3/T6/T7; bàn giao public portal và team workspace. Mocked data không được coi là hoàn thành.
- [ ] Trước integrated S12 portal, owner duyệt ba màn đại diện theo rebuild plan: public directory/overview, team IDE, organizer operations ở1440×1000 và390×844, empty/loading/error/limited scope; fixture nhãn thường trực “Bản thiết kế — dữ liệu minh họa, chưa thực thi”. Preview không là feature/runtime proof.

- [ ] Áp dụng shadcn/ui + Tailwind, dark navy/violet/cyan theo04§4, light phụ; hero/tỉ số lớn, Admin giảm artwork. Người dùng xác nhận đã được phép sao chép code các nguồn đã nêu: copy/adapt phần hữu ích sang React/Tailwind, không mua template/thêm WordPress hoặc Bootstrap stack. Inventory nguồn/phiên bản/files, phạm vi đồng ý và notices; không suy quyền với ảnh/logo/font/dependency. Self-host assets, review tiếng Việt/contrast/reduced-motion; đổi theme không mất draft/filter/cursor.

- [ ] Browser journeys: nộp/receipt trước hạn→intakeclosed→validation sau hạn→candidate→frozen; pending/infra không báo đã khóa; bản mới lỗi giữcũ; out-of-order đúngordinal; khôngmanualselection/luyện tập; draft/log scope đúng.
- [ ] Implement public SSR từ public DTO: HTTP404, canonical/OG/title; Canvas/Monaco client boundaries; private no-store và cache partition. Không Server Actions hoặc backend domain thứ hai. Một component variant, canonical routes/query filters, tiếng Việt, server clock, READY pipeline/upload fallback/private workspace/notifications và đầy đủ trạng thái lỗi/chờ.
- [ ] Chỉ chạy các web tests hiện có bị ảnh hưởng; kiểm tra bằng browser thực tế ở desktop 1440×900 và mobile 390×844, hành trình bàn phím và refresh deep link. Quan sát source riêng tư và network DTO. Screenshot chứng minh UX gates trong đặc tả 04, không chỉ dựa vào DOM `scrollWidth`.
- [ ] Cập nhật user help, asset license inventory và changelog; commit. Bỏ board demo làm landing page và cách truy cập tournaments chỉ qua sidebar.

### T9 — Public live/replay, standings và projection tùy chọn

**Files:** Sửa `packages/server/src/ws-hub.ts`; tạo `src/live/{gateway,chunks,queries}.ts`; sửa `packages/web/src/api/client.ts` và các tệp timeline/Canvas hiện có; tạo `src/features/matches/`, `src/features/tournaments/standings/`, `projection/`; tests: `live-resume.test.ts`, `public-cache-policy.test.ts`.

**Interfaces:** Frame v2 (seq/attempt/protocol) theo đặc tả 03, replay từ T5, snapshot từ T6; bàn giao anonymous read/playlist, không cung cấp control command.

- [ ] Failing tests:seqduplicate/gap/backoff;gatewayrestartcatchup;slowclient>1MiBdisconnect;terminalinfra;anonymousofficialdeeplink;private source/build logs không qua publicmatch/cache; playlistkhôngđổiđiểm/tiếnđộ. Không practiceviewer.
- [ ] Chạy server live/privacy tests; xác nhận FAIL.
- [ ] Single-gateway boundedchunks≤20ply/2s/TTL10min,restartcatchup,private/publicDTO/replayreaders/pagination/bracket/keyboard/projection; khôngmulti-replica polling/pubsub/Redis. PrivateTESTstreams/replay ACL giống01/03,khôngofficialsideeffects.
- [ ] Bracket dùng brackets-viewer.js client-only với official DTO, dispose khi đổi route/unmount; không dùng bracket-manager để tính pairing/điểm. Theme cùng04§4, smoke bye/forfeit/void/EMPTY/correction/stale revision, hai ván trong encounter; Swiss/Elo dùng standings/match list. Có link semantic và danh sách tương đương cho mobile/keyboard/screen reader. Không render DOM library trong SSR hoặc duy trì renderer thứ hai.
- [ ] Đạt tests; kiểm tra bằng browser thực tế: guest match → disconnect → reconnect → seek/share turn; restart relay và kiểm tra board hiển thị trên mobile. Thu evidence về giao diện và accessibility. Không tự phát audio; không dùng confetti khi reduced motion.
- [ ] Cập nhật public viewer/protocol help và commit; bỏ project-next publication policy cùng các kỳ vọng client/test lỗi thời.

### T10 — Organizer console và trải nghiệm học tập

**Files:** Tạo `packages/web/src/features/organizer/{wizard,operations,adjudication}/`, `src/features/workspace/tutorials/`; sửa server queries khi contract cần dữ liệu thực; tests kiểm tra permission/transition behavior của server commands.

**Interfaces:** Commands từ T6, correction impact từ T7, health từ T4, build từ T3. Frontend không phải nguồn có thẩm quyền về permission.

- [ ] Wizard không input rounds/topSwiss: preview auto-policy với Nhiện tại, sau lock dùng resolvedN/R/T. Fixtures N2→R1/T2,N3→R2/T2,N16→R4/T4,N64→R6/T8,N500→R9/T16; withdrawal không đổi cấu hình. Resourcegate/permission/pause/infra/finalize và hash frozen kiểm thực tế.
- [ ] Wizard/ops/adjudication, seal/finalize/corrections impact-confirm và recent password re-auth, không MFA; announcements/CSV/user help/replay analysis đầy đủ.
- [ ] Chạy targeted server tests; browser thực: giảng viên tạo→publish→drain/lock→READY_TO_START (chưa officialjobs)→bấm Bắt đầu→đóng tab→rounds tự chạy→pause/resume→provisional→Adminfinalize. Sinh viên đọc reason/log/replay giải thích Bot thua, public không thấy source/log.
- [ ] Tổ chức usability sessions với ≥ 5 sinh viên/2 giảng viên (mục tiêu đề xuất); ghi task completion/issues, sửa các luồng bị chặn. Kiểm tra accessibility bằng bàn phím/screen reader, kết hợp thủ công và automation; cập nhật help và commit.

### T11 — Migration, triển khai, observability và recovery

**Files:** Tạo `packages/server/bin/migrate-v1.ts`, `src/operations/`, deployment manifests có phiên bản và runbooks; sửa `Dockerfile.server`, `Dockerfile.web`, `docker-compose.yml`, `.github/workflows/ci.yml`, `README.md`; tests: `migration-v1.test.ts`, `restore-consistency.test.ts`.

**Interfaces:** Schema T2, ledger T5, state T6; bàn giao deploy/config và legacy archive verified theo03/05. Create `deploy/linux/{compose.yml,bootstrap.sh,preflight.sh,backup.sh,restore.sh}`, `deploy/linux/config.example.env`, `deploy/linux/bom.json` và `docs/runbooks/{deployment,incidents,backup-restore,migration}.md` khi triển khai; example khôngsecret, không cloud-provider-specific runtime. Packaging runsc/cgroupservice phải phù hợp boundaries05, không privilegedAPI.

- [ ] Viết failing fixtures: owner của Bot cũ trở thành đội 1 thành viên; thiếu revision được đánh dấu `LEGACY_UNVERIFIED`; archive legacy Elo; báo mismatch giữa replay BLOB và disk; không resume giả trạng thái `RUNNING` của v1; nhất quán count/hash/FK; rollback sau khi v2 đã ghi không thể khôi phục bằng SQLite cũ.
- [ ] Chạy migration/restore tests; xác nhận FAIL trước implementation.
- [ ] Maintenanceexport/import/objectschecksum/versionedmigrations/bootstrap/session/mailsecrets,localworker auth/isolation/audit/metrics/outbox,consistentbackup/PITR/restore vàCIimages/SBOM/notices. Khôngsyncstandby/replication/clusterconfig/MFAdeps hoặcAPIprivilegedruntime.
- [ ] Đạt tests; migration/restore theo giai đoạn trên bản sao dữ liệu thực đã redacted; kiểm tra public legacy replay và upload mới thực tế. Gây DB/storage outage rồi restore, đo RPO/RTO/replay hash/scope. Verify người trực on-call nhận và ack page, không chỉ kiểm tra metrics endpoint.
- [ ] Operator và security reviewer review runbooks, cutover/rollback compatibility; commit. Không public lên Internet trước G1 và G4.

### T12 — Tổng diễn tập và launch gate

**Files:** Tạo `tests/load/{mixed-workload,capacity,soak,recovery}.ts` (hoặc dùng load tool đã duyệt), fixture generators và benchmark report; sửa correlation trong `tests/load/websocket-load.ts` hiện có hoặc bỏ benchmark gây hiểu nhầm; cập nhật full suite/contracts hiện có.

**Interfaces:** Platform thực đã triển khai từ T1–T11; bàn giao reports G3/G4 có số đo và quyết định readiness cuối cùng, không phải feature scaffold.

- [ ] Viết behavior/load assertions cho sequence correctness, accepted result duy nhất, rating/standings rebuild, queue bounds và deadline burst thực tế của 500 đội. Không dùng average message size làm gate cho max frame.
- [ ] Chạy `npm test`, `npm run build --workspace=@oantuti/web` (Next build sau migration), `cargo test --manifest-path crates/arena-supervisor/Cargo.toml`, `cargo clippy --manifest-path crates/arena-supervisor/Cargo.toml -- -D warnings`, protocol/codegen/type/deploy validation sau integration. Expected zero errors, ghi output thực tế; smoke public HTML/metadata khi JS tắt và private cache không PII.
- [ ] Smoke thực tế bốn preset trên deployment cô lập có cấu hình tương đương production, sau đó chạy mixed workload thực với 500 đội/1000 khán giả ẩn danh, full RR gồm 249500 baseline games cộng headroom cho retry/tie. Ghi phần cứng, phiên bản và chi phí. Nếu không đạt deadline, bổ sung tài nguyên hoặc sửa kế hoạch trước khi publish, không giảm tuyên bố để che thiếu hụt.
- [ ] Chạy soak 72 h và diễn tập 7 ngày với worker loss/reconnect/backup/secret rotation, không có admin tab mở; dùng Bots đã được chứng nhận và các peak windows. Verify SLOs/recovery/security review theo đặc tả 05; xử lý hết incidents còn lại.
- [ ] Giảng viên, operator và security reviewer ký G1–G4; publish release/runbook/user help/changelog/evidence report và commit. Không đạt nghĩa là `NOT READY`, không đưa beta users vào chạy code thiếu an toàn.

## 3. Bao phủ yêu cầu và bàn giao

| Yêu cầu | Task chịu trách nhiệm |
|---|---|
| PR-01 / 500 đội | T2, T3, T6, T12 |
| PR-02 / Bốn preset | T6, T7, T12 |
| PR-03 / Tự động nhiều ngày | T4, T7, T11, T12 |
| PR-04 / Khán giả truy cập công khai | T8, T9, T10 |
| PR-05 / Code không đáng tin cậy | T1, T3, T5, T11 |
| PR-06 / Provenance | T3, T5, T11 |
| PR-07 / Recovery, không ghi nhận hai lần | T4, T5, T7, T11, T12 |
| PR-08 / UI/UX accessibility | T8, T9, T10 |
| PR-09 / Operations và migration | T11, T12 |
| GP/TR rules | T1, T5, T6, T7 |
| Local identity/email verification/recovery/scoped roles/password re-auth | T2,T8,T11 |
| LAN provision/first-password/team assignment/direct enrollment/recovery | T2,T8,T10,T11,T12 |
| ONLINE register/verify/reset/mail outage/session revocation | T2,T8,T11,T12 |
| Multi-file SDK/build/import/ZIP bounds và private tests mọi phase | T1,T3,T5,T8,T9,T12 |
| Admin map editor/visibility commitment/reveal/resource-only validation | T5,T6,T9,T10 |
| Explicit Admin start/finalize/dispute race/correction/NO_CHAMPION | T4,T6,T7,T10,T12 |
| UI source reuse/dark tokens/bracket/keyboard/mobile/offlineassets | T8,T9,T10,T11,T12 |
| Submission quota/kiểm tra hợp lệ/tài liệu hướng dẫn |T3,T8,T10|

Baseline và roadmap giữ đủ scope; rebuild hiện chỉ thực hiện S01, không tuyên bố task/gate complete. Canonical numbering giữ S10=T3b/S11=T7/S12=Next/S13=viewer/S14=admin/S15=ops/S16=capacity/S17=endurance, không bỏ S04. G1 exact-target/Rust native-WASM, recovery/capacity/endurance/usability phải nghiệm thu lại; historical reports chỉ là evidence chưa accepted, không tự publish/deploy/enable intake.
