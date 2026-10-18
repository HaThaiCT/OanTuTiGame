# OanTuTi Arena v2 — Production specification

> **Baseline đặc tả; rebuild S01 đang chỉnh authority, chưa nghiệm thu implementation.** Nền tảng Bot đại học, single-Linux-host LAN/ONLINE, bốn format, public viewer; 500 đội/1000 viewers là target cần đo. Designer-defaults giữ nguyên; code/report cũ không chứng minh production-ready.

## Đọc theo thứ tự

| Tài liệu | Nội dung |
|---|---|
| [00 — Current-state audit](00-CURRENT-STATE-AUDIT.md) | Bằng chứng từ source, smoke test runner/browser và các thiếu sót cần khắc phục |
| [01 — Product requirements](01-PRODUCT-REQUIREMENTS.md) | Người dùng, phạm vi/quyền, đội/bài nộp, hành trình người dùng, PR-01…09 |
| [02 — Gameplay & tournaments](02-GAMEPLAY-TOURNAMENT-RULES.md) | Luật engine, 4 preset, cặp game đổi màu, tie-break, Elo/corrections, GP/TR IDs |
| [03 — Architecture & data](03-ARCHITECTURE-DATA-CONTRACTS.md) | Modules, PostgreSQL/job ledger, Interface, HTTP/live/provenance, migration |
| [04 — UI/UX & design system](04-UI-UX-DESIGN-SYSTEM.md) | Định hướng hình ảnh/template, tokens, routes/screens/states, mobile/accessibility |
| [05 — Security/operations/QA](05-SECURITY-OPERATIONS-QUALITY.md) | Isolation/limits, SLO/recovery/load/runbooks, G0…G4 |
| [06 — Design review record](06-DESIGN-REVIEW-RECORD.md) | Findings đã giải quyết, kiểm chứng tài liệu và giới hạn bằng chứng |
| [Research nguồn chính thức](../../research/2026-10-13-v2-platform-research.md) | DOMjudge, CTFd, Battlecode, FIDE, isolate/gVisor, shadcn/Radix/Tabler/licenses |
| [Đánh giá tech stack](../../research/2026-10-13-v2-tech-stack-evaluation.md) | Fastify/Go/Django, Rust/Go/Node supervisor, Vite/Next; rationale rewrite chọn lọc |
| [Thiết kế tổng](../../superpowers/specs/2026-10-13-production-upgrade-design.md) | Tổng hợp quyết định và cơ sở lựa chọn để review |
| [Implementation plan](../../superpowers/plans/2026-10-13-production-upgrade.md) | Tasks T0…T12, files, interfaces, verification/dependencies |
| [Research giao diện và quyền reuse code](../../research/2026-10-14-esports-ui-template-options.md) | Nguồn esports, lựa chọn UI và xác nhận permission của chủ sản phẩm |
| [Kế hoạch phiên tuần tự S01–S17](../../superpowers/plans/2026-10-14-sequential-implementation-sessions.md) | Thứ tự triển khai, exit gates, handoff và trạng thái chưa bắt đầu |
| [Gói chuẩn bị trước implementation](../../superpowers/plans/2026-10-14-preimplementation-preparation.md) | Workspace/disk/toolchain/target-host prerequisites, quyền provisioning và exit S01 |

## Authority và giới hạn

Yêu cầu trực tiếp của chủ sản phẩm được ưu tiên. Sau khi phê duyệt, các tài liệu có thẩm quyền theo lĩnh vực: 01 — sản phẩm/quyền riêng tư; 02 — gameplay/scoring; 03 — contracts/state/data; 04 — UI; 05 — security/resource/operational gates. Research cung cấp dữ kiện, tài liệu tham khảo và phương án, **không thay thế quyết định canonical**: rating/points/quota và backend sandbox có thể khác research. Kế hoạch phải tuân theo đặc tả; mọi mâu thuẫn cần được giải quyết trước khi triển khai.

