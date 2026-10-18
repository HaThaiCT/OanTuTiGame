# OanTuTi Arena v2 — thiết kế nâng cấp production

> **Baseline thiết kế, cập nhật rebuild 2026-10-17.** Chủ sản phẩm duyệt workspace cô lập bảo toàn donor và S01; tài liệu không chứng nhận runtime/security/capacity. Completion/evidence claims trước rebuild là **SUPERSEDED / NOT_ACCEPTED**, giữ lịch sử, không kế thừa acceptance/G0–G4.
> Chi tiết canonical: [bộ đặc tả v2](../../specs/v2/README.md). Tasks: [implementation plan](../plans/2026-10-13-production-upgrade.md).

## 1. Ý định và mục tiêu

Xây dựng nền tảng thi đấu lập trình Bot trong đại học, có quy trình tương tự cổng thi CTF/competitive programming nhưng chấm bằng gameplay đối đầu. Quy mô khoảng 500 đội/giải; giảng viên điều hành; giải tự chạy nhiều ngày; khách xem công khai không cần đăng nhập. Trình chiếu là tùy chọn chỉ đọc, không chi phối tiến độ hay điểm số.

Yêu cầu bổ sung từ chủ sản phẩm: **thiết kế như sản phẩm production chuyên nghiệp, không phải demo**, và **được phép thay hoàn toàn tech stack nếu phù hợp hơn**. Đây không phải yêu cầu bắt buộc viết lại toàn bộ; việc đánh giá phải dựa trên các ràng buộc, không giữ công nghệ chỉ vì quán tính.

Baseline mô tả đầy đủ scope, policy, contracts, roadmap và acceptance. Rebuild hiện chỉ thực hiện S01; không triển khai các S sau, install/build/services/migration hay mở intake từ việc chỉnh authority này. Independent design review chỉ kiểm consistency; G0 config và G1–G4 runtime proof phải có evidence mới, không coi tài liệu hoặc report cũ là production-ready.

## 2. Hiện trạng có bằng chứng

[Audit 00](../../specs/v2/00-CURRENT-STATE-AUDIT.md) phân biệt bằng chứng từ source, suy luận tĩnh và smoke test. V1 có pure engine, ownership/source revisions, SDK cho 3 ngôn ngữ và Canvas/replay. Các trở ngại: chưa có sandbox compile/runtime riêng cho từng Bot; lỗi điều kiện trong timer wrapper; giới hạn 64 và chưa có teams; lock chưa ghim version thực thi cho toàn giải; scheduler chỉ lưu trong RAM; result/Elo/replay chưa atomic/idempotent; public standings bị ràng buộc bởi projection gate; giao diện chỉ có sidebar và bị cắt trên mobile; SDK C++ init thiếu dữ liệu; workload tests chưa chứng minh khả năng phục vụ 500 đội.

Smoke test thực tế qua Python CLI với 12 ply sinh replay 647 bytes: Black thắng nhưng reason là `MAX_TURNS_DRAW`. Kiểm tra browser trên desktop/mobile quan sát UI và API dành cho khách. Đây không phải pentest, benchmark hay chứng nhận tải production. Giữ luật chiến thuật và phần code pure đáng tin sau khi được chứng nhận; thay control/runtime/UX khi cần thiết.

## 3. Baseline sản phẩm

Public/team/adminworkspaces; mộtofficialBot khóa/đội/giải, resubmit/autolatest/draindeadline đãchốt. **Đã bổ sung chạy thử riêng tư** baseline/Botđộimình, snapshotproject riêngkhôngsubmit/candidate/points/Elo; khôngpracticeleaderboard/tournament. Đơn/multi-filePython/TS/C++ và Monaco+upload, khôngterminal/Go; source/logprivate,ADMIN chỉreadbàiđãnộp.

Bốn preset:

