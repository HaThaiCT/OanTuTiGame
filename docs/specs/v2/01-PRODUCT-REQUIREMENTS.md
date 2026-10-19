# 01 — OanTuTi Arena v2: yêu cầu sản phẩm production

> Trạng thái: **Baseline thiết kế trước triển khai đã chốt**, ngày 2026-10-14; chưa triển khai/chứng nhận release.
> Chủ sản phẩm: giảng viên/đơn vị tổ chức. Quyết định người dùng được ghi ở [06](06-DESIGN-REVIEW-RECORD.md); các tham số kỹ thuật tại đây và [02](02-GAMEPLAY-TOURNAMENT-RULES.md) là lựa chọn của designer nay thuộc baseline, không ngụ ý người dùng đã duyệt riêng từng giá trị. Gates runtime/security/capacity vẫn bắt buộc trước release.
> **Override người dùng 2026-10-18:** Ban tổ chức và replay chính thức chỉ FULL ADMIN; khách/STUDENT không thấy menu/link và không truy cập page/API/download theo game hoặc digest. Public results/standings/live giữ nguyên. Private TEST của đội vẫn owner-only (ADMIN không được xem), viewer nằm trong workspace đội–giải. Yêu cầu này thay thế mọi câu cũ dưới đây gọi replay chính thức là public.

## 1. Định vị và phạm vi đã xác nhận

Nền tảng tổ chức thi đấu lập trình Bot dành cho sinh viên một trường đại học, với trải nghiệm tương tự cổng thi CTF/competitive programming. Giảng viên tổ chức; khoảng **500 đội trong một giải**; giải hoạt động tự động trong nhiều ngày. Khách **không cần đăng nhập** xem giải đã công bố, standings, bracket, trận đấu và replay. Trình chiếu là tùy chọn, không khóa tiến độ hay kết quả. Dừng công việc hiện tại ở nghiên cứu, thiết kế, đặc tả và kế hoạch; không viết code sản phẩm.

Vòng đời: tìm giải → lập đội → đăng ký → nộp code → kiểm tra hợp lệ → tự cập nhật Bot dự kiến → khóa → thi đấu → công bố → khiếu nại → lưu trữ. Mỗi đội khóa một Bot mỗi giải; không phần luyện tập.

### 1.1. Mục tiêu bắt buộc

| ID | Yêu cầu | Bằng chứng nghiệm thu |
|---|---|---|
| PR-01 | Một giải nhận và khóa được 500 đội hợp lệ | Diễn tập với 500 tài khoản đội, cạnh tranh nộp bài ở deadline |
| PR-02 | Bốn preset: loại trực tiếp, Swiss → playoff, vòng tròn, đấu trường Elo | Hoàn thành giải của từng preset, kết quả tính lại từ ledger trùng khớp |
| PR-03 | Hoạt động tự động 1–7 ngày; 7 ngày là mục tiêu vận hành đề xuất, không phải giới hạn phần cứng đã đo | Soak và khôi phục tiến độ không cần giữ trình duyệt admin |
| PR-04 | Khách xem public không đăng nhập | Truy cập deep link mới, live/replay/standings hoạt động; không thấy source/log riêng |
| PR-05 | Bot không tin cậy chỉ build/run trong sandbox cô lập, không trong process hoặc trust domain API/DB; cùng một máy vật lý Linux | Kiểm chứng sandbox thực và review độc lập trước mở nộp bài |
| PR-06 | Mọi kết quả gắn phiên bản Bot, map, ruleset, runtime và lần thực thi | Tra cứu đầy đủ provenance và replay có checksum |
| PR-07 | Worker/API bị dừng không mất lịch, không cộng điểm hai lần | Fault injection + đối chiếu ledger |
| PR-08 | UI responsive, sử dụng được bằng bàn phím, đọc kết quả không phụ thuộc màu | Kiểm chứng các hành trình trên desktop/mobile và WCAG 2.2 AA |
| PR-09 | Có migration, backup/restore, observability và quy trình sự cố | Diễn tập cutover, restore và runbook có người chịu trách nhiệm |

### 1.2. Không thuộc lần nâng cấp này

