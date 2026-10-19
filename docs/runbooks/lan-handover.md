# Runbook bàn giao LAN — OanTuTi Arena v2 (`LAN_OFFLINE`)

Tài liệu này để người vận hành (giảng viên/ban tổ chức) **tự chạy giải mà không cần trợ lý**: cài đặt, chạy/dừng, cập nhật, sao lưu, xử lý sự cố, và danh sách bằng chứng phải có trước khi ký nghiệm thu.

> **Phạm vi hiện tại:** bàn giao phần mềm LAN; **không yêu cầu provision/cấp máy, infrastructure test, soak 72h hay rehearsal 7 ngày**. Các mục đó và drill off-host bên dưới là khuyến nghị cho triển khai vận hành sau, không chặn hoàn thành delivery này. Đây **không** là chứng nhận production: `releaseReady=false`; G0–G4 chưa ký. `executionReady` phải đọc từ readiness của runtime hiện hành; snapshot lịch sử không phải trạng thái live.

## 0. Phạm vi và trạng thái

| Hạng mục | Giá trị hiện tại |
|---|---|
| Profile đang chạy | `LAN_OFFLINE` (tài khoản do ADMIN cấp, không tự đăng ký, không email) |
| `ONLINE` | `DEFERRED_BY_USER` — chưa làm, không phải lỗi phụ thuộc |
| Ngôn ngữ Bot | Python, TypeScript, C++20 |
| Ledger chính thức | PostgreSQL 16 (không phải `legacy.sqlite`) |
| Vùng chạy Bot | Gateway sandbox gVisor + UID riêng; kiểm readiness hiện hành, không suy từ presence của binary |
| Đích chứng nhận vận hành tương lai | Ubuntu Server 24.04 LTS, kernel GA 6.8, amd64; chưa chứng nhận trên host phát hành |

## 1. Kiến trúc vận hành

Ba tiến trình, một host, đều chỉ nghe loopback:

| Thành phần | Vai trò | Cổng mặc định | Dữ liệu |
|---|---|---|---|
| `packages/server` (Fastify) | Control plane, ledger, WebSocket khán giả | `127.0.0.1:4301` | PostgreSQL qua Unix socket |
| `packages/web` (Next standalone) | Portal SSR công khai + khu vực riêng | `127.0.0.1:4300` | không có trạng thái riêng |
| PostgreSQL 16 | Ledger + object index | Unix socket (dev) / volume (Compose) | `runtimeRoot` (dev) hoặc named volume |

Hai hình dạng triển khai, **không trộn**:

1. **Gói container (đường phát hành đã đóng gói):** `docker compose` với PostgreSQL + Next standalone + nginx proxy. Xem [portable-deployment.md](../implementation/rebuild/portable-deployment.md) để biết biến môi trường, secret dạng file và các giới hạn đã đo. `OANTUTI_DEV_EXECUTION=0` là mặc định — không chạy code sinh viên trong container API.
2. **Stack phát triển/demo trên host (đang dùng ở đây, dùng để duyệt UI/nghiệp vụ):** API `node --import tsx packages/server/src/index.ts`, web `next start` sau khi `npm run build`, PostgreSQL cluster riêng dưới `runtimeRoot` chỉ nghe Unix socket, role tách biệt `app`/`migrator`/`backup`. Stack này **không** thay thế gói phát hành và **không** được dùng cho giải thật khi chưa cài sandbox.

Các đơn vị `systemd` cho môi trường trường học **chưa được viết** (không có file unit nào trong repo). Cho tới khi có, đường phát hành duy nhất đã đóng gói là Compose; muốn chạy bằng systemd phải viết unit, ghim UID riêng cho từng vai trò và chứng nhận lại quyền socket — không suy diễn từ tài liệu này.

Cần mua/cấp máy và phần mềm gì: [khuyến nghị hạ tầng](infrastructure-recommendation.md) (CPU/RAM/đĩa/mạng, phiên bản phải ghim, backup off-host, quy tắc chốt cấu hình bằng probe).

## 2. Kiểm tra trước khi chạy

```sh
# Kiểm kê host, chỉ đọc, không đổi cấu hình. Trả JSON ra stdout.
python3 deploy/linux/lan-preflight.py --root .
```

Các trường phải đọc đúng nghĩa:

| Trường | Ý nghĩa | Giá trị chặn |
|---|---|---|
| `baselineKernelMatches` | Host có đúng dòng kernel GA 6.8 đã chọn | `false` → không được chạy giải thật |
| `executionReady` | Đã có cgroup uỷ nhiệm + runsc + bộ tiêu thụ workload xác thực UID | `false` → không có vùng chạy Bot |
| `releaseReady` | Đã qua mọi cổng | luôn là `false` cho tới khi ký |
| `pendingProof` | Việc còn thiếu, có tên cụ thể | mỗi dòng cần một bằng chứng riêng |
| `disk.freeBytes` | Chỗ trống thật cho object store/WAL/spool | phải dương và có dư địa |

