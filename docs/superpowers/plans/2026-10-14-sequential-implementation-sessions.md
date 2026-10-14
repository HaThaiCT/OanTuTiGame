# OanTuTi Arena v2 — kế hoạch triển khai theo phiên tuần tự

> **For agentic workers:** REQUIRED SUB-SKILL khi thực thi: `subagent-driven-development` hoặc `executing-plans`. Đây là lịch chia phiên của kế hoạch T0–T12, không thay baseline hoặc tự xác nhận task đã hoàn tất.

**Goal:** Triển khai từng increment có evidence, tiếp nối được giữa các phiên, đến sản phẩm đủ G0–G4; không bỏ scope khi một phiên bị chặn.

**Architecture:** Một Linux host chạy Next/Fastify/PostgreSQL/local durable objects và Rust supervisor qua UID-bound Unix socket; compiler và mỗi Bot có gVisor sandbox riêng. Không cluster/remote workers/replication hoặc execution VM mặc định.

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
| S02 | T1 | Supervisor/sandbox/watchdog/generated IPC thật cho3ngônngữ | Isolation/accounting proof, không unsafe fallback |
| S03 | T2 LAN/core | PostgreSQL/migrations/sessions/oneADMIN/LANaccounts/teams | LAN auth/admission và temporary-password transitions đúng |
| S04 | T2 ONLINE | Verification/reset/mailoutbox/sharedcode và profile isolation | ONLINE real staging mail + LAN không phụ thuộcSMTP |
| S05 | T3a | Immutable source/project receipts/quotas/ACL/manifests | Handoff contracts/schema; **T3 chưa complete** |
| S06 | T4 | Durable dispatcher/lease/fencing/restart/admission | Jobs chạy/resume trên local processes không doubleclaim |
| S07 | T5 | Real execution/result ledger/replay/SDK parity | Durable acceptance/trace/replay + crashproof |
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

**Preparation entry:** [Inventory/prerequisites/provisioning packet](2026-10-14-preimplementation-preparation.md). Disk hiện snapshot305MB/df100% và baseline docsuntracked là blockers trước tải tools/images/build/worktree; bảotoànbaseline và giải quyếtheadroom trướcprovisioning. Packet khôngđánh dấuS01done.

- [ ] Kiểm trạng thái repo/workspace, giữ nguyên thay đổi người dùng; xác định commit/base và integration owner, không reset/clean.
- [ ] Inventory thực host/tools/source/template permission artifacts có thể truy cập; không lấy thông tin từ memory làm factual state.
- [ ] Resolve/pin exact versions/digests/support sources theo BOM workflow. Kiểm tool prerequisites và paths trước chạy commands; thiếu tool không gọi là regression.
- [ ] Điền inputs phát triển cô lập theo05: profile, OSroles/origins/TLS/data paths/backuptarget/contacts. ONLINE secrets/mail và LAN CA/perimeter theo profile; không hỏi lại dữ kiện tools/repo cung cấp được.
- [ ] Phân biệt `CONFIG_READY`, `PENDING_RUNTIME_PROOF`, `BLOCKED_INPUT`; G1/capacity/restore chưa chạy không được giả complete. Chưa có preflight scriptT11 thì dùng config checklist/schema validation, không chặn T1 vì đợi script chưa tồn tại.
- [ ] Bàn giao BOM/config manifest redacted và blockers cụ thể. Thiếu hạ tầng runtime an toàn ngănS02; các việc reachables hoàn tất, không tự dùng native fallback.

### S02 — Sandbox và IPC

**Owner/files:** masterT1, `crates/arena-supervisor/`, runner game-host và execution.proto; generated types dùng chung.

- [ ] Implement launch/build/perBotisolation, CPU/freezer/process-tree accounting, independentwatchdog/reaper, bounded IPC.
- [ ] Run targeted Rust/game-host checks masterT1; smoke starterPython/TS/C++ và canaries cô lập.
- [ ] Chứng minh no-network/no-secret/cleanup/100msCPU+1000mswall/300ply theo05. G1execution failure dừng, không profile downgrade.
- [ ] Reviewer đọc evidence/security boundaries; report host/BOM/digests/counters và pass/fail từng constraint. Internal local fixtures không mở submissionspublic.

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

- [ ] Wholeproject hashes/ZIP validation/128files/256KiBfile/4MiBexpanded/2MiBZIP, immutablefsync receipt/ordinal/cutoff/quota.
- [ ] Draft/Test/Submit tách, ownteam/ADMINsubmitted-source read audit; private test snapshot không official ordinal.
- [ ] Real upload→durablereceipt→readback/hash/restart/ACL/cutoffdeny smoke, handoff queue payload schema choS06/S07.
- [ ] Không fake READY/test result. Đây là **T3a handoff**, không đánh dấu T3complete; integrated cases scheduleS10.

