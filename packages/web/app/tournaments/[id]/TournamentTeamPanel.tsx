'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchAuthMe,
  listTournamentEntries,
  listTournamentRegistrations,
  onlineTeams,
  type AuthMe,
  type TeamDto,
  type TeamInvitationDto,
} from '../../../lib/api';
import { registrationErrorText } from '../../../lib/tournament-registration';
import { stateLabel } from '../../../lib/labels';

export default function TournamentTeamPanel({
  tournamentId,
  tournamentState,
  tournamentName,
}: {
  tournamentId: string;
  tournamentState: string;
  tournamentName?: string;
}) {
  const [session, setSession] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [incomingInvitations, setIncomingInvitations] = useState<TeamInvitationDto[]>([]);
  const [sentInvitations, setSentInvitations] = useState<Record<string, TeamInvitationDto[]>>({});

  // Form states
  const [newTeamName, setNewTeamName] = useState('');
  const [inviteUsernames, setInviteUsernames] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const auth = await fetchAuthMe();
      if (!auth.ok || !auth.data) {
        setSession(null);
        setTeams([]);
        setIncomingInvitations([]);
        return;
      }

      const userSession = auth.data;
      setSession(userSession);

      if (userSession.authProfile !== 'ONLINE' || userSession.user.role !== 'STUDENT' || userSession.scope !== 'FULL') {
        setTeams([]);
        setIncomingInvitations([]);
        return;
      }

      const [teamsRes, invitesRes, regsRes, entriesRes] = await Promise.all([
        onlineTeams.list(),
        onlineTeams.invitations(),
        listTournamentRegistrations(tournamentId),
        listTournamentEntries(tournamentId),
      ]);

      if (!teamsRes.ok || !teamsRes.data) {
        setError(registrationErrorText(teamsRes));
        return;
      }

      const allTeams = teamsRes.data.teams;
      const ownRegs = regsRes.ok && regsRes.data ? regsRes.data.registrations : [];
      const entries = entriesRes ?? [];

      const tournamentTeams = allTeams.filter(
        (t) =>
          t.tournamentId === tournamentId ||
          ownRegs.some((r) => r.teamId === t.id) ||
          entries.some((e) => e.teamId === t.id)
      );

      setTeams(tournamentTeams);

      if (invitesRes.ok && invitesRes.data) {
        const pendingForThisTournament = invitesRes.data.invitations.filter(
          (inv) =>
            inv.status === 'PENDING' &&
            inv.recipientUserId === userSession.user.id &&
            inv.tournamentId === tournamentId
        );
        setIncomingInvitations(pendingForThisTournament);
      }
    } catch {
      setError('Lỗi khi tải thông tin đội thi đấu.');
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreateTeam(event: React.FormEvent) {
    event.preventDefault();
    if (!newTeamName.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.create({ tournamentId, name: newTeamName.trim() });
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setNewTeamName('');
      setNotice({
        kind: 'success',
        text: `Đã tạo đội “${result.data?.name ?? newTeamName}”. Vui lòng sang tab “Đăng ký tham gia” để gửi yêu cầu tham gia giải!`,
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(teamId: string, event: React.FormEvent) {
    event.preventDefault();
    const username = (inviteUsernames[teamId] ?? '').trim();
    if (!username || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.invite(teamId, username);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setInviteUsernames((prev) => ({ ...prev, [teamId]: '' }));
      if (result.data) {
        const inv = result.data;
        setSentInvitations((prev) => ({
          ...prev,
          [teamId]: [...(prev[teamId] ?? []).filter((item) => item.id !== inv.id), inv],
        }));
      }
      setNotice({ kind: 'success', text: `Đã gửi lời mời tham gia tới thành viên @${username}.` });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRespondInvitation(invitationId: string, decision: 'ACCEPT' | 'DECLINE') {
    if (busy) return;
    const actionText = decision === 'ACCEPT' ? 'chấp nhận' : 'từ chối';
    if (!window.confirm(`Bạn có chắc chắn muốn ${actionText} lời mời tham gia đội này?`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.respond(invitationId, decision);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setNotice({
        kind: 'success',
        text: decision === 'ACCEPT' ? 'Đã tham gia đội thành công!' : 'Đã từ chối lời mời.',
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeInvitation(teamId: string, invitationId: string) {
    if (busy) return;
    if (!window.confirm('Bạn có chắc muốn thu hồi lời mời này?')) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.revoke(invitationId);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setSentInvitations((prev) => ({
        ...prev,
        [teamId]: (prev[teamId] ?? []).filter((item) => item.id !== invitationId),
      }));
      setNotice({ kind: 'success', text: 'Đã thu hồi lời mời.' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleTransferCaptain(teamId: string, memberUserId: string, memberName: string) {
    if (busy) return;
    if (!window.confirm(`Chuyển quyền đội trưởng cho thành viên “${memberName}”? Bạn sẽ trở thành thành viên thường.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.captain(teamId, memberUserId);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setNotice({ kind: 'success', text: `Đã chuyển quyền đội trưởng cho “${memberName}”.` });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(teamId: string, memberUserId: string, memberName: string) {
    if (busy) return;
    if (!window.confirm(`Xóa thành viên “${memberName}” khỏi đội?`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.remove(teamId, memberUserId);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setNotice({ kind: 'success', text: `Đã xóa “${memberName}” khỏi đội.` });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleLeaveTeam(teamId: string) {
    if (busy) return;
    if (!window.confirm('Rời đội thi đấu? Bạn sẽ không còn là thành viên của đội trong giải này.')) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.leave(teamId);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setNotice({ kind: 'success', text: 'Đã rời khỏi đội thi đấu.' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseTeam(teamId: string, teamName: string) {
    if (busy) return;
    if (!window.confirm(`Đóng / Giải tán đội “${teamName}”? Đội solo chưa thi đấu sẽ được đóng vĩnh viễn.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onlineTeams.close(teamId);
      if (!result.ok) {
        setNotice({ kind: 'error', text: registrationErrorText(result) });
        return;
      }
      setNotice({ kind: 'success', text: `Đã đóng đội “${teamName}”.` });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const returnUrl = `/tournaments/${encodeURIComponent(tournamentId)}?tab=team`;

  // 1. Loading state
  if (loading && !session) {
    return (
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-8 text-center font-mono text-xs text-[var(--text-secondary)] shadow-sm">
        // ĐANG TẢI THÔNG TIN ĐỘI VÀ TÀI KHOẢN...
      </div>
    );
  }

  // 2. Unauthenticated guest
  if (!session) {
    return (
      <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
          Đội thi đấu của bạn
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
          Đăng nhập bằng tài khoản sinh viên để tạo đội, mời thành viên hoặc quản lý đội thi đấu của bạn trong giải này.
        </p>
        <div className="mt-6">
          <Link
            href={`/workspace?returnTo=${encodeURIComponent(returnUrl)}`}
            className="vct-btn-primary inline-flex items-center gap-2 !py-2.5 !px-5 !text-sm !rounded-full"
          >
            Đăng nhập để quản lý đội →
          </Link>
        </div>
      </section>
    );
  }

  // 3. Password change required
  if (session.scope === 'PASSWORD_CHANGE_ONLY') {
    return (
      <section className="rounded-2xl border border-[var(--warning-text)] bg-[var(--warning-tint)] p-6 text-sm text-[var(--warning-text)] shadow-sm">
        <h2 className="font-heading text-lg font-bold">Cần đổi mật khẩu lần đầu</h2>
        <p className="mt-2">
          Tài khoản của bạn được cấp mật khẩu ban đầu và cần đổi mật khẩu trước khi có thể quản lý đội hoặc tham gia giải.
        </p>
        <Link href={`/workspace?returnTo=${encodeURIComponent(returnUrl)}`} className="mt-4 inline-block font-semibold underline">
          Đổi mật khẩu ngay →
        </Link>
      </section>
    );
  }

  // 4. Role check
  if (session.user.role !== 'STUDENT') {
    return (
      <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <h2 className="font-heading text-lg font-bold text-[var(--text-primary)]">Quyền hạn tài khoản</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Tài khoản hiện tại có vai trò <strong>{session.user.role}</strong>. Chỉ tài khoản sinh viên mới thành lập và quản lý đội thi đấu.
        </p>
      </section>
    );
  }

  // 5. Offline LAN profile
  if (session.authProfile === 'LAN_OFFLINE') {
    return (
      <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <h2 className="font-heading text-lg font-bold text-[var(--text-primary)]">Hệ thống mạng LAN</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
          Trong môi trường LAN Offline, Ban tổ chức (ADMIN) trực tiếp thành lập và ghi danh đội thi đấu vào giải. Vui lòng liên hệ Ban tổ chức tại phòng thi đấu nếu cần thay đổi thành viên.
        </p>
      </section>
    );
  }

  const isRegistrationOpen = tournamentState === 'REGISTRATION_OPEN';

  return (
    <div className="flex flex-col gap-6">
      {/* Global notice */}
      {notice ? (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-xl border p-4 text-xs font-medium ${
            notice.kind === 'error'
              ? 'border-[var(--danger-text)] bg-[var(--danger-tint)] text-[var(--danger-text)]'
              : 'border-[var(--success-text)] bg-[var(--success-tint)] text-[var(--success-text)]'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl border border-[var(--danger-text)] bg-[var(--danger-tint)] p-4 text-xs text-[var(--danger-text)]">
          {error}
        </div>
      ) : null}

      {/* Incoming Invitations Banner */}
      {incomingInvitations.length > 0 ? (
        <section className="rounded-2xl border border-[var(--action)] bg-[rgba(0,245,212,0.06)] p-5 shadow-sm">
          <h2 className="font-heading text-base font-bold text-[var(--text-primary)]">
            Lời mời tham gia đội trong giải này
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Bạn đã nhận được lời mời tham gia các đội sau cho giải {tournamentName ?? ''}:
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {incomingInvitations.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4"
              >
                <div>
                  <p className="font-heading font-bold text-sm text-[var(--text-primary)]">{inv.teamName}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    Hết hạn lúc: {inv.expiresAt.slice(0, 16).replace('T', ' ')} UTC
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRespondInvitation(inv.id, 'ACCEPT')}
                    className="vct-btn-primary !py-2 !px-4 !text-xs !rounded-full disabled:opacity-50"
                  >
                    Chấp nhận
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRespondInvitation(inv.id, 'DECLINE')}
                    className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-full disabled:opacity-50"
                  >
                    Từ chối
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Case 1: Student has no team for this tournament */}
      {teams.length === 0 ? (
        <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
          <div className="border-b border-[var(--border-subtle)] pb-4">
            <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
              Tạo đội thi đấu cho giải này
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
              Bạn chưa có đội nào tham gia giải đấu này. Hãy đặt tên đội và thành lập đội ngay dưới đây.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-[var(--accent-secondary)]/30 bg-[var(--surface-subtle)] p-4 text-xs leading-relaxed text-[var(--text-secondary)]">
            <strong className="text-[var(--text-primary)]">Lưu ý quan trọng:</strong> Tạo đội là bước chuẩn bị nhân sự (mời thành viên, phân chia quyền hạn). Sau khi tạo đội thành công, đội trưởng cần chuyển sang tab{' '}
            <strong className="text-[var(--action)]">“Đăng ký tham gia”</strong> để gửi yêu cầu dự thi chính thức cho Ban tổ chức xét duyệt.
          </div>

          {isRegistrationOpen ? (
            <form onSubmit={(e) => void handleCreateTeam(e)} className="mt-6 flex flex-col gap-4 max-w-lg">
              <label className="flex flex-col gap-2 text-sm">
                <span className="font-medium text-[var(--text-primary)]">Tên đội thi đấu</span>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={50}
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="Ví dụ: Chiến Binh UET, Rồng Thần..."
                  disabled={busy}
                  className="h-11 rounded-xl border border-[var(--border-control)] bg-[var(--canvas)] px-3.5 text-sm text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--action)]"
                />
              </label>
              <button
                type="submit"
                disabled={busy || newTeamName.trim().length < 2}
                className="vct-btn-primary self-start !py-2.5 !px-6 !text-xs !rounded-full disabled:opacity-50"
              >
                {busy ? 'Đang tạo đội…' : 'Tạo đội cho giải này'}
              </button>
            </form>
          ) : (
            <div className="mt-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-xs text-[var(--text-secondary)]">
              Giải đấu hiện không mở đăng ký ({stateLabel[tournamentState] ?? tournamentState}). Không thể tạo thêm đội mới cho giải này.
            </div>
          )}
        </section>
      ) : (
        /* Case 2: Student has a team in this tournament */
        <div className="flex flex-col gap-6">
          {teams.map((team) => {
            const isCaptain = team.captainUserId === session.user.id;
            const members = team.members ?? [];
            const isSolo = members.length <= 1;
            const teamSentInvites = sentInvitations[team.id] ?? [];

            return (
              <section
                key={team.id}
                className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm"
              >
                {/* Team Header */}
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-5">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[var(--action)]">
                        {isCaptain ? 'ĐỘI TRƯỞNG' : 'THÀNH VIÊN'}
                      </span>
                      {team.rosterLocked ? (
                        <span className="rounded-full border border-[var(--warning-text)] bg-[var(--warning-tint)] px-2.5 py-0.5 font-mono text-[10px] font-bold text-[var(--warning-text)]">
                          DANH SÁCH ĐÃ KHÓA
                        </span>
                      ) : null}
                      {team.closedAt ? (
                        <span className="rounded-full border border-[var(--danger-text)] bg-[var(--danger-tint)] px-2.5 py-0.5 font-mono text-[10px] font-bold text-[var(--danger-text)]">
                          ĐÃ GIẢI TÁN
                        </span>
                      ) : null}
                    </div>
                    <h2 className="mt-2 font-heading text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                      {team.name}
                    </h2>
                  </div>

                  {/* Quick link to Registration tab */}
                  <div className="flex flex-col items-end gap-1">
                    <Link
                      href={`/tournaments/${encodeURIComponent(tournamentId)}?tab=registration`}
                      className="vct-btn-primary !py-2 !px-4 !text-xs !rounded-full"
                    >
                      Sang tab Đăng ký tham gia →
                    </Link>
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      Theo dõi duyệt đơn và bài nộp
                    </span>
                  </div>
                </div>

                {/* Important Reminder Banner */}
                <div className="mt-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-xs leading-relaxed text-[var(--text-secondary)]">
                  💡 <strong className="text-[var(--text-primary)]">Nhắc nhở:</strong> Việc có đội chưa đồng nghĩa với việc đã được duyệt tham gia thi đấu. Đội trưởng cần vào tab{' '}
                  <Link href={`/tournaments/${encodeURIComponent(tournamentId)}?tab=registration`} className="text-[var(--action)] underline font-medium">
                    Đăng ký tham gia
                  </Link>{' '}
                  để gửi yêu cầu cho Ban tổ chức xét duyệt.
                </div>

                {/* Member List */}
                <div className="mt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="font-heading text-sm font-bold uppercase tracking-wider text-[var(--text-primary)]">
                      Thành viên trong đội ({members.length})
                    </h3>
                  </div>

                  <div className="mt-3 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
                    {members.length === 0 ? (
                      <div className="p-4 text-xs text-[var(--text-secondary)]">Chưa có thông tin danh sách thành viên.</div>
                    ) : (
                      members.map((member) => (
                        <div
                          key={member.userId}
                          className="flex flex-wrap items-center justify-between gap-3 p-4"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--action)]/10 font-mono text-xs font-bold text-[var(--action)]">
                              {member.displayName.slice(0, 1).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-semibold text-sm text-[var(--text-primary)]">
                                {member.displayName}{' '}
                                {member.userId === session.user.id ? (
                                  <span className="text-xs font-normal text-[var(--text-secondary)]">(Bạn)</span>
                                ) : null}
                              </p>
                              <p className="font-mono text-xs text-[var(--text-secondary)]">
                                @{member.username} · {member.role === 'CAPTAIN' ? 'Đội trưởng' : 'Thành viên'}
                              </p>
                            </div>
                          </div>

                          {/* Captain Actions on Members */}
                          {isCaptain && member.role !== 'CAPTAIN' && !team.rosterLocked && !team.closedAt ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleTransferCaptain(team.id, member.userId, member.displayName)}
                                className="vct-btn-secondary !py-1.5 !px-3 !text-xs !rounded-full disabled:opacity-50"
                              >
                                Chuyển đội trưởng
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleRemoveMember(team.id, member.userId, member.displayName)}
                                className="rounded-full border border-[var(--danger-text)]/40 px-3 py-1.5 text-xs font-medium text-[var(--danger-text)] transition-colors hover:bg-[var(--danger-tint)] disabled:opacity-50"
                              >
                                Xóa
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Invite Members Section (Only for Captain when roster is open) */}
                {isCaptain && !team.rosterLocked && !team.closedAt ? (
                  <div className="mt-6 border-t border-[var(--border-subtle)] pt-5">
                    <h3 className="font-heading text-sm font-bold uppercase tracking-wider text-[var(--text-primary)]">
                      Mời thành viên mới vào đội
                    </h3>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      Nhập chính xác tên đăng nhập (username) của sinh viên cần mời. Thành viên sẽ nhận được thông báo để chấp nhận.
                    </p>

                    <form
                      onSubmit={(e) => void handleInvite(team.id, e)}
                      className="mt-3 flex flex-wrap items-end gap-3 max-w-md"
                    >
                      <label className="flex-1 min-w-[200px] flex flex-col gap-1.5 text-xs">
                        <span className="font-medium text-[var(--text-secondary)]">Username sinh viên</span>
                        <input
                          type="text"
                          required
                          value={inviteUsernames[team.id] ?? ''}
                          onChange={(e) =>
                            setInviteUsernames({ ...inviteUsernames, [team.id]: e.target.value })
                          }
                          placeholder="Nhập username..."
                          disabled={busy}
                          className="h-10 rounded-xl border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-xs text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--action)]"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={busy || !(inviteUsernames[team.id] ?? '').trim()}
                        className="vct-btn-secondary h-10 !py-2 !px-4 !text-xs !rounded-xl disabled:opacity-50"
                      >
                        Gửi lời mời
                      </button>
                    </form>

                    {/* Pending Sent Invitations */}
                    {teamSentInvites.length > 0 ? (
                      <div className="mt-4 flex flex-col gap-2">
                        <span className="font-mono text-[11px] text-[var(--text-secondary)] uppercase">
                          Lời mời đã gửi gần đây:
                        </span>
                        {teamSentInvites.map((inv) => (
                          <div
                            key={inv.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-2 text-xs"
                          >
                            <span className="font-mono text-[var(--text-secondary)]">
                              Lời mời đang chờ · hết hạn {inv.expiresAt.slice(0, 16).replace('T', ' ')}
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRevokeInvitation(team.id, inv.id)}
                              className="text-[var(--danger-text)] underline text-xs"
                            >
                              Thu hồi
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Team Management / Exit Actions */}
                {!team.closedAt ? (
                  <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] pt-5">
                    {/* Member can leave */}
                    {!isCaptain ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleLeaveTeam(team.id)}
                        className="rounded-full border border-[var(--danger-text)]/40 px-4 py-2 text-xs font-semibold text-[var(--danger-text)] hover:bg-[var(--danger-tint)] disabled:opacity-50"
                      >
                        Rời khỏi đội
                      </button>
                    ) : null}

                    {/* Captain close solo team */}
                    {isCaptain && isSolo ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCloseTeam(team.id, team.name)}
                        className="rounded-full border border-[var(--danger-text)]/40 px-4 py-2 text-xs font-semibold text-[var(--danger-text)] hover:bg-[var(--danger-tint)] disabled:opacity-50"
                      >
                        Đóng / Giải tán đội solo
                      </button>
                    ) : null}

                    {isCaptain && !isSolo ? (
                      <span className="text-xs text-[var(--text-secondary)]">
                        * Bạn đang là đội trưởng của đội có nhiều thành viên. Để rời đội hoặc giải tán, hãy chuyển quyền đội trưởng cho thành viên khác trước.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
