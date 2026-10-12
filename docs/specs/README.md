# OanTuTi Arena — SDLC Technical Specification Package

> **Thư mục đặc tả kỹ thuật và kiến trúc hệ thống chuẩn SDLC (Software Development Life Cycle)**  
> Phiên bản: **1.0.0** | Trạng thái: **Phê duyệt triển khai (Approved for Implementation)** | Nguyên lý: **Ponytail Senior Engineering**

---

## 1. Mục Đích & Tiêu Chuẩn Bộ Tài Liệu

Gói tài liệu này thiết lập bộ khung kỹ thuật, đặc tả giao thức, mô hình bảo mật sandbox, lược đồ cơ sở dữ liệu và kế hoạch kiểm thử tự động cho toàn bộ hệ thống **OanTuTi Arena**. Mọi quyết định thiết kế ở đây mang tính ràng buộc kỹ thuật (binding authority), đảm bảo:
- **Tính toán học tất định (Mathematical Determinism):** Mọi trạng thái game, nước đi, quy tắc cản đường, và điều kiện thắng được định nghĩa chuẩn xác không có kẽ hở.
- **Tính tổng quát hình học:** Không phụ thuộc vào bàn cờ hình chữ nhật hay bất kỳ kích thước cố định nào. Hệ thống xử lý đồ thị lưới tọa độ tổng quát $G = (V, E)$ với tập ô hợp lệ $V \subset \mathbb{Z}^2$.
- **Hiệu năng & Tiết kiệm tài nguyên (Ponytail Principle):** Gói tin mạng nhị phân $\le 200$ bytes, bộ nhớ game engine $\le 50$ KB/trận, runner hỗ trợ cả local dev không cần Docker lẫn production cgroups sandbox.

---

## 2. Mục Lục Chi Tiết

1. **[01-PRD-GDD.md](./01-PRD-GDD.md) — Đặc Tả Yêu Cầu Sản Phẩm & Thiết Kế Game**
   - Không gian trạng thái và đồ thị lưới tọa độ tổng quát $G = (V, E)$.
   - Bảng ma trận khắc chế Oẳn Tù Tì ($R \succ S \succ P \succ R$).
   - Quy tắc di chuyển 8 hướng King-move, quy tắc cản đường (Blocking Invariant), và 4 điều kiện thắng tuyệt đối.
2. **[02-SYSTEM-ARCHITECTURE.md](./02-SYSTEM-ARCHITECTURE.md) — Kiến Trúc Hệ Thống & Sandbox Security**
   - Phân rã Monorepo 5 packages (`engine`, `protocol`, `runner`, `server`, `web`).
   - Ranh giới module (Seams) và sơ đồ luồng dữ liệu Mermaid.
   - Cơ chế bảo mật Sandbox cgroups v2, seccomp BPF filters, `--network none`.
3. **[03-NETWORK-PROTOCOL-SPEC.md](./03-NETWORK-PROTOCOL-SPEC.md) — Giao Thức Mạng & Nhị Phân Protobuf**
   - Đặc tả frame nhị phân WebSocket (Header 5 bytes + Payload Protobuf).
   - Mã nguồn `proto/oantuti.proto` hỗ trợ bitmask ô hợp lệ và delta frame.
   - Định dạng tệp Replay nén nhị phân `.oantuti`.
4. **[04-BOT-RUNNER-IPC-SPEC.md](./04-BOT-RUNNER-IPC-SPEC.md) — Giao Tiếp Runner & Bot Sandbox**
   - Giao thức STDIO Newline-Delimited JSON (NDJSON) handshake `INIT`/`READY` và `TURN`/`MOVE`.
   - Bộ đếm thời gian Turn Budget Enforcer (100ms) chính xác đến mili-giây.
   - Mã lỗi xử phạt và Bot SDK mẫu bằng Python, TypeScript, C++.
5. **[05-DATA-MODELS-DATABASE-SPEC.md](./05-DATA-MODELS-DATABASE-SPEC.md) — Mô Hình Dữ Liệu & Database Schema**
   - Sơ đồ thực thể ERD Mermaid.
   - DDL SQL hoàn chỉnh cho PostgreSQL và SQLite.
   - Cấu trúc layout bộ nhớ RAM của `GameState`.
6. **[06-UI-UX-VISUALIZER-SPEC.md](./06-UI-UX-VISUALIZER-SPEC.md) — Giao Diện Web & Canvas 2D Viewport**
   - Thuật toán Camera Viewport Transform tự động căn chỉnh và scale bất kỳ hình học bàn cờ nào.
   - Rendering pipeline Canvas 2D phân tầng, hiệu ứng lerp animation.
   - Tích hợp Monaco Editor và thanh điều khiển Timeline Replay.
7. **[07-TEST-PLAN-QA-SPEC.md](./07-TEST-PLAN-QA-SPEC.md) — Kế Hoạch Kiểm Thử & Đảm Bảo Chất Lượng**
   - Tháp kiểm thử tự động: Unit, Integration, E2E, Fuzzing Determinism (10,000 matches), Security Sandbox Penetration, WebSocket Load Test (1,000 clients).
   - Bộ chỉ số Quality Gates và CI/CD Pipeline.
8. **[08-PROJECT-ROADMAP-WBS.md](./08-PROJECT-ROADMAP-WBS.md) — Lộ Trình Dự Án & Phân Rã Công Việc**
   - Lộ trình 5 Phase từ Core Engine đến Production Launch.
   - Bảng phân rã công việc WBS chi tiết cho đội ngũ kỹ sư.
   - Ma trận quản trị rủi ro kỹ thuật.

---

## 3. Schemas & Assets Đi Kèm

- **Protocol Buffers:** [`proto/oantuti.proto`](./proto/oantuti.proto)
- **JSON Map Schema:** [`maps/schema.json`](./maps/schema.json)
- **Sample Map Descriptor:** [`maps/sample-donut.map.json`](./maps/sample-donut.map.json)