Delta kiến trúc được chủ sản phẩm duyệt ngày 2026-10-17: **Rust engine + Rust native runner + cùng engine qua WASM cho browser**, thay Node/TypeScript game-host và v2 engine. TypeScript/Fastify vẫn sở hữu control plane/tournament policies; Next/React vẫn sở hữu web. Kế hoạch rebuild đã duyệt tại `../../../OANTUTI_ARENA_V2_PLAN.md` điều phối S01; không thay product/rules/security/UX canonical. Báo cáo/checklist completion trước rebuild là **SUPERSEDED / NOT_ACCEPTED**, giữ làm lịch sử, phải nghiệm thu lại theo đúng S01–S17 và G0–G4.

Tài liệu v1 ở `docs/specs/01…08` và các thiết kế LAN/projector cũ được giữ làm lịch sử. Không áp dụng đồng thời hai bộ luật cho v2: v2 bỏ projector publication gate, global casual Elo, default admin và cơ chế thực thi latest Bot; giữ archive reader để xem lịch sử v1 đúng version. Proto v1 giữ reader read-only; v2 dùng source `.proto` versioned/generated Rust và TS, không hai schema/wire authorities.

## Bốn lựa chọn sản phẩm

Bốn format: knockoutrandombracket, Swiss/playoff autoN, RRmộtlượt, Eloreset1200/K32/E=max(8,4ceil(log2N)). Swiss/RR/Elo2ván/cặp, knockout4–8ván. Bot khóa cảgiải, public độc lập chiếu; RR500→249.500games, Elo500/E36→18.000games. Policy02 là canonical; khôngfixed4epochs/ngày hoặchardstop7ngày.

**Đã xác nhận:** mỗi đội khóa một Bot mỗi giải; được nộp lại, tự lấy bản hợp lệ mới nhất theo server receipt ordinal; không chọn thủ công/luyện tập. Hạn tính nhận đủ source bền vững: đóng nhận bài rồi kiểm tra hết bài đúng hạn, READY sau hạn vẫn hợp lệ; sau đó khóa. Infra lỗi hoãn khóa, không loại đội; sau khóa không đổi.

Stack single-host đã duyệt: **Next/React + Fastify/TypeScript + Rust engine/native runner/supervisor + Rust WASM browser + PostgreSQL + local durable artifacts + gVisor**. Một máy Linux cả LAN/ONLINE, không cluster/replication/standby; backup ngoài máy và restore. Native/WASM dùng cùng gameplay semantics/revision; browser không chạy Bot thí sinh hoặc accept kết quả. Correctness/security/capacity phải đo.

**UI đã duyệt:** shadcn/ui + Tailwind + brackets-viewer.js, dark-first esports, không mua template. Navy gần đen/violet/cyan, cam LIVE; palette/screens tại04. Người dùng xác nhận đã xin phép sao chép code từ các bên đã nêu; được copy/adapt vào nền đã chọn, ghi provenance và phạm vi. Không suy quyền với ảnh/logo/font/dependency bên thứ ba.

## Production không phải nhãn

Trước khi nhận code không tin cậy, cần đạt G1 isolation. Trước khi mở giải chính thức, cần đạt G0 decision, G1 security, G2 correctness/durability, G3 capacity/endurance và G4 operations. 1000 viewers, soak 72 giờ, rehearsal 7 ngày, RPO 5 phút và RTO 30 phút là **các mục tiêu cần đo**; hiện chưa có báo cáo chứng minh đã đạt. Reviewer độc lập phải kiểm chứng những cam kết này khi triển khai.

## Điều kiện bàn giao và triển khai

Baseline01–05 giữ đủ user decisions ở06 và designer-defaults được ghi rõ. Phiên rebuild được duyệt chỉ đang thực hiện S01; chưa cho phép bỏ gate hoặc mở intake. Operator điền cấu hình03/05 và pin BOM kể cả Rust/WASM tạiG0; security/capacity/recovery/accessibility phải có proofG1–G4. Thiếu secret/maildestination/hardware report là input triển khai, không lý do để thêm unresolved luật giải. Ba màn đại diện phải được owner duyệt trước S12 integrated portal; preview có nhãn dữ liệu minh họa không là feature proof.
