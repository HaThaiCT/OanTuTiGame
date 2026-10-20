# Rebuild ledger — plan: OANTUTI_ARENA_V2_PLAN.md

## Current status — LAN software delivery (updated 2026-10-19)

The latest delivery scope is LAN software only. ONLINE remains deferred by the user. LAN account flows, tournament logic, Rust authority, UID-bound broker/native worker, durable completion, archive, corrections, and role-separated UX are implemented; see [LAN completion evidence](lan-completion-evidence.md) and [LAN UX evidence](core-role-ux-evidence.md). Do not use earlier S-session labels below as current gap inventory.

The demo is on schema 26 and serves the portal/API locally. Current readiness is `degraded`, `productionReady=false`: the demo arms the unsandboxed development executor, has no native gateway/worker and disables the backup fence. It is not safe for untrusted Bot execution.

Remaining handoff items: human U5 visual/usability and accessibility acceptance, and an actual CI runner pass after the workflow update. Locally, migration locking/checksums/grant atomicity, the version-26 fresh install under a separate migrator role, the Bookworm server image and its bundled Rust verifier have been verified. `npm audit --omit=dev --workspace=@oantuti/server` reports zero findings; the web workspace still has known low/moderate advisories (including Monaco's bundled DOMPurify 3.4.15 and the bracket viewer dependency tree), not waived or described as fixed. Infrastructure provisioning, capacity, off-host custody and endurance runs remain outside this software-delivery scope and have no measured claim. See `acceptance-matrix.json` `deliveryScopeOverride` and [LAN handover boundaries](../../runbooks/lan-handover.md#9-bi%C3%AAn-nh%E1%BA%ADn-nghi%E1%BB%87m-thu).

## Fresh personal-machine installation proof (2026-10-21)

Re-verified the portable Compose package end-to-end on this host as a clean target (project `oantuti-install-proof2-20261021`, gateway 127.0.0.1:44300), separate from the live demo (4300/4301/55434), which was restored and left running unchanged.

- **Two real defects found and fixed, both fail-closed:** (1) the scrubbed demo SQL dropped `job_attempts` rows still referenced by `job_completions` FK, so fresh restore rolled back; the bundle was fixed and covered by `packages/server/tests/portable-demo-restore.test.ts` (10/10 pass). (2) Compose file-backed secrets at host mode `0600` were unreadable by the PostgreSQL container UID, so init aborted and the health marker kept the stack unhealthy; README now specifies secret directory `0700` with files `0444` (Compose `uid/gid/mode` cannot remap bind-source permissions).
- **Fresh restore into an empty database:** 126 users / 72 teams / 46 tournaments / 616 accepted results; 628 objects inventoried, 0 missing; no sessions/reset tokens/test snapshots shipped. Restore also passed under a non-superuser role (`arena_personal`), and re-running restore on a non-empty database exits 1 without overwriting.
- **Fresh Compose stack:** all four services (postgres, server, web, gateway) healthy after `up --build`. Browser-verified: public rankings (50 teams listed), admin login, organizer console, and a 300-move official replay page with SHA-256 checksum match. API replay download returns 200.
- **Persistence across restart:** `docker compose down` + `up -d` (volumes kept) → identical counts (126/72/46/616), storage volume holds 616 replay files + 12 submission archives, admin login and replay download still 200.
- Remaining limits unchanged: control-plane packaging evidence only — no TLS, off-host backup, sandboxed execution, or VPS certification claim.

## Historical deployment pause (2026-10-18)

Public/VPS commissioning remains paused unless the user authorizes it. Historical session summaries/checkmarks below are records, not the current status.

## Portable local/VPS web packaging (2026-10-18)

- Replaced obsolete Vite/dist web image with actual Next standalone runtime and nginx SSR/API/WebSocket proxy; Compose now includes PostgreSQL 16 with file secrets, versioned schema initialization and a separate application role. Loopback listener remains default; unsandboxed Bot execution is disabled.
- Built both images, initialized 37 tables/checksums, verified audit UPDATE forbidden, authenticated admin login and course/tournament mutations through isolated gateway. Account survived PostgreSQL restart; API restart needed after database termination. Actual temporary Compose v5.6.0 `config` and `up --build` passed; gateway pages/API returned 200 at 4391. Disposable verification containers/volumes/credentials removed, live demo untouched.
- [Portable deployment instructions](portable-deployment.md) include exact limits. This is control-plane packaging evidence, not full production execution, TLS/off-host-backup or VPS certification. Target VPS and sandbox remain prerequisites; dependency hardening remains open.

## Website UI cutover — game-arena.ai reference (2026-10-18)

- Shared shell, charcoal palette, monospace typography, compact navigation, homepage intro/ranking/catalog and all existing route surfaces restyled. Website only; no native desktop/mobile apps. OanTuTi gameplay and actual data retained.
- Build succeeded; real browser inspection covers public, auth, tournament, workspace, organizer, replay and projector routes. Narrow browser checks on seven routes had no page-level overflow. Search filtered 8 public tournaments to 2; actual student login succeeded; WASM accepted an 11-ply replay (WHITE/EXTINCTION).
- Review corrections exercised: visible search focus, light-theme filter contrast, synchronized theme toggles, unique SVG identifiers, and hiding expanded narrow navigation on wide resize (header remains 65px).
- Detailed evidence and fidelity limitations: [UI reference evidence](2026-10-18-ui-reference-evidence.md). This is not a pixel-diff parity or human visual sign-off claim; proprietary font/artwork and OanTuTi-specific workflows differ from the reference.

## Rà soát thiếu sót lần hai (2026-10-19)

Rà soát độc lập + kiểm tra trực tiếp sau đợt hoàn thiện. Tìm thấy và xử lý:

- **Object root không riêng tư nhưng không ai chặn** (thiếu sót thật): replay object cũ trên host là `0664` và `storage/replays`, `storage/replay-staging`, `~/.local/share/oantuti/development/objects/{replays,staging}` là `0775`. Hệ quả: backup CLI từ chối dữ liệu thật (tức là **không thể sao lưu** deployment vừa nâng cấp) và object đọc được bởi user khác. Đã thêm `persistence/private-root.ts`: store **từ chối khởi động** nếu root do operator chỉ định mà group/world đọc được, tự siết `0700` cho root mặc định do ứng dụng tạo, và `Dockerfile.server` tạo sẵn `/app/storage/*` với `0700`.
- **Backup CLI chưa từng chạy thật** → nay đã chạy end-to-end trên dữ liệu thật: `produce` → `verify` (digest `81a4a23b…`, có `deploymentId`/`generation`); `publish` từ chối khi thiếu role `oantuti_backup_verifier`; `activate-restore` từ chối khi thiếu `--isolated yes`. Producer cũng đã chứng minh fail-closed với root tương đối, root công khai, thiếu object theo inventory, và object bị thay đổi.
- **Object root không chọn được** (thiếu sót thật): đường dẫn object luôn nằm trong `<cwd>/storage` nên operator không thể đặt dữ liệu lên đĩa dữ liệu. Đã thêm `OANTUTI_SUBMISSION_DIR`/`OANTUTI_REPLAYS_DIR`/`OANTUTI_SPOOL_DIR`.
- **Không có test chặn lệch version schema** — docstring trỏ tới `tests/readiness.test.ts` không tồn tại. Đã thêm `tests/schema-version.test.ts` so `EXPECTED_SCHEMA_VERSION` với migration mới nhất và sửa docstring.
- **CI không chạy được suite server** (thiếu PostgreSQL, thiếu migration): thêm service `postgres:16`, DB `arena_ci_test`, bước `apply-migrations.mts --apply`, và env PG/`OANTUTI_DEV_EXECUTION`/`OANTUTI_BACKUP_FENCE` cho job `verify`. *Chưa chạy được trên runner thật — chỉ sửa workflow.*
- **Tài liệu còn nói bề mặt v1 "được bảo vệ"** dù nó đã bị gỡ: đồng bộ runbook và `portable-deployment.md` (v2 không mount route v1 → 404, `OANTUTI_LEGACY_API` chỉ có nghĩa ở chế độ standalone SQLite).
- **Không còn reclaimer trùng**: control plane là chủ sở hữu duy nhất các nhiệm vụ định kỳ (đã kiểm tra không còn `setInterval` reclaim riêng).
- Sau các sửa trên: suite server vẫn **67 files / 431 passed / 1 skipped**, Rust không đổi (167 pass), `tsc` sạch. Ruling: giữ guard nghiêm cho root do operator chỉ định (không tự chmod đường dẫn người dùng gõ) — nếu sai thì một deployment nâng cấp sẽ dừng với thông báo yêu cầu `chmod`, đổi lại là không bao giờ âm thầm sửa quyền của thư mục khác.

## Rà soát thiếu sót lần hai — bổ sung (2026-10-19)

Hai audit độc lập (execution/durability và product/UI) cộng kiểm tra trực tiếp tìm thêm các lỗi sau, đã sửa và có regression nơi hành vi đổi:

- **Live qua gateway bị hỏng**: `nginx.conf` chỉ proxy `/api/` không kèm header `Upgrade`, trong khi socket khán giả là `/api/v2/live/:gameId` → WebSocket không bao giờ nâng cấp trong gói Compose. Đã thêm `Upgrade`/`Connection` + timeout, bỏ location `/ws/` (bề mặt v1 đã gỡ) và sửa banner khởi động còn quảng cáo `/ws/matches`.
- **Cấp tài khoản LAN không có gate profile**: ở `ONLINE`, ADMIN vẫn mint được account `ADMIN_ISSUED` (bỏ qua xác thực email). Nay trả 404 `PROFILE_DISABLED`; UI cũng không còn cho chọn role `OPERATOR` (role không có bề mặt nào) và server chỉ cấp `STUDENT`.
- **ADMIN vẫn nộp bài thay đội**: `submit()` dùng `checkActorTeam` vốn bỏ qua ADMIN. Nay trả 403 `ADMIN_CANNOT_SUBMIT`; có regression chứng minh đỏ/trước–xanh/sau.
- **Private TEST có thể lộ map chưa reveal**: fallback `LATEST_MAP` gate theo `maps.revealed_at` (map-level) trong khi reveal là per-version → một version mới publish sau khi map đã reveal từng lộ qua test. Nay gate theo `map_versions.revealed_at` (map PUBLIC vẫn hợp lệ).
- **Fence không đối xứng ở đường consume**: `recordResult` assert fence lần nữa trong transaction pinned, trong khi hai consumer kia thì không → sau `activate-restore` (checkpoint bị xoá) mọi completion GAME `PENDING` được khôi phục sẽ kẹt vĩnh viễn. Nay fence chỉ áp cho ghi mới (pin), đúng quy tắc đã ghi ở broker.
- **Connection thứ hai trong transaction pinned**: đọc snapshot của private test dùng pool riêng → nguy cơ cạn pool/tự khoá. Nay dùng chính client của transaction.
- **Drain completion thất bại im lặng**: `catch {}` trong reconciler không log gì. Nay log kèm completion id và lý do (operator thấy được, retry vẫn tiếp).
- **Capsule completion không bao giờ được thu hồi**: root mà backup bắt buộc inventory sẽ phình mãi. Nay có sweep 7 ngày (giữ capsule `PENDING`, giữ object còn capsule khác tham chiếu), root khai báo được bằng `completionRoot`, và control plane chạy sweep theo nhịp retention.
- **Root dữ liệu không được kiểm tra khi khôi phục**: readiness thêm check `objectRoots` (mọi `storage_path` phải nằm trong root đang cấu hình) — đổi lại là app vẫn khởi động bình thường nhưng báo `degraded` thay vì trả 404 lặng lẽ.
- **Dọn dead code**: `invalidateAfterGame` (chỉ test gọi; test chuyển sang gọi `invalidateDownstream` như correction thật), `BACKUP_STATUS_KEY`, import không dùng, nhánh `identityService` chết trong block v1, và bề mặt v1 không còn bị mô tả sai trong tài liệu.
- **Audit đọc thiếu `request_id`**: source/build-log nay ghi `request_id` (helper `persistence/audit-request-id.ts`).
- **Giấy phép vendor**: npm khai ISC nhưng LICENSE đi kèm là MIT — README và script copy nay nói đúng tệp được phân phối.
- **CI**: thêm service `postgres:16`, DB `arena_ci_test`, bước apply migrations và env PG để `npm test` thật sự chạy được suite server. *Chưa chạy trên runner thật.*
- **Guard object root**: store từ chối root do operator chỉ định mà group/world đọc được; root mặc định do app tạo được siết `0700`; `Dockerfile.server` tạo `/app/storage/*` với `0700`. Đã chạy `backup-cli produce → verify` thật trên dữ liệu thật (digest `81a4a23b…`), và `publish`/`activate-restore` fail-closed đúng.
- **Test chống lệch schema**: `tests/schema-version.test.ts` so `EXPECTED_SCHEMA_VERSION` với migration mới nhất.
- Sau toàn bộ: suite server **69 files / 435 passed / 1 skipped**, Rust **167 passed**, `tsc` sạch. Chưa commit/push.

**Deferred (có ruling):** `submissions/private-test-service.ts` (`PrivateTestService`/`TestError`) chỉ còn test dùng và trùng luật với đường live (`SubmissionService.createPrivateTest` + `PrivateTestRunner`) — chưa xoá vì hai suite đang dùng làm fixture; rủi ro là nó trôi khỏi đường live. Compiled artifacts không có bảng tham chiếu trong DB nên backup chỉ đối soát ở mức inventory (đã ghi nhận trong evidence).

## Kiểm chứng hành vi các sửa lỗi (2026-10-19)

Ba kịch bản từng lộ lỗi được kiểm chứng bằng hành vi, không chỉ bằng đọc mã; mỗi kịch bản có regression đỏ-trước/xanh-sau:

- **Fence ở đường consume** (`results-durability.test.ts` mục 6): với fence luôn ném lỗi, `recordResult` trên client pinned vẫn ACCEPTED, còn ghi mới (không client) bị từ chối. Đảo lại nhánh `if (!pinned)` → test đỏ đúng thông điệp fence.
- **Lộ map chưa reveal qua private TEST** (`private-map-reveal.test.ts`): map A đã reveal ở version hiện tại, map B tạo sau với v1 đã reveal và v2 (current) chưa reveal. Resolver trả map A; đảo về predicate cũ (`maps.revealed_at`) → trả đúng `board-b-secret` (đỏ), chứng minh lỗi có thật.
- **WebSocket qua nginx của gói Compose**: dựng nginx `stable-alpine` (image có sẵn, không tải mạng) với chính `nginx.conf` của repo trỏ về một upstream WS cục bộ. Cấu hình cũ (không header `Upgrade`) → client nhận `400`; cấu hình đã sửa → `UPGRADED`. `nginx -t` cũng pass.
- Thêm `object-root-privacy.test.ts`: root do operator chỉ định mà `0755` thì store từ chối và **không** tự chmod; root thiếu thì được tạo private.

## Bàn giao phần mềm LAN — hoàn thiện đường cài mới/nâng cấp và chuyển demo (2026-10-19)

Theo kế hoạch đề xuất, đã đóng nốt phần còn thiếu rồi mới chuyển demo sang bản mới. Mã ở `/home/ha-thai/OanTuTi-rebuild`, branch `rebuild/v2`; không commit/push.

- **Bootstrap ADMIN nguyên tử**: kiểm tra terminal, `PGPASSWORD_FILE`, tên database, capacity và điều kiện "đã có ADMIN" **trước mọi ghi**; credential `ADMIN_ISSUED` hết hạn 24h/dùng một lần, buộc đổi; tài khoản + `accountCapacity` + audit commit trong **một** transaction. Chứng minh: chạy qua TCP bằng PTY thật (`script`) tạo ADMIN + capacity + audit; đăng nhập đầu → `PASSWORD_CHANGE_ONLY`, lần hai cùng mật khẩu bị từ chối; chạy lại bị từ chối **không in mật khẩu**; DB mới không có capacity từ chối với **0 user / 0 audit row**.
- **Applier trên database rỗng**: `schema_migrations` chưa tồn tại được coi là deployment mới và áp toàn bộ migration theo thứ tự (probe `to_regclass` để không lỗi khi bảng chưa có). Chứng minh: DB TCP trống `arena_bootstrap_final3_test` → schema 26, 40 bảng; bootstrap một lần dùng credential đúng, từ chối dùng lại; `PGPASSWORD_FILE` hoạt động. Role/DB tạm đã xoá sau kiểm chứng.
- **Đường vận hành cho Compose**: service `ops` (profile `ops`) là container duy nhất mang secret role `arena_owner`, chạy applier/bootstrap; với migration, applier `SET LOCAL ROLE arena_migrator` trong từng transaction để tạo DDL bằng role chuyên biệt. API vẫn chỉ dùng role `arena_app`. Không xác thực được `docker compose config` trên máy này (CLI thiếu plugin Compose) — YAML đã parse được; CI sẽ validate profile `ops` nhưng chưa chạy runner thật.
- **Rust verifier trong image**: builder `rust:1.98.1-slim` (kèm `protobuf-compiler`) build `verify-trace`, runtime chuyển sang Debian (`node:24-bookworm-slim`) để khớp glibc, đặt `OANTUTI_VERIFIER_BIN=/app/bin/verify-trace`. Binary release **đã build và được server dùng thật** qua biến đó (29 test native/results xanh). Bước build image **chưa chạy trên máy này** (thiếu image nền/apt offline).
- **CI**: thêm cài `protobuf-compiler`, build `verify-trace` (profile debug đúng đường mặc định của server) trước `npm test`, và validate cả profile `ops`. Chưa chạy trên runner thật.
- **Chuyển demo sang bản mới**: sao lưu `pg_dump` demo trước khi đổi; migrate có `OANTUTI_MIGRATE_CONFIRM` → schema **26**, dữ liệu nguyên vẹn (10 tournament / 20 user / 32 game trước và sau), `backup_identity` có generation 1, grant của role ứng dụng được siết lại theo ma trận mới.
- **Dọn dữ liệu object của demo** (phát hiện qua check `objectRoots` mới): 953 hàng `submission_sources`/`replay_objects` là orphan từ fixture, trỏ vào root cũ/tmp; đã xoá đúng các hàng **không** được `submissions`/`result_versions`/`test_snapshots` tham chiếu (22 nguồn + 931 replay). 33 object được tham chiếu đều đã nằm trong root cấu hình và còn nguyên byte. Sau đó `objectRoots` = ok.
- **Hành trình LAN trên bản cuối (demo DB đã migrate)**: seed giải Swiss 4 đội qua HTTP thật → 2 vòng Swiss + playoff chạy xong, 12 ván completed, standings/bracket có dữ liệu; đăng nhập bằng credential cấp một lần → buộc đổi mật khẩu → credential cũ trả **401**; private TEST của đội chạy xong (~1 s) trên map COMMITMENT; replay test **200 cho đội, 403 cho ADMIN**; correction preview có impact thật rồi apply → revision 2; `appeal-window 0` → `finalize` → `archive` thành công. Browser: trang giải render bracket vendor (Playfair/Playoff), console ADMIN có panel tài khoản, workspace đội chỉ hiện giải của mình với 4 tab.
- Ghi chú dọn dẹp: session ADMIN tạo cho smoke đã được revoke; role/database tạm đã xoá; dump demo giữ tại `/tmp/demo-backup/pre-024.dump`. Mật khẩu đội `newdemo_cap1` đã đổi thành `Cap1-Demo-2026-strong` trong lúc kiểm tra.

- Trạng thái đang phục vụ sau khi khởi động lại dev stack: PostgreSQL schema 26, portal/API trả lời; readiness `degraded` vì `executionGateway=false`, `executionPlane=false` (dev executor vẫn bật) và `backupFence=false`. Demo DB trước migration đã có `/tmp/demo-backup/pre-024.dump`. Đây là demo phần mềm, không phải production ready.

### Recheck sau restart phiên (2026-10-19)

- Migration applier now holds a database-scoped session advisory lock, persists SHA-256 migration checksums atomically with DDL/version rows, requires exact-database confirmation for `--baseline` and refuses when no checksums are missing or migrations remain pending; grants are transactional. Isolated PostgreSQL regressions: **10/10 pass**, covering concurrent apply, drift refusal, baseline recovery/refusal, separate migrator role, DDL rollback and grant rollback. Fresh schema reached **26/26 checksums** using `arena_migrator`.
- Final `Dockerfile.server` build succeeded using `rust:1.98.1-slim-bookworm` and `node:24-bookworm-slim`. Final image contains only server/engine/protocol/runner runtime dependencies; npm audit during image install: **0 vulnerabilities**. Final-image verifier rejected malformed input with the expected JSON error and exit 2; `@oantuti/server` resolves under the production-only install.
- Final verification: server **72 files / 441 passed / 1 skipped**; migration regressions **10/10**; Rust **167 passed / 0 failed**; server TypeScript check and web production build succeeded; CI YAML parses and configures the isolated migration DB plus final-image verifier smoke. CI has not run on a hosted runner.
- Demo stayed separate and untouched; local API remains schema 26/readiness degraded, portal HTTP 200. Temporary migration databases and temporary test administrator were dropped; existing roles and demo data remain.
- Remaining boundaries: browser U5/usability/accessibility approval is yours; CI hosted run has not been observed; web audit still reports low/moderate advisory findings (Monaco bundled DOMPurify and bracket/UUID dependency tree). No LAN runtime certification, production deployment or release-ready claim.
- Independent code review was attempted, but the reviewer tool could not read the required patch diff and returned **not assessable**; no independent sign-off is claimed.

## Sửa lỗi UI: panel tài khoản LAN hiện sai chỗ (2026-10-19)

- **Triệu chứng người dùng báo:** trong console của một giải, tab **Bản đồ** hiện giao diện quản lý tài khoản LAN.
- **Nguyên nhân:** `OrganizerConsole` được dùng chung cho hai phạm vi, và panel tài khoản được bật theo *section key* (`teams | entries | configuration`). Console toàn cục dùng `teams`; console của giải dùng `configuration` cho tab "Bản đồ" và `entries` cho "Đội tham dự" ⇒ panel lọt vào cả hai tab của giải.
- **Sửa:** thêm prop `accountsScope` (mặc định `false`), chỉ console toàn cục truyền `true`; panel chỉ render khi `accountsScope && section === 'teams'`.
- **Kiểm chứng trên portal đã build lại (browser, session ADMIN):** trước khi sửa — tab Bản đồ của giải có `Tài khoản LAN: true`; sau khi sửa — Bản đồ / Đội tham dự / Tổng quan của giải đều `false`, console toàn cục tab Đội vẫn `true`, tab Bản đồ toàn cục hiện trình tạo bản đồ và không có panel. Nội dung tab Bản đồ của giải vẫn đúng theo trạng thái ("đã chốt bản đồ…", "chưa chốt bản đồ nào…" khi đăng ký đã mở), tức không mất chức năng.

## L10 — bàn giao LAN (2026-10-19)

- **Đợt hoàn thiện phần mềm (LAN-first, sau rà soát).** Đã sửa các khoảng trống phần mềm mà rà soát nguồn chỉ ra, không chỉ hạ tầng:
  - *Durable completion*: completion được pin trước khi ghi ledger; một **consumer độc lập** (`broker.registerCompletionConsumer` + `JobReconciler(db, generation, broker)`) đọc capsule bất biến trên đĩa, xác minh digest/provenance/object rồi mới ghi accepted result/replay/outbox + job terminal trong **cùng transaction**; capsule nằm ngoài spool attempt nên tiến trình chết vẫn khôi phục được. Pin lặp lại trả receipt canonical (không double-score) và trả lời được cả khi fence đang tạm dừng ghi.
  - *Vòng đời đã sửa*: `release()` chạy trên chính session của transaction (trước đó nó mở connection thứ hai ⇒ tự deadlock `test_snapshots`); build replay vẫn dọn spool; `acceptBuild` enqueue TEST_GAME trong cùng transaction.
  - *Control plane độc lập*: `TournamentControlPlane` chạy đóng đăng ký theo hạn, tiêu thụ outbox kết quả, seal vòng, bootstrap job và retention **không phụ thuộc** `OANTUTI_DEV_EXECUTION`; auto-runner dev bỏ qua các nhiệm vụ đó khi app sở hữu.
  - *Khởi động native*: `OANTUTI_NATIVE_CONFIG` (file tuyệt đối, private, do operator sở hữu) nối gateway vào entrypoint thật; readiness thêm check `workers` dựa trên claim/heartbeat thật; start bị chặn `NATIVE_EXECUTION_NOT_READY` khi thiếu worker; bỏ fallback SQLite ngầm.
  - *Runtime worker*: reaper `arena-reaper` chạy độc lập cạnh `arena-worker` (xác nhận cleanup trước khi tái dùng slot, fail-closed nếu thiếu); vi phạm CPU/wall/output/protocol **có đo** trở thành forfeit có căn cứ, lỗi không đo được vẫn là hạ tầng; heartbeat giữ tới lúc pin; phiên official phát `liveTurn` (private TEST không phát).
  - *Nghiệp vụ*: tài khoản LAN (cấp/reset/thu hồi + màn ADMIN + kiểm tra source/log có audit), correction khoá revision trong transaction + receipt idempotent + impact thật, backup checkpoint có producer/verifier/CLI + barrier, dọn bề mặt v1 khỏi deployment v2, bracket client-only đúng thiết kế đã chọn.
  - *Phạm vi hạ tầng*: giữ nguyên quyết định của người dùng — không test/cấp phát hạ tầng; các mục soak 72h, rehearsal 7 ngày, đo dung lượng trên host thật, drill off-host là **khuyến nghị**, không phải việc của đợt này và không được tuyên bố đã đạt.
- **Kiểm chứng thật trong đợt này** (không có tuyên bố hạ tầng):
  - Suite server trên DB cô lập `arena_role_ux_test` (schema 26): **67 files, 431 passed / 1 skipped**.
  - Rust workspace offline: **167 passed, 0 failed**, 0 warning.
  - `tsc` sạch cho protocol/engine/runner/web/server; `next build` thành công (gồm asset bracket tự host).
  - Stack cô lập `arena_smoke_test` (API 4303 + portal 4304, WAN không cần): trang giải công khai render bracket vendor trong iframe same-origin; **khách thấy 0 link replay** và nav chỉ có Giải đấu/Đăng nhập; panel ADMIN cấp tài khoản LAN hiện credential một lần + audit `LAN_ACCOUNT_PROVISION`; đăng nhập lần đầu bằng credential tạm trả `PASSWORD_CHANGE_ONLY`, dùng lại credential đó trả **401** và đánh dấu đã tiêu; reset có reauth trả credential mới, **thu hồi 0→ phiên còn lại**, audit `LAN_PASSWORD_RESET`.
  - Giới hạn đã ghi nhận: **chưa quan sát luồng delta trực tiếp của một ván đang chạy** (ván dev xong trong ~0,2 s; native chưa được cấp trên host này) — trang live chỉ được xác nhận render và xử lý kênh đã đóng.
- **Ruling (ghi lại):** database demo của người dùng (`arena_rebuild_c72cd5a74f33`, schema 23) **không** được migrate trong đợt này: applier yêu cầu `OANTUTI_MIGRATE_CONFIRM` cho database không phải test, và code mới **từ chối khởi động** trên schema cũ. Muốn đưa stack dev lên code mới thì chạy một lệnh có xác nhận tường minh; đổi lại là không tự ý đụng dữ liệu demo.
- Viết [runbook bàn giao LAN](../../runbooks/lan-handover.md): kiến trúc vận hành, cách đọc `lan-preflight.py` và `/api/health/ready` đúng nghĩa, chạy/dừng/cập nhật cho cả gói Compose và stack host, migration có guard hai tầng, phục hồi ADMIN, tạo ADMIN đầu tiên + accountCapacity, cấu hình `OANTUTI_NATIVE_CONFIG`/`arena-reaper`, quy trình giải cho ban tổ chức và đội, sao lưu + custody khoá, bảng xử lý sự cố, chỉ mục bằng chứng, biên nhận G0–G4 và danh sách giới hạn.
- Viết [khuyến nghị hạ tầng](../../runbooks/infrastructure-recommendation.md): mô hình tải, ba mức cấu hình máy, cách tính RAM/đĩa, phần mềm phải ghim, backup off-host, mạng, con người, quy tắc chốt cấu hình bằng probe. Số liệu gắn nhãn [ĐO]/[SUY RA]/[KHUYẾN NGHỊ]: replay 963 bản trong ledger dev (trung bình 1,29 KB, lớn nhất 8,94 KB ở 122 ply) và nền tảng ~7 GB (repo 2,5 GB, toolchain 2,1 GB, rootfs 1,2 GB, cụm PG 596 MB) đo tại chỗ; CPU/đĩa còn lại suy từ profile và bảng khối lượng đã duyệt.
- Kiểm chứng trong lúc viết: `lan-preflight.py --root .` trả JSON thật (`kernel 7.0.0-38`, `runsc` absent, `executionReady=false`, `releaseReady=false`); `apply-migrations.mts --status` báo `23 migrations, 0 pending`; `/api/health/ready` trả `degraded` với `executionGateway ok:false "no native gateway configured"`; `replay_objects` trong ledger đọc trực tiếp bằng `psql` của toolchain (963 dòng). Tài liệu: 0 liên kết hỏng, fence cân bằng.
- Không phần nào của L10 được ký: `releaseReady=false`, G0–G4 `NOT_SIGNED`, ONLINE vẫn `DEFERRED_BY_USER`. Việc còn lại trước khi ký: host/baseline GA 6.8, sandbox + canary, backup off-host + custody, soak 72h + rehearsal 7 ngày, đo dung lượng trên host phát hành, chữ ký người.

## S01 — IN_PROGRESS

- Donor: `/home/ha-thai/OanTuTi`; base HEAD `982e3bb3df85c054cd538b09fdfc59b6ee94715a`.
- Rebuild: `/home/ha-thai/OanTuTi-rebuild`, branch `rebuild/v2`.
- Preservation: `/home/ha-thai/.local/share/oantuti/rebuild-preservation/20261017T100235Z`; 327 regular source/docs files, 2,307,344 bytes, SHA-256 copy and overlay verified. Generated dependencies/build outputs excluded. External data NOT copied; no donor database mutation.
- Worktree creation succeeded; FICLONE unsupported, Git used plain checkout. Verified overlay includes modified/untracked source and canonical plan rather than HEAD alone.
- Actual free space snapshot: 27GiB /home; source-only measured footprint4.1MiB. Toolchain/dependency/build/runtime footprints still require budget before provisioning.
- Authority reconciliation completed in six owner documents; all former COMPLETE gates reset to unaccepted evidence. BOM inventory records observed tools separately from unverified candidates; Rust/WASM prerequisites are being resolved in a new user-local prefix.
- Ruling: execution request follows saved approved plan and harness reports plan mode inactive; proceed in isolated workspace only. Earlier commentary claiming still-read-only was corrected before mutations.
- Gates: S01 incomplete; DEVELOPMENT_CONFIG_READY=false; G1–G4 PENDING_RUNTIME_PROOF; RELEASE_NOT_READY.
- New `deploy/linux/rebuild-config.mts` validates explicit isolated development inventory, rejects donor DB/path, path traversal, overlapping storage domains, shared DDL roles, public listener and secret/production-readiness fields. No production certification is inferred.
- `node --test tests/rebuild-config.test.mjs`: 15/15 PASS. Nested storage-domain, symlink-to-donor and exposed0755root regressions observed FAIL before fix, PASS after fix. Existing path components must be nonsymlink directories, configured existing roots private/current-owner. Initial missing-module run is scaffolding failure, not claimed behavioral RED evidence. Strict standalone TypeScript typecheck of validator exit0.
- Actual inventory at `/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/development-config.json`, mode0600; no secrets. Config smoke PASS with pgPort55434, releaseReady=false. New checksummed private PostgreSQL cluster initialized under runtimeRoot and service `arena-rebuild-pg` listens only Unix socket; donor DB not connected. No product migrations applied.
- Post-setup donor hash check: 327 files unchanged, zero mismatches; donor DB not accessed. Web/API ports4300/4301 bind-checked free; only new private PostgreSQL service runs. New objects/staging/spool directories mode0700; public schema contains zero product tables.
- PostgreSQL evidence `S01-postgresql-isolation.json`: data_checksums/fsync/synchronous_commit/full_page_writes all on; dedicated app/migrator/backup roles nonsuperuser/nocreatedb/nocreaterole. Development-only peer map permits current OS user to these roles; production service UID separation still pending. Actual app connection identifies isolated DB and CREATE TABLE fails permission denied as expected.
- Source safety: no donor writes; source overlay and original manifest preserved. Six authority documents checked for local links/fences: zero broken links/unclosed fences. This is document consistency only, not runtime certification.
- Tool-call failure record: service start requests incorrectly included incompatible async/timeout fields and were rejected without launch; corrected by passing service args without these fields via eval, then service ready. No claim those rejected calls started a process.
- Installed new isolated Rust1.99.1 native+wasm32 std and wasm-bindgen0.2.129; version/hash/targetpresence verified. Actual throwaway Rust→WASM compile+Node instantiate returned expected25200/12600/393 for distances0/1/63. Evidence S01-wasm-smoke.json; not productengine/browserparity certification.
- Private development TLS CA/certificate created under isolatedroot, keys0600; openssl chain/localhost verification and real temporary HTTPS client/server smoke exit0 with explicitCA. No systemtrust changes, cold-browser/prodTLS still pending.
- S01 dependency metadata now selects51exact npm pins with peer/security/license evidence; full lock/artifact/transitive review remains before consumption. PureRust work is not blocked by unused laterUIpackages. Bracketslicense ISC/MIT discrepancy unresolved at artifact stage.
- Cargo development graph:38exact registry archives verified against lock+primary index, licenses and OSV/RustSec ranges reviewed, no known affecting critical/high found. Isolated Cargo home created; `cargo metadata --locked --offline --filter-platform x86_64-unknown-linux-gnu` exit0. Signature certification and full release BOM remain unproven.
- Focused S01 reviewer processes failed without findings twice; no review approval claimed. Independent review remains pending; parent behavioral regressions/smokes do not replace it.
- Ruling: S01 remains partial/PENDING_EXTERNAL_EVIDENCE for release-target/serviceUID/cgroup boundary and review, while plan contingency explicitly permits independent pure-engine/contracts development. Start only S02 pure-engine component; no sandbox launch/untrusted intake or S02 completion until exact-target proof. Later UI dependency artifacts remain phase-owned and do not prevent pure-Rust work.

## S02 — IN_PROGRESS (pure engine/match only; sandbox and runtime pending)

- Canonical proximity formula corrected from linear `100-distance` to integer `sum(25200/(distance+1))`. Regression observed RED (expected18900 got196), then GREEN.
- Added validated `MapTopology::try_new` and `GameState::try_new`: dimensions3–64, unique in-bounds1–4096 cells, distinct valid thrones, unique piece IDs, valid/non-overlapping positions, maxPly1–300.
- Added frozen terminal outcome, initial terminal evaluation before TURN, rejection of moves after terminal, and state preservation on illegal moves. Initial stalemate checks White only.
- Added authoritative match state machine in `arena-runner`: manifest → actions → evidence and `verify_trace` replay; rejects wrong side, illegal ply, trailing actions, incomplete trace and claimed-outcome mismatch. Runner demo now executes through this state machine and prints verified terminal evidence.
- Actual commands: `cargo test -p arena-engine --test gameplay_contract` 8/8 PASS; `cargo test -p arena-runner --test match_trace` 6/6 PASS; `cargo test --workspace --tests --locked --offline` 64/64 PASS across15 suites; `cargo run -p arena-runner` reports WHITE/THRONE_BREACH after1ply.
- Command limit: minimal Rust profile lacks `rustdoc`, so `cargo test --workspace` including doctests exits101 before doctests; `--tests` is the verified scope. This is an environment limitation, not a passing doctest claim.
- **Full native/WASM replay parity closed (dev host).** The replay loop now lives once in `arena-engine/src/replay.rs` (`verify_actions`/`ReplayAction`/`ReplayError`/`ReplayEvidence`); `arena_runner::verify_trace` delegates to it, a new `arena-verifier` crate owns the JSON document format (stdin/stdout CLI **and** the WASM ABI), and `arena-engine-wasm` exports `oantuti_verify_replay` plus alloc/free with a length-prefixed result buffer. `deploy/linux/verify-replay-parity.ts` now replays every stored `OANTUTI2` object through three verifiers: **634 checked / rustOk 634 / tsOk 634 / wasmChecked 634 / wasmOk 634 / 0 mismatches / 68 skippedNoMap**, identical to the pre-refactor native-only summary (behaviour-preserving move). Evidence: `docs/implementation/rebuild/S02-wasm-replay-parity.json` (wasm artifact 206 631 B, sha256 `7994d3bf…`, rustc 1.99.1).
- Browser wiring of the WASM verifier is in place: `packages/web/lib/wasm-verifier.ts` fetches `public/wasm/arena_engine_wasm.wasm` (served as `application/wasm`, 200), rebuilds the trace document from the decoded `OANTUTI2` payload and calls `oantuti_verify_replay`; `WasmVerifierPanel` shows the verdict on `/replays`. Observed in headless Chromium: digest `df45092c…` → “Engine WASM chấp nhận trace. 8 nước được áp dụng · kết cục Đen · THRONE_BREACH” (same verdict as the native/TS parity run), and legacy digest `12cf5f3f…` (no board) → “Replay cũ không kèm bàn đấu … không có kết luận xác minh” instead of a fabricated pass. Asset is produced by `deploy/linux/build-wasm-verifier.sh` (`npm run build:wasm-verifier`), sha256 `7994d3bf…`, no CDN.
- Negative controls for that harness: a missing wasm path and a random-bytes module both fail loudly with exit 2; a stub native verifier returning a fixed verdict produces mismatches whose fields include `wasm:appliedPly`/`wasm:winner`/`wasm:reason`, so the WASM verdict really participates in the comparison; `cargo test -p arena-verifier` 4/4 and `-p arena-engine-wasm` 3/3 cover wrong-side, malformed JSON, missing outcome, an accepted throne-breach trace and the alloc/free round trip.
- Still pending for S02: actual supervisor process/socketpair integration and Bot sandbox launch; build/run dispatcher; gVisor canaries/accounting; browser-side wiring of the WASM verifier; exact GA6.8 target. S02 NOT complete and G1 not certified.
- Added shared `arena-execution` crate generated from `execution.proto`; supervisor now consumes it instead of a second generated copy. Added runner execution session: frame bounds, manifest digest, validated state, initial-terminal evidence, independent startup, turn loop, per-turn action verification, commits and terminal evidence. Fake-supervisor duplex tests exercise normal play, one startup fault and double fault.
- Actual commands: `cargo test -p arena-runner --test session_start` 3/3; `--test session_run` 3/3; `cargo test --workspace --tests --offline` 70/70 across19 suites. New dependencies serde/serde_json/sha2/prost/parking_lot were pinned and fetched; their full advisory/license closure is not yet recorded in S01 cargo BOM. No real Bot/gVisor runtime exercised.
- Added `arena-engine-wasm` wrapper importing the same `arena_engine::proximity_contribution`; built for wasm32-unknown-unknown and executed in Node: distances0/1/63/251 produce25200/12600/393/100. Evidence S02-wasm` child on both sides. This is development-only; no sandbox, accounting, or network isolation, and is not reachable from production execution.





## S03 — IN_PROGRESS (LAN identity/teams/admission + real PG, verified end-to-end)

- Isolated development PostgreSQL 16.15 (`arena-rebuild-pg`, private socket, no donor connection) now has product migrations 001–008 applied in the rebuild runtime root; separate test database `arena_rebuild_test` provisioned with the same migrations plus least-privilege grants for `arena_rebuild_app` (migrator/app/backup roles remain nonsuperuser/nocreatedb).
- Verified live HTTP flow against the running API (cookie session, audit rows in `audit_events`): admin login → `POST /organizer/tournaments` (course auto-create, DRAFT) → `publish` → `open-registration` → `POST /organizer/teams` (captain membership) → `enroll` → `GET /tournaments/:id/entries`, plus duplicate-enroll 409. Invalid transitions rejected with 409 (`open-registration` before publish observed).
- Global CSRF guard (`protectMutations`) requires `application/json` on mutations; bodyless POSTs were observed failing with `JSON payload required`. Web client fixed to send `{}`; the guard itself is unchanged.
- Migrated suites: `vitest run packages/server/tests/teams.test.ts packages/server/tests/submission-lifecycle.test.ts` 13/13 PASS against `arena_rebuild_test`.
- Rust engines re-run: `cargo test -p arena-engine -p arena-runner --offline` — all suites observed passing (session_run 3/3, session_start 3/3, gameplay/match_trace included); no failures shown.
- Next 16 portal built and served on 4300 against the real API (`next build` exit 0): public directory and tournament/standings detail read PostgreSQL data; workspace login works through the Next `/api/*` rewrite; organizer console creates tournaments/teams, publishes, opens registration, enrolls and lists entries. Browser-verified with screenshots; workspace entry history fixed to read the API's camelCase entry fields.
- Not yet: ONLINE verification/recovery (S04), quotas/grace enforcement, map CRUD UI, job broker execution, match execution/replay, standings advancement (scheduler exists but no game executor), sandbox/runtime certification.

### S05 intake slice — source submission receipts (verified)

- `POST /api/v2/tournaments/:id/submissions` verified live with a real 339-byte TS ZIP: response `{receiptId,timestamp,data:{submissionId,receiptOrdinal:1,sourceDigest,intakeEligibility:'ELIGIBLE'}}`; `GET …/submissions?teamId=` returns the history row and `GET …/entries/me?teamId=` the current candidate (status READY).
- Added `GET /api/v2/tournaments/:id/submissions?teamId=<uuid>` (ADMIN or team member, FULL-scope check reused from `checkActorTeam`) with camelCase DTO ordered by `receipt_ordinal DESC`.
- Submission routes now set a route-level 4 MiB `bodyLimit` (2 MiB ZIP + base64 expansion), replacing the global 1 MiB default that would have rejected valid uploads; private-test route matched.
- Workspace portal now renders per-team submission forms (ZIP→base64 in chunks, 2 MiB client bound, language/entrypoint), the latest receipt, current candidate and receipt history. Browser-verified: upload through the real UI returned receipt #2 and history rows #2/#1 with digests; workspace also lists entries in `VALIDATING_SUBMISSIONS`.
- Full server suite re-run against `arena_rebuild_test`: `vitest run packages/server` 118/118 PASS across 24 files; `tsc --noEmit -p packages/server/tsconfig.json` exit 0.
- Still not executed: compile/smoke/private-TEST execution, quotas enforcement surfaces, and receipt state transitions beyond intake (jobs pipeline).

## S07 dev-execution slice — real matches, results, replay, standings (verified)

- New `packages/server/src/tournaments/execution-service.ts` (`MatchExecutionService`) runs PENDING/RUNNING games: extracts each side's frozen READY submission (latest `receipt_ordinal`, ZIP re-validated with the same traversal/limit checks and digest equality), runs `MatchOrchestrator` with per-language launch (TypeScript via repo tsx, Python via `python3`, C++20 compiled once per digest with `g++ -O2 -std=c++20`), builds v2 trace evidence, records it through `ResultService.recordResult` (immutable replay promoted to the object store) and then `scheduler.handleGameCompletion`.
- Safety gate: execution refuses with `409 DEV_EXECUTION_DISABLED` unless `OANTUTI_DEV_EXECUTION=1`; verified by starting the API without the flag and calling the route (HTTP 409, exact body). Path is documented as unsandboxed (no gVisor/cgroup — S02/S06 still own that).
- `POST /organizer/tournaments/:id/start` now requires `{mapSlug}` and schedules round 1 (`MAP_REQUIRED` when missing; map resolved before the state change with compensating pause on scheduling failure). New `POST /organizer/tournaments/:id/run-pending-games` returns `{ran, failed, skipped}`; per-game failures do not abort the batch.
- End-to-end runs on the isolated DB (single-elimination Greedy vs Random; round-robin Python vs C++ SDK starters): `{ran:2, failed:[], skipped:0}` both times; games COMPLETED, `accepted_results` rows with `THRONE_BREACH`/`DECISIVE` (8 turns) for the knockout, encounter winner/points written, `PROVISIONAL` state advanced, outbox topics `GAME_RESULT_ACCEPTED`/`ROUND_SCHEDULED`/`TOURNAMENT_PROVISIONAL`, replay `OANTUTI2` binary served (`/api/v2/games/:id/replay` 200, 908 bytes; 773 bytes for the polyglot run). Round-robin standings snapshots produced real ranks, Buchholz and Elo 1200 rows.
- Bracket API now returns a per-encounter `games` array (`gameId`, `gameOrdinal`, `status`), and the public page renders a real bracket with per-game result/replay links (browser-verified; replay fetched through the Next `/api` proxy with 200). A single-elimination tournament has no standings snapshot by design (bracket is the record).
- Re-verified after the bracket change: `tsc --noEmit -p packages/server/tsconfig.json` exit 0 and `vitest run public-standings-bracket tournament organizer-operations` 11/11 PASS.
- Organizer console now drives the whole path with real UI controls: map creation form (grid dimensions, thrones, pieces JSON with client validation), map list feeding a per-tournament start `select`, start posting `{mapSlug}` (explicit `MAP_REQUIRED`/404 messages), and a \"Chạy các ván đang chờ\" button rendering `{ran, skipped}` plus per-game failures and an explicit `DEV_EXECUTION_DISABLED` refusal message. Browser-verified full lifecycle on a fresh \"UI Run Cup\": create map → create tournament → publish → open registration → enroll two teams → upload submissions → lock → pick map → start → run (\"Đã chạy 2 ván\"), then the public page shows the bracket with per-game result/replay links.
- Still not done for real release: sandboxed execution (UID broker, gVisor, cgroup accounting), compile/smoke acceptance pipeline for submissions, private TEST execution, Swiss/Elo dispatch automation beyond scheduler calls, live spectator streaming for these matches.

## Dev slice — autonomous rounds, quotas, knockout rules (verified)

- `packages/server/src/tournaments/auto-runner.ts` (`TournamentAutoRunner`): inert unless `OANTUTI_DEV_EXECUTION=1`; ticks every 5 s, runs only tournaments in state RUNNING that still have PENDING/RUNNING games (PAUSED/FINALIZED/ARCHIVED/CANCELLED excluded by the state predicate), overlap-guarded via `unref()` timer, per-tournament try/catch. Wired in `app.ts` with `onClose` shutdown; `GET /api/v2/organizer/runner-status` (ADMIN) exposes `{enabled, intervalMs, running, lastTickAt, lastResults}`.
- Pause/resume verified live on a fresh 4-team Swiss→Playoff run: completed games stayed 4 → 4 across a 12 s drain plus a 10 s wait while PAUSED; after resume the runner advanced Swiss round 2, PLAYOFF, and stopped at PROVISIONAL with 12/12 games complete and zero pending — no admin clicks per round.
- Knockout rules aligned with the approved ruleset: `persistSchedule` now takes the tournament format and creates **4 games with swapped sides** for SINGLE_ELIMINATION/PLAYOFF (2 for Swiss/RR/Elo); verified live (playoff final returned exactly 4 games). Equal knockout points now resolve by **better seed** except when every game was a no-contest; verified: the 1.0–1.0 playoff final advanced seed #1 (Python Squad).
- Standings API now defaults to the latest stage that actually has snapshots instead of hardcoding MAIN; verified: a Swiss tournament returns `stage: SWISS` with 4 ranked rows (points 4/4/2/0) and the public page renders them (8 rendered rows incl. bracket occurrences).
- S05 quotas enforced in-transaction (per tournament+team): 10 receipts/rolling 60 min → 429 `QUOTA_EXCEEDED`/`RECEIPTS_HOURLY`, 100/UTC day, 2 pending-compile receipts, TEST 2 pending + 30/UTC day; daily boundary pinned to true UTC after finding the session timezone was Asia/Ho_Chi_Minh. Live probe: 12 concurrent uploads → exactly 10 × 200 and 2 × 429 `RECEIPTS_HOURLY`.
- Pool-safety fix: `ArtifactStore.storeSource` accepts the transaction client, so a submission burst no longer checks out a second pool connection mid-transaction (the previous shape could exhaust the default 10-connection pool under load).
- Re-verified: `tsc --noEmit -p packages/server/tsconfig.json` exit 0; `vitest run submission-quotas submission-lifecycle` 14/14 PASS; `public-standings-bracket swiss-pairing tournament` 9/9 PASS.

## S07 dev slice — Rust trace verification parity (verified)

- New `crates/arena-runner/src/bin/verify_trace.rs` (`[[bin]] verify-trace`): reads one JSON object (manifest from a stored `MapDescriptor` + pieces + max_ply, actions with optional side, claimed outcome) and calls `arena_runner::verify_trace`; success prints `{ok,appliedPly,winner,reason}` and exits 0, every rejection or malformed input prints `{ok:false,error}` and exits 2 (no panic path). Engine types carry no serde derives, so all DTOs live in the binary; `startingPieces` is ignored in favour of the explicit pieces list.
- New `deploy/linux/verify-replay-parity.ts`: decodes stored OANTUTI2 objects (bounds-checked, trailing SHA-256 verified), rebuilds the Rust input and the TS `TraceVerifier` evidence from each payload, runs the compiled binary, and compares `ok/appliedPly/winner/reason`; exits non-zero on mismatch/checksum failure and reports `{checked,rustOk,tsOk,mismatches,skippedNoMap}`.
- Verified against the dev database: `--limit 10` and `--limit 100` → 10/10 and 100/100 parity; full scan `--limit 1000` → **checked 634, rustOk 634, tsOk 634, mismatches 0, skippedNoMap 68** (the 68 are legacy objects stored before the payload embedded `map`; every checksum verified). Negative control (stub verifier returning wrong winner/reason) produced mismatches and exit 1; corrupted object → `REPLAY_DECODE_FAILED: CHECKSUM_MISMATCH`; `cargo test -p arena-engine -p arena-runner --offline` all suites ok; server tsc exit 0.
- Honest boundary: this proves cross-language verifier parity on real traces, not that Rust is yet the production acceptance authority (the result write path still uses the TS verifier) and not the supervisor/sandbox runtime gate.

## S06 dev slice — durable job dispatch, crash recovery, lease reclaim (verified)

- Game execution now flows through the durable job broker: `scheduler.persistSchedule` returns created game ids and enqueues (after commit, idempotently by `(job_type='GAME', target_id=gameId)`) one `GAME` job per game; the worker claims it with `JobBroker.claim(worker,{gameSlots:1}, {targetIds})`, executes through `MatchExecutionService.executeGameById`, then `prepareCompletion` + `complete`. Failure paths leave the lease to expire → `JobReconciler` requeues with 5 s/15 s backoff and BLOCKED after 3 attempts. Heartbeat every 10 s while a match runs. `GET /organizer/runner-status` now also reports `jobsEnqueued`, `jobsCompleted`, `leasesRequeued`.
- Idempotency: `ResultService.recordResult` rejects a second accepted result for the same game (`ALREADY_ACCEPTED`, checked fast-path and inside the locking transaction), so a lease steal/crash cannot create a revision 2; `executeGameById` maps that to `ALREADY_COMPLETED` and still heals an interrupted round advance. `persistSchedule` is idempotent on the round PK and a sealed round short-circuits `handleGameCompletion`.
- Crash test (real kill -9): 4-team Swiss→Playoff started; API killed after round 1 (4 jobs SUCCEEDED, 4 queued, 4 games RUNNING). After restart the remaining jobs resumed by themselves and the tournament reached PROVISIONAL: 12/12 games, 12 jobs SUCCEEDED, 12 accepted results, 0 games with duplicate result versions, 12 completions over 12 distinct jobs.
- Lease-reclaim test (deterministic): tournament started with the runner inert (`enabled:false`); API stopped; one job was fabricated as `LEASED` with an expired `ACTIVE` attempt (`dead-worker`, `lease_expires_at = now() - 60s`). After starting the API armed, the reconciler marked attempt 1 `EXPIRED` (`LEASE_TIMEOUT`), requeued the job, and attempt 2 `COMPLETED` under `dev-worker-…:45816`; job SUCCEEDED (`attempt_count=2`), tournament again 12/12 with 12 accepted results and 0 duplicates; `runner-status.leasesRequeued = 1`.
- Pause semantics: paused tournaments' jobs stay QUEUED (never leased) and resume on their own — no attempt burn, matching the earlier verified pause gate.
- Regression: full server suite `vitest run packages/server` **128/128 PASS** (25 files) against the isolated test DB; `four-formats.test.ts` updated to the approved knockout rule (4 games per knockout encounter, alternating sides, seed fallback on an even split).

## S05/S08 dev slice — build gate, drain, close-lock contract (verified)

- Receipts are no longer born READY. `submit()` inserts `VALIDATING` and enqueues a durable `BUILD` job (idempotent, after commit); `createPrivateTest()` enqueues `TEST_BUILD` for its snapshot. The worker drains build jobs before game jobs and completes them with evidence; a rejected build is a successful job. `BuildPipeline` (`packages/server/src/builds/build-pipeline.ts`) materializes source through the shared `source-materializer.ts` (also now used by `MatchExecutionService`), compiles (PYTHON `py_compile`, CPP `g++ -O2 -std=c++20`, TS none), then smoke-tests the bot through `BotProcess` with a synthetic 3×3 INIT (5 s) before marking it READY; rejection reasons land in new `build_error`/`built_at` columns (migration `009-build-evidence.sql`, applied to dev + test DBs) plus `BUILD_ACCEPTED`/`BUILD_REJECTED` audit rows. `test_snapshots` gained the same evidence columns and `COMPILING|SMOKE_TESTING` states.
- New lifecycle action `POST /api/v2/organizer/tournaments/:id/close-registration` (REGISTRATION_OPEN → VALIDATING_SUBMISSIONS, commits, audits `REGISTRATION_CLOSED`, emits `TOURNAMENT_DRAINING`), and the worker auto-closes intake whose `registration_closes_at` has passed (`registrationsClosed` in runner stats). Lock keeps its contract: pending builds → 409 `INTAKE_DRAINING` **without un-committing draining**, and once drained it freezes the latest READY submission per team, excluding teams without one.
- Verified live: receipts returned `VALIDATING`; early lock 409 while builds in flight (state stayed `VALIDATING_SUBMISSIONS` after close); builds settled to `{"Alpha Team":"READY","Beta Team":"REJECTED","Python Squad":"READY"}`; the rejected team had `candidate: null`; lock then reported `eligibleTeamsCount:2, excludedTeamsCount:1` and the round-robin bracket contained only the two valid teams (finished PROVISIONAL 2/2). Deadline auto-close verified separately (past `registrationClosesAt` → `VALIDATING_SUBMISSIONS`, `registrationsClosed:1`). Organizer console gained a scoped “Đóng đăng ký” control; browser-verified it moves E2E Cup 2026 to `VALIDATING_SUBMISSIONS`.
- Regression: `tsc --noEmit -p packages/server/tsconfig.json` exit 0; `vitest run packages/server` **136/136 PASS** (26 files) after the changes.
- Intake restart smoke: a submission was uploaded (receipt `VALIDATING`, BUILD job QUEUED) and the API was killed with `-9` immediately; after restart the durable job completed (BUILD `SUCCEEDED`, attempt 1) and the submission became READY without resubmission.
- Source reads are now always audited: `GET /submissions/:id/source` writes `SUBMISSION_SOURCE_READ` (actor, team, language, role) in addition to the existing `ADMIN_INSPECT_SOURCE` for admins. Verified: an admin read returned 200 and the audit trail held `SUBMIT_SOURCE`, `BUILD_ACCEPTED`, `ADMIN_INSPECT_SOURCE`, `SUBMISSION_SOURCE_READ (role ADMIN)`.

## S08 dev slice — map versions, freeze-at-opening, pinned start (verified)

- Migration `010-map-versions.sql` adds `maps.current_version`, the `map_versions` table (backfilled v1 for every existing map), and `tournament_map_commitments`; applied to both dev and test DBs with grants for `arena_rebuild_app`.
- `MapService`: `createMap` writes version 1 in the same transaction; `publishVersion` (ADMIN) validates, appends version N+1 and keeps the legacy descriptor column in sync; `getMap(slug, actor?, version?)` serves the pinned version (404 on unknown version); `commitMapForTournament` only accepts DRAFT/PUBLISHED and audits `MAP_COMMITTED`; `getMapCommitment` returns the pinned slug/version.
- Routes: `POST /organizer/maps/:slug/versions`, `POST /organizer/tournaments/:id/map-commitment`, `GET /tournaments/:id/map-commitment` (404 while DRAFT, like entries), `GET /maps/:slug?version=N`. Start now uses the committed version's descriptor; a mismatched body `mapSlug` returns 409 `MAP_COMMITMENT_MISMATCH`, and the no-commitment path still works with an audit note `MAP_USED_WITHOUT_COMMITMENT`.
- Verified live: map v1 (5×5) → publish v2 (6×6) → pinned read of `?version=1` still 5; commit while PUBLISHED → `version:2`; commit after registration opened → 409 `MAP_FREEZE_LOCKED: maps freeze at registration opening`; start with `ui-map-5x5` → 409 `MAP_COMMITMENT_MISMATCH`; start with no body → RUNNING and the DB shows every game carrying `mapName …-v2`, `width 6`; tournament then reached PROVISIONAL autonomously.
- Portal: organizer console shows the committed map + version, offers “Chốt bản đồ” for DRAFT/PUBLISHED (browser-verified: committing through the button wrote the DB row for “E2E Map Pick” pinned to v2) and locks the control afterwards; the start control uses the committed map; the public tournament header renders “Bản đồ: <name> · v<version>”.
- Regression: `tsc --noEmit` exit 0; `vitest run packages/server` **146/146 PASS** (27 files, incl. 10 new `map-versions` tests).

## S10 dev slice — private TEST execution, zero official side effects (verified)

- `PrivateTestRunner` (`packages/server/src/builds/private-test-runner.ts`, migration `011-private-test-results.sql` adding `result_payload`/`replay_digest`/`started_at`/`completed_at`): after a `TEST_BUILD` job passes, the worker enqueues a durable `TEST_GAME` job; the runner resolves the map (tournament commitment pinned version → newest map → synthetic 3×3, recorded), picks the opponent (team's latest READY official submission → repo baseline `bots/greedy-bot.ts`, recorded), plays the match with the shared materializer/orchestrator, stores a replay under `replays/tests/…` via `ReplayStore` and writes `result_payload {winner, reason, totalTurns, opponent, map, finishedAt}` (or `{error}` + FAILED). It never touches `submissions`, `accepted_results`, `result_versions`, `standings_snapshots`, `rating_events`, `tournament_entries` or receipt ordinals.
- Routes: `GET /tournaments/:id/private-tests?teamId=` (list, ADMIN or team member), `GET /private-tests/:id` (detail), `GET /private-tests/:id/replay` (octet-stream, 404 without a digest). The list/detail DTO now also carries `buildError` so build rejections are explainable; the job broker accepts a `jobTypes` filter so a private-test phase can never claim an official `GAME` job.
- Verified live: good Python test → `COMPLETED` with `{winner:1, reason:EXTINCTION, totalTurns:5, opponent:{kind:OWN_SUBMISSION, label:'submission #1'}, map:{name:'Commit Map', version:2, source:'COMMITMENT'}}` and a 794-byte `OANTUTI2` replay downloadable through the portal; broken TypeScript test → `FAILED` with `buildError: SMOKE_TEST_FAILED: … CRASH_FORFEIT`; official counters for that tournament unchanged (accepted_results 2 → 2, result_versions 2 → 2, submissions 2 → 2, entries 2 → 2).
- Portal: `PrivateTestPanel` in the workspace renders the test form, status list, opponent/verdict details, honest pending (“Đang chạy trận…” while COMPLETED has no result yet), `buildError` on failures, replay links, and the explicit “không ảnh hưởng kết quả chính thức” note; workspace boarding now keeps team entries visible in PROVISIONAL/FINALIZED/ARCHIVED/PAUSED so private tests work in every phase. Browser-verified.
- Regression: `tsc --noEmit` server + web exit 0; `vitest run packages/server` **152/152 PASS** (28 files, incl. 6 new private-test-runner tests).

## S11 dev slice — appeal window, disputes blocking, announcements (verified)

- Migration `012-appeal-window.sql` (both DBs): renames the legacy unused `appeal_window_minutes` to `final_appeal_window_minutes` with a named 0–10080 CHECK and keeps `provisional_at`; the scheduler stamps `provisional_at = COALESCE(provisional_at, clock_timestamp())` on every PROVISIONAL transition. `finalizeTournament` now only accepts PROVISIONAL (RUNNING is rejected — the earlier code allowed finalizing a live stage, bypassing both gates) and, after the open-dispute gate, rejects with 409 `APPEAL_WINDOW_OPEN: <n> minute(s) remaining` while the window runs. `POST /organizer/tournaments/:id/appeal-window {minutes}` settles the window explicitly; 0 never bypasses the dispute gate.
- New public `GET /tournaments/:id/announcements` (allow-list of 10 topics, newest first, limit 200). Admission lifecycle now really emits the feed's topics: `TOURNAMENT_PUBLISHED`, `REGISTRATION_OPENED`, `REGISTRATION_CLOSED` (admin close and deadline sweep) alongside the existing locked/started/paused/resumed/round/provisional/finalized events.
- Verified live end-to-end: a fresh round-robin reached PROVISIONAL → finalize 409 `APPEAL_WINDOW_OPEN: 1440 minute(s) remaining` → dispute filed (201) → set window 0 → finalize 409 `OPEN_DISPUTES_BLOCK_FINALIZATION` → resolve dispute → finalize 200 FINALIZED; announcements then listed 8 topics in order (PUBLISHED, REGISTRATION_OPENED, REGISTRATION_CLOSED, LOCKED, STARTED, ROUND_SCHEDULED, PROVISIONAL, FINALIZED). Portal: public page shows the announcement timeline and a “Kết quả chính thức (FINALIZED)” banner; workspace gained `DisputePanel`; organizer cards render dispute resolution, appeal-window setter and correction preview/apply — browser-verified.
- **Critical broker fix found by the E2E**: `JobBroker.claim` filtered with `allowedTypes` instead of the narrowed `claimTypes`, so the private-test phase (`{gameSlots:1}` + `jobTypes:['TEST_GAME']`) leased official GAME jobs, completed them as `NO_CONTEST`/`TEST_NOT_FOUND`, and left tournaments stuck in RUNNING. Fixed the filter, and `enqueueMissingGameJobs` now re-enqueues for unfinished games whose jobs are all terminal (`enqueueIfNoActive`) so the damage self-heals: the stuck tournament's two games were picked up on the next tick, played (accepted, winner 1 in both), encounter COMPLETED 1.0–1.0, tournament PROVISIONAL with `provisional_at` set. Regression test added for both behaviours.
- Regression: `tsc --noEmit` exit 0; `vitest run packages/server` **161/161 PASS** (29 files incl. 8 appeal/announcement and the new claim-narrowing test).
- Correction path verified live: while the tournament was FINALIZED, `preview-correction` is refused with **409 `TOURNAMENT_REOPEN_REQUIRED`**; `POST /organizer/tournaments/:id/reopen` moves it back to PROVISIONAL (clears `finalized_at`, stamps `provisional_at`, audits and emits `TOURNAMENT_REOPENED`); the correction preview/apply then succeeds (revision increments, VOID → `winner 0 / NO_CONTEST`) and the tournament can be finalized again. Announcements include `TOURNAMENT_REOPENED` (new Vietnamese label in the portal). Downstream invalidation is now implemented: `invalidateAfterGame` cancels every later encounter/playoff, cancels their games, blocks their jobs, deletes later rounds + standings snapshots and rating events, clears the corrected round's seal, puts a PROVISIONAL/FINALIZED tournament back into RUNNING and emits `ROUND_INVALIDATED`, after which the worker re-seals the corrected round and re-dispatches a fresh bracket. Round completion now ignores CANCELLED encounters. Verified live on a 4-team single-elimination bracket: PROVISIONAL → VOID correction on a semifinal → immediately RUNNING with the old final CANCELLED → worker played a new final (champion set) → PROVISIONAL again; outbox shows ROUND_SEALED×2 + TOURNAMENT_PROVISIONAL, then ROUND_INVALIDATED, then ROUND_SEALED×2 + TOURNAMENT_PROVISIONAL, and the encounter table holds 3 COMPLETED + 1 CANCELLED. Disputes attached to invalidated encounters (and the corrected one) are closed `RESOLVED / INVALIDATED_BY_CORRECTION`, and the outbox payload reports how many, so no orphan dispute can block finalization. Verified follow-ups: a round-robin correction flipped a split round-1 encounter, cancelled the 4 downstream encounters, and re-ran rounds 2–3 with recomputed standings (T1 5.0→2.0, T2 0.0→2.0, order changed); an Elo-arena correction cancelled 14 downstream encounters, removed their rating events (`ratingEventsOnCancelled = 0`), and rebuilt the epochs to new ratings (1227.91/1227.88/1224.58/1119.63 → 1238.47/1238.39/1228.44/1094.70) before returning to PROVISIONAL.

## S13 dev slice — replay viewer and projector mode (verified)

- Replays now embed the board: `ReplayV2Payload` gained an optional `map` descriptor, written by both `ResultService.recordResult` and the private-test runner; older objects simply lack it.
- New `/replays?game=<gameId>` (resolves the digest through the accepted result) and `/replays?digest=<hex>` pages: the binary is fetched in the browser, parsed (magic/version/digest/json bounds), and the trailing SHA-256 is re-verified with `crypto.subtle` — three honest states (`verified`, `mismatch` with both digests, `unavailable`). The board renders from the embedded descriptor (validTiles, both thrones, R/P/S pieces, mover ring, capture marks) with play/pause, step, speed, scrubber and a move list; plies that violate the local rules are still shown but flagged instead of silently redrawn. Because Turbopack cannot consume the engine package's `.js`-specifier TS sources without changing `next.config.ts`, the viewer carries a self-contained rule implementation (king moves, R>S>P>R capture) — documented in code.
- Verified live: a fresh private-test replay (digest `5cf8a4ba…`) renders the 6×6 committed board with checksum “khớp”, winner/reason/ply counters, and the control bar; a pre-change replay (`?game=4fed4491…`) shows the honest “Bản replay cũ không kèm bàn đấu (map descriptor…)” notice while still listing results.
- Projector: `/projector/[id]` full-screen dark layout (noindex, no auth) with large title/state banner, announcements, bracket and standings, polling the four public endpoints every 10 s and showing the last refresh time; browser-verified at 1920×1080. The public tournament header links to it (“Chế độ trình chiếu”), and the bracket plus private-test panels link to the viewer. The projector also offers “Toàn màn hình” (Fullscreen API) and “Sao chép liên kết” (clipboard, with an honest copied/refused state) — browser-verified.

### Privacy/ACL boundaries (verified live)

- Anonymous requests: private-test list/detail/replay and submission source all answer **401**; an authenticated STUDENT who is not a team member gets **403** for the same four routes. The public bracket payload contains no `sourceDigest`/`replayDigest`/`buildError` fields, while an accepted official replay is public (`GET /api/v2/replays/<digest>` → 200 for an anonymous client). Private-test screens and source reads remain team-scoped (ADMIN inspection is audited).

### Live match streaming (verified)

- New `LiveMatchHub` + `GET /api/v2/live/:gameId` WebSocket: official games open a channel with the map descriptor and both team names, emit one `EVENT` per ply (`turnNumber/side/action/capture`), and a `RESULT`; a late joiner immediately receives a `SNAPSHOT` (status RUNNING/FINISHED, buffered events ≤400, result) — verified against a finished game: SNAPSHOT FINISHED with 8 events, `whiteTeam Alpha Team`, `blackTeam Python Squad`, `result {winner:2, reason:'THRONE_BREACH'}`. Unknown/expired ids close 4404, capacity 4405, plain GET answers 404/426 JSON. Finished channels are retained 5 min (unref timer); private tests never publish.
- Spectator page `/live/[gameId]` reconnects (≤3 backoff attempts), rebuilds the board from the same rule engine as the replay viewer, shows teams/ply/last move/connection state, a result banner mapping winner 1/2/0 to white/black/draw, and a replay link when finished; browser-verified with the same game (board, last-move ring, “Python Squad (Quân Đen) thắng — THRONE_BREACH”, 8 plies, “Đã kết thúc”). Bracket rows for RUNNING games link “Trực tiếp” to it.
- Heartbeat: the socket pings every 20 s (protocol ping + app-level `{type:'PING'}`, ignored by the viewer without touching board state) and closes a spectator stale for 60 s with 4408. Events carry a 1-based monotonic `seq` (verified on the wire: a finished snapshot exposed seq 1..10); the viewer detects a gap, shows a notice and reconnects (buying a fresh snapshot) instead of rendering a wrong board.

### Fresh-database bootstrap (verified)

- A brand-new database (`arena_fresh_bootstrap`) was created and all 15 migrations applied in order as the cluster superuser, then granted to `arena_rebuild_app`: `schema_migrations` ended at `15|15`. Five representative suites run against it (teams/lifecycle, map versions, grace/autoseal, live hub, submission lifecycle) passed **42/42**, proving the migration chain bootstraps a working schema from zero (peer-auth mapping for the temporary DB was added to the isolated cluster's `pg_hba.conf` and reloaded; it does not affect the dev/test DBs).

## S04 dev slice — ONLINE identity, recovery and entry codes (verified)

- Profile switch `OANTUTI_AUTH_PROFILE` (default `LAN_OFFLINE`): in LAN the seven ONLINE routes answer 404 `PROFILE_DISABLED` before auth and login ignores verification; `/auth/me` reports `authProfile`.
- ONLINE: `POST /auth/register` (STUDENT/SELF_REGISTER, 12-char minimum) issues a 24 h hashed verification token; login for an unverified account → 403 `EMAIL_NOT_VERIFIED` with no session; `POST /auth/verify-email` consumes it. Recovery: `POST /auth/request-password-reset` always 202 (no enumeration) with a 1 h token, `POST /auth/reset-password` rotates the hash and revokes every session. Plaintext tokens appear only in outbox payloads when `OANTUTI_DEV_EXPOSE_EMAIL_TOKENS=1`.
- Migration `013-entry-codes.sql`: `tournament_entry_codes` (SHA-256 hashes only, max_uses/uses/expiry). `POST /organizer/tournaments/:id/entry-code` returns the plaintext code once; `GET …/entry-codes` lists usage; `POST /tournaments/:id/join` (captain or ADMIN) validates state → code (invalid/expired/exhausted) → duplicate → capacity and enrolls with `INVITE_CODE` + `ELIGIBLE` in one transaction.
- Verified live under `OANTUTI_AUTH_PROFILE=ONLINE OANTUTI_DEV_EXPOSE_EMAIL_TOKENS=1`: register 201 → unverified login 403 → dev-exposed token verified (hash matched the DB row) → login 200, `/me` `authProfile: ONLINE` → reset request 202, expired token rejected, valid reset rotated the password and invalidated the old session (401) → entry code joined a team (201, ELIGIBLE) and a second redemption returned 403 `ENTRY_CODE_EXHAUSTED` (maxUses 1). Restarting without the profile env restored LAN behaviour (admin login 200, register 404 `PROFILE_DISABLED`).
- Regression: `tsc --noEmit` exit 0; `vitest run packages/server` **167/167 PASS** (31 files).

### ONLINE portal screens (verified)

- `/register`, `/verify-email?token=`, `/forgot-password`, `/reset-password?token=` implemented; the workspace login shows “Đăng ký”/“Quên mật khẩu” only when the server reports `authProfile: ONLINE`, hides them in LAN, and the screens render a LAN notice derived from the API's 404 `PROFILE_DISABLED` (never assumed). Browser-verified end-to-end under `OANTUTI_AUTH_PROFILE=ONLINE`: registered `ui_online_57797174` through the form, fetched the dev-exposed verification token, the verify page confirmed “Email đã được xác minh”, the workspace showed both links and after login printed “Cấu hình xác thực của server: ONLINE”; restarting the API in LAN mode made `/register` render the ONLINE-only notice with the raw `PROFILE_DISABLED` explanation.

## S10 additions — frozen artifacts and final-state TESTs (verified)

- Official games now resolve their candidate through `tournament_entries.frozen_submission_id` first (latest-READY only as a pre-freeze fallback), so every game of a tournament plays the artifact frozen at lock time. New `frozen-candidate.test.ts` proves the frozen submission wins even when a newer READY receipt exists, and that the fallback still applies without a freeze.
- A private TEST runs after FINALIZED as well: verified on the finalized “E2E Map Commitment” tournament (create 200 → COMPLETED with map `COMMITMENT v2`, opponent `OWN_SUBMISSION #1`, replay stored) — no official counters change.
- Regression after both changes: `tsc --noEmit` exit 0; `vitest run packages/server` **167/167 PASS** (31 files, incl. the new frozen-candidate test).

## UI checkpoint — desktop and mobile audit (partly verified, owner approval pending)

- Desktop passes were captured throughout (public directory, tournament detail with bracket/standings/announcements, workspace login/entries/submission/private-test panels, organizer console with map/commitment/enrollment/adjudication controls, replay viewer, projector at 1920×1080).
- Mobile audit at 390×844 found real horizontal overflow on `/workspace` (474 px) and `/organizer` (634 px). Root causes: long single-line `<select>` option labels in the adjudication/dispute forms forcing the grid track wide (fixed with `min-w-0`/`w-full` on the label+control classes) and the un-wrapped `buildError` text on FAILED private tests (fixed with `break-words`); the entry row's `teamId` also gained `break-all`. Re-measured: `/`, `/workspace`, `/organizer` all report `scrollWidth === innerWidth` (390) with the same overlays and forms rendering.
- Outstanding: the plan's *owner* visual checkpoint (human approval of the three surfaces) is not something the agent can self-approve — it stays open until reviewed.

## S12/S14 dev slice — browser source IDE and map editor (verified)

- `app/workspace/SourceIde.tsx`: Monaco (dynamic, no SSR) file list with add/rename/delete, per-language starter skeletons, entrypoint/language coupling, client guards mirroring the intake limits (≤64 files, ≤256 KiB/file, ≤4 MiB total, ≤2 MiB archive, no absolute/`..` paths, entrypoint extension must match), and an in-browser **stored-method ZIP writer** (CRC-32, local headers, central directory, EOCD, UTF-8 names) posting base64 to the same endpoint; `SubmissionPanel.tsx` now offers “Tải .zip” versus “Soạn trực tiếp”. Verified live: composed the Python template in the browser, submitted, and the server build gate accepted it → receipt ordinal 1, status **READY**.
- `app/organizer/MapEditor.tsx`: grid editor (click/drag tiles, full-grid/clear, throne tools, piece tools with ids, slug auto-suggest, live client validation mirroring MapValidator, descriptor JSON path, map picker + “Xuất bản phiên bản mới”), replacing the old JSON textarea. Verified live: created `ide-map` through the UI (40 tiles, white throne [0,4], black throne [4,0], pieces) and the API returned the stored descriptor.
- Regression: `tsc --noEmit -p packages/web/tsconfig.json` exit 0; `npm run build --workspace=@oantuti/web` exit 0.

## S09 fix — BYE encounters were impossible to persist (verified)

- The fixture sweep (4-team RR, 4-team Swiss, 5-team Swiss, 4-team Elo) found the first two formats reaching PROVISIONAL with the expected shapes — RR: 6 encounters / 12 games; Swiss-4: 5 encounters / 12 games with a 4-game playoff final and SWISS standings — but **5-team Swiss failed to start** with `encounters_status_check` because `persistSchedule` writes `status='BYE'` while migration 004 only allowed PENDING/RUNNING/COMPLETED/CANCELLED. Odd fields (any bye) could never start.
- Migration `014-encounter-bye-status.sql` widens the check to include `BYE` (applied to dev and test DBs). New `swiss-bye.test.ts` schedules a 5-team field and asserts exactly one BYE encounter with no games, `winner_team_id` set to the advancing team and 3 points, two real encounters with 2 games each, and that completing them advances to round 2.
- The rerun after the migration completed all four fixtures: 4-team round-robin → PROVISIONAL, 6 encounters / 12 games; 4-team Swiss→Playoff → 5 encounters / 12 games (4-game final) with SWISS standings; **5-team Swiss → 10 encounters (3 byes) / 16 games / 5 ranked rows**, byes persisted and the field advanced to PROVISIONAL; 4-team Elo arena → 16 encounters / 32 games, ratings moved (e.g. 1200 → 1234.35/1227.93/1227.89), matching the policy (E=8, required rated encounters 8, distinct opponents 3). No server restart was needed for the constraint fix.

### Retention report, holds and sweep (S15 partial, verified)

- `packages/server/src/operations/retention-service.ts` implements the §7 retention defaults as executable policy: operational logs/outbox/terminal jobs 30d, private diagnostics 30d after finalize, private TEST evidence 7d from terminal, abandoned staging 24h without a referencing job, audit 1 year, official source 90d post-finalize, official replay ≥1 year, backup 35d.
- Endpoints: `GET /api/v2/organizer/operations/retention` (ADMIN report with per-class rows/bytes/oldest/purgeable/held), `PUT .../retention/holds` (ADMIN + re-auth; GLOBAL/TOURNAMENT/TEAM holds with required reason/id), `POST .../retention/sweep` (dry-run by default; a real purge requires a fresh re-auth). Holds always win over TTL, and the sweep never touches audit rows, official sources or official replays — those stay report-only because the application role has no DELETE grant for them.
- `retention.test.ts` backdates rows and proves: dry-run plans without deleting, a real sweep deletes the expired snapshot, removes only its unreferenced replay object, nulls diagnostics, drops delivered outbox and terminal jobs, keeps the held snapshot, keeps the 400-day audit row, and writes a `RETENTION_SWEEP` audit event; a STUDENT actor gets 403.
- Live API run on the dev database: policy JSON, empty-hold report, eight class rows, hold set/clear round-trip, `dryRun` plan, hold validation 400 for a missing id, and anonymous 401. Dev data is fresh, so the aging behaviour is proven by the backdated test rather than by the live rows.

### Organizer policy preview (verified in browser)

The create-tournament form derives the canonical `ArenaAutoFormat/v1`, `ArenaSwiss/v2` and `ArenaElo/v1` numbers from the entered team count and shows them before the tournament exists: SE 32 → 32-team bracket, 0 byes; Swiss 32 → 5 rounds, playoff top 4, ~83 encounters; round-robin 500 → 499 rounds, 124 750 encounters; Elo 500 → `E=36`, 8 rated encounters against 8 distinct opponents; a count below 2 falls back to a guard message instead of a bogus forecast. Values were read from the rendered page (headless Chromium), not from the helper in isolation.

### Large-field fixture (N=64, verified)

- A 64-team Swiss→Playoff field (64 teams created/enrolled, 64 submissions built to READY, grace 0, map `ui-map-5x5`) ran to **PROVISIONAL in 522 s** with no admin interaction: 6 Swiss rounds (32 encounters each) plus 3 playoff rounds, **199 encounters / 412 games / 64 standings rows**, champion resolved. Observed pipeline throughput on this dev host ≈ **1.3 s/game** with the default 4 games/tick (≈0.79 games/s); the first four rounds took ~162 s and each subsequent round sealed on the worker tick after its last game. This is a real workload data point for the eventual capacity work (not the declared 500-team cert).

### No-champion policy for unresolved knockouts (verified)

- Knockout rounds whose encounters have **no winner** (all games NO_CONTEST / double forfeit) no longer advance a fabricated side: `advanceRound` detects unresolved non-bye encounters, moves the tournament to PROVISIONAL and emits `TOURNAMENT_NO_CHAMPION {reason:'UNRESOLVED_ENCOUNTER'}`; a final with no winner emits the same event with `FINAL_NO_CONTEST` alongside `TOURNAMENT_PROVISIONAL`. The topic is on the public announcement allow-list (Vietnamese label added).
- New `no-champion.test.ts` seals such a round through `sealEligibleRounds` and asserts PROVISIONAL, **no round 2**, and the NO_CHAMPION outbox event.
- Withdrawal (spec 02-GAMEPLAY §118/§124/§126) via `POST /organizer/tournaments/:id/teams/:teamId/withdraw {reason}` (ADMIN + recent re-auth). Before the start it only leaves the field (entry `EXCLUDED`, frozen artifact cleared); a second withdrawal is 409.
- **Live withdrawal resolves unplayed encounters instead of inventing a score.** Migration `017-walkover-encounters.sql` allows `WALKOVER` / `DOUBLE_WITHDRAWAL`. For every `PENDING` encounter of the withdrawing team whose games have not started: an active opponent gets `WALKOVER` (Swiss/RR 3 points, knockout advance, Elo no rating) and both sides gone gets `DOUBLE_WITHDRAWAL` (0-0); scheduled `PENDING` games are `CANCELLED` so the worker never plays them. An encounter that already started is left to finish with the frozen Bots. Standings count the awarded points but keep walkovers out of Buchholz/Sonneborn-Berger, Elo never rates them, and `markTerminalRounds` (called through the app-wired callback) makes a walkover-only round seal-eligible — previously such a round would stall with no game completion to trigger the sweep.
- Evidence: `withdraw.test.ts` covers the pre-start exit, the walkover resolution (points, winner, cancelled games, outbox, `SEAL_ELIGIBLE`) and the duplicate 409; a live HTTP run on the dev database returned `{status:'EXCLUDED', walkovers:1}` with the encounter at `WALKOVER`, opponent 3 points, both games `CANCELLED`, the round at `SEAL_ELIGIBLE` and outbox `ENCOUNTER_WALKOVER, TEAM_WITHDRAWN, ROUND_COMPLETED`.
- Organizer console has the corresponding `Rút đội (teamId)` control with an explicit confirmation while the tournament runs, and the public announcement list/labels now carry `TEAM_WITHDRAWN`, `ENCOUNTER_WALKOVER`, `ENCOUNTER_DOUBLE_WITHDRAWAL`.
- Still open for this area: DQ (uplheld misconduct) voids every encounter of that team in the stage and needs the correction/invalidation path; double withdrawal is implemented but only reachable through DQ or batch decisions.

### Durable grace and autoseal (verified)

- Migration `015-round-grace.sql`: `tournaments.grace_period_minutes` (default 10, CHECK 0–1440) plus the partial seal index; applied to dev and test DBs. `handleGameCompletion` now marks the round `SEAL_ELIGIBLE` with `last_terminal_at`/`seal_eligible_at` (COALESCE-idempotent), emits `ROUND_COMPLETED`, and **never advances directly**. `sealEligibleRounds()` locks the round, blocks while any dispute on the round's encounters is `OPEN`/`UNDER_REVIEW`, otherwise seals once (`sealed_at`, `ROUND_SEALED`) and dispatches the existing next-round/playoff/Elo/PROVISIONAL logic; created games enqueue their jobs after commit. The worker calls the sweep every tick before claiming games. `POST /organizer/tournaments/:id/grace {minutes}` is ADMIN-only and allowed only in DRAFT/PUBLISHED (policy freezes at registration opening), audited as `GRACE_PERIOD_SET`.
- Verified live: grace 0 set at DRAFT; a later attempt after registration opened returned 409 `expected DRAFT, PUBLISHED`; the grace-0 round sealed on the worker tick and the tournament reached PROVISIONAL. With a dispute filed before the round finished, all games completed but the tournament stayed **RUNNING** across a 7 s window (seal blocked); after resolving the dispute the next tick sealed and moved it to PROVISIONAL.
- Regression: `tsc --noEmit` exit 0; `vitest run packages/server` **174/174 PASS** (33 files) including the new `grace-autoseal` tests and the adapted format tests.

## S14 dev slice — recent re-authentication for destructive organizer actions (verified)

- Migration `016-session-reauth.sql`: `sessions.reauthenticated_at TIMESTAMPTZ` (nullable, so every pre-existing session starts unconfirmed); applied to both DBs as `arena_rebuild_migrator` — dev `arena_rebuild_c72cd5a74f33` and test `arena_rebuild_test` each report `schema_migrations` → `16|016-session-reauth` and a `reauthenticated_at | timestamp with time zone | YES` column. No grant work was needed: the column rides on the table privileges `arena_rebuild_app` already holds, and no service restart was performed.
- `POST /api/v2/auth/reauth {password}` (cookie session, both auth profiles): `IdentityService.reauthenticate` verifies the account password, stamps `reauthenticated_at = clock_timestamp()` on **that session row**, audits `ADMIN_REAUTH` (actor, session id, stamped instant) and answers `{reauthenticatedUntil}` = stamp + 10 minutes. 401 `INVALID_CREDENTIALS` (wrong password), 403 `PASSWORD_CHANGE_REQUIRED` (`PASSWORD_CHANGE_ONLY` session), 400 `INVALID_PAYLOAD` (no password). The read side is `IdentityService.assertRecentReauth(token)`: it compares the stamp against `clock_timestamp() - INTERVAL '10 minutes'` — the database clock is the only time source, nothing from the request is trusted — and throws 403 `REAUTH_REQUIRED`.
- Guarded immediately after their ADMIN check through one shared `requireRecentReauth` (canonical `{code, message}` funnel): `start`, `pause`, `resume`, `close-registration`, `finalize`, `reopen`, `appeal-window`, `grace`, `apply-correction`. `preview-correction` stays unguarded (it changes nothing), and nothing re-authenticates implicitly: no bypass flag, no auto-retry server-side.
- Portal: `lib/api.ts` `reauth(password)` (and the two guarded helpers now keep `code` on failure so the refusal is machine-readable), `lib/client.ts` `reauthErrorText` + `REAUTH_PROMPT_TEXT`. `OrganizerConsole` and `TournamentAdjudication` detect 403 `REAUTH_REQUIRED` on the action result, render an inline password prompt per card (“Xác nhận lại mật khẩu để tiếp tục”), and replay exactly the refused action once after a successful confirmation; a refused confirmation reports why and replays nothing (no success is claimed).
- Live verification after restart: `close-registration` without confirmation returned 403 `{code:REAUTH_REQUIRED}`; `POST /auth/reauth` returned a 10-minute `reauthenticatedUntil`; the same action then succeeded. In the organizer UI the refused action rendered the inline “Xác nhận lại mật khẩu để tiếp tục” prompt; entering the password and choosing “Xác nhận” replayed the action once and the tournament moved to `VALIDATING_SUBMISSIONS` (browser-verified).
- Regression: `tsc --noEmit` server + web exit 0; `vitest run packages/server` **199/199 PASS** (37 files) — includes the new `reauth.test.ts` (9 tests: full guarded-route sweep refused with `REAUTH_REQUIRED`, preview unguarded, wrong-password 401, confirmation + `ADMIN_REAUTH` audit + guarded writes succeeding, 11-minute backdate refused, per-session scoping, limited-session 403, missing session/password, ADMIN-check-before-reauth) plus the adapted `appeal-and-announcements` and `map-versions` suites, which now re-authenticate before their guarded calls.

## Storage isolation defect found and corrected (verified)

- `ReplayStore`'s constructor defaults pointed at `/home/ha-thai/.local/share/oantuti/development/objects/replays` (the donor workspace). Because `app.ts` constructed it without an override, replay objects written by this rebuild server during the session landed in the donor directory. This was a file-level isolation breach (no donor database was touched); it was found while preparing a backup drill and is now fixed.
- Fix: `app.ts` now constructs `ReplayStore` with `<rebuild cwd>/storage/replays` and `<rebuild cwd>/storage/replay-staging` by default. All 706 replay objects referenced by the rebuild databases were verified against their SHA-256 digest, copied into the rebuild storage root, inventory `storage_path` updated, and only files created during this session (mtime on/after 2026-10-17, digest present in the rebuild DB) were removed from the donor path — older donor replays (918 files) were left untouched.
- Verified after restart: `GET /api/v2/replays/<digest>` for a migrated object returns 200 (`OANTUTI2`, 1350 B); a new private-test replay increased the rebuild storage count 706 → 707 while the donor directory stayed at 918. Future writes cannot reach the donor path.
- Consequence for S01 evidence: earlier statements that no donor writes occurred must be read with this correction; donor database state was never connected or modified, and the additive files created by mistake were removed precisely as above.

## S09 — knockout bracket keeps its EMPTY slots (verified)

- The elimination bracket no longer shrinks or fabricates sides: `EliminationFormat` now pairs **structurally**. `generateRound1(teams, stage, slotCount)` fills a fixed-width bracket (standard seeding 1vN, 2vN-1, …) where seeds beyond the field are EMPTY — an EMPTY opponent is a bye for the seeded side and a slot with no seed produces no encounter at all. `generateNextRound(completed, roundOrdinal, stage, previousSlotCount)` pairs next slot `k` from slots `2k-1`/`2k`, treats a missing row **or a row without a winner** as EMPTY (never `winnerTeamId ?? teamAId`, which used to decide a title from nothing), and returns `null` when the bracket ends — including the two-EMPTY-slots case.
- Migration `018-round-slot-count.sql` adds `tournament_rounds.slot_count`; `persistSchedule` records the structural width, the knockout advance passes it forward, and `slot_count = 0` (rows written before this column) keeps the previous array-order behaviour so existing tournaments are unaffected.
- Swiss→Playoff now seeds into the **policy** slot width (`slotCountFor(cutoff)`) instead of shrinking the bracket to the number of still-active qualifiers, matching §83 (`ranks k+1…T là EMPTY`). The scheduler emits `TOURNAMENT_NO_CHAMPION` with reason `EMPTY_FINAL` when the last round produced no winner at all (no rows) and keeps `FINAL_NO_CONTEST` when rows exist without a winner.
- Evidence: `elimination-empty-slots.test.ts` (fixed-width fill with byes, two-EMPTY slot producing no encounter, walkover past an EMPTY slot, unresolved slot never advancing its side, `null` for an all-EMPTY final, legacy array-order fallback) and the existing `four-formats.test.ts` knockout invariant still passing; `vitest run packages/server` **212 passed**. Live sanity on the dev stack: a legacy tournament (`slot_count = 0`) still answers `/api/v2/tournaments/:id/bracket` with 200.
- Still open: a real N < cutoff playoff fixture (needs a field with withdrawn qualifiers after the draw) and the EMPTY-slot UI representation in the public bracket.

## Checkpoint UI — self-audit and fixes (owner approval still pending)

- Audited `/`, `/tournaments/:id`, `/replays?digest=…`, `/workspace` and `/organizer` at 1440×900 and 390×844 in
  headless Chromium: DOM measurements (horizontal overflow, accessible names, image alt, `main` landmark, heading
  outline) plus keyboard Tab traversal with computed focus styles. Evidence: `S12-ui-accessibility-audit.json`.
- Baseline was structurally clean (0 px overflow on both widths, 0 unnamed controls, every image has alt, `main`
  present, one h1 per screen except the replay page), but three real gaps were found and fixed:
  1. **Two h1s on the replay page** — the viewer's game-id heading is now `h2`; the page keeps the single `h1`.
  2. **The header always said “Đăng nhập”**, even when signed in. `HeaderSession` now reads `/api/v2/auth/me`,
     re-reads on pathname change and on the `oantuti:session-changed` event the workspace dispatches after
     login/logout, and offers “Đăng xuất”. Verified: signed out → only `Đăng nhập`; signed in → `Quản trị Arena`
     + `Đăng xuất`; after logout → back to `Đăng nhập`.
  3. **No author-defined focus style** — added a global `:focus-visible` ring
     (`2px solid var(--accent-secondary)`, offset 2 px); the first Tab target now computes `solid 2px` cyan.
- Still NOT covered (and cannot be claimed from this audit): a manual screen-reader pass with a real participant,
  owner/designer approval of the three surfaces, physical mobile devices/touch targets, and a token-by-token
  contrast audit. Those remain `PENDING_EXTERNAL_EVIDENCE`.

## S17 — bounded development soak (measured, NOT the 72 h gate)

- `deploy/linux/soak-probe.ts` (`npm run soak:probe`) drives a short, repeatable endurance loop against the
  **running dev API** and samples the server process itself (`/proc/<pid>/status` VmRSS and `/proc/<pid>/fd`):
  public tournament/bracket/standings/announcements reads, binary replay fetches, and spectator WebSocket
  connect/close churn. It reports pass/fail criteria for HTTP failures, socket closure, FD growth and RSS growth,
  and labels the result `DEV_BOUNDED_SOAK_NOT_72H` with an explicit `notMeasured` list.
- Measured (5 minutes, 25 WS clients per round, 2 s poll): **149 rounds / 596 HTTP requests / 0 failures**,
  3.3 MB read, **3 725 sockets opened and 3 725 closed**, latency p50 **1.6 ms** / p95 **2.3 ms** / p99 **3.9 ms**,
  server RSS **142.8 → 133.3 MB** (min 126.7 / max 146.5, growth −9.5 MB), FDs **33 → 35** (min 35 / max 50, churn
  peaks), all four criteria pass. Evidence: `docs/implementation/rebuild/S17-bounded-soak.json`.
- What it does **not** cover (still required by S17): official game execution, private TEST and build-queue churn
  (needs submissions and the sandboxed executor), backup/restore rotation during the soak, the real 72-hour
  duration and 7-day rehearsal, the declared GA 6.8 release host and its quotas, and memory/FD behaviour with
  real Bot processes under cgroup limits.

## S16 — development-host capacity probe (measured, NOT release evidence)

- `deploy/linux/capacity-probe.ts` (`npm run measure:capacity`) runs two workloads on the machine it is
  invoked on and prints/writes a JSON report: the spectator WebSocket fan-out benchmark (N clients × 30
  broadcast ticks, SLA p50 ≤ 25 / p95 ≤ 50 / p99 ≤ 80 ms, 0 % drop, ≤ 200 B frames) and a game-execution
  loop playing `--games` real matches (greedy vs random, `sample-donut`, maxTurns 120) through
  `MatchOrchestrator`, i.e. with real bot processes.
- Measured on this development laptop (Ubuntu 24.04, kernel 7.0.0-38, 8 threads, 7.5 GiB RAM, host load ≈ 1.1):
  - **1 000 spectators**: 30 000/30 000 deliveries, 0 % drop, 27.8 B average frame, p50 10.78 ms / p95 17.79 ms /
    p99 19.60 ms, connection ramp-up 1.20 s, broadcast of 30 ticks 582 ms, process RSS 88.7 → 179.8 MB, SLA pass.
  - **500 spectators**: 15 000/15 000 deliveries, 0 % drop, p50 9.52 / p95 13.96 / p99 17.32 ms, RSS 89.2 → 126.8 MB, SLA pass.
  - **Game execution**: 10 games → mean 136 ms/game ≈ **7.4 games/s** (17 turns/game) at 1 000 clients idle;
    5 games → 190 ms/game ≈ 5.3 games/s (16 turns/game).
  - Evidence files: `S16-dev-host-capacity-500.json`, `S16-dev-host-capacity-1000.json`, each carrying
    `status: DEV_HOST_MEASUREMENT_NOT_CERTIFIED`, host/cgroup facts and an explicit `notMeasured` list.
- What this does **not** establish (and must not be quoted as release capacity): the declared GA 6.8 release
  host and its CPU quota; the sandboxed supervisor, gVisor/cgroup accounting and three-language SDK parity;
  storage/WAL growth and retention under a 249 500-game round robin; TLS/framing overhead, reconnect storms,
  multi-hour stability; and the mixed 500-team/1 000-viewer workload with ties/retries. Those stay
  `PENDING_RUNTIME_PROOF` for S16/S17.

## S13 — public bracket shows EMPTY slots and unplayed results (verified)

- `GET /api/v2/tournaments/:id/bracket` now returns `rounds: [{stage, roundOrdinal, slotCount, status}]` next
  to `encounters`, because a round's structural width can exceed its encounter rows: two EMPTY slots produce no
  row at all (02-GAMEPLAY §122). `lib/api.ts` grew `BracketRound`/`BracketView`, `normalizeBracketRounds`, and
  `getBracket` now returns `{encounters, rounds}`.
- `BracketSection` renders **every structural slot**: rows that exist (with the walkover/bye/double-withdrawal
  status pills and the winner already highlighted) plus dashed `Ô trống (EMPTY) · Không có cặp đấu` placeholders
  for the missing ones, and a per-round badge `n ô trống (EMPTY)`. Status classes/labels for `BYE`,
  `WALKOVER` and `DOUBLE_WITHDRAWAL` were added to `encounterStatusLabel`.
- Projector and tournament pages were adapted to the new `getBracket` shape (`bracket?.encounters`).
- Evidence: fixture tournament with a PLAYOFF round 1 of `slot_count 4` holding a `WALKOVER` (0–3, winner marked)
  and one `PENDING` encounter, plus round 2 of `slot_count 2` with a single row — rendered in the browser as
  `#1 Alpha Team 0 – 3 Beta Team · Thắng walkover`, `#2 … Chờ xếp lịch`, `#3/#4 Ô trống (EMPTY)` with the
  `2 ô trống (EMPTY)` badge, and round 2 as one real row plus one EMPTY row. API payload inspected directly
  (`rounds` present, statuses correct). Fixture rows removed afterwards; `tsc` server+web clean.
- Still open for S13: the same EMPTY treatment in the projector view, and real-device mobile/fullscreen checks.

## S14 — shared entry-code UX (ONLINE), verified end to end

- The shared-code backend (create/list/join) already existed; what was missing was the interface. Now:
  `packages/web/lib/api.ts` gained `createEntryCode`, `listEntryCodes`, `joinTournamentWithCode` and a
  server-side `getAuthProfile({cookie})` so an ONLINE-only screen is hidden instead of failing with
  `PROFILE_DISABLED`.
- Organizer console: `EntryCodesPanel` on every enrollable tournament (ONLINE profile only) — creates a code
  with a use limit and optional expiry, shows the plaintext **once** with a copy button, and lists existing codes
  with uses/max, expiry, creation time and “hết lượt / hết hạn” markers. The lane never re-displays a code.
- Tournament page: `JoinWithCode` renders for a signed-in ONLINE captain while the tournament is
  `REGISTRATION_OPEN`; the team picker lists only the caller's own teams (names resolved from the public entry
  list), and API failures surface verbatim (wrong code, expired, exhausted, already enrolled, tournament full).
- Evidence (live, ONLINE profile):
  - HTTP on `OANTUTI_AUTH_PROFILE=ONLINE`: `/auth/me` → ONLINE; code created (19 chars, maxUses 3) and listed;
    captain joined with it → entry `ELIGIBLE`, code uses `1/3`; second redemption → `409 ALREADY_ENROLLED`;
    wrong code → `403 ENTRY_CODE_INVALID`.
  - Browser on the same profile: organizer showed 10 `Mã vào giải` buttons, the panel created
    `GSSZ-VLJZ-E462-D3NY` with the confirmation line, and a student session (cookies cleared first — the shared
    test profile otherwise keeps the admin cookie) saw exactly **1** team option in the join form and got
    “Đã tham gia giải. Đội của bạn đang ở trạng thái ELIGIBLE.”
  - Fixture rows (2 entries, 2 admissions, 2 codes, team + membership) were removed afterwards and the dev API
    was restarted in its normal LAN profile.
- Operational note for future checks: `packages/web/lib/api.ts` bakes `API_BASE` at **build** time while
  `next.config.ts` rewrites read it at start time. Verifying an ONLINE-only screen therefore requires the
  ONLINE-profile API to listen on the port the web build was compiled with (4301 in dev), or a rebuild with the
  new value — otherwise server components keep talking to the old profile.

## S14 — bulk direct enrollment with preview (verified)

- `POST /api/v2/organizer/tournaments/:id/enroll/bulk` takes `{teamIds[], dryRun}` and answers in paste order: `READY`, `ALREADY_ENROLLED`, `DUPLICATE_IN_REQUEST`, `UNKNOWN_TEAM`, `INVALID_ID`, `CAPACITY_EXCEEDED`, plus `ready/enrolled/skipped/capacityRemaining`. `dryRun` (the default) writes nothing, so a lecturer can check a LAN roster first; a commit is **all-or-nothing on capacity** — a request that would exceed `maxTeams` refuses the whole batch and writes no admission or entry.
- `maxTeams` is now enforced on the single-enroll path too (it was only enforced by the self-enrollment entry code before), throwing `409 Tournament capacity of N team(s) is reached`.
- Organizer console gained the matching block on every enrollable tournament: one textarea (whitespace/comma/semicolon separated), `Xem trước` and `Thêm các đội hợp lệ` buttons, a confirmation before the commit, and a compact summary line (`Xem trước: 2/5 đội thêm được · còn 0 chỗ · trùng trong danh sách: 1 · …`).
- Evidence: `bulk-enrollment.test.ts` (403 cho non-ADMIN, preview classification without rows written, commit of exactly the enrollable teams, capacity refusal for both bulk and single paths, `TEAMS_ENROLLED_BULK` outbox) and a live HTTP run: preview `{ready:2, skipped:3}` with `ENTRIES_AFTER_PREVIEW 0`, commit `{enrolled:2}` → 2 `ELIGIBLE` entries, overflow commit `409 … would be exceeded by 1 team(s); nothing was enrolled` with entries still 2, single enroll `409 … is reached`, entries API listing 2; the browser shows the control on 10 enrollable tournaments. Fixture rows removed afterwards.
- Still open for S14: the ONLINE shared tournament code UX for bulk self-registration, instructor end-to-end walkthrough, and the usability/screen-reader proof (needs real participants).

## S11 — disqualification voids a stage and rebuilds the schedule (verified)

- `CorrectionService.disqualifyTeam(tournamentId, teamId, {reason, stage})` implements 02-GAMEPLAY §124: an upheld ruling voids **every** encounter of that team in the stage (no cherry-picking), pauses the tournament, drops the voided encounters' rating events, cancels their unstarted games/pending jobs, resolves the disputes they carried as `DQ_UPHELD`, marks the entry `EXCLUDED`, and asks the scheduler to rebuild from the earliest affected round. A public reason (3–500 chars) is mandatory and is what the audit row and the `TEAM_DISQUALIFIED` announcement carry.
- The downstream invalidation that corrections already used was extracted into one shared `invalidateDownstream(client, …)` helper; `invalidateAfterRound(tournamentId, stage, roundOrdinal)` is the public entry used here, and `invalidateAfterGame` keeps identical behaviour.
- Route `POST /api/v2/organizer/tournaments/:id/teams/:teamId/disqualify` (ADMIN + recent re-auth); organizer adjudication panel gained a `Loại đội (DQ)` block with teamId/stage/public reason, confirmation, re-auth resume and a result line; announcements list/labels carry `TEAM_DISQUALIFIED` and `ENCOUNTERS_VOIDED_BY_DQ`.
- Evidence: `disqualification.test.ts` (403/400 guards, voided points/winner, cancelled downstream round, dropped rating events, PAUSED state, outbox/audit, duplicate 409) and a live HTTP run on the dev database → `{voidedEncounters:2, paused:true, earliestRound:1}`, encounters `CANCELLED:0.0`, round 2 deleted with round 1 back at `SEAL_ELIGIBLE`, outbox `ENCOUNTERS_VOIDED_BY_DQ, TOURNAMENT_PAUSED, TEAM_DISQUALIFIED, ROUND_INVALIDATED`, audit `2 voided, paused=true`. Fixture rows were removed afterwards.
- Still open in this area: DQ of both finalists (two `EMPTY` slots → `NO_CHAMPION` document), and the operator workflow for un-pausing after a DQ review.

## S15 — retention automation in the worker (verified live)

- The retention sweep no longer depends on an operator remembering to POST it: `RetentionService.sweepAsSystem(dryRun)`
  runs the same TTL classes without a `CommandContext` (audit row records a **null actor** to mark it automatic),
  and `TournamentAutoRunner` calls it at most every `retentionIntervalMs` (default **6 h**, override
  `OANTUTI_RETENTION_INTERVAL_MS`). The ADMIN route keeps its guarded `sweep()`; the worker entry point is not
  exposed through any route.
- `/api/v2/organizer/runner-status` now reports `retentionIntervalMs`, `lastRetentionSweepAt` and the per-class
  rows of the last sweep, so an operator can see the automation working instead of trusting it.
- Evidence: live dev API (worker armed): first tick at `20:55:49Z` ran the sweep, `retentionIntervalMs = 21 600 000`,
  `lastRetentionSweep.actions` lists the five executable classes with `rows: 0` (nothing expired in the dev data),
  `lastTickAt` keeps advancing 5 s later. `retention.test.ts` gained a worker-path case asserting
  `sweepAsSystem(false)` needs no context and writes a `RETENTION_SWEEP` audit row with `actor_user_id IS NULL`.
  `vitest run packages/server` **215 passed**.

## Demo and test entry points (verified in this session)

- **Full suite**: `npm test` with the rebuild PostgreSQL env is **69 test files passed, 421 passed /
  1 skipped** in ~38 s (server alone: 326 passed / 1 skipped). Without that env `db.ts` falls back to the
  development socket, which is not running here, and 34 files fail to connect — environmental, not a
  regression. The suite re-seeds the dev database.
- **New demo driver**: `deploy/linux/dev-demo.ts` (`npm run demo:seed` / `demo:status` / `demo:login`) drives
  the real HTTP API end to end: course → LAN captain accounts → teams → demo map set → tournament with pool +
  commitment → enrollment → each team submits the **SDK starter bot** through its own captain session → waits
  for `READY` → close-registration → lock → start → waits for the auto-runner. Verified run: 2 teams,
  **4/4 games completed, 4 accepted results, ~11 s**; it prints the portal/projector/replay URLs plus a
  session-minting login command. Knocking out the guesswork: the upload must contain the SDK (`oantuti.py`)
  or the build answers `SMOKE_TEST_FAILED: CRASH_FORFEIT`, and `start` enforces the map-pool rule
  (`MAP_POOL_TOO_SMALL` — 4 maps for SINGLE_ELIMINATION/SWISS_PLAYOFF, 1 otherwise), so the seeder publishes
  the right number of maps per format.
- **Formats and sealing verified while building it**: `SINGLE_ELIMINATION` (2 teams, grace 0) reaches
  `PROVISIONAL` with round 1 sealed and the encounter score `3.0 : 0.0` (4 games, winner Team 1); `ROUND_ROBIN`
  (4 teams, grace 0) plays **12/12 games across 3 sealed rounds in ~10 s** with a real standings table
  (all four teams 3.0 pts, 0W/3D/0L, Elo 1200 — identical starter bots draw). Standings snapshots exist for
  Swiss/RR/Elo only (knockout reports through the bracket), and only after the round seals; the grace period
  must be set while the tournament is still `DRAFT`/`PUBLISHED` because policies freeze at registration
  opening (`POST …/grace` → 409 otherwise). The public RR page renders each encounter as `1 – 1` with per-game
  *Kết quả* / *Xem replay* links.
- **Demo browsing verified in the browser**: the public tournament page shows the committed map
  (`DEMO Arena 8x8 #1 · v1`), state `RUNNING` and the round-1 bracket; `/replays?game=<id>` re-verifies the
  archive checksum in the browser and the WASM engine replays it ("Engine WASM chấp nhận trace. 11 nước được
  áp dụng · kết cục Trắng · EXTINCTION"); `/projector/<id>` serves the venue view.
- **Run-book**: `docs/implementation/rebuild/demo-and-tests.md` (prerequisites, env, commands, what each URL
  shows, operating notes).

## First sign-in password change (gap found and closed)

- **Gap**: `POST /api/v2/auth/change-password` existed and enforced the product rule (new password ≥ 8,
  wrong old password → 401, success sets `password_change_required = FALSE`, revokes **every** session and
  issues a fresh `FULL` cookie), but **no portal surface called it**. A LAN-provisioned account
  (`ADMIN_ISSUED`, `password_change_required = TRUE`) signed in with a `PASSWORD_CHANGE_ONLY` session and
  then every call answered 403 `PASSWORD_CHANGE_REQUIRED` with no way forward — including an admin whose
  console rendered but could do nothing. That made the documented "unique temporary password / first change"
  onboarding a dead end.
- **Fix**: `packages/web/app/workspace/FirstPasswordChange.tsx` (old/new/confirm, 12-character UI floor like
  the register and reset surfaces, client checks, then `POST /auth/change-password` and a re-read of
  `/auth/me`); `app/workspace/page.tsx` keeps the session `scope` and renders only that panel while the scope
  is `PASSWORD_CHANGE_ONLY`; `app/organizer/page.tsx` redirects such a session to `/workspace`.
- **Verified in the browser (both roles)**: a student temp credential showed "Đổi mật khẩu lần đầu" (no team
  panels), the change produced the workspace with `Vai trò: STUDENT` and the tournament entry calls returned
  200, and the temp password then answered **401** while the new one answered **200 scope=FULL**; an admin temp
  credential landed on the same panel, `/organizer` redirected there first, and after the change the console
  rendered (`Ban tổ chức`, tournament form, map editor) instead of redirecting. DB flags followed
  (`demo_cap1 must_change=false`, `demo_cap2 must_change=true`), and `demo:accounts` wrote five
  `ADMIN_PASSWORD_RESET` audit rows.

## S14 — organizer workflows, map editor and usability (verified live + browser)

- **Real organizer journey in the browser (admin session, 127.0.0.1:4300)**: the console renders the
  tournament/team forms, the map pool, the commitment pickers and the map editor. Creating a tournament from
  the form produced `POST /api/v2/organizer/tournaments 201` and the receipt "Đã tạo giải “S14 UI Cup …” ở
  trạng thái bản nháp."; the tournament landed in state `DRAFT` (not public) with its format/policy preview.
- **Map editor built a map on the canvas, not by hand-editing rows**: 8×8 grid ("Toàn bộ lưới" → 64 valid
  tiles), thrones at (0,0)/(7,7), pieces added through the "Thêm quân" tool with the owner/type pickers. The
  cell labels expose the real state (`Ô [1, 1] · hợp lệ · quân cờ 3 (Trắng, Búa)`), and "Tạo bản đồ" produced
  `POST /api/v2/organizer/maps 201` plus a list refresh. The server stored `validation_warnings =
  [{code: UNBALANCED_PIECES, message: "Piece count asymmetry: White has 3 pieces, Black has 2 pieces"}]` with
  `version 1`, i.e. warnings are reported and persisted but never reject a map. "Xuất bản phiên bản mới" then
  produced `POST /api/v2/organizer/maps/<slug>/versions 201` and the receipt "Server đã xuất bản “…” phiên bản
  v2." (`maps.current_version = 2`, a second `map_versions` row). The editor itself states that a map already
  registered by a tournament is locked server-side.
- **Audit gap found and closed**: `MapService.createMap` / `publishVersion` were admin-guarded but wrote **no**
  audit rows, unlike `MAP_POOL_ADDED` / `MAP_POOL_REMOVED` / `MAP_COMMITTED`. Both now append
  `MAP_CREATED` / `MAP_VERSION_PUBLISHED` (actor, slug, version, visibility, warning **count** — never the
  warning text or the descriptor) inside the same transaction. Verified live against the restarted API: create
  → `201` + `MAP_CREATED {"slug":"s14-audit-probe-…","version":1,"visibility":"PUBLIC","warningCount":1}`,
  publish → `201` + `MAP_VERSION_PUBLISHED {"slug":"…","version":2,"warningCount":1}`.
- **Role guards**: with a STUDENT session `/organizer` renders the "Cần quyền ADMIN" panel ("Tài khoản … có
  vai trò STUDENT, không đủ quyền ban tổ chức") plus the public tournament list, and carries **no** console
  form; `POST /api/v2/organizer/tournaments` from that session answers **403 `FORBIDDEN`**. (Destructive
  lifecycle actions stay behind the 10-minute re-auth gate verified in S08.)
- **Keyboard and mobile usability, with a real defect fixed**: focusing a grid cell and pressing `Space`
  toggles it (`aria-pressed` true → false, keys handled by the cell's `onKeyDown`). At 390×844 the organizer
  page **overflowed horizontally** (`scrollWidth 518` vs `390`) because the header's session cluster
  (LIVE ENGINE badge + theme toggle + "Quản trị Arena" + "Đăng xuất") did not fit; `packages/web/app/layout.tsx`
  now uses `min-h-16` + `flex-wrap` on the header row and its right cluster. Re-verified after a rebuild:
  **390 px → `scrollWidth 390`, no overflow**, header 149 px on a phone, all controls still present; desktop
  1440 px unchanged (header 64 px + border, inline nav visible). The anonymous public page is fixed too.
- **Suite and environment note**: with the rebuild PostgreSQL env (`PGHOST`/`PGPORT=55434`/`PGUSER=arena_rebuild_app`/
  `PGDATABASE=arena_rebuild_c72cd5a74f33`, `OANTUTI_DEV_EXECUTION=1`) `vitest run packages/server` reports
  **326 passed / 1 skipped / 54 files**. Run without them the suite resolves `db.ts`'s file/env defaults
  (development socket `…/development/pg16/socket`, port 55432), which is not running here, and 34 files fail
  to connect — the invocation needs the env. That suite run also re-seeds the dev database, which is why the
  S14 UI fixtures are no longer present (the audit-probe map was removed explicitly).
- **Mobile sweep after the fix (390×844, admin session)**: `/`, `/workspace`, both public tournament pages,
  `/organizer` and `/projector/<id>` all report `scrollWidth 390` with **no page-level overflow**; the dense
  standings/tiebreak tables keep `min-w-[720px]` but scroll inside their own wrappers, so the page itself never
  scrolls sideways. `/live/<gameId>` and `/replays?digest=` were needed earlier in S13 with real data (the suite
  run reseeds the dev DB, which currently holds no accepted games).
- **Dev-stack operating note**: the web app runs as a *production* `next start` build behind the supervised
  `arena-rebuild-web` service, so a source edit is invisible until `npm run build` + a service restart (the API
  likewise: `arena-rebuild-api` runs `node --import tsx …` without watch). Killing those services makes the
  supervisor report them failed; relaunch the same command with the same name to restore them.

- **Still external (human) evidence**: the instructor walkthrough (start → close the tab → autonomous rounds →
  incident → finalize) and the usability/screen-reader proof with real students and lecturers. These stay
  `PENDING_EXTERNAL_EVIDENCE`; reachable implementation does not substitute for human sign-off.

## S13 — live, replay, projector and private-test privacy (verified live + browser)

- **Private TEST privacy matrix (live HTTP, real durable test run)**: a completed test (`4aaf007c…`) with its own
  replay answered **owner 200/200**, **outside team 403/403**, **ADMIN 403/403** (practice snapshots are team-only;
  the admin source-inspection right covers submitted work only) and **anonymous 401/401**. The 977-byte replay was
  only served to the owner.
- **Replay viewer (headless Chromium, `/replays?digest=df45092c…`)**: the page fetched the official replay from the
  public route, verified the SHA-256 trailer **in the browser** ("Checksum SHA-256 khớp"), and the independent
  **WASM engine** replayed the trace: "Engine WASM chấp nhận trace. 8 nước được áp dụng · kết cục Đen ·
  THRONE_BREACH". Seeking works: dragging to the end set the slider to `8` and highlighted step `#8`; step
  controls (`⏮ ◀ ▶ Tiến ▶ ⏭`) and the ply list are rendered from the result, separate from the frame state.
- **Projector (`/projector/<id>`, PROVISIONAL tournament)**: server-rendered without JavaScript (`200` and the
  tournament name/standings/provisional notice present in the HTML), shows the ELO ARENA header, the
  "Kết quả tạm tính" notice, standings, bracket, announcements, fullscreen + copy-link controls and auto-refresh
  every 10 s; after flipping the browser offline and back, the "Cập nhật lần cuối" stamp advanced
  (`06:26:32 → 06:26:42`), i.e. polling resumed and the last snapshot stayed visible while offline.
- **WebSocket contract (code + suite)**: heartbeat 20 s, stale close at 60 s with code `4408`, slow clients
  disconnected once `bufferedAmount > 1 MiB` (`ws-hub.ts`); the viewer treats a sequence gap as "frames were
  missed" and reconnects for a fresh snapshot; `live-match-hub.test.ts` covers late-join snapshots, one RESULT per
  game, idempotent unsubscribe, bounded buffers/ceilings and the grace window.
- Suite unchanged: `vitest run packages/server` **326 passed / 1 skipped / 54 files**. S13 fixture (course, teams,
  sessions, test snapshot, source and replay objects) removed.

## S12 — portal theme, SSR and the team journey (verified in Chromium)

- The design system's optional **light theme** was missing entirely (only dark tokens existed, and several used
  tokens — `--accent-primary`, the `*-tint` family — were undefined). `globals.css` now defines the complete token
  set for both themes from 04-UI-UX §4.1, with `color-scheme` and a `--focus` ring that follows the theme; the board
  tokens stay dark by spec. A new `ThemeToggle` in the header switches `data-theme` on `<html>`, persists the choice
  in `localStorage`, and a pre-paint script in the root layout applies it before hydration so reloads never flash
  the wrong palette.
- Browser evidence (headless Chromium against the real API):
  - Dark default → toggle → `light`, stored value `light`; **after a reload the theme is still light** (pre-paint
    script) and toggling back returns to dark.
  - **Draft survives the theme change**: typing `DRAFT-CODE-42` into the organizer's course-code field and
    switching the theme leaves the value intact (04 §144).
  - Mobile viewport (390×844): the desktop nav collapses, the header and page still render.
  - Guest/SSR: `/`, `/workspace`, `/replays` answer `200` with real server-rendered content without JavaScript;
    an unknown tournament id and an unknown route answer `404`.
  - Team journey with a real session: the workspace resolved the team's tournament from the server and an upload +
    submit through the UI produced a **real receipt** (`037f879d…`, ordinal 1) that the build gate turned `READY`;
    after reload the panel shows `Bản nộp hiện hành #1 · Python · starter_bot.py · Sẵn sàng` with the digest and the
    submission history. The observed network calls are the live API (`GET /api/v2/tournaments/…/entries/me 200` via
    the Next proxy) — no mock data.
  - Session expiry: replacing the session cookie with an invalid token shows the signed-in gate only and no team
    data.
- Assets: no external CDN/font URLs remain in `app/` or `lib/`, and the WASM verifier is served from
  `public/wasm/arena_engine_wasm.wasm` (self-hosted). There is no Vite portal in this workspace — the Next app is
  the only portal, so the cutover has no legacy surface left to remove here.
- Suite unchanged by the UI work: `vitest run packages/server` **326 passed / 1 skipped / 54 files**; the web app
  builds clean (`next build`).

## S11 — corrections, disputes, finalization and the post-final TEST (verified)

- The v2 correction/finalization contracts are covered end to end by the existing suites plus one new journey:
  - Disputes: a participant may file on their own encounter, a third party may not, an admin resolves with a
    decision note, an unresolved dispute blocks the round seal *and* finalization (`grace-autoseal`,
    `corrections-and-finalization`).
  - Corrections: preview carries a canonical digest, apply rejects a tampered/stale preview, the applied correction
    is atomic, appends a new result version, records the correction ledger and invalidates descendants
    (`invalidate.test.ts`); while the tournament is FINALIZED corrections are refused until an explicit reopen
    (`reopen.test.ts`).
  - Finalization: blocked by open disputes and by the appeal window (`final_appeal_window_minutes`, 0–10080 with the
    remaining-minutes message), only the final stage is manual, duplicate finalize is 409
    (`appeal-and-announcements`, `corrections-and-finalization`).
  - Announcements: the public timeline is restricted to the allowlist and private fields are trimmed
    (`announcement-payload`, `appeal-and-announcements`).
- The S10-deferred **post-final private TEST** now runs on the durable path: with the tournament set to FINALIZED,
  `createPrivateTest` → `TEST_BUILD` → `TEST_GAME` completes with its own replay, `officialCounts()` is identical
  before/after (ordinals, entries, ratings, standings) and an official submission still gets `409`
  (`private-test-runner.test.ts`). That closes the T3 integrated journey's last deferred case on the v2 path.
- Open and assigned elsewhere: there is no ARCHIVED transition command yet (only the v1 migration writes ARCHIVED);
  retention/archive and the full G2 restore proof belong to S15. Suite:
  `vitest run packages/server` **326 passed / 1 skipped / 54 files**.

## S10 — official/TEST journeys and the frozen hash (verified live)

- Multi-file builds are now covered for all three languages: `build-pipeline.test.ts` builds a TypeScript bot that
  imports a sibling module, a Python bot that imports a helper and a C++ bot that includes a local header — each
  through compile + INIT smoke to `READY` (the C++ case runs with a real `g++`).
- "The locked hash is what every official game runs": a live tournament (two teams, one starter-bot upload plus a
  variant with an extra file, 4-map pinned pool + commitment) went upload → build `READY` → `lock` → `start 200
  RUNNING` → four games played by the dev executor → `PROVISIONAL`, and every one of the four accepted results was
  re-derived from the **materialized frozen candidate manifests** (`sha256({rulesRevision, white, black})`): games
  with team A white all carry `6876…`, games with team B white all carry `c4cb…`, and **4/4 matched**. The frozen
  candidates' source digests equal the submitted ones, so no game ran a later or unfrozen artifact. (Two distinct
  combined digests are correct: the digest covers the (white, black) pair, and the series swaps sides.)
- Already-covered pieces reused as evidence: official cutoff deny (`submission-test-integration`), intake drain with
  `INTAKE_DRAINING` (`submission-lifecycle`), TEST allowed after the official cutoff (same live run as S05/S07),
  TEST_BUILD/TEST_GAME leaving ordinals, candidates, ratings and frozen pointers untouched (`private-test-runner`),
  and infrastructure retries ending in `BLOCKED` rather than a Bot forfeit (`durable-jobs`).
- T3 stays **PENDING**, exactly as the plan says: the final/archive private-TEST journey closes in S11 (real
  finalization), so this session signs T3a/b evidence but not the integrated T3 acceptance.
- Suite: `vitest run packages/server` **325 passed / 1 skipped / 54 files** (after the multi-file test).

## S09 — exact pairing implemented, verified and wired (verified)

- The greedy matchers are gone from the v2 path. `packages/server/src/tournaments/formats/matching.ts` is a
  faithful TypeScript port of Edmonds' blossom algorithm (Galil's primal-dual formulation, credited to the
  networkx/Galil reference; min-weight via the same inverse-positive + maxcardinality reduction networkx uses).
  It exposes `minimumWeightPerfectMatching(vertexCount, edges, { budgetMs, now })`, consults the injected clock
  inside the search, and raises `PairingSolverError` (`code = 'BLOCKED_PAIRING'`) for "no perfect matching" or
  "budget exhausted" — never a degraded pairing. Weights must be non-negative safe integers, asserted.
- `formats/pairing-weights.ts` encodes the pinned objectives: Swiss
  `rematch·Wr + |Δpoints|·Wp + |Δseed|` with `Wp = Smax+1`, `Wr = Pmax·Wp + Smax+1`,
  `Smax = m·(maxSeed−minSeed)`, `Pmax = m·3·(roundOrdinal−1)`; Elo lexicographic
  (prior counting encounters, |rating| in micro-rating, |drawIndex|). Tests pin the constants (m=2, seeds 1–5,
  round 2 → Smax 8, Pmax 6, Wp 9, Wr 63), the dominance property (one rematch outweighs all gap levels), and the
  500-team/round-9 safe-integer boundary.
- Integration: `SwissFormat.generateNextRound` and `EloFormat.generateEpoch` now build the weights above and call
  the exact matcher (odd fields keep their bye rules: Swiss by `(byeCount, points, seed)`, Elo by
  `(byeCount asc, drawIndex desc)`); Elo's history is now an encounter **count** per pair, and the scheduler passes
  bye counts. The scheduler maps a solver failure to a durable blocker: the seal transaction rolls back, the round
  stays unsealed, one `ROUND_SEAL_BLOCKED {reason: BLOCKED_PAIRING}` event is recorded per round, and a later
  healthy sweep seals it normally.
- Evidence:
  - Solver: `matching.test.ts` 35 tests (brute-force oracle over all perfect matchings for N∈{2,4,6,8}, 16 golden
    vectors, blocked cases, budget path with a fake clock, N=64 validity) and a throwaway differential harness
    against networkx 3.7: **260 random cases, 0 mismatches**; N=500 complete graph matched in **3.1 s** (budget 10 s).
  - Weight module: `pairing-weights.test.ts` 6 tests.
  - Regression: `exact-pairing.test.ts` — the field that exposed greedy (points `[0,3,3,3,0,0,1,1]`, previous pairs
    `(t1,t2)(t3,t6)(t4,t5)(t7,t8)`) now scores **97**, the exact optimum (greedy scored 99), and 30 random 6-team
    fields match an independent brute-force oracle.
  - Blocker: `pairing-blocker.test.ts` — a failing solver leaves round 1 unsealed, creates no round 2 and records
    exactly one `ROUND_SEAL_BLOCKED`; a healthy sweep then seals and dispatches round 2.
- Honest delta: among **equal-weight optima**, the implementation is deterministic and reproducible (fixed solver,
  canonical pair ordering, pinned inputs) but not literally the "lexicographically smallest sorted pair list" the
  spec names as the tie-break; weights-only optimality is exact. Recorded in the plan as the remaining tie-break nit.
- Suite: `vitest run packages/server` **324 passed / 1 skipped / 54 files**.

## S09 — idempotent lifecycle commands and expectedVersion (verified live)

- `021-command-receipts.sql` adds `command_receipts` (actor, scope, key, payload digest, status, receipt JSONB,
  unique on actor+scope+key). `runIdempotent` (packages/server/src/commands/idempotency.ts) claims the key, runs
  the mutation, stores the canonical receipt, and on a retry with the same key + payload digest returns that
  receipt instead of repeating the effect; the same key with a different payload is `IDEMPOTENCY_CONFLICT`, and a
  retry while the first is still running is `IDEMPOTENT_IN_FLIGHT`. The routes accept the standard
  `Idempotency-Key` header, so a double click or a lost ack no longer decides a tournament twice.
- The same lifecycle commands now also honour optimistic concurrency: `tournaments.version` is read under the row
  lock in every lifecycle transaction, `expectedVersion` from the body is checked there (`STALE_VERSION` with both
  versions), and each state change bumps the version exactly once — including lock/start/pause/resume and the
  registration extension.
- Evidence: `tournament-lifecycle.test.ts` (12 tests) replays a start with one key (same `receiptId`, one
  `TOURNAMENT_STARTED` event, version 1→2), asserts a different payload conflicts, and asserts a stale
  `expectedVersion` is refused with the tournament left untouched. Live over HTTP: first start `200 RUNNING`,
  replay with the same key `200` with the **same receiptId**, a different key `409`, `expectedVersion: 99` `409
  STALE_VERSION ... current 1` with the row still `READY_TO_START/1`, exactly one outbox event, version 2.
  Fixture and receipts removed. `vitest run packages/server`: **278 passed / 1 skipped / 50 files**.

## S08 — knockout series rotates distinct map versions (verified live)

- Closed the last map rule from 02-GAMEPLAY §153: the four games of a knockout series no longer share one
  descriptor. Migration `020-map-pool-version.sql` adds `tournament_map_pool.map_version` (backfilled), the pool
  pins the version when a map joins it, `lock` re-pins every pooled map against the map's current version, and
  `persistSchedule` resolves the frozen pool in pinned order (`resolveStageMapPool`) and hands game *n* the
  descriptor `pool[(n-1) % poolSize]` for knockout stages. Round-robin/Elo keep one map per encounter, and a
  tournament with no pool keeps the caller's descriptor, so existing fixtures and the pool-less dev path behave
  exactly as before.
- Evidence: `four-formats.test.ts` §6 (12 tests in the file) asserts a 4-map pool yields the four pool names in
  order with four distinct versions, and that a pool-less knockout tournament schedules all four games on the
  caller's map. Live against the dev API: a 2-team knockout tournament with a pinned 4-map pool and a commitment
  answered `200 RUNNING` and its four games carried `s08-rotation-1…4` in pool order — `distinct_maps 4`. Fixture
  (rows, objects, session) removed.
- Note: the first live attempt looked like a failure because the dev API still ran the previous build; restarting
  the service after a server-side change is part of the verification recipe.

## S08 — map pool policy and the start contract

- Two product gaps closed with tests:
  1. **Hidden map leak into practice** (same section as S07 above): `PrivateTestRunner.resolveMap` no longer falls
     back to an unrevealed HIDDEN map.
  2. **Pool minimum at start**: `start` now refuses a tournament whose frozen pool cannot host the stage —
     `MAP_POOL_TOO_SMALL` with the required count for `SINGLE_ELIMINATION`/`SWISS_PLAYOFF` (4 maps, so a
     four-game series never repeats a version) and ≥1 for round-robin/Elo (02-GAMEPLAY §153). The guard runs in
     the service, so both the route and any internal caller are covered; `tournament-lifecycle.test.ts` seeds a
     policy-compliant pool (4 public + 1 hidden) for the happy path and asserts the refusal for a one-map pool.
- Verified in the same area (existing suite + the S07 live journey): lock is one transaction that stops further
  intake, refuses with `INTAKE_DRAINING` while receipts still compile, freezes the latest READY receipt per
  admitted team (teams without one become EXCLUDED) and reveals the pool's hidden maps; `start` is ADMIN-only
  (STUDENT denied), refuses a state other than READY_TO_START (duplicate start → 409), refuses fewer than two
  eligible teams, and requires a map (`MAP_REQUIRED` without a commitment; a mismatched slug is
  `MAP_COMMITMENT_MISMATCH`). Pool edits are refused once registration opens (`MAP_FREEZE_LOCKED`).
- Still open and tracked in the plan: the four games of a knockout series are all created with the round's single
  descriptor, so "distinct map versions for the 4 knockout slots" (02 §153) is not yet implemented — that needs
  the pool pinned per version at lock plus per-game-ordinal assignment in the scheduler.
- Evidence: `vitest run packages/server` **275 passed / 1 skipped / 50 files**.

## S07 — real game to verified replay (verified live) and S08 hidden-map leak fixed

- Live journey on the dev API (unsandboxed dev executor, clearly not a certification): two teams uploaded the
  official Python starter bot + SDK (`sdk/python/…`, 3 046 B ZIP) through `POST /submissions` → both receipts
  ordinal 1; the durable worker compiled and smoke-tested them to `READY`; `/lock` → `READY_TO_START`; `/start`
  first answered **400 MAP_REQUIRED** (the start contract refuses a tournament with no committed map), and after
  committing a map version the same call returned `200 RUNNING`. The autonomous runner then played the whole
  4-game final with the real bot processes (all four games `COMPLETED`, encounter `COMPLETED` with a winner) and
  parked the tournament at `PROVISIONAL` — no manual step in between.
- Every game exposed an accepted result (`/api/v2/games/:id/result`: winner, `reason EXTINCTION`, disposition,
  `replayDigest`, `resultVersionId`, revision) and the replay downloaded from `/api/v2/replays/:digest` came back
  `200`, magic `OANTUTI2`, with `sha256(bytes) == digest` for all four.
- Independent verification of those same objects: `deploy/linux/verify-replay-parity.ts --limit 8` reports
  **checked 8 / rustOk 8 / tsOk 8 / wasmChecked 8 / wasmOk 8 / mismatches 0** — Rust `arena_engine::replay`,
  the TypeScript `TraceVerifier` and the WASM verifier agree byte-for-byte on the fresh replays.
- Suite coverage behind it: `build-pipeline.test.ts` (7) compiles PYTHON/TYPESCRIPT/**CPP** (real `g++ -O2
  -std=c++20` with `sdk/cpp` on the include path) and rejects the broken variants; `results-durability.test.ts`
  (12) covers replay serialization/checksum/tamper rejection, staged fsync → immutable promotion, trace verdicts
  (valid, illegal move, wrong winner, forfeit), fraudulent evidence rejection, **no second accepted result for a
  game**, and OANTUTI1 read compatibility; `durable-jobs.test.ts` covers heartbeat/fence and orphan promotion.
- S08 leak found while reading the private-test path: `resolveMap`'s fallback picked the **newest map in the
  database**, so a team practising before the organizer's reveal would have played on the unrevealed HIDDEN map
  and learned it from its own board/replay. The fallback now accepts only `PUBLIC` or already-revealed versions
  (committed maps stay first), and `private-test-runner.test.ts` proves a HIDDEN map is never used.
- Off-host restore stays with S15 (PENDING_PROVIDER_T11); the three-language trusted match harness and the
  sandboxed supervisor remain blocked on the S02 boundary. Evidence: `vitest run packages/server`
  **274 passed / 1 skipped / 50 files**; live fixture (rows, sessions, 4 replays, source object) removed.

## S06 — durable jobs: lease policy aligned and DB-side verified

- Lease policy is now pinned in one place and matches 03-ARCHITECTURE §109 (lease 30s, heartbeat 5s,
  reconciler stale marking, 3 infrastructure attempts with 5/15s backoff): `LEASE_HEARTBEAT_SECONDS = 5` lives
  next to `LEASE_TTL_SECONDS` and both workers (official `execution-service`, private `auto-runner`) use it. They
  previously renewed at TTL/3 = 10s, i.e. the heartbeat cadence was double the contract value.
- Verified by existing suite (`durable-jobs.test.ts`, 7 tests): SKIP LOCKED claim honouring priority and FIFO,
  heartbeat renewal plus rejection of stale fencing tokens, two-phase `prepareCompletion` → `complete`, expired
  lease reclaim with 5s/15s backoff and `BLOCKED` after 3 attempts, orphaned `COMPLETION_PENDING` promotion when a
  worker dies mid-completion, idempotent enqueue, and claim narrowing by job type. Retry never converts an
  infrastructure failure into a Bot forfeit; the whole-tournament schedule is never cancelled.
- Cadences verified in code: reconciler runs on the runner tick (`DEFAULT_INTERVAL_MS = 5_000`, i.e. inside the
  10s stale window), game jobs run at priority 100 while `TEST_GAME_JOB_PRIORITY = 50`, so official work is
  claimed before practice runs.
- Still open (blocked by the S02 sandbox boundary): the UDS **UID-bound** internal claim/heartbeat/
  prepareCompletion/complete channel (03 §193). Neither the server nor `crates/arena-supervisor/src/control.rs`
  authenticates the peer UID today (no SO_PEERCRED check), and the consumer is the real sandboxed supervisor, so
  S06 is not signed off. Evidence: `vitest run packages/server` **273 passed / 1 skipped / 50 files**.

## S05 — source intake limits and T3a durability (verified live)

- Limits (01-PR §103) now have boundary tests instead of only implementation: `source-limits.test.ts` proves a
  project sitting exactly on 16 × 256 KiB = 4 MiB expanded is accepted, 127 uploaded files are accepted while the
  128th is refused ("the manifest is the 128th"), and one byte past a per-file/expanded/ZIP cap is refused with
  the matching 413; the ZIP-size check runs before any entry is parsed, so a 2.5 MiB incompressible archive is
  rejected without touching its contents. The in-memory ZIP builder moved to `tests/helpers/zip.ts` (accepts
  Buffers and is shared with `submission-lifecycle.test.ts`) instead of being copied per test file.
- Live T3a journey against the dev API + PostgreSQL: upload of a real multi-file ZIP returned
  `200` with `{receiptOrdinal: 1, sourceDigest}`; `/submissions/:id/source` returned `200` with the manifest
  (`fileCount 2`, `entrypoint bot.py`); the object on disk was **byte-identical and hash-identical** to the
  uploaded archive; a foreign team got `403` and an anonymous caller `401`; with the registration deadline moved
  into the past the official upload was refused `409 "Submissions closed: registration deadline has passed"` while
  the private TEST upload still returned `200` — the official cutoff does not close the TEST flow.
- Restart durability: after a cold restart of the API the same endpoint still served the receipt's manifest and
  the row/digest matched, i.e. nothing about the receipt depended on in-process state.
- Evidence: `vitest run packages/server` **273 passed / 1 skipped / 50 files**; fixture (rows, sessions, stored
  object) removed afterwards. T3 stays open to S10 for the integrated official/TEST journeys, per the session plan.

## S09/S13 — field sizes, playoff cutoffs and the EMPTY-slot bracket (verified)

- `format-field-sizes.test.ts` adds the plan's N2/3/4/5/10/16/64 acceptance set at policy level: the knockout
  bracket pads to a fixed width (2·slotCount − N byes, no duplicate team), Swiss R/T match the pinned values
  (T=2 for N≤10, 4 for N=16, 8 for N=64) and round 2 avoids rematches, round robin schedules every unordered
  pair exactly once ((N(N−1))/2 pairs over N−1 or N rounds), and Elo pairs the whole field once per epoch with
  E = max(8, 4·ceil(log2 N)). The "fewer qualifiers than the cutoff" case (T=8 bracket, 3 active teams) keeps
  4 pairing slots, emits only the 3 bye rows and never fabricates a matchup.
- Bracket UI: the public tournament page renders a 5-team/8-slot bracket with the round header
  `4 trận · 4 ô trống (EMPTY)`, `Bye — miễn đấu / Đi tiếp (bye)` rows and slots #5–#8 as
  `Ô trống (EMPTY) / Không có cặp đấu`. Verified in headless Chromium against the dev API (:4300/:4301) with a
  real fixture; fixture removed afterwards.
- Evidence: `vitest run packages/server` **266 passed / 1 skipped / 49 files** at the time of the field-size run,
  plus the browser screenshot of the bracket.

## S11 — disqualifications and the title (verified live)

- What a DQ does to the final is now spec-correct (02-GAMEPLAY §118/§122/§124) and tested end-to-end:
  - a *played* stage encounter of the disqualified team is voided (CANCELLED, 0-0, ratings deleted), which
    forces the bracket to rebuild from the earliest erased round;
  - an encounter that never started resolves like a withdrawal — one active opponent advances (WALKOVER,
    knockout advance, Swiss/RR 3 points, Elo no rating) or DOUBLE_WITHDRAWAL when the opponent is gone too;
  - both finalists disqualified -> nobody advanced, so the stage ends `PROVISIONAL` with
    `TOURNAMENT_NO_CHAMPION` and no fabricated champion; one finalist disqualified -> the survivor advances.
- Two latent bugs surfaced and were fixed on the way:
  1. "Encounter started" (§124 = first game claim) was inferred from `games.status <> 'PENDING'`, but the
     scheduler inserts a dispatched round's games as `RUNNING`, so a dispatched-but-untouched encounter was
     treated as playing and never resolved as a walkover. New shared helper
     `packages/server/src/tournaments/encounter-state.ts::isEncounterStarted` (COMPLETED game or a GAME job in
     LEASED/RUNNING/COMPLETION_PENDING) is now used by both disqualification and withdrawal.
  2. The walkover/withdrawal paths cancelled only `PENDING` games, so a decided encounter kept playable
     `RUNNING` games and its queued job. Both paths now cancel every non-COMPLETED game, block the active GAME
     jobs and drop stale rating events.
- Rebuild hygiene: `invalidateDownstream` deletes the *unplayed* encounters of the rounds it deletes (no
  completed game, rating or dispute), so a regenerated round no longer holds two rows for the same slot —
  `/api/v2/tournaments/:id/bracket` therefore returns exactly one row per slot with EMPTY/BYE intact.
- Evidence: `dq-finalists.test.ts` (4-team single-elimination driven to the final: both finalists -> PROVISIONAL +
  `TOURNAMENT_NO_CHAMPION`, no winner in the last round; one finalist -> the survivor holds the last round via a
  BYE row), `disqualification.test.ts` (walkover for an unclaimed dispatched encounter; games `CANCELLED`, job
  `BLOCKED`), `withdraw.test.ts` (same for withdrawal). `vitest run packages/server`: **232 passed / 48 files**.
  Live against the dev API: DQ -> `200 {walkovers: 1}`, encounter `WALKOVER` with the opponent as winner, game
  `CANCELLED`, job `BLOCKED`, `ENCOUNTER_WALKOVER` emitted; short reason `400`; session without recent re-auth
  `403`. Fixtures removed.

## S05 — private TEST create rate limit (verified live)

- §123 requires 10 private-TEST create requests per rolling minute per (tournament, team), counting requests
  that fail validation ("failed auth/validation khong tao game nhung rate-limit van tinh"). Only the 2-pending
  and 30-per-UTC-day caps existed, so the HTTP surface had no burst limiter.
- New `test_create_attempts` ledger (migration `019-test-create-attempts.sql`, applied to dev + test DBs as
  `arena_rebuild_migrator` with `SELECT/INSERT/UPDATE/DELETE` granted to `arena_rebuild_app`). The route records the
  attempt **before** payload validation, so a malformed body still consumes the window; `checkActorTeam` runs first,
  so a foreign member cannot burn another team's window. Rows prune after a day and cascade with their tournament.
- Service `SubmissionService.recordTestCreateAttempt` (called from `POST /api/v2/tournaments/:id/private-tests`)
  counts the rolling minute and answers `429 QUOTA_EXCEEDED {quota: TEST_CREATE_RATE, limit: 10}`.
- Evidence: `submission-quotas.test.ts` (new test) shows 10 rejected `INVALID_LANGUAGE` requests each `400`, the
  11th `429 TEST_CREATE_RATE`, a well-formed request also `429` while full, and `200` again after ageing the window.
  `vitest run packages/server` **228 passed**. Live against the dev API: same sequence observed
  (`[400 x10, 429]`, valid-while-full `429`, post-drain `200` with a testId); fixtures, minted dev session and
  ledger rows removed.

## S13 — public replay route serves official results only (verified live)

- `/api/v2/replays/:digest` read any object in the replay store by digest. Private TEST replays share that
  store, so a team-only practice replay was downloadable by anyone who held its digest — a transport-level leak
  that contradicts 01-PRODUCT-REQUIREMENTS §113 (private TEST replay through HTTP/download must stay team-only).
- `ResultService.getReplay` now first checks that the digest is referenced by an `result_versions` row (i.e. an
  official accepted result). A private TEST replay never becomes one, so the public route answers `404` while the
  team's own `/api/v2/private-tests/:id/replay` keeps working through the store.
- Evidence: `private-test-runner.test.ts` asserts the team can read its replay **and** that `ResultService.getReplay`
  refuses the same digest; `vitest run packages/server` **227 passed**. Live: the official digest `df45092c…` → 200;
  a valid, hash-matching, on-disk object with no result version (mutation of an official file under a new digest) →
  **200 before the restart, 404 after** — the gate is what changed. Fixture row/file removed.

## S13 — public announcement payloads are trimmed (verified live)

- The public tournament timeline forwards allow-listed outbox payloads as-is. `TEAM_WITHDRAWN` carries the
  organizer's free-text `reason`, which is an internal note rather than a published fact; the **disqualification**
  reason, by contrast, is the reviewed public reason and must stay.
- `publicAnnouncementPayload(topic, payload)` (exported from the tournaments routes) now drops `reason` for
  `TEAM_WITHDRAWN` only; every other allow-listed topic is unchanged and the outbox ledger still keeps the full
  payload. The public read is the only thing trimmed.
- Evidence: `announcement-payload.test.ts` (withdrawal reason removed with counts kept, DQ reason preserved,
  non-object payloads untouched) and a live run: withdraw returned `200`, the public timeline showed
  `TEAM_WITHDRAWN` with `{teamId, walkovers: 1, doubleWithdrawals: 0, tournamentId}` and **no `reason`**
  (`REASON_LEAKED False`). Fixture removed; `vitest run packages/server` **227 passed**.
- Repository-wide checks after today's changes: `vitest run` (all packages) **319 passed / 61 files**,
  `cargo test --workspace --offline` all suites ok (0 failed), `next build` ok, wasm artifact present
  (206 631 B, sha256 `7994d3bf…`).

## S03/S05 — one direct-enrollment path (cleanup + verified live)

- Two direct-enrollment implementations existed: `TournamentAdmissionService.enrollTeam` (state gate, capacity by
  active entries, audit, outbox, backup fence) and `TeamService.directEnrollTeam` behind the legacy
  `/organizer/tournaments/:id/enrollments` route. The legacy copy allowed **DRAFT/PUBLISHED** enrollments, counted
  withdrawn teams against capacity, and skipped the audit/outbox/fence — a second set of rules for the same write.
- Consolidation: the alias route now lives in the admission surface and calls the one `enrollTeam`; the legacy route
  and `TeamService.directEnrollTeam` are **deleted**. The missing checks from the old copy moved into the single
  path: **course isolation** (`TEAM_COURSE_MISMATCH`) and the tournament's **team-size window**
  (`TEAM_SIZE_INVALID`) now apply to `enrollTeam` and to bulk enrollment (new statuses `OUT_OF_COURSE`,
  `TEAM_SIZE_INVALID`).
- Tests: `identity-production.test.ts` now drives the production admission path (and its fixture team has the
  captain membership the size rule needs); `bulk-enrollment.test.ts` fixtures added memberships. `vitest run
  packages/server` **224 passed**, `tsc` clean.
- Live: alias against a DRAFT tournament → `409 ... expected REGISTRATION_OPEN or VALIDATING_SUBMISSIONS` (the old
  path accepted DRAFT); another course → `400 TEAM_COURSE_MISMATCH`; zero members → `400 TEAM_SIZE_INVALID: 0
  member(s), tournament allows 1–3`; valid team → `201` `ELIGIBLE`; duplicate → `409`. Fixtures removed.

## S11 — one finalize implementation (cleanup + verified live)

- Two finalize paths existed: the API route used `TournamentAdmissionService.finalizeTournament` (appeal-window
  gate, open-dispute gate, audit, `TOURNAMENT_FINALIZED` outbox), while `TournamentLifecycleService.finalize` was a
  second, weaker copy used only by one test. That is exactly the drift the plan forbids — the test was asserting
  behaviour production did not have.
- The duplicate was **removed** (method and `TournamentFinalizeReceipt` type), and
  `corrections-and-finalization.test.ts` now drives the production path: it sets a 0-minute appeal window through
  `setAppealWindow` before finalizing, and keeps the open-dispute and already-finalized assertions. `lifecycle`
  keeps lock/start/extend only.
- Evidence: `vitest run packages/server` **224 passed**; `tsc` server clean. Live: a PROVISIONAL dev tournament with
  1 266 minutes left on its default 1 440-minute window answered `409 APPEAL_WINDOW_OPEN: 1266 minute(s)
  remaining`, proving the gate runs on the route the organizer actually calls.

## S10/S13 — private tests are team-only, including from ADMIN (spec correction, verified live)

- The private-test runner's access check let an **ADMIN** list/read any team's practice snapshots, results and
  replays. That contradicted the approved rule: the ADMIN source-inspection right covers **submitted** work only
  (01-PRODUCT-REQUIREMENTS §43/§99; 05-SECURITY-OPERATIONS §113/§115 “ADMIN đọc bài đã nộp không mặc nhiên đọc
  draft/test chưa nộp”).
- `PrivateTestRunner.assertTeamAccess` now refuses `ADMIN` with `403 FORBIDDEN "Private tests are visible to the
  owning team only"`; team members keep the existing FULL-scope/team-membership path. No route exposes the tests
  to the organizer any more, and the audit trail still records every submitted-source read.
- Evidence: `private-test-runner.test.ts` now asserts admin is refused for list/get/replay (the old assertion that
  encoded the opposite was replaced, not re-pinned) and the whole 6-test suite passes; `vitest run packages/server`
  **224 passed**. Live with an ADMIN session: `GET /api/v2/tournaments/:id/private-tests?teamId=…` → **403** with
  the message above; a nonexistent id still answers `404 TEST_NOT_FOUND`, so nothing is leaked before the check.

## S08 — initial-terminal map check (verified live)

- `MapValidator` now asks the **engine** whether the starting position is already decided — the same
  `evaluateVictoryV2` the runner uses, not a second copy of the rules. A terminal start (an enemy already on a
  throne, or a side to move with no legal move) becomes an `INITIAL_TERMINAL` **warning** with the engine's
  winner/reason and the note that the match would end at ply 0; an engine rejection is reported as
  `INITIAL_STATE_UNVERIFIED`. Warnings never reject a map, and an empty lineup placeholder is skipped.
- Evidence: `map-initial-terminal.test.ts` (boxed-in stalls at ply 0, enemy on a throne, empty placeholder,
  normal opening) and the existing zero-warning standard-map expectation still passes. Live `POST
  /organizer/maps`: the boxed-in map returned `201` with `[{UNBALANCED_PIECES}, {INITIAL_TERMINAL: "winner 2,
  reason STALEMATE; the match would end at ply 0"}]`, the normal map returned `201` with `[]`. Fixture maps
  removed afterwards; `vitest run packages/server` **224 passed**.

## S08 — tournament map pool management (verified live + browser)

- The pool service existed but had no interface and no guards. Now:
  - `MapService.addMapToPool(tournamentId, slug, actor)` / `removeMapFromPool(...)` are **admin-only**, resolve the
    map by slug, refuse edits once maps freeze (`MAP_FREEZE_LOCKED` outside DRAFT/PUBLISHED), are idempotent for
    duplicate adds, and write `MAP_POOL_ADDED` / `MAP_POOL_REMOVED` audit rows. The unguarded insertion used by one
    fixture moved into that test itself (direct SQL), so no production method can bypass the guard.
  - Routes: `GET /api/v2/organizer/tournaments/:id/map-pool` (ADMIN, returns `{pool, warnings}` with
    `POOL_UNDER_FOUR` below four maps), `POST …/map-pool {slug}`, `DELETE …/map-pool/:slug`.
  - Organizer console: a `Pool bản đồ (n)` block inside the map panel — entries show slug, name, version and a
    visibility badge, with a remove button; an add select lists maps not yet in the pool; the `<4` warning is
    rendered from the server's `warnings`. The organizer page now reads the pool for **every** tournament
    (including DRAFT, which is exactly when maps are edited) instead of skipping drafts.
- Evidence: `map-pool.test.ts` (student 403, unknown slug 404, duplicate add idempotent, remove, audit rows, freeze
  409) and `vitest run packages/server` **220 passed**. Live HTTP: empty pool returned the `POOL_UNDER_FOUR`
  warning, add → `['ide-map']`, duplicate → still 1, unknown slug → 404, remove → 0, add after `open-registration`
  → `409 MAP_FREEZE_LOCKED`. Browser: the DRAFT card showed `Pool bản đồ (1)` with `ide-map · IDE Map · v1` and
  the warning, “Bỏ” refreshed it to `Pool bản đồ (0)`. Fixture tournaments/rows removed afterwards.

## S15 — backup-lag write fence (verified live)

- `packages/server/src/operations/backup-fence.ts` implements the operations rule “backup lag > 5 min pauses
  protected writes”. `BackupFence.assertFresh()` refuses when the heartbeat
  `deployment_settings.backup_status.lastSuccessAt` is missing or older than the limit, and is wired into the
  places that change the protected state: **official submission receipts**, **direct/bulk enrollment**, and the
  **lock / start / finalize** lifecycle transitions. Enforcement is opt-in (`OANTUTI_BACKUP_FENCE=enforce`,
  limit `OANTUTI_BACKUP_MAX_LAG_MINUTES`, default 5); with the fence off every call is a no-op, so the
  development stack has no bootstrap dependency on a scheduled backup.
- The heartbeat is written by the thing that actually completed a verified backup: `deploy/linux/wal-restore-drill.py`
  now records `backup_status` after a successful restore (`--no-heartbeat` opts out). It is deliberately not
  exposed through any HTTP route.
- Evidence: `backup-fence.test.ts` (off = no-op, missing heartbeat = 409, stale 10-minute heartbeat = 409, fresh
  heartbeat passes, env parsing) and a live HTTP run with `OANTUTI_BACKUP_FENCE=enforce`: enrollment answered
  **409 `Protected writes are paused: no successful backup has been recorded yet`**, recording a heartbeat made
  the same call answer **201** with an `ELIGIBLE` entry; fixture rows removed and the dev API restarted without
  enforcement. `vitest run packages/server` **218 passed**.

## S15 — local WAL archiving + point-in-time restore drill (verified, NOT off-host)

- `deploy/linux/wal-restore-drill.py` runs the whole archiving path on the development cluster and
  measures the two gates S15 names: **RPO** (a transaction committed after the base backup must
  survive a restore) and **RTO** (time from `pg_ctl start` to the first successful query). It is
  parameterised (`PGBIN`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSUPERUSER`, `BACKUP_ROLE`,
  `ARCHIVE_DIR`, `RESTORE_DIR`) and writes `docs/implementation/rebuild/S15-wal-restore-drill.json`.
- Steps it performs: enable `archive_mode` + a local `archive_command` via `ALTER SYSTEM` (restarting
  the cluster only when it was off), grant `REPLICATION` to the dedicated `arena_rebuild_backup`
  role, take a `pg_basebackup -X stream` (087 MB / 6.6 s), write a marker row **after** the backup,
  force a WAL switch and wait until the covering segment is in the archive, then restore into a fresh
  0700 data directory with a short `/tmp` socket path, replay the archived WAL and verify the marker.
- Measured on this host: base backup **6.64 s / 82 254 911 B**; segment archived **6 ms** after the
  switch; restore **1.92 s** from start to first query; marker present (**RPO check passed**) with row
  counts `users/games/encounters = 3/704/333`. Manifest status is `LOCAL_WAL_RESTORE_DRILL_NOT_OFF_HOST`
  with `offHost: false`, plus a `notMeasured` list (off-host transfer, key custody/signed manifest,
  35-day retention, backup-lag write fencing, release host, 249 500-game volume).
- Cluster changes made and kept, both required for the drill to be meaningful: archiving is now
  **on** with `archive_command = 'cp %p <pg16>/wal-archive/%f'` (archive currently 161 MB on a volume
  with 22 GB free), the backup role has `REPLICATION`, and `pg_hba.conf` gained
  `local replication arena_rebuild_backup peer map=rebuild_local`. The dev PostgreSQL service was
  restarted by the drill and re-registered under supervision; the dev API and portal were restarted
  afterwards and both answer 200.
- Still PENDING_PROVIDER_T11 (unchanged): off-host copy/transport, immutable object inventory and GC
  holds, key custody, archive-failure alerting, write fencing when backup lag > 5 min, and the same
  drill on the declared GA 6.8 release host with a production-sized data set.

## S15 partial — local backup/restore drill (verified, off-host still pending)

- `deploy/linux/backup-restore-drill.py` is a parameterised drill (no donor paths): `pg_dump --clean` of the rebuild database, gzip archive of the declared object roots, SHA-256 for both, restore into a fresh same-cluster database, per-table row-count comparison for 10 core tables, manifest written next to the artefacts, restore database dropped afterwards.
- Run against the dev database with `storage/submissions` + `storage/replays`: dump 3,757,849 B (`01fa42b0…`), objects 171,433 B (`74ee8a28…`), backup 0.19 s; counts matched exactly (users 3, teams 122, tournaments 43, entries 164, submissions 180, games 704, accepted_results 702, replay_objects 702, standings 575, rating_events 64). Manifest reports `offHost: false` explicitly.
- Still missing for S15 acceptance: a genuinely off-host copy/transport, WAL/base-backup RPO ≤5 min and RTO ≤30 min measurement, object inventory GC holds, key custody and retention automation. This local drill proves only the mechanical restore path and must not be presented as off-host recovery certification.

## Global team ratings — implementation and isolated acceptance

- Implemented migration 027; frozen rated configuration and start-captured field; `ArenaContestRating/v1` calculator/ranks; deterministic current-lineage placement for all formats; canonical source/preview digest; transactional decisions/idempotency; approval-ordered immutable contest history; async generation rebuild with cross-process worker lock and atomic pointer switch; safe public APIs, pagination and live tournament summaries; organizer controls, public ranking/profile/history and rating labels across surfaces.
- Latest post-review verification: targeted rating service/publication/calculator suites **59/59 passed** after the final cursor-bound, worker-session-loss, tie-rank, and DB-unavailable tests; both server and web `tsc --noEmit` passed; web production build exit **0**. Earlier full isolated suite remains **89 files passed/4 skipped, 577 passed/42 skipped**; it was run after the production fixes and tie-spanning regression, before the final database-unavailable test was inserted; that new case is covered by the latest targeted run. The disposable services, databases, roles and browser session were stopped/removed afterward.
- Full isolated server regression suite, final run after all fixes including public DB failure and tie-spanning cursor regressions: **89 files passed, 4 skipped; 577 passed, 42 skipped** (619 total). The additional skip is the conditional boundary case requiring late UTC daily quota setup; no failures. (Earlier temporary submission-lifecycle/quota failures were due to fixture capacity settings; fixtures were fixed and those targeted tests passed 48/48 before the final suite.)
- Schema-26→27 upgrade verified on a disposable DB: all 27 migration rows/checksums matched; application role DML grants verified. No demo DB was migrated.
- Isolated real-run acceptance: 4-team Rated RR completed 12 accepted games, finalized and approved; second Rated 2-team knockout completed, finalized and approved as generation 2. Guest leaderboard/profile, ADMIN review/reauth/approval, public publication, and STUDENT first-login/password change + public access/organizer 404 were exercised in browser with successful response evidence. Dark and light themes and 390px viewport were viewed; focus/tab navigation reached header controls; tables have horizontal overflow handling. Formal keyboard/AT audit, polling under browser-hidden state, cursor reset during a generation switch, malicious-name case, and public tournament-ID route cases were not exercised in browser.
- Final review: prior independent reviewer flagged 4 concrete issues; all four fixed with regressions. A fresh final reviewer confirmed the fixes but flagged leaderboard tie rank pagination; the real DB tie-spanning-page regression passed against the existing CTE (rank window is computed before cursor filter), so no code change was needed. The implementation is review-complete; reviewer did not run tests/build.
- Measured calculator workload: **19,497 ms** for 100 sequential × 500-team calculations; no database/history concurrency included. No end-to-end 100×500 DB or concurrent HTTP capacity evidence is claimed.
- Software acceptance on isolated workstation: full suite + compiler/build + real-run ADMIN/STUDENT/guest journey passed. Not a release/deployment certification: no production migration/deploy, external CI publish/auth, off-host backup RPO/RTO, 500-team capacity/endurance, formal accessibility or owner visual signoff. Those gates remain separate and unasserted.

## Remaining sequence

S02 runtime/engine → S03 LAN/core → S04 ONLINE → S05 source T3a → S06 jobs → S07 acceptance/replay → S08 maps/lock → S09 formats/seal → S10 T3b → S11 adjudication → owner visual checkpoint → S12 Next → S13 viewer → S14 organizer/usability → S15 deployment/recovery → S16 capacity → S17 endurance/signoff. No historical COMPLETE status is accepted as provider evidence.

## 2026-10-18 LAN-first completion — implementation ledger (detail in `lan-completion-evidence.md`)

Status: IN_PROGRESS. ONLINE and deployment stay paused; nothing here is a release or capacity certification.

- **Isolation:** `deploy/linux/test-isolated.mts` refuses any database whose name is not `arena_*test*`; suites ran on `arena_role_ux_test`.
- **Migrations:** new `deploy/linux/apply-migrations.mts` applies pending SQL with schema probes for 017/018 (which never self-registered), refuses non-isolated names unless `OANTUTI_MIGRATE_CONFIRM` equals the exact database, and re-asserts the application DML grant with `--grant-to`. Found that a table created by a migration after initialisation is otherwise invisible to the app role.
- **Identity:** Argon2id with legacy `scrypt` upgrade (CAS), process-lifetime and login throttling, shared `identity_session_valid`, singleton ADMIN. Migration 022 applied to both the isolated and the dev database; the dev one needed operator-approved removal of a leaked `org_admin_…` fixture. Aggregate server suite at the end of this pass **64 files / 422 passed / 1 skipped**; Rust workspace **162 passed**.
- **Native gateway:** transport now requires the assignment service; the unverified digest-shape completion path and the legacy transport test are gone. Fixed a lease-identity comparison bug that would have failed every real completion. New `tests/native-game-acceptance.test.ts` proves verified acceptance, refusal of unproven observations, and policy/fence/capacity enforcement. `crates/arena-supervisor/src/broker.rs` rejects an oversized request per connection instead of terminating (regression proven to fail without the guard).
- **Native worker:** `crates/arena-supervisor/src/{worker,materialize,sandbox}.rs` and `src/bin/arena-worker.rs` claim GAME/TEST_GAME/BUILD/TEST_BUILD work over the SO_PEERCRED socket, verify and materialize per-attempt grants, build the OCI bundle from operator-only roots, run compile plus INIT smoke through one shared sandbox launch lifecycle, drive matches (official and private) through the existing runner session, upload compiled artifacts in ascending chunks, and submit measured observations or a build verdict with the stage that decided it; the sandbox has a single `runsc` spawn site with a `run_command` primitive bounded by the assignment's wall limit. Rust workspace **162 passed / 0 failed** (6 new private-test tests), `--all-targets` warning-free.
- **Native private TEST (server):** `private-test-result-service.ts` owns the snapshot lifecycle (conditional claim, release on lease loss, infrastructure finalization on exhausted attempts) and records a Rust-verified result on the snapshot only — replay promoted before the row names its digest, no accepted result/rating/ordinal/frozen candidate — while a READY `TEST_BUILD` enqueues its follow-up `TEST_GAME` from the control plane. Both sides were cross-checked against the same assignment shape (`testId` = target, manifest `gameId` = snapshot id, opponent kind literals), not only against their own fixtures.
- **Native build acceptance (server):** `compiled-artifact-store.ts` (content-addressed, atomic, digest-verified) and `NativeAssignmentService` build assignments/acceptance: attempt spool grants (`0700`/`0600`, fsync, never a worker path), chunked `stageArtifact` with strict ordering and whole-file hash, acceptance binding toolchain/manifest/build key/staged bytes, artifact promoted before the single state transaction, `SOURCE_REJECTED` requiring a bounded sanitised diagnostic, idempotent replay of a published verdict, and GAME assignments shipping the compiled artifact for compile languages (a missing artifact refuses the game). Isolated suites: build acceptance 7, game acceptance 6, private-test acceptance 8; whole server package **64 files / 422 passed / 1 skipped**.
- **Security review:** an independent reviewer found nine issues. Fixed with regressions: anonymous dispute listing, hold-protected retention diagnostics being stripped, missing backup-freshness fences on finalize/reopen/disqualify/correct, `REJUDGE` writing a fabricated void instead of requesting a replay, the reconciler ignoring the deployment generation and completion fences, anonymous team-roster reads, hidden-map content gated per map instead of per version (migration 023 adds `map_versions.revealed_at`; the lock now reveals exactly the versions the tournament plays), and the login-IP throttle behind the reverse proxy (`OANTUTI_TRUSTED_PROXIES` gates `X-Forwarded-For`, and nginx forwards the client address), and lease reclamation outside the dev executor (the API now reclaims expired leases itself, so a dead worker no longer strands its job). Also fixed: `invalidateDownstream` could reopen a `FINALIZED` ledger (now refuses before mutating, with a regression), one-student-one-team-per-tournament is now enforced at enrollment (including inside a bulk preview) and when adding a member, the legacy self-registration endpoint is opt-in (`OANTUTI_LEGACY_API=1`), and slot accounting counts an `ACTIVE` attempt until reclamation expires it instead of until its lease timestamp passes. **Native build path delivered:** `packages/protocol/src/contracts/jobs.ts` freezes the build evidence and per-attempt path grants (inline source was a 1 MiB frame cliff), the server accepts build evidence with the artifact promoted before the state transaction, and the worker compiles/INIT-smokes inside the sandbox and stages the artifact back. Still open: the reviewer's design gaps (no proof the frozen bots produced the trace, structural-only off-host backup evidence, per-route reauth enforcement, legacy compatibility routes and their session store).
- **Web:** Monaco assets are served from `/monaco/vs` (self-hosted, lockfile-pinned); verified in a real browser that the editor mounts on the team submission page with every request staying on the host.
- **Completion evidence union:** `packages/protocol/src/contracts/jobs.ts` freezes `CompletionEvidence` as `GAME | TEST_GAME | BUILD` (03 §173) and nothing reads `ResultEvidence.details` any more. `JobBroker.prepareCompletion` takes the union; the native gateway returns tagged evidence from `accept` / `acceptPrivateTest` / `acceptBuild`; `ValidatedBuildResult` became a discriminated union, so "a READY build always carries an artifact and a rejection never does" is a type fact rather than a convention. The dev in-process executor pins `DEV_SOURCE_GATE` (source accepted or rejected, real digests, no artifact and no sandbox toolchain invented) instead of imitating a compiled build. The three native acceptance suites assert the pinned tag on READY/private/game completions.
- **Still open:** separate worker UID/cgroup/runsc provisioning with every real isolation canary, off-host backup custody and an authenticated checkpoint verifier, mixed-workload capacity measurement, the review items listed above, the 7-day rehearsal and human gate sign-off.
- **User decision:** the 72-hour soak is waived and is no longer a gate for this delivery; the 7-day rehearsal and the sign-off gates remain unless explicitly waived, and the waiver turns no unmeasured claim into a measured one.
