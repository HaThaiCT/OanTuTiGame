'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiRequest, type ApiResult } from '../../lib/client';
import { fetchAuthMe, listTournamentRegistrations, onlineTeams, probeAuthProfile, type AuthProfile, type TeamDto, type TeamInvitationDto, type TournamentRegistration } from '../../lib/api';
import { registrationErrorText, registrationStatusLabel } from '../../lib/tournament-registration';
import { stateLabel } from '../../lib/labels';
import FirstPasswordChange from './FirstPasswordChange';
import { TeamRatingName } from '../_components/TeamRatingName';
import UetLogo from '../_components/UetLogo';
import { TournamentRatingProvider } from '../_components/TournamentRatingContext';

interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

interface MyEntry {
  entryId: string;
  teamId: string;
  teamName: string;
  status: string;
  seedOrdinal: number | null;
}

interface BoardedTournament {
  id: string;
  name: string;
  state: string;
  registrationClosesAt: string | null;
  myTeams: { teamId: string; teamName: string; entry: MyEntry | null; registration: TournamentRegistration | null }[];
}


export default function WorkspacePage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  /** Session scope from `/auth/me`: `PASSWORD_CHANGE_ONLY` still owes the first password change. */
  const [scope, setScope] = useState<string | null>(null);
  const [boarded, setBoarded] = useState<BoardedTournament[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [boardRevision, setBoardRevision] = useState(0);
  /**
   * Active authentication profile. `null` = not established yet: `/auth/me` answers 401 without a
   * session, so the signed-out screen stays without self-service links until the API reports ONLINE.
   */
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(null);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitationDto[]>([]);
  const [teamName, setTeamName] = useState('');
  const [tournamentId, setTournamentId] = useState('');
  const [availableTournaments, setAvailableTournaments] = useState<{ id: string; name: string }[]>([]);
  const [inviteUsername, setInviteUsername] = useState<Record<string, string>>({});
  const [sentInvitations, setSentInvitations] = useState<TeamInvitationDto[]>([]);
  /**
   * Reads the current session (user + team memberships) and the deployment's authentication profile.
   * The profile comes from the same response, so no extra request is needed while signed in.
   */
  async function refreshSession() {
    const result = await fetchAuthMe();
    if (!result.ok || !result.data) {
      setUser(null);
      setTeamIds([]);
      setScope(null);
      setTeams([]);
      setInvitations([]);
      setSentInvitations([]);
      setBoarded([]);
      if (result.status !== 401) setError(registrationErrorText(result));
      if (result.status === 401) setAuthProfile(await probeAuthProfile());
      // The header lives in the layout and stays mounted across sign-out; tell it to re-read.
      window.dispatchEvent(new Event('oantuti:session-changed'));
      return;
    }
    setUser({
      id: result.data.user.id,
      username: result.data.user.username,
      displayName: result.data.user.displayName,
      role: result.data.user.role,
    });
    setTeamIds(result.data.teamIds);
    setScope(result.data.scope);
    setAuthProfile(result.data.authProfile);
    window.dispatchEvent(new Event('oantuti:session-changed'));
  }

  useEffect(() => {
    void refreshSession();
  }, []);

  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get('tournament');
    if (selected) setTournamentId(selected);
  }, []);

  useEffect(() => {
    if (authProfile !== 'ONLINE' || !user || scope !== 'FULL' || user.role !== 'STUDENT') { setAvailableTournaments([]); return; }
    let cancelled = false;
    void apiRequest<{ tournaments?: Record<string, unknown>[] }>('/api/v2/tournaments').then(result => {
      if (cancelled) return;
      if (!result.ok) { setError('Không tải được danh sách giải mở.'); setAvailableTournaments([]); return; }
      setAvailableTournaments((result.data?.tournaments ?? []).filter(row => row.state === 'REGISTRATION_OPEN').map(row => ({ id: String(row.id ?? ''), name: String(row.name ?? '') })).filter(row => row.id));
    });
    return () => { cancelled = true; };
  }, [authProfile, user, scope]);

  useEffect(() => { if (authProfile === 'ONLINE' && user && scope === 'FULL' && user.role === 'STUDENT') void refreshOnlineTeams(); }, [authProfile, user, scope]);

  useEffect(() => {
    if (!user || scope !== 'FULL' || user.role !== 'STUDENT' || (authProfile !== 'ONLINE' && teamIds.length === 0)) {
      setBoarded([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const list = await apiRequest<{ tournaments?: Record<string, unknown>[] }>('/api/v2/tournaments');
      if (cancelled) return;
      if (!list.ok) {
        setError('Không tải được danh sách giải. Vui lòng thử lại.');
        setLoading(false);
        return;
      }
      const rows = Array.isArray(list.data?.tournaments) ? list.data.tournaments : [];
      const relevant = rows
        .map((row) => ({
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          state: String(row.state ?? ''),
          registrationClosesAt: typeof (row.registrationClosesAt ?? row.registration_closes_at) === 'string' ? String(row.registrationClosesAt ?? row.registration_closes_at) : null,
        }))
        .filter((row) => row.id !== '');

      const mine: BoardedTournament[] = [];
      for (const tournament of relevant) {
        const [entries, registrations] = await Promise.all([
          apiRequest<{ entries?: Record<string, unknown>[] }>(`/api/v2/tournaments/${encodeURIComponent(tournament.id)}/entries`),
          authProfile === 'ONLINE' ? listTournamentRegistrations(tournament.id) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (!entries.ok) {
          setError(`Không tải được đầy đủ danh sách giải của đội. ${registrationErrorText(entries)}`);
          setLoading(false);
          return;
        }
        if (registrations && (!registrations.ok || !registrations.data)) {
          setError(`Không tải được đăng ký của đội: ${registrationErrorText(registrations)}`);
          setLoading(false);
          return;
        }
        const rawEntries = Array.isArray(entries.data?.entries) ? entries.data.entries : [];
        const myEntries = rawEntries
          .map((row) => ({
            entryId: String(row.id ?? ''),
            teamId: String(row.teamId ?? row.team_id ?? ''),
            teamName: String(row.teamName ?? row.team_name ?? 'Đội chưa đặt tên'),
            status: String(row.status ?? ''),
            seedOrdinal: typeof row.seedOrdinal === 'number' ? row.seedOrdinal : null,
          }))
          .filter((entry) => teamIds.includes(entry.teamId));
        const myRegistrations = registrations?.data?.registrations ?? [];
        const myTeams = new Map<string, BoardedTournament['myTeams'][number]>();
        for (const team of teams.filter(item => item.tournamentId === tournament.id && !item.closedAt)) {
          myTeams.set(team.id, { teamId: team.id, teamName: team.name, entry: null, registration: null });
        }
        for (const entry of myEntries) myTeams.set(entry.teamId, { ...myTeams.get(entry.teamId), teamId: entry.teamId, teamName: entry.teamName, entry, registration: null });
        for (const registration of myRegistrations) {
          const current = myTeams.get(registration.teamId);
          myTeams.set(registration.teamId, { teamId: registration.teamId, teamName: registration.teamName, entry: current?.entry ?? null, registration });
        }
        if (myTeams.size > 0) mine.push({ ...tournament, myTeams: [...myTeams.values()] });
      }
      if (!cancelled) { setBoarded(mine); setLoading(false); }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, teamIds, scope, authProfile, teams, boardRevision]);

  async function refreshOnlineTeams() {
    const [teamResult, invitationResult] = await Promise.all([onlineTeams.list(), onlineTeams.invitations()]);
    if (!teamResult.ok || !teamResult.data) {
      setTeams([]);
      setError(`Không tải được đội. ${registrationErrorText(teamResult)}`);
    } else setTeams(teamResult.data.teams);
    if (!invitationResult.ok || !invitationResult.data) {
      setInvitations([]);
      setSentInvitations([]);
      setInvitationError(`Không tải được lời mời. ${registrationErrorText(invitationResult)}`);
    } else {
      setInvitations(invitationResult.data.invitations.filter(invitation => invitation.recipientUserId === user?.id));
      setSentInvitations(invitationResult.data.invitations.filter(invitation => invitation.recipientUserId !== user?.id));
      setInvitationError(null);
    }
  }
  async function runTeamAction(action: () => Promise<ApiResult<unknown>>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      await refreshOnlineTeams();
      await refreshSession();
      setBoardRevision(current => current + 1);
      if (!result.ok) setError(registrationErrorText(result));
    } finally { setBusy(false); }
  }

  async function refreshWorkspace() {
    setBusy(true);
    setError(null);
    try { await refreshSession(); setBoardRevision(current => current + 1); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/v2/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
      });
      const payload = await response.json() as { user?: SessionUser; message?: string };
      if (!response.ok) {
        setError(payload.message ?? 'Đăng nhập thất bại.');
        return;
      }
      setUser(payload.user ?? null);
      await refreshSession();
    } catch {
      setError('Lỗi mạng khi đăng nhập.');
    } finally {
      setBusy(false);
    }
  }

  // An admin-issued credential signs in with a limited session: the API allows only the password
  // change (and sign-out) until it succeeds. Anything else here would answer 403 PASSWORD_CHANGE_REQUIRED.
  if (user && scope === 'PASSWORD_CHANGE_ONLY') {
    return <FirstPasswordChange username={user.username} onChanged={refreshSession} />;
  }

  if (user) {
    if (user.role === 'ADMIN') {
      return (
        <section className="flex flex-col gap-4 border border-[var(--border-subtle)] bg-[var(--surface)] p-6 rounded-2xl shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            Ban tổ chức
          </h1>
          <p className="text-xs text-[var(--text-secondary)]">
            Quản lý giải đấu, tài khoản và bản đồ thi đấu.
          </p>
          <Link href="/organizer" className="vct-btn-primary self-start !py-2 !px-4 !text-xs !rounded-full mt-2">
            Vào trang quản trị →
          </Link>
        </section>
      );
    }
    return (
      <section className="flex flex-col gap-6">
        <div className="border-b border-[var(--border-subtle)] pb-4">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            Không gian đội
          </h1>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Quản lý bài nộp bot và theo dõi các giải đấu đang tham gia
          </p>
        </div>

        {authProfile === 'ONLINE' && user.role === 'STUDENT' && scope === 'FULL' ? (
          <Link href="/workspace/join" className="vct-btn-secondary self-start !py-1.5 !px-3.5 !text-xs !rounded-full">
            Đăng ký và theo dõi tham dự giải →
          </Link>
        ) : null}
        <button type="button" disabled={busy || loading} onClick={() => void refreshWorkspace()} className="vct-btn-secondary self-start disabled:opacity-60">Tải lại đội và trạng thái đăng ký</button>
        {authProfile === 'LAN_OFFLINE' ? <p className="text-sm text-[var(--text-secondary)]">Hệ thống LAN: ADMIN ghi danh trực tiếp cho đội. Liên hệ ban tổ chức để thêm hoặc rút đội khỏi giải.</p> : null}
        {authProfile === 'ONLINE' && user.role === 'STUDENT' && scope === 'FULL' ? <Link className="vct-btn-secondary self-start" href="/account">Quản lý tài khoản</Link> : null}
        {authProfile === 'ONLINE' && user.role === 'STUDENT' && scope === 'FULL' ? (
          <section id="create-team" className="scroll-mt-24 flex flex-col gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
            <h2 className="text-lg font-semibold">Tài khoản và đội</h2>
            <p className="text-sm text-[var(--text-secondary)]">Tạo đội cho đúng giải, mời thành viên rồi gửi đăng ký để ADMIN xét duyệt. Tạo đội chưa phải là ghi danh thi đấu.</p>
            <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void runTeamAction(async () => { const result = await onlineTeams.create({ tournamentId, name: teamName }); if (result.ok) { setTeamName(''); setTournamentId(''); } return result; }); }}>
              <label className="flex flex-col gap-2 text-sm"><span>Tên đội mới</span><input required minLength={2} maxLength={50} value={teamName} onChange={(event) => setTeamName(event.target.value)} className="min-h-11 rounded border border-[var(--border-control)] bg-[var(--canvas)] p-2" /></label>
              <label className="flex flex-col gap-2 text-sm"><span>Giải đấu của đội</span><select required value={tournamentId} onChange={(event) => setTournamentId(event.target.value)} className="min-h-11 rounded border border-[var(--border-control)] bg-[var(--canvas)] p-2"><option value="">Chọn giải đang mở</option>{availableTournaments.map(tournament => <option key={tournament.id} value={tournament.id}>{tournament.name}</option>)}</select></label>
              <button disabled={busy || !tournamentId || availableTournaments.length === 0} className="vct-btn-primary">Tạo đội</button>
            </form>
            {availableTournaments.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">Chưa có giải đang mở để tạo đội. <Link href="/tournaments" className="underline">Xem các giải đấu →</Link></p> : null}
            <h3 className="font-semibold">Lời mời</h3>
            {invitationError ? <p role="alert" className="text-sm text-[var(--danger-text)]">{invitationError} <button type="button" disabled={busy} onClick={() => { setBusy(true); void refreshOnlineTeams().finally(() => setBusy(false)); }} className="underline">Tải lại lời mời</button></p> : null}
            {invitations.filter((invitation) => invitation.status === 'PENDING' && invitation.recipientUserId === user.id).map((invitation) => <div key={invitation.id} className="flex flex-wrap items-center gap-2"><span>{invitation.teamName} · hết hạn {invitation.expiresAt}</span><button disabled={busy} onClick={() => void runTeamAction(() => onlineTeams.respond(invitation.id, 'ACCEPT'))}>Chấp nhận</button><button disabled={busy} onClick={() => void runTeamAction(() => onlineTeams.respond(invitation.id, 'DECLINE'))}>Từ chối</button></div>)}
            {teams.map((team) => <article key={team.id} className="flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-3"><h3 className="font-semibold">{team.name}{team.closedAt ? ' · Đã đóng' : ''}{team.rosterLocked ? ' · Danh sách khóa' : ''}</h3><p className="text-xs">{team.captainUserId === user.id ? 'Bạn là đội trưởng' : 'Bạn là thành viên; đăng ký tham dự ở chế độ chỉ xem'} · {team.rosterLocked ? 'Danh sách ghi danh đã khóa; không thể thay đổi thành viên.' : 'Danh sách có thể chỉnh sửa khi giải cho phép.'}</p>
              {team.tournamentId ? <nav aria-label={`Đăng ký của đội ${team.name}`} className="flex flex-wrap gap-3 text-sm text-[var(--action)]"><Link href={`/workspace/tournaments/${encodeURIComponent(team.tournamentId)}/teams/${encodeURIComponent(team.id)}#registration`} className="underline">Đăng ký / trạng thái của đội →</Link><Link href={`/tournaments/${encodeURIComponent(team.tournamentId)}#registration`} className="underline">Trang giải →</Link></nav> : null}
              {!team.closedAt && !team.rosterLocked && team.captainUserId === user.id && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); const username = inviteUsername[team.id] ?? ''; void runTeamAction(async () => { const result = await onlineTeams.invite(team.id, username); const invitation = result.ok ? result.data : null; if (invitation) { setInviteUsername({ ...inviteUsername, [team.id]: '' }); setSentInvitations(current => [...current.filter(item => item.id !== invitation.id), invitation]); } return result; }); }}><label className="flex flex-col gap-1 text-sm"><span>Tên đăng nhập thành viên mời vào {team.name}</span><input required value={inviteUsername[team.id] ?? ''} onChange={(event) => setInviteUsername({ ...inviteUsername, [team.id]: event.target.value })} className="min-h-11 rounded border border-[var(--border-control)] bg-[var(--canvas)] p-2" /></label><button type="submit" disabled={busy} className="min-h-11 rounded border border-[var(--border-control)] px-3 disabled:opacity-60">Mời thành viên</button></form>}
              {team.members?.map((member) => <div key={member.userId} className="flex flex-wrap gap-2"><span>{member.displayName} · {member.role}</span>{team.captainUserId === user?.id && member.role !== 'CAPTAIN' && !team.rosterLocked && <><button disabled={busy} onClick={() => { if (window.confirm(`Chuyển quyền trưởng đội cho ${member.displayName}?`)) void runTeamAction(() => onlineTeams.captain(team.id, member.userId)); }}>Chuyển trưởng đội</button><button disabled={busy} onClick={() => { if (window.confirm(`Xóa ${member.displayName} khỏi đội?`)) void runTeamAction(() => onlineTeams.remove(team.id, member.userId)); }}>Xóa thành viên</button></>}</div>)}
              {team.captainUserId === user.id ? sentInvitations.filter(invitation => invitation.teamId === team.id && invitation.status === 'PENDING').map(invitation => <div key={invitation.id} className="flex items-center gap-2 text-xs"><span>Lời mời đang chờ · {invitation.expiresAt}</span><button type="button" disabled={busy} onClick={() => { if (window.confirm('Thu hồi lời mời đang chờ?')) void runTeamAction(async () => { const result = await onlineTeams.revoke(invitation.id); if (result.ok) setSentInvitations(current => current.filter(item => item.id !== invitation.id)); return result; }); }}>Thu hồi lời mời</button></div>) : null}
              {!team.closedAt && <div className="flex gap-2"><button disabled={busy} onClick={() => { if (window.confirm('Rời đội? Trưởng đội cần chuyển quyền trước.')) void runTeamAction(() => onlineTeams.leave(team.id)); }}>Rời đội</button>{team.captainUserId === user?.id ? <button disabled={busy} onClick={() => { if (window.confirm('Đóng đội? Các lượt ghi danh hiện có vẫn được giữ.')) void runTeamAction(() => onlineTeams.close(team.id)); }}>Đóng đội</button> : null}</div>}
            </article>)}
          </section>
        ) : null}

        {error ? (
          <div role="alert" className="p-3 bg-[var(--danger-tint)] rounded-xl border border-[var(--danger-text)] text-xs text-[var(--danger-text)]">
            {error}
            <button type="button" disabled={busy} className="ml-3 underline" onClick={() => void refreshWorkspace()}>Tải lại dữ liệu</button>
          </div>
        ) : null}

        {loading ? (
          <p role="status" className="font-mono text-xs text-[var(--text-secondary)]">// ĐANG TẢI DỮ LIỆU ĐỘI...</p>
        ) : !error && boarded.length === 0 ? (
          <div className="border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-center font-mono text-xs text-[var(--text-secondary)]">
            {authProfile === 'ONLINE' ? <>Bạn chưa có đội hoặc đăng ký tham dự giải. <Link href="#create-team" className="underline">Tạo đội</Link> rồi <Link href="/workspace/join" className="underline">gửi đăng ký tham dự →</Link></> : 'Chưa có giải ghi danh đội của bạn. Liên hệ ADMIN / ban tổ chức để tham gia.'}
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {boarded.flatMap((tournament) =>
              tournament.myTeams.map((entry) => (
                <li
                  key={`${tournament.id}:${entry.teamId}`}
                  className="flex flex-wrap items-center justify-between gap-4 border border-[var(--border-subtle)] bg-[var(--surface)] p-5 rounded-2xl shadow-sm hover:border-[var(--border-control)] transition-all"
                >
                  <TournamentRatingProvider tournamentId={tournament.id}>
                    <div>
                      <h2 className="font-heading text-lg font-bold uppercase tracking-wider text-[var(--text-primary)]">
                        {tournament.name}
                      </h2>
                      <div className="mt-1 flex items-center gap-3 font-mono text-xs text-[var(--text-secondary)] uppercase">
                        <TeamRatingName teamId={entry.teamId} name={entry.teamName} rating={null} />
                        <span>//</span>
                        <span className="text-[var(--live-accent)]">● {stateLabel[tournament.state] ?? tournament.state}</span>
                      </div>
                      <p className="mt-2 text-sm font-medium">{entry.registration ? registrationStatusLabel[entry.registration.status] : entry.entry ? 'Đã được ghi danh trực tiếp' : 'Chưa gửi đăng ký'}</p>
                      {entry.registration?.reason ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--text-secondary)]">Lý do riêng tư từ ban tổ chức: {entry.registration.reason}</p> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Link prefetch={false} href={`/workspace/tournaments/${encodeURIComponent(tournament.id)}/teams/${encodeURIComponent(entry.teamId)}`} className="vct-btn-primary !py-2 !px-4 !text-xs !rounded-full">Trang đội / đăng ký →</Link>
                      <Link href={`/tournaments/${encodeURIComponent(tournament.id)}#registration`} className="text-sm text-[var(--action)] underline">Trang giải →</Link>
                      {entry.entry?.status === 'ELIGIBLE' && (!entry.registration || entry.registration.status === 'APPROVED') ? <Link href={`/workspace/tournaments/${encodeURIComponent(tournament.id)}/teams/${encodeURIComponent(entry.teamId)}?tab=submission`} className="text-sm text-[var(--action)] underline">Bài nộp thi đấu →</Link> : null}
                    </div>
                  </TournamentRatingProvider>
                </li>
              ))
            )}
          </ul>
        )}
      </section>
    );
  }

  if (authProfile === null) return <section className="mx-auto flex max-w-md flex-col gap-3 p-6"><h1 className="text-xl font-semibold">Đăng nhập / Không gian đội</h1><p role="status">{error ?? 'Đang xác định hồ sơ máy chủ. Chưa thể thay đổi đăng ký.'}</p><button type="button" disabled={busy} onClick={() => void refreshWorkspace()} className="vct-btn-secondary disabled:opacity-60">Tải lại thông tin đăng nhập</button><Link href="/tournaments" className="text-sm underline">Xem các giải đấu →</Link></section>;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="border-b border-[var(--border-subtle)] pb-4 flex items-center gap-3.5">
        <UetLogo size={48} priority />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            Đăng nhập
          </h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            OanTuTi Arena · Trường ĐH Công nghệ, ĐHQGHN
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-5 border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-7 rounded-2xl shadow-sm">
        <label className="flex flex-col gap-2 text-xs font-medium text-[var(--text-secondary)]">
          <span>Tên đăng nhập</span>
          <input
            name="username"
            required
            autoComplete="username"
            className="h-12 border border-[var(--border-control)] bg-[var(--canvas-deep)] px-4 text-base font-sans text-[var(--text-primary)] outline-none focus:border-[var(--action)] rounded-xl transition-colors"
          />
        </label>
        <label className="flex flex-col gap-2 text-xs font-medium text-[var(--text-secondary)]">
          <span>Mật khẩu</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="h-12 border border-[var(--border-control)] bg-[var(--canvas-deep)] px-4 text-base font-sans text-[var(--text-primary)] outline-none focus:border-[var(--action)] rounded-xl transition-colors"
          />
        </label>
        {error ? (
          <div className="border border-[var(--danger-text)] bg-[var(--danger-tint)] px-3.5 py-2.5 rounded-xl text-xs text-[var(--danger-text)]">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="vct-btn-primary !w-full !py-3.5 !text-base !rounded-xl mt-2 disabled:opacity-60 cursor-pointer"
        >
          {busy ? 'Đang đăng nhập...' : 'Đăng nhập'}
        </button>
      </form>

      {authProfile === 'ONLINE' ? (
        <nav className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
          <span>Chưa có tài khoản?</span>
          <div className="flex items-center gap-2">
            <Link href="/register" className="vct-btn-secondary !py-1.5 !px-3.5 !text-xs !rounded-full">
              Đăng ký
            </Link>
            <Link href="/forgot-password" className="vct-btn-secondary !py-1.5 !px-3.5 !text-xs !rounded-full">
              Quên mật khẩu
            </Link>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
