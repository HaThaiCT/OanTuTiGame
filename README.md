# OanTuTi Arena

Nền tảng thi đấu bot Búa–Kéo–Bao trên bàn cờ tùy biến (server-authoritative, deterministic) lấy cảm hứng từ Battlecode. Hệ thống hỗ trợ bot viết bằng **Python 3.12**, **TypeScript** và **C++20**; tích hợp 4 thể thức thi đấu (Loại trực tiếp, Swiss → Playoff, Vòng tròn tính điểm, Elo Arena), hệ thống xếp hạng toàn cầu **Global Team Rating**, bộ kiểm chứng độc lập viết bằng **Rust**, trình chiếu replay bằng **WebAssembly (WASM)**, cùng bàn điều khiển Ban tổ chức (**Organizer Console**) toàn diện.

---

## 1. Danh sách tài khoản kiểm thử (Test Accounts & Fixtures)

> ⚠️ **Lưu ý bảo mật**: Tất cả mật khẩu và tài khoản mẫu dưới đây đều nằm trong gói dữ liệu demo công khai, **chỉ phục vụ mục đích kiểm thử và demo cục bộ trên loopback (`localhost` / `127.0.0.1`)**. Tuyệt đối không đưa cấu hình này hoặc mở các thông tin này ra môi trường Internet công cộng.

### 1.1. Tài khoản Quản trị viên (ADMIN)

| Username | Password | Vai trò | Quyền hạn & Chức năng kiểm thử |
|---|---|---|---|
| `system_admin` | `DemoAdmin@2026` | **ADMIN** | Toàn quyền quản trị hệ thống: truy cập `/organizer`, tạo giải đấu mới, cấu hình thể thức/vòng đấu, phân bổ đội hình (Roster Assignment), can thiệp trọng tài/xử lý tranh chấp kết quả, duyệt Rating toàn cầu (Rating Review & Approval), quản trị và biên tập bản đồ thi đấu (Map Editor). |

### 1.2. Tài khoản Sinh viên / Đội trưởng mẫu (STUDENT)

| Username | Password | Vai trò / Chiến đội | Mục đích kiểm thử |
|---|---|---|---|
| `demo_cap1` | `DemoStudent@2026` | Đội trưởng (Course 1) | Đăng nhập `/workspace`, nộp bot, xem mã tham gia giải đấu, quản lý đội. |
| `demo_cap2` | `DemoStudent@2026` | Đội trưởng (Course 1) | Thử nghiệm ghép cặp và đối kháng giữa các đội trong cùng lớp học. |
| `demo_cap3`, `demo_cap4` | `DemoStudent@2026` | Đội trưởng (Course 1) | Thử nghiệm giải đấu vòng tròn 4 đội hoặc mini-tournament. |
| `student_alice` | `DemoStudent@2026` | Sinh viên thành viên | Thử nghiệm vai trò thành viên đội, xem trạng thái bot và kết quả thi đấu. |
| `student_bob` | `DemoStudent@2026` | Sinh viên thành viên | Thử nghiệm luồng tham gia đội bằng mã mời (`Join with code`). |
| `student_charlie` | `DemoStudent@2026` | Sinh viên thành viên | Thử nghiệm luồng tài khoản sinh viên độc lập. |
| `legacy_player` | `DemoStudent@2026` | Đội trưởng Legacy | Kiểm tra khả năng tương thích ngược của các hồ sơ đội cũ. |

### 1.3. Tài khoản 48 Chiến đội Showcase (Bảng xếp hạng & Giải đấu chính thức)

Trong cơ sở dữ liệu mẫu, 48 chiến đội showcase đại diện cho các câu lạc bộ thuật toán, AI battlecode và trường đại học. Mỗi đội gồm 2 tài khoản:
* **Đội trưởng**: `showcase_{id}a` (ví dụ: `showcase_12a`)
* **Thành viên**: `showcase_{id}b` (ví dụ: `showcase_12b`)
* **Mật khẩu chung**: `DemoStudent@2026`

