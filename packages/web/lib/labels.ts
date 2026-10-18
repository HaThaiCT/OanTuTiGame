export const formatLabel: Record<string, string> = {
  SINGLE_ELIMINATION: 'Single Elimination',
  SWISS_PLAYOFF: 'Swiss → Playoff',
  ROUND_ROBIN: 'Round Robin',
  ELO_ARENA: 'Elo Arena',
};

export const stateLabel: Record<string, string> = {
  DRAFT: 'Bản nháp',
  PUBLISHED: 'Đã công bố',
  REGISTRATION_OPEN: 'Đang mở đăng ký',
  VALIDATING_SUBMISSIONS: 'Đang kiểm tra bài nộp',
  LOCKED: 'Đã khóa danh sách',
  READY_TO_START: 'Sẵn sàng — chờ Admin bắt đầu',
  RUNNING: 'Đang diễn ra',
  PAUSED: 'Tạm dừng',
  PROVISIONAL: 'Kết quả tạm tính',
  FINALIZED: 'Đã hoàn tất',
  ARCHIVED: 'Đã lưu trữ',
  CANCELLED: 'Đã hủy',
};

export const languageLabel: Record<string, string> = {
  PYTHON: 'Python',
  TYPESCRIPT: 'TypeScript',
  CPP: 'C++20',
};

export const submissionStatusLabel: Record<string, string> = {
  PENDING: 'Chờ xử lý',
  VALIDATING: 'Đang kiểm tra',
  QUEUED: 'Trong hàng đợi',
  COMPILING: 'Đang biên dịch',
  SMOKE_TESTING: 'Đang chạy thử',
  READY: 'Sẵn sàng',
  REJECTED: 'Bị từ chối',
};

/**
 * Private test run statuses (`test_snapshots.status`). They extend the submission pipeline with a
 * live `RUNNING` state, because a test run plays a match instead of only being validated.
 */
export const privateTestStatusLabel: Record<string, string> = {
  QUEUED: 'Trong hàng đợi',
  COMPILING: 'Đang biên dịch',
  SMOKE_TESTING: 'Đang chạy thử',
  RUNNING: 'Đang thi đấu',
  COMPLETED: 'Đã xong',
  FAILED: 'Thất bại',
};

/**
 * Private test winners reuse the official-results side convention: 1 = WHITE, 2 = BLACK,
 * 0 = draw. The API sends the number, so the label is resolved here.
 */
export const privateTestWinnerLabel: Record<string, string> = {
  WHITE: 'Quân Trắng',
  BLACK: 'Quân Đen',
  DRAW: 'Hòa',
  UNKNOWN: 'Không xác định',
};

export const stageLabel: Record<string, string> = {
  MAIN: 'Vòng chính',
  PLAYOFF: 'Playoff',
};

export const encounterStatusLabel: Record<string, string> = {
  PENDING: 'Chờ xếp lịch',
  RUNNING: 'Đang diễn ra',
  COMPLETED: 'Đã xong',
  CANCELLED: 'Đã hủy',
  BYE: 'Đi tiếp (bye)',
  WALKOVER: 'Thắng walkover',
  DOUBLE_WITHDRAWAL: 'Hai đội đã rút',
};

export const entryStatusLabel: Record<string, string> = {
  ELIGIBLE: 'Đủ điều kiện',
  EXCLUDED: 'Bị loại',
  PENDING: 'Chờ xử lý',
  WITHDRAWN: 'Đã rút',
};

/**
 * `disputes.status` (`007-disputes-and-corrections.sql`). `OPEN`/`UNDER_REVIEW` are the two
 * statuses the server counts when blocking finalization.
 */
export const disputeStatusLabel: Record<string, string> = {
  OPEN: 'Đang mở',
  UNDER_REVIEW: 'Đang xem xét',
  RESOLVED: 'Đã chấp nhận',
  REJECTED: 'Đã từ chối',
};

