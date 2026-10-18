# 06 — Kết quả review thiết kế và kiểm chứng tài liệu

> Documentation-only, 2026-10-13. Không chứng nhận triển khai, security, tải hoặc SLO. Hồ sơ này ghi quyết định sau review để người triển khai không quay lại các cách hiểu đã bị loại.

## Rebuild authority — 2026-10-17

**SUPERSEDED / NOT_ACCEPTED:** review, inventory, smoke và completion claims bên dưới là lịch sử theo thời điểm, không current runtime state hoặc acceptance rebuild. Giữ nguyên bằng chứng/report để truy vết; không kế thừa COMPLETE/CONTRACT_HANDOFF/G0–G4 hoặc suy checks cũ chứng nhận implementation mới. S01 đang chỉnh authority/config trong workspace cô lập, donor được bảo toàn; chưa đóng S01/G0/G1. Canonical S01–S17 giữ nguyên; S10=T3b, S11=T7, S12=Next, S13=viewer, S14=admin, S15=ops, S16=capacity, S17=endurance; S04 ONLINE không được bỏ.

Delta được chủ sản phẩm duyệt: Rust engine tại `crates/arena-engine`, native authoritative runner tại `crates/arena-runner`, cùng engine qua WASM browser replay/visualization; thay Node/TS v2 game-host/engine. Rust supervisor vẫn sở hữu sandbox/CPU/freezer/watchdog/reaper, runner không đặc quyền; TypeScript/Fastify giữ control plane/tournament policies, Next/React giữ web. Browser không chạy Bot thí sinh/accept results; không native/runc Bot fallback. Source proto generated Rust/TS, native inspect VERIFY_TRACE/ANALYZE_MAP và một typed build/game completion acceptance theo03. Research/review giữ TS engine trước đây đã superseded, không là rationale hiện hành.

Product/privacy/rules/UX/security/resource/SLO requirements01–05 giữ nguyên. Owner đã chọn duyệt ba màn đại diện trước integrated S12; fixture preview phải có nhãn minh họa, không feature proof. G1 exact-target, real mailbox/offhost restore/capacity/72h+7day/human usability/reviewer sign-off còn phải có evidence mới; không tự ký từ docs hoặc microbench.


## Quyết định bổ sung từ chủ sản phẩm

