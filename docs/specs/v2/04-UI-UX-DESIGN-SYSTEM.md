# 04 — UI/UX và design system OanTuTi Arena v2

> **Baseline UI/UX đã chốt hướng thiết kế; chưa triển khai.** Tài liệu không phải mockup/browser chạy được hoặc bằng chứng nghiệm thu. Usability/performance là targets phải kiểm trong T8–T12; palette/library choice không tự chứng nhận accessibility.
> Yêu cầu gốc: [01 — Product requirements](01-PRODUCT-REQUIREMENTS.md). Quy tắc thi đấu và trạng thái domain do [02 — Gameplay & Tournament](02-GAMEPLAY-TOURNAMENT-RULES.md) quyết định; contract API/data do [03 — Architecture & Data Contracts](03-ARCHITECTURE-DATA-CONTRACTS.md) quyết định. Nhãn UI không được tạo state machine cạnh tranh với server.
> **UX override 2026-10-18:** core UX theo role được ưu tiên: guest chỉ public view; STUDENT thấy danh sách giải tham gia gọn và workspace riêng đội–giải với Tổng quan/Bài nộp/Test riêng tư/Kháng nghị; ADMIN có danh sách quản lý và console một giải riêng. Navigation Ban tổ chức/Replay chỉ FULL ADMIN; official replay không public. Private TEST viewer vẫn chỉ đội mình, không ADMIN. Giữ visual game-arena.ai; không app desktop/mobile. Xem kế hoạch `../../superpowers/plans/2026-10-18-core-role-ux-first.md`.

## 1. Quyết định thiết kế và cơ sở hiện trạng

**Định hướng đã chốt: gaming/esports dark-first, đẹp là yêu cầu sản phẩm, không phát sinh chi phí template.** Cổng thi học thuật tập trung giải, đội, bài nộp, lịch và kết quả. Visual esports phục vụ trải nghiệm nhưng không đánh đổi rõ tác vụ và khả năng đọc. FACEIT/Toornament/Overworld là nguồn thiết kế và code có thể tái sử dụng: người dùng xác nhận đã xin được sự đồng ý của các bên đã nêu. Đây là xác nhận của chủ sản phẩm, không phải giấy phép đã được assistant kiểm chứng. Quyền sao chép code không tự bao gồm ảnh/logo/font hoặc dependency bên thứ ba; ghi provenance và phạm vi cho phần thực tế dùng. [Research](../../research/2026-10-14-esports-ui-template-options.md).

- **Dark là theme mặc định toàn sản phẩm** (public, workspace, IDE/viewer, trình chiếu); light mode là tùy chọn phụ cùng token hierarchy, không phải sản phẩm thứ hai. Màn chiếu lớp học ưu tiên dark tương phản cao, chữ/tỉ số cỡ lớn theo kiểu matchroom esports.
- Accent chính violet, phụ cyan; cam dành cho điểm nhấn trận trực tiếp theo palette §4.1. Đây là lựa chọn thiết kế của người viết theo hướng đã duyệt, không lấy màu từ screenshot. Tên hai đội, biểu tượng quân và viền phe xác định trận; trắng/đen không mang nghĩa thành công/thất bại, không chỉ dựa vào màu để đọc R/P/S.
- Landing không tự mở trận sample. Tutorial có nhãn **“Ví dụ minh họa — không tính điểm”**, truy cập tự nguyện, độc lập giải thật.
- Tách “Đã lưu nháp”, “Đã nhận bài”, “Bot hợp lệ dự kiến tự chọn”, “Đã khóa”. Không nút chọn thi; READY bản mới nhất tự thay candidate, chưa frozen.
- Không panel 460px chứa cả standings và IDE; không wizard dài trong modal; không confetti hoặc intro chặn tác vụ.

### 1.1. Bằng chứng giới hạn hiện tại

Audit đọc tĩnh `packages/web` và quan sát browser do Main cung cấp, không chạy lại:

| Hiện trạng có nguồn | Hệ quả đối với v2 |
|---|---|
| `packages/web/src/App.tsx:21-58,280-295,374-407`: sample tại landing, tab state trong component, sidebar 460px | Cần route/deep link và workspace riêng, không mở rộng sidebar thành cổng giải |
| `components/BotEditor.tsx:14-35,81-112`: draft trong state; save và test source; App key IDE theo user | Giữ Monaco/ba ngôn ngữ nhưng thiết kế receipt, job history, bảo toàn draft và recovery; mất draft khi remount là rủi ro suy luận từ source |
| `App.tsx:171-205`: live callbacks đổi playback, lỗi chỉ console | Cần độc lập connection, playback, execution, publication; pause của người xem không bị delta bật lại |
| Main quan sát 1440×1000: BLACK WINS ở turn 0; leaderboard hẹp; guest được hướng dẫn Create nhưng không có nút | Mỗi màn hình/empty state theo quyền; trạng thái kết quả khác trạng thái frame đang xem |
| Main quan sát 390×844: board không thấy, header bị cắt dù scrollWidth=390 | Gate responsive phải kiểm visibility và tương tác; “không tràn ngang” không đủ |

Nguồn audit: `history://WebAudit`, bổ sung `agent://WebAudit`; source paths ở trên tương đối với repository. Các design cũ trong `docs/specs/06-UI-UX-VISUALIZER-SPEC.md` là lịch sử đối với publication theo projection, local test runner và layout. Không dùng tuyên bố FPS/test-count cũ để công nhận production.

## 2. Template và nguồn chính thức

### 2.1. Lựa chọn đã duyệt

**Chọn shadcn/ui official Blocks: dashboard-01 cho khung organizer/team, sidebar-07 cho navigation thu gọn; public dùng header/content cùng component language.** Chỉ mượn shell/table/form/dialog/tabs, bỏ demo revenue/data. Web canonical là **Next.js/React** theo03 sau đánh giá stack độc lập, không đổi framework chỉ vì template. Public HTML/metadata SSR, Canvas/editor client; private no-store. Không giữ Viteportal song song.

| Phương án | Phù hợp và đánh đổi | Quyết định |
|---|---|---|
| shadcn/ui Blocks | Code được copy vào repo; nhóm sở hữu review/update và kiểm accessibility, không có bảo đảm AA tự động | Đã chọn cùng Tailwind; pin snapshot khi implementation, một bộ component duy nhất |
| Tabler open-source admin template | Có shell/tables/forms, light/dark, dựa Bootstrap 5; MIT cho core. Mang thêm convention CSS/Bootstrap không có sẵn trong frontend | Tham khảo density/hierarchy; không trộn Bootstrap với foundation đã chọn |
| Tự vẽ mọi primitive | Không chi phí template nhưng phải tự chịu focus, dialog, menu, form và accessibility regressions | Chỉ thiết kế riêng board/bracket/domain components; không viết lại primitive vô cớ |

**Nguồn esports miễn phí đã research (2026-10-14, [chi tiết](../../research/2026-10-14-esports-ui-template-options.md)):**

