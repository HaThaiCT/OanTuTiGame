# S05 — Submission Source Pipeline & Private Workspace Tests (T3a)

Status: **CONTRACT_HANDOFF** (T3a contract handoff complete; T3b integrated execution with T4 job broker and T6 lock deferred to S11).

## 1. Phạm vi bàn giao

- **Database migration (`002-submissions.sql`):**
  - `submission_sources`: `digest` PK (SHA-256), `storage_path`, `zip_bytes`, `expanded_bytes`, `file_count`, `manifest` (JSONB).
  - `submissions`: UUID PK, `tournament_id`, `team_id`, `submitted_by_user_id`, `receipt_ordinal` (tăng đơn điệu theo giải và đội), `source_digest`, `language` (`PYTHON`, `TYPESCRIPT`, `CPP`), `entrypoint`, `status` (`VALIDATING`, `QUEUED`, `COMPILING`, `SMOKE_TESTING`, `READY`, `REJECTED`), `received_at`. Ràng buộc `UNIQUE(tournament_id, team_id, receipt_ordinal)`.
  - `test_snapshots`: snapshot bài nộp cho private workspace test runs của từng đội. Độc lập hoàn toàn với `receipt_ordinal` và candidate chính thức.
  - Migration được thực thi bởi role `arena_migrator`, cấp quyền CRUD cho `arena_app`.
- **Canonical data contracts (`packages/protocol/src/contracts/submissions.ts`):**
  - Định nghĩa chuẩn: `BotLanguage`, `SubmissionStatus`, `TestStatus`, `ProjectFileEntry`, `ProjectManifest`, `SubmissionReceipt`, `TestReceipt`, `SubmissionDto`, `TestSnapshotDto`, `PrivateSourceDto`.
- **Artifact Store & ZIP Validator (`packages/server/src/submissions/artifact-store.ts`):**
  - Bộ giải nén và kiểm tra ZIP thuần Node.js không dependency ngoài, an toàn tuyệt đối trước supply chain.
  - Thực thi nghiêm ngặt các hạn mức đặc tả 01/05:
    - Kích thước file ZIP tối đa **2 MiB** (`MAX_ZIP_BYTES = 2097152`).
    - Số lượng file tối đa **128 regular files** (`MAX_REGULAR_FILES = 128`).
    - Kích thước mỗi file tối đa **256 KiB** (`MAX_FILE_BYTES = 262144`).
    - Tổng dung lượng giải nén tối đa **4 MiB** (`MAX_EXPANDED_BYTES = 4194304`).
  - Kiểm tra an toàn:
    - Chặn directory traversal (`..`, đường dẫn tuyệt đối `/`, dấu `\`).
    - Chặn symlink, hardlink, device nodes.
    - Chặn trùng lặp tên file hoặc xung đột chữ hoa/thường (case-folding collisions).
    - Chặn các file nhị phân compiled (`.exe`, `.so`, `.dll`, `.bin`, `.pyc`, `.o`, `.wasm`,...).
    - Kiểm tra bắt buộc có file entrypoint hợp lệ theo ngôn ngữ (`.py` cho Python, `.ts`/`.js` cho TypeScript, `.cpp` cho C++).
  - Tính toán `manifest` canonical sắp xếp theo thứ tự bảng chữ cái và sinh `source_digest` (SHA-256) chuẩn xác.
  - Lưu trữ bất biến xuống đĩa kèm gọi `fsync` trên file và `fsync` trên thư mục cha để đảm bảo tính bền vững (durability).
- **Domain Service (`packages/server/src/submissions/service.ts`):**
  - Phân quyền: chỉ thành viên trong đội hoặc ADMIN mới được nộp bài.
  - Kiểm tra giải: phải ở trạng thái nhận bài (`REGISTRATION_OPEN` hoặc `VALIDATING_SUBMISSIONS`).
  - Chặn nộp bài sau hạn chót đăng ký/nộp bài (`registration_closes_at`).
  - Kiểm tra đội đã được ghi danh (`tournament_admissions`).
  - Quota nộp bài chính thức: tối đa 10 lần / 60 phút trượt, 100 lần / ngày UTC.
  - Cấp số thứ tự biên nhận `receipt_ordinal` tăng dần đơn điệu cho mỗi đội trong giải.
  - Phát sinh `SubmissionReceipt` có chữ ký thời gian và tính toàn vẹn `ELIGIBLE`.
  - **Private Workspace Tests:** hỗ trợ chạy thử mã nguồn riêng cho từng đội; hoạt động ở **mọi giai đoạn** của giải (kể cả sau khóa, khi đã kết thúc hoặc lưu trữ); **không** làm tăng `receipt_ordinal` và không ảnh hưởng đến Bot chính thức.
  - Bảo mật mã nguồn: chỉ đội sở hữu hoặc ADMIN mới có quyền tải/đọc mã nguồn bài nộp; các đội khác và khách bị chặn với mã lỗi 403/401.
- **Fastify v2 REST API (`packages/server/src/submissions/routes.ts`):**
  - `POST /api/v2/tournaments/:id/submissions`: nộp mã nguồn chính thức dạng ZIP base64.
  - `POST /api/v2/tournaments/:id/private-tests`: chạy thử nghiệm riêng cho đội.
  - `GET /api/v2/tournaments/:id/entries/me`: tra cứu bài nộp hợp lệ mới nhất của đội (candidate).
  - `GET /api/v2/submissions/:id/source`: tải mã nguồn bài nộp kèm manifest (chỉ đội sở hữu hoặc ADMIN).

## 2. Kiểm chứng đã thực hiện

- `packages/server/tests/submission-lifecycle.test.ts`: **6/6 passed**
  - Khởi tạo giải, đội, tài khoản sinh viên.
  - Từ chối các file ZIP bất hợp lệ: directory traversal (`../escape.py`), thiếu entrypoint, chứa file binary `.exe`.
  - Nộp bài hợp lệ: lưu file với fsync, cấp `receiptOrdinal = 1`, nộp bản cập nhật cấp `receiptOrdinal = 2`, candidate tự động trỏ về bản mới nhất.
  - Chặn nộp bài từ người ngoài đội hoặc đội chưa ghi danh (403).
  - Chạy thử nghiệm private workspace: cấp `TestReceipt`, `receiptOrdinal` chính thức vẫn giữ nguyên là 2.
  - Quyền riêng tư mã nguồn: đội sở hữu đọc được (200), ADMIN đọc được (200), đội khác bị từ chối (403), khách bị từ chối (401).
- **Toàn bộ hệ thống kiểm thử:**
  - Vitest: **34 test files, 145 tests passed** (100% pass).
  - Cargo test: **17 suites, 46 tests passed** (100% pass).
  - Python test: **23 tests passed** (100% pass).

## 3. Ranh giới chưa hoàn thành (Deferred)

- T3b: Tích hợp hoàn chỉnh pipeline build sandbox và compile execution (thuộc S11 sau khi có Job Broker S06 và Lock S08).
- Worker dispatch: bàn giao dữ liệu bài nộp cho Job Broker (S06).

## 4. Next Session Entry

- S06 — Durable Job Broker, Claim, Lease, Reconciler (master T4).