Bảng tra cứu các chiến đội tiêu biểu trên Bảng xếp hạng (`/rankings`):

| Hạng | Tên Chiến Đội | Điểm Rating | Bậc Màu | Tài khoản Đội trưởng | Tài khoản Thành viên |
|:---:|---|:---:|:---:|---|---|
| **#01** | **Sài Gòn Masterminds** | **1774** | Xanh dương (Expert) | `showcase_12a` | `showcase_12b` |
| **#02** | **Gấu Trúc KungFu Code** | **1772** | Xanh dương (Expert) | `showcase_35a` | `showcase_35b` |
| **#03** | **Vũng Tàu Bitwise** | **1709** | Xanh dương (Expert) | `showcase_24a` | `showcase_24b` |
| **#04** | **Vô Địch Thuật Toán** | **1697** | Xanh dương (Expert) | `showcase_46a` | `showcase_46b` |
| **#05** | **Đà Nẵng CodeNinjas** | **1690** | Xanh dương (Expert) | `showcase_10a` | `showcase_10b` |
| **#06** | **Nha Trang OceanPulse** | **1689** | Xanh dương (Expert) | `showcase_22a` | `showcase_22b` |
| **#07** | **HCMUT Alpha Dragons** | **1671** | Xanh dương (Expert) | `showcase_04a` | `showcase_04b` |
| **#08** | **Bàn Cờ Thần Tốc** | **1665** | Xanh dương (Expert) | `showcase_47a` | `showcase_47b` |
| **#09** | **Chim Ưng Sấm Sét** | **1642** | Xanh dương (Expert) | `showcase_36a` | `showcase_36b` |
| **#10** | **Hiệp Sĩ Búa Kéo** | **1641** | Xanh dương (Expert) | `showcase_48a` | `showcase_48b` |
| **#16** | **Cần Thơ TechClaw** | **1590** | Xanh lơ (Specialist) | `showcase_11a` | `showcase_11b` |
| **#19** | **Bách Khoa Invictus** | **1525** | Xanh lơ (Specialist) | `showcase_01a` | `showcase_01b` |
| **#26** | **Hà Nội Glitch Hunters** | **1459** | Xanh lơ (Specialist) | `showcase_13a` | `showcase_13b` |
| **#36** | **Vinh Tech Vanguard** | **1394** | Xanh lá (Pupil) | `showcase_14a` | `showcase_14b` |
| **#46** | **Vua Búa Kéo Bao** | **1343** | Xanh lá (Pupil) | `showcase_41a` | `showcase_41b` |
| **#48** | **Bóng Ma Không Gian** | **1318** | Xanh lá (Pupil) | `showcase_38a` | `showcase_38b` |

