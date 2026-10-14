# 00 — Audit hiện trạng v1 và khoảng cách tới production

> Ngày 2026-10-13. Audit tĩnh các modules + smoke runner/browser được mô tả dưới đây. Không pentest, không benchmark production, không chạy lại full test suite. File paths/line ranges là snapshot lúc audit; không phải line numbers bảo đảm sau triển khai.

## 1. Kết luận

V1 có nền tảng tái sử dụng tốt: pure engine, SDK đa ngôn ngữ, immutable bot source revisions, ownership/session, Protobuf replay và Canvas playback. **Chưa phải nền tảng production cho 500 đội/mã sinh viên không tin cậy/giải nhiều ngày.** Không chỉ cần đổi giới hạn64, thêm bracket hoặc thay CSS.

README đã nói rõ trusted-bot, không sandbox từng Bot và không mở Internet (`README.md:3–5`). Đặc tả v1 mô tả các mục tiêu sandbox/PostgreSQL/fuzz/load như định hướng, không đồng nghĩa implementation đã có. Ví dụ `docs/specs/02-SYSTEM-ARCHITECTURE.md:249–305` mô tả isolation nhưng actual runner spawn trực tiếp; docs database mô tả PostgreSQL trong khi code `node:sqlite`.

## 2. Bảng gap có nguồn

| Mức | Hành vi source quan sát | Rủi ro/hệ quả [INFERENCE] | Hướng xử lý |
|---|---|---|---|
| P0 | `ipc-client.ts:65–118` compile C++ synchronous, spawn pipes, không per-bot sandbox | Bot/compiler cùng quyền đọc/mạng/tài nguyên với server | Compile và runtime isolated trên worker riêng, gate an toàn |
| P0 | `ipc-client.ts:187–210`: callback so pendingRejecter với raw reject, nhưng lưu wrapper | Timer có thể không reject khi Bot không trả lời; sleep/no-newline treo match | Watchdog độc lập runner, bounded output/lifecycle regression |
| P0 | `tournament-service.ts:113–146` entry lưu version nhưng job gọi startMatch bot IDs; `match-service.ts:104–111` lấy current Bot | Sửa/xóa Bot sau lock ảnh hưởng trận tương lai | Frozen artifact reference end-to-end |
| P0 | `tournament-service.ts:205–345` standings/pairings/bye trong local variables; startup không reconcile | Restart không resume giải RUNNING nhiều ngày | Durable rounds/jobs/leases/fencing |
| P0 | `match-service.ts:133–138`, `db.ts:416–439,478–505` result/Elo/replay nhiều bước riêng | Crash gây state lệch, duplicate acceptance có thể cộng điểm hai lần | Immutable evidence + transaction ledger/outbox |
| P1 | `app.ts:211`, `tournament-service.ts:119` cap64; entry userId, schema không teams | Không biểu diễn500 đội/members/captain/scope | Teams/course model và concurrent lock |
| P1 | `app.ts:254–272` public uses projectedIndex; direct replay/ws không kiểm gate | Public discovery phụ thuộc projector, policy không xuyên suốt | Public DTO độc lập projection; source/build logs private; không luyện tập v2 |
| P1 | `tournament-service.ts:222–305` chỉ Swiss/RR, tuần tự await | Không có knockout/playoff/Elo season; capacity chưa biết |4 preset và admission control |
| P1 | `tournament-service.ts:28–97` recursive matching + rematch fallback, điểm→wins→live Elo | Pairing có thể expensive; results/order làm seed thay đổi | Versioned bounded matching, fixed tie-break/bye ledger |
| P1 | `db.ts:478–501` global Elo1200,K32; mọi registry match tăng rating | Người dùng tạo match casual ảnh hưởng rating chung | Season scoped sealed-epoch rating |
| P1 | `match-service.ts:33–59,222–299` giữ active frames/results trong Map | Memory giữ trận hoàn tất qua nhiều ngày | TTL bounded live chunks + object storage |
| P1 | `ws-hub.ts:138–151`, `api/client.ts:187–207,329–340` send không backpressure; client không reconnect FSM | Slow viewers/restart có thể mất kết nối hoặc tăng memory | Seq/catchup/backpressure/terminal failure |
| P1 | `sdk/cpp/oantuti.hpp:255–264` starting_pieces rỗng; parser substring | C++ init semantics khác Python/TS | Schema-valid parsing và parity fixtures |
| P1 | `graph.ts:94–234` chỉ đảm bảo đường giữa throne, không toàn map/symmetry/đủ3loại | Map valid chưa đồng nghĩa map official công bằng | Tournament certification layer |
| P1 | `rules.ts:133–146,236–279` floor integer proximity, reason MAX_TURNS_DRAW có winner | UI/verdict gây hiểu sai, docs hữu tỉ lệch code | Pin integer rule, split reason v2 |
| P1 | `protocol/src/schema.ts`, `types.ts`, `ws-framing.ts` có hai enum frame khác nhau | Schema drift, wire mismatch khi nâng cấp | One source proto, one wire frame |
| P1 | `auth.ts` role ADMIN/PLAYER, bootstrap mật khẩu mặc định; `app.ts:87` logger false | Scope giảng viên và vận hành chưa đủ | Scoped roles, email verification/recovery, safe bootstrap, session re-auth/audit/metrics; không MFA theo quyết định chủ sản phẩm |
| P2 | `App.tsx:23–24,286–295,399–407` demo board landing/sidebar460px | Tournament là panel phụ, không portal | Route-first information architecture |

