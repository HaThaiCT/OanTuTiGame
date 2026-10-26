'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cancelTournamentRegistration, fetchAuthMe, joinTournamentWithCode, listTournamentEntries, listTournamentRegistrations, onlineTeams, probeAuthProfile, requestTournamentRegistration, type AuthMe, type AuthProfile, type TeamDto, type TournamentEntry, type TournamentRegistration } from '../../../lib/api';
import { registrationActions, registrationErrorText, registrationStatusLabel } from '../../../lib/tournament-registration';
import { entryStatusLabel } from '../../../lib/labels';
import { tournamentCreateTeamHref } from '../../../lib/navigation';

const INPUT_CLASS = 'h-12 w-full min-w-0 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3.5 text-base text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]';
const BUTTON_CLASS = 'min-h-12 rounded-md bg-[var(--action)] px-5 py-2.5 text-base font-semibold text-[var(--action-text)] disabled:opacity-60 cursor-pointer';

interface RegistrationContext {
  readonly session: AuthMe | null;
  readonly profile: AuthProfile | null;
  readonly teams: readonly TeamDto[];
  readonly registrations: readonly TournamentRegistration[];
  readonly entries: readonly TournamentEntry[];
  readonly error: string | null;
}

async function loadRegistrationContext(tournamentId: string): Promise<RegistrationContext> {
  const auth = await fetchAuthMe();
  const empty = { teams: [], registrations: [], entries: [] };
  if (!auth.ok || !auth.data) {
    const profile = auth.status === 401 ? await probeAuthProfile() : null;
    return { ...empty, session: null, profile, error: auth.status === 401 && profile !== null ? null : auth.status === 401 ? 'Không tải được hồ sơ máy chủ. Vui lòng tải lại trước khi đăng ký.' : registrationErrorText(auth) };
  }
  const session = auth.data;
  if (session.authProfile !== 'ONLINE' || session.user.role !== 'STUDENT' || session.scope !== 'FULL') {
    return { ...empty, session, profile: session.authProfile, error: null };
  }
  const [teams, registrations, entries] = await Promise.all([onlineTeams.list(), listTournamentRegistrations(tournamentId), listTournamentEntries(tournamentId)]);
  if (!teams.ok || !teams.data) return { ...empty, session, profile: session.authProfile, error: registrationErrorText(teams) };
  if (!registrations.ok || !registrations.data) return { ...empty, session, profile: session.authProfile, error: registrationErrorText(registrations) };
  if (entries === null) return { ...empty, session, profile: session.authProfile, error: 'Không tải được thông tin ghi danh. Vui lòng tải lại trước khi thao tác.' };
  const ownRegistrations = registrations.data.registrations;
  return { session, profile: session.authProfile, teams: teams.data.teams.filter(team => team.tournamentId === tournamentId || ownRegistrations.some(registration => registration.teamId === team.id) || entries.some(entry => entry.teamId === team.id)), registrations: ownRegistrations, entries, error: null };
}

