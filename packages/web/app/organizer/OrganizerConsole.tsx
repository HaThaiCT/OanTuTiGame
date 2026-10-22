'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RatingReviewDto } from '@oantuti/protocol';
import { apiRequest, adjudicationErrorText, errorText, reauthErrorText, REAUTH_PROMPT_TEXT, type ApiResult } from '../../lib/client';
import { entryStatusLabel, formatLabel, stateLabel } from '../../lib/labels';
import {
  addMapPoolEntry,
  approveTournamentRating,
  commitMap,
  getRatingReview,
  reauth,
  rejectTournamentRating,
  removeMapPoolEntry,
  setTournamentRated,
  type MapCommitment,
  type MapPoolView,
  type MapSummary,
  type TournamentEntry,
  type TournamentSummary,
  searchOrganizerTeams,
} from '../../lib/api';
import TeamSearchPicker from './TeamSearchPicker';
import EntryCodesPanel from './EntryCodesPanel';
import RegistrationReviewPanel from './RegistrationReviewPanel';
import MapEditor from './MapEditor';
import TournamentAdjudication from './TournamentAdjudication';
import AccountsInspectionPanel from './AccountsInspectionPanel';
import LanRosterAssignment from './LanRosterAssignment';
import StarterBotsPanel from './StarterBotsPanel';
import { TeamRatingName } from '../_components/TeamRatingName';
import { TournamentRatingProvider } from '../_components/TournamentRatingContext';
import { useRatingRefresh } from '../_components/RatingLivePanels';

type Notice = { kind: 'success' | 'error'; text: string };

/** Outcome of one `run-pending-games` call: the API report or a rendered failure. */
type RunPendingOutcome =
  | { kind: 'result'; ran: number; skipped: number; failed: { gameId: string; error: string }[] }
  | { kind: 'error'; text: string };

/**
 * A destructive action the API refused with 403 `REAUTH_REQUIRED` (migration 016): the session must
 * confirm the operator's password. The action is replayed once — exactly as it was requested — after
 * that confirmation succeeds.
 */
interface ReauthRetry {
  readonly action: string;
  readonly label: string;
}

const TOURNAMENT_FORMATS = ['SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA'] as const;

const SECTIONS = [
  { id: 'overview', label: '1. Tổng quan & Vòng đời' },
  { id: 'configuration', label: '2. Bản đồ & Xếp hạng' },
  { id: 'entries', label: '3. Đội tham dự & Xét duyệt' },
  { id: 'adjudication', label: '4. Kết quả & Kháng nghị' },
  { id: 'starter-bots', label: '5. Thư viện Bot mẫu' },
] as const;
/**
 * States where a team can still be withdrawn. Before the start this only shrinks the field; while
 * the tournament runs the server turns every not-yet-started encounter into an unplayed result
 * (walkover / double withdrawal) instead of a fabricated score.
 */
/** One team's outcome in a bulk enrollment request (`POST …/enroll/bulk`). */
interface BulkEnrollEntry {
  readonly teamId: string;
  readonly status: string;
}

interface BulkEnrollReport {
  readonly dryRun: boolean;
  readonly submitted: number;
  readonly ready: number;
  readonly enrolled: number;
  readonly skipped: number;
  readonly capacityRemaining: number;
  readonly entries: readonly BulkEnrollEntry[];
}

const BULK_STATUS_LABEL: Record<string, string> = {
  ALREADY_ENROLLED: 'đã ở trong giải',
  DUPLICATE_IN_REQUEST: 'trùng trong danh sách',
  UNKNOWN_TEAM: 'không tìm thấy đội',
  INVALID_ID: 'id không hợp lệ',
  CAPACITY_EXCEEDED: 'vượt sức chứa',
};

/** One readable line for a preview/commit result: counts per problem status, never a wall of ids. */
function bulkSummary(report: BulkEnrollReport): string {
  const problems = report.entries.filter((entry) => entry.status !== 'READY');
  const counts = new Map<string, number>();
  for (const entry of problems) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  const head = report.dryRun
    ? `Xem trước: ${report.ready}/${report.submitted} đội thêm được`
    : `Đã thêm ${report.enrolled} đội (bỏ qua ${report.skipped})`;
  const details = [...counts.entries()].map(([status, count]) => `${BULK_STATUS_LABEL[status] ?? status}: ${count}`);
  return [head, `còn ${report.capacityRemaining} chỗ`, ...details].join(' · ');
}

const WITHDRAWABLE_STATES: readonly string[] = [
  'REGISTRATION_OPEN',
  'VALIDATING_SUBMISSIONS',
  'LOCKED',
  'READY_TO_START',
  'RUNNING',
  'PAUSED',
  'PROVISIONAL',
];

/** Actions the lifecycle API accepts, keyed by the state the tournament must be in. */
const STATE_ACTIONS: Record<string, { action: string; label: string }[]> = {
  DRAFT: [{ action: 'publish', label: 'Công bố giải' }],
  PUBLISHED: [
    { action: 'open-registration', label: 'Mở đăng ký' },
    { action: 'lock', label: 'Khóa danh sách' },
  ],
  REGISTRATION_OPEN: [
    { action: 'close-registration', label: 'Đóng đăng ký' },
    { action: 'lock', label: 'Khóa danh sách' },
  ],
  VALIDATING_SUBMISSIONS: [{ action: 'lock', label: 'Khóa danh sách' }],
  READY_TO_START: [{ action: 'start', label: 'Bắt đầu' }],
  RUNNING: [
    { action: 'pause', label: 'Tạm dừng' },
    { action: 'finalize', label: 'Hoàn tất' },
  ],
  PAUSED: [{ action: 'resume', label: 'Tiếp tục' }],
  PROVISIONAL: [{ action: 'finalize', label: 'Hoàn tất' }],
  FINALIZED: [{ action: 'archive', label: 'Lưu trữ giải' }],
};

const ENROLLABLE_STATES: Record<string, true> = {
  REGISTRATION_OPEN: true,
  VALIDATING_SUBMISSIONS: true,
};

/** States where disputes, result corrections or an appeal window can already exist. */
const ADJUDICABLE_STATES: Record<string, true> = {
  RUNNING: true,
  PAUSED: true,
  PROVISIONAL: true,
  FINALIZED: true,
};

/**
 * States where registration has not opened yet, so the map can still be committed.
 * From REGISTRATION_OPEN onwards the server freezes the commitment (MAP_FREEZE_LOCKED).
 */
const COMMITTABLE_STATES: Record<string, true> = {
  DRAFT: true,
  PUBLISHED: true,
};

/** Freeze codes are rendered verbatim: the operator must be able to quote the exact code. */
function commitmentErrorText(result: ApiResult<unknown>, fallback: string): string {
  if (result.message === 'MAP_FREEZE_LOCKED') {
    return 'MAP_FREEZE_LOCKED — bản đồ đã bị khóa cứng vì giải đã mở đăng ký.';
  }
  if (result.message === 'MAP_COMMITMENT_MISMATCH') {
    return 'MAP_COMMITMENT_MISMATCH — bản đồ gửi lên không khớp bản đồ đã chốt.';
  }
  return errorText(result, fallback);
}

const INPUT_CLASS =
  'h-11 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';
const LABEL_CLASS = 'flex flex-col gap-2 text-sm';
const PRIMARY_BUTTON_CLASS =
  'h-11 rounded-md bg-[var(--action)] px-5 font-semibold text-[var(--action-text)] disabled:opacity-60';
const SECONDARY_BUTTON_CLASS =
  'h-10 rounded-md border border-[var(--border-control)] px-4 text-sm font-semibold disabled:opacity-60';