Không marketplace Bot, thanh toán/cá cược, mạng xã hội/chat công khai, native mobile, đa trường dạng SaaS thu phí, microservices toàn diện, ML training/GPU jobs hoặc nhiều game khác nhau. Không thêm Go/Java ngay: giữ Python, TypeScript, C++20 nhưng hoàn thiện pipeline cả ba. Không có giải pháp “chỉ nhận code tin cậy” thay cho sandbox khi công bố production.

ONLINE: tự đăng ký email/password và xác nhận email trước login, đội dùng mã chung để tham gia giải. LAN_OFFLINE: Admin cấp tài khoản username/password, kích hoạt và ghi danh đội trực tiếp, không SMTP/mã tham gia. Không SSO/MFA; khách viewing không account ở cả hai profile.

### 1.3. Hai chế độ triển khai — đã duyệt

- **LAN_OFFLINE đã duyệt:** Admin cấp tài khoản sinh viên; tắt self-registration, email verification và SMTP bắt buộc. Account có username/password, tên hiển thị và `activationMethod=ADMIN_ISSUED`, không tự điền email_verified_at. Mật khẩu tạm random riêng mỗi account, bắt buộc đổi lần đầu; credentials phân phối riêng. Recovery do Admin reset một lần/revoke sessions/audit. Admin duy nhất bootstrap local khi deploy không email link; không bypass ONLINE. UI/Monaco/SDK/compiler/images/font/maps/help bundle trước khi ngắt mạng; DB/storage/jobs local durable; guest chỉ reachable LAN.
- **ONLINE:** cùng topology một máy Linux, có thể đặt tại trường hoặc thuê một VPS Linux, HTTPS và tên miền; khách Internet xem public, team/admin auth, email verification/recovery qua mail provider. Bot build/run vẫn offline/no-network.
- Mode gắn deployment/network perimeter; giải lưu mode để công bố policy. Toggle UI không tạo VLAN/firewall hoặc ngắt Internet máy sinh viên. Mỗi deployment chỉ một máy vật lý/host Linux; không cluster, remote worker, standby, replication hoặc đồng bộ giữa deployments. Chuyển profile là maintenance có audit/kiểm tra auth và network, không request của client hoặc nút đổi mode của giải đang chạy.
- “Không Internet” chỉ giảm truy cập AI trực tuyến qua mạng thi, không chứng minh không dùng AI: local models/cache/4G/5G hoặc thiết bị khác ngoài khả năng ứng dụng kiểm soát. Cấm AI cần nội quy/thiết bị/giám sát bên ngoài; không quảng cáo AI-free guarantee hoặc tự thêm surveillance.
- **Đã duyệt host chỉ Linux**, không Windows/macOS/WSL/Docker Desktop. Client dùng browser trên OS được hỗ trợ. API, PostgreSQL, storage và execution pool nằm cùng host, sandbox tách process/trust domain với tài nguyên dành riêng; không yêu cầu hoặc đề xuất máy execution thứ hai. Preflight kiểm kernel/cgroupv2/runtime/isolation/resources và benchmark/admission/ETA; máy cá nhân không mặc nhiên đủ500đội. Distro/kernel/CPU/recovery phải được chứng nhận theo [05](05-SECURITY-OPERATIONS-QUALITY.md); mất máy/disk cần restore từ backup ngoài máy, không HA/zero-loss.


## 2. Vai trò và quyền

**Đã duyệt một ADMIN duy nhất**, là người tổ chức chung quản lý tất cả giải; tài khoản khác STUDENT. Không nhiều admin/phân công/promote; organizer là workspace, captain/member là quyền đội. ADMIN được đọc source và log **bài đã nộp** của mọi đội để hỗ trợ/review, không sửa source, thay Bot đã khóa hoặc giả danh đội; truy cập có audit. Không mở rộng quyền này tới draft chưa nộp trên thiết bị sinh viên.

