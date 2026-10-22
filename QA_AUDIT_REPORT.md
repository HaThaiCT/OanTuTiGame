# BÁO CÁO KIỂM THỬ UX/A11Y — OANTUTI ARENA

**Ngày:** 22/10/2026  
**Preview:** `http://127.0.0.1:14300` (Docker Compose, production web image)  
**Source workspace:** `/home/ha-thai/orca/workspaces/OanTuTi/develop-online-v2-2`, `develop/online-v2-2`, base `626429e2e6d5a76b0122cfd46fdde72a47816e4c`  
**Verdict:** **Incomplete** — source build/test pass; isolated browser smoke confirms rendered home/catalog/projector but has API proxy failure; official Docker preview still uses old image. Full workflow and post-fix authenticated smoke remain unverified.

## Phạm vi và phương pháp đã thực sự chạy

Browser exploration có tương tác trên guest home/catalog/tournament/live/replay/projector/team profile, cùng local FULL ADMIN trên organizer creation, maps, team management, tournament operations; light/dark toggle và reload; search; projector scroll; keyboard focus; axe-core 4.13.0; API result payload. Viewports đã quan sát: 1440×900, catalog 375×812.

Đây không phải kiểm thử toàn bộ hệ thống. Chưa hoàn thành toàn bộ route/element inventory, WCAG screen reader pass, stress matrix 768/1024/1280/1920, reduced-motion/i18n/offline matrix, ONLINE student end-to-end, concurrency, performance vitals, CI a11y gate, hoặc full suite.

## Finding đã xác minh trên preview trước sửa

| ID | Severity | Hành vi | Bằng chứng quan sát | Sửa trong source |
|---|---|---|---|---|
| QA-01 | High — WCAG contrast | Light theme header, semantic/rating colors, and colors interpolated during theme changes failed contrast on standard surfaces. | Before fix: axe serious contrast findings on catalog/detail/projector. Frame tracing showed header, action foreground/background, and rating-link colors transition independently. | Updated contrast palettes and removed color interpolation from theme-sensitive header, button and rating-link rules. Final image home toggle passes axe in both themes; populated detail passes axe. Rankings page still has one serious `color-contrast` finding on `.text-[#f5a524]`. Regression test checks all 11 ranks across 3 surfaces and rejects color/background/all transitions. |
| QA-02 | Medium — heading structure | Home `/` had no H1. | Before fix: axe `page-has-heading-one`; main contained H2s only. | Added semantic sr-only H1; final image home has H1 and axe 0 violations in both themes. |
| QA-03 | High — broken presentation | Bracket `Kết quả` navigated to raw JSON API. | Earlier connected image showed the raw endpoint response. | Final demo stack: result disclosure fetched HTTP 200, stayed on tournament route, expanded in-page result and exposed no raw API link. Detail axe 0, browser console 0, no failed API requests. |
| QA-04 | Medium — findability | Directory lacked state filters; newest-created-first order placed completed fixtures ahead of open/live events. | Before fix: 46 events, 12 pages; first page contained completed showcase events. Public API sorts `created_at DESC`; schema has no durable demo/curation marker. | Added status filters and actionable-first ordering without hiding events or applying name-based rules. Demo directory renders 46 events and page 1/12; previous connected filter smoke returned LIVE 7 and UPCOMING 3. |
| QA-05 | Medium — LAN organizer workflow | Global LAN Admin page lacked UI to add a member to an existing team while server endpoint already existed. | Organizer teams tab had no roster picker; Admin API/search existed. | Added LAN/global-admin-only roster panel with search, roster/account loading, member filter, cap and stale-response guard. No team mutation submitted; mutation acceptance remains unverified. |

## A11y, responsive và hành vi khác