/** `datetime-local` input value → ISO instant; `null` when empty or not a valid date. */
function isoOrNull(value: string): string | null {
  if (value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function NoticeLine({ notice }: { notice: Notice | null | undefined }) {
  if (!notice) return null;
  const tone =
    notice.kind === 'error'
      ? 'border-[var(--danger-text)] text-[var(--danger-text)]'
      : 'border-[var(--success-text)] text-[var(--success-text)]';
  return <p className={`rounded-md border px-3 py-2 text-sm ${tone}`}>{notice.text}</p>;
}

function EntriesList({ entries, state }: { entries?: TournamentEntry[] | null; state: string }) {
  if (state === 'DRAFT') {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        Giải đang ở bản nháp — danh sách đội hiển thị sau khi công bố.
      </p>
    );
  }
  if (!entries) {
    return (
      <p className="rounded-md border border-[var(--warning-text)] px-4 py-3 text-sm text-[var(--warning-text)]">
        Không tải được danh sách đội từ API.
      </p>
    );
  }
  const rows = entries;
  return (
    <div className="rounded-md border border-[var(--border-subtle)]">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold">Đội trong giải</span>
        <span className="text-xs text-[var(--text-secondary)]">{rows.length} đội</span>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-[var(--border-subtle)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
          Chưa có đội nào trong danh sách.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
          {rows.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="font-semibold"><TeamRatingName teamId={entry.teamId} name={entry.teamName} rating={null}/></span>
              <span className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
                <span className="font-mono">teamId: {entry.teamId}</span>
                <span>Seed {entry.seedOrdinal ?? '—'}</span>
                <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
                  {entryStatusLabel[entry.status] ?? entry.status}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface OrganizerConsoleProps {
  section:
    | 'create'
    | 'teams'
    | 'maps'
    | 'tournament'
    | 'overview'
    | 'operations'
    | 'entries'
    | 'configuration'
    | 'adjudication'
    | 'starter-bots';
  tournaments: TournamentSummary[];
  /** Deployment auth profile: ONLINE reviews registrations; LAN keeps ADMIN direct enrollment. */
  authProfile: 'ONLINE' | 'LAN_OFFLINE' | null;
  entriesByTournament: Record<string, TournamentEntry[] | null>;
  /** Committed map per tournament; a missing/DRAFT entry means “no commitment”. */
  commitmentsByTournament: Record<string, MapCommitment | null>;
  /** Tournament map pools; `null` means the pool could not be read. */
  poolsByTournament: Record<string, MapPoolView | null>;
  maps: MapSummary[];
  /**
   * The global organizer console owns account issuance and inspection; a tournament console only
   * manages that tournament. Both share section keys (`teams`, `configuration`), so the accounts
   * panel is gated by scope instead of by key — otherwise "Bản đồ" of a tournament renders it.
   */
  accountsScope?: boolean;
}

/** Mirrors the canonical N/R/T/E policy formulas so operators see the shape before creating. */
function policyPreview(format: string, raw: string): string {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2) return 'Nhập số đội ≥ 2 để xem trước chính sách.';
  const ceilLog2 = Math.ceil(Math.log2(n) - 1e-12);
  if (format === 'SINGLE_ELIMINATION') {
    const size = 2 ** ceilLog2;
    return `Nhánh ${size} đội · ${size - n} bye · knockout 4 ván/cặp, hòa điểm dùng seed tốt hơn.`;
  }
  if (format === 'SWISS_PLAYOFF') {
    const rounds = Math.min(ceilLog2, n % 2 === 0 ? n - 1 : n);
    const cutoff = Math.min(n, Math.max(2, 2 ** Math.floor(Math.log2(Math.floor(Math.sqrt(n))))));
    const encounters = Math.floor(n / 2) * rounds + (cutoff - 1);
    return `Swiss ${rounds} vòng · playoff top ${cutoff} · khoảng ${encounters} cặp (2 ván/cặp; playoff 4 ván).`;
  }
  if (format === 'ROUND_ROBIN') {
    const rounds = n % 2 === 0 ? n - 1 : n;
    return `Vòng tròn ${rounds} vòng · ${(n * (n - 1)) / 2} cặp · 2 ván/cặp.`;
  }
  const e = Math.max(8, 4 * ceilLog2);
  const a = n % 2 === 0 ? e : e - Math.ceil(e / n);
  return `Elo E=${e} · cần ${Math.min(8, a)} trận có rating với ${Math.min(8, a, n - 1)} đối thủ khác nhau.`;
}

function RatedControl({ tournament }: { tournament: TournamentSummary }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const editable = tournament.state === 'DRAFT' || tournament.state === 'PUBLISHED';

  async function update(isRated: boolean) {
    setPending(true);
    const result = await setTournamentRated(tournament.id, isRated, tournament.version);
    setPending(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, 'Không thể cập nhật cấu hình xếp hạng.') });
      router.refresh();
      return;
    }
    setNotice({ kind: 'success', text: isRated ? 'Giải đã được đặt là tính Rating global.' : 'Giải đã được đặt là không tính Rating global.' });
    router.refresh();
  }

  return (
    <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={tournament.isRated} disabled={!editable || pending} onChange={(event) => void update(event.target.checked)} />
        Tính Rating global
      </label>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        {editable ? 'Chỉ có thể thay đổi khi giải ở Bản nháp hoặc Đã xuất bản.' : 'Cấu hình Rating global đã bị khóa theo trạng thái giải.'}
      </p>
      <NoticeLine notice={notice} />
    </div>
  );
}

function RatingReviewPanel({ tournament }: { tournament: TournamentSummary }) {
  const router = useRouter();
  const [review, setReview] = useState<RatingReviewDto | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'approve' | 'reject' | 'reauth' | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [retry, setRetry] = useState<'approve' | 'reject' | null>(null);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    if (document.hidden) { setLoading(false); return; }
    const result = await getRatingReview(tournament.id);
    if (!mounted.current) return;
    setLoading(false);
    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không tải được đánh giá Rating. Dữ liệu hiện có vẫn được giữ nguyên.') });
      return;
    }
    setReview(previous => {
      if (previous?.previewDigest !== result.data!.previewDigest || previous?.tournamentVersion !== result.data!.tournamentVersion || result.data!.updating) setConfirmApprove(false);
      return result.data!;
    });
    setNotice(null);
  }, [tournament.id]);

  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  useRatingRefresh(load, Boolean(review?.updating));

  async function decide(kind: 'approve' | 'reject') {
    if (!review || review.updating) return;
    if (kind === 'approve' && (!confirmApprove || !review.previewDigest)) {
      setNotice({ kind: 'error', text: 'Xác nhận hậu quả công bố trước khi phê duyệt.' });
      return;
    }
    const reason = rejectReason.trim();
    if (kind === 'reject' && reason.length < 3) {
      setNotice({ kind: 'error', text: 'Cần nêu lý do từ 3 ký tự để từ chối.' });
      return;
    }
    setPending(kind);
    const result = kind === 'approve'
      ? await approveTournamentRating(tournament.id, { previewDigest: review.previewDigest!, generationId: review.generationId, expectedVersion: review.tournamentVersion }, crypto.randomUUID())
      : await rejectTournamentRating(tournament.id, { reason, expectedVersion: review.tournamentVersion }, crypto.randomUUID());
    setPending(null);
    if (!result.ok) {
      if (result.code === 'REAUTH_REQUIRED') { setRetry(kind); return; }
      setNotice({ kind: 'error', text: errorText(result, 'Quyết định Rating thất bại.') });
      if (result.code === 'RATING_PREVIEW_STALE' || result.code === 'VERSION_CONFLICT' || result.code === 'RATING_UPDATE_IN_PROGRESS') {
        setConfirmApprove(false);
        setRetry(null);
        await load();
        setNotice({ kind: 'error', text: 'Bản xem trước đã thay đổi. Đã tải lại; hãy kiểm tra và xác nhận hậu quả một lần nữa.' });
      }
      return;
    }
    setNotice({ kind: 'success', text: result.data?.status === 'UPDATING' ? 'Đang cập nhật công bố Rating.' : 'Đã từ chối đánh giá Rating.' });
    setConfirmApprove(false);
    router.refresh();
    await load();
  }

  async function confirmReauth() {
    if (!retry || reauthPassword === '') { setNotice({ kind: 'error', text: 'Nhập mật khẩu để xác nhận lại.' }); return; }
    setPending('reauth');
    const result = await reauth(reauthPassword);
    setPending(null);
    if (!result.ok) { setNotice({ kind: 'error', text: reauthErrorText(result) }); return; }
    const action = retry;
    setRetry(null);
    setReauthPassword('');
    await decide(action);
  }

  const disabled = !review || review.updating || ['UNRATED', 'NOT_FINAL'].includes(review.status) || pending !== null || loading;
  return <section className="mt-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4">
    <h4 className="font-semibold">Duyệt Rating global</h4>
    {loading && !review ? <p className="mt-2 text-sm text-[var(--text-secondary)]">Đang tải đánh giá…</p> : null}
    <NoticeLine notice={notice} />
    <button type="button" onClick={() => void load()} disabled={loading || pending !== null} className={SECONDARY_BUTTON_CLASS}>Tải lại đánh giá</button>
    {review ? <>
      <p className="mt-2 text-sm">Trạng thái: <strong>{review.status}</strong>{review.updating ? ' · Đang cập nhật; đang hiển thị bản công bố trước.' : ''}</p>
      <p className="text-xs text-[var(--text-secondary)]">Tính lại {review.affectedContestCount} giải kế tiếp · Bản công bố {review.generationId ?? 'chưa có'} · Phiên bản {review.desiredRevision} · Bản xem trước: {review.previewDigest ?? '—'}</p>
      {review.reason ? <p className="mt-1 text-sm text-[var(--warning-text)]">Lý do: {review.reason}</p> : null}
      {review.exclusions.length > 0 ? <ul className="mt-2 text-xs text-[var(--text-secondary)]">{review.exclusions.map((item) => <li key={item.teamId}><span className="font-mono">{item.teamId}</span>: {item.reason === 'PRESTART_EXCLUDED' ? 'Loại trước khi bắt đầu — không tính rating' : item.reason === 'DISQUALIFIED' ? 'Truất quyền thi đấu — không tính rating' : 'Rút sau khi bắt đầu — vẫn tính rating, đồng hạng cuối'}</li>)}</ul> : null}
      {review.changes.length > 0 ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><caption>Vị trí và thay đổi Rating global dự kiến</caption><thead><tr><th scope="col">Đội</th><th scope="col">Hạng</th><th scope="col">Cũ</th><th scope="col">Δ</th><th scope="col">Mới</th></tr></thead><tbody>{review.changes.map((change) => <tr key={change.teamId}><td><TeamRatingName teamId={change.teamId} name={change.teamId} rating={null}/></td><td>{change.rank}{change.rankEnd > change.rank ? `–${change.rankEnd}` : ''}</td><td>{change.oldPublicRating === null ? 'Unrated (1500 hiệu dụng)' : change.oldRating}</td><td>{change.delta >= 0 ? '+' : ''}{change.delta}</td><td>{change.newRating}</td></tr>)}</tbody></table></div> : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex max-w-md items-start gap-2 text-xs"><input type="checkbox" checked={confirmApprove} disabled={disabled} onChange={(event) => setConfirmApprove(event.target.checked)} /> Tôi hiểu việc phê duyệt sẽ công bố thay đổi Rating global và có thể tính lại các giải bị ảnh hưởng.</label>
        <button type="button" disabled={disabled || review.status === 'BLOCKED' || !confirmApprove || !review.previewDigest} onClick={() => void decide('approve')} className={PRIMARY_BUTTON_CLASS}>{pending === 'approve' ? 'Đang duyệt…' : 'Phê duyệt Rating'}</button>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3"><label className={LABEL_CLASS}>Lý do từ chối (bắt buộc, 3–500 ký tự)<textarea maxLength={500} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} disabled={disabled} className="min-h-20 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] p-2 text-sm" /></label><button type="button" disabled={disabled || rejectReason.trim().length < 3} onClick={() => void decide('reject')} className={SECONDARY_BUTTON_CLASS}>{pending === 'reject' ? 'Đang từ chối…' : 'Từ chối Rating'}</button></div>
      {retry ? <div className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-[var(--warning-text)] p-3"><label className={LABEL_CLASS}><span>{REAUTH_PROMPT_TEXT}</span><input type="password" autoComplete="current-password" value={reauthPassword} onChange={(event) => setReauthPassword(event.target.value)} className={INPUT_CLASS} /></label><button type="button" onClick={() => void confirmReauth()} disabled={pending !== null} className={PRIMARY_BUTTON_CLASS}>{pending === 'reauth' ? 'Đang xác nhận…' : 'Xác nhận'}</button></div> : null}
    </> : null}
  </section>;
}

