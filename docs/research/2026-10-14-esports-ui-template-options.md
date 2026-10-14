# 2026-10-14 — Research mẫu giao diện gaming/esports cho OanTuTi v2

Ngữ cảnh: người dùng chốt hướng **gaming/esports dark-first, thật đẹp**, cho phép tận dụng/sao chép từ template đẹp và phổ biến. Tài liệu này chỉ research và đề xuất lựa chọn; chưa code, chưa mua, chưa tải về.

## Quyền tái sử dụng — xác nhận mới của chủ sản phẩm

- Người dùng xác nhận đã xin được sự đồng ý của các bên đã nêu cho **sao chép code**. Vì vậy được copy/adapt code giao diện trong phạm vi đồng ý; các giới hạn chỉ tham khảo code ở bản nghiên cứu trước không còn áp dụng. Đây là xác nhận của người dùng, không phải giấy phép assistant đã kiểm chứng.
- Không tự mở rộng sự đồng ý sang ảnh/logo/font hoặc dependency bên thứ ba. Ghi nguồn/phiên bản/file, phạm vi cho phép và notices của phần thực tế tích hợp.
- Không mua template; nguồn code được cấp quyền không nhất thiết phải open-source. Nếu chưa có source, dùng file/gói tác giả cung cấp hoặc phần công khai hợp lệ; không suy rằng permission làm private source tự truy cập được.

---

## 1. Youplay — nK (HTML template)

- Demo chính thức: https://html.nkdev.info/youplay/ (4 biến thể: Dark, Shooter, Anime, Light). Trang sản phẩm: https://nkdev.info/downloads/youplay-game-bootstrap-template/
- Stack: HTML5 + **Bootstrap 3** + SASS, jQuery-era; có sẵn trang store, blog, forum, **Clan Wars** (quản lý đội và trận), review/rating, carousel, parallax (Jarallax). [Nguồn: trang sản phẩm nK]
- Giá niêm yết trên demo: **$23**; bán qua Envato/ThemeForest. [Nguồn: trang demo]
- Đã kiểm chứng trực quan demo Dark (14/10/2026): nền tối, accent vàng/cam, typography gaming mạnh, card trận đấu "team A vs team B + tỉ số + ngày", carousel hero.
- Đánh giá cho OanTuTi:
  - **Ưu:** kho component gaming rộng nhất trong nhóm HTML; phần "Clan Wars"/match listing khớp trực tiếp màn trận đấu/cặp đấu của ta; giá rẻ.
  - **Nhược:** Bootstrap 3 + jQuery là công nghệ cũ; phải **port tay sang React/Next.js + Tailwind**, giữ visual, bỏ hạ tầng JS cũ. Ảnh demo là ảnh game thương mại — chỉ dùng được nếu license template bao gồm; cần kiểm trong gói mua, nếu không phải thay bằng asset tự vẽ.

## 2. Overworld — Edge Themes/Qode (WordPress theme)

- Demo chính thức: https://overworld.qodeinteractive.com/ ; ThemeForest: $85, **1.070 sales** — mức phổ biến cao nhất trong nhóm gaming/esports theme. [Nguồn: trang ThemeForest]
- Đã kiểm chứng trực quan (14/10/2026): hero dark tím neon cực đậm chất esports, typography display lớn, có **mục Tournament riêng trên menu**, trang tournament archive có metadata giải (ngày giờ, game, prize, format 5v5, slot 54/54).
- Đánh giá cho OanTuTi:
  - **Ưu:** ngôn ngữ thị giác esports "đỉnh" nhất trong các mẫu đã xem; trang tournament có sẵn khái niệm prize/format/slots rất gần với màn giải đấu của ta.
  - **Nhược:** là **WordPress theme** — không thể tái dùng code cho Next.js; chỉ có thể dùng làm **tham chiếu thị giác** hoặc mua để trích CSS/asset (vẫn phải viết lại component React). $85 chỉ để lấy cảm hứng là đắt nếu không dùng WordPress.

## 3. Gameco — UIAXIS (React + Next.js template)

- ThemeForest: https://themeforest.net/item/gameco-esports-and-gaming-react-next-js-template/57678143 — **$29, 44 sales**, "Well Documented". [Nguồn: trang ThemeForest]
- Stack: **React + Next.js** — trùng stack đích của OanTuTi v2 (Next.js/React public SSR), nên **tái dùng được gần như nguyên trạng** thay vì port tay.
- Đánh giá cho OanTuTi:
  - **Ưu:** duy nhất trong nhóm chạy đúng stack đích; chi phí tích hợp thấp nhất; giá rẻ.
  - **Nhược:** 44 sales là ít — chưa được thị trường kiểm chứng rộng như Overworld/Youplay; cần xem kỹ demo và chất lượng code trước khi chốt (chưa kiểm chứng được demo trực tiếp trong phiên này vì ThemeForest chặn fetch, HTTP 403). **Rủi ro mở:** chưa xác minh phiên bản Next.js trong template có khớp phiên bản ta chốt (Next 15) hay không.