| Hành động | Khách | Thành viên đội | Đội trưởng | Admin/Giảng viên |
|---|---|---|---|---|
| Xem giải public/kết quả/live | Có | Có | Có | Có |
| Xem/tải replay chính thức, thư viện Replay | Không | Không | Không | Có, FULL session |
| Xem giải nháp | Không | Không | Không | Mọi giải trong hệ thống |
| Xem source/log bài đã nộp | Không | Đội mình | Đội mình | Mọi đội, chỉ đọc, ghi audit; không public |
| Lưu/nộp code/kiểm tra hợp lệ | Không | Đội mình | Đội mình | Không giả danh đội |
| Chọn Bot thi | Không | Không chọn thủ công | Không chọn thủ công | Hệ thống tự chọn, không sửa source |
| Mời/xóa thành viên | Không | Không | ONLINE trước roster lock; LAN không | LAN provisioning trước lock; không âm thầm sửa roster đã khóa |
| Tạo/vận hành giải/mã mời | Không | Không | Không | Tất cả giải, không phụ thuộc người tạo |
| DQ/void/rejudge/finalize | Không | Không | Không | Lý do/impact/re-auth/audit |
| Quản lý tài khoản | Không | Không | Không | Admin duy nhất quản lý sinh viên; không tạo/mời/promote thêm Admin |

Một người có thể thuộc nhiều đội ở các giải khác nhau nhưng chỉ một đội trong một giải. Giảng viên không tham gia với tư cách thí sinh trong chính giải mình điều hành. Không xuất email, mã sinh viên, member IDs nội bộ, IP, session hay source trong public DTO. Trang đội public chỉ có tên, slug, avatar đã xử lý an toàn và thành tích; danh sách tên thành viên chỉ công khai khi từng người opt-in, mặc định ẩn.

## 3. Tổ chức, đội và danh tính

- Một deployment phục vụ một trường; dữ liệu nhóm theo Organization → Course → Tournament. Scope organization vẫn có khóa ngoại để ngăn truy cập chéo học phần; không hứa hỗ trợ multi-tenant hosting.
- **ONLINE:** sinh viên tự đăng ký email/password/tên hiển thị, PENDING_EMAIL→verified→ACTIVE rồi login; emailverified dùng recovery tự động. **LAN_OFFLINE:** chỉ Admin cấp username/password và kích hoạt, không self-register/email gate; activationMethod ADMIN_ISSUED không đồng nghĩa emailverified. Profile do operator chọn tại deployment, không client/tournament request tự đổi để bypass online auth. Registerrole luôn STUDENT, khôngpromote thêmADMIN; hash/session/authorization/re-auth vẫn bắt buộc.
- Một ADMIN duy nhất bootstrap khi deploy: ONLINE xác nhận email+thiết lập password; LAN local bootstrap+password không SMTP, activationMethod LOCAL_BOOTSTRAP. Không default secret; DB singleton cảpending/disabled, bootstrapidempotent. Đổi người tổ chức maintenance/audit/revoke tokens/sessions, không tạo ADMIN thứhai. Không tự chuyển account LAN thành ONLINEverified khi import.
- **Người dùng đã duyệt:** đội mặc định1–3thành viên; maxTeamSize do Admin đặt1–5 trước mở đăng ký, minTeamSize=1; không đổi giữa giải. Một sinh viên chỉ một đội/cùng giải. ONLINE invitation TTL48h/use-once; captain phải chuyển quyền cho thành viên còn lại trước rời, đội một người chỉ rời bằng đóng đội chưa admitted. Roster khóa cùng entry; concurrent invite accept enforce maxTeamSize nguyên tử. LAN chỉ workflow Admin ở dưới, không invitation/self-transfer.
- **LAN:** Admin cấp account, tạo/phân đội và **ghi danh trực tiếp vào giải**, không mã mời hoặc sinh viên xác nhận tham gia thêm. Gán members/captain trước roster lock; sinh viên không tự create/join/leave/invite/transfer. Bulk preview/validation/team limits/unique membership/admission trong transaction có audit; đội không được ghi danh không upload vào giải. Không chuyển source/entry khi chuyển người. **ONLINE** giữ tự tạo/tham gia đội và mã giải; roster đã khóa không thay âm thầm.
- **Đã duyệt Admin chốt số tài khoản và đội:** LAN Admin cấp chính xác danh sách account, mỗi account mật khẩu tạm random riêng và **bắt buộc đổi lần đầu**; limited change-password session không cấp quyền team/upload trước đổi. Admin đặt accountCapacity cho deployment và maxTeams/giải; ONLINE self-registration vẫn áp accountCapacity, không suy thành LAN provisioning cho online. Limits phải ≥số đã cấp/đã admitted, không giảm để âm thầm loại người; tăng cần resource preview/audit. Đóng đăng ký/chốt roster thuộc Admin, số N dùng autoSwiss/Elo là **đội approved có Bot hợp lệ sau drain/lock**, không maxTeams hay accountcount.500đội là mục tiêu capacity cần đo, không mặc định mọi giải hoặc bảo đảm vượt500; overload chặn start/cảnh báo, không tự đổi luật hoặc loại đội.
- Tên public 3–64 ký tự, escape khi render; không dùng tên làm ID. Định danh UUID; slug đổi không làm mất deep link canonical theo ID.
- **ONLINE dùng một mã chung mỗi giải**; captain nhập mã hợp lệ trong cửa sổ đăng ký, server kiểm roster/capacity rồi APPROVED. Rotation/revoke chỉ chặn đội mới, không kick đội cũ. **LAN không cần mã:** Admin ghi danh đội trực tiếp với cùng kiểm tra roster/capacity và audit, không tạo mã vô dụng. Public viewing không cần mã/account ở cả hai profile.

