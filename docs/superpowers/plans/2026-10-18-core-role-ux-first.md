# Core UX theo vai trò — kế hoạch ưu tiên trước LAN core

## Trạng thái và quyết định

IMPLEMENTED_PENDING_USER_REVIEW / role split và replay ACL đã triển khai, production build thành công, isolated server suite 331 passed/1 skipped; browser smoke guest/player/admin và private TEST embed đã chạy. Bằng chứng: [core-role-ux-evidence](../../implementation/rebuild/core-role-ux-evidence.md). U5 người dùng duyệt vẫn chưa hoàn tất; independent final review tool lỗi. ONLINE/deploy tiếp tục hoãn; chưa tự chuyển sang LAN core.

Giữ ngôn ngữ hình ảnh game-arena.ai đã chọn nhưng không sao chép cách phân chia chức năng không phù hợp. UX đúng nhiệm vụ/role được ưu tiên hơn việc đưa mọi chức năng lên một màn. Sản phẩm là website, không app desktop/mobile.

Ba yêu cầu bắt buộc của người dùng:
1. Ban tổ chức và Replay chỉ ADMIN truy cập; khách/người chơi không nhìn thấy chúng trên giao diện.
2. Không gian đội là danh sách giải gọn; mỗi cặp đội–giải có trang làm việc riêng chứa nộp code, test riêng tư, kháng nghị và thông tin liên quan.
3. Giao diện giải cho khách, người chơi và ADMIN khác nhau theo nhiệm vụ, không tích hợp chung một trang dài.

## Thay đổi chính sách cần đồng bộ

Replay chính thức trước đây công khai; yêu cầu mới thay thế điều đó. Phạm vi thực thi mặc định: thư viện/view/download replay CHÍNH THỨC chỉ ADMIN, gồm route trang, API theo game, API theo digest, link tải và mọi entry point legacy. Không chỉ giấu menu.

Giả định cần người dùng xác nhận trước code: private TEST vẫn cho CHÍNH ĐỘI xem bàn cờ/kết quả/replay test bên trong trang Test riêng tư, không dùng thư viện `/replays`, ADMIN vẫn không được xem private TEST của đội. Nếu người dùng muốn cấm người chơi xem cả replay TEST thì cần sửa contract private TEST rõ ràng; không tự mở quyền ADMIN vào private TEST để phù hợp câu “Replay chỉ ADMIN”.

Live trận đang diễn ra, điểm cuối, bracket và standings vẫn công khai theo spec cũ; không suy yêu cầu chặn replay thành chặn toàn bộ dữ liệu giải/live. Live không phải đường tải lại replay lưu trữ; kiểm tra endpoint kết thúc trận không rò archive dưới dạng snapshot. Dữ liệu đã tải/cached trước thay đổi không thể thu hồi từ máy khách; bảo đảm không public-cache các response mới và purge cache quản lý được khi cutover.

## Thông tin kiến trúc và route

| Vai trò/phạm vi | Trang | Mục đích |
|---|---|---|
| Khách | `/`, `/tournaments/:id` | Danh sách giải, tổng quan công khai, lịch/đối đầu, standings, live nếu có; không form nộp/test/kháng nghị/quản trị/replay |
| Người chơi | `/workspace` | Chỉ các giải có đội của mình; một hàng tên giải và nút Xem giải, không mount panel tác vụ cho mọi giải |
| Đội trong giải | `/workspace/tournaments/:id/teams/:teamId` | Trang riêng được kiểm quyền membership + enrollment; tổng quan, bài nộp, test riêng tư, kháng nghị |
| ADMIN | `/organizer` | Danh sách/quản lý giải, tài khoản/đội/map ở cấp toàn hệ thống; không nhồi toàn bộ giải vào cùng console |
| ADMIN theo giải | `/organizer/tournaments/:id` | Cấu hình/ghi danh, map pool, điều hành, adjudication, nhật ký theo đúng giải |
| ADMIN replay | `/replays` hoặc viewer hiện tại được bảo vệ | Chỉ official replay; mở từ console giải hoặc thư viện admin |

Route đội gồm teamId để không dựa vào “đội đầu tiên” hoặc query tùy ý. Server luôn kiểm role/scope + membership + tournament enrollment; URL hợp lệ không đồng nghĩa được phép. Nếu dữ liệu vi phạm unique-membership thì báo lỗi có kiểm soát, không chọn đội ngẫu nhiên. Liên kết `/tournaments/:id` vẫn là public view; từ public view có thể hiện CTA phù hợp “Vào trang đội của tôi” cho thành viên hoặc “Quản lý giải” cho ADMIN, không nhúng private controls vào public layout.

Trang làm việc đội dùng subnavigation có URL ổn định (`?tab=overview|submission|tests|appeals`) hoặc nested route nhất quán; quyết định triển khai dùng query tab để tái sử dụng component hiện có. Back/forward/reload giữ tab và đúng context. Chỉ mount tác vụ của tab đang dùng; không fetch source/test/dispute của tất cả giải ngay ở `/workspace`.

## Nội dung từng màn