Paths không có prefix trong bảng: engine → `packages/engine/src/`; runner → `packages/runner/src/`; server → `packages/server/src/`; frontend → `packages/web/src/`. Những hệ quả chưa inject fault được đánh dấu suy luận; không khẳng định đã khai thác hoặc đã đo outage.

## 3. Smoke đã thực sự chạy

### 3.1. Runner

Node24.21.0, npm11.19.0. Chạy actual CLI:

```text
npm run match:play -- --white sdk/python/starter_bot.py --black sdk/python/starter_bot.py --max-turns 12 --replay /tmp/oantuti-v2-audit.oantuti
```

Observed exit0; 12 ply; Black thắng với 6 quân còn lại so White4; CLI reason `MAX_TURNS_DRAW`; replay647 bytes; elapsed0.05s. Chỉ chứng minh một đường CLI Python/replay hoạt động; không chứng minh fairness/runtime300ply/throughput500đội/security. Reason chữ DRAW dù có winner là hành vi quan sát, không lỗi test giả định.

### 3.2. Browser và public API

Khởi động API127.0.0.1:3001 với DB `:memory:` và Vite127.0.0.1:4310, không dùng storage database người dùng. Khách chưa login:

- GET health/auth-me/bots/tournaments đều200; auth user=null;5 baseline bots1200Elo; không có giải trong DB tạm.
- Desktop1440×1000 landing mở sample board, BLACK WINS ở turn0; leaderboard narrow sidebar.
- Guest empty tournament state bảo bấm Create nhưng guest không có Create control.
- Mobile390×844: screenshot thấy sidebar, không thấy board; header cắt phía phải. DOM scrollWidth390 nên “không tràn ngang” không chứng minh responsive đạt.

Runtime artifacts tạm: desktop `/tmp/omp-sshots-15a4cb870f76fd27.webp`, mobile `/tmp/omp-sshots-15a4cb8f1b36fd29.webp`; không đưa ảnh demo vào production design như thể đã là UI mới. Source corroboration: `App.tsx:23–24,212–218,239–295`, `Header.tsx:56–63,65–118,199–218`, `LeaderboardView.tsx:172–190,324–330`.

Không chạy thử Bot độc hại, không đo sandbox escape, không thử restart database người dùng. Các phát hiện timeout, freeze và atomicity dựa source; phải có regression/fault rehearsal khi triển khai.

## 4. Test và benchmark hiện có không chứng minh điều gì

`tests/load/websocket-load.ts:42–45,88–163` synthetic single match/localhost,30ticks mặc định, không compiler/game workload, timestamp gửi dùng chung không correlate sequence. Không chứng minh1.000viewer1giờ hay500đội nhiều ngày. `packages/engine/tests/fuzz.test.ts:41–109` canonical trace seeded in-process, principal test1.000seeds; không hash full replay10.000 external-bot re-executions cross-platform. SDK tests starter bots200ms không là100ms parity certification. Session restart test không là scheduler restart test.

Audit không chạy test suite; không kết luận suite hiện pass hoặc fail. V2 acceptance tập trung behavior/invariants/recovery/security thực, không chỉ coverage percentage.

## 5. Giữ, thay và bỏ

- **Giữ & harden:** game semantics, topology/legal moves, pure transition tests, replay playback, Canvas rendering, NDJSON approach, ownership/version history, Monaco, React components, Fastify và ba SDK. **Không giữ Vite/runtime Node-watchdog vì quán tính:** canonical03 chọn Next SSR và Rust supervisor sau nghiên cứu stack.
- **Thay:** latest-bot execution → pinned artifact; async RAM loops → durable scheduling; global live Elo → season epochs; config_json authoritative standings → relational ledger; child Bot cạnh API → isolated workers; panel-only UX → portal; handwritten parallel proto representations → generated source.
- **Bỏ khi cutover:** projector publication gate, default admin password, dead advertised double-elimination surface, global casual rating side effects, unbounded active match cache, unsafe production local runner fallback. Không xóa lịch sử/replay v1; archive reader có version là nhu cầu thật, không alias runtime.

## 6. Ưu tiên thực hiện

G0 approve rules/budget → secure build/run proof +identity/team/persistence → submissions/freeze →durable result/runner → formats/rating →portal/public replay →load/recovery/migration rehearsal→production launch. Không mở Internet nhận code trước sandbox gates. Làm visual polish sớm bằng design tokens nhưng không dùng nó thay security/reliability gate. Research và các quyết định đích ở [index](README.md).
