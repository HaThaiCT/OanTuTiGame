# OanTuTi Arena

Nền tảng thi đấu Bot Búa–Kéo–Bao trên bàn cờ: Python, TypeScript và C++20; giải loại trực tiếp, Swiss → playoff, vòng tròn và Elo arena; bảng Rating toàn cầu, live spectator, replay và trang quản trị.


## Online deployment package

This branch contains the Online software and Docker image build configuration. It is a controlled software package, **not** production commissioning, G0–G4 release certification, U5 acceptance, or a deployed public service. See the [Online software receipt and exported-image instructions](docs/implementation/rebuild/online-software-release.md) and [Online deployment/runbook](docs/implementation/rebuild/portable-deployment.md#controlled-online-startup-not-public-commissioning). Public commissioning requires human-supplied host, domain/TLS, mail provider/mailbox, backup custody, sandbox, and operator sign-off evidence.

## Chọn cách cài

| Nhu cầu | Cách chạy |
|---|---|
| Xem dữ liệu demo, đăng nhập, xem giải/bảng xếp hạng/replay | **Docker Compose** bên dưới; không cần cài Node, Rust hoặc PostgreSQL trên host |
| Chỉnh sửa mã, biên dịch và đấu thử Bot tin cậy | **Local development trên Ubuntu 24.04 / WSL2 Ubuntu** |
| Nhận mã Bot không tin cậy qua Internet | Không dùng cấu hình demo. Cần cấu hình/certify sandbox và backup theo [tài liệu vận hành](docs/specs/v2/05-SECURITY-OPERATIONS-QUALITY.md) |

Bộ demo nằm trong Git ở `deploy/demo-data/`, không lấy dữ liệu từ máy tác giả: 46 giải, 72 đội, 616 kết quả/replay và 48 đội showcase có lịch sử Rating. Restore chỉ dành cho **database và object roots mới, trống**; không dùng để ghi đè dữ liệu hiện có.

## 1. Docker Compose — khuyến nghị để xem demo

### Điều kiện

- Git, Docker Engine hoặc Docker Desktop đang chạy, **Docker Compose v2**.
- Kiểm tra cả hai lệnh: `docker version` và `docker compose version`. Có Docker Engine chưa chắc đã có Compose plugin.
- Internet để tải dependencies/base images ở lần build đầu. Build lần đầu mất vài phút tùy máy và mạng, không phải cam kết một phút.
- Linux amd64 là môi trường kiểm chứng. Trên Windows dùng Docker Desktop Linux containers/WSL2; trên macOS dùng Docker Desktop. Chưa chứng nhận native Windows hay Apple Silicon.

### Tải và chạy

Các lệnh dưới đây dùng Bash (Linux/macOS/terminal WSL2):

```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame

# Mật khẩu database tự sinh, không dùng lại mật khẩu thật của bạn.
umask 077
mkdir -p "$HOME/.config/oantuti-demo"
chmod 700 "$HOME/.config/oantuti-demo"
openssl rand -hex 24 > "$HOME/.config/oantuti-demo/postgres-owner"
openssl rand -hex 24 > "$HOME/.config/oantuti-demo/postgres-app"
# Compose mount từng file vào các container chạy UID khác nhau.
# Thư mục cha 0700 chặn người dùng host khác; file 0444 cho UID trong container đọc.
chmod 444 "$HOME/.config/oantuti-demo/postgres-owner" "$HOME/.config/oantuti-demo/postgres-app"
export PG_OWNER_PASSWORD_FILE="$HOME/.config/oantuti-demo/postgres-owner"
export PG_APP_PASSWORD_FILE="$HOME/.config/oantuti-demo/postgres-app"
export OANTUTI_BACKUP_FENCE=off
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

docker compose up --build -d
docker compose ps
```

Mở **http://localhost:3000** sau khi PostgreSQL và API khỏe, web/gateway đang chạy. API/PostgreSQL không công bố cổng ra host; gateway mặc định chỉ bind `127.0.0.1`.

Database mới tự nạp demo; server tự phục hồi các object replay/source vào volume riêng. Named volumes giữ dữ liệu qua restart. Nếu restore thất bại, đọc log và sửa nguyên nhân; không bỏ qua lỗi rồi coi như thành công.

```bash
docker compose logs --tail=100 postgres server web gateway
docker compose restart
# Dừng nhưng giữ dữ liệu:
docker compose down
# Lần sau dùng lại cùng các biến secret-file ở trên:
docker compose up -d
```

**Không chạy `docker compose down -v` để xử lý lỗi thông thường:** lệnh đó xóa database và object volumes. Muốn một demo mới độc lập, dùng project name khác, ví dụ `docker compose -p oantuti-second-demo up --build -d` và cổng khác.

Đổi cổng phải đổi cả origin:

```bash
export WEB_PORT=3300
export PUBLIC_ORIGINS=http://localhost:3300,http://127.0.0.1:3300
docker compose up -d
```

### Tài khoản demo công khai

| Vai trò | Username | Password |
|---|---|---|
| ADMIN | `system_admin` | `DemoAdmin@2026` |
| Đội trưởng mẫu | `demo_cap1` | `DemoStudent@2026` |
| Sinh viên mẫu | `student_alice` | `DemoStudent@2026` |
| Showcase: đội trưởng / thành viên đội 01–48 | `showcase_01a` … `showcase_48a` / `showcase_01b` … `showcase_48b` | `DemoStudent@2026` |

Đây là mật khẩu fixture **công khai**, không phải mật khẩu của một triển khai đang vận hành. Chỉ dùng demo trên loopback; không đưa cấu hình này lên Internet và không dùng mật khẩu này cho hệ thống thật. Bundle không chứa các phiên đăng nhập/token recovery đang hoạt động.

Đăng nhập tại `/workspace`; ADMIN vào `/organizer`. Khi thao tác nhạy cảm yêu cầu xác thực lại, nhập mật khẩu ADMIN demo ở trên.

### Giới hạn cấu hình Docker mặc định

Docker Compose mặc định **tắt thực thi Bot mới** (`OANTUTI_DEV_EXECUTION=0`). Bạn xem được dữ liệu lịch sử/replay, nhưng submission/private test/trận mới không tự hoàn tất khi chưa có executor. `/api/health` là liveness; `/api/health/ready` có thể trả `503 degraded` vì chưa có sandbox/backup. Đây không phải cấu hình production-ready.

`OANTUTI_BACKUP_FENCE=off` chỉ dành cho demo cá nhân; không chứng minh backup hay khả năng khôi phục.

## 2. Local development — Ubuntu 24.04 / WSL2

### Prerequisites

- **Node.js 24.7 trở lên thuộc dòng 24**, npm đi kèm Node 24. Node 20/22 không có API Argon2 mà dự án dùng.
- PostgreSQL **16** server và client (`psql`, `createdb`).
- Rust toolchain theo `rust-toolchain.toml` (cài qua [rustup](https://rustup.rs/)); Cargo tự chọn phiên bản đã pin khi chạy trong repo.
- `protoc`, compiler/linker, Python 3.12 và g++ C++20.

Cài gói hệ thống trên Ubuntu (không thay thế bước cài Node 24/rustup):

```bash
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-client-16 \
  build-essential python3 protobuf-compiler pkg-config libssl-dev
sudo systemctl start postgresql

node --version
npm --version
cargo --version
psql --version
protoc --version
python3 --version
g++ --version
```

Nếu dùng WSL không có systemd, khởi động PostgreSQL bằng cơ chế service của distro. Không hạ/nâng kernel để chạy demo này.

### Cài dependencies và verifier từ source

```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame
npm ci
cargo build --release --locked -p arena-runner --bin verify-trace
export OANTUTI_VERIFIER_BIN="$PWD/target/release/verify-trace"
```

Rust verifier là authority kiểm tra luật/kết quả. Không có TypeScript fallback nếu thiếu binary. Trình xem replay đã có WASM được đóng gói trong `packages/web/public/wasm/`; [script build WASM](deploy/linux/build-wasm-verifier.sh) dùng khi cần tái biên dịch nó.

### Database mới và restore demo

Chỉ tạo một role/database riêng cho demo. Các tên dưới đây có thể đổi, nhưng phải nhất quán với biến môi trường:

```bash
sudo -u postgres createuser --login --pwprompt arena_local
sudo -u postgres createdb --owner=arena_local arena_demo

export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=arena_local PGDATABASE=arena_demo
read -rsp 'Database password: ' PGPASSWORD; export PGPASSWORD; printf '\n'
npm run demo:restore -- --fresh-empty-database
```

Restore yêu cầu đủ bốn biến PG, từ chối database có dữ liệu/schema ứng dụng và object roots không trống. Lỗi restore trả exit code khác 0. Không có mật khẩu/database path hard-code của máy tác giả. Cần kết nối PostgreSQL hoạt động trước khi restore.

Mặc định object nằm ở `<repo>/storage/submissions` và `<repo>/storage/replays`. Nếu chọn thư mục ngoài checkout, đặt `OANTUTI_SUBMISSION_DIR` và `OANTUTI_REPLAYS_DIR` **giống nhau khi restore và khi chạy server**. Đường dẫn object được rebase theo thư mục đích.

### Chạy API và web

Terminal 1, tại gốc repo, với các biến PG và verifier ở trên:

```bash
export PORT=4301 HOST=127.0.0.1
export PUBLIC_ORIGINS=http://127.0.0.1:4300,http://localhost:4300
export OANTUTI_AUTH_PROFILE=LAN_OFFLINE
export OANTUTI_BACKUP_FENCE=off
export OANTUTI_DEV_EXECUTION=1
export DB_LOCATION="$PWD/storage/legacy.sqlite"
node --import tsx packages/server/src/index.ts
```

**Executor development không sandbox:** chỉ chạy Bot mẫu hoặc mã bạn tin cậy; không mở nhận mã từ người khác. Không đổi `HOST` sang `0.0.0.0` một cách tùy tiện.

Terminal 2, tại gốc repo:

```bash
API_BASE=http://127.0.0.1:4301 npm run build --workspace=@oantuti/web
API_BASE=http://127.0.0.1:4301 npm run start --workspace=@oantuti/web -- -H 127.0.0.1
```

Mở **http://127.0.0.1:4300**. Đăng nhập bằng tài khoản demo của mục 1. Sửa web phải build và restart `next start`; dùng `npm run dev --workspace=@oantuti/web` nếu muốn hot reload. `API_BASE` cần đúng cả lúc build vì Next rewrites được resolve khi build.

## 3. Tự kiểm tra sau cài đặt

1. Trang chủ/`/tournaments`: thấy danh sách 46 giải demo, không có lỗi kết nối API.
2. `/rankings`: thấy 48 đội `SHOWCASE_Txx` cùng các đội Rated có sẵn.
3. Mở một đội: có lịch sử Rating, không lộ danh sách thành viên trên trang public.
4. Mở một giải FINALIZED → chọn một ván → Replay: tải được dữ liệu object và điều khiển playback.
5. Đăng nhập `system_admin` → `/organizer`: thấy course, đội, giải và phần review Rating.
6. Đăng nhập `showcase_01a` → `/workspace`: vào đúng đội; không có quyền quản trị.

Docker:

```bash
docker compose ps
docker compose logs --tail=50 postgres server
# Kiểm tra API từ trong container (không cần công bố cổng API):
docker compose exec server node -e "fetch('http://127.0.0.1:3001/api/health').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
```

Local: `curl --fail http://127.0.0.1:4301/api/health`.

## 4. Viết và đấu thử Bot

Luật: di chuyển một ô theo 8 hướng trên các ô hợp lệ; Rock thắng Scissors, Scissors thắng Paper, Paper thắng Rock. Thắng bằng cách diệt hết một loại quân đối thủ hoặc chiếm throne đối thủ; chi tiết/tie-break xem [luật v2](docs/specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md).

Dùng đúng starter và SDK đi kèm, không chép API giả từ ví dụ cũ:

- [Python](sdk/python/starter_bot.py) + [SDK](sdk/python/oantuti.py)
- [TypeScript](sdk/typescript/starter_bot.ts) + [SDK](sdk/typescript/oantuti.ts)
- [C++20](sdk/cpp/starter_bot.cpp) + [SDK](sdk/cpp/oantuti.hpp)
- [Giao thức STDIO NDJSON](docs/specs/04-BOT-RUNNER-IPC-SPEC.md)

Bot nhận INIT và TURN qua stdin, chỉ xuất protocol JSON ra stdout; log chẩn đoán dùng stderr. ZIP submission phải có cả entrypoint và SDK/project files.

Đấu thử không cần web/database, sau `npm ci` và cài Python/g++:

```bash
npm run match:play -- \
  --map docs/specs/maps/sample-donut.map.json \
  --white sdk/python/starter_bot.py \
  --black sdk/cpp/starter_bot.cpp
```

CLI này là công cụ development, không ghi rating/kết quả chính thức. Replay chính thức hiển thị trên portal phải có accepted evidence trong server, không chỉ một file tùy ý trên máy.

## 5. Tests — dùng database riêng

Các test PostgreSQL ghi/sửa dữ liệu fixture. **Không trỏ test vào database demo hay dữ liệu thật.**

```bash
npm run test:engine
npm run test:protocol
npm run test:runner
npm run test:specs
npm run test:proto
```

`test:web` hiện không có test files; build web và kiểm tra browser là bước xác minh UI.

Để chạy suite có PostgreSQL, dùng role có quyền tạo fixture và một database mới chứa `test` trong tên:

```bash
sudo -u postgres createdb --owner=arena_local arena_local_test
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=arena_local PGDATABASE=arena_local_test
read -rsp 'Test database password: ' PGPASSWORD; export PGPASSWORD; printf '\n'

# Migration CLI nhận mật khẩu qua file riêng, không qua raw PGPASSWORD.
umask 077
mkdir -p "$HOME/.config/oantuti-demo"
printf '%s' "$PGPASSWORD" > "$HOME/.config/oantuti-demo/test-db-password"
PGPASSWORD= PGPASSWORD_FILE="$HOME/.config/oantuti-demo/test-db-password" \
  node --import tsx deploy/linux/apply-migrations.mts --apply --grant-to arena_local

export OANTUTI_VERIFIER_BIN="$PWD/target/release/verify-trace"
OANTUTI_DEV_EXECUTION=1 node --import tsx deploy/linux/test-isolated.mts
```

Một số test nâng quyền/migration cần URL PostgreSQL admin riêng; các test skip không được tính là đã kiểm chứng. `npx tsc --noEmit` ở root hiện không đồng nghĩa typecheck web/server package: root còn diagnostics của test/NodeNext; dùng build web và package configs tương ứng, đọc output thật thay vì coi exit lỗi là pass.

## 6. Khắc phục sự cố

- **Node thiếu `crypto.argon2`**: dùng Node 24.7+, chạy lại `npm ci`; Node20/22 không được hỗ trợ.
- **`docker: unknown command: compose`**: cài Compose plugin hoặc Docker Desktop; kiểm tra `docker compose version`.
- **`permission denied` đọc secret file**: đường dẫn phải là file mật khẩu có nội dung, Docker được quyền đọc. Không dùng `/dev/null` để chạy thật.
- **Restore từ chối database không trống**: dùng database/project volume mới. Không chạy restore lại trên dữ liệu đang dùng và không xóa volume chỉ để né guard.
- **Không thấy replay / lỗi object root**: restore cả SQL và archive; giữ nguyên thư mục object đã chọn; kiểm tra log. `storage` phải riêng tư với service identity, không `chmod -R 777`.
- **`RUST_VERIFIER_PROCESS` / thiếu `verify-trace`**: build Rust verifier và đặt `OANTUTI_VERIFIER_BIN` tuyệt đối; Docker image đã mang binary này.
- **Không có trận mới chạy trong Docker**: mặc định Docker chỉ xem demo, executor tắt. Không phải lỗi nạp dữ liệu.
- **Login/CSRF khi đổi cổng**: sửa `PUBLIC_ORIGINS` khớp origin trên trình duyệt rồi tạo lại container server bằng `docker compose up -d`.
- **Mất dữ liệu sau `down -v`**: volume đã bị xóa; không có bảo đảm khôi phục dữ liệu tự tạo nếu chưa backup. Bundle chỉ chứa snapshot demo công khai.

## 7. Phạm vi và bảo mật

Compose/local development không phải chứng nhận production, sandbox, backup hay tải 500 đội. Xem [specs v2](docs/specs/v2/README.md) và [hướng dẫn vận hành](docs/implementation/rebuild/demo-and-tests.md). Các tài khoản/mật khẩu riêng của môi trường tác giả không nằm trong README hoặc bản demo chia sẻ.

Các thay đổi cục bộ chưa commit/push không xuất hiện khi clone GitHub. Báo cáo kiểm chứng phải nêu đúng revision đã clone và các bản sửa chưa phát hành; không ngầm coi working tree là mã đã có trên GitHub.
