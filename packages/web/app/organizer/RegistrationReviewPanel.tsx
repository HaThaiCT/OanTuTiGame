'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  listTournamentRegistrations,
  reviewTournamentRegistration,
  type TournamentRegistration,
} from '../../lib/api';
import { errorText, type ApiResult } from '../../lib/client';
import {
  canReviewRegistration,
  filterRegistrations,
  isRegistrationReviewOpen,
  prepareRegistrationReview,
  REGISTRATION_STATUS_LABEL,
  registrationStatusCounts,
  type RegistrationDecision,
  type RegistrationFilter,
} from './registration-review-state';

type Notice = { readonly kind: 'success' | 'error'; readonly text: string };
type RejectionDraft = { readonly id: string; readonly version: number; readonly reason: string };

const FILTERS: readonly RegistrationFilter[] = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const BUTTON_CLASS = 'min-h-10 rounded-md border border-[var(--border-control)] px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-secondary)] disabled:opacity-60';
const INPUT_CLASS = 'min-h-10 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';

function formatInstant(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : iso;
}

function reviewErrorText(result: ApiResult<unknown>): string {
  const detail = errorText(result, 'Không xét duyệt được yêu cầu.');
  if (result.code === 'STALE_VERSION' || result.code === 'REGISTRATION_NOT_PENDING') {
    return `Yêu cầu đã thay đổi, đã được xét duyệt hoặc đã bị đội trưởng hủy. Quyết định này chưa được áp dụng. ${detail}`;
  }
  if (result.code === 'TOURNAMENT_LOCKED') {
    return `Giải đã khóa xét duyệt. Chỉ có thể xem danh sách. ${detail}`;
  }
  if (result.code === 'CAPACITY_EXCEEDED') {
    return `Giải đã đủ số đội; yêu cầu chưa được duyệt. ${detail}`;
  }
  return detail;
}