- Mỗi đội chỉ khóa một Bot cho mỗi giải; cùng phiên bản/artifact dùng toàn giải, không đổi giữa vòng, stage hoặc Elo epoch.
- Không practiceportal/leaderboard/giải luyện tập. Compile/INIT-smoke kiểm officialsubmission; quyết định mới bổ sung private workspaceTEST baseline/Botđội mình theo dòng26, không tính điểm/ordinal/candidate.
- Được nộp lại; tự chọn bản hợp lệ mới nhất theo server receipt ordinal, không captain selection hoặc compile-completion order. Hạn là durable full-source receipt; đóng intake rồi drain bài đúng hạn, kể cả READY sau hạn, mới khóa. Infra pending/BLOCKED hoãn lock/start; bản lỗi fallback bản hợp lệ cũ, không sửa code sau deadline.
- Đã duyệt knockout4game và tối đa8game khi hòa, rồi ưu tiên seed index nhỏ hơn. **Loại trực tiếp độc lập tự động random ghép cặp**: draw permutation cấp chỉ số bốc thăm, bye và tie fallback theo cùng chỉ số; bracket công bố/khóa, không random lại mỗi vòng. Playoff Swiss theo thứ hạng Swiss; không suy yêu cầu random thành thay pairing Swiss/Elo.
- Swiss/playoff tự cấu hình từ Nfrozeneligible, không AdmininputR/T. Công thứcR/T designer-default đã chốt ArenaAutoFormat/v1 tại02, không giả user xác nhận từng con số; withdrawal không đổiR/T.
- Đã duyệt mỗi cặp đấu Swiss/vòng tròn/Elo có2ván trên cùng map đổi bên, cộng kết quả hai ván; không tính mỗi ván là một vòng/cặp riêng.
- Đã duyệt vòng tròn cố định một lượt gặp, mỗi cặp2ván đổi bên; không tùy chọn hai lượt.500đội→124.750cặp/249.500ván, capacity phảiđo trướcpublish.
- Swiss/RR điểmencounter3–1–0, khôngtừngván; Elo riêng. Bye/walkover/tie-break baseline02 là designer-default đãfinalize.
- Elo reset từnggiải; khởi1200/K32 và eligibility là designer-defaultArenaElo/v1 tại02, khôngcarryrating, giữarchive.
- Elo chạy liên tục tớiEauto=max(8,4ceil(log2N)); N500→36epochs/18.000games. ETAbenchmark/reservedslots, khônghardstop/cắttrận/giảmđợt; policy designer-default cần proof chấtlượng/capacity trước release, khôngchờchọncôngthức.
- Đã duyệt đội mặc định1–3người, giảng viên đặt giới hạn tốiđa1–5 trước mở đăng ký; mỗi sinh viên chỉ một đội trong cùng giải. Không suy xác nhận này thành duyệt invitationTTL/auth/privatePII policy khác.
- ONLINE mọi account verifiedemail/password trước login, khôngSSO/MFA; pending khôngsession/team/submission. LANngoạilệ đãduyệt ở31–33: ADMIN-issued/LOCAL_BOOTSTRAP/password/firstchange, khôngSMTP/fakeverified.
- ONLINE mãchungmultieuse/giải; đúngmã/roster/capacity mớiadmit/upload, rotate/revoke khôngkickadmitted. LANAdmindirectenroll khôngmã. Publickhôngaccount/mã.
- ONLINE emailrecovery purposebound/oneuse/expiry/revokesessions, khôngactivatepending/escalaterole; LANAdminreset và operatorlocalADMINrecovery theo05, khôngemailwall.
- ADMINONLINE verifiedemail/password, LANlocalbootstrap/password; cảhai khôngMFA/TOTP/recoverycodes/enrollment. Session/scope/audit/passwordreauth nhạy cảm giữ; tradeoff singlefactor đãnêu.
- Đã duyệt một ADMIN duy nhất là người tổ chức chung mọi giải, bootstrap khi triển khai; không mời/promote admin. **ADMIN đọc được source và log bài nộp mọi đội**, read-only/audit; không sửa code hoặc thay Bot đã khóa. Sinh viên chỉ đội mình, khách không đọc source/log; không bao gồm draft chưa nộp.
- Upload vàIDEweb chung officialreceipt/deadline; Save/Import khôngautosubmit. PrivateTEST khác pipeline, khôngofficialordinal/candidate.
- Botlanguage chốt Python/TypeScript/C++20, khôngGo; đơn/nhiều tệp đãduyệt, khôngđơntệp-only.
- MonacoVSCode-styletree/tabs/entrypoint, khôngterminal/debugger/extensionruntime. Bounds128files/256KiBfile/4MiBsource/2MiBZIP vàfixedbuild theo01/05 là designer-default, standardlib+SDK/projectfiles only.
- Đã duyệt private workspace tests baseline/Bot đội mình, server sandbox/snapshot/replay/log, khôngpoints/Elo/candidate/frozen-change và không practiceleaderboard. **Chạy thử bất cứ lúc nào**, kể cả sau cutoff/lock/final/archive; nộp chính thức vẫn phải đúng hạn. Quota/readiness/permissions không bị bỏ; test receipt không được chuyển thành official receipt đúng hạn.
- Đã duyệt imports chỉ tệp dự án + thư viện chuẩn + SDK hệ thống, không dependencies ngoài/tải pip/npm/Internet; cùng policy cho chạy thử và official. Không Go, không userbuildscripts/package manager; artifact pin cảproject+SDK+toolchain.
- Adminmap tựdo khôngfairness/connectivitygate; schema/resourcebounds02 là hardvalidation. PUBLIC_BEFORE_SUBMISSION hoặc REVEAL_AFTER_BOT_LOCK pin trước intake, hiddencommitment khônglộmetadata; reveal sau drain/lock. Mapeditor/gates theo04/T6/T10, khôngchờ chọnworkflow.
- **Đã duyệt mọi giải cần ADMIN bấm Bắt đầu**, không autostart từ timer/lock/reveal/readiness. Trướcstart không officialexecution; saustart các vòng/epoch tự vận hành và phục hồi sau restart. Start idempotent/audit/atomic dispatchgate; private TEST độc lập.
- ADMINchốt cuối; finalAppealWindowMinutes0–10080 default1440 là designer-default, cấu hình trướcregistration;0khôngbỏdispute/infra/integrity, khôngautofinalize. Serializedispute/finalize, giờtừfinalstageprovisional.
- LAN_OFFLINE vàONLINE đãduyệt. LANAdminissued/directenroll/noemail; ONLINEverify/recovery; khôngfakeverified/importbypass. Offlinebundle/WANdeny/sandbox/capacity/recovery phảiproof trênsinglehost, khôngVMdefault/AIfree/HAclaim.
- Đã duyệt LAN mỗi account mật khẩu tạm riêng, bắt buộc đổi lần đầu; Admin chốt số lượng account/đội, limits và roster có audit. ONLINE vẫnselfregister+emailverify theo capacity; Nautoformat là đội thực eligible sau drain, không đăngkýcap.500đội chỉcapacitytarget, không fixedroster hoặc unlimitedguarantee.
- Đã duyệt LAN Admin cấp account, phân đội và **ghi danh đội vào giải trực tiếp**, không nhập mã. Student không tự tạo/đổi/mời đội; online self-team+shared invite code. Server kiểm roster/capacity/unique membership và audit admission như nhau, không bypass quyền bài nộp.
- Đã duyệt **host chỉ Linux** trong cả LAN và online; không Windows/macOS/WSL host packages. Sinh viên/khách dùng browser mọi OS được hỗ trợ. Distro/kernel/CPU profile cần chứng nhận; sandbox/trust separation/capacity không được bỏ vì host Linux.
- **Đã duyệt tập trung một máy Linux cho cả LAN và ONLINE/VPS.** Bỏ cluster/remoteworker/standby/replication/WALpublicationbarrier và nhiều-adminphức tạp. Localdurableobject+DBtransaction/idempotentledger/outbox,backupngoàimáy/verifiedrestore; không HA/zero-loss khi máy/diskmất. Security sandbox/resourcelimits vàcapacitygate vẫnbắtbuộc. Những reviewreplication trước đây là lịch sử bị thay thế, khôngcontract hiện hành.
- **Đã duyệt shadcn/ui + Tailwind + brackets-viewer.js, dark-first esports, không mua template. Người dùng xác nhận đã xin được sự đồng ý cho sao chép code của các bên đã nêu.** Cho phép copy/adapt code giao diện, không còn giới hạn chỉ tham khảo; port vào nền React/Tailwind, không thêm WordPress/Bootstrap stack. Xác nhận của chủ sản phẩm chưa phải giấy phép assistant đã kiểm chứng; ghi provenance/phạm vi và notices, không tự mở rộng sang ảnh/logo/font/dependency bên thứ ba. Palette04§4 và bracket chỉ render official DTO giữ nguyên; chứng nhận contrast/accessibility/runtime vẫn là gate triển khai.
- Kiểm chứng cập nhật UI: 6 tài liệu liên quan không có link nội bộ lỗi hoặc fence chưa đóng, không còn nhãn chờ chọn mẫu. Contrast sRGB của token: body dark16,84:1; metadata dark9,06:1; button dark10,49:1/light7,10:1; control edge dark5,68:1/light4,76:1. Đây là phép tính token, không chứng nhận component/browser thực tế, opacity/gradient/focus/mobile/screen reader; các gate đó thuộc T8/T9 khi triển khai.