## 4. Vòng đời và hành trình

### 4.1. Giảng viên

Wizard: thông tin & quyền công bố → lịch theo múi giờ → thể thức & luật → map pool/runtime → điều kiện tham gia → quota/capacity preview → review & publish. Preview hiển thị tổng encounter/game tối thiểu/tối đa, estimated completion dựa trên benchmark thật, không chỉ số đội.

Publish tạo URL công khai và immutable rule revision. Trước mở đăng ký có thể tạo revision mới; lúc mở đăng ký pin revision gồm policy versions, quotas, maps/commitment, runtime và source/public policy. Sau mở chỉ sửa mô tả không ảnh hưởng luật; không thay ruleset/map/pool/runtime/seeding/scoring/quotas bằng re-accept âm thầm. Nếu cần đổi luật, hủy giải có thông báo/audit và tạo giải mới. Ngoại lệ duy nhất về lịch: gia hạn submissionClosesAt trước cutoff cũ bằng receipt/audit/thông báo, không rút ngắn hoặc mở lại intake sau cutoff. Appeal window chỉ được gia hạn có audit/thông báo, không rút ngắn sau mở; resolved N/R/T/E được chốt sau drain theo policy đã pin, không là đổi luật.

Dashboard điều hành: tình trạng vòng, đội hợp lệ, pipeline submission, queue age, worker health, retries, kết quả provisional và thao tác có hậu quả. Mỗi nút hiển thị tác động, không gom mọi hành động thành “Run”. Pause chỉ ngừng claim công việc mới; game đang chạy kết thúc. Emergency stop hủy sandbox đang chạy, kết quả chưa commit là lỗi hạ tầng và không phạt đội.

**Đã duyệt Admin phải bấm Bắt đầu cho mọi giải.** Đóng intake/kiểm tra/khóaBot/công bốmap không tự chạy trận chính thức. Hệ thống chuyển Sẵn sàng và hiển thị blockers/cấu hình/ETA; Admin xác nhận mới bắt đầu, ghi receipt/audit. Sau start tự vận hành vòng/epoch khi đủ điều kiện, không cần tabAdmin; restart không bắt đầu giải chưastart. Baseline ETA trướcstart là duration dự kiến; estimatedCompetitionEndsAt lấy actualstartedAt, liveETA cập nhật riêng. Test private không bị chặn vì chưastart.

### 4.2. Đội thi