- `:focus-visible` outline 2px được quan sát trên logo và link catalog; không phát hiện focus trap trong đoạn thử.
- Home/catalog không horizontal overflow ở 1440×900; `/tournaments` không overflow ở 375×812. Search nhập `SHOWCASE-30` cho đúng một giải.
- Theme lựa chọn tồn tại sau reload; lỗi tái hiện là header colors, không phải mất preference.
- Projector board dùng `position: fixed; inset: 0; overflow-y: auto`; document scroll vẫn bằng 0 sau scroll. Header global vẫn nằm phía trên overlay trên phiên Admin đã đăng nhập. Cáo buộc “header cuộn xuống theo trang” chưa được tái hiện; có thể còn vấn đề layering.
- Replay SVG piece có computed `transform-box:view-box`, `transform-origin:194px 194px`; hover smoke không đổi bounding box. Không đủ bằng chứng kết luận quân cờ “chắc chắn bị nhảy”.
- Console errors/warnings: 0 trong các browser interactions đã thu; không thấy 5xx trong request inventory. 401 `/api/v2/auth/me` ở guest là auth probe có chủ đích.
- Official replay guest/student bị từ chối là **policy có chủ ý**, không phải bug: docs/specs/v2/01 §5 và replay ACL tests yêu cầu FULL ADMIN; public live/result vẫn hoạt động, public result ẩn `replayDigest` với non-admin. Không mở quyền này.

## Các cáo buộc trong bản nháp cũ đã được kiểm tra lại

| Cáo buộc cũ | Kết quả đối chiếu |
|---|---|
| Không ẩn/xóa giải; archive draft bị lỗi | Không xác minh được yêu cầu delete/hidden. Archive được định nghĩa là retention-preserving transition, không phải purge; không thêm xóa dữ liệu. Draft public-list allegation chưa có trace đủ để khẳng định. |
| Replay chỉ Admin | Đây là override/policy hiện hành, có page/API/download authorization tests. Không sửa ACL. |
| Projector cần Admin-only | Contradicts UI spec: projector public read-only. Giữ public policy. |
| Projector header scroll theo nội dung | Fixed viewport container, document scroll không đổi; cáo buộc chưa tái hiện. Còn cần kiểm tra stacking/layering sau build. |
| Không có cấu hình Rated | Sai: `RatedControl` đã có trong tournament configuration khi DRAFT/PUBLISHED. Form create mặc định Unrated theo dev demo contract. |
| Không có CTA tham gia | ONLINE có `JoinWithCode` và `/workspace/join`; LAN ghi danh trực tiếp bởi Admin theo PR §3. Trang public detail có thể thiếu next-action guidance trong một số state nhưng chưa được chứng minh là thiếu join path theo cả profile. |
| Thiếu thành viên đội | ONLINE workspace đã mời/xóa/chuyển captain; LAN server có Admin add-member API nhưng UI thiếu. QA-05 thêm đúng control LAN. |
| Private test thiếu IDE | Private test form nhận ZIP; nhưng product requirement chốt web IDE cho submission và server-only safe execution, không bắt buộc Monaco trong test. Không thêm editor/test execution trong browser. |
| Replay thiếu keyboard/speed | Sai: ReplayViewer có ArrowLeft/ArrowRight/Space, playback speed 0.5/1/2/4. |
| Map editor thiếu undo/confirm | Code hiện có clearGrid không confirm; đây là rủi ro UX hợp lý nhưng report gộp thêm undo là feature mới và chưa được xác nhận/sửa trong phạm vi. Ghi nhận deferred, không tự thêm undo. |
| Rankings thiếu search | Hiện global leaderboard phân trang bounded 50/trang, cursor. Search toàn dataset là feature gap/spec delta vì API không cung cấp query search; không filter sai trên trang hiện tại. |
| Tab organizer cần bỏ overview | Existing tabs đáp ứng các route/operations; chưa có quyết định UX mới được chấp thuận cho bỏ tab. Không thay IA. |
| Tạo giải cần Rated checkbox | Không thêm checkbox; `RatedControl` là flow cấu hình có sẵn trước registration. |
| Account LAN chỉ ONLINE | ONLINE account panel phân tách theo profile là đúng scope hiện tại; chưa có bằng chứng LAN password-management acceptance contract bị thiếu. |

## Deferred product/contract gaps requiring a separate decision