### Designer-defaults và readiness baseline cuối

Theo yêu cầu hoàn thiện đầy đủ trước code, người viết chốt defaults01/02/05: ArenaAutoFormat/v1, ArenaSwiss/v2, ArenaElo/v1/ArenaEloPair/v1, scoring/unplayed/eligibility/correction, quotas/manifestbounds/auth/retention/SLO. Đây không phải user đã duyệt riêng từng tham số. Ubuntu24.04LTSamd64/GA6.8/PostgreSQL16 cùngUID-boundUDS/runsc là deployment target; patches/digests/BOM được pin/reviewthực tế ởG0. NoVMdefault/replication/SSO/MFA/S3service. Operatorinputs05§7.4 là giátrịthực cần điền, khôngproductTBD; tài liệu khôngbịa secrets/hardware/capacity/securityevidence.


## 1. Review độc lập

Các review trong phiên trước là lịch sử, không thay chứng nhận baseline cuối hoặc runtime proof. Bảng sau giữ findings còn hữu ích và cập nhật quyết định canonical; review cuối baseline ghi riêng khi có kết quả thực.

| Phát hiện | Quyết định canonical | Nơi quy định |
|---|---|---|
| Giải nhiều ngày không chờ duyệt từng vòng | Automatic round/epoch seal theo policy, durable timers; **final giải do ADMIN chốt**, không auto-finalization |01§6,02TR-09,03lifecycle,T7 |
| Double-forfeit knockout không biết ai advance | Không ai advance; EMPTY propagate; có thể NO_CHAMPION |02TR-07,03terminalstates,05resultpath |
| Cả hai withdrawn/empty Swiss vòng không có terminal timestamp | DOUBLE_WITHDRAWAL0điểm/no-rating; emptyround dùng roundActivatedAt |02TR-07,03timer |
| Elo small-field eligibility | Threshold theo02TR-05 với Eauto/Nlocked/bye rotation; không dùng E4 như cấu hình canonical |02TR-05,T6 |
| Matching scalarweights không giữ điểm trước seed | Dominance weights checkedinteger, seedrange gốc còn lại sauwithdrawal; deterministic solver timeoutBLOCKED |02TR-03/T6 |
| FrozenBot không thể drain request lớn hơn pipe | Bound request256KiB, nonblocking transfer sau unfreeze cóCPU/wall accounting |05§2.3,stackresearch§6.3 |
| Delivery pending bị expiry lease gây recompute | prepareCompletion pin durable; COMPLETION_PENDING/reconciler không computation reclaim |03AR-02,T4/T5 |
| Publication/durability còn mô tả replication | Đã bỏ WAL-LSN/remote_apply barrier: evidence fsync/promote + local PostgreSQL durableaccept + outbox; wholehostloss dùng backup |03AR-02,05§6,T5/T11 |
| WS caps256KiB và1MiB mâu thuẫn | Canonical1MiBpending/client |03live,05SLO,T9 |
| Plan Elo1200v1200K32 ghi+32 | S1,E0.5 đúngdelta+16/−16 |T6 |
| Stack v1 có thể bị giữ bởi quán tính | NextpublicSSR/Rustsupervisor chọn lọc,TScontrol/engine giữ córationale |03,stackresearch,plan |

