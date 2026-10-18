# S06 — Durable Job Broker, Leases & Reconciler (T4)

Status: **CONTRACT_HANDOFF** (T4 JobBroker and JobReconciler complete; automated supervisor worker integration deferred to integrated sessions).

## 1. Phạm vi bàn giao

- **Database migration (`003-jobs.sql`):**
  - `jobs`: `id` UUID PK, `job_type` (`BUILD`, `GAME`, `TEST_BUILD`, `TEST_GAME`), `target_id`, `priority` (mặc định 100), `state` (`QUEUED`, `LEASED`, `RUNNING`, `COMPLETION_PENDING`, `SUCCEEDED`, `RETRY_WAIT`, `BLOCKED`), `fencing_token` (BIGINT tăng dần đơn điệu), `deployment_generation` (ngăn cản stale deployment nhận job), `attempt_count`, `max_attempts` (mặc định 3), `active_lease_id`, `available_at`, `payload` (JSONB).
  - `job_attempts`: `id` UUID PK, `job_id`, `ordinal` (lần thử 1, 2, 3), `fencing_token`, `grant_id` UUID, `worker_id`, `lease_expires_at`, `heartbeat_at`, `state` (`ACTIVE`, `EXPIRED`, `COMPLETED`, `FAILED`), `evidence_digest`.
  - `job_completions`: `id` UUID PK, `job_id`, `attempt_id`, `fencing_token`, `deployment_generation`, `evidence_digest`, `evidence_payload` (JSONB), `state` (`PENDING`, `ACCEPTED`, `REJECTED`).
  - Migration được thực thi bởi `arena_migrator`, cấp quyền CRUD cho `arena_app`.
- **Canonical data contracts (`packages/protocol/src/contracts/jobs.ts`):**
  - `JobType`, `JobState`, `WorkerIdentity`, `ReconcilerIdentity`, `SlotOffer`, `LeaseIdentity`, `JobLease`, `LeaseStatus`, `ResultEvidence`, `CompletionReceipt`, `PinnedCompletion`, `ResultReceipt`.
- **JobBroker (`packages/server/src/jobs/broker.ts`):**
  - `enqueue(jobType, targetId, priority, payload)`: đẩy job vào hàng đợi.
  - `claim(worker, capacity)`:
    - Sử dụng **`FOR UPDATE SKIP LOCKED`** trên PostgreSQL 16 đảm bảo concurrency cao không deadlock.
    - Sắp xếp theo `priority DESC, available_at ASC, id ASC`.
    - Lọc job theo khả năng nhận của worker (`buildSlots`, `gameSlots`).
    - Cấp lease **30 giây** (`LEASE_TTL_SECONDS = 30`), sinh `grant_id` UUID và tăng `fencing_token` đơn điệu.
    - Chuyển trạng thái job sang `LEASED`.
  - `heartbeat(lease)`:
    - Gia hạn lease thêm 30 giây khi worker gửi heartbeat định kỳ.
    - Kiểm tra nghiêm ngặt `fencing_token`, `grant_id`, `deployment_generation` và trạng thái `ACTIVE`.
    - Trả về lệnh `{ status: 'STOP', reason: 'FENCE_STALE_OR_EXPIRED' }` nếu token bị stale hoặc hết hạn (chống split-brain).
  - `prepareCompletion(lease, evidence)`:
    - **Pha 1 của two-phase completion**: kiểm tra lease còn hợp lệ, tính `evidence_digest` (SHA-256).
    - Tạo bản ghi `job_completions` trạng thái `PENDING` và cập nhật job sang **`COMPLETION_PENDING`**.
    - Phát sinh `CompletionReceipt`.
  - `complete(completion, actor)`:
    - **Pha 2 của two-phase completion**: kiểm tra digest khớp chính xác với bản ghi đã ghim.
    - Chuyển `job_completions` sang `ACCEPTED`, job sang `SUCCEEDED`, attempt sang `COMPLETED`.
    - Phát sinh `ResultReceipt`.
- **JobReconciler (`packages/server/src/jobs/reconciler.ts`):**
  - Quét độc lập các job bị hết hạn lease (`lease_expires_at <= clock_timestamp()`).
  - Đánh dấu attempt là `EXPIRED` (`LEASE_TIMEOUT`).
  - Thực thi chính sách retry và exponential backoff:
    - Lần thử 1 -> lùi lại **5 giây** (`RETRY_WAIT`).
    - Lần thử 2 -> lùi lại **15 giây** (`RETRY_WAIT`).
    - Lần thử 3 -> đạt `max_attempts` -> chuyển sang **`BLOCKED`** (bảo vệ hệ thống trước lỗi lặp lại vô tận).
  - Tự động phát hiện và chính thức hóa các job mồ côi (`COMPLETION_PENDING`): nếu worker gặp sự cố sau khi đã ghim evidence bền vững, Reconciler tự động hoàn tất sang `ACCEPTED` mà không cần chạy lại job.

## 2. Kiểm chứng đã thực hiện

- `packages/server/tests/durable-jobs.test.ts`: **5/5 passed**
  - Enqueues jobs and enforces priority and FIFO ordering via SKIP LOCKED claim.
  - Renews lease via periodic heartbeat and rejects stale fences / wrong grants with STOP.
  - Orchestrates two-phase completion: prepareCompletion (COMPLETION_PENDING) -> complete (ACCEPTED).
  - Reconciles expired leases with backoff (5s, 15s) and marks BLOCKED after 3 failed attempts.
  - Reconciles and promotes orphaned COMPLETION_PENDING records when worker crashes after prepareCompletion.
- **Toàn bộ hệ thống kiểm thử:**
  - Vitest server test suites (S03 + S05 + S06): **22/22 passed**.
  - Vitest toàn repo: **35 test files, 150 tests passed** (100% pass).
  - Rust supervisor test suite: **17 suites, 46 tests passed** (100% pass).
  - Python test suite: **23 tests passed** (100% pass).

## 3. Ranh giới chưa hoàn thành (Deferred)

- Tích hợp daemon worker chạy ngầm của supervisor kết nối tự động với JobBroker (thuộc S11 tích hợp).
- Replay object storage bền vững và manifest parity (S07 / T5).

## 4. Next Session Entry

- S07 — Result Durability, FS & Replay Objects (master T5).