- **Public join guidance (LAN_OFFLINE):** anonymous `/tournaments/fa4ca04e-b412-4ca7-b718-e7b93e028119` visibly reports `ĐANG MỞ ĐĂNG KÝ` but contains no join/action guidance; auth profile probe confirms `LAN_OFFLINE`. LAN policy assigns direct enrollment to Admin (PR §3), so the safe UI response is likely “liên hệ ban tổ chức,” not a new student self-service endpoint. Confirm copy and whether an Admin contact/CTA is wanted before implementing.
- **Global rankings search:** UI currently fetches bounded cursor pages (`limit`, `cursor`); server contract exposes no search term. Client-only filtering would search only loaded rows and mislead a user that the result covers the global ranking. Requires a server search contract/design decision.
- **Organizer DQ picker:** report alleges manual team UUID entry. No complete verification of this control was done in the live pass; not a confirmed finding here.
- **Map-editor destructive recovery:** `clearGrid()` clears immediately with no confirm/undo; report’s undo request is feature scope beyond a minimal error-prevention fix. Needs a separate interaction/design decision.

## Source changes và kiểm thử

- Public match result summary panel; API public result summary uses safe fields only; strict parser rejects missing/null/inconsistent outcomes.
- Directory filters ALL/LIVE/UPCOMING/ENDED and stable actionable-first ordering; home spotlight/featured shelf excludes finalized/archived/cancelled, with all historical tournaments still present in the catalog. Tests cover filter/order and item retention.
- LAN global organizer roster assignment panel, visible only when `accountsScope && authProfile === 'LAN_OFFLINE'`; loading/error/empty states, account filtering, capacity and stale-response guards. Server remains authoritative.

### Targeted regression command

```text
npx vitest run packages/web/app/organizer/LanRosterAssignment.test.ts packages/web/app/organizer/roster-state.test.ts packages/web/lib/roster-assignment.test.ts packages/web/lib/homepage-tournaments.test.ts packages/web/lib/tournament-catalog.test.ts packages/web/lib/public-game-result.test.ts packages/web/lib/theme-tokens.test.ts 'packages/web/app/tournaments/[id]/MatchResultPanel.test.ts'
```

**Observed:** 8 test files, 23 tests passed. Tests cover roster role/load/capacity/stale-request handling; account filtering; home spotlight excluding completed events; catalog state/format/search/order and record retention; public result normalization including null/inconsistent fields; CSS contrast for all rating ranks; and no theme-sensitive color transitions. The transition test failed first on `.arena-header { transition: all ... }`, then passed after limiting animations to non-color properties.

**Build:** `npm run build` in `packages/web` exited 0. The final-source web image, isolated PostgreSQL demo, API, TLS proxy and local mail sink run on separate demo resources. Demo Postgres is initialized from the repository's portable SQL/object bundles (46 tournaments, 72 teams) on volume `oantuti-demo-20261022-postgres-data`, schema migrated to v29 for Online identity; no old database/storage volumes were mounted or modified.

**Browser/API smoke (isolated demo):** Data-backed home, directory, rankings, completed tournament detail and result disclosure were verified. `/api/v2/auth/profile` returns `ONLINE`; registration UI loads at both HTTPS loopback URLs. With matching Origin and browser `Sec-Fetch-Site: cross-site`, exact loopback aliases pass to validation (400 for invalid input); unrelated external Origin remains 403. UI distinguishes origin refusal from ADMIN permissions. Config/client tests 7/7; identity 9/9; origin 13/13; server typecheck and web production build pass. Fixed the sign-in bounce: local demo login issued a valid session, but `authenticateToken` still enforced `email_verified_at` at `/auth/me`, which discarded it. The same validated local-demo-only flag now controls both signup/login and session validation; regular Online still enforces verified email. After rebuilding/restarting the isolated API, `system_admin` and `demo_cap1` each logged in (200) and immediately fetched `/auth/me` (200) with same identity, FULL scope, and Online profile. `/workspace` returns 200. No legacy DB/container was changed. Rankings still has one axe serious contrast issue on `.text-[#f5a524]`.