### S06 — Durable jobs

**Owner/files:** masterT4 migrations/jobs broker/reconciler/scheduler/admission, contracts/jobs.

- [ ] UDSUIDidentity, SKIPLOCKED/uniquekeys, lease30s/heartbeat5s/reconcile10s/fences/generation.
- [ ] Slots/reserve/buildofficialTESTpriority,3infraattempts/backoff5/15s/BLOCKED; noBotforfeitretry.
- [ ] Local2supervisorprocesses smoke claim/restart/oldfence/recover, not twohostdeployment. T5result provider not yet accepted pipeline; no syntheticresult marked real.

### S07 — Engine/result/replay

**Owner/files:** masterT5, results/verifier/outbox/replay/proto/SDK paths.

- [ ] Versioned semantics/init/actiontrace, threeSDKparity, runtime verdict vs infrastructure distinction.
- [ ] Broker evidencefsyncfile+parent beforeCOMPLETION_PENDING DBpin, stagingrefs/GC hold; independentreconciler immutablepromotion/durableaccept/outbox.
- [ ] Realgame→traceverify→accept→download→replay; kill boundaries/lostack/stalefence/no doublescore, originalsupervisor absent recovery.
- [ ] Consistent off-host backup/restore còn PENDING_PROVIDER_T11 tớiS15; S07khép crash/restart/localdurability, chưa ký toànG2restore. Không yêu cầu backup pipeline chưa implement trước khi sangS08, khôngbỏ nghiệmthu release.
- [ ] PrivateTESTexecution engine supported but API full journey completion deferredS10. V1archiveversion remains readable.

### S08 — Map/version/lock/start

**Owner/files:** masterT6 maps and lifecycle, T3repositories consumed; T6soleTournamentCommands.lockowner.

- [ ] Adminmap authoring/version/pool/resourcevalidation, unbalanced/disconnected/occupiedthrone warnings not fairnessrejection; initialterminal evaluation.
- [ ] PUBLIC/HIDDENcommitment policy frozenbeforeintake; metadata/storage/cache/privateTEST hidden-map denial; durable reveal afterdrain/lock.
- [ ] Atomic frozeninputs/lock/reveal và startcommand persistence/authorization contract; smoke noofficialclaim trướcstart, STUDENTdenied, thiếucapacity/provider denied. **CONTRACT_HANDOFF**: positive start→firstofficialdispatch chỉ nghiệmthuS09 khiformatproducer đãcó, khôngRUNNINGno-op.
- [ ] Real API mapcreate→warnings→pool→receipt/drain/lock→reveal; startpositive cònpendingS09. FullmapeditorS14; S08khôngkýcompleteT6 hoặcfakefirstjobs.

### S09 — Four formats

**Owner/files:** masterT6 policies/reducer/pairing/elo; consumeS08frozeninputs/S07ledger.

- [ ] Exactmatching/canonicaltiebreak/timeoutBLOCKED, policy IDs02, randomknockout/Swissplayoff/RR/Elo1200K32Eauto.
- [ ] S09/T6 sở hữu durable lastTerminalAt/sealEligibleAt, grace10min, autoseal khi no blockers và next-round/Swissplayoff/Eloepochcommit dispatch. Realclockgrace/restart smoke; blocker state được persist từđầu, S11 thêm dispute/correction paths khôngimplementationautosealthứhai.
- [ ] Đóng S08positiveacceptance: Adminstart→atomicRUNNINGgate→realfirst-round/jobs/game, doubleclick/lostacksame receipt, restartREADY_TO_START khôngstart/RUNNINGresume. Capacity proof dùng fixture workload thật measuredslots côlập, không giả full500capacity.
- [ ] Bye/walkover/EMPTY/NO_CONTEST/NO_CHAMPION/withdrawal/DQ/dependency handling; nofakegames/rating.
- [ ] N2/3/4/5/10/16/64/500fixtures and real small fourformat tournaments tớiPROVISIONAL; Swiss→playoffauto, không Adminstartlần2.
- [ ] S09 không tựfinalize: providerS11; schedulerN500 khôngcapacitycertification.

### S10 — Submission/privateTEST end-to-end T3b

**Owner/files:** masterT3b integrateS05–S09, không duplicate lockimplementation.