export default function RegistrationReviewPanel({ tournamentId, state }: {
  readonly tournamentId: string;
  readonly state: string;
}) {
  const router = useRouter();
  const headingId = useId();
  const reasonHintId = useId();
  const mutationInFlight = useRef(false);
  const [registrations, setRegistrations] = useState<readonly TournamentRegistration[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RegistrationFilter>('PENDING');
  const [search, setSearch] = useState('');
  const [rejection, setRejection] = useState<RejectionDraft | null>(null);
  const [serverLocked, setServerLocked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await listTournamentRegistrations(tournamentId);
    if (!result.ok || !result.data) {
      setRegistrations(null);
      setRejection(null);
      setLoadError(errorText(result, 'Không tải được yêu cầu đăng ký.'));
    } else {
      const rows = result.data.registrations;
      setRegistrations(rows);
      setRejection((current) => current && rows.some((row) => row.id === current.id && row.version === current.version && row.status === 'PENDING') ? current : null);
    }
    setLoading(false);
  }, [tournamentId]);

  useEffect(() => {
    setRejection(null);
    setServerLocked(false);
    void load();
  }, [load, state]);

  const reviewOpen = isRegistrationReviewOpen(state) && !serverLocked;
  const busy = loading || pendingId !== null;
  const counts = registrations === null ? null : registrationStatusCounts(registrations);
  const visibleRegistrations = filterRegistrations(registrations ?? [], filter, search);

  async function review(registration: TournamentRegistration, decision: RegistrationDecision, reason = '') {
    if (mutationInFlight.current || busy || serverLocked) return;
    const prepared = prepareRegistrationReview(state, registration, decision, reason);
    if (!prepared.ok) {
      setNotice({ kind: 'error', text: prepared.message });
      return;
    }
    const prompt = decision === 'REJECT'
      ? `Từ chối yêu cầu của đội “${registration.teamName}”? Lý do dưới đây sẽ được gửi riêng cho đội:\n\n${prepared.input.reason}`
      : `Duyệt đội “${registration.teamName}” vào giải? Máy chủ sẽ kiểm tra danh sách thành viên và số chỗ còn lại trước khi ghi danh.`;
    if (!window.confirm(prompt)) return;
    mutationInFlight.current = true;
    setPendingId(registration.id);
    setNotice(null);
    const result = await reviewTournamentRegistration(tournamentId, registration.id, prepared.input);
    if (result.code === 'TOURNAMENT_LOCKED') setServerLocked(true);
    setRejection(null);
    await load();
    router.refresh();
    setPendingId(null);
    mutationInFlight.current = false;
    setNotice(result.ok && result.data
      ? { kind: 'success', text: decision === 'APPROVE' ? `Máy chủ đã duyệt đội “${registration.teamName}” vào giải.` : `Đã từ chối yêu cầu của đội “${registration.teamName}”. Lý do chỉ hiển thị cho ADMIN và đội liên quan.` }
      : { kind: 'error', text: reviewErrorText(result) });
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)]">
      <div className="flex flex-wrap items-start justify-between gap-3 p-3 sm:p-4">
        <div className="min-w-0 flex-1">
          <h4 id={headingId} className="text-sm font-semibold">Yêu cầu đăng ký đội (ONLINE)</h4>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Đội chỉ được ghi danh và nộp bot sau khi ADMIN duyệt. Yêu cầu, thành viên và lý do xét duyệt không hiển thị công khai.
          </p>
          {!reviewOpen ? (
            <p className="mt-2 text-xs text-[var(--warning-text)]">
              Chỉ xem — chỉ được duyệt hoặc từ chối trong lúc mở đăng ký hoặc kiểm tra bài nộp, trước khi khóa danh sách.
            </p>
          ) : null}
        </div>
        <button type="button" disabled={busy} onClick={() => { setNotice(null); void load(); router.refresh(); }} className={BUTTON_CLASS}>
          {loading ? 'Đang tải…' : 'Tải lại yêu cầu'}
        </button>
      </div>

      {notice ? (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`mx-3 mb-3 rounded-md border px-3 py-2 text-sm sm:mx-4 ${notice.kind === 'error' ? 'border-[var(--danger-text)] text-[var(--danger-text)]' : 'border-[var(--success-text)] text-[var(--success-text)]'}`}>
          {notice.text}
        </p>
      ) : null}

      {counts ? (
        <div className="flex flex-col gap-3 border-t border-[var(--border-subtle)] p-3 sm:p-4">
          <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs" aria-label="Số lượng yêu cầu đăng ký">
            {FILTERS.map((status) => (
              <div key={status} className="flex items-center gap-1.5">
                <dt className="text-[var(--text-secondary)]">{REGISTRATION_STATUS_LABEL[status]}</dt>
                <dd className="font-semibold tabular-nums">{counts[status]}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <span>Trạng thái yêu cầu</span>
              <select value={filter} onChange={(event) => { setFilter(event.target.value as RegistrationFilter); setRejection(null); }} className={INPUT_CLASS}>
                {FILTERS.map((status) => <option key={status} value={status}>{REGISTRATION_STATUS_LABEL[status]} ({counts[status]})</option>)}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <span>Tìm đội hoặc thành viên</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tên đội, teamId, tên hoặc tài khoản thành viên" className={`${INPUT_CLASS} w-full`} />
            </label>
          </div>
          <p role="status" className="text-xs text-[var(--text-secondary)]">Hiển thị {visibleRegistrations.length}/{counts.ALL} yêu cầu.</p>
        </div>
      ) : null}

      {loading ? <p role="status" className="border-t border-[var(--border-subtle)] px-4 py-4 text-sm text-[var(--text-secondary)]">Đang tải yêu cầu đăng ký…</p> : null}
      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] px-4 py-4 text-sm text-[var(--danger-text)]">
          <p className="min-w-0 flex-1">{loadError} Không thể xét duyệt cho đến khi tải lại thành công.</p>
          <button type="button" disabled={busy} onClick={() => void load()} className={BUTTON_CLASS}>Thử lại</button>
        </div>
      ) : null}

      {registrations !== null ? (
        visibleRegistrations.length === 0 ? (
          <div className="border-t border-[var(--border-subtle)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
            <p>{registrations.length === 0 ? 'Chưa có đội gửi yêu cầu đăng ký.' : filter === 'PENDING' && search.trim() === '' ? 'Không có yêu cầu nào đang chờ duyệt.' : 'Không có yêu cầu phù hợp với bộ lọc.'}</p>
            {registrations.length > 0 && (filter !== 'ALL' || search.trim() !== '') ? (
              <button type="button" onClick={() => { setFilter('ALL'); setSearch(''); }} className={`${BUTTON_CLASS} mt-3`}>Xem tất cả yêu cầu</button>
            ) : null}
          </div>
        ) : (
          <ul aria-busy={busy} className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
            {visibleRegistrations.map((registration) => {
              const rejectionDraft = reviewOpen && rejection?.id === registration.id && rejection.version === registration.version && registration.status === 'PENDING' ? rejection : null;
              const reasonInvalid = rejectionDraft !== null && (rejectionDraft.reason.trim() === '' || rejectionDraft.reason.length > 500);
              return (
                <li key={registration.id} className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h5 className="break-words text-sm font-semibold">{registration.teamName}</h5>
                      <p className="mt-1 break-all font-mono text-xs text-[var(--text-secondary)]">teamId: {registration.teamId}</p>
                    </div>
                    <span className="rounded-full border border-[var(--border-subtle)] px-2 py-1 text-xs font-semibold">{REGISTRATION_STATUS_LABEL[registration.status]}</span>
                  </div>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)]">
                    <span>Gửi lúc <time dateTime={registration.requestedAt}>{formatInstant(registration.requestedAt)}</time></span>
                    {registration.reviewedAt ? <span>Xét duyệt lúc <time dateTime={registration.reviewedAt}>{formatInstant(registration.reviewedAt)}</time></span> : null}
                  </p>
                  <div>
                    <p className="text-xs font-semibold">Thành viên ({registration.members.length})</p>
                    {registration.members.length === 0 ? (
                      <p className="mt-1 text-xs text-[var(--warning-text)]">Không có thành viên trong yêu cầu này.</p>
                    ) : (
                      <ul className="mt-1 flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                        {registration.members.map((member) => (
                          <li key={member.userId} className="break-words">{member.displayName || member.username} · @{member.username} · {member.role === 'CAPTAIN' ? 'Trưởng đội' : 'Thành viên'}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {registration.reason ? (
                    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-2 text-xs">
                      <p className="font-semibold">Lý do xét duyệt (riêng tư)</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-[var(--text-secondary)]">{registration.reason}</p>
                    </div>
                  ) : null}
                  {reviewOpen && canReviewRegistration(state, registration) ? (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={busy} aria-label={`Duyệt đội ${registration.teamName}`} onClick={() => void review(registration, 'APPROVE')} className={`${BUTTON_CLASS} border-[var(--accent-secondary)] text-[var(--accent-secondary)]`}>
                        {pendingId === registration.id ? 'Đang xử lý…' : 'Duyệt đội'}
                      </button>
                      <button type="button" disabled={busy} aria-label={`Từ chối đội ${registration.teamName}`} aria-expanded={rejectionDraft !== null} onClick={() => { setNotice(null); setRejection(rejectionDraft ? null : { id: registration.id, version: registration.version, reason: '' }); }} className={BUTTON_CLASS}>
                        Từ chối
                      </button>
                    </div>
                  ) : null}
                  {rejectionDraft ? (
                    <form onSubmit={(event) => { event.preventDefault(); void review(registration, 'REJECT', rejectionDraft.reason); }} className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3">
                      <label className="flex flex-col gap-1 text-xs font-semibold">
                        <span>Lý do từ chối đội {registration.teamName} (bắt buộc)</span>
                        <textarea required maxLength={500} rows={3} value={rejectionDraft.reason} disabled={busy} onChange={(event) => setRejection({ ...rejectionDraft, reason: event.target.value })} aria-describedby={reasonHintId} className={`${INPUT_CLASS} w-full resize-y font-normal`} />
                      </label>
                      <p id={reasonHintId} className="text-xs text-[var(--text-secondary)]">{rejectionDraft.reason.length}/500 ký tự. Chỉ ADMIN và đội liên quan xem được lý do này. Bạn sẽ được yêu cầu xác nhận trước khi gửi.</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busy || reasonInvalid} className={`${BUTTON_CLASS} border-[var(--danger-text)] text-[var(--danger-text)]`}>Xác nhận từ chối</button>
                        <button type="button" disabled={busy} onClick={() => setRejection(null)} className={BUTTON_CLASS}>Bỏ qua</button>
                      </div>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}
