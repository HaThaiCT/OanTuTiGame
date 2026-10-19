# OanTuTi v2 — tạm dừng deploy và phần việc còn lại

**Ưu tiên mới của người dùng:** hoàn tất và chạy ổn định LAN trước; ONLINE chỉ tiếp tục cùng người dùng sau nghiệm thu LAN. Kế hoạch thực hiện mới: [LAN-first completion](2026-10-18-lan-first-completion.md). Quyết định hoãn deploy bên dưới vẫn có hiệu lực cho tới khi được cho phép commissioning LAN.

## Quyết định của người dùng

Deploy TẠM DỪNG theo yêu cầu ngày 2026-10-18. Không tiếp tục cài trên máy cá nhân/VPS, mở cổng Internet, cấu hình domain/TLS/SMTP, migrate dữ liệu triển khai hoặc bật nhận/chạy mã Bot công khai cho tới khi người dùng yêu cầu tiếp tục. Không dừng hoặc xóa stack demo chỉ vì hoãn deploy. Sản phẩm là website, không có hạng mục ứng dụng desktop/mobile riêng.

## A. Điểm dừng deploy

Đã sửa đường đóng gói v1 thành: Next.js standalone + Fastify + PostgreSQL 16 + nginx HTTP/WebSocket. Đã build image và chạy Compose tách biệt trên máy hiện tại: trang web/API 200, login ADMIN 200/FULL, tạo course/tournament thành công, 37 bảng PostgreSQL, checksum bật, tài khoản ứng dụng không UPDATE/DELETE audit. Dữ liệu account tồn tại sau restart PostgreSQL; API cần restart khi kết nối pool bị ngắt. Tài nguyên kiểm thử tạm đã dọn. Không đụng DB demo đang dùng.

Các file cần giữ để tiếp tục:
- `Dockerfile.web`, `Dockerfile.server`, `docker-compose.yml`, `.dockerignore`.
- `packages/web/next.config.ts`, `packages/web/nginx.conf`.
- `deploy/linux/init-postgres.sh`, `deploy/linux/server-entrypoint.sh`.
- `docs/implementation/rebuild/portable-deployment.md` (hướng dẫn và bằng chứng đã chạy).
- `docs/superpowers/plans/2026-10-18-portable-web-deployment.md` (phạm vi đóng gói).

Đây chỉ là bằng chứng đóng gói control plane; `OANTUTI_DEV_EXECUTION=0`. Không coi là đã triển khai đầy đủ hệ thống thi đấu trên VPS hay đã an toàn để nhận code không tin cậy.

### Checklist khi mở lại deploy

1. Chốt host được phép thao tác (máy cá nhân và VPS độc lập), hệ điều hành/CPU/RAM/disk, quyền truy cập. Recheck baseline; không dùng thông tin disk 305 MB cũ (lần đo gần nhất đã có khoảng 22 GB trống).
2. Hoàn thành sandbox và broker ở phần B trước khi bật thi đấu bằng mã không tin cậy. Docker không thay kernel host và không thay gVisor per-job.
3. Chốt BOM/digest image/toolchain có thể tái tạo; giảm dependency/runtime không cần thiết, xử lý advisories theo thực tế. Không tự `audit fix --force`.
4. Hoàn thiện bootstrap operator/admin có kiểm soát, migration nâng cấp DB hiện có, ledger migration có checksum và xử lý lỗi. Script init hiện chỉ dùng volume trống; không xóa volume để nâng cấp.
5. Cấu hình listener/origins, HTTPS/domain và trust proxy đúng; kiểm tra cookie, CSRF, WebSocket qua TLS. Giữ DB/API private.
6. Chọn LAN_OFFLINE hoặc ONLINE theo nhu cầu, không suy từ loại host. ONLINE phụ thuộc mail transport thật và kiểm chứng thư xác minh/reset.
7. Backup ngoài host: PG base/WAL + inventory immutable objects + GC holds + key custody/retention; đo RPO ≤5 phút/RTO ≤30 phút; kiểm chứng write fence khi backup trễ.
8. Migration v1 trên bản sao: count/hash/FK/provenance; rehearsal cutover và rollback tương thích, không ghi đè v2 bằng SQLite cũ.
9. Managed startup/restart/readiness/monitoring/alert acknowledgement và incident drills. Chạy lại Compose + browser + sandbox trên từng host thực tế; không lấy smoke local thay bằng chứng VPS.
10. Capacity, soak và sign-off G0–G4 trước khi mở external intake. Chỉ deploy/public khi có yêu cầu rõ ràng.

