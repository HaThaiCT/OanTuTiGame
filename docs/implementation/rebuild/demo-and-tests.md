# Chạy demo và test trên workspace rebuild

Tài liệu này chỉ cách chạy **bộ test đầy đủ** và **một demo đầu-cuối thật** trên workspace
`/home/ha-thai/OanTuTi-rebuild` (portal Next.js `127.0.0.1:4300`, API Fastify `127.0.0.1:4301`,
PostgreSQL qua Unix socket `55434`). Mọi thao tác đều đi qua API thật của sản phẩm — công cụ demo
không ghi thẳng vào DB để tạo kết quả.

## 1. Điều kiện chạy

Ba tiến trình phải đang chạy (chúng là service có giám sát, xem `proc://`):

| Thành phần | Lệnh | Cổng/socket |
|---|---|---|
| PostgreSQL | `arena-rebuild-pg` | socket `/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/pg16/socket`, port `55434` |
| API | `PORT=4301 HOST=127.0.0.1 OANTUTI_DEV_EXECUTION=1 OANTUTI_BACKUP_FENCE=off PGHOST=… PGPORT=55434 PGDATABASE=arena_rebuild_c72cd5a74f33 PGUSER=arena_rebuild_app node --import tsx packages/server/src/index.ts` | `127.0.0.1:4301` |
| Portal | `cd packages/web && npm run start -- -H 127.0.0.1` | `127.0.0.1:4300` |

`OANTUTI_DEV_EXECUTION=1` bật `TournamentAutoRunner` (tick 5 giây) — **không có nó thì giải sẽ
không tự đấu**. Portal đang phục vụ bản **production build**: sửa `packages/web/**` thì phải
`npm run build` rồi khởi động lại service mới thấy thay đổi.

## 2. Chạy test

```bash
PGHOST=/home/ha-thai/.local/share/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d/pg16/socket \
PGPORT=55434 PGUSER=arena_rebuild_migrator PGDATABASE=arena_rebuild_c72cd5a74f33 \
OANTUTI_DEV_EXECUTION=1 npm test
```

Kết quả đã kiểm chứng trong phiên này: **69 test file passed, 421 test passed / 1 skipped**, ~38 giây.

- Chạy từng phần: `npm run test:server` (326 passed / 1 skipped), `test:engine`, `test:runner`,
  `test:protocol`, `test:web`, `test:specs`, `test:proto`.
- **Bắt buộc có env PG.** Thiếu env, `packages/server/src/persistence/db.ts` rơi về cấu hình mặc
  định (socket `…/development/pg16/socket`, port `55432`) — instance đó không chạy ở đây, và ~34 test
  file fail vì không kết nối được. Đó là lỗi môi trường, không phải regression.
- `npm test` **re-seed database dev**: dữ liệu bạn tạo bằng tay (giải, đội, tài khoản) sẽ bị thay
  bằng fixture của test. Chạy demo trước, hoặc seed lại sau khi test.
- Benchmark tải (`tests/load`/`load-benchmark.test.ts`) chạy trong suite: 500 spectator, không mất
  gói, p99 < 80 ms. Đo capacity trên host thật là `npm run measure:capacity`.

## 3. Chạy demo

```bash
# từ gốc repo, với env PG như trên
npm run demo:seed -- --teams 2                                  # mặc định SINGLE_ELIMINATION
npm run demo:seed -- --format ROUND_ROBIN --teams 4             # hoặc SWISS_PLAYOFF / ELO_ARENA
npm run demo:seed -- --format SWISS_PLAYOFF --teams 8 --grace 5 # grace 5 phút
npm run demo:seed -- --format ROUND_ROBIN --teams 4 --rated --tag RATED # opt-in Rating global
npm run demo:status                                             # tóm tắt các giải demo
npm run demo:login system_admin                                 # in session cookie để mở portal
```

Tùy chọn: `--teams 2..16`, `--format`, `--tag <TAG>` (đổi tên học phần/giải/map), `--grace 0..1440` (demo mặc định 0 phút).
Mặc định mọi giải là **Unrated**. `--rated` ghim lựa chọn Rated trước khi mở đăng ký và đặt cửa sổ kháng nghị 0 phút cho demo. Sau khi giải `PROVISIONAL`, ADMIN vẫn phải `finalize`; sau đó dùng `/organizer/tournaments/<id>?tab=adjudication` để review, re-auth và phê duyệt Rating. Công bố Rating là bước riêng, không tự chạy cùng với finalize.

`demo:seed` thực hiện đúng trình tự của một kỳ thi thật, rồi in ra URL để mở:

1. tạo học phần (`POST /organizer/courses`) và cấp tài khoản đội trưởng
   (`POST /organizer/accounts/provision-lan`, in mật khẩu tạm một lần);
2. tạo đội (`POST /organizer/teams`) với đội trưởng vừa cấp;
3. publish bộ bản đồ demo: **4 map cho SINGLE_ELIMINATION/SWISS_PLAYOFF, 1 map cho ROUND_ROBIN/ELO_ARENA**
   — luật `02-GAMEPLAY §153`, thiếu map thì `POST …/start` trả `MAP_POOL_TOO_SMALL`;
4. tạo giải mới, đưa cả bộ map vào pool, **commit** map #1, publish, mở đăng ký, ghi danh đội
   (`POST /organizer/tournaments/:id/enroll`);
5. mỗi đội nộp **starter bot trong SDK** (`sdk/python/starter_bot.py` + `oantuti.py`) bằng chính
   session của đội trưởng, rồi chờ tới khi build `READY`;
