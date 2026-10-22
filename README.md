# OanTuTi Arena

Nền tảng thi đấu bot Búa–Kéo–Bao trên bàn cờ. Hỗ trợ bot Python, TypeScript và C++20; giải loại trực tiếp, Swiss → playoff, vòng tròn, Elo Arena, bảng Rating, replay và công cụ tổ chức.

## Chọn chế độ chạy

| Mục tiêu | Chế độ | Tự đăng ký | Xác minh email |
|---|---|---:|---:|
| Xem dữ liệu mẫu, đăng nhập bằng tài khoản fixture | Docker Compose `LAN_OFFLINE` | Không | Không |
| Thử luồng đăng ký Online trên máy cá nhân | Docker Compose `ONLINE` local demo | Có | Tắt bằng cờ chỉ dành cho localhost development |
| Public Internet / production | Deployment Online đã được commissioning | Có | Bắt buộc; cần email/TLS/hạ tầng được phê duyệt |
| Sửa code, build và đấu bot tin cậy | Local development | Theo profile server | Không tự bật Online |

Nhánh này là gói phần mềm và cấu hình Docker, **không phải** dịch vụ public đã triển khai hoặc production được chứng nhận. Trạng thái G0–G4/U5 và các điều kiện commissioning được ghi trong [Online software receipt](docs/implementation/rebuild/online-software-release.md) và [portable deployment runbook](docs/implementation/rebuild/portable-deployment.md).

Demo database chính thức nằm trong `deploy/demo-data/`: 46 giải, 72 đội, kết quả/replay và dữ liệu Rating showcase. Restore chỉ dùng với database và object roots mới, trống; không dùng để ghi đè dữ liệu đang có.

## 1. Chạy demo LAN_OFFLINE bằng Docker Compose

Đây là lựa chọn đơn giản nhất để xem giải, bảng xếp hạng, bracket và replay. API/PostgreSQL không được publish ra host; gateway mặc định chỉ bind loopback.

### Yêu cầu

- Docker Engine hoặc Docker Desktop đang chạy.
- Docker Compose v2 (`docker compose version`). Docker CLI không đồng nghĩa đã có Compose plugin.
- Internet để kéo image/package lần đầu. Linux amd64 là môi trường kiểm chứng; Windows dùng Docker Desktop/WSL2, macOS dùng Docker Desktop.

### Khởi động database và ứng dụng

```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame

# Tạo hai password riêng, đặt ngoài repository.
umask 077
mkdir -p "$HOME/.config/oantuti-demo"
chmod 700 "$HOME/.config/oantuti-demo"
openssl rand -hex 24 > "$HOME/.config/oantuti-demo/postgres-owner"
openssl rand -hex 24 > "$HOME/.config/oantuti-demo/postgres-app"
chmod 444 "$HOME/.config/oantuti-demo/postgres-owner" "$HOME/.config/oantuti-demo/postgres-app"

export PG_OWNER_PASSWORD_FILE="$HOME/.config/oantuti-demo/postgres-owner"
export PG_APP_PASSWORD_FILE="$HOME/.config/oantuti-demo/postgres-app"
export OANTUTI_BACKUP_FENCE=off
export WEB_PORT=3000
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

docker compose up --build -d
docker compose ps
```

Mở <http://localhost:3000>. Database mới tự nạp bộ demo và object replay/source vào named volumes. Đọc log nếu service không healthy:

```bash
docker compose logs --tail=100 postgres server web gateway
```

Các named volumes giữ dữ liệu qua restart. `docker compose down` dừng stack nhưng giữ dữ liệu. **Không dùng `docker compose down -v` để xử lý lỗi thông thường** vì lệnh đó xóa database/object volumes. Muốn demo mới độc lập, dùng Compose project name và cổng khác.

### Tài khoản fixture

Các tài khoản/mật khẩu dưới đây có trong bundle công khai; chúng **không phải** thông tin xác thực riêng hay an toàn cho public service.