Cấu hình phát triển phải qua validator trước khi dùng: `deploy/linux/rebuild-config.mts` từ chối DB/donor path, path traversal, vùng lưu trữ chồng nhau, role dùng chung DDL, listener công khai và mọi trường "production-ready" khai báo suông.

Sức khỏe runtime (khác với "host đã đủ điều kiện"):

```sh
curl -sS http://127.0.0.1:4301/api/health        # liveness: tiến trình còn sống
curl -sS http://127.0.0.1:4301/api/health/ready  # readiness: nhận được loại job nào
```

`/api/health/ready` trả `ready` hoặc `degraded` **kèm lý do máy đọc được** cho từng check (`database`, `schema`, `executionGateway`, `executionPlane`, backup freshness). Đọc kết quả theo bảng:

| Check | `ok:false` nghĩa là | Việc phải làm |
|---|---|---|
| `database` | Không kết nối được ledger | Kiểm tra service PostgreSQL và socket, không "chạy lại cho xong" |
| `schema` | Version schema khác bản build | `node --import tsx deploy/linux/apply-migrations.mts --status`, rồi `--apply` có xác nhận và đúng PG env (§3) |
| `executionGateway` | Chưa cấu hình gateway sandbox → không dispatch được việc có sandbox | Đọc lý do hiện hành; không bật `OANTUTI_DEV_EXECUTION` để che lỗi |
| `executionPlane` | Thiếu UID/cgroup uỷ nhiệm cho vùng chạy | Cài đặt phần sandbox và chạy canary |
| backup freshness | Không có checkpoint off-host hợp lệ | Xem §6; nếu `OANTUTI_BACKUP_FENCE=enforce`, protected writes bị tạm dừng |

`status: "degraded"` vẫn cho phép đọc công khai; nó **không** cho phép chấm điểm chính thức khi gateway/plane chưa sẵn sàng.

## 3. Chạy, dừng, cập nhật

### Gói container (đường phát hành)

```sh
export PG_OWNER_PASSWORD_FILE=/absolute/private/postgres-owner   # file ngoài repo, quyền hẹp
export PG_APP_PASSWORD_FILE=/absolute/private/postgres-app
export PUBLIC_ORIGINS=http://127.0.0.1:3000
export OANTUTI_BACKUP_FENCE=off  # chỉ demo; vận hành thật dùng enforce và checkpoint backup hợp lệ
docker compose config --quiet          # bắt lỗi cấu hình, không khởi động
docker compose up -d --build           # chạy
docker compose ps                      # trạng thái
docker compose logs -f server          # log API (web/nginx riêng)
docker compose down                    # dừng, GIỮ named volume
```

- **Không bao giờ** `docker compose down -v` trên dữ liệu thật.
- Khởi tạo volume rỗng cài schema phiên bản và cấp DML cho role ứng dụng; đó **không** phải cơ chế nâng cấp. Volume đã có dữ liệu: sao lưu đã xác minh, rồi chạy applier bằng **container vận hành** (nó mang secret của role owner; container API thì không):
  ```sh
  export OANTUTI_MIGRATE_CONFIRM=arena     # tên PGDATABASE trong docker-compose.yml (phải khớp chính xác)
  docker compose --profile ops run --rm ops \
    deploy/linux/apply-migrations.mts --apply --grant-to arena_app
  ```
- **Chỉ chạy một lần nếu volume đã tồn tại trước checksum ledger:** xem lại lịch sử/schema đang cài và đối chiếu các migration đã áp dụng; sao lưu đã xác minh; sau đó xác nhận chính xác database name và chạy applier với `--baseline`. Lệnh chỉ lấp checksum còn thiếu, không sửa migration bị lệch; checksum sai vẫn bị từ chối. Không baseline một DB đang có đủ checksum và không dùng thao tác này để bỏ qua migration pending:
  ```sh
  export OANTUTI_MIGRATE_CONFIRM=arena
  docker compose --profile ops run --rm ops \
    deploy/linux/apply-migrations.mts --apply --baseline
  ```
- Sau baseline, `--status` phải trả 0 pending/0 checksum lỗi; migration mới chạy bằng lệnh nâng cấp thông thường. Database demo không được baseline tự động.
- Database chưa có bảng `schema_migrations` là deployment mới: cùng lệnh trên áp toàn bộ migration theo thứ tự (001 tạo bảng tracking).
- Nâng cấp = build image mới rồi `up -d` lại; rollback trong cửa sổ 7 ngày bằng image trước đó (schema expand/contract, chưa drop cột).