export default function OrganizerConsole({
  section,
  authProfile,
  tournaments,
  entriesByTournament,
  commitmentsByTournament,
  poolsByTournament,
  maps,
  accountsScope = false,
}: OrganizerConsoleProps) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [previewFormat, setPreviewFormat] = useState('SINGLE_ELIMINATION');
  const [previewTeams, setPreviewTeams] = useState('32');
  const [createNotice, setCreateNotice] = useState<Notice | null>(null);
  const [teamNotice, setTeamNotice] = useState<Notice | null>(null);
  const [cardNotices, setCardNotices] = useState<Record<string, Notice>>({});
  const [enrollDraft, setEnrollDraft] = useState<Record<string, string>>({});
  const [withdrawDraft, setWithdrawDraft] = useState<Record<string, string>>({});
  const [bulkDraft, setBulkDraft] = useState<Record<string, string>>({});
  const [bulkReport, setBulkReport] = useState<Record<string, BulkEnrollReport | null>>({});
  const [closesAtDraft, setClosesAtDraft] = useState<Record<string, string>>({});
  const [mapSlugDraft, setMapSlugDraft] = useState<Record<string, string>>({});
  const [poolSlugDraft, setPoolSlugDraft] = useState<Record<string, string>>({});
  const [runOutcomes, setRunOutcomes] = useState<Record<string, RunPendingOutcome>>({});
  const [reauthRetries, setReauthRetries] = useState<Record<string, ReauthRetry>>({});
  const [reauthPasswords, setReauthPasswords] = useState<Record<string, string>>({});
  const archiveRequests = useRef<Record<string, { key: string; expectedVersion?: number }>>({});
  const [activeAnchor, setActiveAnchor] = useState<string>('overview');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash && SECTIONS.some((s) => s.id === initialHash)) {
      setActiveAnchor(initialHash);
      const el = document.getElementById(initialHash);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveAnchor(entry.target.id);
          }
        }
      },
      { rootMargin: '-10% 0px -70% 0px' }
    );

    for (const sec of SECTIONS) {
      const el = document.getElementById(sec.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  function setCardNotice(tournamentId: string, notice: Notice | null) {
    setCardNotices((current) => {
      if (notice) return { ...current, [tournamentId]: notice };
      const next = { ...current };
      delete next[tournamentId];
      return next;
    });
  }

  async function createTournament(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const courseCode = String(data.get('courseCode') ?? '').trim();
    const name = String(data.get('name') ?? '').trim();
    if (courseCode === '' || name === '') {
      setCreateNotice({ kind: 'error', text: 'Cần nhập mã học phần và tên giải.' });
      return;
    }
    const body: Record<string, unknown> = { courseCode, name, format: String(data.get('format') ?? '') };
    const maxTeamsInput = String(data.get('maxTeams') ?? '').trim();
    if (maxTeamsInput !== '') {
      const maxTeams = Number(maxTeamsInput);
      if (!Number.isInteger(maxTeams) || maxTeams <= 0) {
        setCreateNotice({ kind: 'error', text: 'Số đội tối đa phải là số nguyên dương.' });
        return;
      }
      body.maxTeams = maxTeams;
    }
    const opensAt = isoOrNull(String(data.get('registrationOpensAt') ?? ''));
    const closesAt = isoOrNull(String(data.get('registrationClosesAt') ?? ''));
    if (opensAt) body.registrationOpensAt = opensAt;
    if (closesAt) body.registrationClosesAt = closesAt;

    setPending('create-tournament');
    const result = await apiRequest<{ tournament?: { id?: string; name?: string } }>('/api/v2/organizer/tournaments', {
      method: 'POST',
      body,
    });
    setPending(null);
    if (!result.ok) {
      setCreateNotice({ kind: 'error', text: errorText(result, 'Tạo giải thất bại.') });
      return;
    }
    setCreateNotice({
      kind: 'success',
      text: `Đã tạo giải “${result.data?.tournament?.name ?? name}” ở trạng thái bản nháp.`,
    });
    form.reset();
    if (result.data?.tournament?.id) {
      router.push(`/organizer/tournaments/${encodeURIComponent(result.data.tournament.id)}`);
      return;
    }
    router.refresh();
  }

  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const courseCode = String(data.get('courseCode') ?? '').trim();
    const name = String(data.get('name') ?? '').trim();
    const captainUsername = String(data.get('captainUsername') ?? '').trim();
    if (courseCode === '' || name === '' || captainUsername === '') {
      setTeamNotice({ kind: 'error', text: 'Cần nhập mã học phần, tên đội và tên đăng nhập đội trưởng.' });
      return;
    }
    setPending('create-team');
    const result = await apiRequest<{ team?: { id?: string; name?: string } }>('/api/v2/organizer/teams', {
      method: 'POST',
      body: { courseCode, name, captainUsername },
    });
    setPending(null);
    if (!result.ok) {
      setTeamNotice({ kind: 'error', text: errorText(result, 'Tạo đội thất bại.') });
      return;
    }
    const teamId = result.data?.team?.id;
    setTeamNotice({
      kind: 'success',
      text: `Đã tạo đội ${result.data?.team?.name ?? name}${teamId ? ` — teamId: ${teamId}` : ''}`,
    });
    form.reset();
  }

  async function runAction(tournament: TournamentSummary, action: string, label: string) {
    const body: Record<string, unknown> = {};
    let archiveRequest: { key: string; expectedVersion?: number } | undefined;
    if (action === 'archive') {
      if (tournament.state !== 'FINALIZED') {
        setCardNotice(tournament.id, { kind: 'error', text: 'Chỉ giải đã hoàn tất mới có thể lưu trữ.' });
        return;
      }
      archiveRequest = archiveRequests.current[tournament.id];
      if (!archiveRequest) {
        if (!window.confirm('Lưu trữ giải đã hoàn tất? Kết quả, mã nguồn đã nộp, replay và các yêu cầu giữ dữ liệu vẫn được bảo toàn theo chính sách lưu giữ. Bài nộp chính thức tiếp tục đóng; đội vẫn có thể chạy thử riêng tư. Đây không phải thao tác xóa dữ liệu.')) return;
        archiveRequest = { key: crypto.randomUUID(), expectedVersion: tournament.version };
        archiveRequests.current[tournament.id] = archiveRequest;
      }
      if (archiveRequest.expectedVersion !== undefined) body.expectedVersion = archiveRequest.expectedVersion;
    }
    let startMapSlug = '';
    if (action === 'open-registration') {
      const closesInput = closesAtDraft[tournament.id] ?? '';
      const closesAt = isoOrNull(closesInput);
      if (closesInput.trim() !== '' && closesAt === null) {
        setCardNotice(tournament.id, { kind: 'error', text: 'Hạn đăng ký không hợp lệ.' });
        return;
      }
      if (closesAt) body.registrationClosesAt = closesAt;
    }
    if (action === 'start') {
      // A committed map is pinned for the tournament, so it wins over the operator's select.
      startMapSlug = (commitmentsByTournament[tournament.id] ?? null)?.slug ?? mapSlugDraft[tournament.id] ?? maps[0]?.slug ?? '';
      if (startMapSlug === '') {
        setCardNotice(tournament.id, {
          kind: 'error',
          text: 'Chưa có bản đồ nào trên server — hãy tạo bản đồ trước khi bắt đầu.',
        });
        return;
      }
      body.mapSlug = startMapSlug;
    }
    setPending(`${tournament.id}:${action}`);
    const result = await apiRequest(`/api/v2/organizer/tournaments/${tournament.id}/${action}`, {
      method: 'POST',
      body,
      ...(archiveRequest ? { headers: { 'idempotency-key': archiveRequest.key } } : {}),
    });
    setPending(null);
    if (!result.ok) {
      if (result.code === 'REAUTH_REQUIRED') {
        // Destructive action refused until this session confirms the password. The inline prompt
        // below carries the message, so any stale notice is dropped instead of lying about success.
        setReauthRetries((current) => ({ ...current, [tournament.id]: { action, label } }));
        setCardNotice(tournament.id, null);
        return;
      }
      if (action === 'archive' && result.status >= 400 && result.status < 500 && !result.message?.includes('IDEMPOTENT_IN_FLIGHT')) {
        delete archiveRequests.current[tournament.id];
        if (result.message?.includes('STALE_VERSION')) router.refresh();
      }
      let text =
        action === 'finalize'
          ? adjudicationErrorText(result, `${label} thất bại.`)
          : errorText(result, `${label} thất bại.`);
      if (action === 'start') {
        if (result.message === 'MAP_REQUIRED') {
          text = 'Server báo MAP_REQUIRED — hãy chọn bản đồ trước khi bắt đầu.';
        } else if (result.message === 'MAP_FREEZE_LOCKED' || result.message === 'MAP_COMMITMENT_MISMATCH') {
          text = commitmentErrorText(result, text);
        } else if (result.status === 404) {
          text = `Không tìm thấy bản đồ “${startMapSlug}” trên server (404).`;
        }
      }
      setCardNotice(tournament.id, { kind: 'error', text });
      return;
    }
    if (action === 'archive') delete archiveRequests.current[tournament.id];
    setCardNotice(tournament.id, {
      kind: 'success',
      text: action === 'start' ? `${label}: thành công với bản đồ “${startMapSlug}”.` : `${label}: thành công.`,
    });
    router.refresh();
  }

  /**
   * Confirms the password for the paused action, then replays that one action. A refused confirmation
   * replays nothing and reports the refusal: the card must never read as if the action had run.
   */
  async function confirmReauth(tournament: TournamentSummary) {
    const retry = reauthRetries[tournament.id];
    const password = reauthPasswords[tournament.id] ?? '';
    if (!retry) return;
    if (password === '') {
      setCardNotice(tournament.id, { kind: 'error', text: 'Nhập mật khẩu để xác nhận lại.' });
      return;
    }
    setPending(`${tournament.id}:reauth`);
    const result = await reauth(password);
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, { kind: 'error', text: reauthErrorText(result) });
      return;
    }
    setReauthPasswords((current) => {
      const next = { ...current };
      delete next[tournament.id];
      return next;
    });
    setReauthRetries((current) => {
      const next = { ...current };
      delete next[tournament.id];
      return next;
    });
    await runAction(tournament, retry.action, retry.label);
  }

  async function commitMapForTournament(tournament: TournamentSummary) {
    const slug = mapSlugDraft[tournament.id] ?? maps[0]?.slug ?? '';
    if (slug === '') {
      setCardNotice(tournament.id, {
        kind: 'error',
        text: 'Chưa có bản đồ nào trên server — hãy tạo bản đồ trước khi chốt.',
      });
      return;
    }
    setPending(`${tournament.id}:commit-map`);
    const result = await commitMap(tournament.id, slug);
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, {
        kind: 'error',
        text: commitmentErrorText(result, `Chốt bản đồ “${slug}” thất bại.`),
      });
      return;
    }
    const version = result.data?.version;
    setCardNotice(tournament.id, {
      kind: 'success',
      text: `Đã chốt bản đồ “${result.data?.slug ?? slug}”${version ? ` ở phiên bản v${version}` : ''}.`,
    });
    router.refresh();
  }

  async function runPendingGames(tournament: TournamentSummary) {
    setPending(`${tournament.id}:run-pending-games`);
    const result = await apiRequest<{ ran: number; failed: { gameId: string; error: string }[]; skipped: number }>(
      `/api/v2/organizer/tournaments/${tournament.id}/run-pending-games`,
      { method: 'POST', body: { limit: 8 } }
    );
    setPending(null);
    if (!result.ok) {
      const text =
        result.status === 409 || result.message === 'DEV_EXECUTION_DISABLED'
          ? 'Không chạy được: server chưa bật chế độ chạy dev (DEV_EXECUTION_DISABLED).'
          : errorText(result, 'Chạy các ván đang chờ thất bại.');
      setRunOutcomes((current) => ({ ...current, [tournament.id]: { kind: 'error', text } }));
      return;
    }
    const failed = Array.isArray(result.data?.failed) ? result.data.failed : [];
    setRunOutcomes((current) => ({
      ...current,
      [tournament.id]: {
        kind: 'result',
        ran: result.data?.ran ?? 0,
        skipped: result.data?.skipped ?? 0,
        failed,
      },
    }));
    router.refresh();
  }

  async function enrollTeam(tournament: TournamentSummary) {
    const teamId = (enrollDraft[tournament.id] ?? '').trim();
    if (teamId === '') {
      setCardNotice(tournament.id, { kind: 'error', text: 'Nhập teamId trước khi thêm đội.' });
      return;
    }
    setPending(`${tournament.id}:enroll`);
    const result = await apiRequest(`/api/v2/organizer/tournaments/${tournament.id}/enroll`, {
      method: 'POST',
      body: { teamId },
    });
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, { kind: 'error', text: errorText(result, 'Thêm đội thất bại.') });
      return;
    }
    setEnrollDraft((current) => ({ ...current, [tournament.id]: '' }));
    setCardNotice(tournament.id, { kind: 'success', text: `Đã thêm đội ${teamId} vào giải.` });
    router.refresh();
  }


  /** Splits a pasted roster on any whitespace/comma/semicolon run. */
  function parseBulkIds(raw: string): string[] {
    return raw
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter((value) => value !== '');
  }

  /**
   * Bulk direct enrollment with a preview pass: the first click only reports what would happen,
   * the second one writes it. Capacity is all-or-nothing on the server, so a roster that does not
   * fit is refused as a whole instead of half-landing.
   */
  async function submitBulkEnroll(tournament: TournamentSummary, dryRun: boolean) {
    const teamIds = parseBulkIds(bulkDraft[tournament.id] ?? '');
    if (teamIds.length === 0) {
      setCardNotice(tournament.id, { kind: 'error', text: 'Dán ít nhất một teamId (mỗi dòng một đội).' });
      return;
    }
    if (!dryRun) {
      const confirmed = window.confirm(
        `Thêm ${teamIds.length} teamId vào giải? Chỉ đội tồn tại và chưa ở trong giải mới được thêm; nếu vượt sức chứa thì không đội nào được thêm.`
      );
      if (!confirmed) return;
    }
    setPending(`${tournament.id}:bulk-${dryRun ? 'preview' : 'commit'}`);
    const result = await apiRequest<BulkEnrollReport>(
      `/api/v2/organizer/tournaments/${tournament.id}/enroll/bulk`,
      { method: 'POST', body: { teamIds, dryRun } }
    );
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, { kind: 'error', text: errorText(result, 'Nhập hàng loạt thất bại.') });
      return;
    }
    if (result.data) {
      setBulkReport((current) => ({ ...current, [tournament.id]: result.data ?? null }));
    }
    if (!dryRun) {
      setCardNotice(tournament.id, {
        kind: 'success',
        text: `Nhập hàng loạt xong: ${result.data?.enrolled ?? 0} đội được thêm, ${result.data?.skipped ?? 0} bỏ qua.`,
      });
      setBulkDraft((current) => ({ ...current, [tournament.id]: '' }));
      router.refresh();
    }
  }

  /**
   * The pool is the set of maps a tournament may play (knockout series need four). It freezes with
   * the commitment at registration opening, so these controls only exist while maps can change.
   */
  async function addMapToPool(tournament: TournamentSummary) {
    const pool = poolsByTournament[tournament.id]?.pool ?? [];
    const slug =
      poolSlugDraft[tournament.id] ??
      maps.find((map) => !pool.some((entry) => entry.slug === map.slug))?.slug ??
      '';
    if (slug === '') {
      setCardNotice(tournament.id, { kind: 'error', text: 'Không còn bản đồ nào để thêm vào pool.' });
      return;
    }
    setPending(`${tournament.id}:pool-add`);
    const result = await addMapPoolEntry(tournament.id, slug);
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, { kind: 'error', text: errorText(result, 'Thêm bản đồ vào pool thất bại.') });
      return;
    }
    setPoolSlugDraft((current) => ({ ...current, [tournament.id]: '' }));
    setCardNotice(tournament.id, { kind: 'success', text: `Đã thêm ${slug} vào pool.` });
    router.refresh();
  }

  async function removeMapFromPool(tournament: TournamentSummary, slug: string) {
    setPending(`${tournament.id}:pool-remove:${slug}`);
    const result = await removeMapPoolEntry(tournament.id, slug);
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, { kind: 'error', text: errorText(result, 'Bỏ bản đồ khỏi pool thất bại.') });
      return;
    }
    setCardNotice(tournament.id, { kind: 'success', text: `Đã bỏ ${slug} khỏi pool.` });
    router.refresh();
  }

  /**
   * Withdraws a team. Before the start this only removes it from the field; while the tournament
   * is live the server resolves every not-yet-started encounter as an unplayed walkover, so the
   * operator gets an explicit confirmation instead of a silent score change.
   */
  async function withdrawTeam(tournament: TournamentSummary) {
    const teamId = (withdrawDraft[tournament.id] ?? '').trim();
    if (teamId === '') {
      setCardNotice(tournament.id, { kind: 'error', text: 'Nhập teamId cần rút trước.' });
      return;
    }
    const live = ['RUNNING', 'PAUSED', 'PROVISIONAL'].includes(tournament.state);
    if (live) {
      const confirmed = window.confirm(
        'Giải đang chạy: mọi cặp chưa bắt đầu của đội này sẽ được xử walkover (Swiss/vòng tròn 3 điểm cho đối thủ, loại trực tiếp đi tiếp, Elo không đổi rating). Tiếp tục?'
      );
      if (!confirmed) return;
    }
    setPending(`${tournament.id}:withdraw`);
    const result = await apiRequest<{ walkovers?: number; doubleWithdrawals?: number }>(
      `/api/v2/organizer/tournaments/${tournament.id}/teams/${teamId}/withdraw`,
      { method: 'POST', body: { reason: live ? 'Rút khi giải đang chạy (organizer)' : 'Rút trước khi bắt đầu (organizer)' } }
    );
    setPending(null);
    if (!result.ok) {
      setCardNotice(tournament.id, { kind: 'error', text: errorText(result, 'Rút đội thất bại.') });
      return;
    }
    setWithdrawDraft((current) => ({ ...current, [tournament.id]: '' }));
    const walkovers = result.data?.walkovers ?? 0;
    setCardNotice(tournament.id, {
      kind: 'success',
      text:
        walkovers > 0
          ? `Đã rút đội ${teamId}; ${walkovers} cặp chưa đấu được xử walkover.`
          : `Đã rút đội ${teamId} khỏi giải.`,
    });
    router.refresh();
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {accountsScope === true && section === 'teams' && (
        <AccountsInspectionPanel authProfile={authProfile} tournaments={tournaments} entriesByTournament={entriesByTournament} />
      )}
      {accountsScope && authProfile === 'LAN_OFFLINE' && section === 'teams' ? <LanRosterAssignment enabled /> : null}
      <div className="grid items-start gap-4">
        {section === 'create' ? (
        <form onSubmit={createTournament} className="flex min-w-0 flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5">
          <div>
            <h2 className="text-base font-semibold">Tạo giải đấu</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">Giải mới luôn bắt đầu ở trạng thái bản nháp và chưa hiển thị công khai.</p>
          </div>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Mã học phần</span>
            <input name="courseCode" required placeholder="CS101" className={INPUT_CLASS} />
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Tên giải</span>
            <input name="name" required placeholder="OanTuTi Arena Học kỳ 2026.1" className={INPUT_CLASS} />
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Thể thức</span>
            <select
              name="format"
              value={previewFormat}
              onChange={(event) => setPreviewFormat(event.target.value)}
              className={INPUT_CLASS}
            >
              {TOURNAMENT_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {formatLabel[format]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Số đội tối đa (tùy chọn)</span>
            <input
              name="maxTeams"
              type="number"
              min={1}
              step={1}
              placeholder="32"
              value={previewTeams}
              onChange={(event) => setPreviewTeams(event.target.value)}
              className={INPUT_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">{policyPreview(previewFormat, previewTeams)}</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              <span className="font-medium">Mở đăng ký (tùy chọn)</span>
              <input name="registrationOpensAt" type="datetime-local" className={INPUT_CLASS} />
            </label>
            <label className={LABEL_CLASS}>
              <span className="font-medium">Đóng đăng ký (tùy chọn)</span>
              <input name="registrationClosesAt" type="datetime-local" className={INPUT_CLASS} />
            </label>
          </div>
          <NoticeLine notice={createNotice} />
          <button disabled={pending !== null} className={PRIMARY_BUTTON_CLASS}>
            {pending === 'create-tournament' ? 'Đang tạo…' : 'Tạo giải'}
          </button>
        </form>
        ) : null}

        {section === 'teams' ? (
        <form onSubmit={createTeam} className="flex min-w-0 flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5">
          <div>
            <h2 className="text-base font-semibold">Tạo đội</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">Đội trưởng phải là tài khoản đã tồn tại trong hệ thống.</p>
          </div>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Mã học phần</span>
            <input name="courseCode" required placeholder="CS101" className={INPUT_CLASS} />
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Tên đội</span>
            <input name="name" required placeholder="Nhóm 07 — Búa Kéo Bao" className={INPUT_CLASS} />
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Tên đăng nhập đội trưởng</span>
            <input name="captainUsername" required autoComplete="off" placeholder="sv2026007" className={INPUT_CLASS} />
          </label>
          <NoticeLine notice={teamNotice} />
          <button disabled={pending !== null} className={PRIMARY_BUTTON_CLASS}>
            {pending === 'create-team' ? 'Đang tạo…' : 'Tạo đội'}
          </button>
          <p className="text-xs text-[var(--text-secondary)]">
            Sau khi tạo, dùng teamId ở ô “Thêm đội trực tiếp” của giải để ghi danh.
          </p>
        </form>
        ) : null}
      </div>

      {section === 'maps' ? <MapEditor initialMaps={maps} /> : null}

      {!['create', 'teams', 'maps'].includes(section) ? (
      <div className="flex flex-col gap-6">
        {tournaments.length === 0 ? (
          <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
            Chưa có giải nào. Tạo giải đầu tiên bằng biểu mẫu phía trên.
          </p>
        ) : (
          tournaments.map((tournament) => {
            const actions = STATE_ACTIONS[tournament.state] ?? [];
            const canEnroll = authProfile === 'LAN_OFFLINE' && ENROLLABLE_STATES[tournament.state] === true;
            const commitment = commitmentsByTournament[tournament.id] ?? null;
            const canCommitMap = COMMITTABLE_STATES[tournament.state] === true;
            const notice = cardNotices[tournament.id];
            const runOutcome = runOutcomes[tournament.id];
            const reauthRetry = reauthRetries[tournament.id];

            return (
              <div key={tournament.id} className="flex flex-col gap-6">
                {/* Sticky Anchor Navigation */}
                <nav
                  aria-label="Điều hướng nhanh các mục giải đấu"
                  className="sticky top-0 z-30 -mx-1 px-1 py-2.5 bg-[var(--canvas)]/95 backdrop-blur border-b border-[var(--border-subtle)] shadow-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {SECTIONS.map((sec) => (
                      <a
                        key={sec.id}
                        href={`#${sec.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          const el = document.getElementById(sec.id);
                          if (el) {
                            el.scrollIntoView({ behavior: 'smooth' });
                            history.replaceState(null, '', `#${sec.id}`);
                            setActiveAnchor(sec.id);
                          }
                        }}
                        className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
                          activeAnchor === sec.id
                            ? 'vct-btn-primary !py-1 !px-3.5 shadow-sm'
                            : 'vct-btn-secondary !py-1 !px-3.5 hover:border-[var(--action)]'
                        }`}
                      >
                        {sec.label}
                      </a>
                    ))}
                  </div>
                </nav>

                {/* Section 1: Overview & Lifecycle */}
                <section
                  id="overview"
                  className="scroll-mt-14 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm"
                >
                  <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-[var(--text-primary)]">1. Tổng quan & Vòng đời giải đấu</h3>
                      <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                        Trạng thái hiện tại và các thao tác chuyển đổi vòng đời theo quy tắc máy chủ
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface)] px-2.5 py-0.5 text-xs font-semibold text-[var(--live-accent)]">
                        {stateLabel[tournament.state] ?? tournament.state}
                      </span>
                      <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface)] px-2.5 py-0.5 text-xs font-semibold">
                        {tournament.isRated ? 'Rated' : 'Unrated'}
                      </span>
                    </div>
                  </div>

                  <div className="p-5 flex flex-col gap-5">
                    {/* Facts Grid */}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-xs">
                      <div>
                        <span className="text-[var(--text-secondary)] block">Thể thức</span>
                        <strong className="text-[var(--text-primary)] text-sm font-semibold">
                          {formatLabel[tournament.format] ?? tournament.format}
                        </strong>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">Sức chứa tối đa</span>
                        <strong className="text-[var(--text-primary)] text-sm font-semibold">{tournament.maxTeams} đội</strong>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">Số đội trong giải</span>
                        <strong className="text-[var(--text-primary)] text-sm font-semibold">
                          {entriesByTournament[tournament.id] ? `${entriesByTournament[tournament.id]?.length} đội` : tournament.state === 'DRAFT' ? 'Bản nháp' : '—'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">Bản đồ cam kết</span>
                        <strong className="text-[var(--text-primary)] text-sm font-semibold">
                          {commitment ? `${commitment.displayName} (v${commitment.version})` : 'Chưa chốt'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">Hạn đóng đăng ký</span>
                        <span className="font-mono text-[11px] text-[var(--text-primary)]">
                          {tournament.registrationClosesAt ? `${tournament.registrationClosesAt.slice(0, 16).replace('T', ' ')} UTC` : 'Không giới hạn'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">Thời gian bắt đầu</span>
                        <span className="font-mono text-[11px] text-[var(--text-primary)]">
                          {tournament.startedAt ? `${tournament.startedAt.slice(0, 16).replace('T', ' ')} UTC` : 'Chưa bắt đầu'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">Phiên bản / Quy tắc</span>
                        <span className="font-mono text-[11px] text-[var(--text-primary)]">
                          v{tournament.version} · {tournament.rulesRevision || 'ArenaRules/v1'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[var(--text-secondary)] block">ID Giải đấu</span>
                        <span className="font-mono text-[11px] text-[var(--text-primary)] truncate block" title={tournament.id}>
                          {tournament.id}
                        </span>
                      </div>
                    </div>

                    {/* Notice Line */}
                    <NoticeLine notice={notice} />

                    {/* Lifecycle Actions */}
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 flex flex-col gap-4">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Thao tác vòng đời khả dụng</h4>

                      <div className="flex flex-wrap items-end gap-3">
                        {tournament.state === 'PUBLISHED' && (
                          <label className={`${LABEL_CLASS} text-xs`}>
                            <span className="text-[var(--text-secondary)]">Hạn đăng ký (tùy chọn)</span>
                            <input
                              type="datetime-local"
                              value={closesAtDraft[tournament.id] ?? ''}
                              onChange={(event) =>
                                setClosesAtDraft((current) => ({ ...current, [tournament.id]: event.target.value }))
                              }
                              className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                            />
                          </label>
                        )}

                        {tournament.state === 'READY_TO_START' && !commitment && (
                          <label className={`${LABEL_CLASS} text-xs`}>
                            <span className="text-[var(--text-secondary)]">Bản đồ vòng 1</span>
                            <select
                              value={mapSlugDraft[tournament.id] ?? maps[0]?.slug ?? ''}
                              onChange={(event) =>
                                setMapSlugDraft((current) => ({ ...current, [tournament.id]: event.target.value }))
                              }
                              disabled={maps.length === 0}
                              className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                            >
                              {maps.length === 0 ? <option value="">Chưa có bản đồ</option> : null}
                              {maps.map((map) => (
                                <option key={map.slug} value={map.slug}>
                                  {map.displayName ? `${map.displayName} (${map.slug})` : map.slug}
                                  {map.currentVersion !== undefined ? ` · v${map.currentVersion}` : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}

                        {actions.map(({ action, label }) => (
                          <button
                            key={action}
                            type="button"
                            disabled={pending !== null}
                            onClick={() => void runAction(tournament, action, label)}
                            className={PRIMARY_BUTTON_CLASS + ' !h-10'}
                          >
                            {pending === `${tournament.id}:${action}`
                              ? 'Đang xử lý…'
                              : action === 'start' && commitment
                                ? `Bắt đầu với ${commitment.displayName} (v${commitment.version})`
                                : label}
                          </button>
                        ))}

                        {(tournament.state === 'RUNNING' || tournament.state === 'PAUSED') && (
                          <button
                            type="button"
                            disabled={pending !== null}
                            onClick={() => void runPendingGames(tournament)}
                            className="vct-btn-secondary !h-10 !px-4 !text-xs font-semibold border-[var(--action)] text-[var(--action)] hover:bg-[rgba(0,245,212,0.06)] disabled:opacity-60 transition-colors"
                          >
                            {pending === `${tournament.id}:run-pending-games` ? 'Đang chạy…' : 'Chạy các ván đang chờ (8)'}
                          </button>
                        )}

                        {actions.length === 0 && tournament.state !== 'RUNNING' && tournament.state !== 'PAUSED' && (
                          <p className="text-xs text-[var(--text-secondary)] italic">
                            Không có thao tác chuyển đổi trạng thái nào cho trạng thái {stateLabel[tournament.state] ?? tournament.state}.
                          </p>
                        )}
                      </div>

                      {/* Reauth prompt */}
                      {reauthRetry && (
                        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--warning-text)] bg-[rgba(245,165,36,0.06)] p-3">
                          <label className={`${LABEL_CLASS} text-xs flex-1 min-w-[200px]`}>
                            <span className="font-semibold text-[var(--warning-text)]">{REAUTH_PROMPT_TEXT}</span>
                            <input
                              type="password"
                              autoComplete="current-password"
                              value={reauthPasswords[tournament.id] ?? ''}
                              onChange={(event) =>
                                setReauthPasswords((current) => ({ ...current, [tournament.id]: event.target.value }))
                              }
                              placeholder="Nhập mật khẩu quản trị viên"
                              className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                            />
                          </label>
                          <button
                            type="button"
                            disabled={pending !== null}
                            onClick={() => void confirmReauth(tournament)}
                            className={PRIMARY_BUTTON_CLASS + ' !h-10'}
                          >
                            {pending === `${tournament.id}:reauth` ? 'Đang xác nhận…' : 'Xác nhận lại'}
                          </button>
                          <span className="w-full text-[11px] text-[var(--text-secondary)]">
                            Thao tác “{reauthRetry.label}” sẽ được tự động thực hiện lại sau khi xác nhận mật khẩu.
                          </span>
                        </div>
                      )}

                      {/* Run Pending Outcome */}
                      {runOutcome?.kind === 'error' && (
                        <NoticeLine notice={{ kind: 'error', text: runOutcome.text }} />
                      )}
                      {runOutcome?.kind === 'result' && (
                        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-3 text-xs text-[var(--text-primary)]">
                          <p>
                            Đã chạy <span className="font-bold text-[var(--success-text)]">{runOutcome.ran}</span> ván · bỏ qua{' '}
                            <span className="font-semibold">{runOutcome.skipped}</span> ván còn lại
                            {runOutcome.failed.length > 0 ? ` · ${runOutcome.failed.length} ván lỗi` : ''}.
                          </p>
                          {runOutcome.failed.length > 0 && (
                            <ul className="mt-2 list-disc pl-5 text-xs text-[var(--danger-text)]">
                              {runOutcome.failed.map((failure) => (
                                 <li key={failure.gameId}>
                                   <span className="font-mono">{failure.gameId}</span>: {failure.error}
                                 </li>
                               ))}
                             </ul>
                           )}
                         </div>
                       )}
                     </div>
                   </div>
                 </section>

                 {/* Section 2: Map & Rating Configuration */}
                 <section
                   id="configuration"
                   className="scroll-mt-14 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm"
                 >
                   <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-3.5">
                     <h3 className="text-sm font-bold text-[var(--text-primary)]">2. Cấu hình Bản đồ & Xếp hạng</h3>
                     <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                       Cam kết bản đồ thi đấu, thiết lập pool bản đồ cho loạt knockout và chính sách tính Rating global
                     </p>
                   </div>

                   <div className="p-5 flex flex-col gap-5">
                     {/* Map Commitment Box */}
                     <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 flex flex-col gap-3">
                       <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Bản đồ cam kết (Commit Map)</h4>
                       {canCommitMap ? (
                         <>
                           <div className="flex flex-wrap items-end gap-3">
                             <label className={`${LABEL_CLASS} text-xs flex-1 min-w-[200px]`}>
                               <span className="text-[var(--text-secondary)]">Chọn bản đồ chốt (trước khi mở đăng ký)</span>
                               <select
                                 value={mapSlugDraft[tournament.id] ?? maps[0]?.slug ?? ''}
                                 onChange={(event) =>
                                   setMapSlugDraft((current) => ({ ...current, [tournament.id]: event.target.value }))
                                 }
                                 disabled={maps.length === 0}
                                 className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                               >
                                 {maps.length === 0 ? <option value="">Chưa có bản đồ trên hệ thống</option> : null}
                                 {maps.map((map) => (
                                   <option key={map.slug} value={map.slug}>
                                     {map.displayName ? `${map.displayName} (${map.slug})` : map.slug}
                                     {map.currentVersion !== undefined ? ` · v${map.currentVersion}` : ''}
                                   </option>
                                 ))}
                               </select>
                             </label>
                             <button
                               type="button"
                               disabled={pending !== null || maps.length === 0}
                               onClick={() => void commitMapForTournament(tournament)}
                               className={PRIMARY_BUTTON_CLASS + ' !h-10'}
                             >
                               {pending === `${tournament.id}:commit-map` ? 'Đang chốt…' : 'Chốt bản đồ cam kết'}
                             </button>
                           </div>
                           <p className="text-xs text-[var(--text-secondary)]">
                             {commitment
                               ? `Bản đồ hiện tại đã chốt: ${commitment.displayName} (v${commitment.version}).`
                               : 'Chưa chốt bản đồ. Bản đồ phải được chốt trước khi mở đăng ký thi đấu.'}
                           </p>
                         </>
                       ) : (
                         <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3 text-xs">
                           <p className="text-[var(--text-primary)]">
                             {commitment
                               ? `Bản đồ đã chốt cứng: ${commitment.displayName} (v${commitment.version}). `
                               : 'Giải chưa chốt bản đồ nào. '}
                             <span className="text-[var(--text-secondary)]">
                               Đăng ký đã mở hoặc giải đã qua bước chuẩn bị nên server đã khóa cứng bản đồ — không thể thay đổi nữa.
                             </span>
                           </p>
                         </div>
                       )}
                     </div>

                     {/* Map Pool for Knockout */}
                     <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 flex flex-col gap-3">
                       <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                         Pool bản đồ thi đấu ({poolsByTournament[tournament.id]?.pool?.length ?? 0} bản đồ)
                       </h4>
                       {(() => {
                         const poolView = poolsByTournament[tournament.id];
                         const pool = poolView?.pool ?? [];
                         const candidates = maps.filter((map) => !pool.some((entry) => entry.slug === map.slug));
                         return (
                           <div className="flex flex-col gap-3">
                             {pool.length === 0 ? (
                               <p className="text-xs text-[var(--text-secondary)] italic">Pool bản đồ hiện đang trống.</p>
                             ) : (
                               <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] overflow-hidden">
                                 {pool.map((entry) => (
                                   <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-xs">
                                     <div className="flex flex-wrap items-center gap-2">
                                       <span className="font-mono font-semibold text-[var(--text-primary)]">{entry.slug}</span>
                                       {entry.displayName ? (
                                         <span className="text-[var(--text-secondary)]">· {entry.displayName}</span>
                                       ) : null}
                                       <span className="text-[var(--text-secondary)] font-mono text-[11px]">v{entry.currentVersion}</span>
                                       {entry.visibility !== 'PUBLIC' ? (
                                         <span className="rounded border border-[var(--warning-text)] px-1.5 py-0.5 text-[10px] text-[var(--warning-text)]">
                                           {entry.visibility}
                                         </span>
                                       ) : null}
                                     </div>
                                     {canCommitMap && (
                                       <button
                                         type="button"
                                         disabled={pending !== null}
                                         onClick={() => void removeMapFromPool(tournament, entry.slug)}
                                         className="rounded border border-[var(--danger-text)] px-2 py-0.5 text-[11px] text-[var(--danger-text)] hover:bg-[rgba(239,68,68,0.06)]"
                                       >
                                         {pending === `${tournament.id}:pool-remove:${entry.slug}` ? 'Đang bỏ…' : 'Bỏ khỏi pool'}
                                       </button>
                                     )}
                                   </li>
                                 ))}
                               </ul>
                             )}

                             {poolView && poolView.warnings.length > 0 && (
                               <div role="alert" className="rounded-lg border border-[var(--warning-text)] bg-[rgba(245,165,36,0.06)] p-3 text-xs text-[var(--warning-text)]">
                                 Cảnh báo: Pool có dưới 4 bản đồ — loạt thi đấu knockout yêu cầu ít nhất bốn bản đồ khác nhau.
                               </div>
                             )}

                             {canCommitMap && (
                               <div className="flex flex-wrap items-end gap-2 pt-1">
                                 <select
                                   value={poolSlugDraft[tournament.id] ?? candidates[0]?.slug ?? ''}
                                   onChange={(event) =>
                                     setPoolSlugDraft((current) => ({
                                       ...current,
                                       [tournament.id]: event.target.value,
                                     }))
                                   }
                                   disabled={candidates.length === 0}
                                   className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 text-xs text-[var(--text-primary)]"
                                 >
                                   {candidates.length === 0 ? <option value="">Hết bản đồ để thêm</option> : null}
                                   {candidates.map((map) => (
                                     <option key={map.slug} value={map.slug}>
                                       {map.displayName ? `${map.displayName} (${map.slug})` : map.slug}
                                     </option>
                                   ))}
                                 </select>
                                 <button
                                   type="button"
                                   disabled={pending !== null || candidates.length === 0}
                                   onClick={() => void addMapToPool(tournament)}
                                   className={SECONDARY_BUTTON_CLASS + ' !h-10'}
                                 >
                                   {pending === `${tournament.id}:pool-add` ? 'Đang thêm…' : 'Thêm vào pool'}
                                 </button>
                               </div>
                             )}
                           </div>
                         );
                       })()}
                     </div>

                     {/* Rated/Unrated Policy */}
                     <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                       <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Xếp hạng Global (Elo/Glicko)</h4>
                       <RatedControl tournament={tournament} />
                     </div>
                   </div>
                 </section>

                 {/* Section 3: Teams & Registration */}
                 <section
                   id="entries"
                   className="scroll-mt-14 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm"
                 >
                   <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-3.5">
                     <h3 className="text-sm font-bold text-[var(--text-primary)]">3. Đội tham dự & Xét duyệt đăng ký</h3>
                     <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                       Duyệt hồ sơ đăng ký, quản lý mã mời, thêm đội trực tiếp và danh sách đội tham gia
                     </p>
                   </div>

                   <div className="p-5 flex flex-col gap-6">
                     {authProfile === null && (
                       <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--warning-text)] bg-[rgba(245,165,36,0.06)] px-4 py-3 text-xs text-[var(--warning-text)]">
                         <p className="min-w-0 flex-1">Không tải được chế độ đăng ký. Chưa thể hiển thị xét duyệt hoặc thêm đội trực tiếp.</p>
                         <button type="button" onClick={() => router.refresh()} className={SECONDARY_BUTTON_CLASS}>Thử lại</button>
                       </div>
                     )}

                     {/* Online Registration Review */}
                     {authProfile === 'ONLINE' && (
                       <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 flex flex-col gap-4">
                         <RegistrationReviewPanel tournamentId={tournament.id} state={tournament.state} />
                       </div>
                     )}

                     {/* Online Entry Codes */}
                     {authProfile === 'ONLINE' && ['REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS'].includes(tournament.state) && (
                       <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                         <EntryCodesPanel tournamentId={tournament.id} />
                       </div>
                     )}

                     {/* LAN Direct Enrollment */}
                     {canEnroll && (
                       <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 flex flex-col gap-4">
                         <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Ghi danh trực tiếp (LAN)</h4>
                         <div className="flex flex-wrap items-end gap-3">
                           <label className={`${LABEL_CLASS} min-w-[200px] flex-1 text-xs`}>
                             <span className="text-[var(--text-secondary)]">Thêm một đội trực tiếp (teamId)</span>
                             <input
                               value={enrollDraft[tournament.id] ?? ''}
                               onChange={(event) =>
                                 setEnrollDraft((current) => ({ ...current, [tournament.id]: event.target.value }))
                               }
                               placeholder="team_…"
                               className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                             />
                           </label>
                           <button
                             type="button"
                             disabled={pending !== null}
                             onClick={() => void enrollTeam(tournament)}
                             className={SECONDARY_BUTTON_CLASS + ' !h-10'}
                           >
                             {pending === `${tournament.id}:enroll` ? 'Đang thêm…' : 'Thêm đội'}
                           </button>
                         </div>

                         {/* Bulk Enrollment */}
                         <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-subtle)]">
                           <label className={`${LABEL_CLASS} text-xs`}>
                             <span className="text-[var(--text-secondary)]">Nhập hàng loạt teamId (mỗi dòng một đội)</span>
                             <textarea
                               rows={3}
                               value={bulkDraft[tournament.id] ?? ''}
                               onChange={(event) =>
                                 setBulkDraft((current) => ({ ...current, [tournament.id]: event.target.value }))
                               }
                               placeholder={'team_… \n(hoặc team_id_1, team_id_2, …)'}
                               className="w-full rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                             />
                           </label>
                           <TeamSearchPicker disabled={pending !== null} onSelect={(teamId) => setBulkDraft((current) => {
                             const existing = parseBulkIds(current[tournament.id] ?? '');
                             return { ...current, [tournament.id]: existing.includes(teamId) ? (current[tournament.id] ?? '') : [...existing, teamId].join('\n') };
                           })} />
                           <div className="flex flex-wrap items-center gap-2">
                             <button
                               type="button"
                               disabled={pending !== null}
                               onClick={() => void submitBulkEnroll(tournament, true)}
                               className={SECONDARY_BUTTON_CLASS}
                             >
                               {pending === `${tournament.id}:bulk-preview` ? 'Đang kiểm…' : 'Xem trước'}
                             </button>
                             <button
                               type="button"
                               disabled={pending !== null}
                               onClick={() => void submitBulkEnroll(tournament, false)}
                               className={PRIMARY_BUTTON_CLASS + ' !h-9'}
                             >
                               {pending === `${tournament.id}:bulk-commit` ? 'Đang thêm…' : 'Thêm các đội hợp lệ'}
                             </button>
                           </div>
                           {bulkReport[tournament.id] && (
                             <p className="text-xs text-[var(--text-secondary)]">{bulkSummary(bulkReport[tournament.id]!)}</p>
                           )}
                         </div>
                       </div>
                     )}

                     {/* Team Withdrawal */}
                     {WITHDRAWABLE_STATES.includes(tournament.state) && (
                       <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 flex flex-col gap-3">
                         <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Rút đội khỏi giải</h4>
                         <div className="flex flex-wrap items-end gap-3">
                           <label className={`${LABEL_CLASS} min-w-[200px] flex-1 text-xs`}>
                             <span className="text-[var(--text-secondary)]">Nhập teamId cần rút</span>
                             <input
                               value={withdrawDraft[tournament.id] ?? ''}
                               onChange={(event) =>
                                 setWithdrawDraft((current) => ({ ...current, [tournament.id]: event.target.value }))
                               }
                               placeholder="team_…"
                               className="h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)]"
                             />
                           </label>
                           <button
                             type="button"
                             disabled={pending !== null}
                             onClick={() => void withdrawTeam(tournament)}
                             className="h-10 rounded-lg border border-[var(--danger-text)] px-4 text-xs font-semibold text-[var(--danger-text)] hover:bg-[rgba(239,68,68,0.06)] disabled:opacity-60 transition-colors"
                           >
                             {pending === `${tournament.id}:withdraw` ? 'Đang rút…' : 'Rút đội'}
                           </button>
                         </div>
                         <p className="text-[11px] text-[var(--text-secondary)]">
                           Trước khi bắt đầu: chỉ xóa khỏi danh sách. Khi giải đang chạy: các ván chưa đấu sẽ được xử walkover.
                         </p>
                       </div>
                     )}

                     {/* Current Enrolled Teams */}
                     <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                       <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-3">Danh sách đội trong giải</h4>
                       <TournamentRatingProvider tournamentId={tournament.id}>
                         <EntriesList entries={entriesByTournament[tournament.id]} state={tournament.state} />
                       </TournamentRatingProvider>
                     </div>
                   </div>
                 </section>

                 {/* Section 4: Adjudication & Disputes */}
                 <section
                   id="adjudication"
                   className="scroll-mt-14 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm"
                 >
                   <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-3.5">
                     <h3 className="text-sm font-bold text-[var(--text-primary)]">4. Kết quả & Kháng nghị</h3>
                     <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                       Xử lý khiếu nại thí sinh, điều chỉnh kết quả trận đấu và phê duyệt công bố Rating sau giải
                     </p>
                   </div>

                   <div className="p-5 flex flex-col gap-6">
                     {ADJUDICABLE_STATES[tournament.state] === true ? (
                       <>
                         <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                           <TournamentAdjudication tournamentId={tournament.id} state={tournament.state} />
                         </div>
                         <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                           <TournamentRatingProvider tournamentId={tournament.id}>
                             <RatingReviewPanel tournament={tournament} />
                           </TournamentRatingProvider>
                         </div>
                       </>
                     ) : tournament.state === 'ARCHIVED' ? (
                       <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                         <TournamentRatingProvider tournamentId={tournament.id}>
                           <RatingReviewPanel tournament={tournament} />
                         </TournamentRatingProvider>
                       </div>
                     ) : (
                       <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-6 text-center text-xs text-[var(--text-secondary)]">
                         <p className="font-semibold text-[var(--text-primary)]">Chưa mở xử lý kết quả & kháng nghị</p>
                         <p className="mt-1">
                           Khu vực này sẽ khả dụng sau khi giải đấu bắt đầu (từ trạng thái RUNNING). Hiện tại giải đang ở trạng thái{' '}
                           <strong className="text-[var(--text-primary)]">{stateLabel[tournament.state] ?? tournament.state}</strong>.
                         </p>
                       </div>
                     )}
                   </div>
                 </section>

                 {/* Section 5: Starter Bots */}
                 <section
                   id="starter-bots"
                   className="scroll-mt-14 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm"
                 >
                   <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-3.5">
                     <h3 className="text-sm font-bold text-[var(--text-primary)]">5. Thư viện Bot mẫu cho thí sinh</h3>
                     <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                       Tải lên gói mã nguồn bot mẫu định dạng ZIP (Python, TypeScript, C++20) và quản lý thư viện bot
                     </p>
                   </div>

                   <div className="p-5">
                     <StarterBotsPanel />
                   </div>
                 </section>
               </div>
             );
           })
         )}
       </div>
       ) : null}
    </div>
  );
}
