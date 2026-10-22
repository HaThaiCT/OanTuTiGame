import type { TournamentRegistration } from '../../lib/api';

type RegistrationStatus = TournamentRegistration['status'];
export type RegistrationFilter = 'ALL' | RegistrationStatus;
export type RegistrationDecision = 'APPROVE' | 'REJECT';

export const REGISTRATION_STATUS_LABEL: Record<RegistrationFilter, string> = {
  ALL: 'Tất cả',
  PENDING: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Đã từ chối',
  CANCELLED: 'Đã hủy',
};

export function isRegistrationReviewOpen(state: string): boolean {
  return state === 'REGISTRATION_OPEN' || state === 'VALIDATING_SUBMISSIONS';
}

export function canReviewRegistration(state: string, registration: TournamentRegistration): boolean {
  return isRegistrationReviewOpen(state) && registration.status === 'PENDING';
}

export function registrationStatusCounts(registrations: readonly TournamentRegistration[]): Record<RegistrationFilter, number> {
  const counts = { ALL: registrations.length, PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
  for (const registration of registrations) counts[registration.status] += 1;
  return counts;
}

export function filterRegistrations(
  registrations: readonly TournamentRegistration[],
  status: RegistrationFilter,
  search: string,
): readonly TournamentRegistration[] {
  const query = search.trim().toLowerCase();
  return registrations.filter((registration) => {
    if (status !== 'ALL' && registration.status !== status) return false;
    if (query === '') return true;
    return [registration.teamName, registration.teamId, ...registration.members.flatMap((member) => [member.username, member.displayName])]
      .some((value) => value.toLowerCase().includes(query));
  });
}

interface RegistrationReviewInput {
  readonly decision: RegistrationDecision;
  readonly expectedVersion: number;
  readonly reason?: string;
}

type PreparedReview =
  | { readonly ok: true; readonly input: RegistrationReviewInput }
  | { readonly ok: false; readonly message: string };

export function prepareRegistrationReview(
  state: string,
  registration: TournamentRegistration,
  decision: RegistrationDecision,
  reason = '',
): PreparedReview {
  if (!canReviewRegistration(state, registration)) {
    return { ok: false, message: 'Yêu cầu không còn chờ duyệt hoặc giải không còn cho phép xét duyệt. Hãy tải lại danh sách.' };
  }
  if (decision === 'APPROVE') {
    return { ok: true, input: { decision, expectedVersion: registration.version } };
  }
  const trimmedReason = reason.trim();
  if (trimmedReason === '' || reason.length > 500) {
    return { ok: false, message: 'Nhập lý do từ chối từ 1 đến 500 ký tự, không chỉ gồm khoảng trắng.' };
  }
  return { ok: true, input: { decision, expectedVersion: registration.version, reason: trimmedReason } };
}
