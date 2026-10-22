import type { TeamDto, TournamentEntry, TournamentRegistration } from './api';

export const registrationStatusLabel: Record<TournamentRegistration['status'], string> = {
  PENDING: 'Chờ ban tổ chức duyệt',
  APPROVED: 'Đã được duyệt',
  REJECTED: 'Bị từ chối',
  CANCELLED: 'Đã hủy đăng ký',
};

export function registrationActions(input: {
  readonly tournamentId: string;
  readonly userId: string;
  readonly team: TeamDto;
  readonly state: string;
  readonly registrationClosesAt: string | null;
  readonly registration: TournamentRegistration | null;
  readonly entry: TournamentEntry | null;
}, now = Date.now()): { canRequest: boolean; canCancel: boolean; canSubmit: boolean } {
  const { team, registration, entry } = input;
  const open = input.state === 'REGISTRATION_OPEN' && (input.registrationClosesAt === null || Date.parse(input.registrationClosesAt) > now);
  const captain = team.captainUserId === input.userId && !team.closedAt;
  const reapplying = registration?.canRequest === true && (registration.status === 'REJECTED' || registration.status === 'CANCELLED');
  return {
    canRequest: open && captain && team.tournamentId === input.tournamentId && (!registration || reapplying) && (!entry || (reapplying && entry.status === 'EXCLUDED')),
    canCancel: open && captain && registration?.canCancel === true && (registration.status === 'PENDING' || registration.status === 'APPROVED'),
    // An existing direct admission remains valid; a pending request never creates submission access.
    canSubmit: entry?.status === 'ELIGIBLE' && (!registration || registration.status === 'APPROVED'),
  };
}

export function registrationErrorText(result: { readonly status: number; readonly code?: string | null; readonly message?: string | null }): string {
  if (result.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  switch (result.code) {
    case 'STALE_VERSION': return 'Trạng thái đăng ký vừa thay đổi. Dữ liệu đã được yêu cầu tải lại; hãy kiểm tra trạng thái mới trước khi thao tác.';
    case 'TEAM_CAPTAIN_REQUIRED': return 'Chỉ đội trưởng hiện tại mới được gửi hoặc hủy đăng ký. Thành viên chỉ có thể xem.';
    case 'EMAIL_NOT_VERIFIED': return 'Bạn cần xác minh email trước khi đăng ký giải. Mở Quản lý tài khoản để kiểm tra.';
    case 'REGISTRATION_WINDOW_CLOSED': return 'Giải chưa mở hoặc đã hết thời gian đăng ký; không thể gửi hay hủy đăng ký.';
    case 'CAPACITY_EXCEEDED': return 'Giải đã đủ số đội được duyệt. Liên hệ ban tổ chức để được hỗ trợ.';
    case 'ALREADY_REGISTERED': return 'Đội đã có đăng ký hoặc đã được ghi danh. Hãy kiểm tra trạng thái mới nhất.';
    case 'TEAM_POLICY_MISMATCH': return 'Đội không thuộc giải này. Chọn đội gắn với đúng giải đấu.';
    case 'TEAM_CLOSED': return 'Đội đã đóng nên không thể thay đổi đăng ký.';
    case 'TEAM_SIZE_INVALID': return 'Số thành viên chưa đáp ứng quy định của giải. Kiểm tra lại danh sách đội.';
    case 'TEAM_MEMBER_ALREADY_ENROLLED': return 'Một thành viên đã thuộc đội tham dự khác trong giải. Liên hệ ban tổ chức.';
    case 'REGISTRATION_NOT_CANCELLABLE': return 'Đăng ký này không còn được phép hủy. Hãy kiểm tra trạng thái mới nhất.';
    case 'ENTRY_NOT_REAPPLICABLE': return 'Đội đã bị ban tổ chức loại khỏi giải; không thể tự đăng ký lại. Hãy liên hệ ban tổ chức.';
  }
  if (result.status === 403) return 'Tài khoản chưa có quyền thực hiện thao tác này. Cần tài khoản sinh viên đã xác minh email và quyền đội trưởng.';
  return result.message ?? 'Không thể cập nhật đăng ký. Vui lòng tải lại và thử lại.';
}
