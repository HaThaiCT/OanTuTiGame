# Đánh giá tech stack v2 — chọn theo ranh giới trách nhiệm, không theo stack cũ

**Ngày nghiên cứu:** 2026-10-13. **Phạm vi:** tài liệu và đề xuất kiến trúc; không triển khai, cài đặt, chạy test hay benchmark. Đây là research để người tích hợp quyết định; không tự thay thế các đặc tả canonical trong `docs/specs/v2`.

## 1. Kết luận điều hành

**Khuyến nghị: rewrite chọn lọc, không rewrite toàn bộ.** Giữ TypeScript/Fastify cho control plane và engine semantics thuần; thay đường thực thi Bot bằng **supervisor Rust độc lập trên Linux worker**, PostgreSQL làm authority cho durable jobs/result ledger; chuyển web portal sang **React trên Next.js với public HTML render phía server, tương tác replay/Canvas/editor phía client**. Không giữ Vite SPA chỉ vì đã dùng nó, cũng không chọn Rust/Next vì mới hơn. Hai thay đổi nhắm đúng điểm yếu của yêu cầu: deadline/freezer không phụ thuộc event loop của engine; public portal có HTML/metadata thực ngay khi tải URL.

Đây là **khuyến nghị kỹ thuật**, không phải kết quả benchmark chứng minh Rust nhanh hơn Go hoặc Next tốt hơn mọi SPA. Go là phương án supervisor hợp lệ nếu người vận hành không có năng lực Rust; Django là phương án control plane hợp lệ khi trường có đội Python mạnh và ưu tiên back-office. Không có dữ liệu hiện tại chứng minh cần đổi control plane sang Go hoặc port engine sang Rust để phục vụ 500 đội. Số đội không tương đương concurrent requests hay số execution slots.

Quyền đổi toàn bộ stack đã được mở. Tuy vậy, lợi ích phải xuất phát từ requirements, không từ việc “được phép rewrite”. Việc giữ TS được biện minh bằng **một implementation semantics dùng được ở trusted worker và browser**, không bằng sunk cost của code v1.

## 2. Cách đọc bằng chứng và tiêu chí

- **[FACT]** là khả năng/giới hạn được nguồn chính thức mô tả; liên kết đặt ngay tại luận điểm.
- **[RECOMMENDATION]** là lựa chọn đề xuất cho OanTuTi.
- **[INFERENCE]** là hệ quả thiết kế từ các fact; không phải đo lường.
- **[UNVERIFIED]** là điều cần chứng nhận trên kernel/runtime/hardware thật; không biến thành cam kết.

Mục tiêu là giải đại học tối đa 500 đội, bốn format, tự động nhiều ngày, Bot không tin cậy, khách xem không đăng nhập và UX chuyên nghiệp. Thứ tự ưu tiên: correctness/fairness và isolation → ledger/recovery → vận hành dễ hiểu → public discoverability/UX → hiệu năng đã đo. Không dùng benchmark “hello world” framework làm proxy cho tournament throughput. Capacity phải tính số game, service time sandbox, retries và lượng khách thực.

Bối cảnh repo đọc được: kiến trúc v2 đang đề xuất TS/Fastify/React-Vite, PG và gVisor; security v2 yêu cầu 100 ms CPU active turn, suspend sandbox inactive và watchdog ngoài event loop. `packages/engine/src/rules.ts:18–40,50–90` hiện có action/delta/victory và kiểm tra luật dựa `GameState`, không cần API/DB để định nghĩa combat. Đây là evidence về seam có thể tách, **không chứng minh toàn engine đã có portability/correctness được chứng nhận**. Research cũ và audit không phải lý do để khóa stack mới.

## 3. Control plane: TS/Fastify, Go hay Django?