- [ ] Three languagesmulti-file→build→INITsmoke→READY; ordinalordering/newfailurefallback/cutoff/drainrestart/infraBLOCKED.
- [ ] Lockhash same everyofficialgame; aftercutoffOFFICIALdeny but realTESTbefore/afterlock/final/archive allowed withquota/ACL.
- [ ] TEST_BUILD/TEST_GAME→privateboard/replay/log without ordinal/candidate/rating/frozen changes. Final/archive fixture may be completed afterS11 realfinalization; S10reports that cross-session acceptance explicitly, no falsepass.
- [ ] T3 integration acceptance complete except any declared final/archive livejourney awaitingS11; S11 closes that case before portal acceptanceS12.

### S11 — Corrections/disputes/finalization

**Owner/files:** masterT7 corrections/rebuild/disputes/announcements/contracts.

- [ ] preview/applydigest/version/re-auth/idempotency; append-onlyresults/invalidate descendants/RRrescore/Eloepochrebuild.
- [ ] Grace10min/appeal0–10080default1440, dispute-finalizeserialization, noautofinalize; finalstageonlymanualgate.
- [ ] Real tournament→PROVISIONAL→Adminfinalize→FINALIZED, explicitreopen/correction; privateTESTafterfinal/archiveS10deferredcase closes here.
- [ ] Backend correction/finalization contracts accepted; G2correctness evidence bàn giao, **fullG2 còn restoreproofS15**, không ký toànG2 ởS11. Không arbitraryeditablewinner.

### S12 — Next public/team portal

**Owner/files:** masterT8 Nextcutover/designsystem/IDE/upload/APIclient/routes.

- [ ] Migrate realroutes/SSR/publicDTO/private no-store, remove obsolete Viteportal onlyaftercutover; no secondauthorityServerActions.
- [ ] Darknavy/violet/cyan/esports, reusepermittedcode appropriately; self-hostassets/Monaco/fonts, multi-fileeditor+upload/mobilefallback.
- [ ] Browser actual guestdeep-link/noJS/404, teamdraft/save/test/submit/receipts/errors/sessionexpiry, desktop/mobile/keyboard/themechange preservation.
- [ ] Existingaffectedbehavioraltests only; semantic servercontracts, screenshots/networkevidence. No mock-dataportal deliverable.

### S13 — Live/replay/standings/bracket/projector

**Owner/files:** masterT9 boundedgateway/chunks/live/publicreader/features.

- [ ] RealWSseq/attempt/gap/snapshot/reconnect/resume, heartbeat20s/stale60s, ≤1MiBpendingclient.
- [ ] Replaychecksum/version/seek/frame-vs-result separation; officialpublic vs privateTESTACL.
- [ ] brackets-viewerclient-only/dispose/officialDTO/keyboardlist, Swiss/Elostandings, projectorplaylist noledger/publication sideeffect.
- [ ] Realbrowser disconnect/restart/seek/share/fullscreen/mobile; screenshots and privacy-network evidence.

### S14 — Admin operations và usability

**Owner/files:** masterT10 maps/accountprovisioning/wizard/ops/adjudication/tutorials.

- [ ] Full graphical mapeditor, LANbulkpreview/directenroll, ONLINEadmission/sharedcode, autoN/R/T/Epreview/capacity/deadlines.
- [ ] Adminsource/logread-only audited, start/pause/emergencystop/finalize/correctionimpactconfirm/re-auth; extension onlyopenintake+serverNow<currentcutoff.
- [ ] Instructor realjourney start→closetab→autonomousrounds→incident→finalize; student reason/log/replay explanation.
- [ ] Usability targets04 with students/lecturers and keyboard/screen-reader checks. Human participants unavailable means targetpending, not invented completion; reachableUI/server fixes completed, releaseevidence cannot be falsely signed.

### S15 — Deployment/migration/recovery

**Owner/files:** masterT11 `deploy/linux/`, migrations/archive/operations/runbooks/CI/Dockerfiles/README.

- [ ] ReproducibleBOM/offlinebundle/roles/ACL/CA/TLS/secrets/preflight; managedstartup/readiness, noAPIprivilegedsocket.
- [ ] Consistentv1cloneexport/import/hash/count/FK, nofakeprovenance/runningresume/noSQLiteoverwritev2writes.
- [ ] OffhostPGbase/WAL+objectinventory/holds/signmanifest/keys/35dretention; backupage>5min protectedwritestop, realrestore+RPO/RTOreport.
- [ ] ONLINEstagingmail/reset; LANcoldbrowser noWANentirejourney/localADMINrecovery; oncallalertack+incidentdrills.
- [ ] Validate G0 config and operationalproof; no deploymentpublicproduction transition without user/operator authorization.

### S16 — Full integration và capacity