Nhận xét reviewer trước chỉ áp phiên tài liệu lúc review. Seedrange dùng `(maxInitialSeed−minInitialSeed)`, không `(N−1)` sauwithdrawal. Các policy còn từng ghi đề xuất được finalize thành designer-defaults trong baseline01/02/05, không giả user phê duyệt từng tham số. Scope04/plan phải đồng bộ vớibaseline.

### Review baseline cuối trước triển khai

Ba review độc lập kiểm product/rules/UI, plan/contracts và architecture/security. **Năm findings đã sửa:** (1)T3a source/contracts→T4/T5/T6→T3b integratedacceptance, T6solelockowner; (2)full evidence fsyncfile+parent trước DBpinCOMPLETION_PENDING, brokerstagingrefs/hold và reconciler độc lậpworker; (3)pieceCount≤validCellCount≤4096, occupiedthrone hợp lệ vàcap256KiBđộc lập; (4)chỉ stagecuốigiải cầnADMINfinalize, Swiss→playoffauto; (5)gia hạn nhận bài chỉintakeopen/serverNow<currentcutoff/chưalock, appealextension riêng. Reviewers plan/ops đã xác nhận fixes khôngcòn blocker trongscope; productfixes áp đúng minimalrecommendation. Khôngsecurity/runtimecertification.

Sau fixes, cả ba reviewer đã đọc và xác nhận không còn blocker trong phạm vi review của mình (product/rules/UI; plan/interfaces; architecture/durability/security contracts). Đây là review thiết kế read-only, không chạy implementation/tests/build/securityprobes; không chứng minh mọi runtimeedgecase hoặc khả năng hardware.

## 2. Kiểm chứng thực hiện trong phiên tài liệu

- ActualCLI PythonvPython12ply, replay647bytes; không benchmark throughput.
- Actualbrowser desktop1440×1000/mobile390×844 và anonymousAPI trên DBmemory tạm; observed UI limitations ởaudit00.
- Script docs-only kiểm11tài liệu:0linknộibộlỗi/0fencechưađóng; taskheadings đủT0…T12 đúng thứtự, PR-01…PR-09 đều cócoverage, registry03 và T3a/T3b rõ. Khôngcode/test/buildrun.
- Arithmetic script N2/3/4/5/10/16/64/500 kiểmR/T/E và eligibility. N500: knockout499series1996–3992games; Swiss2265encounters4560–4620games; RR124750encounters249500games; EloE36/9000encounters18000games. Các số workload không phải throughput/timing đãđo.
- TemporaryAPI/webservices đã dừng, temporary replay đã xóa. Không thay code/config/tests, không cài dependency/template, không chạy Rust/Nextimplementation.