### Stack host (phát triển/demo)

```sh
export PGHOST=/absolute/runtimeRoot/pg16/socket PGPORT=55434
export PGUSER=arena_rebuild_app PGDATABASE=arena_rebuild_example
export OANTUTI_BACKUP_FENCE=off        # chỉ ở dev; production để enforce
export PORT=4301 HOST=127.0.0.1 OANTUTI_DEV_EXECUTION=1
node --import tsx packages/server/src/index.ts

# web: build xong mới chạy, sửa packages/web không tự có hiệu lực
(cd packages/web && npm run build) && (cd packages/web && npm run start -- -H 127.0.0.1)
```

Sửa mã server thì phải **khởi động lại** tiến trình API (nó nạp TS lúc start, không watch). Sửa `packages/web` thì phải `npm run build` lại và restart tiến trình web. Biến PG, tài khoản demo và cách chạy suite: [demo-and-tests.md](../implementation/rebuild/demo-and-tests.md).

### Launch native bình thường (khi operator đã provision riêng)

Không dùng dev executor. Cung cấp `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` và credentials cho app role đúng cluster; native API không fallback sang DB dev. `OANTUTI_NATIVE_CONFIG` là đường dẫn **tuyệt đối** tới JSON private do operator quản lý: regular file, không symlink, tối đa 64 KiB, không group/world-writable. Không đặt secret trong repo. API đọc contract `LocalJobBrokerOptions` qua `packages/server/src/jobs/runtime-config.ts`:

- `executable`: binary broker được duyệt; `socketPath`: Unix socket; `workerUid` dương và `socketGid`: danh tính OS/socket đã cấp.
- `deploymentGeneration`: generation hiện hành trong `backup_identity`, không tự chọn/reset sau restore.
- `runtimeProfileDigest`: SHA-256 profile thực đã duyệt; `maxBuildSlots`, `maxGameSlots`: admission đã cấu hình, không phải cam kết capacity.
- `spoolRoot`, `compiledArtifactsDir`: absolute operator-owned roots.
- `toolchains`: đúng ba language `PYTHON`, `TYPESCRIPT`, `CPP`, mỗi item có `imageDigest` SHA-256 thật, `version` không rỗng và `flags` cố định; khớp manifest/rootfs worker. Không dùng hash giả hay lấy path từ HTTP/job.

```sh
# Các biến *_CONFIG/*_BIN/path dưới đây là operator references đã cấp, không phải defaults.
export OANTUTI_NATIVE_CONFIG="$NATIVE_CONFIG_FILE"
export OANTUTI_DEV_EXECUTION=0
node --import tsx packages/server/src/index.ts

# Terminal/service riêng dưới đúng worker UID, không chạy code sinh viên bằng API UID.
"$ARENA_WORKER_BIN" \
  --broker-socket "$BROKER_SOCKET" --runsc "$RUNSC_BIN" \
  --runtime-rootfs "$RUNTIME_ROOTFS" --cgroup-root "$DELEGATED_CGROUP_ROOT" \
  --attempt-root "$ATTEMPT_ROOT" --runtime-profile-digest "$RUNTIME_PROFILE_DIGEST" \
  --max-game-slots "$GAME_SLOTS" --max-build-slots "$BUILD_SLOTS" \
  --toolchains "$TOOLCHAINS_DOCUMENT" --artifact-output-root "$COMPILED_ARTIFACTS_ROOT"
```

`ARENA_WORKER_BIN` phải có sibling binary **`arena-reaper`** cùng directory. Worker flags hiện hành do `WorkerConfig::from_arguments` trong `crates/arena-supervisor/src/worker.rs` định nghĩa; bản parser này **chưa có `--help`**. Tùy chọn thêm `--heartbeat-seconds`, `--poll-seconds`, `--once`; không dùng `--once` cho service thường trực. `NATIVE_CONFIG_FILE` và worker document/UID/socket/rootfs/digest phải nhất quán. Bật native cùng `OANTUTI_DEV_EXECUTION=1` bị từ chối. Không có bước nào ở đây đã provision hoặc chứng nhận host.

### Migrations

```sh
# PGHOST/PGPORT/PGDATABASE bắt buộc chỉ đúng cluster; PGUSER là migrator có DDL, không app role.
export OANTUTI_MIGRATE_CONFIRM="$PGDATABASE"  # status cũng yêu cầu trên DB không phải test
node --import tsx deploy/linux/apply-migrations.mts --status
node --import tsx deploy/linux/apply-migrations.mts --apply --grant-to arena_rebuild_app
```

