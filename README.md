# OanTuTi Arena

Website thi đấu Bot OanTuTi: Next.js/React, Fastify/WebSocket, PostgreSQL 16, bàn cờ và replay. Engine/supervisor Rust có cổng kiểm chứng riêng.

> **Chưa chứng nhận production:** bộ Docker dưới đây chạy control plane v2, không bật thực thi mã Bot. Không dùng `OANTUTI_DEV_EXECUTION=1` để thay thế sandbox trên một website công khai.

**Phạm vi bàn giao hiện tại:** phần mềm LAN, không provision/cấp máy, không infrastructure test, soak 72h hay rehearsal 7 ngày. Các việc đó chỉ là khuyến nghị triển khai tương lai; không có nghĩa release đã được chứng nhận hoặc capacity/ETA/RPO/RTO đã đạt.

## 1. Cài trên máy cá nhân hoặc VPS Linux

Cùng bộ Compose cho hai nơi: PostgreSQL → API → Next.js → nginx. Chỉ gateway bind loopback theo mặc định. Không có ứng dụng desktop/mobile riêng.

Đọc [runbook bàn giao LAN](docs/runbooks/lan-handover.md) để vận hành, sao lưu, xử lý sự cố và nghiệm thu; [khuyến nghị hạ tầng](docs/runbooks/infrastructure-recommendation.md) để chọn máy/phần mềm; [hướng dẫn triển khai và bằng chứng kiểm thử](docs/implementation/rebuild/portable-deployment.md) cho chi tiết đóng gói. Cần Docker Engine và Compose; tạo hai file mật khẩu ngẫu nhiên khác nhau ngoài checkout, rồi đặt đường dẫn:

```bash
export PG_OWNER_PASSWORD_FILE=/absolute/private/path/postgres-owner
export PG_APP_PASSWORD_FILE=/absolute/private/path/postgres-app
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
export OANTUTI_BACKUP_FENCE=off  # chỉ demo không nhận code sinh viên; vận hành thật dùng enforce + backup hợp lệ
docker compose config --quiet
docker compose up --build -d
```

Mở http://127.0.0.1:3000. Không publish cổng PostgreSQL/API. VPS mặc định truy cập qua SSH tunnel; HTTPS, tên miền, mail ONLINE, sandbox và backup ngoài host phải được cấu hình/kiểm chứng trước khi mở dịch vụ công khai.

```bash
docker compose ps
docker compose logs -f server web gateway
curl --fail http://127.0.0.1:3000/api/v2/tournaments
docker compose down  # giữ named volumes
```

**Không dùng `down -v` với dữ liệu thật.** PostgreSQL `arena-postgres` giữ ledger v2, `arena-storage` giữ source/replay; sao chép riêng storage không phải backup v2 đầy đủ. Khởi tạo schema chỉ chạy với volume trống; nâng cấp volume hiện có cần migration được duyệt và backup đã kiểm tra.

## 2. Workspace phát triển và demo

[Demo và test](docs/implementation/rebuild/demo-and-tests.md) mô tả stack dev đang có, biến PG, tài khoản demo và cách chạy suite. Suite có thể re-seed DB; không trỏ nó vào dữ liệu triển khai.

Đặc tả: [v2](docs/specs/v2/README.md). Trạng thái/bằng chứng: [rebuild ledger](docs/implementation/rebuild/progress.md). Các mục lịch sử bên dưới mô tả API/SDK v1, không phải chứng nhận deploy v2.

## 3. Giao diện LAN v2

- ADMIN cấp tài khoản/đội và direct-enroll; không tự đăng ký, không mật khẩu admin mặc định. STUDENT đăng nhập bằng tài khoản được cấp và kích hoạt theo policy.
- Workspace đội: source/Monaco nhiều tệp, bài nộp chính thức, diagnostics và private TEST. Private TEST chỉ đội sở hữu, không ảnh hưởng điểm chính thức.
- ADMIN mở đăng ký, khóa cấu hình, chủ động Bắt đầu khi readiness/capacity hợp lệ, xử lý dispute/correction và finalize. Không cần giữ tab mở để scheduler tiến giải.
- Public SSR: giải đã công bố, standings, bracket và kết quả/live. **Official replay chỉ FULL ADMIN**, không phát replay qua renderer bracket. Private TEST replay theo quyền chủ đội.
- Sơ đồ elimination/playoff dùng **brackets-viewer.js 1.9.1** từ npm lockfile (npm khai báo ISC nhưng tệp LICENSE đi kèm là **MIT**; bản copy nội bộ giữ đúng tệp LICENSE đó); JS/CSS/LICENSE được copy nội bộ bởi predev/prebuild, không CDN. Mỗi sơ đồ ở document client riêng, dispose khi dữ liệu đổi/unmount; danh sách accessible vẫn giữ EMPTY/BYE/WALKOVER/DOUBLE_WITHDRAWAL theo server. Swiss/Elo không vẽ bracket giả, mỗi cửa sổ tối đa 16 ô.
- Monaco và assets renderer phục vụ cục bộ; không cần Internet trên browser LAN. Cách build/restart và biến môi trường xem runbook.

