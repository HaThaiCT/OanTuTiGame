# Khuyến nghị hạ tầng tối thiểu để vận hành OanTuTi Arena v2 (`LAN_OFFLINE`)

Tài liệu này đề xuất phần cứng/phần mềm để lập kế hoạch cho giải 500 đội; **không chứng minh máy nào đủ tải hoặc ETA**. Theo phạm vi bàn giao phần mềm hiện tại, không yêu cầu cấp máy, provision, infrastructure test, soak 72 giờ hay rehearsal 7 ngày. Các phép đo triển khai dưới đây chỉ là khuyến nghị cho đợt vận hành sau; không phải điều kiện hoàn thành delivery này hay chứng nhận release.

| Nhãn | Nghĩa |
|---|---|
| **[ĐO]** | Số đo thật trên host dev hiện tại, có tệp bằng chứng |
| **[SUY RA]** | Tính từ profile/định mức đã duyệt trong spec 02/05, hoặc ngoại suy từ số đo có nêu cơ sở |
| **[KHUYẾN NGHỊ]** | Kết luận kỹ thuật của tài liệu này, có dư địa; không phải số đo |

> Trạng thái release hiện tại: `releaseReady=false`. Tài liệu này **không** biến bất kỳ mục nào thành đã chứng nhận.

## 0. Tóm tắt cho người mua máy

| | Ước lượng cấu hình cơ sở (chưa đo) | Ước lượng có dư địa (chưa đo) | Ghi chú |
|---|---|---|---|
| CPU | 8 nhân vật lý / 16 luồng, x86-64 | **16–32 nhân vật lý** | Ứng viên để đo; không suy đủ tải từ số core |
| RAM | 32 GiB | **64 GiB** | Xem §2.2; 16 GiB chỉ đủ khi hạ số slot |
| Đĩa hệ thống | 256 GB SSD (NVMe/SATA) | **512 GB – 1 TB NVMe** | Nền tảng ~7 GB + dữ liệu giải (§2.3) |
| Đĩa backup | 1 TB, gắn **thường trực** khi giải chạy, **khác máy** | 2 TB + ổ thứ hai để luân chuyển | §4; RPO 5 phút không tha cho ổ cắm cuối ngày |
| Mạng | 1 GbE | 1 GbE (2.5 GbE nếu chiếu nhiều trận) | §5 |
| UPS | — | **Có**, ≥ 15 phút | §7; một máy, không HA |
| HĐH | Ubuntu Server 24.04 LTS amd64, kernel dòng GA 6.8 | như trên | §3; container **không** đổi kernel host |

Không cần: cluster, standby/HA, replication, Redis, S3/MinIO, GPU, VM thực thi, host thứ hai phục vụ, Windows/macOS/ARM.

## 1. Tải mà máy phải chịu

Một máy Linux duy nhất vừa chạy control plane + ledger + sandbox + web. Tải gồm 4 loại:

1. **Chạy trận (CPU-bound).** Mỗi turn: 1 bot hoạt động, trần **100 ms CPU**, trần tường 1.000 ms; startup 500 ms CPU/1.000 ms tường; trần bộ nhớ **256 MiB/bot, swap 0**. **10.000 ms CPU/job là trần compile, không phải toàn game**; compile 1 GiB, 1 core/job. Game tối đa 300 ply có turn-bound 30 giây CPU, watchdog toàn game 330 giây tường; không dùng các trần này như service time đã đo. [SUY RA — spec 03/05]
2. **Build/bài nộp.** Trần bài nộp: 128 tệp, 256 KiB/tệp, 4 MiB giải nén, ZIP 2 MiB (artifact nhận tối đa 64 MiB). Quota: 10 receipt/60 phút, 100/ngày/đội, tối đa 2 compile pending → trần lý thuyết 50.000 build/ngày cho 500 đội. [SUY RA — spec 01 §105/§108, spec 05 §49]
3. **Khán giả/HTTP.** 1.000 viewer × 60 delta/s × ~200 B ≈ 12 MB/s (~96 Mbit/s) payload, chưa tính TLS/WS framing và tải replay. [SUY RA — spec 05 §4.4]
4. **Nền tảng luôn chạy.** PostgreSQL, API, Next SSR, nginx, reclaimer/retention, sao lưu.

### 1.1. Khối lượng theo thể thức (500 đội, chưa tính retry hạ tầng) [SUY RA — spec 05 bảng §4.4]