| Preset | Giá trị | Tradeoff |
|---|---|---|
| Loại trực tiếp | 499 series cho500đội, cao trào rõ | 4–8game/series; hòa cuối drawindex nhỏ hơn, không áp cho doubleforfeit |
| Swiss → playoff tự cấu hình | N500→9vòng/top16 theo02TR-03 | Designer-defaultR/T pin policy/version, không đổi dowithdrawal |
| Full vòng tròn | Cùng tập đối thủ, một lượt | 124.750encounters/249.500games với500đội, cầncapacityproof |
| Elo liên tục | Reset1200/K32, E=max(8,4ceil(log2N)) | N500→36epochs/18.000games; eligibility02, ETA đo thực khônghardstop |

**Đã duyệt:** Swiss/vòng tròn/Elo2ván cùng map đổi bên mỗi cặp; knockout4–8ván, vẫn hòa ưu tiên seed. Loại trực tiếp độc lập random bracket/bye và drawindex dùng tie priority, không rating/manualseeding; vòng sau giữ nhánh. PlayoffSwiss seed theo rankSwiss; Swiss tự cấu hình số đội. Công bố/audit draw, không reroll; luật02.

## 4. Những ranh giới bắt buộc cho production

- Một máy Linux chạy control plane và execution processes riêng; mỗi compiler/Bot gVisor sandbox không secrets/mounts/quyền API/DB, cgroup admission/reserve được kiểm chứng. Không bắt buộc worker host thứ hai, không chạy code trong API.
- Manifests của source/artifact/ruleset/map/runtime/seed đã đóng băng phải bất biến; job không resolve latest Bot.
- Durable jobs/lease/fencing/reconcile thay các vòng lặp async trong RAM; game hoàn tất chỉ được chấp nhận sau khi xác minh bằng chứng.
- Append-only ledger, local durable transaction/outbox, checksum/fsync/atomic promotion cho artifact/replay; backup ngoài máy và restore. Không replica/standby/LSN barrier; standings/rating rebuild, correction invalidate descendants.
- Chính sách đọc công khai áp dụng xuyên suốt HTTP/WS/cache/export/object path; projector playlist không có quyền tính điểm.
- Có SLO/quotas/readiness/admission/backup restore/on-call/migration thực tế; mục tiêu phải được đo và review độc lập, không thể chỉ dựa vào nhãn thư viện.

## 5. Tech stack và nguyên tắc lựa chọn

[03](../../specs/v2/03-ARCHITECTURE-DATA-CONTRACTS.md) giữ các quyết định canonical; [nghiên cứu stack](../../research/2026-10-13-v2-tech-stack-evaluation.md) so sánh các phương án, năng lực thực tế và chi phí migration. Stack gốc không phải ràng buộc; module nào cải thiện safety/maintainability sẽ được thay.

**Stack single-host đã duyệt:** Ubuntu Server24.04LTS amd64 GA6.8/systemd/cgroupv2, PostgreSQL16/localdurableobjects, Fastify/TS, Next/React, **Rust engine + native runner + supervisor + cùng engine qua WASM browser**, runsc/gVisor. Delta thay Node/TS v2 engine/game-host; TS vẫn control plane/tournament policy, không full-Rust backend. Engine pure không IO/DB/identity/process privileges; runner trusted không đặc quyền consume pinned manifest và evidence, supervisor sở hữu Bot isolation/accounting. Native server verifier/map analysis qua bounded inspect theo03; WASM replay/visualization không Bot execution hoặc acceptance authority. Generated source proto Rust/TS và typed build/game completion, một broker/reconciler acceptance; không native/runc Bot fallback. LocalUID-boundUDS, noVMdefault/Redis/cluster/standby/remoteexecution. Exact patches/BOM kể cả WASM toolchain theo05§7.4; LANlocalCAHTTPS/offlinebundle khácONLINEpublicTLS/mail; không tên công nghệ thay runtimeproof.

## 6. UI direction và template

Competition-first, **dark-first esports: shadcn/ui + Tailwind + brackets-viewer.js**, light mode phụ, palette04§4. Người dùng xác nhận đã xin phép sao chép code từ các bên đã nêu; ưu tiên tái sử dụng/adapt code phù hợp thay vì dựng lại, port vào React/Tailwind, không thêm WordPress/Bootstrap stack hoặc mua template. Ghi provenance/phạm vi/notices; quyền code không tự bao gồm ảnh/logo/font/dependency. Bracket chỉ presentation official DTO, Swiss/Elo dùng standings/matches; self-host assets. [Research](../../research/2026-10-14-esports-ui-template-options.md).