Guard hai tầng: DB tên khớp `arena_*test*` chạy ngay; mọi DB khác **bắt buộc** `OANTUTI_MIGRATE_CONFIRM` đúng tên DB, nên không thể migrate nhầm demo/production bằng biến môi trường cũ.

### Phục hồi ADMIN

```sh
sudo node --import tsx deploy/linux/recover-admin.ts <lý do> <mã-tham-chiếu-cho-phép>
```

Chỉ chạy được với root thật + terminal tương tác, yêu cầu **đúng một** ADMIN tồn tại, in mật khẩu tạm ra `/dev/tty` (không nhận mật khẩu/UUID qua tham số). Mọi lần dùng phải ghi lại lý do và người cho phép.

### Tạo ADMIN đầu tiên cho một database mới

```sh
OANTUTI_BOOTSTRAP_CONFIRM=<tên-db-chính-xác> OANTUTI_ACCOUNT_CAPACITY=<số-tài-khoản> \
  node --import tsx deploy/linux/bootstrap-admin.mts <username>
```

Mọi điều kiện được kiểm tra **trước khi ghi**: thiếu terminal, thiếu `OANTUTI_ACCOUNT_CAPACITY`, sai tên database hay đã có ADMIN đều dừng lại mà **không** tạo tài khoản nào (không thể xảy ra cảnh ADMIN đã tạo nhưng chưa ai nhận được mật khẩu). Tài khoản, `accountCapacity` và audit commit trong **một** transaction; mật khẩu tạm in **một lần** ra `/dev/tty` và buộc đổi ở lần đăng nhập đầu. Với gói Compose (cần `-it` cho terminal):

```sh
export OANTUTI_BOOTSTRAP_CONFIRM=arena OANTUTI_ACCOUNT_CAPACITY=600
docker compose --profile ops run --rm -it ops deploy/linux/bootstrap-admin.mts <username>
```

Qua TCP, cả hai CLI đọc mật khẩu từ `PGPASSWORD_FILE` và **từ chối** biến `PGPASSWORD`. `OANTUTI_ACCOUNT_CAPACITY` ghi `deployment_settings.accountCapacity` khi chưa có — thiếu nó thì cấp tài khoản LAN bị từ chối (`ACCOUNT_CAPACITY_REQUIRED`), nên một deployment mới cần cả hai bước.

### Vùng chạy Bot (khi host đã được cấp)

API khởi động gateway native bằng file cấu hình do người vận hành sở hữu:

```sh
export OANTUTI_NATIVE_CONFIG=/etc/oantuti/native.json   # tuyệt đối, không group/world-writable, chủ sở hữu là operator
```

File này khai báo `executable`, `socketPath`, `workerUid`, `socketGid`, `deploymentGeneration`, `runtimeProfileDigest`, `maxBuildSlots`, `maxGameSlots`, `spoolRoot`, `compiledArtifactsDir`, `completionRoot` (tuỳ chọn; mặc định `<spoolRoot>/completions`) và đúng ba `toolchains` (mỗi cái có `language`/`imageDigest`/`version`/`flags`). Sai một trường thì API **từ chối khởi động**, và `OANTUTI_NATIVE_CONFIG` không được đi cùng `OANTUTI_DEV_EXECUTION=1`. Binary worker cần **`arena-reaper` nằm cạnh `arena-worker`**; thiếu nó worker dừng trước khi chạy workload.

### Đặt dữ liệu bất biến lên đĩa dữ liệu (không nằm trong checkout)

```sh
export OANTUTI_SUBMISSION_DIR=/srv/oantuti/sources
export OANTUTI_REPLAYS_DIR=/srv/oantuti/replays
export OANTUTI_SPOOL_DIR=/srv/oantuti/spool
```

Không đặt thì giữ layout cũ `<cwd>/storage/*`. Cả ba thư mục (và mọi thư mục con chứa object) phải **riêng tư**: `chmod 700` cho thư mục, `chmod 600` cho tệp, chủ sở hữu là identity chạy service. Store sẽ **từ chối khởi động** nếu root cho phép group/world truy cập, và backup CLI cũng từ chối sao lưu một cây như vậy — nâng cấp từ bản cũ thì chạy `chmod -R go-rwx <các root>` một lần.

Capsule completion đã được chấp nhận được thu hồi sau 7 ngày (không còn completion `PENDING` nào tham chiếu); object chỉ bị xoá khi không capsule còn lại nào dùng. Vì vậy `--completions` luôn là thư mục capsule bất biến, không phải spool tạm.