### Khách
- Header: Giải đấu, đăng nhập; không Ban tổ chức/Replay và không flash link admin trước khi session resolve.
- Public tournament: tổng quan, trận/nhánh đấu, bảng xếp hạng, thông báo; bỏ Xem replay/Tải replay khỏi mọi row/card/projector cho non-admin.
- Không cần đăng nhập để xem nội dung công khai; không ép khách vào workspace.

### Người chơi
- Header: Giải đấu, Không gian đội, tài khoản/đăng xuất. Không Ban tổ chức/Replay.
- `/workspace`: tên giải là nội dung chính mỗi hàng, “Xem giải” vào trang đội riêng. Có thể dùng nhãn trạng thái nhỏ nếu cần nhưng không thêm đoạn mô tả dài, UUID/seed/digest kỹ thuật hoặc panel lồng nhiều cấp. Chỉ liệt kê giải có enrollment đội mình; empty/loading/error riêng, không hiển thị danh sách mọi giải với “bạn chưa có đội”.
- Header trang đội: tên giải, tên đội, trạng thái/hạn quan trọng và link public view. Mặc định tab Tổng quan.
- Tổng quan: trạng thái bài đang dùng/frozen, ván tiếp theo/kết quả đội, thông báo quan trọng và CTA tiếp theo.
- Bài nộp: IDE hoặc ZIP, trạng thái build/receipt và lịch sử (chi tiết digest/log trong disclosure, không chiếm màn mặc định). Khi intake đóng: giải thích ngắn, không giấu lịch sử hoặc vô hiệu hóa private TEST.
- Test riêng tư: tạo test, trạng thái, kết quả/log và viewer riêng của đội theo giả định ở trên; không điểm/rating/frozen side effects.
- Kháng nghị: chọn ván của đội, lý do, trạng thái xử lý, deadline; không hiện công cụ correction/DQ/finalize.
- Giữ draft theo cả tournamentId + teamId + file; đổi tab không mất draft. Chuyển giải/đội không mang source hoặc kết quả private sang context khác.

### ADMIN
- Header: Giải đấu, Ban tổ chức, Replay, tài khoản/đăng xuất; không đưa ADMIN vào workspace người chơi theo mặc định. Đổi mật khẩu bắt buộc vẫn là cổng riêng trước khi điều hành.
- `/organizer`: danh sách giải + tạo giải; các mục tài khoản/đội/bản đồ được điều hướng thành section/tab riêng, không form nối tiếp vô hạn.
- Console giải riêng: Tổng quan; Đội tham dự; Bản đồ/cấu hình (guard theo state); Điều hành; Kháng nghị/sửa kết quả; Nhật ký. Hiện hành động hợp state, confirm impact và reauth đúng logic hiện có.
- ADMIN đọc submitted source/log qua quyền audited hiện có; không gọi private TEST API của đội, không sửa frozen artifact.

## Kế hoạch thực hiện U0–U5

### U0 — Chốt quyền và contract UX trước chỉnh sửa
**Files:** specs v2 product/architecture/UI/security + canonical plan; identity/session contract và result routes được đọc để kiểm kê.
- [ ] Chốt ngoại lệ private TEST ở trên. Viết ma trận quyền route/API/download/link cho guest, FULL STUDENT own/foreign, FULL ADMIN, PASSWORD_CHANGE_ONLY, expired/revoked.
- [ ] Ghi override replay chính thức admin-only vào specs và acceptance cũ; không để test public replay cũ tiếp tục được coi là policy.
- [ ] Định nghĩa entry point đội–giải và admin–giải, trang đăng nhập riêng/returnTo nội bộ an toàn; limited-session chỉ đổi mật khẩu/logout.
**Acceptance:** không có mâu thuẫn “official replay public/admin-only” trong tài liệu hoạt động; private test policy rõ ràng.

### U1 — Role shell và bảo vệ replay thật
**Files:** `app/_components/{SiteHeader,HeaderSession}.tsx`, `lib/api.ts`, `app/replays/**`, `packages/server/src/results/routes.ts`, replay/result route registration trong app.ts, public bracket/projector links; rà legacy replay endpoints trong server.
- [ ] Regression tests API official replay: guest401, STUDENT403 (own/foreign đều vậy), ADMIN200, limited403; cả gameId/digest/download/legacy path. ADMIN không có quyền private TEST.
- [ ] Dùng auth service/Actor đã xác minh, không nhận role từ client. Private/no-store headers, không immutable/public cache, không lộ replay digest/path trong DTO chỉ để phục vụ link bị cấm.
- [ ] Header chỉ render đúng role, loading fail closed; public/admin links chính xác sau login/logout/revoke/first-change. Direct URL vẫn được bảo vệ, không dựa vào ẩn CSS.
- [ ] Kiểm tra public results/live còn hoạt động theo contract, không accidentally khóa standings hoặc nguồn dữ liệu kháng nghị của đội.
**Acceptance:** non-admin không thấy và không truy cập official replay/organizer; negative API/browser checks đều đạt. Header không flash admin links.