| Vai trò | Username | Password |
|---|---|---|
| ADMIN | `system_admin` | `DemoAdmin@2026` |
| Đội trưởng mẫu | `demo_cap1` | `DemoStudent@2026` |
| Sinh viên mẫu | `student_alice` | `DemoStudent@2026` |
| Showcase đội 01–48 | `showcase_01a` … `showcase_48a` / `showcase_01b` … `showcase_48b` | `DemoStudent@2026` |

Đăng nhập ở `/workspace`; ADMIN mở `/organizer`. Chỉ dùng các fixture này trên loopback cá nhân. Không đưa chúng hoặc cấu hình LAN demo lên Internet. Compose mặc định tắt executor (`OANTUTI_DEV_EXECUTION=0`): dữ liệu/replay lịch sử xem được nhưng trận mới không tự chạy. `OANTUTI_BACKUP_FENCE=off` chỉ dành cho demo cá nhân, không chứng minh backup hoặc khả năng khôi phục.

## 2. Thử đăng ký Online trên localhost

Mục này dành cho môi trường development và **database demo riêng**. Nó bật profile `ONLINE`, nhưng cờ local-only làm user mới xác minh ngay và đăng nhập được, không cần mail. Mail/identity code vẫn được khởi tạo; normal Online không dùng cờ thì email verification vẫn bắt buộc.

**Không dùng bypass này cho production/public host.** `OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION=true` chỉ được server chấp nhận khi `NODE_ENV=development` và public URL là HTTPS localhost/loopback. Trên host production hoặc domain công khai, API fail-closed.

### Với demo local đã được provision

Mở:

- Form đăng ký: <https://localhost:14443/register>
- Trang đăng nhập: <https://localhost:14443/workspace> → **Đăng ký**

`https://127.0.0.1:14443` cũng được hỗ trợ. Các địa chỉ loopback này là cùng máy; Online origin policy vẫn chặn origin khác. Chứng chỉ demo là private/self-signed nên browser có thể cảnh báo. Chỉ chấp nhận nếu chắc chắn URL là localhost của máy demo; không đưa dịch vụ này ra LAN/Internet.

Đăng ký trong local-demo bypass tạo `STUDENT` đã verified, không gửi/queue email và có thể login ngay. Mật khẩu vẫn cần đạt policy của form. Nếu bật bypass mà mở bằng IP/domain không khớp, API sẽ trả `Cross-origin mutation denied`; hãy dùng đúng URL loopback nêu trên.

### Tự dựng local Online demo