Migrations/sao lưu/generation: `apply-migrations.mts --apply` bắt buộc `OANTUTI_MIGRATE_CONFIRM=<tên-db>` cho database không phải `arena_*test*`; app đọc generation hiện tại từ `backup_identity` và từ chối khi cấu hình lệch. Sao lưu dùng `backup-cli.ts` (`produce`/`verify`/`publish`/`activate-restore`) trên các root `sources`/`replays`/`compiled`/`completions`.

### Lưu ý khi đổi API cho portal

`packages/web` nhúng đích proxy `/api` vào lúc **build** (`next.config.ts` đọc `API_BASE`), không phải lúc chạy: đổi cổng API thì phải build lại portal với `API_BASE` tương ứng, nếu không portal sẽ nói chuyện với API cũ.

## 4. Vận hành giải đấu (ban tổ chức)

1. **Tài khoản:** cấp tài khoản LAN bằng `/api/v2/organizer/accounts/provision-lan` hoặc enroll hàng loạt. Không tự đăng ký: deployment v2 **không mount bề mặt v1** (route match/replay/bot cũ và session store SQLite riêng), nên các đường đó trả 404 chứ không phải một cửa sau có bảo vệ. Bề mặt v1 chỉ còn tồn tại khi chạy ứng dụng standalone SQLite không có PostgreSQL; `OANTUTI_LEGACY_API=1` chỉ có ý nghĩa ở chế độ đó.
2. **Khoá luật:** rules/map/runtime/policies/quota đóng băng tại thời điểm mở đăng ký. Muốn đổi luật → phải tạo giải mới.
3. **Mở đăng ký → khoá (lock) → bắt đầu (start):** Admin chỉ bấm start khi hệ thống báo `READY_TO_START`; sau đó các vòng chạy tự động. Admin chỉ **finalize** ở giai đoạn cuối sau khi hết cửa sổ khiếu nại và không còn blocker.
4. **Đội:** nộp source (ZIP hoặc Monaco), xem log riêng tư, tự chạy **private TEST** (không sinh ordinal/kết quả chính thức, không lên bảng xếp hạng).
5. **Công khai:** khán giả xem trận/standings/replay theo chính sách công khai; replay chính thức chỉ ADMIN (FULL). Private TEST replay chỉ đội sở hữu — cần chốt trước khi mở.
6. **Sự cố trong giải:** nếu backup lag vượt ngưỡng và fence `enforce`, protected writes tạm dừng → không bắt đầu vòng mới, không finalize, thông báo cho người vận hành; không tự tắt fence để "chạy tiếp".
Live native chỉ phát **official GAME**, không TEST_GAME. SNAPSHOT/EVENT/RESULT gắn `attemptId`, `fencingToken`, `deploymentGeneration`; snapshot có sequence và `historyComplete`, stream native giới hạn 300 lượt. `PREVIEW_ENDED` chỉ báo kết thúc preview/chờ authoritative acceptance, không chấm điểm và không đóng socket; chỉ durable accepted result mới phát RESULT. Hàng đợi gửi cộng frame kế tiếp tối đa 1 MiB/client, khán giả chậm bị đóng 4405; official archived replay vẫn chỉ FULL ADMIN.


## 5. Nhật ký cần theo dõi

| Nguồn | Xem ở đâu | Dấu hiệu bất thường |
|---|---|---|
| API | stdout/stderr của tiến trình (Compose: `logs -f server`) | `CAPACITY_EXHAUSTED`, `BLOCKED_PAIRING`, `INTEGRITY_*`, lỗi DB lặp lại |
| Reconciler | cùng stdout API | completion `COMPLETION_PENDING` không được promote sau nhiều vòng |
| Gateway sandbox | log của supervisor/worker (khi đã cài) | job `ACTIVE` không heartbeat, lease hết hạn liên tục |
| DB | `schema_migrations`, `job_attempts.state`, `backup` checkpoint | schema lệch, attempt kẹt `ACTIVE` |
| Backup | checkpoint freshness | lag > ngưỡng (mặc định 5 phút) |

## 6. Sao lưu và bàn giao khoá

### Checkpoint production: produce → copy → verify/publish → restore

CLI thật: `node --import tsx packages/server/src/operations/backup-cli.ts --help`. Không dùng defaults dev. Operator cấp root private rỗng, không symlink, các source/replay/compiled roots và **immutable native completion capsule directory** (`--completions`), không transient attempt spool. Cần `pg_dump` trong PATH, PostgreSQL host/port/database/user explicit và `PGPASSFILE` private cho credentials.

