# S03 — PostgreSQL 16, LAN Identity, Teams và Tournament Admission Substrate

Status: **CONTRACT_HANDOFF** (development target, LAN_OFFLINE profile on local PostgreSQL 16; ONLINE email workflows and submission pipelines deferred to S04/S05).

## 1. Phạm vi bàn giao

- **Database migration:**
  - `packages/server/src/persistence/migrations/001-control-plane.sql`: tạo 14 bảng trong schema `public`:
    - `users`: UUID PK, username unique, password_hash (scrypt), role (`ADMIN`, `STUDENT`, `OPERATOR`), activation_method (`ADMIN_ISSUED`, `LOCAL_BOOTSTRAP`, `SELF_REGISTER`), password_change_required.
    - `sessions`: token_hash unique, scope (`FULL`, `PASSWORD_CHANGE_ONLY`), expires_at, revoked_at.
    - `email_verification_tokens`, `password_reset_tokens`: purpose-bound tokens for recovery.
    - `courses`: code unique, name.
    - `teams`: course_id, name unique per course, captain_user_id.
    - `team_memberships`: team_id, user_id unique, role (`CAPTAIN`, `MEMBER`).
    - `tournaments`: course_id, format, state (`DRAFT` -> `PUBLISHED` -> `REGISTRATION_OPEN` -> ...), rules_revision, max_teams, min_team_size, max_team_size.
    - `tournament_admissions`: tournament_id, team_id unique, admitted_by_user_id, admission_type.
    - `tournament_entries`: tournament_id, team_id unique, status (`PENDING`, `ELIGIBLE`, `EXCLUDED`), seed_ordinal.
    - `audit_events`: actor_user_id, action, resource_type, resource_id, details (JSONB).
    - `outbox_events`: topic, payload (JSONB), delivered_at.
    - `deployment_settings`: key PK, value (JSONB).
    - `schema_migrations`: version tracking.
  - Migration được chạy và xác nhận thành công bởi role `arena_migrator`, cấp quyền CRUD cho `arena_app`.
- **Durable persistence layer:**
  - `packages/server/src/persistence/db.ts`: kết nối qua `pg.Pool` đến socket PostgreSQL 16 (`host: /home/ha-thai/.local/share/oantuti/development/pg16/socket`, `database: arena_development`, `user: arena_app`).
  - Hỗ trợ `withTransaction<T>(callback)` đảm bảo cùng client connection trong suốt transaction.
- **Canonical data contracts:**
  - `packages/protocol/src/contracts/common.ts`: định nghĩa canonical `Actor`, `CommandContext`, `Receipt<T>`, `UUID`, `Instant`, `Digest`, `Role`, `SessionScope`.
  - `packages/protocol/src/contracts/identity.ts`: `UserDto`, `SessionDto`, `TeamDto`, `TournamentSubstrateDto`, `LanBulkUserEntry`, `LanProvisionedUser`.
- **Identity & Cryptography:**
  - `packages/server/src/identity/crypto.ts`: `scrypt` password hashing + timing-safe verification, SHA-256 token hashing, temporary password generation.
  - `packages/server/src/identity/service.ts`:
    - Singleton Admin bootstrap: idempotent, từ chối bootstrap lần 2 (409).
    - LAN bulk student provisioning: sinh temporary password ngẫu nhiên, đặt `password_change_required = true`, kiểm tra `accountCapacity`.
    - Login: tài khoản mới cấp session `PASSWORD_CHANGE_ONLY`.
    - Change password: xác thực mật khẩu cũ, revoke tất cả session cũ, cấp session `FULL`.
    - Token authentication & session revocation.
- **Teams & Tournament Admission Substrate:**
  - `packages/server/src/teams/service.ts`:
    - Quản lý khóa học (Course).
    - Quản lý đội: tạo đội, gán đội trưởng, thêm thành viên (kiểm tra giới hạn 1-5 người và chống trùng lặp thành viên).
    - Tournament Substrate (theo master T2 / S03): tạo giải ở trạng thái `DRAFT` -> `PUBLISHED` -> `REGISTRATION_OPEN`.
    - Direct enrollment: Admin ghi danh trực tiếp đội vào giải (kiểm tra cùng course, giới hạn kích thước đội, sức chứa giải, chống ghi danh 2 lần); ghi danh đồng thời vào `tournament_admissions` và `tournament_entries`, ghi audit log.
- **Fastify v2 REST API:**
  - `packages/server/src/identity/routes.ts`: `/api/v2/auth/login`, `/api/v2/auth/change-password`, `/api/v2/auth/logout`, `/api/v2/auth/me`, `/api/v2/organizer/accounts/provision-lan`.
  - `packages/server/src/teams/routes.ts`: `/api/v2/organizer/courses`, `/api/v2/organizer/teams`, `/api/v2/organizer/teams/:id/members`, `/api/v2/teams/:id`, `/api/v2/organizer/tournaments`, `/api/v2/organizer/tournaments/:id/publish`, `/api/v2/organizer/tournaments/:id/open-registration`, `/api/v2/organizer/tournaments/:id/enrollments`, `/api/v2/tournaments/:id`.

## 2. Kiểm chứng đã thực hiện

- `packages/server/tests/identity-production.test.ts`: **4/4 passed**
  - Enforces singleton ADMIN account bootstrap.
  - Provisions LAN bulk student accounts with unique temporary passwords and forced password change.
  - Forces password change workflow on initial student login.
  - Manages courses, teams, and tournament admission substrate atomically.
- `packages/server/tests/teams.test.ts`: **7/7 passed** (HTTP REST API qua Fastify inject)
  - Login ADMIN -> cookie `oantuti_session`.
  - Provision students qua API.
  - Rejects unauthenticated provisioning (401).
  - Student login -> `PASSWORD_CHANGE_ONLY` -> change-password -> `FULL` -> verified `/api/v2/auth/me`.
  - Create course + team via organizer routes.
  - Full tournament lifecycle: create `DRAFT` -> publish `PUBLISHED` -> open `REGISTRATION_OPEN` -> direct enroll team.
  - Public query `GET /api/v2/tournaments/:id` returns admitted count.
  - Logout revokes session.
- **Toàn bộ test suites:**
  - Vitest: **135 passed** across 32 files.
  - Cargo: **46 passed** across 17 suites.
  - Python: **23 passed**.

## 3. Ranh giới chưa hoàn thành (Deferred)

- S04: ONLINE profile email verification & reset via SMTP provider (LAN_OFFLINE không phụ thuộc SMTP).
- S05: Submission pipeline (upload ZIP, 128 files / 4 MiB bounds, immutable artifact receipt).
- G1 / GA 6.8 release certification: vẫn pending môi trường thực tế.

## 4. Next Session Entry

- Gate cho S04/S05 đã sẵn sàng: cơ sở dữ liệu PostgreSQL 16, danh tính LAN, đội thi và tournament substrate hoạt động hoàn chỉnh.
