# OanTuTi Arena — Nền tảng Đấu trường Bot Thuật toán

**OanTuTi Arena** là nền tảng thi đấu bot trí tuệ nhân tạo đối kháng thời gian thực dựa trên cơ chế trò chơi **Búa · Kéo · Bao chiến thuật trên bàn cờ lưới** (phong cách Battlecode). Nền tảng được thiết kế cho các cuộc thi học thuật, giải đấu lập trình trường đại học và sự kiện mạng nội bộ (LAN Tournament).

Dự án bao gồm bộ máy tính toán deterministic bất biến (authoritative engine), hệ thống chấm điểm và lập lịch giải đấu tự động, trình mô phỏng trận đấu đa ngôn ngữ (**Python**, **TypeScript**, **C++20**), và giao diện điều hành / khán giả hiện đại chuẩn Esports xây dựng trên **Next.js 16** và **Fastify**.

---

## Mục lục
1. [Tính năng nổi bật](#1-tính-năng-nổi-bật)
2. [Cấu trúc Monorepo](#2-cấu-trúc-monorepo)
3. [Yêu cầu hệ thống](#3-yêu-cầu-hệ-thống)
4. [Cách 1: Khởi chạy bằng Docker Compose (Khuyến nghị)](#4-cách-1-khởi-chạy-bằng-docker-compose-khuyến-nghị)
5. [Cách 2: Cài đặt và Chạy cục bộ (Local Development)](#5-cách-2-cài-đặt-và-chạy-cục-bộ-local-development)
6. [Hướng dẫn Lập trình Bot (SDK Guide)](#6-hướng-dẫn-lập-trình-bot-sdk-guide)
7. [Chạy thử trận đấu bằng dòng lệnh (CLI Runner)](#7-chạy-thử-trận-đấu-bằng-dòng-lệnh-cli-runner)
8. [Kiểm thử tự động (Testing)](#8-kiểm-thử-tự-động-testing)
9. [Tài liệu tham khảo chuyên sâu](#9-tài-liệu-tham-khảo-chuyên-sâu)

---

## 1. Tính năng nổi bật

- **Luật chơi chiến thuật đối kháng**: Bàn cờ lưới đa dạng địa hình (vật cản, ô cấm). Quân cờ di chuyển 8 hướng theo quy tắc Búa ăn Kéo, Kéo ăn Bao, Bao ăn Búa. Thắng cuộc bằng cách chiếm Hoàng toạ (Throne) đối phương hoặc tuyệt diệt toàn bộ một chủng loại quân của đối thủ.
- **Hỗ trợ 3 ngôn ngữ lập trình chính**: Cung cấp sẵn SDK và bot mẫu cho **Python 3**, **TypeScript** và **C++20**.
- **Đa dạng thể thức giải đấu**:
  - **Loại trực tiếp (Single Elimination)**: Phân nhánh đối đầu sinh tử.
  - **Swiss → Playoff**: Vòng tròn Thụy Sĩ lấy các đội dẫn đầu vào vòng loại trực tiếp.
  - **Vòng tròn tính điểm (Round Robin)**: Thi đấu xoay vòng tính điểm toàn diện.
  - **Đấu trường Elo (Elo Arena)**: Ghép cặp động theo bậc xếp hạng kỹ năng.
- **Giao diện người dùng Esports hiện đại**:
  - **Portal giải đấu**: Bảng xếp hạng Rating Global, danh mục giải đấu, thẻ giải đấu trực quan.
  - **Màn hình trực tiếp (Live Match HUD)**: Bảng điểm đối đầu thời gian thực, nhật ký combat feed qua WebSocket.
  - **Trình phát Replay tương tác**: Tua từng nước đi, điều chỉnh tốc độ, bàn cờ hoạt họa hiển thị quân cờ ✊ Búa, ✌️ Kéo, 🖐️ Bao và hào quang nước đi.
  - **Không gian đội (Team Workspace)**: Tích hợp Monaco Code IDE trực tiếp trên trình duyệt, nộp mã nguồn `.zip`, chạy kiểm thử nội bộ (Private Test) trước khi vào giải.
  - **Bảng điều khiển Ban tổ chức (Organizer Console)**: Quản lý giải đấu, phê duyệt đội, chỉnh sửa bản đồ (Map Editor), chốt kết quả và công bố rating.

---

## 2. Cấu trúc Monorepo

```text
OanTuTiGame/
├── packages/
│   ├── engine/          # Game engine thuần túy (rules, topology, move validation, fuzzing)
│   ├── protocol/        # Giao thức truyền thông (wire format, NDJSON framing, Protobuf, replay .oantuti)
│   ├── runner/          # Bộ điều phối chạy bot cục bộ qua STDIO child processes
│   ├── server/          # Control-plane backend (Fastify, WebSocket stream, PostgreSQL 16 ledger, scheduler)
│   └── web/             # Web portal frontend (Next.js 16 App Router, Tailwind CSS, Monaco Editor)
├── sdk/
│   ├── python/          # Python SDK (oantuti.py) & bot mẫu (starter_bot.py)
│   ├── typescript/      # TypeScript SDK (oantuti.ts) & bot mẫu (starter_bot.ts)
│   └── cpp/             # C++20 header-only SDK (oantuti.hpp) & bot mẫu (starter_bot.cpp)
├── deploy/linux/        # Scripts triển khai, migrations PostgreSQL, bootstrap admin, demo seed
├── docs/                # Đặc tả kiến trúc (specs v2) và tài liệu vận hành (runbooks)
├── tests/               # Bộ kiểm thử tích hợp, load test và specs validation
├── docker-compose.yml   # Cấu hình triển khai trọn gói Docker Compose
└── package.json         # Workspace root scripts và dependencies
```

---

## 3. Yêu cầu hệ thống

Trước khi bắt đầu, hãy đảm bảo máy tính của bạn đã cài đặt các công cụ sau:

- **Hệ điều hành**: Linux (Ubuntu 22.04 / 24.04 LTS khuyến nghị), macOS, hoặc Windows (thông qua WSL2).
- **Node.js**: Phiên bản `>= 20.x` (khuyến nghị **Node.js 22 LTS** hoặc **24 LTS**) cùng `npm >= 10.x`.
- **Python**: Phiên bản `>= 3.10` (dành cho bot Python).
- **Trình biên dịch C++**: `g++` hoặc `clang++` hỗ trợ chuẩn **C++20** (dành cho bot C++).
- **Docker & Docker Compose**: Docker Engine `>= 24.x` và Docker Compose v2 (nếu sử dụng phương án Docker).
- **PostgreSQL**: Phiên bản `16.x` (nếu chạy trực tiếp trên máy host không qua Docker).

---

## 4. Cách 1: Khởi chạy bằng Docker Compose (Khuyến nghị)

Repository đã được đóng gói sẵn **toàn bộ dữ liệu demo thực tế** (`deploy/demo-data/` gồm 46 giải đấu, 72 đội, bảng xếp hạng Global Rating và 616 tệp replay ván đấu). Khi khởi chạy lần đầu, Docker sẽ **tự động nạp toàn bộ dữ liệu này** vào PostgreSQL và kho lưu trữ tệp.

### Bước 4.1: Clone repository và chuẩn bị secrets
```bash
git clone https://github.com/HaThaiCT/OanTuTiGame.git
cd OanTuTiGame
```

Tạo thư mục chứa mật khẩu bảo mật (ngoài git):
```bash
mkdir -p secrets
openssl rand -hex 24 > secrets/postgres-owner
openssl rand -hex 24 > secrets/postgres-app
```

### Bước 4.2: Thiết lập biến môi trường và chạy container
```bash
export PG_OWNER_PASSWORD_FILE=$(pwd)/secrets/postgres-owner
export PG_APP_PASSWORD_FILE=$(pwd)/secrets/postgres-app
export PUBLIC_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
export OANTUTI_BACKUP_FENCE=off  # Đặt là 'off' cho môi trường demo / thử nghiệm

# Khởi chạy toàn bộ hệ thống ở chế độ nền
docker compose up --build -d
```
*Hệ thống sẽ tự động khởi tạo cơ sở dữ liệu, nạp 46 giải đấu cùng 616 ván replay trong vòng vài giây.*

### Bước 4.3: Truy cập ứng dụng & Tài khoản đăng nhập
Mở trình duyệt tại **[http://localhost:3000](http://localhost:3000)**.

Hệ thống đã có sẵn các tài khoản đăng nhập để bạn trải nghiệm ngay lập tức:

| Vai trò | Tên đăng nhập | Mật khẩu | Quyền hạn |
|---|---|---|---|
| **👑 Ban tổ chức (Admin)** | `system_admin` | `DemoAdmin@2026` | Quản trị giải, phê duyệt đội, Map Editor, duyệt Rating |
| **🎮 Thí sinh (Captain)** | `demo_cap1` | `DemoStudent@2026` | Không gian đội, Monaco IDE, nộp bài `.zip`, chạy test nội bộ |
| **🎮 Thí sinh (Member)** | `student_alice` | `DemoStudent@2026` | Xem giải đấu, theo dõi kết quả của đội |

### Bước 4.4: Các lệnh quản lý Docker thường dùng
```bash
docker compose ps                         # Xem trạng thái các container
docker compose logs -f server web gateway # Xem log theo thời gian thực
docker compose restart server web         # Khởi động lại dịch vụ web và api
docker compose down                       # Dừng hệ thống (VẪN GIỮ NGUYÊN DỮ LIỆU volume)
```
*(Lưu ý: Không dùng `docker compose down -v` nếu bạn muốn giữ lại dữ liệu giải đấu).*

---

## 5. Cách 2: Cài đặt và Chạy cục bộ (Local Development)

Dành cho nhà phát triển muốn chạy trực tiếp trên máy host và chỉnh sửa mã nguồn.

### Bước 5.1: Cài đặt dependencies
```bash
npm ci
```

### Bước 5.2: Phục hồi bộ dữ liệu Demo vào PostgreSQL cục bộ
Đảm bảo bạn đã có một cơ sở dữ liệu PostgreSQL 16 (ví dụ: `arena`). Bạn có thể phục hồi ngay bộ dữ liệu 46 giải đấu và 616 replay chỉ với **một lệnh duy nhất**:

```bash
PGHOST=localhost PGPORT=5432 PGDATABASE=arena PGUSER=postgres PGPASSWORD=your_password \
  npm run demo:restore
```
*Lệnh này sẽ tự động nạp dump database và giải nén toàn bộ 616 tệp replay `.oantuti` cùng mã nguồn bot vào thư mục `storage/`.*

### Bước 5.3: Khởi động Backend API (`packages/server`)
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
export OANTUTI_DEV_EXECUTION=1   # Bật bộ tự động đấu trận (auto-runner)
export OANTUTI_BACKUP_FENCE=off

node --import tsx packages/server/src/index.ts
```
API server sẽ sẵn sàng tại `http://127.0.0.1:4301`.

### Bước 5.4: Khởi động Frontend Web Portal (`packages/web`)
Mở cửa sổ terminal thứ hai:
```bash
cd packages/web

# Chạy chế độ Development (Hot-Reload):
npm run dev

# Hoặc build bản Production tối ưu và chạy:
npm run build
npm run start -- -H 127.0.0.1 -p 4300
```
Mở trình duyệt tại **[http://127.0.0.1:4300](http://127.0.0.1:4300)** (hoặc `http://localhost:3000` tùy chế độ chạy).
---

## 6. Hướng dẫn Lập trình Bot (SDK Guide)

### 6.1. Luật chơi tóm tắt
- **Bàn cờ**: Kích thước lưới $N \times M$ (mặc định $8 \times 8$).
- **Di chuyển**: Mỗi lượt, bot được chọn một quân còn sống để di chuyển tới 1 trong 8 ô lân cận (kiểu nước đi của quân Vua trong cờ vua).
- **Quy tắc tương khắc (Oẳn Tù Tì)**:
  - ✊ **Búa** thắng ✌️ **Kéo**, thua 🖐️ **Bao**.
  - ✌️ **Kéo** thắng 🖐️ **Bao**, thua ✊ **Búa**.
  - 🖐️ **Bao** thắng ✊ **Búa**, thua ✌️ **Kéo**.
  - Không thể di chuyển vào ô có quân cùng phe hoặc quân địch cùng loại / quân địch khắc chế mình.
- **Điều kiện thắng**:
  1. Chiếm Hoàng toạ (Throne) của đối phương.
  2. Tuyệt diệt toàn bộ một chủng loại quân bất kỳ của đối phương (ví dụ: ăn hết toàn bộ Kéo của địch).
  3. Đối phương không còn nước đi hợp lệ hoặc bị xử thua do vi phạm (quá thời gian, crash, sai định dạng).

### 6.2. Giao thức truyền thông STDIO NDJSON
Bot giao tiếp với hệ thống thông qua `stdin` và `stdout` theo chuẩn JSON trên mỗi dòng:
1. **Lượt khởi tạo (`INIT`)**:
   - Nhận: Thông tin bàn cờ, phe thi đấu (`WHITE` hoặc `BLACK`), vị trí quân ban đầu.
   - Trả lời: `{"status": "READY"}` trong vòng **1000ms**.
2. **Lượt đi (`TURN`)**:
   - Nhận: Trạng thái bàn cờ hiện tại, danh sách quân còn sống, lượt đánh.
   - Trả lời: `{"action": "MOVE", "piece_id": 1, "target": [3, 4]}` trong vòng **100ms** (có 5ms grace).

### 6.3. Viết Bot bằng Python
Xem bot mẫu tại `sdk/python/starter_bot.py`:
```python
import random
from oantuti import Bot, Context, MoveAction

class MyBot(Bot):
    def on_init(self, ctx: Context) -> None:
        # Khởi tạo chiến thuật, lưu trữ toạ độ bản đồ
        pass

    def on_turn(self, ctx: Context) -> MoveAction:
        moves = ctx.get_legal_moves()
        if not moves:
            return None
        # Ưu tiên nước đi ăn quân đối phương hoặc tiến về hoàng toạ
        return random.choice(moves)

if __name__ == "__main__":
    MyBot().run()
```

### 6.4. Viết Bot bằng TypeScript
Xem bot mẫu tại `sdk/typescript/starter_bot.ts`:
```typescript
import { BotHandler, Context, MoveAction, runBot } from './oantuti';

const myBot: BotHandler = {
  onInit(ctx: Context): void {
    // Khởi tạo
  },
  onTurn(ctx: Context): MoveAction | null {
    const legalMoves = ctx.getLegalMoves();
    if (legalMoves.length === 0) return null;
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  },
};

runBot(myBot);
```

### 6.5. Viết Bot bằng C++20
Xem bot mẫu tại `sdk/cpp/starter_bot.cpp`:
```cpp
#include "oantuti.hpp"
#include <random>

class MyBot : public oantuti::Bot {
public:
    void on_init(const oantuti::Context& ctx) override {
        // Khởi tạo chiến thuật
    }

    std::optional<oantuti::MoveAction> on_turn(const oantuti::Context& ctx) override {
        auto legal_moves = ctx.get_legal_moves();
        if (legal_moves.empty()) return std::nullopt;
        return legal_moves[0];
    }
};

int main() {
    MyBot bot;
    bot.run();
    return 0;
}
```

---

## 7. Chạy thử trận đấu bằng dòng lệnh (CLI Runner)

Bạn có thể cho hai bot bất kỳ đấu thử trực tiếp trên máy cục bộ mà không cần bật Web Server:

```bash
# Cho Bot Python đấu với Bot C++ (Runner sẽ tự biên dịch mã nguồn C++):
npm run match:play -- \
  --map docs/specs/maps/sample-donut.map.json \
  --white sdk/python/starter_bot.py \
  --black sdk/cpp/starter_bot.cpp \
  --replay /tmp/demo-match.oantuti
```

Trận đấu sẽ in ra kết quả từng nước đi, lý do thắng/thua và lưu lại tệp replay nhị phân `.oantuti`. Bạn có thể nạp tệp này lên trang Web Replay để xem lại diễn biến bàn cờ.

---

## 8. Kiểm thử tự động (Testing)

Dự án có bộ test suite toàn diện sử dụng **Vitest** với hơn 400+ kiểm thử bao phủ toàn bộ engine, protocol, server và giao diện:

```bash
# Chạy toàn bộ test suite:
npm test

# Hoặc kiểm tra từng module chuyên biệt:
npm run test:engine    # Kiểm tra game engine và tính tất định
npm run test:protocol  # Kiểm tra mã hóa/giải mã Protobuf và NDJSON
npm run test:runner    # Kiểm tra bộ chạy bot và xử lý timeout
npm run test:web       # Kiểm tra các components giao diện web
npm run test:server    # Kiểm tra API Fastify, cơ chế giải đấu và quyền hạn
npm run test:load      # Chạy kiểm thử chịu tải WebSocket
```

---

## 9. Tài liệu tham khảo chuyên sâu

Để tìm hiểu chi tiết hơn về mặt kiến trúc kỹ thuật và vận hành:
- **[Đặc tả hệ thống v2](docs/specs/v2/README.md)**: Thiết kế chuẩn về mô hình dữ liệu, cơ chế giải đấu, và tiêu chuẩn bảo mật.
- **[Runbook bàn giao mạng LAN](docs/runbooks/lan-handover.md)**: Hướng dẫn dành cho ban tổ chức vận hành giải đấu tại địa điểm thi đấu.
- **[Khuyến nghị hạ tầng](docs/runbooks/infrastructure-recommendation.md)**: Hướng dẫn cấu hình máy chủ, CPU/RAM, backup và phân quyền hệ điều hành.
- **[Hướng dẫn chạy Demo và Test](docs/implementation/rebuild/demo-and-tests.md)**: Hướng dẫn chi tiết về các kịch bản demo và biến môi trường dev.

---

## Giấy phép (License)
Dự án được phát hành và bảo hộ theo các quy định nội bộ của nền tảng OanTuTi Tournament Platform. Mọi quyền được bảo lưu.