```sh
node --import tsx packages/server/src/operations/backup-cli.ts produce \
  --root "$CAPTURE_ROOT" --sources "$SOURCE_ROOT" --replays "$REPLAY_ROOT" \
  --compiled "$COMPILED_ARTIFACTS_ROOT" --completions "$COMPLETION_CAPSULE_ROOT" \
  --host "$PGHOST" --port "$PGPORT" --database "$PGDATABASE" --user "$BACKUP_CAPTURE_ROLE"
# Operator copy checkpoint tới destination được quản trị độc lập trước; chạy tại destination:
node --import tsx packages/server/src/operations/backup-cli.ts verify \
  --root "$DESTINATION_ROOT" --digest "$EXPECTED_MANIFEST_SHA256"
node --import tsx packages/server/src/operations/backup-cli.ts publish \
  --root "$DESTINATION_ROOT" --digest "$EXPECTED_MANIFEST_SHA256" \
  --host "$PGHOST" --port "$PGPORT" --database "$PGDATABASE" --user oantuti_backup_verifier
```

`EXPECTED_MANIFEST_SHA256` phải đến qua kênh xác thực **độc lập**, không tự tin digest lấy từ chính bản sao cần kiểm. `publish` yêu cầu dedicated PostgreSQL `current_user = oantuti_backup_verifier`; operator provision role/grants giới hạn riêng, không có provisioning được thực hiện trong delivery. Verify/publish xác minh bytes tại destination, không có boolean tự nhận `offhost=true` và không chứng minh placement chỉ bằng tên directory.

Role verifier cần `CONNECT` database, `USAGE` schema, `SELECT` trên `backup_identity`, `INSERT` trên `backup_checkpoints` và `SELECT(manifest_digest)` cho `ON CONFLICT`; advisory locks dùng quyền PostgreSQL mặc định. Không cấp membership/inheritance từ app role và không dùng app role để publish. App chỉ đọc identity/checkpoints; packaging loại quyền ghi `backup_identity`, `backup_checkpoints`, `schema_migrations` và UPDATE/DELETE audit. Restore operator là role riêng có mutation privileges cần thiết, gồm thay identity và DELETE checkpoint; không mở các quyền này cho app/verifier. Đây là contract cấp quyền để operator triển khai, không phải các GRANT đã chạy.

Checkpoint dùng **logical `pg_dump` exported snapshot**, manifest gắn flushed WAL LSN lúc capture; **không phải PITR hoặc bằng chứng WAL archive**. Khôi phục `database.dump` bằng `pg_restore --no-owner --no-acl` vào **DB cô lập mới**, copy đủ bốn object roots, dừng API/workers rồi activate một lần:

```sh
node --import tsx packages/server/src/operations/backup-cli.ts activate-restore \
  --root "$DESTINATION_ROOT" --digest "$EXPECTED_MANIFEST_SHA256" \
  --sources "$RESTORED_SOURCE_ROOT" --replays "$RESTORED_REPLAY_ROOT" \
  --compiled "$RESTORED_COMPILED_ROOT" --completions "$RESTORED_COMPLETION_ROOT" \
  --isolated yes --host "$RESTORE_PGHOST" --port "$RESTORE_PGPORT" \
  --database "$RESTORE_DATABASE" --user "$RESTORE_OPERATOR_ROLE"
```

Activation tăng deployment generation, rebind storage paths; pinned `COMPLETION_PENDING` giữ original fencing identity qua `restore_recovery` và cần executable profile khớp. Các jobs khác bị fence/requeue. API lấy generation từ `backup_identity`; restart worker với grants mới, không tái dùng lease cũ. Không có off-host provisioning/drill được thực hiện; các script drill bên dưới chỉ là bằng chứng dev lịch sử.

Hiện có (bằng chứng cục bộ, **không** phải off-host):

```sh
python3 deploy/linux/wal-restore-drill.py     # đọc cấu hình/đường dẫn dev trước khi chạy
python3 deploy/linux/backup-restore.py        # drill cũ, đường dẫn dev cố định trong file
```

| Hạng mục | Trạng thái thật |
|---|---|
| Base backup + WAL archive trên cùng đĩa | đã chạy, có bằng chứng RPO/RTO |
| Bản sao **off-host** + retention 35 ngày | **CHƯA CÓ** — `PENDING_PROVIDER_T11` |
| Custody khoá (ai giữ, ở đâu, quy trình bàn giao) | **CHƯA CÓ** — do trường chỉ định; khoá/secret không bao giờ vào Git hay báo cáo |
| Fence chặn ghi khi backup trễ | có code (`OANTUTI_BACKUP_FENCE=off|enforce`); chỉ ở dev mới để `off` |