1. Đọc luật và thời gian bằng giờ địa phương, luôn kèm timezone và giờ server.
2. ONLINE tạo/tham gia đội; captain nhập mã chung để ghi danh, xác nhận rule revision/source/public policy. LAN Admin tạo/phân đội/ghi danh trực tiếp, không mã hoặc xác nhận thêm. Đội APPROVED đủ quyền mới nộp bài, không nhập lại mã khi nộp phiên bản mới.
3. **Đã duyệt giữ cả IDE trên web và upload code**: sinh viên có thể soạn trực tiếp hoặc tải source từ máy cá nhân. Hai luồng dùng cùng pipeline nộp/kiểm tra, receipt ordinal/hash và deadline; lưu draft không tự nộp, IDE không thêm luyện tập hoặc thực thi code trong browser.
4. Submission validate → compile → INIT-smoke → READY hoặc REJECTED. Lưu nháp không là nộp; READY tự cập nhật Bot dự kiến nếu đây là bản nộp hợp lệ mới nhất của đội trong giải.
5. Hệ thống tự chọn theo submissionOrdinal server cấp khi nhận bài; không theo thời điểm compile xong. UI hiện Bot dự kiến/hash/bản đang xử lý; không nút Chọn thi. Bản mới lỗi hoặc còn pending không thay bản READY cũ.
6. Hết hạn intake đóng, drain bài đúng hạn rồi khóa một official Bot/đội; không đổi official artifact. **Chạy thử được dùng mọi thời điểm**, kể cả drain/running/paused/finalized/archive, nếu account/team có quyền và service/profile sẵn sàng; không phụ thuộc hạn nộp. Draft sửa sau hạn chỉ test, không eligible submission.
7. Trong giải xem lịch, trận, kết quả, log riêng đã lọc và tình trạng hệ thống. Gửi yêu cầu hỗ trợ/khiếu nại có match ID.
8. Sau giải xem phân tích: nguyên nhân thua, map/side, timeout/illegal move; tải replay và kết quả CSV không chứa PII.

### 4.3. Khách

Vào trang giải → xem lịch/trạng thái/luật → standings/bracket → trận live/replay. Không buộc đăng nhập để xem; URL giữ filter/page/round/turn. Submission source và log kiểm tra hợp lệ không nằm trong discovery public.

### 4.4. Công khai không có nghĩa công khai mọi dữ liệu

Official public theo visibility giải, source/log bài nộp chỉ đội và ADMIN read-only/audit. Test snapshots/results/replays private theo team, không public discovery hoặc match-ID bypass; không practice tournaments/leaderboards. ADMIN đọc bài nộp không bao gồm draft chưa nộp.

## 5. Submission và kiểm tra hợp lệ

- Nhận đơn tệp và dự án nhiều tệp Python/TypeScript/C++20, không Go. Upload source/ZIP hoặc workspace Monaco có cây tệp/tabs/entrypoint; không terminal/debugger/extensions tùy ý. Chỉ tệp dự án, thư viện chuẩn và SDK pin sẵn; build cố định, không scripts/Makefile/package tải mạng. Baseline limits: tối đa128regularfiles (kể cả manifest),256KiB/tệp,4MiB tổng source bytes/giải nén cho mọi luồng, riêng ZIP nén tối đa2MiB; manifest chứa language/entrypoint/SDKversion, không lệnh thực thi. Path/extraction validation theo05, áp dụng cả TEST; chứng nhận cả3toolchains trước launch, không tự tăng limits để chạy test pass.
- **Người dùng đã duyệt dependency policy:** chỉ import các tệp source của dự án, thư viện chuẩn của runtime và SDK hệ thống đã pin; không pip/npm install, package registry/Internet, dependency tùy ý hoặc vendored third-party package để lách giới hạn. Có thể tổ chức thuật toán tự viết thành nhiều module. SDK/toolchain fixed và công bố, áp dụng giống nhau cho TEST và OFFICIAL.
- Source đã nhận bất biến, lưu hash SHA-256; edit tạo submission mới. TypeScript được compile ở build sandbox trước, không chạy `tsx` để biên dịch trong lượt thi.
- Baseline quota mỗi đội/giải:10official receipts trong rolling60phút,100 trong ngày UTC, tối đa2compile pending/running; không namespace luyện tập riêng. Request bị reject trước receipt không tiêu official receipt quota; retry/idempotency cùng receipt không đếm thêm.429+Retry-After; quotas pin lúc mở đăng ký, capacity preview trước publish. Private TEST có quota riêng dưới đây.
- Pipeline validate/compile/INIT-smoke chỉ kiểm bài đáp ứng toolchain/giao thức, không đấu với baseline hoặc bài khác, không tạo trận/replay/điểm luyện tập. Nhiều bản nộp trước hạn không có nghĩa nhiều Bot được khóa: entry chỉ tham chiếu một bản cụ thể.
- **Đã duyệt:** nhận bài trước hạn, kiểm tra xong rồi mới khóa. `receivedAt` do server cấp trong transaction receipt sau khi nhận đủ bytes và lưu source bất biến bền vững, phải `< submissionClosesAt`; bắt đầu upload/click trước hạn nhưng nhận đủ sau hạn không hợp lệ. Receipt lưu ordinal tăng nguyên tử theo team/giải, không theo build completion.
- Hết hạn đóng intake, cố định tập submission đủ điều kiện và tiếp tục compile/INIT-smoke dù READY sau hạn. Khi mọi bài trong tập có READY/REJECTED, tự khóa max ordinal READY mỗi đội; bản lỗi giữ bản hợp lệ cũ. Lỗi hạ tầng/BLOCKED chưa giải quyết **hoãn khóa**, báo organizer, không tự loại đội hoặc lấy bản cũ bỏ qua bài pending. Không READY sau xử lý hết thì không eligible entry. Không mở lại intake hay sửa source trong drain; manual lock không bỏ qua bài đúng hạn. Sau khóa không thay version/artifact.