**Local Online demo:** Open `https://localhost:14443/register`, or `/workspace` then `Đăng ký`. Accept the private local certificate warning only for this localhost demo. Registration creates a verified student and allows immediate login, without sending or queuing verification email. This is a development-only setting, rejected for production/public origins; later deployed Online keeps email verification. A prior test user `online_demo_mvjd3c8t` remains pending with one local Mailpit message from the earlier email-enabled run; no token was consumed. Original database/API containers and volumes remain untouched.

**Public Online deployment:** Not performed. No target host/domain/TLS/mail operator config is provided; no SSH deploy host, GitHub environment, deployment record or deploy secrets were found. Do not expose this local demo or public fixture credentials to the Internet. G0–G4/U5 commissioning is outside this local smoke.

## Remaining coverage / release caveat

## Đợt kiểm thử tái thiết kế UX theo giải đấu & QA toàn diện (22/10/2026)

### 1. Phạm vi tính năng & Kiến trúc đã triển khai

| Hạng mục | Hiện trạng & Giải pháp triển khai | Kết quả kiểm thử thực tế |
|---|---|---|
| **Rating khởi đầu 0 & không màu** | Đội chưa thi đấu (`rating === null` hoặc `ratedContests === 0`) hiển thị số `0` với màu trung tính (`var(--text-primary)`), không gắn badge phân hạng màu. Bảng xếp hạng toàn cục chỉ hiển thị đội đã có giải tính rating. Đã sửa lỗi tương phản WCAG hạng 2 (`#f5a524` -> `var(--warning-text)`). | Unit test `theme-tokens.test.ts` 5/5 pass. Trình duyệt thực tế hiển thị số `0` trung tính, không lỗi màu sắc. |
| **Migration 031 & API News / Bot mẫu** | Bổ sung bảng `news_posts` và `starter_bot_templates` trong migration `031-tournament-centered-content.sql`. Nâng `EXPECTED_SCHEMA_VERSION = 31`. Xây dựng `ContentService` và `registerContentRoutes`. | Đã chạy migration trên PostgreSQL test và demo. Schema test pass. API GET/POST tin tức và bot mẫu hoạt động chuẩn xác. |
| **Bản tin Trang chủ phong cách Codeforces** | Tái cấu trúc trang chủ: Bản tin & Thông báo trở thành cột chính trung tâm với `MarkdownRenderer` tự động format tiêu đề, trích dẫn, danh sách gạch đầu dòng, khối code, đoạn văn bản. Các khối giải đấu tiêu điểm, giải đấu sắp tới, xếp hạng Top 8 và trận đấu chuyển sang sidebar bên phải. | Trình duyệt chụp ảnh màn hình xác nhận: Trang chủ có diện mạo hiện đại chuẩn Codeforces, font chữ thoáng, đọc bài viết mượt mà không lỗi escape `\n`. |
| **IDE cho Test riêng tư** | Tách `SourceIde` thành component dùng chung hỗ trợ Monaco Editor cho cả 3 ngôn ngữ (Python, TypeScript, C++20). Nhúng trực tiếp vào `PrivateTestPanel` với 2 chế độ: Tải file .zip hoặc Soạn mã trực tiếp. Gửi yêu cầu qua `POST /api/v2/tournaments/:id/private-tests` không ảnh hưởng bảng điểm chính thức. | TypeScript typecheck 0 lỗi. Giao diện tab chuyển đổi mượt mà, lưu nháp riêng biệt theo ngữ cảnh test. |
| **Trung tâm giải đấu (Tournament Hub)** | Tái cấu trúc `/tournaments/[id]` thành Hub duy nhất với hệ thống tab: Tổng quan, Đội thi đấu, Đăng ký tham gia, Bài nộp & Test, Bot mẫu & Chạy local, Điều hành (cho ADMIN). Thí sinh tạo đội, mời thành viên, đăng ký dự thi, nộp bài và test riêng tư ngay tại trang giải mà không cần nhảy sang `/workspace`. Sửa lỗi tiêu đề trên mobile 390px không còn bị ép thành cột hẹp 6 dòng. | Đã xác minh trên mobile 390px và desktop 1440px. Tiêu đề dàn hàng ngang 100% full-width, tabs chuyển đổi qua URL `?tab=` giữ nguyên ngữ cảnh. |
| **Điều hành giải tập trung (All-in-one Console)** | Tái thiết kế `OrganizerConsole` và `/organizer/tournaments/[id]`: gom 5 tab rời rạc thành một màn hình điều hành duy nhất với thanh điều hướng neo dính (Sticky Anchors: `#overview`, `#configuration`, `#entries`, `#adjudication`, `#starter-bots`). Giữ nguyên các chốt an toàn `expectedVersion`, idempotency key, và xác thực mật khẩu `reauth`. | ADMIN quan sát và điều hành toàn bộ giải đấu từ một trang duy nhất. Thêm tab Bản tin trong quản trị hệ thống. |
| **Tải Bot mẫu & Kiểm thử Local** | Ban tổ chức upload gói bot mẫu qua console. Thí sinh tải file zip trực tiếp từ tab "Bot mẫu & Chạy local". | Đã tải file zip `official-python-starter.zip`, giải nén và chạy kiểm thử đối đầu trực tiếp trên máy bằng CLI `npm run match:play` — hoàn thành 10 lượt đấu, bắt quân hợp lệ và lưu file replay `test-match.oantuti`. |
| **Điều hướng an toàn `safeReturnTo`** | Rehome `/workspace` thành cổng đăng nhập chuyên dụng kèm kiểm tra `safeReturnTo` chống Open Redirect. Khi đăng nhập thành công, tự động quay trở lại đúng trang giải đấu ban đầu. Sửa nút xem replay trận đấu gần đây ở trang chủ để khách không bị rơi vào lỗi 401. Trang `/account` có màn hình chào đón và hướng dẫn đăng nhập thay vì báo lỗi thô. | Khách vãng lai bấm đăng nhập từ giải đấu -> đăng nhập thành công -> quay trở lại đúng trang giải đấu. |

