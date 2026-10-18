'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/client';
import { fetchAuthMe, probeAuthProfile, type AuthProfile } from '../../lib/api';
import { entryStatusLabel, stateLabel } from '../../lib/labels';
import DisputePanel from './DisputePanel';
import FirstPasswordChange from './FirstPasswordChange';
import PrivateTestPanel from './PrivateTestPanel';
import SubmissionPanel from './SubmissionPanel';

interface SessionUser {
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
  entriesLoaded: boolean;
  myEntries: MyEntry[];
}

/** Tournaments whose entry list is worth showing a team: intake open, intake locked, or live. */
const BOARDED_STATES: Record<string, true> = {
  REGISTRATION_OPEN: true,
  VALIDATING_SUBMISSIONS: true,
  LOCKED: true,
  READY_TO_START: true,
  RUNNING: true,
  PAUSED: true,
  PROVISIONAL: true,
  FINALIZED: true,
  ARCHIVED: true,
};

export default function WorkspacePage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  /** Session scope from `/auth/me`: `PASSWORD_CHANGE_ONLY` still owes the first password change. */
  const [scope, setScope] = useState<string | null>(null);
  const [boarded, setBoarded] = useState<BoardedTournament[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Active authentication profile. `null` = not established yet: `/auth/me` answers 401 without a
   * session, so the signed-out screen stays without self-service links until the API reports ONLINE.
   */
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(null);

  /**
   * Reads the current session (user + team memberships) and the deployment's authentication profile.
   * The profile comes from the same response, so no extra request is needed while signed in.
   */
  async function refreshSession() {
    const result = await fetchAuthMe();
    if (!result.ok || !result.data) {
      setTeamIds([]);
      setScope(null);
      if (result.status === 0) setError(result.message);
      if (result.status === 401) setAuthProfile(await probeAuthProfile());
      // The header lives in the layout and stays mounted across sign-out; tell it to re-read.
      window.dispatchEvent(new Event('oantuti:session-changed'));
      return;
    }
    setUser({
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
    if (!user || teamIds.length === 0) {
      setBoarded([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await apiRequest<{ tournaments?: Record<string, unknown>[] }>('/api/v2/tournaments');
      if (cancelled) return;
      const rows = Array.isArray(list.data?.tournaments) ? list.data.tournaments : [];
      const relevant = rows
        .map((row) => ({
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          state: String(row.state ?? ''),
          registrationClosesAt: typeof row.registration_closes_at === 'string' ? row.registration_closes_at : null,
        }))
        .filter((row) => row.id !== '' && BOARDED_STATES[row.state] === true);

      const mine: BoardedTournament[] = [];
      for (const tournament of relevant) {
        const entries = await apiRequest<{ entries?: Record<string, unknown>[] }>(
          `/api/v2/tournaments/${tournament.id}/entries`
        );
        if (cancelled) return;
        // A failed entries call must not break the workspace: report it for that tournament only.
        const rawEntries = entries.ok && Array.isArray(entries.data?.entries) ? entries.data.entries : [];
        const myEntries = rawEntries
          .map((row) => ({
            entryId: String(row.id ?? ''),
            teamId: String(row.teamId ?? row.team_id ?? ''),
            teamName: String(row.teamName ?? row.team_name ?? 'Đội chưa đặt tên'),
            status: String(row.status ?? ''),
            seedOrdinal: typeof row.seedOrdinal === 'number' ? row.seedOrdinal : null,
          }))
          .filter((entry) => teamIds.includes(entry.teamId));
        mine.push({ ...tournament, entriesLoaded: entries.ok, myEntries });
      }
      if (!cancelled) setBoarded(mine);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, teamIds]);

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
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Không gian đội</h1>
        <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5">
          <p className="text-xs text-[var(--text-secondary)]">Đăng nhập với</p>
          <p className="mt-1 text-lg font-semibold">{user.displayName || user.username}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">Vai trò: {user.role}</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Cấu hình xác thực của server: <span className="font-mono">{authProfile ?? 'chưa xác định'}</span>
          </p>
          <p className="mt-4 border-t border-[var(--border-subtle)] pt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            Form nộp mã nguồn bên dưới nộp thẳng lên server và hiển thị receipt thật. Mỗi đội còn có khối “Test riêng tư” để chạy thử bot mà không ảnh hưởng đến kết quả chính thức.
          </p>
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Đội của tôi trong giải đang mở / đang đấu</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Lấy từ danh sách đội tham dự của giải; chỉ hiển thị đội mà tài khoản này là thành viên.
            </p>
          </div>
          {teamIds.length === 0 ? (
            <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
              Tài khoản này chưa thuộc đội nào. Hãy nhờ ban tổ chức tạo đội với bạn là đội trưởng và ghi danh vào giải.
            </p>
          ) : boarded.length === 0 ? (
            <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
              Chưa có giải nào đang mở đăng ký, đã khóa danh sách hoặc đang diễn ra.
            </p>
          ) : (
            boarded.map((tournament) => (
              <article key={tournament.id} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)]">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-base font-semibold">{tournament.name}</h3>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      {stateLabel[tournament.state] ?? tournament.state} · đóng đăng ký:{' '}
                      {tournament.registrationClosesAt
                        ? `${tournament.registrationClosesAt.slice(0, 16).replace('T', ' ')} UTC`
                        : '—'}
                    </p>
                  </div>
                  <Link
                    href={`/tournaments/${tournament.id}`}
                    className="rounded-md border border-[var(--border-control)] px-3 py-2 text-sm font-medium hover:border-[var(--action)]"
                  >
                    Xem giải →
                  </Link>
                </header>
                <div className="p-3 sm:p-4">
                  {!tournament.entriesLoaded ? (
                    <p className="text-sm text-[var(--warning-text)]">Không tải được danh sách đội của giải này.</p>
                  ) : tournament.myEntries.length === 0 ? (
                    <p className="text-sm text-[var(--text-secondary)]">Bạn chưa có đội nào trong giải này.</p>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {tournament.myEntries.map((entry) => (
                        <li
                          key={entry.entryId}
                          className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 sm:p-4"
                        >
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                            <span className="font-semibold">{entry.teamName}</span>
                            <span className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
                              <span className="break-all font-mono">teamId: {entry.teamId}</span>
                              <span>Seed {entry.seedOrdinal ?? '—'}</span>
                              <span className="rounded-sm border border-[var(--border-subtle)] px-2 py-0.5">
                                {entryStatusLabel[entry.status] ?? entry.status}
                              </span>
                            </span>
                          </div>
                          <SubmissionPanel
                            tournamentId={tournament.id}
                            teamId={entry.teamId}
                            tournamentState={tournament.state}
                          />
                          <PrivateTestPanel tournamentId={tournament.id} teamId={entry.teamId} />
                          <DisputePanel
                            tournamentId={tournament.id}
                            teamId={entry.teamId}
                            tournamentState={tournament.state}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Đăng nhập</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          {authProfile === 'LAN_OFFLINE'
            ? 'Server này chạy cấu hình xác thực LAN_OFFLINE: tài khoản do ban tổ chức cấp, không có đăng ký tự phục vụ.'
            : 'Dùng tài khoản do ban tổ chức cấp hoặc tài khoản ONLINE đã xác minh email.'}
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5">
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Tên đăng nhập</span>
          <input name="username" required autoComplete="username" className="h-11 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]" />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Mật khẩu</span>
          <input name="password" type="password" required autoComplete="current-password" className="h-11 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]" />
        </label>
        {error ? <p className="rounded-md border border-[var(--danger-text)] px-3 py-2 text-sm text-[var(--danger-text)]">{error}</p> : null}
        <button disabled={busy} className="h-11 rounded-md bg-[var(--action)] font-semibold text-[#0B0D17] disabled:opacity-60">
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
      {authProfile === 'ONLINE' ? (
        <nav className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
          <span>Chưa có tài khoản?</span>
          <Link
            href="/register"
            className="rounded-md border border-[var(--border-control)] px-3 py-2 font-medium hover:border-[var(--action)]"
          >
            Đăng ký
          </Link>
          <Link
            href="/forgot-password"
            className="rounded-md border border-[var(--border-control)] px-3 py-2 font-medium hover:border-[var(--action)]"
          >
            Quên mật khẩu
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