## 4. Luật chơi

Mỗi quân đi một ô theo 8 hướng vua trên các ô hợp lệ. Không đi vào đồng minh, quân địch cùng loại hoặc quân khắc chế mình.

| Quân | Ăn | Thua |
| --- | --- | --- |
| Búa — nắm đấm | Kéo | Bao |
| Kéo — hai ngón chữ V | Bao | Búa |
| Bao — bàn tay xòe | Búa | Kéo |

Các điều kiện kết thúc: tuyệt diệt một chủng loại của đối phương, chiếm hoàng tòa đối phương, đối phương hết nước đi, hoặc bot phạm quy/quá giờ/crash. Giới hạn mặc định 300 lượt; khi chạm giới hạn, phân định theo quân số rồi điểm tiếp cận hoàng tòa, cuối cùng hòa.

## 5. Viết bot Python, TypeScript, C++20

Giao thức STDIO NDJSON: nhận một JSON trên mỗi dòng stdin; trả đúng một JSON kết thúc bằng newline trên stdout. `INIT` yêu cầu `{"status":"READY"}` trong 1.000ms. `TURN` yêu cầu `{"action":"MOVE","piece_id":1,"target":[2,3]}` trong ngân sách 100ms (runner có 5ms grace). Log debug viết vào stderr, không stdout.

SDK mẫu:

| Ngôn ngữ | SDK | Điểm vào bot mẫu |
| --- | --- | --- |
| Python | `sdk/python/oantuti.py` | `sdk/python/starter_bot.py` |
| TypeScript | `sdk/typescript/oantuti.ts` | `sdk/typescript/starter_bot.ts` |
| C++20 | `sdk/cpp/oantuti.hpp` | `sdk/cpp/starter_bot.cpp` |

Python: kế thừa `Bot`, override `on_init(ctx)` và `on_turn(ctx)`, dùng `ctx.get_legal_moves()`, rồi gọi `.run()`.
TypeScript: triển khai `BotHandler`, dùng `ctx.getLegalMoves()`, gọi `runBot(handler)`.
C++20: kế thừa `oantuti::Bot`, override `on_init` và `on_turn`, trả `std::optional<MoveAction>`, gọi `.run()`.

```bash
# Đấu bằng SDK; runner tự biên dịch .cpp nếu chưa có binary hoặc source mới hơn
npm run match:play -- \
  --map docs/specs/maps/sample-donut.map.json \
  --white sdk/python/starter_bot.py \
  --black sdk/cpp/starter_bot.cpp \
  --replay /tmp/python-vs-cpp.oantuti

# Sau khi sửa header C++, tự biên dịch lại để tránh binary cũ
# (cơ chế hiện tại chỉ so mtime file .cpp)
g++ -std=c++20 -O3 -I sdk/cpp sdk/cpp/starter_bot.cpp -o sdk/cpp/starter_bot
```

Binary được tạo cạnh source nên thư mục đó cần quyền ghi. SDK/header phải đi kèm khi bot import/include chúng; code inline trong IDE nên tự chứa các thành phần cần thiết.

## 6. Kiến trúc repository và API v2

- `packages/server`: Fastify control plane, PostgreSQL ledger, scheduler, immutable object/result và role ACL.
- `packages/web`: Next.js SSR/React portal, workspace, organizer, Canvas live/replay và bracket presentation.
- Rust workspace: engine, verifier và execution supervisor; TypeScript local runner là công cụ SDK/dev, không thay sandbox cho code không tin cậy.
- `packages/protocol`, `sdk/`: wire format và SDK ba ngôn ngữ.
- `docs/specs/v2/`: authority sản phẩm/luật/dữ liệu/UI/security; không xem tên baseline là bằng chứng đã nghiệm thu.

API mới nằm dưới `/api/v2`; public discovery không phụ thuộc máy chiếu. Route legacy `/api/auth/register` bị tắt mặc định; không dùng hướng dẫn PLAYER/self-registration/anti-spoiler v1 cho LAN v2. Runbook chứa quy trình operator và quyền replay hiện hành.

## 7. Kiểm tra phát triển (không chạy trong lượt bàn giao này)

```bash
# Trước suite có server: PGHOST/PGPORT/PGUSER tới DB test cô lập; không dùng DB demo/production.
export PGDATABASE=arena_example_test
npm test
npm run test:engine
npm run test:runner
npm run test:protocol
npm run test:web
node --import tsx deploy/linux/test-isolated.mts packages/server
npm run build --workspace=@oantuti/web
# Load/infrastructure probes chỉ là khuyến nghị riêng, không yêu cầu trong delivery này.
```