| Thể thức | Cặp đấu | Ván | CPU (trần turn) | Giờ-slot (trần tường) |
|---|---:|---:|---:|---:|
| Loại trực tiếp | 499 | 1.996–3.992 | 16,6–33,3 core-hours | 166–333 |
| Swiss 9 vòng + playoff top 16 | 2.265 | 4.560–4.620 | ~38 core-hours | ~385 |
| Round robin một lượt | 124.750 | 249.500 | 2.079 core-hours | 20.792 |
| Elo liên tục | 250E | 500E | 4,17E core-hours | 41,67E |

Bảng là mô hình khối lượng theo trần luật, không phải benchmark hay ETA. Chưa bao gồm compile/TEST, retry, startup/IPC, sandbox gVisor, I/O, thời gian grace/seal và headroom cho API/PG.

## 2. Phần cứng

### 2.1. CPU [KHUYẾN NGHỊ]

- **8 nhân/16 luồng**, **16 nhân** và **32 nhân** là các ứng viên ngân sách để cân nhắc, không phải bằng chứng đủ chạy một thể thức hoặc hoàn thành trong vài ngày.
- `C` (game slots) và `B` (build slots) phải để lại CPU cho API/PG và overhead sandbox; không suy số slot khả dụng bằng số nhân hoặc số luồng danh nghĩa. Chọn admission từ service distribution đo trên sandbox thực, không CPU turn-bound.
- Ưu tiên nhân **vật lý**; HT giúp web/PG nhưng không tăng gấp đôi thông lượng sandbox.
- Không cần GPU. Không cần CPU mới nhất; cần **ổn định nhiệt** khi chạy liên tục nhiều ngày.

### 2.2. RAM

Công thức ngân sách **ước lượng**, không phải RSS/peak đã đo [SUY RA — spec 05 §4.4]:

```
RAM ≈ C×2×256 MiB (bot)  +  B×1 GiB (build)  +  PostgreSQL  +  API/web/reclaimer  +  OS  +  dư địa
```

| Kịch bản | Tính | Tổng |
|---|---|---|
| `C=4`, `B=2` | 2 GiB + 2 GiB + 3 GiB + 2 GiB + 2 GiB | ~11 GiB → **16 GiB** là sàn tuyệt đối |
| `C=8`, `B=4` | 4 GiB + 4 GiB + 4 GiB + 2 GiB + 2 GiB | ~16 GiB → **32 GiB** khuyến nghị |
| `C=16`, `B=8`, web SSR tải cao | 8 GiB + 8 GiB + 6 GiB + 4 GiB + 3 GiB | ~29 GiB → **64 GiB** |

Các tổng trên **chưa** gồm runtime/supervisor/gVisor sandbox overhead, page cache, staging/giải nén và biến động peak. Phần build đã có 1 GiB/job trong công thức; không cộng trùng định mức đó như số đo bổ sung. Host dev 7,7 GiB trong bằng chứng S16 không phải cấu hình khuyến nghị.

### 2.3. Đĩa

Đo thật trên host dev [ĐO]:

| Thành phần | Kích thước |
|---|---|
| Repo + artefact build (không tính `.git`) | 2,5 GB (trong đó `node_modules` 615 MB, `.next` 111 MB) |
| Cụm PostgreSQL 16 (dữ liệu dev, nhẹ) | 596 MB |
| Prefix toolchain (Rust/Node/PG/WASM…) | 2,1 GB |
| Rootfs sandbox (gVisor + compiled starter) | 1,2 GB |
| **Nền tảng, chưa có dữ liệu giải** | **~7 GB** |

Dữ liệu sinh ra trong giải:

| Loại | Kích thước | Cơ sở |
|---|---|---|
| Replay 1 ván | trung bình **1,29 KB**, lớn nhất **8,94 KB** ở 122 ply | [ĐO — 963 replay trong ledger dev] |
| Bài nộp | ≤2 MiB ZIP / ≤4 MiB giải nén, 128 tệp | [SUY RA — spec 01 §105] |
| Trần lý thuyết bài nộp | 50.000 build/ngày × 4 MiB ≈ 200 GB/ngày | [SUY RA — *trần chính sách*, không phải con số lập kế hoạch] |

963 replay dev không đại diện cho mọi map/bot/300 ply. Không ngoại suy tuyến tính bytes/ply hay kết luận replay luôn nhỏ; lập ngân sách theo phân phối replay thực tế, source/artifact, retention, WAL, PostgreSQL và staging. Khuyến nghị dung lượng bên dưới là **ước lượng**, không phải bảo đảm:

- **256 GB SSD** là sàn cho 1 giải thường niên; **512 GB – 1 TB NVMe** là mức nên mua, vì còn đĩa staging, spool sandbox, WAL, ảnh container, và bản sao trước khi đẩy ra ngoài máy.
- Đặt cảnh báo tại **80% (warning)** và **90% (page)** như spec 05 §6 yêu cầu; ở 90% phải dừng nhận bài/ghi mới, không tự xoá dữ liệu (hold dispute/security chặn purge).
- **Không** đặt thư mục backup trên cùng máy/đĩa: spec coi "thư mục khác cùng host" là **không đạt** yêu cầu.

## 3. Phần mềm phải ghim

| Thành phần | Phiên bản/digest | Nguồn |
|---|---|---|
| HĐH | Ubuntu Server 24.04 LTS amd64 | [SUY RA — spec 03 §10, BOM S01] |
| Kernel | dòng **GA 6.8** (khớp baseline đã chọn) | [SUY RA — spec 03 §10] |
| Init/cgroup | systemd + cgroup v2 | [SUY RA — spec 03 §10] |
| PostgreSQL | **16** | [SUY RA — spec 03 §10] |
| Node.js | **24 LTS** (BOM dev ghim `v24.22.0`/`v24.21.0`) | [ĐO — `S01-bom-inventory.json`] |
| Python | 3.12 | [SUY RA — spec 02/03 runtime] |
| C++ | g++ 13, chuẩn C++20 | [SUY RA — spec 02 runtime] |
| Rust (build verifier/WASM) | 1.99.x + target `wasm32-unknown-unknown`, `wasm-bindgen 0.2.129` | [ĐO — S01 ledger] |
| gVisor `runsc` | build `gvisor-20261005.0`, sha256 `210b437a…24f7a` | [ĐO — `deploy/linux/smoke-gvisor.py`] |
| Rootfs sandbox | compiled-starter `fac7d1f7…446fbb`; trusted-match `63768f52…3865b4` | [ĐO — `install-three-language.sh`, `trusted-match.py`] |
| nginx | bản ổn định của distro (TLS/SSR proxy, WebSocket) | [SUY RA — gói Compose] |
| Docker + Compose (nếu dùng đường container) | Engine ≥ 24, Compose **v2** plugin | [ĐO — `portable-deployment.md`] |

Nguyên tắc: ghim **digest**, không dùng "latest"; mọi thay đổi phiên bản đi kèm review bảo mật và cập nhật BOM. Toolchain của ba ngôn ngữ Bot nằm **trong rootfs sandbox đã ghim**, không lấy từ host.

## 4. Lưu trữ backup và bàn giao khoá

| Yêu cầu | Nội dung |
|---|---|
| Vị trí | **Khác máy, khác đĩa**; LAN dùng phương tiện tháo rời/NAS **gắn thường trực suốt thời gian giải chạy** |
| Dung lượng | ≥ 2× tập dữ liệu được bảo vệ, và ≥ **1 TB** để chứa 35 ngày retention + luân chuyển |
| Nội dung | Base backup + WAL archive + inventory object bất biến (replay/artifact/source) |
| Tần suất | Đủ để **RPO ≤ 5 phút**; thiếu pipeline này thì preflight/start bị chặn theo spec |
| Khôi phục | **RTO ≤ 30 phút** là mục tiêu cần đo khi triển khai sau này, chưa phải kết quả hay yêu cầu infrastructure test của delivery hiện tại |
| Custody | Tối thiểu **2 người** của trường giữ khoá CA, tài khoản quản trị và phương tiện backup; không để khoá trong Git/repo/báo cáo |
| Media dự phòng | Ít nhất 1 ổ luân chuyển dự phòng, vì không có host standby |

Ổ chỉ cắm cuối ngày **không** đáp ứng RPO 5 phút (spec nói rõ). Bản sao cùng máy/đĩa không tính là backup.

## 5. Mạng

- **LAN tối thiểu 1 GbE** giữa máy chủ và switch: 1.000 viewer ≈ 96 Mbit/s payload [SUY RA], cộng WebSocket framing/TLS và tải replay. Số đo dev: frame trung bình 27,8 B, p99 17,3 ms ở 500 client và 19,6 ms ở 1.000 client [ĐO — S16].
- Nếu chiếu nhiều trận song song hoặc tải replay tập trung: **2,5 GbE** trở lên.
- Mạng ra Internet của vùng chạy Bot: **chặn** (WAN-deny). Máy chủ chỉ cần Internet cho cập nhật/vá, và trong `LAN_OFFLINE` phải chạy được **hoàn toàn không có WAN**.
- Nếu đặt nginx phía trước API: khai báo `OANTUTI_TRUSTED_PROXIES` đúng địa chỉ proxy, nếu không throttle đăng nhập sẽ gộp mọi người vào một bucket (30 lần sai → khoá toàn bộ 15 phút).
- Cổng chỉ bind loopback; không mở PostgreSQL/API ra LAN.