Nguyên tắc bàn giao: backup không có bản sao off-host thì **không** được coi là khôi phục được; RPO≤5min/RTO≤30min chỉ là mục tiêu tới khi có drill thật trên host được cấp.

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Hành động |
|---|---|---|
| `/api/health/ready` → `executionGateway ok:false` | Gateway chưa sẵn sàng, xem reason hiện hành | Không bật dev executor cho giải thật; khôi phục cấu hình/sandbox theo reason |
| Job `ACTIVE` không nhúc nhích | Worker chết, lease chưa hết | Đợi reclaimer/API thu hồi lease; không tự UPDATE `job_attempts` |
| Job `COMPLETION_PENDING` lâu | Reconciler không chạy hoặc DB lỗi | Kiểm tra log reconciler, DB reachable; không tự promote bằng tay |
| `CAPACITY_EXHAUSTED` dù worker rảnh | Slot đang bị attempt `ACTIVE` chưa bị reclaim | Kiểm tra reclaimer; số slot tính tới lúc reclaim, không phải lúc hết lease |
| Protected writes bị chặn | Fence `enforce` + không có checkpoint hợp lệ | Khôi phục backup, ghi checkpoint; không tắt fence |
| `SOURCE_REJECTED` không mong đợi | Lỗi biên dịch/INIT smoke của chính bài nộp | Đưa diagnostic cho đội; đây là verdict của đội, không phải lỗi hạ tầng |
| Replay không khớp trace | Nghi ngờ toàn vẹn | Coi là **integrity incident**: giữ nguyên hiện trường, không tự tính lại điểm, báo người có trách nhiệm |
| DB restart làm API mất kết nối | Pool đã chết cùng kết nối | Restart API (Compose restart policy); đây không phải khôi phục không gián đoạn |
| Không đăng nhập được hàng loạt | Throttle đăng nhập theo IP gộp chung (đứng sau proxy mà thiếu cấu hình) | Đặt `OANTUTI_TRUSTED_PROXIES` đúng địa chỉ proxy, rồi thử lại |

## 8. Chỉ mục bằng chứng

Đường dẫn gốc: `docs/implementation/rebuild/`. Đây là bằng chứng **trên host dev**; mỗi mục ghi rõ nó *không* chứng minh gì.

| Tệp | Nội dung |
|---|---|
| `execution-context.json` | Donor/rebuild/preservation root, HEAD, số file xác minh, `releaseReady=false` |
| `S01-bom-inventory.json`, `S01-dependency-selection.json` | BOM/phiên bản đã chọn cho npm; chưa phải BOM phát hành đầy đủ |
| `S01-cargo-development-bom.json`, `S01-cargo-cache-proof.json`, `S01-cargo-offline-smoke.json` | Đồ thị Cargo dev, provenance/advisory, smoke offline |
| `S01-rust-wasm-tools.json`, `S01-wasm-smoke.json` | Toolchain Rust/WASM và smoke compile+instantiate |
| `S01-postgresql-isolation.json` | Cluster riêng, checksums/fsync, role tách biệt |
| `S01-storage-budget.json`, `S01-storage-smoke.json` | Ngân sách đĩa và smoke ghi/fsync (không chứng minh chịu mất điện) |
| `S01-tls-smoke.json` | CA/cert riêng, verify chuỗi cục bộ (chưa chứng minh tin cậy trên browser lạnh) |
| `S01-document-check.json` | Liên kết/fence tài liệu |
| `S02-engine-proximity.json`, `S02-engine-session.json`, `S02-local-bot-smoke.json` | Hành vi engine, session, bot cục bộ (không có sandbox) |
| `S02-wasm-parity.json`, `S02-wasm-replay-parity.json` | Tương đương native/WASM và verifier replay |
| `S12-ui-accessibility-audit.json` | Đo accessibility trước/sau sửa, kèm phần "chưa xác minh" |
| `S15-wal-restore-drill.json` | Drill WAL/PITR cục bộ, RPO/RTO đo được, `offHost=false` |
| `S16-dev-host-capacity-500.json`, `S16-dev-host-capacity-1000.json` | Đo dung lượng trên host dev, có `notMeasured` |
| `S17-bounded-soak.json` | Soak ngắn có biên, không phải soak 72h |
| `acceptance-matrix.json` | Gán yêu cầu theo cổng, `releaseReady=false` |
| `progress.md` | Nhật ký theo thời gian, gồm cả các phát hiện review và cách xử lý |
| `lan-completion-evidence.md` | Bằng chứng hoàn thiện LAN và các hạn chế ghi rõ |
| `core-role-ux-evidence.md`, `demo-and-tests.md`, `portable-deployment.md` | Duyệt UI theo vai trò, cách chạy demo/test, đóng gói |