**Owner/files:** masterT12 fullsuite/build/codegen/deploychecks/loadgenerators/reports; providersS02–S15 complete or explicitexternal-evidenceblocker.

- [ ] Run masterT12 aggregatecommands afterintegration, fixconsumerbehavior failures without narrowingassertions.
- [ ] Independentsecurityreview/adversarialcanaries, frozenpolicy/ACL/ledgercoverage; zero unresolvedcritical/high.
- [ ] Actualmixedworkload500teams/1000viewers/fullRR249500games plus tie/retryheadroom ondeclaredhost, separate loadgenerator allowed (not serving/workerhost).
- [ ] Measure certifiedslots/service-distributions/queue/SLO/resources/growth/ETA; insufficientcapacityNOT_READY, no reducedscopeclaims.

### S17 — Endurance, review và release decision

**Owner/files:** masterT12 soak/rehearsal/evidence/userhelp/changelog/release/runbooks.

- [ ]72hsoak và7dayrehearsal riêng, realclock/overnight/backup/outage/reconnect/noAdmintab, enoughBot/viewer mix.
- [ ] Recovery/budget/ownership/retention/privacy/accessibility proof, S10final/archiveTESTacceptance complete, migrations rollback compatible.
- [ ] ADMIN/operator/independentreviewer signG0–G4 evidence; summarize READY/NOT_READY+restrictions actual, do not call scaffoldproduction.
- [ ] Only after explicittargetauthorization publish/deploy/enableexternalintake. Failure remainsS17blockedwithreason; fix applicableowner task then rerunaffectedproof, not auto-launch.

## 3. Handoff bắt buộc mỗi phiên

Khi triển khai, tạo report tại `docs/implementation/sessions/SNN-<scope>.md` (không tạo report giả trong phiên planning này). Một report chứa:

- Status `COMPLETE`, `CONTRACT_HANDOFF`, `PENDING_EXTERNAL_EVIDENCE` hoặc `BLOCKED`; chỉ COMPLETE sau đúngexitgate.
- Base/end commit nếu có, changedfiles, spec/policy/BOM digests, migrations applied và sharedcontracts delivered.
- Commands thực sự chạy+exitstatus, smoke scenario+observedresult, evidencepaths/screenshot/logredacted; unrun rõ ràng.
- Review findings/resolution, remainingblocker owner, security/privacy/data impact.
- Nextsession prerequisites/firstaction; không TODOimplementation bị giấu hoặc mock pass.

Bảng tiến độ (S01 đã thực thi phần preparation có thể làm; provisioning vẫn bị chặn):

| Phiên | Trạng thái | Evidence/handoff |
|---|---|---|
| S01 | BLOCKED | [Preparation inventory, hash manifest và partial BOM; chưa checkpoint/provisioning/config-ready](../../implementation/sessions/S01-preparation.md) |
| S02 | NOT_STARTED | — |
| S03 | NOT_STARTED | — |
| S04 | NOT_STARTED | — |
| S05 | NOT_STARTED | — |
| S06 | NOT_STARTED | — |
| S07 | NOT_STARTED | — |
| S08 | NOT_STARTED | — |
| S09 | NOT_STARTED | — |
| S10 | NOT_STARTED | — |
| S11 | NOT_STARTED | — |
| S12 | NOT_STARTED | — |
| S13 | NOT_STARTED | — |
| S14 | NOT_STARTED | — |
| S15 | NOT_STARTED | — |
| S16 | NOT_STARTED | — |
| S17 | NOT_STARTED | — |

## 4. Cách bắt đầu và tiếp tục

Lệnh yêu cầu phiên đầu: **“Triển khai S01 theo kế hoạch phiên tuần tự; hoàn tất phạm vi và handoff, không tự deploy production.”** Các phiên sau: **“Tiếp tục phiên kế tiếp từ handoff đã hoàn tất; giữ đúng baseline và gates.”** Đây là prompt mẫu, không thay quyền user ở thực tế.

Mặc định đề xuất thực thi subagent-driven khi có các slice độc lập, integrationowner duy nhất/reviewer mới, tuần tự giữa các phiên. Native cũng hợp lệ với cùngchecks/handoff. Không cần hỏi lại luật/UI đã chốt; chỉ hỏi dữ liệu operator/secret/hardware không thể lấy qua tools hoặc tradeoff thật sự đổi phạm vi.

Không cam kết số ngày/ngân sách từ số phiên: S02sandbox, S16capacity và S17endurance phụ thuộc evidence/hardware/humanreview thực tế. Ước lượng lại sauS02 vàS06. Hoàn thành planning này chưa nghĩa là đã thực hiệnS01.