[04](../../specs/v2/04-UI-UX-DESIGN-SYSTEM.md) bao gồm tokens/routes/screens, wireframes/states/accessibility và các gate kiểm tra thủ công. Thiết kế không dừng ở landing đẹp: deadline receipt, mất kết nối, draft chưa lưu, empty public state, pagination500/tie-break và correction confirmation là luồng chính. Owner đã duyệt checkpoint ba màn đại diện public directory/overview, team IDE, organizer operations tại1440×1000 và390×844 trước integrated S12; fixture có nhãn thường trực “Bản thiết kế — dữ liệu minh họa, chưa thực thi”. Không suy preview thành product/feature/runtime acceptance hoặc quyền bỏ hành trình thật.

## 7. Lộ trình và điều kiện mở giải

T0 approve/budget → T1 sandbox proof & T2 identity/teams → T3 submission/freeze & T4 jobs → T5 result/protocol → T6 four formats & T7 correction → T8 portal & T9 viewer & T10 organizer → T11 migration/operations → T12 rehearsal/launch. Công việc chạy song song theo Interfaces trong plan, với một integration owner; không viết code trước khi phê duyệt.

Launch cần G0decision/G1security/G2correctness-durability/G3capacity/G4operations trên một máy Linux;500teams/1000viewers,72hsoak và riêng7dayrehearsal, RPO5min/RTO30min là acceptance targets bắt buộc đo theo05, không lời chứng nhận đã đạt. External load generator và independent probes chỉ measurement clients, không cluster. KhôngHA/zero-losswholehostclaim; diskintact restart giữ accepteddata, diskloss restorebackupconsistentcuối. Proof không đạt phải giữ NOT_READY/BLOCKED, không hạ rules/security/scope để báo pass.

## 8. Baseline và điều kiện bắt đầu implementation

1. Product decisions đã xác nhận: bốn preset, Bot khóa xuyên giải/latest-valid receipt/drain, paired2game và knockout4–8game/randombracket, teamlimits, private tests, custom-map/publication, Adminstart/finalize.
2. Designer-defaults là canonical cho implementer tại01/02/05: SwissR/T, Elo1200/K32/E/eligibility/tie-break, bye/unplayed, quotas/bounds/retention. Không giả từng con số được user duyệt riêng; thay đổi phải revision và công bố trướcregistration, không đổi giải locked.
3. Python/TS/C++20 đơn/nhiều tệp, standardlib+SDK/projectimports; Monaco/upload, khôngGo/terminal/packageinstall. Privacy source/log theo01, không sourceđơntệp-only.
4. Single-Linux-host, mộtADMIN: LAN cấpaccounts/teams/directenroll/reset khôngSMTP; ONLINE selfregister/emailverify/password/recovery, khôngMFA/SSO. UI darkesports/code reuse được phép theo04.
5. Operator inputs G0 có schema/validation tại03/05: host/BOM/secrets/mailONLINE/origins/TLS/backupdestination/owner/budget. Giá trị mật hoặc phần cứng thực tế không thể bịa trong tài liệu; thiếuinput làm preflightNOT_READY, không unresolvedproductdesign.
6. CPU100ms/wall1s/300ply/no-ponder và capacity/recovery/UX là nghiệm thu phải chứng minh T1–T12. Khôngfallbacknative, khôngHA/zero-losswholehost.

Rebuild S01 đang thực hiện, chưa đóng S01/G0/G1 hoặc mở sản phẩm trước G1–G4. Giữ canonical S01–S17: S10=T3b, S11=T7, S12=Next, S13=viewer, S14=admin, S15=operations, S16=capacity, S17=endurance; không bỏ S04 ONLINE. Handoff theo master/provider contracts; report cũ giữ nguyên tên/evidence với superseded provenance, không renumber sessions để khớp completion sai.