/** `disputes.status` values the resolve endpoint accepts, kept verbatim next to the label. */
export const disputeResolutionLabel: Record<string, string> = {
  RESOLVED: 'Chấp nhận (RESOLVED)',
  REJECTED: 'Từ chối (REJECTED)',
};

/** `result_corrections.action` CHECK constraint values. */
export const correctionActionLabel: Record<string, string> = {
  VOID: 'Hủy kết quả ván (VOID)',
  REJUDGE: 'Cho đấu lại (REJUDGE)',
};

/**
 * `reason` of an official result / replay payload — the `WinReason` enum names of the engine
 * (`packages/engine/src/state.ts`) plus `BOT_TIMEOUT`, which is what the runner records when a bot
 * misses its deadline (present in every stored replay of that kind). The viewer still prints the
 * raw code next to the label, because that code is what the server stores.
 */
export const winReasonLabel: Record<string, string> = {
  EXTINCTION: 'Diệt hết quân đối phương',
  THRONE_BREACH: 'Chiếm ngai đối phương',
  STALEMATE: 'Đối phương hết nước đi',
  TIMEOUT: 'Đối phương hết thời gian',
  BOT_TIMEOUT: 'Bot không phản hồi trong thời gian cho phép',
  ILLEGAL_MOVE: 'Đối phương đi sai luật',
  CRASH_FORFEIT: 'Bot đối phương gặp lỗi',
  MAX_TURNS_DRAW: 'Hòa — hết số lượt tối đa',
  PROTOCOL_VIOLATION: 'Đối phương vi phạm giao thức',
  WIN_REASON_UNSPECIFIED: 'Không xác định lý do',
};

/** `disposition` of an official result / replay payload; the recorded value is printed next to it. */
export const dispositionLabel: Record<string, string> = {
  DECISIVE: 'Phân thắng bại',
  DRAW: 'Hòa',
  NO_CONTEST: 'Không tính kết quả',
};

/**
 * Sides of a game, keyed by the numeric convention the server records (1 = WHITE, 2 = BLACK,
 * 0 = no winner). The replay viewer indexes this map with `String(side)`.
 */
export const sideLabel: Record<string, string> = {
  '1': 'Quân Trắng',
  '2': 'Quân Đen',
  '0': 'Hòa',
};

/**
 * `outbox_events.topic` values the public announcements feed exposes (server allow-list for
 * `GET /api/v2/tournaments/:id/announcements`). A topic the server adds later still renders,
 * because the timeline falls back to the raw topic string.
 */
export const announcementTopicLabel: Record<string, string> = {
  TOURNAMENT_PUBLISHED: 'Công bố giải đấu',
  REGISTRATION_OPENED: 'Mở đăng ký',
  REGISTRATION_CLOSED: 'Đóng đăng ký',
  TOURNAMENT_LOCKED: 'Khóa danh sách đội',
  TOURNAMENT_STARTED: 'Bắt đầu giải',
  TOURNAMENT_PAUSED: 'Tạm dừng giải',
  TOURNAMENT_RESUMED: 'Tiếp tục giải',
  ROUND_SCHEDULED: 'Xếp lịch vòng đấu',
  TOURNAMENT_PROVISIONAL: 'Kết quả tạm tính',
  TOURNAMENT_REOPENED: 'Mở lại để sửa kết quả',
  TOURNAMENT_NO_CHAMPION: 'Không có nhà vô địch',
  TOURNAMENT_FINALIZED: 'Chốt kết quả chính thức',
  TEAM_WITHDRAWN: 'Đội rút khỏi giải',
  ENCOUNTER_WALKOVER: 'Cặp đấu xử thắng walkover',
  ENCOUNTER_DOUBLE_WITHDRAWAL: 'Cả hai đội đã rút',
  TEAM_DISQUALIFIED: 'Đội bị loại (DQ)',
  ENCOUNTERS_VOIDED_BY_DQ: 'Hủy kết quả các cặp của đội bị loại',
};