6. đặt **grace** (`POST …/grace`) — chỉ đặt được khi giải còn `DRAFT`/`PUBLISHED`, vì chính sách bị
   đóng băng lúc mở đăng ký;
7. `close-registration` → `lock` → `start` (map đã commit), chờ auto-runner đấu xong **và vòng 1 seal**,
   rồi in ra vòng/đối đầu/điểm và bảng xếp hạng (nếu thể thức có).

Kết quả đã kiểm chứng trong phiên này:

- `SINGLE_ELIMINATION`, 2 đội, grace 0: build `READY`, **4/4 ván hoàn tất**, vòng 1 `SEALED`, giải sang
  `PROVISIONAL`; đối đầu hiển thị `Demo Team 1 3.0 : 0.0 Demo Team 2 · 4 ván · winner Demo Team 1`
  (~15 giây). Thể thức loại trực tiếp **không có bảng xếp hạng dạng snapshot** — kết quả nằm ở nhánh đấu.
- `ROUND_ROBIN`, 4 đội, grace 0: **12/12 ván, 3/3 vòng sealed** trong ~10 giây, 6 cặp đấu 1–1 và bảng xếp
  hạng thật (`#1 Demo Team 1 · 3.0 pts · 0W/3D/0L · Elo 1200.00`, cả 4 đội bằng điểm vì bot giống nhau).
  Trang công khai hiện điểm từng cặp `1 – 1` kèm liên kết *Kết quả* / *Xem replay* cho từng ván.
- Bảng xếp hạng chỉ xuất hiện **sau khi vòng được seal**; nếu vòng còn `SEAL_ELIGIBLE` thì
  `demo:status` nói rõ đang chờ grace.

Mở các URL mà script in ra:

| URL | Nội dung |
|---|---|
| `/tournaments/<id>` | trang công khai: thể thức, map đã commit (`DEMO Arena 8x8 #1 · v1`), nhánh đấu, tỉ số, trạng thái |
| `/projector/<id>` | màn trình chiếu cho sân khấu (tự làm mới 10 giây, nút toàn màn hình) |
| `/replays?game=<gameId>` | replay: checksum SHA-256 kiểm tra ngay trên browser + nút xác minh bằng engine WASM |
| `/workspace` → `/tournaments/<id>` | đường của sinh viên: nộp bài, test riêng tư, xem kết quả đội mình |
| `/organizer` | bảng điều khiển ban tổ chức: vòng đấu, sửa kết quả, kháng nghị, finalize |

`demo:login <username>` mint một session 4 giờ và in câu lệnh dán vào DevTools của browser:

```js
document.cookie = 'oantuti_session=<token>; path=/';
```

Cookie này đã có mốc re-auth nên các thao tác phá huỷ (start/pause/finalize…) chạy được; đăng nhập
bằng mật khẩu thật vẫn đi qua `/auth/login` như người dùng cuối.

## 4. Tài khoản để test giao diện

Không ghi mật khẩu vào repo — cấp và in ra bằng một lệnh (mỗi lần chạy **xoay** mật khẩu):

```bash
npm run demo:accounts            # in mật khẩu tạm cho ADMIN + các đội trưởng demo_capN
npm run demo:login <username>    # hoặc mint session 4 giờ, không cần mật khẩu
```

`demo:accounts` mô phỏng đúng luồng cấp lại của sản phẩm: đặt mật khẩu tạm mới, đặt
`password_change_required = TRUE`, **thu hồi mọi session cũ** của tài khoản đó và ghi
`ADMIN_PASSWORD_RESET` vào audit (kèm `source: DEV_DEMO_ACCOUNTS`).

Đăng nhập lần đầu bằng mật khẩu tạm (luồng `ADMIN_ISSUED` thật):

1. mở `/workspace`, nhập tài khoản + mật khẩu tạm;
2. portal trả về phiên `PASSWORD_CHANGE_ONLY` và hiện **form “Đổi mật khẩu lần đầu”** — mọi trang khác
   (kể cả `/organizer`) chuyển hướng về đây vì phiên giới hạn chỉ cho phép đổi mật khẩu hoặc đăng xuất;
3. đặt mật khẩu mới (≥ 12 ký tự, UI; API yêu cầu ≥ 8) → server thu hồi mọi phiên cũ và cấp phiên `FULL`,
   portal vào thẳng không gian đội (hoặc bảng điều khiển ban tổ chức với ADMIN).

Tài khoản có sẵn sau `demo:seed`: một ADMIN (tài khoản ADMIN đầu tiên trong DB, thường là `system_admin`)
và một đội trưởng cho mỗi đội demo (`demo_cap1…N`). Sau khi chạy `npm test`, DB bị re-seed: chạy lại
`npm run demo:seed` rồi `npm run demo:accounts`.

## 5. Ghi chú vận hành

- `demo:seed` chạy lại được: học phần, tài khoản, đội và map được tái sử dụng, mỗi lần chạy tạo một
  giải mới nên giải cũ vẫn xem lại được.
- Nộp bài **phải** kèm SDK trong zip (`oantuti.py`); thiếu nó build sẽ `SMOKE_TEST_FAILED: CRASH_FORFEIT`
  và bài bị `REJECTED`.
- Nguồn sự thật về luật/thể thức: `docs/specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md`; cổng bản đồ là
  `packages/server/src/tournaments/lifecycle-service.ts` (`MAP_POOL_TOO_SMALL`).
