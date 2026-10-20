# OanTuTi Arena — Nền tảng Đấu trường Bot Thuật toán

[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16%20App%20Router-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose%20v2-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**OanTuTi Arena** là nền tảng thi đấu bot trí tuệ nhân tạo đối kháng thời gian thực dựa trên cơ chế trò chơi **Búa · Kéo · Bao chiến thuật trên bàn cờ lưới** (phong cách Battlecode). Nền tảng được tối ưu hóa cho các giải đấu lập trình trường đại học, hackathon và sự kiện thi đấu nội bộ (LAN Tournament).

Dự án tích hợp đầy đủ:
- **Game Engine bất biến (Deterministic Engine)**: Xử lý luật chơi, di chuyển 8 hướng, tương khắc Oẳn Tù Tì và phân định thắng thua.
- **Hệ thống Giải đấu & Xếp hạng**: Hỗ trợ 4 thể thức chuẩn (Loại trực tiếp, Swiss → Playoff, Vòng tròn, Elo Arena) và thuật toán tính điểm Rating Global.
- **Sân chơi Đa ngôn ngữ**: Hỗ trợ lập trình bot bằng **Python 3**, **TypeScript** và **C++20**.
- **Giao diện Web Esports (Next.js 16)**: Bảng điểm trực tiếp (Live Match HUD), trình xem Replay bàn cờ hoạt họa cử chỉ tay ✊ ✌️ 🖐️, Monaco Code Editor trực tiếp trên trình duyệt, bảng xếp hạng và giao diện Ban tổ chức.
- **Đóng gói sẵn bộ dữ liệu Demo thực tế**: Có sẵn 46 giải đấu, 72 đội thi đấu, 616 ván đấu Replay và bảng xếp hạng hoàn chỉnh.

---

## ⚡ Khởi động nhanh trong 1 phút (Quick Start với Docker)

Nếu máy bạn đã cài sẵn **Docker** và **Docker Compose**, chỉ cần chạy 4 dòng lệnh sau:

```bash
# 1. Tải mã nguồn về máy
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame

# 2. Khởi tạo 2 tệp mật khẩu bảo mật cho database
mkdir -p secrets
echo "postgres_owner_secret_pass" > secrets/postgres-owner
echo "postgres_app_secret_pass" > secrets/postgres-app

# 3. Thiết lập biến môi trường và khởi chạy
export PG_OWNER_PASSWORD_FILE=$(pwd)/secrets/postgres-owner
export PG_APP_PASSWORD_FILE=$(pwd)/secrets/postgres-app
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
export OANTUTI_BACKUP_FENCE=off

docker compose up --build -d
```

👉 **Mở trình duyệt truy cập ngay:** **[http://localhost:3000](http://localhost:3000)**

*Hệ thống sẽ tự động khởi động PostgreSQL 16, nạp sẵn bộ dữ liệu 46 giải đấu và 616 trận đấu replay mà không cần cấu hình thêm.*

---

## 🔑 Tài khoản đăng nhập có sẵn trong hệ thống

Bạn có thể bấm vào nút **Đăng nhập** ở góc phải trên cùng (hoặc vào `/workspace`) để trải nghiệm các quyền hạn khác nhau:

| Vai trò | Tên đăng nhập | Mật khẩu | Quyền hạn & Chức năng trải nghiệm |
|---|---|---|---|
| **👑 Ban tổ chức (Admin)** | `system_admin` | `DemoAdmin@2026` | Toàn quyền quản trị giải đấu, phê duyệt đội thi đấu, chỉnh sửa bản đồ (Map Editor), chốt kết quả và công bố Rating. |
| **🎮 Đội trưởng thí sinh (Captain)** | `demo_cap1` | `DemoStudent@2026` | Quản lý đội, phòng soạn thảo bot Monaco IDE, tải file `.zip`, chạy kiểm thử riêng tư (Private Test). |
| **🎮 Thành viên thí sinh (Member)** | `student_alice` | `DemoStudent@2026` | Xem thông tin giải đấu, theo dõi kết quả thi đấu của đội. |

---

## 📋 Mục lục hướng dẫn chi tiết
1. [Yêu cầu môi trường](#1-yêu-cầu-môi-trường)
2. [Hướng dẫn Cài đặt & Khởi chạy](#2-hướng-dẫn-cài-đặt--khởi-chạy)
   - [Phương án A: Khởi chạy bằng Docker Compose (Khuyên dùng)](#phương-án-a-khởi-chạy-bằng-docker-compose-khuyên-dùng)
   - [Phương án B: Cài đặt và Chạy trực tiếp trên máy host (Local Development)](#phương-án-b-cài-đặt-và-chạy-trực-tiếp-trên-máy-host-local-development)
3. [Khám phá Giao diện & Tính năng chính](#3-khám-phá-giao-diện--tính-năng-chính)
4. [Hướng dẫn Lập trình Bot (Bot Developer Guide)](#4-hướng-dẫn-lập-trình-bot-bot-developer-guide)
   - [Luật chơi & Điều kiện thắng](#luật-chơi--điều-kiện-thắng)
   - [Giao thức giao tiếp STDIO NDJSON](#giao-thức-giao-tiếp-stdio-ndjson)
   - [Bot mẫu Python](#bot-mẫu-python)
   - [Bot mẫu TypeScript](#bot-mẫu-typescript)
   - [Bot mẫu C++20](#bot-mẫu-c20)
5. [Đấu thử 2 Bot bằng dòng lệnh (CLI Match Runner)](#5-đấu-thử-2-bot-bằng-dòng-lệnh-cli-match-runner)
6. [Chạy kiểm thử tự động (Test Suite)](#6-chạy-kiểm-thử-tự-động-test-suite)
7. [Xử lý sự cố thường gặp (FAQ & Troubleshooting)](#7-xử-lý-sự-cố-thường-gặp-faq--troubleshooting)

---

## 1. Yêu cầu môi trường

Để tự tải về và cài đặt dự án, máy tính của bạn cần đáp ứng:

- **Hệ điều hành**: Linux (Ubuntu 22.04 / 24.04 khuyến nghị), macOS, hoặc Windows 10/11 (qua WSL2).
- **Node.js**: Phiên bản `>= 20.x` (khuyến nghị **Node.js 22 LTS** hoặc **24 LTS**) cùng `npm >= 10.x`.
- **Docker**: Docker Engine `>= 24.x` và Docker Compose v2 (nếu dùng phương án Docker).
- **Python**: Phiên bản `>= 3.10` (nếu lập trình bot Python).
- **C++ Compiler**: `g++` hoặc `clang++` hỗ trợ chuẩn **C++20** (nếu lập trình bot C++).
- **PostgreSQL**: Phiên bản `16.x` (nếu chạy cục bộ không dùng Docker).

---

## 2. Hướng dẫn Cài đặt & Khởi chạy

### Phương án A: Khởi chạy bằng Docker Compose (Khuyên dùng)

Phương án này đóng gói sẵn toàn bộ môi trường bao gồm: CSDL PostgreSQL 16, backend Fastify, frontend Next.js và Nginx reverse proxy.

#### Bước 1: Tải mã nguồn
```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame
```

#### Bước 2: Tạo tệp mật khẩu (Secrets)
Docker Compose sử dụng cơ chế Docker Secrets để bảo mật mật khẩu CSDL:
- **Trên Linux / macOS**:
  ```bash
  mkdir -p secrets
  openssl rand -hex 24 > secrets/postgres-owner
  openssl rand -hex 24 > secrets/postgres-app
  ```
- **Trên Windows (PowerShell)**:
  ```powershell
  New-Item -ItemType Directory -Force -Path secrets
  [System.Guid]::NewGuid().ToString("N") | Out-File -Encoding ascii secrets/postgres-owner
  [System.Guid]::NewGuid().ToString("N") | Out-File -Encoding ascii secrets/postgres-app
  ```

#### Bước 3: Thiết lập biến môi trường và chạy container
- **Trên Linux / macOS**:
  ```bash
  export PG_OWNER_PASSWORD_FILE=$(pwd)/secrets/postgres-owner
  export PG_APP_PASSWORD_FILE=$(pwd)/secrets/postgres-app
  export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
  export OANTUTI_BACKUP_FENCE=off

  docker compose up --build -d
  ```
- **Trên Windows (PowerShell)**:
  ```powershell
  $env:PG_OWNER_PASSWORD_FILE = "$PWD/secrets/postgres-owner"
  $env:PG_APP_PASSWORD_FILE = "$PWD/secrets/postgres-app"
  $env:PUBLIC_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
  $env:OANTUTI_BACKUP_FENCE = "off"

  docker compose up --build -d
  ```

#### Bước 4: Kiểm tra trạng thái và mở ứng dụng
Sau khoảng 15–30 giây, kiểm tra trạng thái các container:
```bash
docker compose ps
```
Khi thấy cả 4 container (`postgres`, `server`, `web`, `gateway`) đều ở trạng thái `running (healthy)`, hãy mở trình duyệt vào:
👉 **[http://localhost:3000](http://localhost:3000)**

#### Các lệnh quản trị Docker hữu ích:
```bash
# Xem log máy chủ theo thời gian thực
docker compose logs -f server web

# Khởi động lại các dịch vụ
docker compose restart

# Dừng hệ thống (DỮ LIỆU ĐƯỢC GIỮ NGUYÊN trong named volumes)
docker compose down

# Xoá sạch toàn bộ dữ liệu để làm lại từ đầu (cẩn trọng!)
docker compose down -v
```

---

### Phương án B: Cài đặt và Chạy trực tiếp trên máy host (Local Development)

Dành cho các bạn muốn phát triển hoặc tùy biến mã nguồn trực tiếp mà không qua container.

#### Bước 1: Cài đặt dependencies
Tại thư mục gốc dự án:
```bash
npm ci
```

#### Bước 2: Chuẩn bị cơ sở dữ liệu PostgreSQL 16
Tạo database tên là `arena` trên PostgreSQL cục bộ của bạn (qua `psql` hoặc pgAdmin):
```sql
CREATE DATABASE arena;
```

#### Bước 3: Phục hồi bộ dữ liệu Demo chỉ với 1 lệnh
Chạy lệnh tự động phục hồi dữ liệu demo (bao gồm 46 giải đấu, bảng xếp hạng và 616 ván replay):
```bash
PGHOST=localhost PGPORT=5432 PGDATABASE=arena PGUSER=postgres PGPASSWORD=your_password \
  npm run demo:restore
```
*Script sẽ tự động nạp cơ sở dữ liệu và giải nén toàn bộ các tệp replay `.oantuti` vào thư mục `storage/replays/`.*

#### Bước 4: Khởi động Backend Fastify Server (`packages/server`)
Mở cửa sổ terminal thứ nhất:
```bash
export PORT=4301
export HOST=127.0.0.1
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=arena
export PGUSER=postgres
export PGPASSWORD=your_password
export OANTUTI_AUTH_PROFILE=LAN_OFFLINE
export OANTUTI_DEV_EXECUTION=1   # Bật bộ tự động đấu trận (Tournament Auto-Runner)
export OANTUTI_BACKUP_FENCE=off

node --import tsx packages/server/src/index.ts
```
Máy chủ API sẽ lắng nghe tại `http://127.0.0.1:4301`.

#### Bước 5: Khởi động Frontend Next.js Web (`packages/web`)
Mở cửa sổ terminal thứ hai:
```bash
cd packages/web

# Chạy bản production build đã tối ưu (khuyên dùng):
npm run build
npm run start -- -H 127.0.0.1 -p 4300

# Hoặc nếu muốn chỉnh sửa giao diện với hot-reload:
# npm run dev
```
Mở trình duyệt truy cập:
👉 **[http://127.0.0.1:4300](http://127.0.0.1:4300)** (hoặc cổng cấu hình của bạn).

---

## 3. Khám phá Giao diện & Tính năng chính

Sau khi khởi chạy thành công, bạn có thể trải nghiệm các phân hệ chính trên thanh điều hướng:

1. **Trang chủ (`/`)**:
   - Dải thông báo trận đấu gần nhất (Match Ticker) với tỉ số trực tiếp và liên kết xem Replay ngay lập tức.
   - Thẻ giải đấu tiêu điểm đang diễn ra (`● ĐANG DIỄN RA`).
   - Danh sách các cặp đối đầu mới nhất và Bảng xếp hạng Top 8 đội mạnh nhất.
2. **Giải đấu (`/tournaments`)**:
   - Trang chuyên biệt quản lý tất cả các giải đấu trên hệ thống.
   - Bộ tìm kiếm và các bộ lọc thể thức: *Loại trực tiếp*, *Swiss → Playoff*, *Vòng tròn*, *Elo Arena*.
   - Chi tiết giải đấu: **Sơ đồ nhánh đấu đồ họa (Bracket)** tương tác hiển thị trực quan, xem tỷ số từng cặp đấu và trạng thái từng ván.
3. **Bảng xếp hạng (`/rankings`)**:
   - Bảng xếp hạng toàn cục (Global Standings) cập nhật theo thời gian thực.
   - Hiển thị danh hiệu phân hạng: *Novice*, *Pupil*, *Specialist*, *Expert*, *Master*, *Grandmaster*.
4. **Trình phát lại ván đấu (Replay Player)**:
   - Truy cập qua nút **Replay** ở bất kỳ trận đấu nào.
   - Bàn cờ hiển thị trực quan các quân cờ cử chỉ tay ✊ Búa, ✌️ Kéo, 🖐️ Bao với hiệu ứng 3D phát sáng.
   - Hỗ trợ Play/Pause, tua lùi, tua tiến, thay đổi tốc độ (0.5x, 1x, 2x, 4x) và danh sách nước đi bên phải.
5. **Không gian đội (`/workspace`)**:
   - Đăng nhập với tài khoản `demo_cap1` / `DemoStudent@2026`.
   - Trình soạn thảo mã nguồn **Monaco Code Editor** hỗ trợ code bot trực tiếp nhiều file trên trình duyệt.
   - Tải file nộp bài `.zip`.
   - Tính năng **Chạy test riêng tư (Private Test)**: Kiểm tra bot đánh thử với bot mẫu để xem trước replay mà không bị tính điểm phạt.
6. **Bảng điều khiển Ban tổ chức (`/organizer`)**:
   - Đăng nhập với tài khoản `system_admin` / `DemoAdmin@2026`.
   - Quản lý học phần, cấp tài khoản sinh viên hàng loạt, tạo giải đấu mới.
   - Công cụ vẽ bản đồ **Map Editor**: Tạo ô cấm, đặt vị trí Hoàng toạ và quân ban đầu.

---

## 4. Hướng dẫn Lập trình Bot (Bot Developer Guide)

### Luật chơi & Điều kiện thắng
- **Bàn cờ**: Kích thước lưới $N \times M$ (mặc định $8 \times 8$).
- **Di chuyển**: Mỗi lượt đi, bạn chọn 1 quân cờ còn sống của phe mình để di chuyển tới 1 trong 8 ô lân cận (ngang, dọc, chéo).
- **Quy tắc ăn quân**:
  - ✊ **Búa (Rock)**: Ăn ✌️ Kéo, bị ăn bởi 🖐️ Bao.
  - ✌️ **Kéo (Scissors)**: Ăn 🖐️ Bao, bị ăn bởi ✊ Búa.
  - 🖐️ **Bao (Paper)**: Ăn ✊ Búa, bị ăn bởi ✌️ Kéo.
  - Không thể đi vào ô có quân cùng phe hoặc quân địch cùng loại / quân địch khắc chế mình.
- **Điều kiện thắng**:
  1. Quân cờ của bạn đi vào ô **Hoàng toạ (Throne)** của đối phương.
  2. Bạn ăn sạch **toàn bộ một chủng loại quân** của đối thủ (ví dụ: đối thủ mất sạch cả 2 quân Kéo).
  3. Đối thủ không còn nước đi hợp lệ hoặc bị xử thua do vi phạm (quá giờ, crash).

---

### Giao thức giao tiếp STDIO NDJSON
Bot chạy độc lập dưới dạng một tiến trình con (child process), giao tiếp qua `stdin` (nhận dữ liệu) và `stdout` (gửi nước đi) bằng các dòng JSON (NDJSON):

1. **Giai đoạn khởi tạo (`INIT`)**:
   - Nhận thông tin cấu hình ván đấu, phe thi đấu (`WHITE` hoặc `BLACK`), vị trí xuất phát.
   - Bot phải phản hồi: `{"status": "READY"}` trong vòng **1000ms**.
2. **Giai đoạn tính toán nước đi (`TURN`)**:
   - Nhận trạng thái bàn cờ hiện tại, lượt đánh, danh sách quân sống/chết.
   - Bot phải phản hồi: `{"action": "MOVE", "piece_id": 1, "target": [3, 4]}` trong vòng **100ms** (có 5ms grace).
   - *Lưu ý: Mọi log in ra màn hình để gỡ lỗi (debug) phải ghi vào `stderr`, không ghi vào `stdout`.*

---

### Bot mẫu Python
Tệp `sdk/python/starter_bot.py`:
```python
import random
from oantuti import Bot, Context, MoveAction

class StarterBot(Bot):
    def on_init(self, ctx: Context) -> None:
        # Khởi tạo chiến thuật ban đầu
        pass

    def on_turn(self, ctx: Context) -> MoveAction:
        # Lấy danh sách toàn bộ các nước đi hợp lệ
        moves = ctx.get_legal_moves()
        if not moves:
            return None

        # Ví dụ chiến thuật: Ưu tiên nước đi ăn quân đối phương
        attack_moves = [m for m in moves if ctx.is_capture_move(m)]
        if attack_moves:
            return random.choice(attack_moves)

        # Nếu không có nước ăn quân, chọn ngẫu nhiên nước đi hợp lệ
        return random.choice(moves)

if __name__ == "__main__":
    StarterBot().run()
```

---

### Bot mẫu TypeScript
Tệp `sdk/typescript/starter_bot.ts`:
```typescript
import { BotHandler, Context, MoveAction, runBot } from './oantuti';

const starterBot: BotHandler = {
  onInit(ctx: Context): void {
    // Khởi tạo
  },

  onTurn(ctx: Context): MoveAction | null {
    const legalMoves = ctx.getLegalMoves();
    if (legalMoves.length === 0) return null;

    // Chọn ngẫu nhiên một nước đi hợp lệ
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  },
};

runBot(starterBot);
```

---

### Bot mẫu C++20
Tệp `sdk/cpp/starter_bot.cpp`:
```cpp
#include "oantuti.hpp"
#include <random>

class StarterBot : public oantuti::Bot {
public:
    void on_init(const oantuti::Context& ctx) override {
        // Khởi tạo
    }

    std::optional<oantuti::MoveAction> on_turn(const oantuti::Context& ctx) override {
        auto legal_moves = ctx.get_legal_moves();
        if (legal_moves.empty()) {
            return std::nullopt;
        }

        // Chọn nước đi đầu tiên hợp lệ
        return legal_moves[0];
    }
};

int main() {
    StarterBot bot;
    bot.run();
    return 0;
}
```

---

## 5. Đấu thử 2 Bot bằng dòng lệnh (CLI Match Runner)

Bạn hoàn toàn có thể kiểm tra thuật toán của 2 bot đối đầu trực tiếp trên máy mình mà không cần bật Web Server:

```bash
# Đấu thử Bot Python (Phe Trắng) với Bot C++ (Phe Đen):
# Bộ chạy runner sẽ tự động biên dịch mã C++ nếu chưa có binary!
npm run match:play -- \
  --map docs/specs/maps/sample-donut.map.json \
  --white sdk/python/starter_bot.py \
  --black sdk/cpp/starter_bot.cpp \
  --replay /tmp/test-match.oantuti
```

Sau khi trận đấu kết thúc, kết quả thắng thua sẽ hiển thị trên terminal và xuất ra tệp `/tmp/test-match.oantuti`. Bạn có thể mở giao diện web mục Replay để xem lại diễn biến trận đấu đó.

---

## 6. Chạy kiểm thử tự động (Test Suite)

Dự án tích hợp bộ kiểm thử tự động toàn diện với hơn 400+ unit/integration tests bao phủ toàn bộ hệ thống:

```bash
# Chạy toàn bộ test suite
npm test

# Hoặc chạy kiểm thử riêng từng thành phần:
npm run test:engine    # Kiểm tra game engine, luật chơi và tính tất định
npm run test:protocol  # Kiểm tra giao thức mã hóa dữ liệu
npm run test:runner    # Kiểm tra bộ chạy bot và xử lý timeout
npm run test:web       # Kiểm tra các components giao diện web
npm run test:server    # Kiểm tra các API backend Fastify
```

---

## 7. Xử lý sự cố thường gặp (FAQ & Troubleshooting)

**Hỏi: Cổng 3000 đã bị chiếm bởi một ứng dụng khác trên máy tôi?**
> **Trả lời**: Bạn có thể đổi cổng web khi chạy Docker Compose bằng cách đặt biến `WEB_PORT`:
> ```bash
> WEB_PORT=3300 docker compose up -d
> ```
> Sau đó truy cập tại `http://localhost:3300`.

**Hỏi: Làm sao để đăng nhập Admin mà không cần nhập mật khẩu?**
> **Trả lời**: Trong môi trường dòng lệnh, bạn có thể tạo session cookie trực tiếp:
> ```bash
> npm run demo:login system_admin
> ```
> Terminal sẽ in ra chuỗi cookie phiên `oantuti_session=...` để bạn dán vào DevTools trình duyệt.

**Hỏi: Làm sao để cài lại dữ liệu mẫu nếu lỡ tay xóa?**
> **Trả lời**:
> - Nếu dùng Docker Compose:
>   ```bash
>   docker compose down -v
>   docker compose up -d
>   ```
> - Nếu chạy cục bộ:
>   ```bash
>   npm run demo:restore
>   ```

---

## 📜 Giấy phép & Bản quyền
Dự án được xây dựng và phát hành theo các tiêu chuẩn học thuật của **OanTuTi Tournament Platform**. Mọi quyền được bảo lưu.