| Nguồn | License | Dùng thế nào |
|---|---|---|
| [brackets-viewer.js](https://github.com/Drarig29/brackets-viewer.js) | MIT, 231 stars, còn maintain | Renderer bracket round-robin/single/double elimination, nhúng vào Next.js, theme dark theo token; Swiss tự render bảng xếp hạng |
| [bracketry](https://github.com/sbachinin/bracketry) | MIT, ít tính năng hơn | Không chọn; không tích hợp renderer thứ hai trong phạm vi hiện tại |
| [BEKO Master](https://github.com/rjksharma/beko_master) | License công khai chưa rõ; người dùng xác nhận đã xin phép các bên đã nêu | Có thể tái sử dụng code trong phạm vi sự đồng ý; không tự đổi nền component đã chọn |
| FACEIT / Toornament / Overworld / Youplay | Người dùng xác nhận đã được đồng ý sao chép code | Được copy/adapt code giao diện được cho phép; không suy quyền với ảnh/logo/font/dependency bên thứ ba |
| g-loot/react-tournament-brackets | LGPL-2.1 | Không chọn; copyleft cần review riêng nếu sử dụng, không coi LGPL là license không hợp lệ |

**Nền đã chọn: shadcn/ui + Tailwind, brackets-viewer.js; được sao chép/adapt code giao diện từ các nguồn đã được cho phép.** Không mua template hoặc đưa WordPress/Bootstrap thành nền thứ hai; port phần cần thiết vào component React/Tailwind cùng design system. Ghi nguồn/phiên bản/file và phạm vi cho phép; giữ notices áp dụng. Bracket chỉ trình bày official DTO, không tính pairing/điểm/advance; client-only, dispose khi đổi giải/unmount, không DOM trong SSR. Swiss/Elo có standings/match list; keyboard/mobile/screen reader có danh sách tương đương. Pin phiên bản và kiểm các trạng thái bye/forfeit/void/correction/EMPTY theo02; không đổi luật giải để phù hợp library.

Nguồn chính thức đã đọc ngày 2026-10-13:

1. [shadcn/ui introduction](https://ui.shadcn.com/docs): phân phối component code, không phải thư viện đóng; [official Blocks](https://ui.shadcn.com/blocks): `dashboard-01`, `sidebar-07`, open-source blocks.
2. [shadcn/ui MIT LICENSE](https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md): cho phép dùng/sửa/phân phối; phải giữ copyright và permission notice trong bản sao/phần đáng kể; không có warranty.
3. [Tabler official admin template](https://tabler.io/admin-template): core open-source MIT, Bootstrap 5, layout sáng/tối; **không suy MIT cho Pro, illustrations, email templates hoặc bundle trả phí**.
4. [Inter official distribution](https://rsms.me/inter/): free/open source, link [SIL OFL 1.1 của Inter](https://raw.githubusercontent.com/rsms/inter/v4.1/LICENSE.txt). Khi phân phối font giữ license; font sửa đổi phải tuân thủ điều kiện tên reserved trong license tương ứng.
5. Chuẩn nghiệm thu accessibility: [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Endpoint W3C trả HTTP 403 trong phiên nghiên cứu, do đó không coi lần fetch này là kiểm chứng từng clause; gate implementation phải dùng bản chuẩn truy cập được và review thủ công.

MIT không chứng minh an toàn, responsive hay production-ready. Gate asset/legal: kiểm LICENSE của **snapshot và từng dependency thực sự sử dụng**, giữ notices trong distribution, lập inventory; không dùng screenshot/icon thương mại ngoài quyền. Giữ icon set hiện có nếu hợp lệ, một stroke style; tránh thêm font/icon chỉ để tạo thương hiệu. Font, editor assets và component styles phải self-host trong deployment trường, không cần Google Fonts/Monaco CDN cho hành trình cốt lõi.

## 3. Information architecture và quyền

### 3.1. Routes canonical đề xuất

`:id` là UUID ổn định; slug/tên chỉ để đọc. Các route là contract UX đề xuất, không khẳng định router hiện có. Mọi deep link mở trực tiếp/reload/back được. Query phản ánh state chia sẻ, không chứa token/session/source.

| Không gian | Route | Nội dung/chính sách |
|---|---|---|
| Khách | `/`, `/tournaments` | Directory public, giải đang diễn ra/sắp mở/đã lưu trữ, tìm theo tên/học phần |
| Khách | `/tournaments/:id` | Overview: status, lịch, thông báo, next action, trận nổi bật |
| Khách | `/tournaments/:id/rules`, `/schedule`, `/announcements` | Luật revision/map/runtime, lịch timezone, cập nhật có timestamp |
| Khách | `/tournaments/:id/standings`, `/bracket`, `/matches` | Xếp hạng hoặc nhánh theo format, danh sách trận có filter |
| Khách | `/teams/:teamId` | Tên/slug/avatar an toàn/thành tích; thành viên chỉ từng người opt-in |
| Khách | `/matches/:matchId`, `/matches/:matchId/replay` | Official live/detail/replay; provenance công khai, không stdout/source |
| Khách | `/learn`, `/learn/tutorial` | Luật RPS + mục tiêu thắng + SDK và replay minh họa có nhãn sample |
| Danh tính | `/sign-in`, `/account/security`; ONLINE thêm `/sign-up`, `/verify-email`, `/forgot-password`, `/reset-password`; LAN Admin `/organizer/accounts` | ONLINE email verify/recovery; LAN username/password cấp bởi Admin, không signup/emailwall, Admin reset riêng; public không login |
| Đội | `/workspace` | Đội theo giải, hạn sắp tới, entry cần hành động, inbox |
| Đội | `/workspace/teams/:teamId`, `/members` | Tạo đội, invitations, roster, chuyển captain; quyền đúng PR §2 |
| Đội | `/workspace/teams/:teamId/tournaments/:id` | Đăng ký → nộp/kiểm tra → candidate tự động → khóa → theo dõi |
| Đội |route trên+`/bots`,`/editor`,`/submissions`,`/submissions/:submissionId`,`/tests`,`/tests/:testId`,`/disputes`|Project IDE/upload, officialreceipts và private testviewer/jobhistory; khôngpracticeleaderboard|
| Tổ chức | `/organizer`, `/organizer/tournaments/new` | MộtADMIN quản lý mọi giải, không assignment ACL |
| Tổ chức | `/organizer/tournaments/:id` + `/settings`, `/entries`, `/rounds`, `/jobs`, `/incidents`, `/disputes`, `/announcements`, `/audit` | ADMIN đọc source/log bài đã nộp mọi đội read-only/audit, không draft/test chưa nộp; không sửa code/frozenBot |
| Trình chiếu | `/tournaments/:id/project`, `/matches/:matchId/project` | Public read-only presentation; điều khiển viewer cục bộ, không quyền commit điểm |

Private draft/source/log/testviewer/replay không metadata/cache/publicdiscovery. Teamtests cần membership/admission, guest và đội khác denied quaHTTP/WS/storage/download; không login token trongshareURL. Khôngpracticeportal riêng.

### 3.2. Navigation

- Public header: logo → Giải đấu, Hướng dẫn; tìm giải; theme; Đăng nhập hoặc Workspace. Tournament subnav: Tổng quan, Luật, Lịch, Xếp hạng, Nhánh đấu (khi áp dụng), Trận, Thông báo.
- Team shell: chọn đội/giải, Tổng quan, Bot/IDE, Chạy thử riêng tư, Bài nộp, Lịch/kết quả, Thành viên, Khiếu nại, Xem public. Không practiceportal/leaderboard; LAN roster doAdminquản lý, ONLINE selfteam theo01. Không đổi scope âm thầm khi notification.
- MộtADMIN quản lý mọi giải: Giải/Đội/Vòng/Jobs/Sự cố/Khiếu nại/Thông báo/Cấu hình/Audit và source/log read-only. ONLINE verifiedemail/password, LAN LOCAL_BOOTSTRAP/password khôngSMTP; khôngMFA. Action nhạy cảm re-auth/impactconfirm/audit, creatorfilter khôngACL.
- Breadcrumb chỉ 2–4 tầng, title H1 độc lập. Không đưa mọi mục vào hamburger desktop. Mobile drawer có focus trap, đóng về trigger, active route được công bố bằng semantics.
- URL query dùng `stage`, `round`, `team`, `status`, `q`, `sort`, `page`, `pageSize`, `turn`. Đổi filter reset page; Back phục hồi filter và vị trí; share link giữ turn. Tìm kiếm input không cập nhật history mỗi ký tự.

## 4. Hệ thống thị giác và tokens

Mọi value dưới đây là default bắt buộc cho thiết kế ban đầu; contrast còn phải đo trên component thực tế. Không chọn màu bằng ảnh screenshot template.

### 4.1. Color tokens

| Token | Dark — mặc định | Light — tùy chọn | Dùng |
|---|---|---|---|
| canvas | `#0B0D17` | `#F8FAFC` | nền trang |
| surface | `#151827` | `#FFFFFF` | card/dialog/table |
| surface-subtle | `#22263A` | `#F1F5F9` | section/hover |
| text-primary | `#F8FAFC` | `#0F172A` | body/title |
| text-secondary | `#C4C9DC` | `#475569` | metadata |
| border-subtle | `#3C435C` | `#CBD5E1` | phân vùng, không dùng làm text |
| border-control | `#8792B0` | `#64748B` | input/control edge |
| action | `#C4B5FD` | `#6D28D9` | violet; dark filled text `#0B0D17`, light filled text trắng |
| action-hover | `#DDD6FE` | `#5B21B6` | hover button/link |
| accent-secondary | `#67E8F9` | `#0E7490` | cyan; link phụ, detail chart có legend |
| live-accent | `#FDBA74` | `#9A3412` | cam; badge LIVE có chữ, không thay màu cảnh báo |
| focus | `#67E8F9` | `#0E7490` | ring 3px, offset 2px; kiểm nền thực tế |
| success-text / tint | `#BBF7D0` / `#14532D` | `#166534` / `#F0FDF4` | READY/finalized với icon và chữ |
| warning-text / tint | `#FDE68A` / `#451A03` | `#92400E` / `#FFFBEB` | gần hạn, provisional, lag |
| danger-text / tint | `#FECACA` / `#450A0A` | `#991B1B` / `#FEF2F2` | lỗi/hậu quả nghiêm trọng |
| info-text / tint | `#BFDBFE` / `#172554` | `#1E40AF` / `#EFF6FF` | thông báo/queued |
| board-bg / tile | `#0B1220` / `#243247` | cùng dark | board nền tối ổn định, legend riêng |
| side-A / side-B | `#F8FAFC` / `#111827` | cùng dark | quân outline tương phản, nhãn A/B, không đồng nghĩa status |

Selected row: surface-subtle + viền action + nhãn selection, không màu đơn lẻ. Disabled có label/reason ngoài tooltip, không giảm opacity cả đoạn text tới mất đọc. Chart/status dùng shape/pattern và legend; không red/green-only. Badge luôn chữ cụ thể: “Chờ biên dịch”, không chỉ chấm vàng.

**Ngôn ngữ esports:** directory dùng hero giải nổi bật và card trạng thái/đăng ký; trang giải ưu tiên tab Tổng quan/Vòng đấu/Trận/Đội/Luật cùng route canonical §3. Matchroom đặt tên/avatar hai đội, tỉ số khổ lớn, nhãn LIVE/PROVISIONAL/FINAL và phiên bản kết quả phía trên board; thắng ở kết quả cuối không bị hiểu là trạng thái frame replay đang xem. Hero gradient violet→cyan chỉ trang trí, có lớp nền đặc dưới chữ; glow không dùng quanh body text/IDE/table. Artwork OanTuTi tự tạo hoặc nguồn có license riêng rõ ràng, không dùng ảnh game/logo trong demo tham khảo. Organizer giữ cùng palette nhưng giảm artwork để ưu tiên tác vụ và incidents.

### 4.2. Typography, layout, interaction

| Nhóm | Default |
|---|---|
| UI font | Inter self-host WOFF2, fallback `system-ui, sans-serif`; weight 400 body, 500 control, 600 heading, 700 emphasis. Kiểm glyph tiếng Việt/NFC và dấu ở line-height thật |
| Code font | `ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace`; không thêm font code tải ngoài; ligatures tắt mặc định |
| Type scale | caption 12/18px; label/table 14/20px; body 16/24px; H3 20/28px; H2 24/32px; H1 32/40px; mobile H1 28/36px; IDE 14/22px. Hero desktop 56/64px, mobile 32/40px, weight 800; không uppercase chuỗi tiếng Việt dài |
| Numbers | tabular numerals cho rank/điểm/clock; match score desktop 48/56px, mobile 32/40px, projector 72/80px; tên đội luôn đi cùng tỉ số. Timestamp không chỉ relative; checksum monospace, rút gọn 12 ký tự + Copy full |
| Spacing | thang 4px: 4, 8, 12, 16, 24, 32, 48, 64. Form group gap 16; section gap 24; page gutter 32 desktop/24 tablet/16 mobile |
| Density | control cao 44px; desktop table row 48px; mobile row/card tối thiểu 64px; editor toolbar wrap, không thu control dưới target |
| Shape | radius 6px control, 8px card, 12px dialog; border 1px; shadow chỉ popover/dialog (`0 8px 24px`, black 12% light/30% dark) |
| Shell | header 64px; sidebar 240px (icon collapsed 64px); max content 1440px, form max 760px; viewer/IDE có thể full width; z-order base 0, sticky 10, popover 30, dialog 40, toast 50 |
| Motion | hover/focus 120ms, panel/dialog 160ms, board move 180ms, ease-out; không auto celebration/shake; reduced-motion → transition 0ms, board instant, không particles/confetti |
| Sound | muted mặc định; bật rõ bằng control có pressed state; lưu preference theo thiết bị; không autoplay audio hoặc dùng âm thanh làm feedback duy nhất |

Thay theme giữ draft, cursor, filters. Theme không thay phe hoặc ý nghĩa màu status. Skeleton cho initial load, không giả dữ liệu/rank. Pending action có nhãn và spinner nhưng giữ chiều rộng, không đổi layout liên tục. Toast chỉ bổ sung; receipt/errors tồn tại trên page.

## 5. Screen hierarchy và luồng public

### 5.1. Directory và overview

Directory hierarchy: H1 “Giải đấu” → tabs Đang diễn ra/Sắp tới/Đã kết thúc → search/học phần/date filter → danh sách. Card chỉ tên giải, thể thức, trạng thái, thời gian có timezone, số đội đã hợp lệ, CTA “Xem giải”. Empty guest: “Chưa có giải được công bố” + Hướng dẫn; không “Bấm Create”. Lỗi tải có Retry và mã hỗ trợ, không chuyển thành empty.

Overview hiển thị timeline và state canonical DRAFT/PUBLISHED/REGISTRATION_OPEN/VALIDATING_SUBMISSIONS/LOCKED/READY_TO_START/RUNNING/PAUSED/PROVISIONAL/FINALIZED/ARCHIVED/CANCELLED. READY_TO_START ghi “Sẵn sàng — chờ Admin bắt đầu”, không scheduled countdown tự chạy. Validation drain không là đã khóa; public khách thấy trạng thái nhưng không start control. Baseline duration, planned start và actual start/ETA tách rõ; chưa có kết quả không dùng sample giả.

Khách CTA “Xem xếp hạng/Xem trận”; người chưa đội CTA đăng nhập để tham gia nhưng không chặn phần public; đã có đội CTA “Đến bài nộp”. Closed registration nói rõ đóng lúc nào, không nút Join disabled vô nghĩa. Archived giữ rules/result/replay theo retention đã công bố; replay hết retention hiện lý do, kết quả không bị mất theo file.

### 5.2. Standings 500 đội

Trang toàn chiều rộng, không sidebar. H1 + format/stage + “Tạm tính/Đã chốt” + cập nhật lúc X (timezone) → search team → vòng/stage/status → bảng → pagination. Default thứ tự rank chính thức do server tính. Cho sort cột phân tích nhưng ghi **“Sắp xếp theo X — hạng chính thức không thay đổi”**; không tính rank/tie-break tại client.

- Default 50 dòng/trang, lựa chọn 25/50/100, tổng 500 và “1–50/500”; jump page/rank, đầu/cuối, tìm đội hoặc “Đội của tôi” nếu authenticated. Search kiểm trên toàn dataset, không chỉ trang hiện tại; normalize tiếng Việt/slug theo contract search.
- Columns nền tảng: Hạng, Đội (link), Đã đấu, Thắng–Hòa–Thua, Điểm, tie-break theo format, Trạng thái. Tie-break có mô tả/rules revision, tooltip không là nguồn duy nhất. Shared rank đồng hạng ghi “=12”; không làm unique rank giả bằng sort alphabet.
- Swiss: points và thứ tự tie-break đúng spec 02; cutoff + “qualification provisional” trước seal. Round robin: points/head-to-head/tie-break được định nghĩa; không mặc định vẽ matrix 500×500. Elo: rating, games/eligibility/window và epoch; **rating chỉ đổi khi epoch SEALED**, còn game/encounter provisional được public ngay và hiển thị riêng, không animate rating theo tốc độ worker. Không gọi Elo là tournament points. Elimination: standings kết quả cuối/placement nếu luật có; bracket là primary, không tự bịa rank đội đã bị loại.
- Refresh giữ focus/scroll/page/selected team. Rank biến động không animate đổi hàng khi người đang đọc: show “Có cập nhật” rồi áp dụng khi chọn hoặc idle, với timestamp snapshot. Khi giải đang live và auto-refresh bật, công bố setting và vẫn không chuyển trang.
- Server pagination bounded; client không render 500 row vô hạn. Trang đầu và API snapshot gồm tổng/filter; new snapshot không trộn rows từ revision cũ. CSV public chứa cùng data/tie-break/rules revision, không email/member IDs.
- Mobile cột bắt buộc Rank/Đội/Điểm (hoặc rating)/status; expand row có W-D-L/tie-break; toàn bảng đầy đủ là chế độ có horizontal scroll trong vùng gắn nhãn, không cắt nội dung. Trang controls luôn đọc/nhấn được.

### 5.3. Bracket/rounds/matches

**List view accessible là mặc định trên mobile và luôn có trên desktop.** Bracket graphical là cách đọc thêm, không đường duy nhất tới match.

- Với 500 đội elimination, envelope tối đa 512 slots khi luật dùng power-of-two; UI lấy seed/bye thật từ server, không suy mỗi ô trống thành bye. Navigation stage → round → nhánh/quadrant → pair; chỉ render cửa sổ nhánh đang xem, không scale cả 512 ô xuống chữ 4px.
- Desktop round columns, minimap có nhãn, zoom 50/75/100/125/150%, Fit, tìm đội, “Theo đường đi đội”; pan/zoom có nút bàn phím thay cho gesture-only. Selecting pair mở detail panel/link; background canvas không biến thành 500 tab stops.
- Pair card: encounter ID, đội A/B, seed, score series, trạng thái, lịch dự kiến, game count, next/previous dependency. TBD ghi “Chờ đội thắng encounter …”; BYE ghi “Miễn đấu”, không W/O. Forfeit, disqualified, void và lỗi hạ tầng tách nhãn; không tô mọi lỗi thành thua.
- Encounter league/Swiss/Elo gồm cặp 2 game đổi side; knockout gồm series 4–8 game theo luật 02. Card phải tách encounter aggregate score khỏi game winner/side; các nút replay chọn đúng game và execution attempt, không gắn một replay làm bằng chứng toàn series.
- Swiss/playoff tự cấu hình: overview/wizard hiển thị Nđội hợp lệ hiện tại và Rvòng/Tsuất dự kiến cùng công thức/version; sau lock hiện resolvedN/R/T bất biến, không manual inputs. Playoff chờSEALED, withdrawal không thayR/T; bracket/byes/EMPTY từserver. League/Elo không bracketgiả.
- Matches: filter round/stage/team/map/status, 50 items/page, status running/queued/finished/unresolved theo contract. Encounter detail gom nhiều games/map/side, aggregate result, links từng replay; lịch “dự kiến”, không hứa thời gian bắt đầu như appointment nếu queue có thể đổi.
- Mọi dispute/rejudge hiển thị badge “Kết quả đã điều chỉnh” với revision và giải thích public đã lọc; link cũ tới trận vẫn resolve provenance, không silently thay replay execution cũ.

## 6. Đội, đăng ký, IDE và submission

### 6.1. Onboarding và roster

ONLINE register→email verify→login→tự tạo/tham gia đội→mã chung giải. LAN Admin cấp account/phân đội/**ghi danh giải luôn**→sinh viên login→đổi mật khẩu tạm bắt buộc→workspace đội/giải đã gán; không Join/mã mời/signup/emailwall. Chưa gán hoặc chưa ghi danh hiện liên hệAdmin, không upload vào giải khác. Admin bulk assignment có preview/limits/audit, không giả danh đội hoặc di chuyển code khi sửa membership. LAN recovery Adminreset, public no-login.

Invitations hiện người mời, đội, giải, hạn 48 giờ, accept/decline. Used/expired/revoked có màn riêng, không spinner. Captain transfer yêu cầu chọn thành viên đang hợp lệ và xác nhận; rời đội không mất khả năng xem public. Roster locked: giữ view, giải thích hỗ trợ ngoại lệ organizer có audit. Rejected entry có lý do private và hướng liên hệ; không public cáo buộc.

### 6.2. Team overview và IDE

Card “Bot dự kiến đem thi” hiện candidate ID/ordinal/hash/language/receivedAt/readyAt và bản mới pending/rejected. Sau lock đổi nhãn “Bot đã khóa” kèm cutoff/lockedAt. Không selectedBy/selectedAt hay nút chọn; latest draft không tự nộp.

IDE hierarchy desktop: breadcrumb + team/giải → sticky deadline/entry strip → tên draft/ngôn ngữ + save status → editor và documentation/problem pane → diagnostics/jobs → footer actions. Three columns không bắt buộc; editor phải tối thiểu 600px rộng trên desktop, docs pane đóng được. IDE load theo route, không cần tải Monaco ở public directory.

- Python/TypeScript/C++20; Monaco workspace nhiều tệp có tree/tabs/search/entrypoint/import-export ZIP, templates và per-file diagnostics. Đơn tệp là project một sourcefile. Không terminal/debugger/extensionmarketplace; không code-server/Codespaces bắt buộc. Limits/canonical packaging theo01; mobile textarea/upload fallback và server build.
- Actions **Lưu nháp / Chạy thử / Nộp bài / Tải dự án** riêng. Chạy thử chụp snapshot rõ hash/version/map/side/opponent baseline hoặc Bot đội mình, queued/building/running/finished/error, private board/replay/diagnostics và quota. Không auto-submit/candidate/Elo, không test opponent đội khác. Import không nộp, không ghi đè draft mất dữ liệu; Monaco lỗi vẫn upload được. Không practice leaderboard/workspace server terminal.
- Chạy thử không bị khóa theo phase: sau deadline/lock/final/archive vẫn có CTA cùng quota/readiness indicator. UI giữ official locked hash riêng và cảnh báo code đang sửa chỉ dùng test; admin pause official không mặc nhiên khóa workspace tests, emergency execution shutdown vẫn chặn vì an toàn.
- Draft autosave cục bộ sau1giây idle là baseline, nhãn thời điểm trênthiếtbị khác serverreceipt; namespace identity/team/project/language. Logout cóexport/xóa trên máy chung; guest không thấy authenticateddraft. Storage denied/quota cóbanner/download, không success giả; autosave khôngbackupserver.
- Reload/session expiry/network offline không âm thầm mất code. Login overlay/route preserve draft; anonymous draft chỉ nhập vào workspace sau explicit confirmation, không gán code của người cũ cho người mới. Autosave không chứa secret token và không phải backup server.
- Hai thành viên sửa cùng draft: version conflict có Compare local/server, giữ local, lưu thành bản mới hoặc reload sau export; không last-write-wins. Bài nộp nhận rồi không merge source.
- Dirty navigation cảnh báo chỉ khi không có bản lưu phục hồi đáng tin cậy; reset template yêu cầu xác nhận, source cũ còn export được. Browser shortcuts/editor shortcuts không kích hoạt viewer bên dưới.
- Mobile đọc/sửa/save/upload/submit và xem candidate/hash/diagnostics; textarea accessible nếu Monaco không phù hợp. Không chặn mobile; không selection action.

### 6.3. Receipt, deadlines và lỗi

Submission VALIDATING/QUEUED/COMPILING/SMOKE_TESTING/READY/REJECTED; registration approval riêng. READY candidate được tự cập nhật bằng receipt ordinal trong cùng team/giải, không readyAt. Job có ID/timestamps/runtime/errorcategory, mở lại sau browser đóng được.

Receipt có submission ID/ordinal, team/giải/ruleset, language/hash, receivedAt/readyAt, candidate hay frozen, lỗi riêng. UI chỉ rõ bản hợp lệ cũ vẫn candidate nếu bản mới pending/lỗi; không gọi mọi historical READY là Bot hiện tại.

Deadline strip dùng timezone defaultAsia/Ho_Chi_Minh, absolute UTCoffset/local/server time và countdown. Nhắc24h/1h/15m, khôngmodal chặncode; ETA chỉ khi cóbenchmark. Deadline receipt theo01/02, không hứaREADYtrướchạn.

Hạn tính durable full-source receipt receivedAt server, không click/start upload hoặc compile completion. Hết hạn hiện “Đã đóng nhận bài — đang kiểm tra”, intake disabled nhưng đúng-hạn pending tiếp tục chạy và có thể thay candidate khi READY. Khi xử lý hết mới hiện “Bot đã khóa”. Infra blocker báo hoãn khóa; không success giả/âm thầm loại bài hoặc fallback cũ.

Flow: nộpv1→READY candidatev1→nộpv2→pending vẫnv1→v2READY auto-replace; nếuv2lỗi giữv1. Out-of-order build không cho ordinal thấp ghi đè. Lock snapshot duy nhất, không đổi saukhóa; mất response tra receipt/key, không tự nộp lặp hoặc success giả.

| Lỗi/tình huống | Nội dung và hành động |
|---|---|
| Validation/encoding/size/language | Field + summary cụ thể; không upload lại vô ích; giữ source |
| Compile/smoke fail | Stage, error code, file/line/column nếu có, message đầy đủ có bounds; click đến vị trí; tải diagnostics private; sửa rồi tạo submission mới |
| Runtime bot timeout/illegal move/output | Job/game ID, resource/rule bị vi phạm, turn; giải thích ảnh hưởng theo luật; không gọi là server failure |
| Infrastructure failed | “Lỗi hạ tầng — không kết luận Bot sai”; recovery/retry do scheduler; không mặc định phạt đội |
| 429/quota | Quota hiện tại/giới hạn và Retry-After tuyệt đối; không polling dồn dập; không xóa draft |
| 401/session expired | Giữ draft, yêu cầu đăng nhập lại; private logs ngừng tải; không auto hiển thị cho anonymous |
| 403/roster hoặc entry locked | Lý do quyền/lock, captain hoặc hỗ trợ; không chỉ disabled |
| Conflict/rules revision changed | Đọc revision mới và xác nhận lại nếu quy tắc cần; không âm thầm chấp thuận |
| Deadline closed |Nộp chính thức bị khóa, nhưng lưu/import/sửa draft và Chạy thử vẫn được. Drain pending không báo frozen sớm; TESTreceipt/status khácOFFICIAL. Không nút nộp test thành bài sau hạn hoặc override|
| Offline/5xx/uncertain response | Trạng thái lỗi khác empty; giữ request/job ID; refresh receipt, Retry an toàn theo contract |

### 6.4. Khiếu nại

Khiếu nại gửi từ trận đội mình trong khi giải chạy hoặc trước finalappealclosed; referenceID/reason/evidence/receipt/status. Wizard Admin đặt finalAppealWindowMinutes trướcregistration (0hợp lệ), luậtpublic và countdown final từ serverprovisionalAt. Window0 ghi “Có thể chốt ngay khi không tranh chấp”, không tựđóng disputeđãmở hoặc autowinner. Sau deadline có late-support path rõ, không hứa đảokếtquả; Admin resolution/audit,public đãlọc,khôngsource/cáobuộc.

## 7. Live/replay: viewer không điều khiển thi đấu

### 7.1. Hierarchy

Header: giải/stage/encounter/game ID → đội A/B + side + aggregate score → match execution status và result status → stream freshness. Board → playback bar → turn/action text → roster counts R/P/S và kết quả → tabs Events/Metadata. Metadata gồm map/rules/runtime revision, seed policy/public seed khi được phép, entry hashes, execution attempt, replay checksum. Public events là action log đã lọc, **không stderr/stdout**.

Match chưa chạy: queued/preparing + lịch dự kiến + link standings, không board sample thay thật. Running: board có state authoritative đến sequence X. Finished: result reason và replay CTA. Unresolved/void/cancelled có lý do, không DRAW giả. Replay availability độc lập result: “Kết quả đã ghi nhận; replay đang chuẩn bị” là hợp lệ.

### 7.2. Ba trục trạng thái độc lập

| Trục | Trạng thái UX | Hành vi |
|---|---|---|
| Execution/result | queued, preparing, running, completed, infrastructure-failed/recovery, cancelled/void; provisional/sealed/finalized theo domain | Không suy từ WS open/close; đọc server authoritative |
| Connection | connecting, synchronized, delayed, disconnected, reconnecting, catching-up, ended | Badge + last received time; mất kết nối không biến match thành hoàn thành |
| Playback | paused, playing-historical, at-live-edge, seeking | Delta mới không hủy pause hoặc seek; nút “Về trực tiếp” explicit |

Connecting có timeout + Retry/đọc snapshot; disconnected giữ frame cuối, ghi “Dữ liệu đến …”, không chấm LIVE giả. Reconnect nối lại từ seq/turn đã nhận theo contract, thiếu gap thì tải snapshot/checkpoint; catching-up ghi tiến độ, không áp delta không liên tục. Browser sleep/background rồi quay lại → reconcile status và turn, không dựa timer đã chạy ngầm. Đổi trận hoặc live → replay detach stream cũ; message trận A không được cập nhật B. END không final delta vẫn có terminal result thống nhất snapshot cuối.

Transportping20giây/stale60giây theo03; UI delayed khi lastheartbeatage>40giây, disconnected/reconnect sau60giây. Hiển thị last-eventage riêng, không suy khôngcónước là mấtconnection. Metadata/standings vẫn đọc khi snapshotfail; errors córequestID, khôngconsole-only.

### 7.3. Playback/turn states

- Controls: play/pause, previous/next turn, first/last, speed 0.5/1/2/5/10×, scrubber có accessible name/current/max, numeric Go to turn, “Về trực tiếp”, mute, reduced motion, fit board, fullscreen/presentation. Turn 0 là initial state; không move để “trước turn 0”.
- URL `?turn=N`; đang live edge không rewrite history mỗi delta. Share lấy turn snapshot hiện tại. Invalid/out-of-range turn được thông báo và clamp tới turn hợp lệ sau metadata load, không màn trắng.
- Paused/historical ghi “Đang xem lượt 42; trực tiếp đã đến 89”. Events chỉ frame/cursor được chọn; panel result cuối là phần riêng, không gắn winner terminal vào turn 0. Auto-scroll events chỉ khi at-live-edge và người dùng chưa cuộn ngược.
- Public result luôn có thể xem ở match/standings. “Ẩn kết quả khi xem replay” là preference cục bộ tùy chọn của viewer/projector; không ACL và không làm API/standings chờ trình chiếu. Với preference bật, result panel collapsed, reveal explicit; chia sẻ turn không giấu kết quả cho người khác bằng policy.
- Replay states: unavailable (lý do/retention), preparing, downloading (bytes nếu biết), verifying checksum, ready, corrupt/unsupported version (retry/redownload/support), no permission. Không play file checksum sai; không âm thầm thay bằng sample. Download filename/size/version được server cung cấp an toàn.
- Piece inspection bằng pointer và keyboard: chọn tọa độ → side/type/ID/location/threat hoặc hợp lệ chỉ khi engine contract cung cấp. Không vẽ hints dự đoán như sự thật. Legend R/P/S có icon + chữ và hai mục tiêu thắng (loại một loại hoặc đạt goal).
- Canvas có board summary dạng DOM: turn, đội, số R/P/S, last action, terminal reason; accessible piece list có tọa độ, keyboard next/previous piece. Screen reader không đọc mọi delta; announce status/selected action hoặc step theo yêu cầu. Bản văn bản đủ để hiểu kết quả, không claim mọi trải nghiệm đồ họa tương đương đã đạt.

### 7.4. Projection optional

Route riêng read-only dùng published result/replay như guest. Operator có thể chọn trận/playlist, play/pause/next/fullscreen, tăng chữ, mute/hide-spoiler cục bộ. Playlist persist preference không đổi ledger/publication/scheduler. Đóng máy chiếu, network mất hay bỏ qua một trận **không ngừng vòng tiếp theo, không giữ standings, không trì hoãn finalize**.

Projection HUD tên đội/giải/round/map/turn và historical/live; không source/privatecontrols. Autoplayoff, intro khôngchặn; preset1920×1080 HUD≥24px, score72/80px theo§4, kiểm phòng thực tế. QR/permalink public khôngorganizertoken; fullscreenEscape cóđườngthoát, mobile dùng viewerroute.

## 8. Organizer: tạo giải và vận hành nhiều ngày

### 8.1. Wizard có review thực

Wizard toàntrang save/resume: thôngtin/họcphần→lịch/timezone/deadlines→format/auto-policy preview không inputR/T/E→map/rules/runtime/seed→roster/profileadmission/privacy→quota/capacity→reviewpublish. LANAdminbulkassign/directenroll, ONLINEsharedcode; không manualapproval thường lệ.

Map policy wizard: Admin chọn Công khai trước hạn hoặc Giữ kín tới khóa Bot trước mở đăng ký; review hiển thị commitment/pool pinned và hậu quả. Hidden map chỉ admin preview; public/team hiện “Map công bố sau khóa Bot”, không thumbnail/name/version/digest gợi cấu trúc. Test selector chỉ map công khai trước reveal; Bot vẫn có observation map khi official chạy sau reveal. Sau lock tự mở preview/download/test cho tất cả theo policy, có proof commitment; source Bot không public. Public-library map đã lộ không được gắn nhãn secret.

Review hiển thị timeline, immutable fields sau open/lock, participant cap 500, encounter/game min/max và estimate **từ benchmark có hardware/date**. Chưa benchmark: “Chưa có dữ liệu ước lượng đáng tin cậy”, không số đoán. Validation cross-field show summary + link bước; wizard không bỏ mất dữ liệu khi back/refresh. Publish confirm public URL, rule revision, trường dữ liệu sẽ công khai; draft không discoverable.

Khi mở đăngký, rules/map/runtime/policy/quota freeze theo01/02; chỉ sửa mô tả/announcement khôngđổi meaning. Deadline extension chỉ trước originalcutoff/lock theo01, cóaudit/thôngbáo, khôngreopen bài muộn. Đổi luật hoặc pool tạo giải mới, không reconfirm để thay luật trên giải đang nhận bài. Saulockread-only, correction chỉđúngTR-08.

### 8.2. Operations dashboard

Above fold: tournament state + timezone/freshness → open incident/banner → next scheduler milestone → số eligible/entry missing/READY selected/locked → current round completed/running/unresolved → queue age/worker health. Links đi tới filtered list. Không confetti champion khi còn unresolved/dispute. Nếu server stale, action nguy hiểm ngừng hoặc yêu cầu reconcile, không hiển thị health xanh từ cache.

Entries500đội có search/filter/pagination50 và source/log viewer read-only cho ADMIN duy nhất, chọn đúng submission/version/hash. Không editor Save/Replace/impersonate hoặc thay frozen Bot. Hiện nhãn private và audit mọi đọc/tải; sinh viên chỉ đội mình, khách không source/log. Bulk tournament actions có impact preview/exclusions, không bulk sửa code.

Rounds: dependencies, seal conditions, grace/dispute deadline, unresolved list. Jobs: queue/claim/attempt/lease/status/failure classification; không một nút Run-all dựa vào browser. Incidents: timestamp, impact, owner, action/history/resolution, link public notice đã lọc. Dashboard mở lại/reload đọc durable state, không yêu cầu giữ tab.
Round badges dùng enum chính thức `PLANNED | RUNNING | PROVISIONAL | SEALED | INVALIDATED | BLOCKED`; INVALIDATED giữ trace kết quả cũ và lý do, BLOCKED chỉ rõ dependency/điều kiện thiếu. Không gộp cả hai thành “Chờ chạy”.

| Action | Confirmation và phản hồi bắt buộc |
|---|---|
| Bắt đầu | Chỉ ADMIN, READY_TO_START, preview số đội/map/ruleset/rounds/epochCount/capacity/duration; xác nhận rồi receipt/audit. Pending/lostack reconcile idempotency key, không blind retry hoặc auto-start; lỗi precondition giữ chờ |
| Pause/resume | Scope + “Pause ngừng claim mới, game đang chạy tiếp tục”; current running count, reason/audit |
| Emergency stop | Dialog danger: sandbox đang chạy sẽ hủy, chưa commit là hạ tầng không phạt đội; reason bắt buộc; kết quả reconcile |
| Seal/finalize | Những dispute/unresolved còn mở; không cho success khi precondition không đạt; ảnh hưởng vòng sau |
| DQ/void/rejudge | Đội/trận/revision, standings và dependency chịu ảnh hưởng, lý do private/public tách riêng; xác nhận cụ thể, không OK chung |
| Gia hạn nhận bài | Old/new cutoff/timezone + announcement; chỉ khi intake còn mở, serverNow < current submissionClosesAt và chưalock. Không rútngắn hoặc reopen intake đãđóng/draining; wizard/preview/confirm và server cùngđiềukiện |
| Gia hạn khiếu nại cuối | Tách khỏi submissiondeadline; chỉ kéo dài window theo01/02, cóaudit/thôngbáo, không rútngắn hoặc overridefinalized/reopenpolicy |
| Publish announcement | Preview đúng public/private scope, nội dung, target giải; xác nhận trước gửi; unsent draft giữ được |

Thao tác: preview→confirm→pending/requestId→receipt hoặc conflict/uncertain; timeout reconcile, không blind destructive retry. Session hết hạn giữ draft; password re-auth cho hành động nhạy cảm, không MFA prompt. Public projection không điều khiển publication.

## 9. Textual wireframes

Các khung là hierarchy, không yêu cầu render bằng code.

### A. Public standings — desktop

```text
[Logo | Giải đấu | Hướng dẫn | Tìm kiếm | Theme | Workspace/Đăng nhập]
[Course / Tên giải]                      [Đang thi đấu · cập nhật 10:32 UTC+07]
[Tổng quan | Luật | Lịch | Xếp hạng* | Nhánh đấu | Trận | Thông báo]
H1 Xếp hạng        [Swiss / Vòng 5]      [Tạm tính · giải thích] [CSV]
[Tìm đội................] [Stage] [Status] [Đội của tôi] [Có cập nhật]
| Hạng | Đội (link) | Đã đấu | W-D-L | Điểm | TB1 | TB2 | Status |
| 1    | ...        | ...    | ...   | ...  | ... | ... | ...    |
[1–50/500] [25/50*/100] [Đầu] [Trước] [Trang 1/10] [Sau] [Cuối]
[Luật tính điểm/tie-break + revision] [Thông báo sự cố nếu có]
```

### B. Team entry/IDE — desktop

```text
[Team/course/tournament scope | Inbox | Account]
[Nav đội]  H1 Bot & IDE
           [Mã mời giải nếu chưa tham gia | Bot dự kiến v7 | Hạn nhận bài/giờ server]
           [Draft name | Python/TS/C++ | lưu trên thiết bị / lưu server]
           [Editor source.....................] [SDK / rules / docs]
           [Diagnostics: stage/file/line]       [Job history + IDs]
           [Lưu nháp] [Upload dự án] [Chạy thử] [Nộp bài chính thức]
           [Bot dự kiến v7 · official receipt/hash · chưa khóa]
           [Test snapshot t9 · hash riêng · private/unranked · không tự nộp]
```

### C. Live/replay — mobile

```text
[Back về giải | Game ID | Menu]
[Đội A — Đội B | round/map | execution + provisional/finalized]
[Connection: đang kết nối / stale / sync · cập nhật cuối]
[Board fit chiều rộng; không bị sidebar che]
[Turn 42/89 · đang xem lịch sử] [Về trực tiếp]
[Previous] [Play/Pause] [Next] [Speed] [Go turn]
[Events | Quân & counts | Metadata] [Text board summary]
[Result riêng / spoiler collapsed nếu preference bật]
[Trận trước/sau] [Share turn] [Download replay]
```

### D. Organizer overview — desktop

```text
[Organizer/course/tournament | Account/email verified]
[Nav ops] H1 Tên giải [State · server freshness] [Xem public]
         [Incident đang mở + impact + owner + xử lý]
         [Next milestone | 500 entries | selected/locked/missing]
         [Round 5: finished/running/unresolved | seal điều kiện]
         [Queue age | healthy workers | failed attempts → jobs]
         [Disputes cần quyết định → list]
         [Pause] [Resume] [Emergency stop — danger, role-guarded]
         [Recent audit + request IDs; không controls máy chiếu gating]
```

Mobile organizer: các section thành stack; queue/audit tables chuyển detail rows; thao tác danger vẫn đầy đủ preview/confirmation, không xóa phần giải thích để vừa viewport.

## 10. Responsive, accessibility và content

- Breakpoints đề xuất: <768px mobile một cột; 768–1199px tablet drawer/2 panes tùy chỗ; ≥1200px desktop sidebar và content. Kiểm cả 320/390/768/1024/1440px và landscape, không chỉ breakpoints đẹp. Body scroll tự nhiên; không root `overflow:hidden` cắt UI. Overlay/editor có scroll vùng hợp lý và trả focus.
- Viewer mobile ưu tiên identity/status/board/playback trước logs. Tablet landscape board+details khi đủ rộng; không ép desktop sidebar cố định. Board zoom/pan không khiến page bị khóa; controls Fit/Reset luôn có.
- WCAG 2.2 AA là gate: contrast text thường ≥4.5:1, text lớn ≥3:1; essential control/graphic ≥3:1; mọi màu actual đo ở cả theme. Reflow 320 CSS px/400% zoom, text 200%; bảng/board hai chiều có vùng cuộn gắn nhãn và alternative list, không toàn trang mất navigation.
- Touch target thiết kế 44×44px; không lấy mức tối thiểu 24px của WCAG làm default. Focus luôn rõ, không bị sticky header/dialog che; keyboard-only đăng ký, upload, select, standings, replay và organizer actions hoàn tất.
- Semantic headings/landmarks/tables; sort có aria-sort, table caption/rank context, pagination name/current; tabs có selected/panel relationships; dialog trap/Escape/restore. Tooltip có keyboard tương đương, không chứa thông tin bắt buộc duy nhất. Button/link đúng semantics, không clickable div.
- Shortcuts viewer chỉ khi workspace viewer active, không trong input/editor/modals, không chiếm phím system/modifier; có help/toggle. Space ở button giữ activation. Slider có numeric alternative và accessible value; không drag-only.
- Live region polite cho receipt/job status, alert cho action error; không đọc mọi clock second/delta. Error summary focus sau submit thất bại, link đến field; field labels không dựa placeholder. Async completion không giật focus khỏi editor.
- `lang=vi` mặc định; tiếng Việt cho tác vụ, giữ thuật ngữ Python/TypeScript/C++/READY/hash nhưng glossary giải thích. Date/number locale thống nhất; error raw compiler nằm panel code, phần diễn giải tiếng Việt. Không dịch enum rồi gửi về API.
- Announcements/notifications không thu thập PII không cần thiết. Link public share không source/token; email không là điều kiện duy nhất nhận critical status. Banner sự cố có timestamp/update link, không phủ che action. Giá trị cached rõ “cập nhật cuối …”, không “Online” vô căn cứ.

## 11. Usability/readiness gates

Đây là **mục tiêu đề xuất cần chứng minh trong implementation**, không đã pass. Mỗi gate lưu task script, dataset, viewport/device/AT, recording hoặc screenshots, defect list và kết quả; parent roadmap dùng IDs dưới đây.

| ID / PR | Gate và dữ liệu | Điều kiện chấp nhận |
|---|---|---|
| UX-01 / PR-04 | Anonymous cold deep links giải/standings/match/replay, back/reload/share filter/turn | Không login wall cho public; đúng scope/turn; không source/stdout/PII trong page/network/export; private URL không lộ metadata |
| UX-02 / PR-01,08 | 500 đội và fixture dataset format lớn; tìm hạng ~450, đội tên gần nhau, playoff path, round 7 | 8/10 người thử mới tìm đúng đội → đúng trận → đúng replay trong ≤60 giây không hỗ trợ; page DOM bounded ≤100 data rows; không xem nhánh bằng chữ thu nhỏ khó đọc |
| UX-03/PR-06,08 |Nộp nhiều versions, build đảo thứ tự/lỗi, auto-candidate→lock;10đội|10/10 biết đúng Bot dự kiến/frozen và hash; không thao tác chọn; draft/pending kháccandidate; receipt đúngserver|
| UX-04/PR-01,07 |Upload nhận đủ trước/sau hạn, lateREADY,drain/restart/infra/quota/lostack|Bài đúng hạn được kiểm sau hạn; chưadrain khônglock; chọn maxordinal hợp lệ; source frozen không đổi; intake không mở lại|
| UX-05 / PR-08 | Login/session expiry/offline/reload/storage denied/concurrent editor/logout trên máy chung | Không âm thầm mất draft; recovery/export có thể thực hiện; tài khoản khác không thấy draft riêng; conflict không overwrite không hỏi |
| UX-06 / PR-04,06,07 | Pause live + deltas, seek, END không delta, disconnect/gap/reconnect/sleep, đổi A→B, live→replay, corrupt file | Không frame chéo trận, không tự unpause; stale rõ; result đúng terminal; resume không gap/duplicate; checksum sai có lỗi không fallback sample |
| UX-07 / PR-03,07 | Projector đóng/mất mạng và organizer browser đóng; mở dashboard mới khi giải tiếp tục | Publication, scheduler và finalize không phụ thuộc browser/projector; state khôi phục từ server; replay kết quả xem được anonymous |
| UX-08 / PR-08 | 320×568, 390×844, 768×1024, 1024×768, 1440×1000; keyboard mở trên mobile; zoom/reflow | Board, identity, playback, standings, receipt và navigation thật sự nhìn thấy/nhấn được; không clipping; mobile có thể submit/select và đọc diagnostics |
| UX-09 / PR-08 | Keyboard-only + NVDA/Firefox và VoiceOver/Safari; light/dark; reduced motion; contrast measurement | Hành trình chính không trap/missing name; focus không bị che; errors readable; text/controls đạt AA; canvas có summary/list; không flash/audio bắt buộc |
| UX-10 / PR-02,07,09 | Organizer publish/pause/emergency/seal/rejudge/DQ, scope conflict, request timeout | Preview đúng phạm vi và hậu quả; reason/audit/request ID; không success giả hoặc blind retry; unresolved ngăn finalize; không impersonation/source quyền mặc định |
| UX-11 / PR-03,08,09 | Assets Internet bị chặn; cold IDE start; phiên dài theo soak gate vận hành | Public/IDE core không phụ thuộc CDN; failure có phục hồi; draft/queue/receipt không mất khi re-auth; memory/render evidence đo thực không claim FPS từ spec |
| UX-12 / PR-08 | 5 sinh viên mới + 2 captain + 2 giảng viên thực hiện scripts không hướng dẫn | Không lỗi blocker; ≥90% tác vụ trọng yếu hoàn tất; deadline/version/role interpretation đúng 100%; thu khó khăn và sửa trước public launch |

Performance UX targets bổ sung: trên cấu hình client/network baseline phải được chốt tại capacity gate, standings page/filter p95 ≤2 giây; feedback local khi click ≤100ms; tải replay có tiến độ khi >1 giây. **Không** coi các con số là SLA backend hoặc capacity 500 viewers. Đo riêng API wait, render và asset download. Long-session suite/fault injection do kế hoạch ops định nghĩa; usability không thay thế sandbox/security/capacity gates.

## 12. Contract tích hợp và chốt phạm vi

1. **02 tournament/gameplay:** cần round/stage/encounter/game dependency, official rank/tie-break/qualification snapshots, bye/forfeit/void/unresolved và result revision; SEALED/dispute/invalidation semantics. UI không tự tính hoặc phát hành.
2. **03 API/data:** scope/public-private, immutable receipts/ordinal, auto-candidate/frozen snapshot, deadline, durable jobs, pagination/search/live/replay/audit và uncertain upload reconciliation; không selectEntry mutation.
3. **05 security:** sanitized incidents/capacity/runtime verdicts, email verification/recovery/re-auth/session controls, retention/privacy/metrics; không MFA scope, không UI button thay sandbox authority.
4. **Roadmap:** UX-01…UX-12 là gate evidence. Stack03 chọn Next từ nghiên cứu requirements, không template-driven; bổ sung kiểm public HTML có nội dung/metadata/canonical/HTTP404 khi tắtJS, privatecache/OG/sitemap không chứaPII. Template cần license snapshot/component review trước dùng.
5. **Clean cutover:** bỏ navigation state-only, private/public lẫn discovery, projection-based result hiding và account-level one-entry wording khi triển khai v2; giữ code cũ chỉ theo kế hoạch migration rõ. Trong phiên DOCS ONLY này không sửa code/config/tests hay các tài liệu lịch sử.

**Lựa chọn UI đã duyệt:** shadcn/ui + Tailwind + brackets-viewer.js, dark-first esports theo§4, được reuse code theo quyền người dùng xác nhận. Không còn chờ chọn mẫu. Các policy/resource limits theo01/02/05 là baseline thiết kế; targets phải đo trướcrelease, không tự coi là đã đạt. Không chat/social/marketplace/thêmruntimeBot/localexecution thay authority.