### 2. Kết quả kiểm thử tự động (Test Suites)

- **Packages Web Unit Tests:** 11 files, 35 tests passed.
- **Server Content & Journey Tests:** `content-service.test.ts`, `schema-version.test.ts`, `e2e-user-journeys.test.ts` 7/7 tests passed.
- **TypeScript Compilation:** `packages/protocol`, `packages/server`, `packages/web` biên dịch đạt 0 lỗi (0 diagnostics).
- **Production Build:** `npm run build --workspace=@oantuti/web` và Docker image `oantuti-qa-20261022-web-updated:local`, `oantuti-online-v2-server:local` dựng thành công 100%.
- **Live Browser Verification:** Đã chụp ảnh màn hình và xác minh trực quan trên cả desktop 1440px và mobile 390px, chế độ sáng và chế độ tối.

### 3. Kết luận đợt tái thiết kế

Tất cả 7 mục tiêu chính của người dùng đã được thực thi và nghiệm thu thực tế:
1. Rating khởi đầu 0 hiển thị màu trung tính cho đội chưa thi đấu, giữ nguyên lịch sử và bảng xếp hạng đội rated.
2. Migration 031 bổ sung bảng `news_posts` và `starter_bot_templates`, nâng schema lên 31.
3. Bản tin trang chủ phong cách Codeforces hiển thị bài viết nổi bật ở cột chính với MarkdownRenderer hoàn chỉnh.
4. Trình soạn thảo Monaco IDE tích hợp trực tiếp vào mục Test riêng tư, chạy qua worker sandbox an toàn.
5. Giao diện Giải đấu `/tournaments/[id]` trở thành trung tâm điều hướng duy nhất, sửa lỗi co nghẽn mobile 390px.
6. Trang điều hành của Ban tổ chức gom toàn bộ 5 nhóm chức năng vào một màn hình duy nhất với neo dính sticky.
7. Tải và kiểm thử bot mẫu local thành công với CLI `npm run match:play`.