Fuzz suite so sánh SHA-256 canonical trace của các lần chạy cùng seed trên cùng runtime; chưa chứng minh tính đồng nhất trên mọi CPU/runtime hay SHA-256 toàn bộ replay `.oantuti`.
Load benchmark hiện là phép đo ngắn trên loopback, client/server cùng tiến trình: không thay thế soak test 60 phút, kiểm tra memory leak dài hạn hoặc đo qua mạng thật. Không lấy một lần chạy làm chứng nhận SLA production.

Các số test/smoke v1 lịch sử không được dùng làm bằng chứng v2 hiện tại. Chỉ báo cáo các checks thực sự đã chạy cho revision tương ứng; xem ledger/bằng chứng có scope rõ ràng.

Nếu máy báo `docker: unknown command: docker compose`, cần cài Docker Compose v2 plugin theo hệ điều hành hoặc dùng standalone Compose v2. Lần smoke test dùng standalone `/tmp/oantuti-docker-compose` vì host chưa có plugin; không thay đổi cài đặt Docker của host.

## 8. Giới hạn trước khi triển khai công khai

Cần cấu hình HTTPS/origin, sandbox riêng cho code không tin cậy, backup/fence và quyền ADMIN/STUDENT trước vận hành thật. Không có admin password mặc định hay public self-registration trong LAN v2; kết quả công khai không bị khóa bởi projector. Compose không tự biến API thành execution sandbox.

Không suy trạng thái dependency vulnerabilities từ một lần `npm ci` cũ; audit/support và chứng nhận host là công việc triển khai được cho phép riêng, không phải bằng chứng hay yêu cầu infrastructure test của delivery này.

## 9. GitHub Actions CI/CD

Workflow: `.github/workflows/ci.yml`.

| Sự kiện | Kiểm tra | Publish image |
| --- | --- | --- |
| Pull request | `npm ci`, toàn bộ tests, typecheck/build Web, Compose config, build server/web image | Không |
| Push vào `main` | Như pull request | Không |
| Chạy thủ công qua Actions | Như pull request | Không |
| Push tag `vX.Y.Z` hoặc `vX.Y.Z-rc.1` | Như pull request; validate tag | GHCR, sau khi job verify thành công |

Pipeline dùng Ubuntu 24.04, Node.js 24, Python 3.12 và G++ của runner. Hai image build riêng bằng matrix, target `linux/amd64`. Không tạo release tag, tự deploy, chạy Security Pentest hoặc tự nâng cấp dependencies. Không có tag `latest` tự động.

Các action được pin theo commit SHA. Token mặc định chỉ đọc repository; chỉ job `release` có `packages: write`. Job này chỉ chạy khi push tag, sau khi `verify` và cả hai Docker builds thành công. PR dùng `pull_request`, không dùng `pull_request_target`; job build PR không có quyền publish.

### Phát hành image

Sau khi workflow đã được đưa lên GitHub, maintainer chọn commit cần phát hành và push tag phiên bản chưa dùng:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

Đây là thao tác phát hành, không phải lệnh kiểm tra local. Workflow không tự thực hiện thao tác này.

Với repository `HaThaiCT/OanTuTiGame`, các image được đặt tên:

```text
ghcr.io/hathaict/oantutigame-server:v1.0.0
ghcr.io/hathaict/oantutigame-web:v1.0.0
```

Cả hai có thêm tag `sha-<full-commit-sha>` để xác định bản build. Tên owner/repository được chuyển sang chữ thường khi tạo tên image. Nếu fork repository, tên image tự thay theo owner/repository mới.

Đăng nhập registry dùng `GITHUB_TOKEN` do GitHub cấp, không cần thêm PAT/secret cho workflow. Chính sách organization/repository phải cho phép GitHub Actions ghi Packages. Package visibility không được workflow thay đổi; image private yêu cầu người tải có quyền đọc package. Bảo vệ quyền tạo/cập nhật release tag bằng repository rulesets nếu cần.

Theo dõi tab **Actions → CI and container release**. Workflow tạo status checks; nó không tự bật branch protection. Nếu muốn bắt buộc checks trước khi merge, cấu hình rule cho `main` trong GitHub Settings sau khi workflow chạy lần đầu.

Kiểm tra local tương ứng:

```bash
npm ci
npm test
npm run build --workspace=@oantuti/web
docker compose config --quiet
docker build -f Dockerfile.server -t oantuti-server:ci .
docker build -f Dockerfile.web -t oantuti-web:ci .
```

CI đã được kiểm tra local bằng actionlint, `npm ci`, 74 workspace tests, build Web, Compose config và build cả hai Docker image. Script tạo tên image/tag đã được chạy với branch, tag release, prerelease và tag không hợp lệ. Chạy trên GitHub-hosted runner và publish GHCR chỉ được xác nhận sau khi workflow được push và có một run thực tế; không xem kiểm tra local là bằng chứng đã publish.