| Ứng viên | [FACT] từ nguồn chính thức | [INFERENCE] và đánh đổi cho sản phẩm |
|---|---|---|
| **TypeScript + Fastify** | Fastify dùng JSON Schema để validation/serialization, có response schema; schema được compile bằng `new Function`, nên không nhận schema do người dùng cung cấp. Async DB checks không nên nằm trong initial validation: dùng hook sau validation ([Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)). `node-postgres` có transaction nhưng mọi statement phải dùng **cùng client**, không `pool.query` rải rác ([pg](https://node-postgres.com/features/transactions)). | Phù hợp API I/O, typed contracts và modular monolith. Auth/MFA/authorization, migrations, jobs và ledger phải thiết kế rõ; Fastify không tự cung cấp tournament reliability. Không chạy engine CPU-heavy/compiler/Bot trong API event loop. Response schema hữu ích cho DTO public allowlist nhưng không thay authorization. |
| **Go control plane** | `net/http` có client/server, server timeouts và handlers; client/transport dùng đồng thời được qua goroutines ([Go HTTP](https://pkg.go.dev/net/http)). `database/sql` có `BeginTx`, `Commit`, `Rollback`; không trộn `sql.DB` queries ngoài `sql.Tx` đang dùng ([Go transactions](https://go.dev/doc/database/execute-transactions)). | Control service rõ, concurrency và deployment binary là điểm hấp dẫn; vẫn phải chọn PG driver, auth, migrations, schema/codegen, admin UI. Đổi ngôn ngữ không tạo ledger đúng, không xóa DB locking contention. Nếu engine vẫn TS, Go vẫn có seam IPC; nếu port engine thì phải trả chi phí parity. |
| **Django control plane** | Django có `atomic`, savepoints và `on_commit`; mặc định autocommit ([transactions](https://docs.djangoproject.com/en/5.2/topics/db/transactions/)). Django 5.2 có ASGI/async views nhưng transactions chưa hoạt động ở async mode, cần một sync function qua `sync_to_async` ([async](https://docs.djangoproject.com/en/5.2/topics/async/)). Admin tự động được khuyến nghị cho quản lý nội bộ, không phải toàn frontend ([admin](https://docs.djangoproject.com/en/5.2/ref/contrib/admin/)). | ORM/admin/auth conventions thuận lợi cho roster, course và moderation. Public portal, bracket, authoring/replay vẫn cần UI theo tác vụ; không lấy admin làm “professional UX” cho đội/khách. Chọn transactional handlers sync nhất quán thay vì trộn async ORM tùy tiện. Python control plane không phải lý do chạy untrusted Bot cùng tiến trình. |

**[RECOMMENDATION] Chọn TS/Fastify control plane modular monolith.** Lý do là control workload phần lớn HTTP/PG/object-store I/O, cùng contract với frontend/engine, trong khi yêu cầu fairness được chuyển sang execution plane khác. Không có requirement nào ở đây mà Go/Django có và Fastify không thể đáp ứng bằng thiết kế dữ liệu đúng. Ưu thế admin Django chưa đủ thay một portal tournament theo tác vụ; ưu thế compiled service Go chưa được chứng minh là bottleneck của hệ thống.

**Điều kiện đổi quyết định:** chọn Django nếu ownership thực tế của trường là Python/Django và back-office chiếm phần lớn công việc; chọn Go nếu đội duy trì Go mạnh hơn và measurements control API cho thấy Node CPU/memory là vấn đề sau khi đã tách engine, tối ưu queries/cache. Năng lực đội là input chưa được cung cấp, không được giả định. Nếu greenfield với đội ngang năng lực, TS vẫn có lợi thế một nguồn semantics/contract; không bắt buộc đổi chỉ để đồng nhất với supervisor.

## 4. Jobs và result ledger: PostgreSQL mới là seam bền vững

**[FACT]** `FOR UPDATE ... SKIP LOCKED` của PostgreSQL bỏ các row đang bị khóa; tài liệu nói view có thể không nhất quán, không phù hợp query tổng quát nhưng có thể dùng để tránh contention cho nhiều consumer của bảng kiểu queue ([PG SELECT, locking clause](https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE)). Nó không phải delivery exactly-once và không tự xây lease.

**[RECOMMENDATION]** Một PostgreSQL authority cho registration/frozen entries/schedule/jobs/attempts/accepted result/ledger/outbox. Không thêm Redis queue chỉ vì framework có plugin. Transaction claim ngắn: chọn eligible job có index + `SKIP LOCKED`, cập nhật `leaseOwner`, `leaseUntil`, tăng `fencingToken`, commit rồi mới chạy sandbox. Không giữ row lock hoặc DB transaction xuyên 300 ply.

Commit result phải kiểm tra attempt/token hiện hành và unique identity; transaction ghi accepted outcome + encounter contribution + outbox đồng thời. Duplicate delivery trả receipt hiện có, không thêm điểm lần hai. Worker cũ không được ghi đè worker mới; lease expiry không đồng nghĩa response của Bot là lỗi Bot. Standings/rating là derived state có revision, có thể rebuild từ ledger; không “last writer wins” JSON aggregate.

`on_commit`/callback publish không phải durable outbox: process có thể chết sau commit trước callback. TS/Go/Django đều phải có outbox row **trong cùng transaction** và publisher có thể retry. Source/artifact/replay ở object store cần digest và lifecycle reconciliation vì transaction PG không tự commit atomically với object store. Synchronous replication/PITR/second evidence copy là quyết định durability và vận hành, không được framework miễn phí cung cấp.

**[UNVERIFIED]** Throughput claim/result transactions, index contention, scheduler failover và RPO thực cần fault rehearsal. Không kết luận PG “dư sức 500 đội” nếu chưa đo workload, nhưng cũng không ép microservices/Redis theo số đội.

## 5. Execution supervisor: Rust, Go hay Node?

### 5.1 Điều không ngôn ngữ nào thay thế được

**[FACT]** Linux cgroup v2 cung cấp `cpu.stat` với `usage_usec`, `user_usec`, `system_usec`; `cpu.max` giới hạn bandwidth theo period. `cgroup.freeze=1` dừng cgroup và descendants, nhưng thao tác **bất đồng bộ**, phải đợi `cgroup.events:frozen=1`. `cgroup.kill` gửi SIGKILL tới cây cgroup và xử lý concurrent forks ([kernel cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)).

**[FACT]** gVisor thu hẹp tiếp xúc với host System API nhưng dựa host cgroups để chống resource exhaustion; network policy vẫn cần ở container level. gVisor không thay secure architecture và không bảo đảm chống hardware side channels ([security model](https://gvisor.dev/docs/architecture_guide/security/)).

**[INFERENCE]** Ngôn ngữ supervisor **không đo CPU thay OS**, không làm freezer tức thì và không biến Linux thành hard-real-time. `cpu.max=1 core` không phải “100 ms CPU mỗi turn”; quota định kỳ có thể nạp lại trong turn. `SIGSTOP` main PID không chứng minh toàn cây Bot dừng. Chỉ đọc `process.cpuUsage()` của supervisor/engine không phải CPU Bot.

**[RECOMMENDATION]** Mỗi Bot là một sandbox riêng, nằm trong cgroup riêng bao đầy đủ workload host phục vụ sandbox theo accounting profile đã chứng nhận. Supervisor/engine/watchdog ở ngoài cgroup Bot. Delta counter từ baseline trước unfreeze đến **freeze-confirmed** là CPU turn; overhead runsc/Sentry/Gofer thuộc cgroup nào phải công bố và kiểm chứng, không tự gọi đó là bare algorithm CPU. Nếu Gofer ngoài counter hoặc Sentry dùng chung giữa hai Bot, không có attribution per-Bot đúng như giả định: phải sửa topology/profile, không chia CPU ước lượng.

### 5.2 So sánh

| Ứng viên | [FACT] | [RECOMMENDATION]/[INFERENCE] |
|---|---|---|
| **Rust** | Rust không có garbage collector; ownership/type system hướng memory/thread safety ([Rust](https://rust-lang.org/)); `Send`/`Sync` kiểm soát truyền/chia sẻ giữa threads, unsafe implementations phải giữ invariants ([Rust Book](https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html)). | Phù hợp TCB nhỏ điều khiển cgroup, bounded IPC và lifecycle tài nguyên. Dùng dedicated OS watchdog thread, không để watchdog chờ cùng async executor với parser/upload/engine. Không có GC là lợi thế cho kiểm soát jitter, **không** chứng minh p99 hoặc hết race/logic errors; syscall FFI/unsafe cần review. |
| **Go** | Standard Go toolchain có GC; hướng dẫn mô tả tradeoff CPU/memory và heap allocation ([GC guide](https://go.dev/doc/gc-guide)). gVisor Sentry chính thức là pure Go binary ([gVisor](https://gvisor.dev/docs/architecture_guide/security/)). | Hoàn toàn khả thi cho supervisor; bản thân gVisor là phản chứng của “Go không phù hợp isolation”. Giữ watchdog workload nhỏ, allocation thấp và tách khỏi game computation; đo scheduler/GC jitter. Chọn nếu đội Go duy trì tốt hơn; không loại Go bằng khẳng định GC luôn phá budget. |
| **Node/TypeScript** | JS callbacks chạy trên event loop; callback blocking cản callbacks khác và có thể gây DoS. JSON/regexp và synchronous APIs có thể block ([Node guide](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)). | Có thể điều phối I/O nếu watchdog process thực sự độc lập. **Không chọn Node làm watchdog authority chung event loop với engine/JSON/log upload**. Một Node child process không tự là sandbox. Tách native watchdog thì phần critical đã chuyển sang native dù orchestration còn TS. |

**[RECOMMENDATION] Chọn Rust supervisor, giữ scope nhỏ.** Mục tiêu là ownership rõ của FD/child/cgroup và loại coupling watchdog–engine, không phải viết lại tournament logic bằng Rust. Go đứng thứ hai rất sát; không có benchmark cho phép tuyên bố Rust thắng Go về throughput hoặc đáp ứng target polling 1 ms. Điều kiện deploy là canary chứng minh CPU attribution/freezer/network/limits và overshoot dưới admission load. Ngôn ngữ đẹp không mở security gate.

## 6. Seam chính xác: Rust supervisor + TS engine

Tất cả tên dưới đây là **module/interface đề xuất**, không phải code đã có.

### 6.1 Ownership và các tiến trình

| Module/process | Sở hữu | Không được sở hữu |
|---|---|---|
| `control-plane` — TS/Fastify | Identity/team, artifact manifest, schedule, PG claim/lease/result acceptance, ledger/outbox, public/private DTO | Compiler, Bot process, privileged launcher |
| `arena-supervisor` — Rust trên worker | Claim/heartbeat bằng credential giới hạn; verified artifact cache; sandbox lifecycle; Bot stdin/stdout/stderr; cgroup accounting/freezer; evidence spool/delivery | Luật combat/victory, tournament scoring authoritative, DB password/session keys |
| `game-host` — trusted Node child, một process/game | Import `packages/engine`; initial state, observation/request bytes, legal move/transition, terminal state, deterministic replay events | Bot FDs, cgroup paths/write permissions, runsc launcher, worker network credential, tự cấp/unfreeze budget |
| `sandbox-adapter` — Rust module | Allowlisted pinned runtime/profile, launch/build/run/kill và kiểm tra đúng cgroup | Arbitrary command/path từ job hoặc engine |
| `turn-watchdog` — dedicated Rust thread | Monotonic wall deadline; polling OS CPU counter; freeze/kill quyết định độc lập | Await engine, upload, DB hoặc scheduler để dừng Bot |

`arena-supervisor` có thể nhận cgroup delegation tối thiểu; nếu bootstrap cần quyền cao, dùng helper local chỉ nhận manifest/profile allowlist. Không cho game-host hoặc Bot gọi helper. Engine child trusted nhưng vẫn non-root, hạn chế FS/network; malformed Bot output không được đưa thẳng vào JS dưới dạng JSON vô hạn.

### 6.2 Transport và envelope

**[RECOMMENDATION]** Supervisor tạo `socketpair` Unix stream riêng và truyền **một FD** cho game-host; không listener TCP, không socket path world-writable và không FFI addon gọi Rust trong Node. Mỗi frame: `u32` big-endian length + Protobuf payload, maximum **1 MiB/frame**, tối đa một request chờ response mỗi chiều; cap áp dụng trước allocate/decode. Một `execution.proto` là nguồn codegen Rust/TS; không handwritten hai type trees. Dùng `uint64` CPU/monotonic nanoseconds trong Rust và `bigint`/representation hỗ trợ 64-bit ở TS, không ép qua JS `number` mất precision.

Envelope chung: `protocolVersion`, `gameId`, `attemptId`, `seq`, `requestId`; handshake xác nhận `rulesetVersion`, `engineDigest`, `resourceProfileDigest`, `mapDigest`, seed. Không đồng nhất protocol IPC này với Bot NDJSON hay public WS protocol; không áp giới hạn 200 B/turn của public transport cho observation IPC.

Messages tối thiểu:

- Supervisor → engine: `StartGame(manifest, map, seed)`, `TurnObservation(botSide, requestId, boundedResponseBytes, cpuUsageUsec, wallElapsedNs, freezeConfirmed)`, `ExecutionFault(classification, sanitizedEvidenceRef)`, `StopGame`.
- Engine → supervisor: `EngineReady`, `RunBotTurn(botSide, turnNumber, requestId, boundedRequestBytes)`, `TurnCommitted(requestId, replayEvent, stateDigest, nextSide)`, `GameFinished(outcome, terminalReason, finalStateDigest)`.
- Supervisor điều khiển startup `INIT/READY` của Bot theo protocol riêng; `RunBotTurn` không nhận budget tùy ý, argv, shell command, mount hoặc cgroup path. Budgets chỉ lấy từ immutable resource profile trong manifest. Observation/terminal semantic payload có version và digest; private source không qua IPC.

Frame cap 1 MiB là đề xuất transport supervisor–engine, không mở rộng Bot quotas. **Request gửi Bot tối đa 256 KiB** theo proposal canonical05 đã chọn; full request theo map lớn nhất phải vừa cap/profile và được kiểm chứng. Vượt cap do engine hợp lệ là `INFRA_FAILURE`, không xử thua Bot. Bot stdout/stderr có caps riêng; stderr/log không đi vào control stream và luôn drain có quota.

### 6.3 State machine một turn

1. Cả hai Bot đã READY và **freeze-confirmed**. Engine sinh request; supervisor kiểm tra active side/seq và bounded bytes. Chỉ một turn in flight/game.
2. Khi Bot còn frozen, supervisor **chỉ stage request đầy đủ trong private bounded buffer**, tối đa 256 KiB; không cố ghi trọn request vào pipe của Bot đang frozen. Pipe có thể nhỏ hơn request và Bot chưa chạy để drain, nên full write lúc frozen có thể deadlock. Staging/validation lỗi là infrastructure fault, không trừ CPU Bot.
3. Supervisor lấy OS CPU baseline, đăng ký watchdog và bắt đầu wall monotonic deadline trước unfreeze, bật đúng một sandbox; sau đó thực hiện **nonblocking write/read có bounds**, ghi request theo từng phần khi pipe writable và đồng thời drain output. CPU/wall của pha transport sau unfreeze **đều nằm trong turn budget**, không có thời gian đọc request miễn phí hoặc reset timer sau write. Backpressure không block watchdog; watchdog giữ quyền freeze độc lập ngay cả khi Node bị GC, treo loop hoặc IPC stalled.
4. Rust chỉ làm **framing/output bounds/request correlation** của Bot response; khi có candidate response hoàn chỉnh, freeze toàn sandbox ngay. Chờ `frozen=1` có deadline và đọc final CPU counter. CPU bao cả freeze latency. Vượt CPU limit thì candidate không hợp lệ dù bytes đã đến trước deadline; không cộng grace để “cứu” response.
5. Khi cả hai sandbox dừng, supervisor gửi bounded candidate + immutable accounting evidence cho engine. TS parse/schema-check/legal-move/transition; unsolicited/stale/multiple responses là protocol fault theo profile. Không unfreeze Bot đối thủ trước `TurnCommitted` của engine.
6. Engine commit state/replay event **trong game memory**, không PG ledger. Supervisor lưu evidence/replay spool và outcome; control plane chỉ accept khi pinned input, fencing token, digest và durable evidence đạt contract. Node chết/stall hoặc freeze/counter không đọc được là infrastructure failure; không tùy tiện đổi thành Bot forfeit.

Engine response timeout là worker infrastructure deadline độc lập Bot wall deadline. Supervisor mất heartbeat/lifecycle state thì execution bị quarantine; supervisor crash phải có host-level cleanup/reaper ngoài process để kill sandbox còn sống. Không tin destructors chạy khi process bị SIGKILL. Khi counter/watchdog không khỏe, freeze/kill và không claim thêm; không fallback native spawn.

**[UNVERIFIED]** OS counter granularity, freezer delay, gVisor mapping, pipe capacity và jitter dưới mixed load. Sampling 1 ms/overshoot p99 ≤5 ms đang là target cần chứng nhận, không guaranteed bởi Rust. Profile phải mô tả overhead tính vào CPU; mọi Bot trong cùng tournament dùng profile/runtime/hardware class đã chốt.

## 7. Frontend: React/Vite route SPA hay Next SSR?

| Phương án | [FACT] | Hệ quả |
|---|---|---|
| **React + Vite route SPA** | Vite có SSR và prerendering, nhưng native SSR API được mô tả là low-level dành cho framework/library authors ([Vite SSR](https://vite.dev/guide/ssr.html)). Google có thể render JavaScript, nhưng app-shell phải qua rendering queue; không phải mọi bot chạy JS. SPA cần xử lý status/soft-404 và crawlable `<a href>` ([Google Search](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)). | Static assets dễ self-host và workspace/replay rất phù hợp client rendering. Route SPA **không tự** cung cấp public initial content, per-route OG hay HTTP404. Có thể bổ sung SSR/SSG, nhưng khi đó không còn là SPA thuần và phải duy trì routing/data/HTML pipeline. Không nói “SPA không SEO được”. |
| **React + Next server-rendered public routes** | Next có `metadata`/`generateMetadata`, OG/robots/sitemap conventions; metadata động có xử lý bot không hỗ trợ streaming ([metadata](https://nextjs.org/docs/app/getting-started/metadata-and-og-images)). Self-host bằng Node/Docker hỗ trợ rendering/streaming; docs khuyến nghị reverse proxy, lưu ý cache per-instance, multi-instance invalidation/version skew và Server Function keys nếu dùng ([self-hosting](https://nextjs.org/docs/app/guides/self-hosting)). | Public overview/rules/standings/match text có HTML và share preview; Canvas/editor/live subscription vẫn client. Thêm web runtime, rollout/cache discipline; không bắt buộc Vercel, Redis hay serverless. SSR không tự tạo accessibility, chất lượng visual hay privacy. |

**[RECOMMENDATION]** Chọn **một Next web app** cho portal, không hai portal Vite + Next song song. Reuse React/Canvas/design-system components sau kiểm tra boundary; client components cho editor/replay/browser APIs. Public pages render HTML từ **public read API/DTO**; không đọc private tables trực tiếp trong web process. Fastify tiếp tục là mutation/auth/result authority; Next không trở thành backend tournament thứ hai.

Public routes cần: directory, tournament overview/rules/schedule/standings/bracket/match summary/team public profile, unique title/description/canonical/OG và status404 thật; replay metadata và text summary có trong HTML, animation hydrate sau. Public state có `revision`, `updatedAt`, provisional/final/stale. Không SSR toàn Monaco hoặc Canvas pixels vì SEO. Login workspace private `no-store`, không đưa PII/source vào cache/metadata/OG/sitemap.

Baseline self-host đơn giản: reverse proxy → Next replicas cho web và Fastify replicas cho API/live, pinned build cùng version. **Không dùng ISR/shared Next cache cho mutable standings ở baseline:** render theo request từ public read API, để API/edge cache công khai có policy ngắn và revision rõ. Tránh Server Actions cho domain mutations nên không thêm synchronization key path không cần thiết. Assets fingerprinted và giữ qua rolling deploy. SSR load/caching và public API latency phải đo; cache read-model có thể bổ sung theo evidence, không thêm Redis chỉ để bật feature framework.

Nếu discoverability chỉ nghĩa là tìm trong portal, trường chỉ dùng LAN, và không cần external sharing/indexing, Vite SPA có thể là lựa chọn vận hành đơn giản hơn. Nhưng với anonymous public audience/professional shareable portal, initial HTML là lựa chọn có rationale mạnh hơn; đây không phải yêu cầu UX suy ra rằng Next chắc chắn thắng về usability.

## 8. Pure game semantics: portable behavior khác portable binary

**[RECOMMENDATION]** `packages/engine` chỉ giữ deterministic domain: graph/map, pieces/state, action legality, combat, transition, victory, ruleset version. Không import Node I/O, Fastify, PG, sandbox/process, wall clock hoặc unseeded randomness. Tournament pairing/rating là domain riêng, không đưa vào per-ply engine.

Một implementation TS chạy trusted Node game-host và browser replay là cách giảm semantic drift. Transport chuyển `Map`/`Set` sang ordered arrays/explicit DTO; canonical digest phải định nghĩa field ordering, integer range, seed PRNG, iteration/tie ordering và invalid-input behavior. Không hash `JSON.stringify` object bất kỳ rồi gọi đó là cross-language canonical.

**[INFERENCE]** Nếu sau này port Rust/Go, có thể port **pure semantics** mà không đổi jobs/worker/public interfaces. Nhưng arithmetic, JS number bounds, seed generation, ordered iteration và terminal reasons cần golden fixtures/differential tests. Nếu không chứng minh parity, ruleset mới phải có version, không thay silently replay authority. Rust→WASM có thể giữ một nguồn semantics cho web/worker nhưng chưa có evidence CPU hot path là bottleneck để biện minh rewrite này.

Không bắt Rust supervisor reimplement `isLegalMove` hoặc victory để “bớt Node process”; như vậy tạo hai authorities. Supervisor quyết resource/protocol framing; TS engine quyết game semantics; control plane quyết tournament ledger. Browser engine chỉ phục vụ hiển thị, không tự xác nhận official result.

## 9. So sánh phương án end-to-end và hệ quả tích hợp

| Phương án | Lợi ích có căn cứ | Chi phí/rủi ro | Quyết định đề xuất |
|---|---|---|---|
| Giữ toàn bộ TS/Vite, thêm gVisor/PG | Ít runtime mới, semantics dùng chung | Nếu watchdog vẫn event loop thì thiếu seam bắt buộc; public HTML cần giải pháp thêm | Không chọn dưới dạng hiện tại; Node orchestration chỉ chấp nhận khi watchdog độc lập thực |
| **TS control + Rust supervisor + TS engine + Next web + PG** | Đúng trust/process seam; no-GC critical controller; public server HTML; cùng engine semantics | Rust ownership/support, thêm IPC contract và web runtime; cần chứng nhận OS/gVisor | **Chọn rewrite có mục tiêu** |
| Go control + Go supervisor + TS engine + Next | Nhiều native service cùng Go; ít Rust skill demand | Cross-language contracts vẫn tồn tại; control rewrite chưa giải bottleneck đã đo | Hợp lệ nếu đội Go/measurements biện minh |
| Django control + native supervisor + Next/React | Built-in back-office conventions mạnh | Python/TS/native ownership; admin không thay portal; sync transactional path cần rõ | Hợp lệ nếu trường có Python ownership mạnh |
| Go/Rust toàn backend và engine, Next frontend | Có thể native hóa execution/semantics; WASM nếu chọn Rust | Full rules parity, SDK/replay migration và test surface lớn; không loại nhu cầu PG/isolation/watchdog | Chưa có evidence chọn full rewrite |

**Implications cho người tích hợp specs/plan (chưa áp dụng ở tài liệu canonical):**

1. Architecture: thay cụm “giữ toàn bộ tech stack” bằng quyết định theo từng plane; thêm Rust supervisor/game-host IPC, Next web reader, vẫn một control authority.
2. Security: OS cgroup accounting/freezer là authority; watchdog dedicated native thread độc lập TS engine, fail-closed readiness và host reaper. Không gọi “Rust sandbox” — sandbox là Linux/gVisor policy.
3. Data: transaction claim/result/ledger/outbox giữ nguyên semantics bất kể framework; acceptance không phụ thuộc browser hay renderer. Migrate mọi caller khi cutover, không runtime dual-write.
4. UX: thay Vite-only/template constraint bằng framework-agnostic component reuse; public HTML/metadata/404/privacy cache phải có acceptance criteria; workspace/editor/Canvas vẫn client.
5. Plan: có contract/codegen và isolation proof trước worker implementation, parity fixtures cho engine trước refactor, public HTML/privacy verification trước portal launch. Không đưa port engine native vào critical path nếu chưa có bottleneck evidence.
6. Vận hành: team cần ownership Rust và Next self-host; versioned runtime/image/build manifests, runbooks cho supervisor crash/IPC stall/cache stale. Nếu skill ownership không đạt, quyết định lại Go supervisor trước triển khai chứ không fallback ở production.

**Không có test/build/install nào được chạy trong research này.** Các gate cần người triển khai thực hiện: negative sandbox tests; CPU/freezer attribution và overshoot trên admitted load; engine stall/kill và supervisor crash cleanup; stale fencing/duplicate result/crash-before-outbox publish; SSR public HTML404/metadata/PII-cache audit; throughput/soak nhiều ngày cho bốn format. Những gate này mới là evidence launch, không phải tên tech stack.

## 10. Danh mục nguồn chính thức đã đối chiếu

1. [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html) — `cpu.stat`, `cpu.max`, freezer asynchronous confirmation, cgroup kill/hierarchy.
2. [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/) — host cgroups/network policy, security boundary/limitations, pure Go Sentry.
3. [Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) — JSON Schema, compiled schemas và warning về user schemas/async validation.
4. [node-postgres transactions](https://node-postgres.com/features/transactions) — same-client transaction boundary.
5. [Go net/http](https://pkg.go.dev/net/http) và [Go transactions](https://go.dev/doc/database/execute-transactions) — standard HTTP/concurrency và `sql.Tx`.
6. [Django 5.2 transactions](https://docs.djangoproject.com/en/5.2/topics/db/transactions/), [async support](https://docs.djangoproject.com/en/5.2/topics/async/), [admin](https://docs.djangoproject.com/en/5.2/ref/contrib/admin/) — atomic/sync transaction limitation và intended admin scope.
7. [PostgreSQL16 SELECT locking clause](https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE) — queue use/limitations của `SKIP LOCKED`.
8. [Rust](https://rust-lang.org/) và [Rust Book Send/Sync](https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html) — no GC và concurrency type guarantees, không deadline guarantee.
9. [Go GC guide](https://go.dev/doc/gc-guide) — standard toolchain GC costs/tradeoffs; không dùng ví dụ trong guide làm measured workload OanTuTi.
10. [Node event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) — blocking callbacks/JSON/sync APIs.
11. [Vite SSR](https://vite.dev/guide/ssr.html) — native SSR/prerender capability và low-level API caveat.
12. [Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting) và [Metadata/OG](https://nextjs.org/docs/app/getting-started/metadata-and-og-images) — self-host rendering, multi-instance cache/rollout, metadata và crawler handling.
13. [Google JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) — JS rendering queue, SSR/prerender, crawlable links, soft404.

Các trang `latest` là mutable; implementation phải pin supported release/digest và kiểm tra đúng version. Facts của Django ở đây dựa trang 5.2 cụ thể, không suy tự động sang mọi bản mới hơn. Chưa có official docs nào trong danh sách chứng minh capacity, p99 deadline hoặc isolation của deployment OanTuTi thực tế.