Không chạy fulltest/build/securityprobe/load/soak/restore certification trong phiên này. Gatesfuture cần evidence thật và sign-off theo05. Markdownfence/link checks không chứng minh Mermaid renderer/accessibility hoặc triển khai đúng; không gọi suite hiện pass/fail khi chưa chạy.

### Inventory readiness trước S01 — chỉ đọc, không provisioning

Host quan sát: Ubuntu24.04.5LTS/x86_64, kernel7.0.0-38-generic, cgroup2. Node24.21.0/npm11.19.0, Docker29.1.3, g++13.3 và Python3.12.3 có CLI. `cargo`, `rustc`, `runsc`, `psql`, `protoc` không tìm trong PATH; cargo cũng không ở~/.cargo/bin/cargo. Đây không chứng minh PostgreSQLserver hoàn toàn không cài hoặc runtime không tồn tại ngoàiPATH. Host kernel khác GA6.8 baseline03/05, chưa có compatibility/accountingcertification; không tự downgrade/reboot/đổiOS để hợpprofile.

Không tìm thấy `deploy/`, `crates/` hoặc `docs/implementation/` qua glob inventory; đó là artifacts tương lai, không gọi scaffolds đãdone. Chưaresolve exactBOM/check cgroupdelegation/rootlauncher/offhostbackup/SMTP/TLS/trust/securityreview/capacity/restore trênhost. Vì vậy **có thể bắt đầuS01 inventory/config/provisioning có kiểmsoát**, chưa tuyên bố safeS02runtime hoặc RELEASE_READY. Thiếu tool phải xử lý ởS01, secrets/mail/humanreview lấy quaoperator antoàn trướcsmoke tươngứng, khôngpaste vàochat.

Đã tách DEVELOPMENT_CONFIG_READY trướcT1 khỏi RELEASE_READY sauT11/T12 tại05§7.4/masterT0: capacity/restore/canaryreport chưasinh làPENDING_RUNTIME_PROOF, khôngfake hoặc prerequisite vòngtròn trướccode. Productionpreflight khôngdevbypass. Script readiness kiểm12tài liệu/link/fences, đủS01–S17 và17NOT_STARTED; khôngtests/build/sandboxprobe.

Review readiness lịchS01–S17 tìm và sửa thêm4providerdependencies: T2/S03ownsreal tournamentadmissionsubstrate/schema/API trước LAN/ONLINEenroll; S08startcontracthandoff→S09positivefirstdispatch/lostack/restart; T6/S09owns autoseal10min+nextSwissplayoff/Elo, T7extendsdisputeblockers/manualfinalize; T5/S07localcrashdurabilityhandoff còn fullconsistentoffhostrestore đóngT11/S15. S11chỉpartialG2, khôngkýrestoretrướcprovider; T2uploadcase khépT3b khôngfakeearlyprovider. Gate reviewer xác nhận restorefix khôngcòn blocker trongscope, session reviewconfirmation ghi theo reportthực. Inventorykhông đủ safeS02; S01 là bước xửlý tool/BOM/hostinputs, khôngfreepasskernelmismatch.

Cả hai readinessreviewer đã đọc fixes và xác nhận không còn providercycle/blocker trong phạm vi dependency/config/releasegate được giao. Chỉ chứng minh consistency tài liệu; khôngruntimeavailability. Kết luận: ready để bắt đầuS01, chưareadyS02runtime hoặcrelease; prerequisites thực cần hoàn tất trướcsmoke/gate tươngứng.

## 3. Handoff

Đọc [index](README.md), [designoverview](../../superpowers/specs/2026-10-13-production-upgrade-design.md), [plan](../../superpowers/plans/2026-10-13-production-upgrade.md). Baseline hoàn thiện không cấp quyền code: phiên triển khai riêng bắt đầu T0/G0 với operator inputs theo03/05 rồi sandboxproofT1. KhôngOIDC/MFA/replication/multi-host prerequisite; secrets/hardware hiệnthực khôngbịa. V1 vẫn trusted-bot, chưa cho phép mở nhận code không tin cậy chỉ vì có tài liệu.