*(Cùng các đội đại diện: `UET CyberWolves` (#02), `HUST ByteCraft` (#03), `PTIT Dynamic Knights` (#05), `FPT Quantum Nexus` (#06), `VNU Algorithmics` (#07), `UIT Binary Storm` (#08), `HUS DeepLearners` (#09), `Thăng Long Warriors` (#16), v.v.)*

### 1.4. Đăng ký tài khoản Online mới (Local Online Demo)

Khi triển khai với stack Online demo (`https://localhost:14443` hoặc `https://127.0.0.1:14443`):
* Mở trang đăng ký: <https://localhost:14443/register>
* Nhập thông tin sinh viên tùy ý và mật khẩu thỏa mãn chính sách bảo mật (tối thiểu 12 ký tự, bao gồm chữ hoa, chữ thường, chữ số và ký tự đặc biệt).
* Nhờ cơ chế `OANTUTI_LOCAL_DEMO_SKIP_EMAIL_VERIFICATION=true` trên HTTPS loopback development, tài khoản mới tạo sẽ được **kích hoạt tự động ngay lập tức** và có thể đăng nhập vào `/workspace` mà không cần xác nhận qua hòm thư điện tử.

---

## 2. Chọn chế độ chạy

| Mục tiêu | Chế độ | Tự đăng ký | Xác minh email | Ghi chú |
|---|---|:---:|:---:|---|
| **Xem demo nhanh, duyệt giải, xem replay** | Docker Compose `LAN_OFFLINE` | Không | Không | Phù hợp nhất để kiểm thử giao diện và chức năng hiện có |
| **Thử nghiệm luồng Online trên máy cá nhân** | Docker Compose `ONLINE` local demo | Có | Tự động bỏ qua trên localhost | Chạy qua HTTPS Nginx (cổng 14443), hỗ trợ cookie `Secure` |
| **Phát triển mã nguồn (Dev mode)** | Local development (Node 24 + Postgres) | Tùy cấu hình | Tùy cấu hình | Chạy server & client trực tiếp với live hot-reload/watch |
| **Môi trường sản xuất (Production)** | Deployment Online đã commissioning | Có | Bắt buộc | Cần chứng chỉ TLS thật, SMTP gateway, sandbox bảo vệ |

---

## 3. Hướng dẫn khởi chạy nhanh

### 3.1. Chạy demo bằng Docker Compose (Khuyên dùng)

#### Yêu cầu hệ thống:
* Docker Engine hoặc Docker Desktop (hỗ trợ Docker Compose v2).
* Bộ nhớ RAM trống tối thiểu 4GB.

#### Các bước khởi chạy:

```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame

# 1. Tạo file chứa mật khẩu cục bộ ngoài thư mục mã nguồn
umask 077
mkdir -p "$HOME/.config/oantuti-demo"
chmod 700 "$HOME/.config/oantuti-demo"
openssl rand -hex 24 > "$HOME/.config/oantuti-demo/postgres-owner"
openssl rand -hex 24 > "$HOME/.config/oantuti-demo/postgres-app"
chmod 444 "$HOME/.config/oantuti-demo/postgres-owner" "$HOME/.config/oantuti-demo/postgres-app"

# 2. Thiết lập biến môi trường khởi chạy
export PG_OWNER_PASSWORD_FILE="$HOME/.config/oantuti-demo/postgres-owner"
export PG_APP_PASSWORD_FILE="$HOME/.config/oantuti-demo/postgres-app"
export OANTUTI_BACKUP_FENCE=off
export WEB_PORT=3000
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

# 3. Khởi chạy toàn bộ hệ thống
docker compose up --build -d
docker compose ps
```

Mở trình duyệt tại địa chỉ: <http://localhost:3000>.

Hệ thống sẽ tự động khởi tạo cơ sở dữ liệu mẫu bao gồm:
* **46 giải đấu** với nhiều thể thức khác nhau.
* **72 chiến đội** với lịch sử thi đấu và tên gọi thực tế.
* Bảng xếp hạng **Global Team Rating** đầy đủ biến động.
* Toàn bộ replay các ván đấu lịch sử đã được kiểm chứng.

Kiểm tra log của các dịch vụ khi cần:
```bash
docker compose logs --tail=100 postgres server web gateway
```

Dừng dịch vụ (vẫn giữ nguyên dữ liệu):
```bash
docker compose down
```

---

### 3.2. Chạy môi trường Local Development (Dành cho lập trình viên)

#### Yêu cầu:
* **Node.js**: Phiên bản 24.x (tối thiểu 24.7 để hỗ trợ Web Crypto Argon2id).
* **PostgreSQL**: Phiên bản 16 (`psql`, `createdb`).
* **Rust**: Toolchain theo file `rust-toolchain.toml` và `cargo`.
* **C++ / Python**: `g++` hỗ trợ C++20, Python 3.12, `protobuf-compiler` (`protoc`).

#### Cài đặt và biên dịch Rust Verifier:

```bash
# Cài đặt dependencies Node.js
npm ci

# Biên dịch bộ kiểm chứng luật chơi bằng Rust (bắt buộc)
cargo build --release --locked -p arena-runner --bin verify-trace
export OANTUTI_VERIFIER_BIN="$PWD/target/release/verify-trace"
```

#### Khởi tạo Database mẫu:

```bash
sudo -u postgres createuser --login --pwprompt arena_local
sudo -u postgres createdb --owner=arena_local arena_demo
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=arena_local PGDATABASE=arena_demo
read -rsp 'Nhập mật khẩu database: ' PGPASSWORD; export PGPASSWORD; echo

# Phục hồi dữ liệu demo chính thức
npm run demo:restore -- --fresh-empty-database
```

#### Khởi chạy Server và Web Portal:

* **Terminal 1 (Backend API Server)**:
```bash
export PORT=4301 HOST=127.0.0.1
export PUBLIC_ORIGINS=http://localhost:4300,http://127.0.0.1:4300
export OANTUTI_AUTH_PROFILE=LAN_OFFLINE
export OANTUTI_BACKUP_FENCE=off
export OANTUTI_DEV_EXECUTION=1
node --import tsx packages/server/src/index.ts
```

* **Terminal 2 (Frontend Web Client)**:
```bash
API_BASE=http://127.0.0.1:4301 npm run build --workspace=@oantuti/web
API_BASE=http://127.0.0.1:4301 npm run start --workspace=@oantuti/web -- -H 127.0.0.1
```

Truy cập web tại: <http://127.0.0.1:4300>.

---

## 4. Các trang chức năng chính (Portal Navigation)

| Đường dẫn (URL) | Tên trang / Chức năng | Mô tả chi tiết |
|---|---|---|
| `/` | **Trang chủ** | Hiển thị Top 8 chiến đội xuất sắc nhất, danh sách các trận đấu gần đây kèm tỉ số trực quan, và các giải đấu đang diễn ra. |
| `/tournaments` | **Danh mục giải đấu** | Danh sách 46 giải đấu được phân loại theo thể thức (Single Elimination, Swiss, Round Robin, Elo Arena) và trạng thái (Đang mở đăng ký, Đang diễn ra, Đã hoàn tất). |
| `/tournaments/:id` | **Chi tiết giải đấu** | Xem sơ đồ nhánh đấu trực quan (Bracket), lịch thi đấu chi tiết từng cặp đấu, kết quả từng ván đấu, và bảng thay đổi Rating chính thức. |
| `/rankings` | **Bảng xếp hạng toàn cầu** | Xếp hạng chiến đội theo điểm Rating toàn cầu, phân cấp màu sắc theo từng bậc rating (không dùng nhãn chữ rườm rà), hỗ trợ xem số giải đã tham gia. |
| `/teams/:id` | **Hồ sơ chiến đội** | Xem biểu đồ lịch sử biến động Rating qua từng giải đấu, điểm số cao nhất đạt được, và danh sách các giải đấu đã tham dự. |
| `/workspace` | **Không gian đội thi** | Dành cho sinh viên/đội trưởng: tạo và quản lý đội, gửi đăng ký tham gia giải, theo dõi trạng thái xét duyệt, hủy đăng ký khi cần, nộp gói bot (`.zip`), chạy test riêng tư và đổi mật khẩu. |
| `/organizer` | **Ban tổ chức (Organizer)** | Dành cho `system_admin`: khởi tạo và quản lý tiến trình giải đấu, **hàng chờ xét duyệt đội đăng ký (Duyệt đội / Từ chối kèm lý do riêng tư)**, can thiệp trọng tài, duyệt Rating global, quản lý phân đội và trình biên tập bản đồ. |
| `/replays` | **Trình xem Replay** | Trình phát lại ván đấu tương tác tích hợp Rust WASM Verifier, cho phép kiểm tra từng lượt đi (Turn), thanh máu, ô cờ và trạng thái quân cờ. |
| `/projector/:id` | **Màn hình trình chiếu** | Chế độ hiển thị đặc biệt tối ưu cho máy chiếu hội trường, màn hình LED hoặc luồng livestream khi tổ chức sự kiện trực tiếp. |

### 4.1. Quy trình Đăng ký, Hủy đăng ký và Xét duyệt đội thi đấu

Hệ thống triển khai cơ chế xét duyệt chặt chẽ, đảm bảo tính công bằng và minh bạch:

1. **Đội trưởng gửi yêu cầu đăng ký**:
   * Khi giải đấu ở trạng thái **Đang mở đăng ký** (`REGISTRATION_OPEN`), Đội trưởng chọn chiến đội của mình và bấm **“Gửi đăng ký”** trực tiếp tại trang giải (`/tournaments/:id#registration`) hoặc trong Không gian đội (`/workspace`). Không bắt buộc phải có mã mời.
   * Trạng thái đăng ký chuyển sang **Chờ ban tổ chức duyệt** (`PENDING`). Lúc này đội **chưa** được cấp quyền nộp bài thi đấu.

2. **Hủy đăng ký (Cancellation)**:
   * Trước khi hết hạn đóng đăng ký, Đội trưởng có thể chủ động bấm **“Hủy đăng ký”**.
   * Yêu cầu đang chờ sẽ được rút khỏi hàng đợi xét duyệt, hoặc suất thi đấu đã duyệt sẽ được giải phóng cho đội khác.
   * Nếu giải vẫn còn trong thời gian mở đăng ký, Đội trưởng có thể bấm **“Gửi đăng ký lại”**.

3. **Ban tổ chức xét duyệt (Organizer Review)**:
   * Tài khoản `system_admin` truy cập mục Quản lý giải đấu → tab **Đội tham dự** (`/organizer/tournaments/:id?tab=entries`).
   * Ban tổ chức xem đầy đủ danh sách đội đăng ký, thời gian gửi, danh sách thành viên và vai trò trong đội.
   * **Phê duyệt (`Duyệt đội`)**: Hệ thống kiểm tra sức chứa giải đấu và ghi danh chính thức đội vào giải (`APPROVED`), cấp quyền nộp bot thi đấu cho đội.
   * **Từ chối (`Từ chối`)**: Ban tổ chức bắt buộc nhập lý do từ chối (1–500 ký tự). Lý do này được lưu trữ riêng tư, chỉ hiển thị cho Ban tổ chức và các thành viên của đội bị từ chối xem tại trang đội của họ.

4. **Nộp bài thi đấu (Bot Submission)**:
   * Chỉ các đội đã được Ban tổ chức **Phê duyệt** mới hiển thị tab **“Bài nộp”** và được phép tải lên file mã nguồn bot để thi đấu.

---

## 5. Hướng dẫn viết Bot và tham gia thi đấu

### 5.1. Luật chơi cốt lõi (v2 Rules)
* **Bàn cờ & Di chuyển**: Bàn cờ tùy biến có chướng ngại vật; mỗi quân cờ có thể di chuyển 1 ô theo 8 hướng (ngang, dọc, chéo) vào ô hợp lệ.
* **Tương khắc Búa–Kéo–Bao**:
  * **Búa (Rock)** thắng **Kéo (Scissors)**
  * **Kéo (Scissors)** thắng **Bao (Paper)**
  * **Bao (Paper)** thắng **Búa (Rock)**
  * Cùng loại quân khi giao tranh sẽ hòa (trừ khi có ưu thế địa hình/vị trí).
* **Điều kiện thắng cuộc**:
  1. Tiêu diệt toàn bộ một chủng loại quân bất kỳ của đối thủ (ví dụ: đối thủ mất toàn bộ quân Kéo).
  2. Chiếm giữ ngai vàng (**Throne**) trên bàn cờ trong số lượt quy định.
  3. Dẫn điểm khi hết số lượt tối đa theo luật tie-break của v2.

### 5.2. Starter Kits và SDK có sẵn

* 🐍 **Python Starter**: [`sdk/python/starter_bot.py`](sdk/python/starter_bot.py) — Đi kèm thư viện [`sdk/python/oantuti.py`](sdk/python/oantuti.py)
* 🔷 **TypeScript Starter**: [`sdk/typescript/starter_bot.ts`](sdk/typescript/starter_bot.ts) — Đi kèm thư viện [`sdk/typescript/oantuti.ts`](sdk/typescript/oantuti.ts)
* ⚡ **C++20 Starter**: [`sdk/cpp/starter_bot.cpp`](sdk/cpp/starter_bot.cpp) — Đi kèm header-only library [`sdk/cpp/oantuti.hpp`](sdk/cpp/oantuti.hpp)
* 📜 **Giao thức STDIO / NDJSON**: Xem chi tiết đặc tả tại [`docs/specs/04-BOT-RUNNER-IPC-SPEC.md`](docs/specs/04-BOT-RUNNER-IPC-SPEC.md).

### 5.3. Chạy thử nghiệm trận đấu cục bộ (Không cần server)

Bạn có thể cho hai bot tự thi đấu trực tiếp trên máy bằng lệnh:

```bash
npm run match:play -- \
  --map docs/specs/maps/sample-donut.map.json \
  --white sdk/python/starter_bot.py \
  --black sdk/cpp/starter_bot.cpp
```

Kết quả ván đấu, điểm số và trace log chi tiết sẽ hiển thị trực tiếp trên terminal.

---

## 6. Kiểm thử tự động (Automated Test Suites)

Hệ thống có bộ kiểm thử tự động toàn diện bao quát từ engine, protocol, server cho tới giao diện web:

```bash
# Kiểm thử Engine và Quy tắc trò chơi
npm run test:engine

# Kiểm thử Giao thức và Serialization
npm run test:protocol

# Kiểm thử Bộ chạy bot và IPC
npm run test:runner

# Kiểm thử Đặc tả chuẩn hóa và cấu trúc dữ liệu
npm run test:specs

# Kiểm thử giao diện Web (Components, Theme tokens, Panels)
npm run test:web

# Kiểm thử Backend API Server (yêu cầu test database riêng biệt)
npm run test:server
```

---

## 7. Xử lý sự cố thường gặp (Troubleshooting)

* **Lỗi `crypto.argon2` không tìm thấy**: Đảm bảo đang sử dụng Node.js phiên bản từ `24.7.0` trở lên. Node 20 hoặc 22 không tích hợp sẵn Web Crypto Argon2id.
* **Lỗi `docker: unknown command: compose`**: Hệ thống yêu cầu Docker Compose V2 plugin (`docker compose`). Nâng cấp Docker Desktop hoặc cài đặt `docker-compose-plugin`.
* **Cảnh báo chứng chỉ bảo mật trên HTTPS (Cổng 14443)**: Do môi trường demo cục bộ sử dụng chứng chỉ tự ký (`self-signed certificate`). Bạn chỉ cần bấm "Nâng cao" (Advanced) → "Tiếp tục truy cập" (Proceed) trên trình duyệt.
* **Lỗi “Nguồn trang không khớp cấu hình máy chủ” (CORS/Origin Error)**: Đảm bảo mở đúng địa chỉ `https://localhost:14443` hoặc `https://127.0.0.1:14443`. Tránh mở bằng IP mạng LAN hoặc tên miền khác khi đang chạy cấu hình loopback demo.
* **Không thấy trận đấu mới tự động chạy**: Trong cấu hình Docker Compose mặc định, biến `OANTUTI_DEV_EXECUTION=0` để bảo vệ tài nguyên máy. Lịch sử, kết quả và replay đều hiển thị đầy đủ. Để tự chạy bot thật trên local, bật `OANTUTI_DEV_EXECUTION=1`.

---

## 8. Giấy phép & Thông tin dự án

Dự án được phát triển phục vụ công tác tổ chức thi đấu thuật toán và giáo dục. Xem thêm tài liệu kỹ thuật chi tiết tại thư mục [`docs/`](docs/).