### 5.1. Chạy thử riêng tư trong workspace — đã duyệt

Chạy thử dùng snapshot toàn dự án/draft hoặc submission cũ của chính đội, đối đầu baseline hệ thống hoặc snapshot/submission khác của chính đội. Snapshot test có namespace/receipt/hash riêng, **không submissionOrdinal**, không eligible intake set, không tự tạo bài nộp READY/auto-candidate, không thay Bot frozen. Draft sửa tiếp không đổi test đang chạy. Build và match sandbox trên server với ruleset/profile của giải; không browser execution. Replay/trạng thái/source/log chỉ đội xem; public discovery/WS/HTTP/download không truy cập được. Quyền ADMIN đọc bài đã nộp không tự mở rộng tới draft/test snapshot chưa nộp. Không Elo/points/standings/official-result ledger; không dùng Bot đội khác. Dùng cùng engine/runner nhưng phân loại TEST rõ ràng, event không vào official reducers. Không hệ thống luyện tập/giải/leaderboard riêng.

Chạy thử mọi thời điểm trước/sau deadline/lock/kết thúc; quota/service readiness/permission vẫn áp dụng, không cam kết tức thì hoặc uptime100%. Mỗi test một ván; baseline2test requests pending/running/đội/giải (gồm build+game),30accepted tests/ngày UTC, không đếm retry cùng receipt. Official/build đúng hạn ưu tiên. Snapshot sau deadline chỉ test, không submissionOrdinal/eligible drain/frozen entry. Không promote TestReceipt thành bài đúng hạn; official sau cutoff luôn từ chối. Upload tách Import để sửa/test và Nộp chính thức. Hidden pool trước reveal chỉ cho test trên map công khai thay thế theo02GP-03.

## 6. Giao tiếp và quản trị thi đấu

ONLINE email activation/recovery bắt buộc qua outbox; mail lỗi không bypass verification. LAN không SMTP/email gate: creation/reset do ADMIN có audit, credentials riêng; announcements nội bộ, không team invitations sinh viên. Mã giải ONLINE phân phối riêng không public; không livechat/SSO.

Round/epoch tựSEALED sau grace10phút từlastTerminalAt nếu khôngblocker; **chỉ stage cuối của toàngiải** PROVISIONAL chờ ADMINfinalize. SwissSEALED→playoff tựactivate, không cần Adminstart/chốt lầnthứhai. finalAppealWindowMinutes integer0–10080 default1440 pintrướcregistration; deadline từfinalStageProvisionalAt. Dispute gửi ngay từresult; window0 vẫn giữdisputeđãmở. Serializecreate-dispute/finalize; chỉfinalizehếtwindow/noopendispute/infra/integrity, khôngtimer/restart/Adminoverridechampion. Sau mở chỉgia hạn appeal cóaudit/thôngbáo, khôngrútngắn; correctionfinalized cầnexplicitreopen/revision/audit. Publicprovisional/replay khôngchờfinalize.