Demo Online ở trên là môi trường loopback đã được provision riêng. Repo không có một lệnh Compose đơn giản tự tạo HTTPS proxy, certificate và mail sink cho cấu hình này. Nếu tự dựng, cần Compose project/database/volume hoàn toàn mới; restore bundle; áp schema tới migration hiện tại bằng service `ops`; tạo TLS localhost và cấu hình SMTP TLS/mail keyring riêng theo [migration runbook](docs/implementation/rebuild/portable-deployment.md#secrets-and-first-start) và [Online startup runbook](docs/implementation/rebuild/portable-deployment.md#controlled-online-startup-not-public-commissioning). Không đổi auth profile hoặc migrate volume dữ liệu hiện có chỉ để thử đăng ký.

Bộ demo dùng credential fixture công khai trong bảng trên; chúng chỉ dành cho loopback. Các tài khoản/email fixtures cũ không tự được xác minh; local bypass chỉ áp dụng cho tài khoản mới đăng ký.

## 3. Deployment Online public (operator-controlled)

Public deployment cần host Linux/amd64 được chọn, domain/HTTPS proxy, SMTP mailbox/provider, PostgreSQL secret/keyring, capacity/bootstrap ADMIN, backup off-host, sandbox/isolation và phê duyệt operator. Xem [Online release receipt](docs/implementation/rebuild/online-software-release.md) và [controlled Online startup](docs/implementation/rebuild/portable-deployment.md#controlled-online-startup-not-public-commissioning).

Không public demo fixture trên. Đặc biệt, **không** dùng `OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION` cho host public; Online production luôn yêu cầu mailbox verification. Không có target/deployment tự động được cấu hình trong repo này; build image không đồng nghĩa đã deploy.

## 4. Local development

### Prerequisites

- Node.js 24.x (ít nhất 24.7) và npm đi kèm; Node 20/22 không được hỗ trợ cho API Argon2.
- PostgreSQL 16 (`psql`, `createdb`).
- Rust toolchain theo `rust-toolchain.toml`, `protoc`, compiler/linker, Python 3.12 và g++ C++20.

Trên Ubuntu:

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

WSL không có systemd thì khởi động PostgreSQL bằng cơ chế của distro. Không cần đổi kernel để xem demo.

### Install and verifier

```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame
npm ci
cargo build --release --locked -p arena-runner --bin verify-trace
export OANTUTI_VERIFIER_BIN="$PWD/target/release/verify-trace"
```

Rust verifier là authority của luật/kết quả; không có TypeScript fallback. Replay viewer WASM đã nằm trong `packages/web/public/wasm/`; dùng `deploy/linux/build-wasm-verifier.sh` khi cần build lại.

### Restore demo vào database local mới

Chỉ dùng database và object roots riêng, mới, trống:

```bash
sudo -u postgres createuser --login --pwprompt arena_local
sudo -u postgres createdb --owner=arena_local arena_demo
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=arena_local PGDATABASE=arena_demo
read -rsp 'Database password: ' PGPASSWORD; export PGPASSWORD; printf '\n'
npm run demo:restore -- --fresh-empty-database
```

Restore yêu cầu đủ PG variables, từ chối database có schema/data ứng dụng và roots object không trống, trả exit code khác 0 nếu lỗi. Không dùng password/path của máy khác. Mặc định object paths là `<repo>/storage/submissions` và `<repo>/storage/replays`; nếu đổi thư mục ngoài checkout, đặt `OANTUTI_SUBMISSION_DIR`/`OANTUTI_REPLAYS_DIR` giống nhau lúc restore và chạy server.

### Run API and web in LAN_OFFLINE

API (terminal 1, repo root, với biến PG/verifier ở trên):

```bash
export PORT=4301 HOST=127.0.0.1
export PUBLIC_ORIGINS=http://localhost:4300,http://127.0.0.1:4300
export OANTUTI_AUTH_PROFILE=LAN_OFFLINE
export OANTUTI_BACKUP_FENCE=off
export OANTUTI_DEV_EXECUTION=1
export DB_LOCATION="$PWD/storage/legacy.sqlite"
node --import tsx packages/server/src/index.ts
```

Web (terminal 2):

```bash
API_BASE=http://127.0.0.1:4301 npm run build --workspace=@oantuti/web
API_BASE=http://127.0.0.1:4301 npm run start --workspace=@oantuti/web -- -H 127.0.0.1
```

Mở <http://127.0.0.1:4300>. Portal production build cần build/restart sau khi sửa `packages/web`; `API_BASE` phải đúng lúc build vì Next rewrite được resolve khi build. Chỉ chạy bot mẫu/mã tin cậy: executor local này không sandbox và không được mở ra mạng.

## 5. Verify installation

1. `/` và `/tournaments`: homepage/danh mục tải được dữ liệu và API.
2. `/rankings`: có bảng xếp hạng.
3. Mở trang đội: có rating history, không lộ roster trên trang public.
4. Mở giải `FINALIZED`, chọn game rồi mở replay.
5. Với LAN fixtures: đăng nhập `system_admin` → `/organizer`; đăng nhập `showcase_01a` → `/workspace`.
6. Với local Online: `/api/v2/auth/profile` trả `ONLINE`; `/register` có form. Chỉ khi bật cờ localhost dev thì đăng ký mới không đòi email.

Docker diagnostics:

```bash
docker compose ps
docker compose logs --tail=50 postgres server
docker compose exec server node -e "fetch('http://127.0.0.1:3001/api/health').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
```

Local API check: `curl --fail http://127.0.0.1:4301/api/health`.

## 6. Write and run a bot

Di chuyển một ô theo 8 hướng trên ô hợp lệ; Rock thắng Scissors, Scissors thắng Paper, Paper thắng Rock. Thắng bằng cách diệt hết một loại quân đối thủ hoặc chiếm throne; chi tiết/tie-break trong [v2 rules](docs/specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md).

- [Python starter](sdk/python/starter_bot.py) + [SDK](sdk/python/oantuti.py)
- [TypeScript starter](sdk/typescript/starter_bot.ts) + [SDK](sdk/typescript/oantuti.ts)
- [C++20 starter](sdk/cpp/starter_bot.cpp) + [SDK](sdk/cpp/oantuti.hpp)
- [STDIO NDJSON protocol](docs/specs/04-BOT-RUNNER-IPC-SPEC.md)

Bot nhận INIT/TURN qua stdin; stdout chỉ chứa protocol JSON, diagnostics dùng stderr. ZIP submission cần entrypoint và SDK/project files.

Local match (không ghi rating/kết quả chính thức):

```bash
npm run match:play -- \
  --map docs/specs/maps/sample-donut.map.json \
  --white sdk/python/starter_bot.py \
  --black sdk/cpp/starter_bot.cpp
```

## 7. Tests

PostgreSQL tests tạo/xóa fixture; tuyệt đối không chạy trên demo hoặc dữ liệu thật. Test runner chỉ nhận tên DB dạng `arena_*test*` và xác nhận DB đã kết nối.

Không cần PostgreSQL:

```bash
npm run test:engine
npm run test:protocol
npm run test:runner
npm run test:specs
npm run test:proto
```

Server/web focused tests:

```bash
npm run test:server
npm run test:web
npx tsc --noEmit -p packages/server/tsconfig.json
npm run build --workspace=@oantuti/web
```

Để chạy suite server, tạo database riêng có `test` trong tên, áp dụng migrations và gọi runner có guard (`deploy/linux/test-isolated.mts`). Xem [test/deployment runbook](docs/implementation/rebuild/demo-and-tests.md) để biết PG env/socket của môi trường local. Một số privileged migration tests cần connection test riêng; các test bị skip không được tính là đã xác minh.

## 8. Troubleshooting

- **`crypto.argon2` missing:** dùng Node 24.7+ và chạy lại `npm ci`.
- **`docker: unknown command: compose`:** cài Compose v2/Docker Desktop; kiểm tra `docker compose version`.
- **Secret `permission denied`:** kiểm tra file ngoài repository, quyền thư mục `0700`, quyền file theo UID service; không dùng `/dev/null` để chạy.
- **Demo restore từ chối database/root không trống:** tạo database/project volume mới, không bỏ guard và không xóa volume để né lỗi.
- **Replay thiếu object:** phải có cả SQL demo và `arena_objects.tar.gz`; giữ nguyên các object roots đã chọn, không `chmod -R 777`.
- **Không có game mới trong Docker:** executor bị tắt mặc định (`OANTUTI_DEV_EXECUTION=0`); lịch sử/replay vẫn xem được.
- **CSRF/origin khi chạy local Online:** mở đúng `https://localhost:14443` hoặc `https://127.0.0.1:14443`; local demo cho phép chính xác hai HTTPS loopback origin này. Host khác vẫn bị chặn. Nếu giao diện báo nguồn trang không khớp cấu hình, kiểm tra address bar; đây không phải lỗi vai trò ADMIN.
- **Mất dữ liệu sau `docker compose down -v`:** volume đã bị xóa; chỉ khôi phục được nếu có backup. Bundle trong Git chỉ là snapshot demo công khai.

## 9. Security and scope

Docker/local development không chứng nhận production, sandbox, backup, capacity hoặc tải 500 đội. Đọc [v2 specs](docs/specs/v2/README.md), [operations runbook](docs/implementation/rebuild/demo-and-tests.md), [Online software receipt](docs/implementation/rebuild/online-software-release.md) và [deployment runbook](docs/implementation/rebuild/portable-deployment.md).

Không commit secrets, local mail/TLS keys hoặc file `.env`. Demo fixture passwords là công khai, chỉ dùng loopback; demo no-email bypass chỉ dành cho `NODE_ENV=development` + HTTPS loopback và tuyệt đối không dùng trên public host.

Working-tree changes chưa commit/push không có trong GitHub. Khi báo kiểm thử/deploy, ghi đúng revision và phân biệt local changes với source đã phát hành.