### U2 — Không gian đội thành danh sách và trang đội–giải riêng
**Files:** `app/workspace/page.tsx`, new `app/workspace/tournaments/[id]/teams/[teamId]/page.tsx` và client tabs colocated; reuse `SubmissionPanel`, `SourceIde`, `PrivateTestPanel`, `DisputePanel`; dedicated own-enrollment query trong teams/tournaments routes/lib nếu cần.
- [ ] Viết boundary tests membership/enrollment/cross-course/revoked/limited; không lấy toàn bộ private source/tests của mọi giải ở list route.
- [ ] `/workspace` chỉ rows tên giải tham gia + Xem giải, data state gọn. Nút trỏ private team route, không trỏ public tournament như code hiện tại.
- [ ] Tạo layout trang đội với 4 tab đã nêu, giữ đúng tournamentId/teamId; trả no-store, denied không leak source/team-private metadata.
- [ ] Cô lập draft theo cặp đội–giải; kiểm tra tab navigation, reload/deep link, build history, cutoff/frozen, TEST sau final/archive, appeals theo state.
**Acceptance:** thao tác mỗi đội–giải nằm trên trang riêng; trang danh sách không chứa IDE/upload/test/appeal form và không tải private data của giải chưa mở.

### U3 — Console ADMIN theo giải, public tournament không trộn nhiệm vụ
**Files:** `app/organizer/{page,OrganizerConsole,MapEditor,TournamentAdjudication,EntryCodesPanel}.tsx`, new `app/organizer/tournaments/[id]/page.tsx`, public `app/tournaments/[id]/**`.
- [ ] Tách chọn/tạo giải và quản lý tài nguyên toàn cục khỏi console một giải; tái sử dụng handler/API hiện có, không duplicate lifecycle owners.
- [ ] Chuyển control theo giải vào trang riêng/tabs, không mount card nghiệp vụ của mọi giải. Source inspection audited, confirmation+reauth không bị bỏ để làm gọn UI.
- [ ] Public page chỉ read view; participant CTA vào private workspace, ADMIN CTA vào console. Query/URL giả role không đổi quyền.
- [ ] Replay chỉ hiện trong context ADMIN; private TEST không xuất hiện trong console ADMIN.
**Acceptance:** ba vai trò có hierarchy/nhiệm vụ riêng; player không thấy admin actions; admin không bị dẫn vào form nộp code như đội; public vẫn SSR/deep-link được.

### U4 — Rút gọn nội dung và kiểm chứng các journey
**Files:** toàn bộ surface bị đổi và tests/browser evidence; không viết test pin nguyên văn text/CSS.
- [ ] Bỏ debug prose như “PostgreSQL/server receipt/không mock” khỏi nội dung mặc định; giữ giải thích ngắn theo hành động. UUID/hash/raw error chỉ trong chi tiết cần thiết, không rò secret.
- [ ] Scenario browser guest: header/public tournament/live, không admin/replay; direct URL denied.
- [ ] Scenario player: login/first change → list giải → đội–giải → nộp→READY→private TEST→kháng nghị; chuyển giải không mất/lẫn draft; non-member denied.
- [ ] Scenario ADMIN: login → chọn giải → quản lý team/map/start/pause/preview correction/reauth/finalize → official replay; không truy cập private TEST. Các mutation phá hủy dùng fixture riêng, không giải demo người dùng.
- [ ] Build + regression isolated DB; bảo toàn source privacy, official/TEST side effects, multi-role cookies/logout/back/forward và bàn phím. Không triển khai native app; kiểm thử browser là kiểm chứng website.
**Acceptance:** kiểm chứng nhiệm vụ role thực sự, không chỉ screenshots; không còn form dài ở danh sách đội/giải; không mất chức năng vì rút gọn.

### U5 — Người dùng duyệt core UX, rồi mới tiếp LAN core
- [ ] Demo người dùng ba đường guest/player/ADMIN, nhận phản hồi core flow và sửa trước khi đóng UX.
- [ ] Cập nhật docs/routes/ACL/evidence, bỏ obsolete public replay assertions và những nav/alias thừa sau cutover; không giữ shim công khai để tương thích quyền cũ.
- [ ] Sau khi người dùng duyệt core UX, quay lại L0→L1/L2… trong LAN plan. Không tự tiếp ONLINE/deploy.

## Những việc không thuộc đợt này

Không đổi luật gameplay, thêm game khác, viết desktop/mobile app, phát triển SMTP/ONLINE, triển khai VPS hoặc làm capacity/soak khi flow UI chưa được duyệt. Không tự mở lại public replay cũ để làm đẹp bảng giải. Không loại bỏ server ACL chỉ vì nav đã ẩn.

## Review/self-check

Mỗi yêu cầu user có owner: U1 = nav+official replay; U2 = private team–tournament page; U3 = distinct role views; U4 = concise copy/journeys; U5 = UX-first priority gate. Root findings verified in code: SiteHeader static links include organizer/replay for everyone; workspace maps all boarded tournaments and mounts 3 panels per entry; results replay routes use public immutable caching. Những gì cần hỏi chỉ là private TEST replay policy, không hỏi lại yêu cầu đã rõ.