export default function TournamentRegistrationPanel({ tournamentId, state, registrationClosesAt = null, teamId: fixedTeamId }: {
  readonly tournamentId: string;
  readonly state: string;
  readonly registrationClosesAt?: string | null;
  readonly teamId?: string;
}) {
  const router = useRouter();
  const [context, setContext] = useState<RegistrationContext | null>(null);
  const [teamId, setTeamId] = useState(fixedTeamId ?? '');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'request' | 'code' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<{ readonly kind: 'success' | 'error'; readonly text: string } | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadRegistrationContext(tournamentId);
      setContext(next);
      setTeamId(current => fixedTeamId ?? (next.teams.some(team => team.id === current) ? current : next.teams[0]?.id ?? ''));
    } finally { setLoading(false); }
  }, [tournamentId, fixedTeamId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setNow(Date.now());
    const remaining = registrationClosesAt ? Date.parse(registrationClosesAt) - Date.now() : 0;
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(remaining + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [registrationClosesAt]);

  const session = context?.session;
  const team = context?.teams.find(item => item.id === teamId);
  const registration = context?.registrations.find(item => item.teamId === teamId) ?? null;
  const entry = context?.entries.find(item => item.teamId === teamId) ?? null;
  const actions = team && session ? registrationActions({ tournamentId, userId: session.user.id, team, state, registrationClosesAt, registration, entry }, now ?? Date.now()) : { canRequest: false, canCancel: false, canSubmit: false };
  const disabled = loading || pending !== null || Boolean(context?.error);
  const open = state === 'REGISTRATION_OPEN' && (registrationClosesAt === null || (now !== null && Date.parse(registrationClosesAt) > now));
  const teamBase = `/workspace/tournaments/${encodeURIComponent(tournamentId)}/teams/${encodeURIComponent(teamId)}`;
  const createTeamHref = tournamentCreateTeamHref(tournamentId);

  async function request(usingCode = false) {
    if (!team || !actions.canRequest || disabled) return;
    if (usingCode && code.trim() === '') { setNotice({ kind: 'error', text: 'Nhập mã do ban tổ chức cung cấp.' }); return; }
    if (!window.confirm(`Gửi đăng ký cho đội “${team.name}”? Ban tổ chức sẽ xét duyệt; gửi yêu cầu chưa đồng nghĩa với được tham dự hoặc nộp bài.`)) return;
    setPending(usingCode ? 'code' : 'request');
    try {
      const result = usingCode ? await joinTournamentWithCode(tournamentId, { teamId, code: code.trim() }) : await requestTournamentRegistration(tournamentId, { teamId });
      setNotice(result.ok ? { kind: 'success', text: 'Đã gửi đăng ký. Đội đang chờ ban tổ chức duyệt; chưa được nộp bài thi đấu.' } : { kind: 'error', text: registrationErrorText(result) });
      if (result.ok) setCode('');
      await refresh();
      router.refresh();
    } finally { setPending(null); }
  }

  async function cancel() {
    if (!team || !registration || !actions.canCancel || disabled) return;
    const consequence = registration.status === 'APPROVED' ? 'Đội sẽ mất suất tham dự và không thể nộp bài thi đấu; lịch sử bài nộp vẫn được giữ.' : 'Yêu cầu đang chờ sẽ được rút khỏi hàng đợi xét duyệt.';
    const reapply = team.tournamentId === tournamentId ? 'Có thể gửi lại khi giải còn mở đăng ký.' : 'Đội ghi danh trực tiếp không thể tự gửi lại; liên hệ ban tổ chức nếu muốn tham dự lại.';
    if (!window.confirm(`Hủy đăng ký của đội “${team.name}”? ${consequence} ${reapply}`)) return;
    setPending('cancel');
    try {
      const result = await cancelTournamentRegistration(tournamentId, registration.id, { expectedVersion: registration.version });
      setNotice(result.ok ? { kind: 'success', text: team.tournamentId === tournamentId ? 'Đã hủy đăng ký. Bạn có thể gửi đăng ký lại trước khi hết hạn; bài nộp và lịch sử cũ được giữ nguyên.' : 'Đã hủy đăng ký. Bài nộp và lịch sử cũ được giữ nguyên; liên hệ ban tổ chức nếu muốn tham dự lại.' } : { kind: 'error', text: registrationErrorText(result) });
      await refresh();
      router.refresh();
    } finally { setPending(null); }
  }

  return (
    <section aria-label="Đăng ký tham dự giải" aria-busy={loading || pending !== null} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Đăng ký tham dự giải</h2>
        <button type="button" disabled={loading || pending !== null} onClick={() => { void refresh(); router.refresh(); }} className="min-h-11 rounded-md border border-[var(--border-control)] px-4 py-2 text-sm font-medium disabled:opacity-60">Tải lại trạng thái</button>
      </div>
      {loading && !context ? <p role="status" className="mt-3 text-sm">Đang tải đăng ký của bạn…</p> : null}
      {context?.error ? <p role="alert" className="mt-3 text-sm text-[var(--danger-text)]">{context.error} <Link href="/workspace" className="underline">Mở không gian đội</Link></p> : null}
      {context?.profile === 'LAN_OFFLINE' ? <p className="mt-3 text-sm text-[var(--text-secondary)]">Hệ thống LAN: ADMIN ghi danh trực tiếp cho đội. Sinh viên không tự gửi yêu cầu; liên hệ ban tổ chức để được thêm hoặc rút đội. <Link href="/workspace" className="underline">Đăng nhập / Không gian đội →</Link></p> : null}
      {context && !session && context.profile !== 'LAN_OFFLINE' ? <p className="mt-3 text-sm">Đăng nhập bằng tài khoản sinh viên đã xác minh email để xem đội, gửi đăng ký và theo dõi xét duyệt. <Link href={`/workspace?returnTo=${encodeURIComponent(`/tournaments/${tournamentId}?tab=registration`)}`} className="font-medium text-[var(--action)] underline">Đăng nhập →</Link></p> : null}
      {session?.scope === 'PASSWORD_CHANGE_ONLY' ? <p className="mt-3 text-sm">Bạn cần đổi mật khẩu trước khi đăng ký. <Link href="/workspace" className="underline">Đổi mật khẩu →</Link></p> : null}
      {session?.user.role === 'ADMIN' && context?.profile === 'ONLINE' ? <p className="mt-3 text-sm">Đội trưởng gửi yêu cầu; ADMIN xét duyệt trong trang quản lý giải. <Link href={`/organizer/tournaments/${encodeURIComponent(tournamentId)}`} className="underline">Quản lý đăng ký →</Link></p> : null}
      {session?.user.role === 'STUDENT' && session.scope === 'FULL' && context?.profile === 'ONLINE' && !context.error ? <div className="mt-3 flex flex-col gap-4">
        <p className="text-sm text-[var(--text-secondary)]">Đội trưởng gửi đăng ký không cần mã và có thể hủy trước khi hết hạn. Chỉ đội được ban tổ chức duyệt mới được nộp bài thi đấu. Thành viên chỉ xem trạng thái.</p>
        {registrationClosesAt ? <p className="text-sm text-[var(--text-secondary)]">Hạn đăng ký: <time dateTime={registrationClosesAt}>{registrationClosesAt.slice(0, 16).replace('T', ' ')} UTC</time></p> : null}
        {!open ? <p role="status" className="text-sm text-[var(--warning-text)]">Giải chưa mở hoặc đã đóng đăng ký. Bạn vẫn có thể xem trạng thái và lý do xét duyệt của đội.</p> : null}
        {context.teams.length === 0 ? context.registrations.length === 0 ? open ? <p className="text-sm">Bạn chưa có đội thuộc giải này. <Link href={createTeamHref} className="font-medium text-[var(--action)] underline">Tạo đội trong không gian đội →</Link> hoặc nhận lời mời từ đội trưởng.</p> : <p className="text-sm text-[var(--text-secondary)]">Giải đã đóng đăng ký nên không thể tạo đội mới. Nhận lời mời từ đội trưởng hoặc liên hệ ban tổ chức nếu cần hỗ trợ.</p> : null : <>
          {!fixedTeamId ? <label className="flex max-w-xl flex-col gap-2 text-sm"><span>Đội của bạn trong giải này</span><select value={teamId} disabled={disabled} onChange={event => { setTeamId(event.target.value); setNotice(null); }} className={INPUT_CLASS}>{context.teams.map(item => <option key={item.id} value={item.id}>{item.name} · {item.captainUserId === session.user.id ? 'Đội trưởng' : 'Thành viên'}{item.closedAt ? ' · Đã đóng' : ''}</option>)}</select></label> : null}
          {team ? <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4">
            <p className="font-medium">{team.name} · {team.captainUserId === session.user.id ? 'Bạn là đội trưởng' : 'Bạn là thành viên — chỉ xem đăng ký'}</p>
            <p role="status" className="text-sm font-semibold">{registration ? registrationStatusLabel[registration.status] : entry ? 'Đội đã được ban tổ chức ghi danh trực tiếp' : 'Chưa gửi đăng ký'}</p>
            {entry && entry.status !== 'ELIGIBLE' ? <p role="status" className="text-sm text-[var(--warning-text)]">Trạng thái tham dự: {entryStatusLabel[entry.status] ?? entry.status}. Đội chưa có quyền nộp bài thi đấu.</p> : null}
            {registration ? <p className="text-xs text-[var(--text-secondary)]">Gửi lúc <time dateTime={registration.requestedAt}>{registration.requestedAt.slice(0, 16).replace('T', ' ')} UTC</time>{registration.reviewedAt ? <> · Xét duyệt lúc <time dateTime={registration.reviewedAt}>{registration.reviewedAt.slice(0, 16).replace('T', ' ')} UTC</time></> : null}</p> : null}
            {registration?.reason ? <div className="text-sm"><p className="font-medium">Lý do của ban tổ chức (riêng tư với đội và ADMIN)</p><p className="mt-1 whitespace-pre-wrap break-words">{registration.reason}</p></div> : null}
            {registration?.status === 'PENDING' ? <p className="text-sm text-[var(--text-secondary)]">Yêu cầu đang chờ duyệt; đội chưa có quyền nộp bài thi đấu.</p> : null}
            {team.closedAt ? <p className="text-sm text-[var(--warning-text)]">Đội đã đóng; không thể gửi hoặc hủy đăng ký.</p> : null}
            {team.tournamentId !== tournamentId && registration?.status === 'CANCELLED' ? <p className="text-sm text-[var(--text-secondary)]">Đội này được ghi danh trực tiếp trước đây. Không thể tự gửi lại đăng ký; liên hệ ban tổ chức để được hướng dẫn.</p> : null}
            {team.tournamentId === tournamentId && team.captainUserId === session.user.id && registration && (registration.status === 'CANCELLED' || registration.status === 'REJECTED') && !registration.canRequest && open ? <p className="text-sm text-[var(--text-secondary)]">Hiện chưa thể gửi đăng ký lại. Kiểm tra danh sách đội hoặc liên hệ ban tổ chức để biết điều kiện tham dự.</p> : null}
            <div className="flex flex-wrap items-center gap-3">
              {actions.canRequest ? <button type="button" disabled={disabled} onClick={() => void request()} className={BUTTON_CLASS}>{pending === 'request' ? 'Đang gửi…' : registration ? 'Gửi đăng ký lại' : 'Gửi đăng ký'}</button> : null}
              {actions.canCancel ? <button type="button" disabled={disabled} onClick={() => void cancel()} className="min-h-12 rounded-md border border-[var(--danger-text)] px-5 py-2.5 text-base font-medium text-[var(--danger-text)] disabled:opacity-60 cursor-pointer">{pending === 'cancel' ? 'Đang hủy…' : 'Hủy đăng ký'}</button> : null}
              <Link href={teamBase} className="text-sm text-[var(--action)] underline">Trang đội / theo dõi đăng ký →</Link>
              {actions.canSubmit ? <Link href={`${teamBase}?tab=submission`} className="text-sm font-semibold text-[var(--action)] underline">Bài nộp thi đấu →</Link> : null}
            </div>
            {actions.canRequest ? <details className="text-sm"><summary className="min-h-8 cursor-pointer text-[var(--text-secondary)]">Có mã từ ban tổ chức? (tùy chọn)</summary><p className="mt-2 text-[var(--text-secondary)]">Mã chỉ gửi yêu cầu vào cùng hàng đợi xét duyệt, không tự động ghi danh hay bỏ qua ADMIN.</p><form onSubmit={event => { event.preventDefault(); void request(true); }} className="mt-3 flex flex-wrap items-end gap-3"><label className="flex min-w-0 flex-1 flex-col gap-2"><span>Mã đăng ký của ban tổ chức</span><input value={code} onChange={event => setCode(event.target.value)} required disabled={disabled} autoCapitalize="characters" className={INPUT_CLASS} /></label><button type="submit" disabled={disabled || code.trim() === ''} className={BUTTON_CLASS}>{pending === 'code' ? 'Đang gửi…' : 'Gửi yêu cầu bằng mã'}</button></form></details> : null}
          </div> : <p role="alert" className="text-sm">Đội này không còn trong danh sách đội của bạn ở giải. <Link href="/workspace" className="underline">Quay lại không gian đội</Link></p>}
        </>}
        {context.registrations.filter(item => (!fixedTeamId || item.teamId === fixedTeamId) && !context.teams.some(team => team.id === item.teamId)).map(item => <article key={item.id} className="rounded-lg border border-[var(--border-subtle)] p-4"><h3 className="font-medium">{item.teamName}</h3><p role="status" className="mt-2 text-sm">{registrationStatusLabel[item.status]}</p>{item.reason ? <p className="mt-2 whitespace-pre-wrap break-words text-sm">Lý do riêng tư từ ban tổ chức: {item.reason}</p> : null}<p className="mt-2 text-sm text-[var(--text-secondary)]">Đội hiện không nằm trong danh sách đội hoạt động của bạn; đăng ký này chỉ xem. Liên hệ ban tổ chức nếu cần hỗ trợ.</p></article>)}
        <Link href="/workspace" className="self-start text-sm text-[var(--action)] underline">Quản lý đội và tài khoản →</Link>
      </div> : null}
      {notice ? <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`mt-4 rounded-md border px-3 py-2 text-sm ${notice.kind === 'error' ? 'border-[var(--danger-text)] text-[var(--danger-text)]' : 'border-[var(--success-text)] text-[var(--success-text)]'}`}>{notice.text}</p> : null}
    </section>
  );
}