## B. Còn lại sau đợt hoàn thiện phần mềm LAN

Danh sách này từng là gap inventory đầu ngày 2026-10-18. Các mục triển khai phía dưới đã được supersede bởi `progress.md` §Current status và `lan-completion-evidence.md` §Software completion pass. Trạng thái hiện hành:

1. **Sandbox/broker:** UID-bound broker, native supervisor/worker, Rust result authority và durable completion consumer đã có trong mã và được test trên worker giả lập/isolated DB. Host gVisor/cgroup/canary certification chưa có; đây là vận hành ngoài delivery phần mềm, không phải feature thiếu.
2. **Matching:** exact lexicographic optimal tie-break đã implement/test. Dense weighted N=500 có thể hết budget và trả `BLOCKED_PAIRING`; đây là hành vi fail-closed, không phải capacity claim.
3. **Archive/correction/dispute/live:** lệnh archive và correction ledger đã implement/test. Human walkthrough cuối cho confirm/reauth, dispute/rebracket matrix và live reconnect/delta của ván đang chạy vẫn cần acceptance/proof.
4. **ONLINE email:** mail delivery/retry/resend thật bị DEFERRED_BY_USER; không nằm trong LAN handoff.
5. **Software packaging:** đã build exact server image và smoke verifier trong final image; migration applier giờ có advisory lock, checksum/baseline guards và atomic grant/init. Hosted CI chưa chạy; web dependency audit còn advisory thấp/trung bình cần disposition trước public release.
6. **U5:** owner walkthrough guest/STUDENT/ADMIN, keyboard/accessibility và visual/usability sign-off còn chờ người dùng.

Các historical checklist bên dưới chỉ là bằng chứng/kế hoạch cũ, không được đọc thành trạng thái hiện hành.

### Historical operational acceptance recommendations (not blockers to the current software handoff)

Các mục dưới đây mô tả hoạt động có ích nếu commissioning sau này được cho phép; chúng không phải yêu cầu của delivery LAN software hiện tại theo `acceptance-matrix.json` `deliveryScopeOverride`.

7. **S14 — Owner walkthrough.** Instructor/student walkthrough, keyboard and screen-reader usability remain human acceptance, not implementation evidence.
8. **S16 — Independent security review.** Hosted CI has not run; the attempted independent diff review was not assessable. Web workspace dependencies still carry low/moderate advisories; triage/update and verify Monaco’s bundled sanitizer before any public release.
9. **S16 — Capacity.** Current runs do not certify 500-team/1000-viewer mixed throughput; measure on a declared target only if commissioning later requires it.
10. **S17 — Operational endurance.** The 72-hour soak is waived and 7-day rehearsal is excluded from the current software delivery; neither is represented as measured.

## C. Không liệt kê lại là “chưa làm”

Các phần có evidence mới hơn đã đóng trong dev: map pool/version pin/reveal ở lock; 4 map khác nhau cho knockout; BYE/WALKOVER/EMPTY/NO_CHAMPION và DQ finalist; grace/autoseal/Swiss→playoff/Elo tới PROVISIONAL; private TEST sau FINALIZED và privacy ADMIN=403; IDE/upload/first-password-change; pool/map editor/audit; retention worker và backup-lag fence ở mức code. Projector hiện có render EMPTY (`ProjectorBoard.tsx`), vì vậy dòng checklist cũ “EMPTY trong projector chưa có” đã lỗi thời. Chúng vẫn cần integrated/release acceptance khi có phụ thuộc tương ứng, nhưng không phải viết lại từ đầu.

## D. Thứ tự tiếp tục khi vẫn hoãn deploy

1. Đóng logic tie-break S09 và archive command với regression tests riêng, không đụng database thật.
2. Hoàn thiện broker UID-bound + Rust authoritative integration ở code, rồi chạy sandbox khi có môi trường được phép; không coi host permission là lý do để bỏ phần code còn thiếu.
3. Hoàn thiện mail consumer/resend/failure flow với transport kiểm thử nội bộ; mail thật chờ authorization.
4. Đóng correction/dispute/live reconnect matrix và full integration/security review.
5. Người dùng duyệt UI và tham gia instructor/student walkthrough; sau đó capacity/endurance/sign-off theo điều kiện sẵn sàng.
6. Mở lại phần A chỉ khi người dùng yêu cầu. Không tự push/merge/deploy vì đang rà soát tài liệu.