## 6. Con người và quy trình (một phần của hạ tầng)

- **Người trực khi giải chạy**: có mặt tại chỗ để xác nhận cảnh báo trong **≤ 5 phút**; ở LAN cảnh báo phát tại máy (âm thanh/console), không phụ thuộc email/Internet.
- **Hai người giữ khoá** (CA, ADMIN, backup) và một đầu mối escalation ngoài nhóm viết code.
- **Người ký nghiệm thu**: người vận hành + người đánh giá an ninh độc lập (G0–G4); thiếu chữ ký thì không được coi là phát hành.
- Sao lưu phải có người **kiểm tra khôi phục định kỳ**, không chỉ chạy script.

## 7. Điện, phòng, độ bền vật lý

- **UPS tối thiểu 15 phút** [KHUYẾN NGHỊ]: hệ thống là một máy, không có standby; mất điện đột ngột giữa ván làm gián đoạn giải và buộc quy trình khôi phục.
- Ổ hệ thống nên là SSD/NVMe; tản nhiệt đủ cho tải liên tục. Soak 72h/rehearsal 7 ngày là khuyến nghị validation vận hành tương lai, không bắt buộc trong delivery phần mềm này.
- Không cần máy thứ hai; nhưng nếu trường có máy tương đương cấu hình, dùng nó để **tập khôi phục** là cách rẻ nhất để đạt RTO.

## 8. Khuyến nghị xác nhận cấu hình khi triển khai sau này

Không có lệnh dưới đây phải chạy trong delivery hiện tại. Khi operator được phép đo trên máy thật, chạy từ repo root sau khi cài dependency và cấu hình đúng DB/backup/sandbox:

```sh
python3 deploy/linux/lan-preflight.py --root .
node --import tsx deploy/linux/capacity-probe.ts --clients 1000 --out /tmp/capacity.json
node --import tsx deploy/linux/soak-probe.ts --minutes 60 --api http://127.0.0.1:4301 --out /tmp/soak.json
# Chỉ parity: khai báo PGHOST/PGPORT/PGDATABASE/PGUSER đúng ledger và đường dẫn verifier đã build.
node --import tsx deploy/linux/verify-replay-parity.ts --limit 5 --rust-bin "$VERIFY_TRACE_BIN" --wasm "$REPLAY_WASM_BIN"
```

`capacity-probe` và `soak-probe` là probe dev có giới hạn, không chứng minh mixed-load sandbox, 72h/7 ngày hoặc SLO production. Script parity hiện đọc cố định `storage/replays` trong repo; chỉ dùng ledger tương ứng và artifact verifier đúng digest, không dùng cho object store khác. Không gọi một lần chạy thành công là chứng nhận. Nếu không có capacity evidence cho giải dự kiến, không hứa ETA/capacity và không bỏ qua admission `BLOCKED_CAPACITY` trong phần mềm.


## 9. Ví dụ ba cấu hình cụ thể

| | Ứng viên cơ sở | Ứng viên có dư địa | Ứng viên ngân sách cao |
|---|---|---|---|
| CPU | 8C/16T | 16C/32T | 32C/64T |
| RAM | 32 GiB | 64 GiB | 128 GiB |
| Đĩa hệ thống | 256 GB SSD | 1 TB NVMe | 2 TB NVMe (hoặc 2×1 TB RAID1) |
| Slot chạy | `C=4`, `B=2` | `C=8`, `B=4` | `C=16`, `B=8` |
| Backup | 1 TB ngoài máy | 2 TB ngoài máy | 2 TB + ổ luân chuyển |
| UPS | có | có | có |

Các cấu hình/slot ở bảng là **ước lượng ngân sách**, chưa tính đầy đủ overhead sandbox và không kèm ETA hay cam kết đủ tải. Cần số đo mixed-load thật mới xác nhận lựa chọn cho một giải cụ thể.

## 10. Những gì không được cắt

Dù chọn cấu hình nào, các mục sau là điều kiện vận hành, không phải tùy chọn: dải loopback-only; sandbox gVisor + UID/cgroup riêng cho vùng chạy; swap 0 trong cgroup Bot; backup off-host gắn thường trực; fence backup; PostgreSQL với checksums/fsync/role tách biệt; và không chạy code sinh viên bằng dev executor.
