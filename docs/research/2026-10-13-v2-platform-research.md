# Nghiên cứu nền tảng OanTuTi v2: cổng thi đấu production, thể thức, sandbox và UI

Ngày nghiên cứu và truy cập tất cả nguồn: **2026-10-13**. Phạm vi: tài liệu và nguồn chính thức; không cài đặt, tải template về dự án, triển khai hay chạy benchmark/test. Đây là tài liệu nghiên cứu phục vụ thiết kế, **không phải chứng nhận hệ thống hiện tại đã production-ready**.

## 1. Kết luận điều hành

**Đầu vào từ yêu cầu:** khoảng 500 đội sinh viên; giảng viên tổ chức nhiều giải kéo dài vài ngày; bot thi đấu bất đồng bộ; khán giả không đăng nhập xem standings, matches và replay; trình chiếu chỉ là tùy chọn; hỗ trợ single elimination, Swiss → top 16 playoff, round robin và Elo arena. Đây là mục tiêu sản phẩm, không phải số tải đồng thời hay năng lực đã đo.

**Khuyến nghị nghiên cứu, chưa phải quyết định đã được người dùng phê duyệt:**

1. Xây **competition portal** có ba không gian rõ ràng: công khai, đội thi, ban tổ chức. Học quy trình submission/clarification của DOMjudge, phân quyền visibility của CTFd, và vòng luyện tập → khóa bot → giải đấu của Battlecode; không sao chép mô hình chấm bài/CTF vào engine bot.
2. Đề xuất **Swiss 9 vòng → top 16 single-elimination** làm preset cho giải chính 500 đội; Elo arena cho luyện tập nhiều ngày; single elimination cho sprint; round robin cho giải nhỏ hoặc khi ngân sách tính toán được duyệt. Giữ cả bốn thể thức thật, không đổi full round robin thành vòng bảng mà vẫn gọi cùng tên.
3. Chuẩn hóa `game` là một ván, `match` là cuộc đối đầu có một hoặc nhiều ván, `round` là vòng ghép cặp. Tính điểm, Elo, replay và xử lý lỗi phải khai báo rõ áp dụng ở tầng nào.
4. Compile và run đều là ranh giới thực thi mã không tin cậy. Ưu tiên đánh giá **isolate trên worker Linux chuyên dụng, tách khỏi host có dữ liệu/credentials của portal**; gVisor là phương án thay thế cần kiểm chứng tương thích. Không coi child process, timeout đơn thuần hay container mặc định là bằng chứng an toàn.
5. Chọn một hệ component nhất quán: đề xuất shadcn/ui với bộ primitive được pin rõ; Radix phù hợp làm primitive nếu chọn biến thể Radix. Dùng Tabler làm nguồn bố cục/dashboard tham khảo, không ghép nguyên hai hệ CSS. Không đồng nhất thư viện UI với hoàn thiện accessibility.
6. Chặn mở giải chính thức nếu chưa chứng minh được: isolation compile/run, durable jobs, commit kết quả idempotent, phục hồi sau crash, tính lại standings/rating, phân quyền public/private và diễn tập tải trên cấu hình thực. Không cần microservices chỉ để trông giống production.

### Quy ước bằng chứng

- **Nguồn:** thông tin đọc được từ tài liệu chính thức, luôn kèm liên kết.
- **Suy luận/tính toán:** hệ quả từ giả định ghi rõ; không phải benchmark hoặc thông tin do bên thứ ba xác nhận.
- **Đề xuất:** lựa chọn riêng cho OanTuTi, cần được đưa vào spec và acceptance tests trước triển khai.
- Tài liệu này không audit source code hiện tại; không lấy mô tả trong yêu cầu làm bằng chứng một tính năng đã tồn tại.

## 2. So sánh cổng thi đấu và mô hình UX