Anti-cheat học thuật: đội xác nhận quy tắc hợp tác và nguồn code. Công cụ similarity (nếu trường có) chỉ cung cấp tín hiệu, không tự loại đội; quyết định có bằng chứng riêng, quyền khiếu nại, audit. Không công khai cáo buộc hoặc source giữa đội.

## 7. Thành công và chống mục tiêu sai

Chỉ số sản phẩm: tỷ lệ đội có submission READY, thời gian đến bản nộp hợp lệ đầu tiên, lỗi submission theo nguyên nhân, lỗi hạ tầng trận, thời gian tìm replay và hoàn thành giải đúng hạn. Telemetry không ghi code/password/token/email.

Anti-goals: UI đẹp nhưng không biết bài nào được chốt; rating thay đổi theo tốc độ worker; giải chỉ chạy khi tab admin còn mở; source code chạy cạnh database; ghi “production-ready” dựa vào unit tests; tạo 500 đội nhưng không đo khối lượng trận.

## 8. Baseline, giao diện và nghiệm thu

Baseline dùng shadcn/ui+Tailwind+brackets-viewer.js, dark navy/violet/cyan, responsive và bàn phím; Monaco multi-file cho IDE. Không mua template hoặc thêm WordPress/Bootstrap stack. Người dùng cho phép copy/adapt code của các vendor/platform đã nêu; lưu provenance/notices/phạm vi, không suy thành quyền dùng ảnh/logo/font hoặc tự cài dependency. Chi tiết trải nghiệm/asset authority theo04 và06.

01 xác định scope/quyền/hành trình;02 là authority công thức, pairing, scoring và champion;03 là authority dữ liệu/API;05 là authority isolation/quality gates;06 phân biệt user decisions và designer defaults. Mỗi tournament pin các policy IDs/version cùng rule revision; thay default trong release tương lai chỉ áp dụng giải chưa mở, không sửa lịch sử. Nếu implementation khác baseline, chặn release/tournament start và sửa implementation hoặc tạo baseline revision minh bạch trước đăng ký; không chọn tùy ý giữa hai công thức. Những lựa chọn source/languages/UI/provisioning/single-host không còn mở. Chứng nhận runtime, security review, measured capacity/ETA, restore drills và operator secrets/domain/SMTP/offline bundle vẫn là prerequisites thực tế, không được tài liệu này tự chứng nhận.

| Kịch bản nghiệm thu trước release | Kết quả bắt buộc |
|---|---|
| LAN cấp hai account rồi ghi danh đội; một account chưa đổi mật khẩu | Không SMTP/mã mời; limited password session không upload/team access; sau đổi mới cấp quyền |
| ONLINE chưa verified hoặc hết accountCapacity | Không login/team/upload; không dùng LAN activation để bypass; guest vẫn xem public |
| Receipt ordinals10/11/12 đúng hạn, build hoàn tất12REJECTED→11READY→10READY sau hạn | Drain xong khóa11; infrastructure pending hoãn lock; không theo completion order |
| Workspace nhiều tệp và ZIP cùng project; imports ngoài policy hoặc vượt cap | Cùng hash/provenance canonical và validation; source chưa nộp/test không public hoặc ADMIN draft access |
| TEST sau lock/archive và official upload sau cutoff | TEST riêng tư có quota, không sửa Bot/điểm; official bị từ chối; hidden map không lộ trước reveal |
| Khóa/reveal hoàn tất nhưng chưa bấm Bắt đầu; restart | Không official dispatch; Admin start idempotent mới mở gate; tab đóng không ngừng giải |
| Kết thúc với appeal0 và dispute đang mở hoặc infra unresolved | Giữ PROVISIONAL; không timer award; finalize chỉ khi mọi blocker đã xử lý |

Đây là hợp đồng nghiệm thu tương lai, không báo cáo đã chạy các kịch bản. Các gates kỹ thuật ở05 giữ nguyên và phải có evidence trên host/profile release thực tế.