Liên quan trực tiếp tới vùng chạy Bot (khi cài trên host mới): `deploy/linux/install-dev-helper.sh`, `install-trusted-match.sh`, `install-three-language.sh`, `install-gvisor-smoke.sh`, `promote-compiled-rootfs.py`, `verify-rootfs.py`, `trusted-match.py`, `three-language-match.py`, `smoke-gvisor.py`, `smoke-cgroup-kernel.py`, `update-trusted-match-reaper.sh`. Tất cả đều yêu cầu root thật, từ chối ghi đè mục đã tồn tại, và ghim digest — chạy đúng một lần theo tài liệu riêng của từng payload.

## 9. Biên nhận nghiệm thu

| Cổng | Ý nghĩa | Trạng thái | Người ký |
|---|---|---|---|
| G0 | Đầy đủ baseline/cấu hình | `NOT_SIGNED` | Người vận hành |
| G1 | Cách ly an ninh (sandbox, tài khoản, biên trust) | `NOT_SIGNED` | Người đánh giá an ninh độc lập |
| G2 | Đúng đắn/bền vững (ledger, fencing, khôi phục pin) | `NOT_SIGNED` | Reviewer + người vận hành |
| G3 | Dung lượng/độ bền (soak/rehearsal khuyến nghị khi triển khai sau) | `NOT_SIGNED` — ngoài delivery phần mềm hiện tại | Người vận hành trên host được cấp |
| G4 | Phát hành vận hành (runbook, custody, drill off-host) | `NOT_SIGNED` | Người vận hành + reviewer |

`LAN_COMPLETE_STABLE` theo chứng nhận vận hành lịch sử cần L0–L9/G0–G4 trên đúng target/BOM/digest; **không dùng nhãn đó làm điều kiện bàn giao phần mềm hiện tại**. Infrastructure/provision/72h/7 ngày được loại khỏi delivery theo chỉ đạo người dùng, không có nghĩa các gate đã đạt. Không suy chứng nhận từ Markdown hay test luôn-đúng.

## 10. Giới hạn chứng nhận và khuyến nghị triển khai sau (không phải infrastructure blockers của delivery)

1. **Sandbox/runtime chưa được chứng nhận trên host phát hành**; kiểm readiness thực trước khi nhận code sinh viên không tin cậy, không dùng dev executor thay thế.
2. **Kernel host không khớp baseline GA 6.8** → chưa thể chứng nhận profile đã chọn; container không đổi kernel host.
3. **Backup chưa off-host**, chưa có retention/custody → chưa chứng minh khôi phục khi mất host.
4. **Không có bằng chứng soak 72h/rehearsal 7 ngày**; không tuyên bố độ bền đã đo. Không yêu cầu các lượt chạy này trong delivery hiện tại.
5. **Chưa đo dung lượng trên host phát hành** (chỉ có số liệu host dev).
6. **Chưa có chữ ký người/human sign-off** cho G0–G4.
7. Bằng chứng lịch sử trong chỉ mục không chứng nhận runtime mới tích hợp: provenance pinned-bot/trace, backup restore và ACL phải được đánh giá theo mã/bằng chứng hiện hành; không giữ kết luận audit cũ như trạng thái live.
8. **Chưa có đơn vị `systemd`** cho môi trường trường học; đường phát hành hiện tại là Compose.
9. **Không có bản sao/zero-loss khi mất toàn bộ host** — RPO/RTO là mục tiêu có drill, không phải bảo đảm.

## 11. Đề nghị chạy lại sau mỗi thay đổi mã

```sh
# Suite server trên DB test cô lập (tên DB phải khớp arena_*test*)
# Khai báo đủ PGHOST/PGPORT/PGUSER tới cluster test và role test; không dùng demo/production.
PGDATABASE=arena_example_test node --import tsx deploy/linux/test-isolated.mts packages/server
# Cargo workspace
cargo test --workspace --locked        # dùng cargo của prefix đã cài
# Tương đương verifier replay
# PGHOST/PGPORT/PGUSER/PGDATABASE và object store phải chỉ đúng ledger; binary/module đã build.
# Script parity hiện đọc cố định storage/replays trong repo; không trỏ nó vào ledger/object store khác.
node --import tsx deploy/linux/verify-replay-parity.ts --limit 5 --rust-bin "$VERIFY_TRACE_BIN" --wasm "$REPLAY_WASM_BIN"
```

Đây là các lệnh chu kỳ phát triển; chúng **không** thay thế bằng chứng nghiệm thu ở §9.