| Nguồn chính thức và sự thật đã đọc | Điều nên học cho OanTuTi — đề xuất | Điều không suy diễn |
| --- | --- | --- |
| [DOMjudge team manual](https://www.domjudge.org/docs/manual/main/team.html): submission đi vào queue, được compile/chạy; trang đội có thời gian, ngôn ngữ, bài, trạng thái; public scoreboard; clarification riêng cho đội hoặc gửi toàn bộ; có scoreboard freeze tùy chọn. | Receipt bền vững ngay sau upload; lịch sử bot/version và trạng thái build; verdict riêng biệt; một nơi đọc thông báo/chính sách; hàng đội của mình được định vị trong standings. | Không lấy penalty-time/chấm đúng-sai của bài thuật toán làm điểm bot. Freeze là chính sách công bố, không có nghĩa scheduler dừng. Manual đọc là nhánh `main`, tự ghi 10.0.0DEV, không khẳng định bản stable đã có mọi chi tiết. |
| [CTFd visibility settings](https://docs.ctfd.io/docs/settings/visibility-settings): cấu hình riêng challenge, score, account và registration visibility; score Public cho mọi người; Private cần đăng nhập. Tài liệu cảnh báo score/account visibility lệch nhau có thể làm lộ điểm qua profile. | Ma trận visibility phải bao gồm trang, API, search, profile, replay metadata, export và cache. Công khai điểm đội không đồng nghĩa công khai email, danh sách sinh viên hoặc source bot. | Không giả định chỉ ẩn menu hoặc middleware ở UI đã bảo vệ dữ liệu. CTFd không phải bộ lập lịch bot của OanTuTi. |
| [Battlecode About](https://battlecode.org/about.html): đội cải tiến autonomous player trong tháng, chơi scrimmage và tournament; yêu cầu upload bot/eligibility trước deadline; sprint thường single elimination, qualifier/final thường double elimination; seeding dựa scrimmage rating; final có khán giả trực tiếp và stream. | Workspace để luyện tập liên tục; phân biệt bot đang phát triển và bot đã chốt cho giải; eligibility checklist trước deadline; replay và trang trận độc lập với buổi trình chiếu. | Không suy ra Battlecode dùng Elo từ từ “rating”; không suy ra cơ chế resume, sandbox, công suất hay API chỉ từ trang About. Không kéo double elimination vào scope bốn thể thức đã yêu cầu. |

### 2.1 Kiến trúc thông tin đề xuất

**Public, không đăng nhập:**

- Danh sách giải và trang giải: thể thức, trạng thái, thời gian theo timezone có nhãn, luật, lịch/vòng, thông báo, liên kết standings/matches/replays.
- Standings: rank, tên đội công khai, W/D/L, điểm, tie-break theo thể thức, số trận đã tính, thời điểm snapshot, trạng thái tạm thời/đã chốt. Có tìm tên đội, lọc vòng và permalink.
- Matches: queued/running/completed/under-review/void; không hứa giờ bắt đầu chính xác khi queue chưa có ETA tin cậy. Link kết quả và replay sau publication policy.
- Match detail: đội, bot version công khai ở mức identifier/hash đã chọn, map/ruleset, series score, từng ván, nguyên nhân kết thúc, correction history. Không trả source, stderr riêng hay đường dẫn worker.
- Replay: URL bền vững; điều khiển play/pause/seek/speed; text move log và kết quả thay thế khi Canvas/WebGL không dùng được. Nhãn “đang phát lại” khác “đang thi đấu”.
- Projection: một chế độ hiển thị đọc dữ liệu public, không có quyền advance round/start engine. Tắt màn hình chiếu, đóng tab hoặc mất kết nối không được dừng giải.

**Đội thi:** đội/thành viên/eligibility; upload hoặc chỉnh bot; build log riêng; bot versions bất biến; chọn phiên bản cho practice và đăng ký giải; xác nhận version khóa; lịch sử trận; gửi clarification/appeal. Upload thất bại không làm mất bot active trước đó. Không yêu cầu Monaco hoạt động để có thể nộp bài: đường upload file vẫn là luồng chính thức.

**Giảng viên/ban tổ chức:** tạo giải theo wizard (thể thức → lịch → roster → maps/rules → scoring/tie-break → publication → resource budget → review); xem blockers trước publish; duyệt roster; khóa bot; preview pairings; vận hành queue; pause/resume; adjudication; xuất kết quả; đóng/archival. Mọi thay đổi có ảnh hưởng điểm cần lý do, preview phạm vi, audit record và revision; không chỉ một nút “reset” mơ hồ.

**Trạng thái bắt buộc ở mọi trang dữ liệu:** loading, empty, permission denied, not found, stale/disconnected, partial failure, retryable error, finalized. State phải đến từ dữ liệu server, không tự đoán completed vì animation đã hết.

### 2.2 Bảo mật khán giả ẩn danh — đề xuất

- Public read DTO chỉ chứa trường đã duyệt; không serialize nguyên entity quản trị.
- Replay là public nhưng code sinh viên vẫn private mặc định; chính sách sở hữu/quyền công bố source cần độc lập. [Battlecode](https://battlecode.org/about.html) có điều khoản quyền đối với submission riêng; đây là minh chứng cần chính sách, **không phải điều khoản được nhập tự động cho trường**.
- Private build logs không đặt cùng cache policy với public replay. Danh tính sinh viên chỉ đội có quyền và giảng viên có thẩm quyền đọc.
- Nếu có delayed publication/freeze, áp dụng một policy tới scoreboard, profile, match detail, replay, API và export. Với yêu cầu public mặc định, không bật freeze chỉ để tạo kịch tính.

## 3. Bốn thể thức: nguồn, lượng công việc và quy tắc đề xuất

### 3.1 Cơ sở chính thức

**Swiss:** [FIDE C.04.1, hiệu lực 01-02-2026](https://handbook.fide.com/chapter/C0401202507) quy định khai báo trước số vòng; không gặp lại cùng đối thủ; thông thường ghép người cùng điểm; nếu lẻ có pairing-allocated bye; không cấp bye tiếp cho người đã có bye hoặc đã nhận điểm tương đương một trận thắng mà không chơi; luật ghép phải giải thích được. Các điều khoản màu quân thuộc cờ vua, không tự động áp dụng cho bot game.

**Round robin:** [FIDE Berger tables](https://handbook.fide.com/chapter/C05Annex1) công bố lịch round-robin và dùng số lớn nhất làm bye khi số người lẻ. Đây là nguồn tham khảo lịch, không là luật xác định thắng/thua của OanTuTi.

**Tie-break:** [FIDE, hiệu lực 01-03-2026](https://handbook.fide.com/chapter/TieBreakRegulations032026), điều 4 yêu cầu danh sách tiêu chí có thứ tự; điều 8.1 định nghĩa Buchholz là tổng điểm đối thủ và cảnh báo không dùng nhóm Buchholz cho round robin; điều 9.1 định nghĩa Sonneborn-Berger là tổng tích điểm cuối đối thủ với điểm đạt được khi gặp họ. Điều 16 có quy tắc riêng cho ván không chơi, bye và forfeit; không thể chỉ coi đối thủ bye có điểm 0 rồi tuyên bố đúng FIDE.

**Rating:** [FIDE Rating Regulations](https://handbook.fide.com/chapter/B022024), điều 8.3, dùng chênh lệch kết quả thực và xác suất kỳ vọng, nhân hệ số K; FIDE dùng bảng xác suất cùng các quy tắc cụ thể về K và rating period. Điều 5.1 loại trận không chơi khỏi rating. Đây là nguồn tham khảo mô hình; công thức logistic/preset ở dưới là **đề xuất Elo-style riêng**, không tuyên bố triển khai rating FIDE.

### 3.2 So sánh định lượng — phép tính, không phải đo tải

Giả sử 500 đội hợp lệ, không rút lui, một cuộc đối đầu tính là một `match`, không có tranh hạng ba và playoff không hòa ở kết quả cuối. Mỗi match có `g` ván; chưa tính build, retry hay tiebreak thêm.

| Thể thức | Số match theo giả định | Tính chất vận hành — suy luận | Quyết định đề xuất |
| --- | --- | --- | --- |
| Single elimination | `N−1 = 499`. Bracket 512 chỗ có 12 bye; 9 tầng, vòng đầu 244 match thực + 12 bye. | Ít match; đội thua sớm ít cơ hội; match tầng sau phụ thuộc kết quả tầng trước. | Preset sprint và playoff. Bye không tạo ván giả, không cập nhật Elo. Công khai seeding và bracket trước chạy. |
| Swiss 9 → top 16 | `9 × 250 + 15 = 2.265` match; tổng ván cơ sở `2.265g`. | 9 barrier ghép vòng; một trận lỗi chưa giải quyết có thể chặn vòng kế. 9 vòng không chứng minh top 16 là “16 bot mạnh nhất” trong mọi trường hợp. | Preset giải chính: cơ hội thi đấu đều hơn elimination, ngân sách hữu hạn. Chốt số vòng trước mở giải; không tăng vòng giữa chừng để phá hòa. |
| Full single round robin | `500 × 499 / 2 = 124.750` match; lịch không cho một đội chơi hai match cùng vòng cần 499 vòng × 250 match. Double RR: 249.500 match. | Khối lượng tăng bậc hai; lượng replay cũng tăng tương ứng. Với bot bất biến, tính toán có thể chạy nhiều match của một đội đồng thời nếu spec cho phép; “vòng” không nhất thiết là barrier chạy thật. | Hỗ trợ đầy đủ nhưng UI phải hiện dự toán; block publish nếu vượt budget. Vòng bảng RR là cấu hình khác, phải mang tên khác. |
| Elo arena | Không có tổng tự nhiên. Nếu đúng 20 match mỗi đội: `500 × 20 / 2 = 5.000` match. | Không phải tournament bracket; hoạt động theo thời gian/quota, bị ảnh hưởng opponent selection, version updates và thứ tự cập nhật rating. | Preset luyện tập nhiều ngày; có lịch đóng, quota và điều kiện được xếp hạng chính thức. Không “chạy vô hạn đến khi người xem đóng trang”. |

**Tính thời gian dự kiến:** với `M` match, `g` ván/match, thời gian chiếm worker trung bình đo được `t`, `c` slot chạy và hiệu suất đo được `u`, thành phần chạy xấp xỉ `Mgt/(cu)`. Cộng riêng compile, startup, tiebreak, retry, barrier Swiss, I/O replay và dự phòng. Không gán `t`, `c`, `u` trước đo; công thức không chứng minh 500 đội hoàn thành trong một ngày.

### 3.3 Đặc tả chung cần chốt — đề xuất

- Một match dùng map/seed list cố định, chạy cặp ván đổi bên/đổi lượt đi đầu, cộng game points để xác định match outcome. Việc hai ván cùng đối thủ nằm trong **một encounter** là biến thể bot của Swiss; không gọi là hai vòng Swiss lặp đối thủ.
- Mặc định points của match: thắng 1, hòa 0,5, thua 0. Có thể lưu integer half-points để không phụ thuộc sai số số thực. Bracket phải có winner theo tie policy.
- Danh sách seed/map tiebreak hữu hạn công bố hoặc commit trước deadline. Nếu hết vẫn hòa trong elimination: dùng tiêu chí cuối xác định trước, ví dụ seeded draw có seed audit được; tuyệt đối không loop đến khi có winner. Thông báo rõ tiêu chí này có yếu tố ngẫu nhiên, không được giả làm đánh giá kỹ năng.
- Bot submission đã khóa và compile thành công là artifact bất biến: source hash, compiler/toolchain image digest, ruleset version, map hash, engine version, sandbox profile. Không resolve “latest bot” khi worker lấy job.
- Lỗi bot có verdict theo luật; lỗi hạ tầng là `retryable/under-review`, không tự cho đội thua. Retry chỉ lỗi hạ tầng, giới hạn attempt, cùng input/seed/version. Không retry bot timeout đến khi tình cờ thắng.
- Thay đổi kết quả sau vòng Swiss đã phát sinh cần workflow correction: pause, hiển thị affected rounds, quyết định giữ hay vô hiệu hóa descendants, tạo revision và công bố. Không sửa điểm ngầm hoặc tự ghép lại toàn giải.

### 3.4 Swiss và cắt top 16 — đề xuất cụ thể

- Ghép ưu tiên nhóm cùng điểm, không rematch; không chỉ sort rồi ghép hai hàng cạnh nhau vì có thể tạo rematch hoặc bế tắc. Phải có solver/thuật toán xác định và một chứng cứ giải thích các lần float nhóm.
- Mỗi vòng chỉ được chốt sau khi tất cả match có terminal adjudicated result; đội rút lui không nhận pairing mới. Bye do lẻ được lưu như kết quả không có đối thủ và không có replay.
- Tie-break preset đề xuất: match points → Buchholz → Sonneborn-Berger → số match thắng thực → drawing seed đã khóa. Chọn và phiên bản hóa **đúng cách tính unplayed rounds** theo điều 16 của nguồn FIDE hoặc công bố biến thể riêng đầy đủ; không lấy tên tiêu chí thay cho công thức.
- Việc phân hạng tại ranh giới 16/17 theo đúng danh sách đã công bố; nếu muốn có qualification playoff cho điểm bằng nhau thì phải lập ngân sách/lịch từ trước, không thêm ad hoc sau vòng cuối.
- Lưu pairing input snapshot, solver/version, tie-break contributions từng đối thủ, seed và kết quả. Người dự thi phải kiểm tra được vì sao đội khác đứng trên mình.
- Không khẳng định “FIDE-compliant Swiss” nếu chưa chọn đầy đủ hệ ghép và kiểm chứng các luật/ngoại lệ; dùng nhãn **Swiss cho bot, lấy nguyên tắc FIDE làm tham chiếu**.

### 3.5 Round robin — đề xuất cụ thể

Roster và artifact khóa trước lịch; mỗi cặp xuất hiện đúng một lần cho single RR; bye không tính là thắng. Điểm → Sonneborn-Berger → số thắng thực → tiêu chí cuối công bố. Không dùng Buchholz chỉ vì đã có từ Swiss.

Nếu một đội rút giữa giải, phải áp dụng một chính sách đã định trước cho toàn bộ kết quả của họ, thay vì trận đã chạy được giữ còn trận chưa chạy xử ngẫu nhiên. Preset có thể giữ kết quả hợp lệ đã chạy và ghi forfeits cho trận còn lại, nhưng scoreboard phải phân biệt actual/forfeit; thay thế bằng hủy toàn bộ chỉ khi luật giải đã chọn trước. Không tự âm thầm thay đổi sang chia bảng để giảm thời gian.

### 3.6 Elo arena — đề xuất cụ thể

Công thức riêng đề xuất:

`E_A = 1 / (1 + 10^((R_B − R_A)/400))`

`R'_A = R_A + K(S_A − E_A)`; cập nhật B đối xứng với cùng rating trước trận, `S_A ∈ {0, 0,5, 1}`. `S` là outcome **match/series**, không vừa rate từng game vừa rate lại match.

Preset khởi đầu để thảo luận: rating 1.000, K=32, provisional trước 20 match hợp lệ, tối thiểu 10 đối thủ khác nhau; các số này **không được nghiên cứu chứng minh là tối ưu**. Dùng một K chung trong preset để giữ zero-sum ở từng cặp; không copy K theo tuổi/danh hiệu của cờ vua.

- Matchmaking do server chọn; giới hạn lặp cùng đối thủ; cân bằng số match theo đội; đội không tự chọn đối thủ yếu để farm điểm.
- Bot mới tạo version lineage. Đề xuất rating thuộc đội-trong-season, giữ rating khi đổi version nhưng lịch sử ghi version ở từng match; giới hạn tần suất activate và đảm bảo phiên bản active mới không thay artifact của job đã cấp. Nếu muốn rating thuộc version thì phải thiết kế reset/cold-start và chống reset farming riêng, không trộn hai mô hình.
- Chạy theo batch: snapshot rating đầu batch, ghép đội theo quota, tính delta trên snapshot và commit một lần theo batch ID. Đây là **Elo-style theo kỳ**, tránh điểm cuối phụ thuộc tốc độ worker; không được gọi tương đương sequential Elo.
- Chốt arena khi hết window: ngừng cấp pairing mới, drain hoặc adjudicate toàn bộ job đã nhận theo deadline đóng đã công bố, đóng rating revision. Winner dựa snapshot final, không rating đang nhảy.
- Forfeit không chơi không rate theo preset; bot bị thua do vi phạm runtime trong trận có thể rate nếu luật đã định nghĩa là trận hợp lệ. Số played/rated/forfeit phải tách biệt.

## 4. Thực thi mã không tin cậy: isolate so với gVisor

| Khía cạnh | isolate — sự thật nguồn | gVisor — sự thật nguồn | Hệ quả đề xuất cho OanTuTi |
| --- | --- | --- | --- |
| Mục đích/ràng buộc | [README](https://github.com/ioi/isolate) mô tả sandbox cho chương trình thi đấu, dùng Linux namespaces và control groups. | [Security model](https://gvisor.dev/docs/architecture_guide/security/) mô tả Sentry triển khai System API để hạn chế tiếp xúc trực tiếp với host kernel; không phải VM có guest kernel. | Chọn theo threat model/toolchain, không xếp hạng “an toàn tuyệt đối”. Worker mã không tin cậy không cùng host chứa DB, signing secrets hay session keys. |
| Resource accounting | [Manual](https://raw.githubusercontent.com/ioi/isolate/master/isolate.1.txt): CPU time, wall time, file size, disk quota, process/thread count; `--cg-mem` giới hạn tổng cgroup. Multi-process cần cgroup để giới hạn thời gian/bộ nhớ thích hợp. | [Security model](https://gvisor.dev/docs/architecture_guide/security/) nói chống resource exhaustion dựa host cgroups; network policy phải áp dụng ở container level. | Compile và run có budgets riêng, memory toàn cây process, wall watchdog, CPU, PID, bytes output, disk+inode, cleanup. Chỉ kill parent không đủ tiêu chí nghiệm thu. |
| Network/filesystem | [Manual](https://raw.githubusercontent.com/ioi/isolate/master/isolate.1.txt): mặc định network namespace không có thiết bị ngoài loopback; `--share-net` bỏ lớp này; có bind directory rules và env allowlist. | [Security model](https://gvisor.dev/docs/architecture_guide/security/) cho biết app vẫn có thể đọc/ghi file được map và kết nối mạng nếu được phép. | Deny network cho bot lẫn compiler; chỉ mount input/toolchain cần thiết, không Docker socket/host home/env secrets. gVisor không tự mang nghĩa network off. |
| Giới hạn bảo vệ | isolate dùng cơ chế của host Linux theo [README](https://github.com/ioi/isolate). | [Security model](https://gvisor.dev/docs/architecture_guide/security/) nói không thay thế secure architecture, không bảo đảm chống hardware side channels, có trade-off performance/compatibility. | Vẫn cập nhật kernel/runtime, tách pool, hạn chế credentials và có incident recovery. Không công bố overhead/capacity nếu chưa đo chính workload bot. |
| Vận hành | [Manual](https://raw.githubusercontent.com/ioi/isolate/master/isolate.1.txt) yêu cầu box ID độc nhất khi chạy song song; init/run/cleanup; metadata riêng. | [Security model](https://gvisor.dev/docs/architecture_guide/security/) nêu mỗi kernel feature app dùng cần Sentry hỗ trợ. | Phải chứng minh box/UID reuse không rò dữ liệu, garbage collection sau crash và compiler/runtime tương thích. Không cộng chồng isolate+gVisor theo cảm tính nếu chưa kiểm chứng accounting/namespaces. |

### 4.1 Quyết định triển khai đề xuất

Dùng **isolate làm ứng viên baseline để thẩm định** vì giao diện quota/verdict hướng contest rõ; compile và run tách sandbox invocation/profile, worker nằm ở miền tin cậy khác portal. Không cho go-live chỉ vì thêm executable isolate vào command line. Nếu nhóm vận hành có chuẩn OCI và gVisor đã được hỗ trợ, đánh giá gVisor như ứng viên ngang hàng bằng cùng acceptance suite. Không chọn đồng thời hai backend runtime trong bản thiết kế đầu nếu không có nhu cầu thật.

Pipeline đề xuất: upload được lưu an toàn → validate archive/path/size nếu có archive → sandbox compile → kiểm tra artifact manifest/hash → queue match dùng artifact bất biến → sandbox run bot → authoritative engine xác minh action → finalize result/replay → publish read model. Source code, tên file và compiler output đều là input không tin cậy.

**Readiness gate bảo mật bắt buộc:** thử chương trình có fork/thread bomb, allocation vượt quota, infinite loop, ngủ vô hạn, stdout flood, disk/inode flood, truy cập host path, network, child còn sống sau timeout và compile-time resource abuse. Bằng chứng phải cho thấy portal/worker còn khỏe, job khác không đọc được dữ liệu nhau và credentials không xuất hiện trong sandbox/log. Đây là yêu cầu kiểm chứng tương lai, chưa thực hiện trong đợt nghiên cứu này.

## 5. UI framework, template và accessibility

### 5.1 So sánh nguồn tái sử dụng

| Phương án | Sự thật nguồn | Đề xuất sử dụng | Chi phí/rủi ro — suy luận |
| --- | --- | --- | --- |
| shadcn/ui | [Introduction](https://ui.shadcn.com/docs) nói phân phối actual component code có thể sửa; không phải package component truyền thống. [Blocks](https://ui.shadcn.com/blocks) có dashboard-01 với sidebar/chart/data table và sidebar-07. | Ưu tiên chọn lọc app shell, form, dialog, tabs, table; dashboard giải dùng số liệu thi đấu thật, không giữ card revenue/demo. | Code copy vào dự án trở thành phần phải bảo trì. Docs hiện đề cập cả headless dependency như Base UI; không giả định mọi block luôn dùng Radix. Pin implementation và kiểm dependency graph. |
| Radix Primitives | [Accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility): theo WAI-ARIA APG, xử lý role/aria, focus và keyboard; labels vẫn là trách nhiệm app. | Primitive cho dialog/menu/tabs khi chọn hệ Radix; label rõ và hành vi focus nhất quán. | Không phải dashboard template. Dùng primitive không chứng minh contrast, copy, live updates hoặc Canvas đã accessible. |
| Tabler | [Repository chính thức](https://github.com/tabler/tabler): HTML dashboard kit dựa Bootstrap 5, layouts/forms/tables, dark mode, có plugins bên thứ ba. | Tham khảo density, sidebar, trang danh sách và trạng thái empty/error. Có thể là lựa chọn thay thế trọn hệ nếu nhóm chọn Bootstrap, không ép dùng đồng thời. | Import cả template có nguy cơ đưa CSS/JS/plugin không dùng vào bundle; demo third-party assets cần rà license riêng. Không giả định code HTML chuyển nguyên thành React components đúng lifecycle. |

**Đề xuất:** một bộ tokens (màu, spacing, typography, focus, status), một bộ form primitives, một shell portal. Canvas chỉ cho visualization bàn cờ, không vẽ standings/form/navigation thành bitmap. Tránh chọn UI bằng số sao hoặc vì “nhìn chuyên nghiệp” mà không kiểm keyboard/error flows.

### 5.2 Patterns và tiêu chí accessible đề xuất

**Nguồn đã xác minh đầy đủ:** [W3C APG Table Pattern, source chính thức](https://raw.githubusercontent.com/w3c/aria-practices/main/content/patterns/table/table-pattern.html) phân biệt table tĩnh với grid widget, khuyến nghị HTML table native, `aria-sort` cho header đang sort; khi ẩn hàng/cột cần xem xét row/column count/index. [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility) nhấn mạnh accessible labels, keyboard và focus management.

**Nguồn W3C tìm được qua chỉ mục nhưng trang bị HTTP 403 khi đọc trực tiếp:** [Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html), [Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Chỉ mục chính thức xác nhận các chủ đề này; không dùng snippet làm căn cứ tuyên bố app đạt WCAG hoặc chép ngưỡng/ngoại lệ chưa đọc đủ. Tài liệu Understanding là giải thích, không thay normative WCAG.

**Acceptance đề xuất cho portal:**

- Standings native table có caption, column headers, sort button và `aria-sort`; pagination server-side/search; không biến mọi ô thành tab stop. Chỉ dùng virtualization sau khi chứng minh cần và kiểm semantics với screen reader.
- Status luôn có text/icon/label, không chỉ xanh-đỏ. Focus visible; sticky toolbar không che control đang focus. Dialog có title, mô tả hậu quả và trả focus về trigger.
- “Đã nhận bot”, “compile thất bại”, “kết nối gián đoạn” có vùng status hỗ trợ assistive technology; không cướp focus mỗi lần polling và không đọc to toàn bộ 500 dòng standings.
- Reordering live standings có nút tạm dừng cập nhật/áp dụng thay đổi; timestamp rõ. Đội đang đọc không bị nhảy hàng liên tục; link và query lọc ổn định.
- Replay có pause, tốc độ, next/previous turn, seek bằng bàn phím, mô tả trận và move log text. Giảm chuyển động theo lựa chọn người dùng; không tự phát âm thanh.
- Mobile: bảng có chiến lược ưu tiên cột/horizontal scroll có nhãn, không mất rank/team/points; controls đủ dễ chạm. Luồng tổ chức phức tạp được tối ưu desktop nhưng luồng xem công khai vẫn usable trên điện thoại.
- Kiểm thủ công bằng keyboard và ít nhất browser/screen-reader combinations được trường lựa chọn; kiểm automated chỉ là một phần evidence. Không gắn huy hiệu WCAG AA trước audit toàn bộ flow.

### 5.3 License và giới hạn tái sử dụng

| Thành phần | License đọc được | Ràng buộc và quyết định đề xuất |
| --- | --- | --- |
| shadcn/ui | [MIT](https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md) | Giữ copyright và permission notice trong bản sao/phần đáng kể. Code source được cung cấp “AS IS”; không có bảo đảm chất lượng của sản phẩm cuối. |
| Radix Primitives | [MIT](https://raw.githubusercontent.com/radix-ui/primitives/main/LICENSE) | Cùng nghĩa vụ giữ notices; lập inventory package/version. |
| Tabler core | [MIT](https://raw.githubusercontent.com/tabler/tabler/dev/LICENSE) | Không suy license core bao trùm mọi plugin/font/ảnh/logo hoặc gói trả phí. Duyệt từng asset trước copy; không dùng thương hiệu nhà cung cấp như thương hiệu trường. |
| isolate | [GPL-2.0-or-later](https://raw.githubusercontent.com/ioi/isolate/master/LICENSE) | Rà nghĩa vụ khi phân phối binary/image hoặc chỉnh sửa isolate. Đề xuất tích hợp như executable độc lập và lưu manifest nguồn/license; không tự kết luận license toàn portal bị đổi hoặc không có nghĩa vụ. Cần người phụ trách pháp lý duyệt phương thức phân phối. |
| gVisor | [Apache-2.0 và notices theo file](https://raw.githubusercontent.com/google/gvisor/master/LICENSE) | Giữ license, notices thích hợp và ghi thay đổi khi phân phối; file LICENSE cũng liệt kê một số file mang license khác. Apache license không tự cấp quyền trademark. |
| DOMjudge/CTFd/Battlecode | Trong nghiên cứu này chỉ dùng tài liệu làm nguồn UX, không tái sử dụng code/assets. | Không coi việc truy cập public là quyền copy template/source/branding. Nếu chọn fork, phải đọc license đúng repo/tag và dependencies ở bước quyết định riêng. |

Các dòng trên là tóm tắt nghiên cứu license, không phải tư vấn pháp lý. Đề xuất pin version/commit của mọi component được chọn, có third-party notices và người chịu trách nhiệm cập nhật. Không tải/copy template trong phạm vi hiện tại.

## 6. Production nhiều ngày: hợp đồng vận hành và readiness gates

Toàn bộ mục này là **đề xuất cho OanTuTi**, không là lời khẳng định DOMjudge, CTFd hay Battlecode có cùng kiến trúc.

### 6.1 Kiến trúc nhỏ nhưng có ranh giới thật

Một modular application cho auth/roster/tournament/results/public API, một lớp jobs bền vững, worker thực thi tách trust boundary, và kho artifact/replay bền vững là điểm xuất phát hợp lý. Không bắt buộc tách mỗi module thành microservice, không bắt buộc đổi database chỉ từ con số 500 đội. Chọn DB/queue theo transaction semantics, recovery và tải đo thực tế; “dùng SQLite” hoặc “dùng PostgreSQL” tự nó không là bằng chứng đạt hay không đạt production.

Hợp đồng job cần có `jobId`, `matchId`, `attempt`, lease owner/expiry, fencing token, pinned inputs, state transition version và terminal classification. Worker chết có thể được cấp lại job, nhưng **kết quả chính thức chỉ commit một lần**. Worker giữ lease cũ không được ghi đè attempt mới. Không tuyên bố queue exactly-once delivery; yêu cầu idempotent outcome là thứ có thể kiểm chứng.

Result, standings/rating update và replay readiness phải có quy tắc consistency: replay upload được xác minh checksum/manifest rồi mới đánh dấu playable; job đã xong nhưng chưa publish không biến mất. Transaction/outbox hoặc cơ chế tương đương phải có đường reconcile sau crash. Replay lifecycle/retention không được xóa evidence đang có appeal.

### 6.2 Bảng chặn phát hành

| Gate | Bằng chứng cần có trước mở giải | Hành vi không đạt |
| --- | --- | --- |
| G1 — Isolation compile/run | Threat model và profile; test hostile code ở cả hai pha; quota toàn cây process; network/filesystem deny; cleanup sau kill; audit secrets boundary. | Không nhận untrusted submissions lên môi trường có dữ liệu thật. Không lách gate bằng nhãn “sinh viên đáng tin”. |
| G2 — Correctness bốn thể thức | Fixtures cho odd roster, bye, withdrawal, draw, rematch avoidance, tie at 16/17, forfeits; tính lại điểm từ ledger ra cùng snapshot; Elo batch/version replay được. | Không cho publish thể thức chưa đạt; không quảng cáo hỗ trợ đầy đủ khi chỉ có bảng UI. |
| G3 — Durable recovery | Diễn tập kill worker giữa game/giữa upload/giữa commit, restart scheduler, lease expiry, duplicate delivery; không mất accepted upload, không double-score, không zombie. | Pause dispatch, giữ last-known public snapshot có nhãn stale, không sửa điểm bằng thao tác DB không audit. |
| G4 — Chạy nhiều ngày | Soak tương đương thời gian giải dự kiến có upload, build, gameplay, replay reads và log rotation; theo dõi disk/inode, memory, backlog, orphan artifacts; operator handover. | Không suy từ smoke test vài phút ra ổn định nhiều ngày. |
| G5 — Capacity và admission | Dataset 500 đội; workload bao gồm submission burst, concurrent builds, số game/match, spectators và replay egress; đo latency p50/p95/p99, throughput, queue age, saturation, headroom. | Không publish format vượt budget. Public spectators/concurrent users là biến tải riêng, không đặt bằng 500 một cách mặc định. |
| G6 — Backup/restore | Restore DB + artifacts đồng bộ lên môi trường sạch, kiểm hash và khôi phục accepted uploads/results; RPO/RTO được chủ giải duyệt và drill đo thực tế. | Không xem “đã có file backup” là restore thành công. Không hứa RPO=0 nếu thiết kế không chứng minh. |
| G7 — Visibility/authorization | Anonymous đọc đủ trang public/replay; không đọc source/log/PII; đội A không đổi bot/roster đội B; lecturer chỉ quản trị đúng scope; cache/export cùng policy. | Chặn public launch khi có leak; ẩn nút không là remediation đủ. |
| G8 — Trải nghiệm và accessibility | Hoàn thành upload→compile→register→lock→match→replay; wizard publish/recovery/adjudication; keyboard/screen reader/mobile; empty/stale/error states. | Không gắn production-ready cho dashboard có data mẫu hoặc thao tác không có backend outcome. |
| G9 — Vận hành giải | Runbook pause/resume, queue backlog, disk full, worker compromise, deadline outage, appeal, correction, finalization; audit và quyền operator; người trực và đường báo sự cố. | Không để đội thi tự đoán nộp bài đã nhận chưa; deadline không phụ thuộc clock browser. |

**Mục tiêu cần ghi số trong spec triển khai, không tự coi đã đạt:** thời gian phản hồi upload receipt/public pages, queue delay ở tải thiết kế, thời gian lease recovery, mức headroom, replay availability, RPO/RTO, retention và số spectator peak. Người triển khai phải lấy dự toán từ lịch giải và benchmark phần cứng/toolchain thật; tài liệu nghiên cứu này không có dữ liệu để đặt ra con số năng lực có căn cứ.

### 6.3 Workflow trưởng thành cần giữ

- Publish giải là hành động có review summary và blockers; bot lock có server timestamp/receipt và phiên bản được chốt. Mốc nhận upload, kết thúc compile và khóa bot phải là ba khái niệm khác nhau: luật quy định upload trước deadline nhưng build hoàn thành sau có hợp lệ không.
- Trước mỗi giai đoạn, snapshot roster/bot/rules/seed. Giảng viên nhìn thấy đội chưa sẵn sàng; không phải chờ engine crash mới biết thiếu bot.
- Pause scheduler không làm mất job đang chạy; UI hiển thị rõ drain hay cancel, tác động và quyền. Resume khôi phục từ state bền vững, không cần khán giả mở WebSocket.
- Appeals có cửa sổ và finalization. Kết quả final chỉ sửa qua correction revision có lý do; export có revision và timestamp để người nhận không nhầm các bản.
- Khi kết thúc giải: đóng writes theo policy, lưu public archive/replay theo retention, xuất bảng điểm; thông tin private giữ/xóa theo chính sách trường, không mặc định công khai mã sinh viên.

## 7. Giới hạn nghiên cứu và danh mục nguồn

### 7.1 Những điều chưa được chứng minh

- Không benchmark, triển khai sandbox, thử bot hay audit source hiện tại; không có số capacity/overhead, mức concurrency an toàn hoặc lời hứa hoàn thành 500 đội trong thời gian cụ thể.
- [Battlecode portal](https://play.battlecode.org/) trả shell HTML trong static reader; không kiểm được các màn hình authenticated bằng nguồn này. Dùng trang About cho kết luận, không suy bố cục ẩn hoặc trạng thái submission thực tế.
- URL CTFd `/docs/settings/visibility/` và Tabler `/ui/getting-started/introduction` trả 404; đã chuyển sang visibility-settings và repo Tabler chính thức. Không coi 404 của docs path là sản phẩm không có tính năng.
- FIDE URL dự đoán `C0401202602` trả mục lục chung, không đúng văn bản Swiss. Đã theo link từ mục lục tới `C0401202507`, kiểm tiêu đề/hiệu lực 01-02-2026. Đây là lý do không chỉ nhìn HTTP 200 hoặc slug để tin phiên bản luật.
- Trang WCAG/APG trên `w3.org` gặp 403. APG table được đọc qua repository W3C chính thức; các trang WCAG Understanding chỉ có kết quả chỉ mục và được đánh dấu như trên. Không tuyên bố đã đọc trọn normative WCAG 2.2 trong lần nghiên cứu này.
- GitHub raw/main/master/dev và docs latest có thể đổi; ngày truy cập không tương đương commit pin. Trước tái sử dụng code/luật, khóa phiên bản nguồn và lưu version vào quyết định thiết kế. Không dùng số sao, marketing counts hay lời tự giới thiệu “accessible” để chứng minh chất lượng.
- Luật FIDE thuộc cờ vua. Bot series, asynchronous scheduling và rating theo batch là thiết kế chuyển thể; cần fixtures và quy tắc riêng, không phải được FIDE chứng nhận.

### 7.2 Chỉ mục nguồn đã sử dụng

Tất cả truy cập **2026-10-13**, chỉ đọc; liên kết gắn trực tiếp vào từng factual claim ở trên.

1. [DOMjudge team manual, nhánh main](https://www.domjudge.org/docs/manual/main/team.html) — submissions, queue, verdict, scoreboard, clarification, freeze.
2. [CTFd Visibility Settings](https://docs.ctfd.io/docs/settings/visibility-settings) — public/private và tương tác account/score visibility.
3. [Battlecode About](https://battlecode.org/about.html) — bot competition, scrimmage, deadline/eligibility, format, terms.
4. [Battlecode portal](https://play.battlecode.org/) — static shell; hạn chế truy cập được ghi nhận.
5. [FIDE Swiss basic rules 2026](https://handbook.fide.com/chapter/C0401202507) — pairing, số vòng, bye.
6. [FIDE Berger tables](https://handbook.fide.com/chapter/C05Annex1) — lịch round robin.
7. [FIDE Tie-Break Regulations 2026](https://handbook.fide.com/chapter/TieBreakRegulations032026) — Buchholz, Sonneborn-Berger, unplayed rounds.
8. [FIDE Rating Regulations](https://handbook.fide.com/chapter/B022024) — kỳ vọng, K, rating period, unplayed games.
9. [isolate repository](https://github.com/ioi/isolate), [manual](https://raw.githubusercontent.com/ioi/isolate/master/isolate.1.txt), [license](https://raw.githubusercontent.com/ioi/isolate/master/LICENSE).
10. [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/), [license](https://raw.githubusercontent.com/google/gvisor/master/LICENSE).
11. [shadcn/ui introduction](https://ui.shadcn.com/docs), [blocks](https://ui.shadcn.com/blocks), [license](https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md).
12. [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility), [license](https://raw.githubusercontent.com/radix-ui/primitives/main/LICENSE).
13. [Tabler repository](https://github.com/tabler/tabler), [license](https://raw.githubusercontent.com/tabler/tabler/dev/LICENSE).
14. [W3C APG Table Pattern source](https://raw.githubusercontent.com/w3c/aria-practices/main/content/patterns/table/table-pattern.html).
15. W3C Understanding: [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), [pause/stop/hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) — chỉ mục đọc được, full-page 403; không là bằng chứng conformance.