## 4. Geco / Bame / Xports (HTML, nhóm phổ biến tầm trung)

- Geco (ThemeBeyond): $12, **76 sales**, có bản HTML5 và bản React JS riêng. [Nguồn: ThemeForest search]
- Bame (themeholy): $23, **97 sales**, cập nhật gần đây, 2 reviews. [Nguồn: ThemeForest]
- Xports (Gramentheme): $14, **80 sales**. [Nguồn: ThemeForest]
- Đánh giá: cùng nhóm HTML phải port tay như Youplay nhưng ít component và ít kiểm chứng hơn; chỉ nên xem nếu cả 3 phương án trên đều bị loại.

---

## 5. Nguồn thị giác và code được người dùng xác nhận đã xin phép

### FACEIT

- Trang chủ: "Browse competitions from **10,000+ tournament organizers**" — mức phổ biến rất cao. [Nguồn: https://www.faceit.com/en]
- Đã kiểm chứng trực quan matchroom (14/10/2026): nền đen, **accent cam**, banner trận với map background mờ, scoreboard "9 vs 13" cỡ lớn, badge **WINNER** xanh lá, tab Overview/Stats.
- Bài học cho OanTuTi: header trận đấu nên có ảnh/map mờ + tỉ số khổ lớn + badge kết quả; trang chiếu cho lớp học cần "winner state" rõ như FACEIT.

### Toornament

- Vendor tự mô tả: "**Thousands of tournaments every week**". [Nguồn: https://www.toornament.com/en_US/]
- Đã kiểm chứng trực quan (14/10/2026): dark navy + accent xanh cyan, header giải có banner + ngày + trạng thái, tab **Overview / Stages / Matches / Participants / Rules**, danh sách trận dạng hàng "A vs B" theo vòng (Playoffs / Main Bracket / Round 1), tab Upcoming/Results.
- Bài học cho OanTuTi: đây là **cấu trúc trang giải gần nhất với nhu cầu giảng viên** — tab Rules/Participants/Stages khớp 1-1 với spec; danh sách trận theo vòng phù hợp chiếu màn hình.

---

## 6. Bảng so sánh quyết định

| Mẫu | Stack | Giá | Mức phổ biến (nguồn chính thức) | Tái dùng code vào Next.js | Chất esports |
|---|---|---|---|---|---|
| Youplay (nK) | HTML + Bootstrap 3 | $23 | Trường tồn từ 2016, 4 biến thể demo | Port tay (visual giữ, JS viết lại) | Tốt, nhiều component gaming |
| Overworld (Edge/Qode) | WordPress | $85 niêm yết | 1.070 sales | Có thể port code được cho phép sang React; không dùng nguyên WordPress | Tím neon, trang tournament riêng |
| Gameco (UIAXIS) | **React + Next.js** | $29 | 44 sales | **Cao nhất — đúng stack** | Chưa kiểm chứng demo trực tiếp |
| Geco/Bame/Xports | HTML | $12–$23 | 76–97 sales | Port tay | Trung bình |
| FACEIT / Toornament | Nền tảng thật | — | 10.000+ organizers / hàng nghìn giải mỗi tuần | Người dùng xác nhận đã xin phép copy code; cần source thực tế | Tham khảo bố cục giải/matchroom |

## 7. Đề xuất trả phí ban đầu — không được chọn

Gameco/Youplay/Overworld đã khảo sát; không mua hoặc đổi nền sản phẩm. Với xác nhận mới, được reuse code giao diện đã cho phép và port phần hữu ích sang React/Tailwind; không dùng nguyên WordPress/Bootstrap stack hoặc tự suy quyền với artwork/branding. Quyết định canonical ở§9.5 và04§4.

## 8. Handoff sau lựa chọn

Người dùng đã chọn theo đề xuất miễn phí ở§9.5. Palette, mapping màn hình, contract bracket và gate triển khai đã cập nhật vào04, hồ sơ06 và T8/T9 trong kế hoạch. Không tải/mua/cài template và không sửa product code. License từng snapshot/dependency/asset vẫn phải kiểm trước phân phối.

---

## 9. BỔ SUNG: shortlist MIỄN PHÍ / open-source (theo yêu cầu "nguồn miễn phí" 14/10/2026)

Người dùng yêu cầu không phát sinh chi phí template, sau đó xác nhận đã xin phép sao chép code các bên đã nêu. Các nguồn ở mục1–4 được copy/adapt trong phạm vi đồng ý, không còn giới hạn chỉ nhìn demo. Kết quả license GitHub trước đây chỉ mô tả license công khai, không phủ định sự cho phép riêng.

### 9.1 BEKO Master — template esports HTML/CSS/JS miễn phí

- Live preview: https://rjksharma.github.io/beko_master/ ; source: https://github.com/rjksharma/beko_master ; trang giới thiệu: https://rjksharma.com/free-template/free-open-source-gaming-website-template-modern-esports-html-template (ghi 962 downloads).
- Đã kiểm chứng trực quan: dark navy + gradient đỏ-hồng, hero typography lớn, có section Fighter/Team/Blog, CTA gradient. Landing-page-oriented, không có trang tournament/bracket.
- **License công khai và cho phép riêng:** snapshot GitHub trả `NOASSERTION`, trang giới thiệu ghi educational purposes; đó là tình trạng license công khai quan sát trước đây. Người dùng nay xác nhận đã xin phép các bên đã nêu: code được reuse trong phạm vi đồng ý, không yêu cầu xin phép lại. Ghi provenance/phạm vi cho phần sử dụng và phân biệt asset/dependency không tự nằm trong quyền code.

### 9.2 brackets-viewer.js — thư viện bracket MIT (thành phần cốt lõi)

- Repo: https://github.com/Drarig29/brackets-viewer.js — MIT; số231 stars và push09/2026 là snapshot nghiên cứu trước, không số liệu adoption hiện tại. Library hỗ trợ round-robin/single/double elimination, không đồng nghĩa3/4 format sản phẩm: OanTuTi có knockout/Swiss-playoff/RR/Elo, trong đó Swiss/Elo cần standings/match list riêng.
- Có demo và docs chính thức: https://drarig29.github.io/brackets-docs/
- **Đề xuất:** dùng trực tiếp cho màn bracket trên web Next.js (nhúng như component), tùy biến CSS sang dark esports.

### 9.3 Thư viện bracket thay thế

- g-loot/react-tournament-brackets: snapshot304 stars, LGPL-2.1, push gần nhất quan sát07/2024. Không suy last-push thành đã bỏ hoang; LGPL là license hợp lệ có nghĩa vụ copyleft cần review, không phải tự động cấm frontend. Không chọn trong scope này.
- sbachinin/bracketry: **MIT**, 41 stars, còn maintain (03/2026), chỉ knockout tree — phù hợp nếu chỉ cần single/double elimination dạng cây. [Nguồn: GitHub API]
- hrmasss/bracketkit: headless pure-CSS React bracket, zero-dependency, SSR-safe — mới, ít kiểm chứng. [Nguồn: GitHub]

### 9.4 Nền component miễn phí: shadcn/ui + Tailwind (MIT)

- shadcn/ui + Tailwind + Radix dùng nền MIT upstream; kiểm snapshot/notices. Code giao diện nguồn khác được copy/adapt theo sự đồng ý người dùng xác nhận; quyền với asset/dependency phải xét riêng.

### 9.5 Lựa chọn miễn phí đã được người dùng duyệt

**Đã chọn: shadcn/ui + Tailwind, brackets-viewer.js; được copy/adapt code giao diện các nguồn người dùng xác nhận đã xin phép.** Palette navy gần đen/violet/cyan, cam LIVE tại04§4. Không mua template/đổi stack; đưa phần tái sử dụng vào component React/Tailwind, ghi provenance/phạm vi và notices. Không mặc định permission code bao gồm asset/dependency bên thứ ba.

Trong các nguồn đã kiểm, chưa tìm thấy template esports miễn phí đáp ứng đồng thời license rõ, đúng stack Next.js và đủ tournament/workspace screens. Không coi đó là chứng minh không tồn tại template khác. Nền component MIT giúp tái sử dụng primitives; cần effort tích hợp/domain UI và kiểm license/contrast thực tế, không cam kết ít công hơn mọi phương án hoặc không có rủi ro pháp lý.

| Phương án miễn phí | License | Đúng stack Next.js | Có sẵn tournament UI | Rủi ro |
|---|---|---|---|---|
| BEKO Master | Không rõ (NOASSERTION, "educational") | Không (HTML thuần) | Không | Pháp lý chưa rõ |
| brackets-viewer.js | MIT | Nhúng client-only | Bracket RR/knockout; không Swiss/Elo | Cần mapping domain + accessibility |
| g-loot/react-tournament-brackets | LGPL-2.1 | Có (React) | Bracket | Không chọn; review copyleft nếu dùng |
| bracketry | MIT | Nhúng được | Chỉ knockout | Thấp, ít tính năng |
| shadcn/ui + Tailwind | MIT | **Có** | Không (tự dựng) | Thấp nhất |
