'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/client';
import { fetchAuthMe, probeAuthProfile, type AuthProfile } from '../../lib/api';
import { stateLabel } from '../../lib/labels';
import FirstPasswordChange from './FirstPasswordChange';
import { TeamRatingName } from '../_components/TeamRatingName';
import { TournamentRatingProvider } from '../_components/TournamentRatingContext';

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
  myEntries: MyEntry[];
}


export default function WorkspacePage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  /** Session scope from `/auth/me`: `PASSWORD_CHANGE_ONLY` still owes the first password change. */
  const [scope, setScope] = useState<string | null>(null);
  const [boarded, setBoarded] = useState<BoardedTournament[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
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
      setUser(null);
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
    if (!user || scope !== 'FULL' || user.role !== 'STUDENT' || teamIds.length === 0) {
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
          registrationClosesAt: typeof row.registration_closes_at === 'string' ? row.registration_closes_at : null,
        }))
        .filter((row) => row.id !== '');

      const mine: BoardedTournament[] = [];
      for (const tournament of relevant) {
        const entries = await apiRequest<{ entries?: Record<string, unknown>[] }>(
          `/api/v2/tournaments/${tournament.id}/entries`
        );
        if (cancelled) return;
        if (!entries.ok) {
          setError('Không tải được đầy đủ danh sách giải của đội. Vui lòng thử lại.');
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
        if (myEntries.length > 1) {
          setError('Tài khoản có nhiều đội trong cùng giải. Vui lòng liên hệ ban tổ chức.');
          setLoading(false);
          return;
        }
        if (myEntries.length === 1) mine.push({ ...tournament, myEntries });
      }
      if (!cancelled) { setBoarded(mine); setLoading(false); }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, teamIds, scope]);

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
      return <section className="flex flex-col gap-4"><h1 className="text-2xl font-semibold">Ban tổ chức</h1><p>Quản lý giải và tài nguyên trong trang điều hành.</p><Link href="/organizer" className="text-[var(--action)] underline">Vào Ban tổ chức →</Link></section>;
    }
    return (
      <section className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Không gian đội</h1>
        {authProfile === 'ONLINE' && user.role === 'STUDENT' && scope === 'FULL' ? <Link href="/workspace/join" className="text-sm text-[var(--action)] underline">Tham gia giải bằng mã →</Link> : null}
        {error ? <p role="alert" className="text-[var(--danger-text)]">{error}</p> : null}
        {loading ? <p role="status">Đang tải giải của đội…</p> : !error && boarded.length === 0 ? (
          <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">Chưa có giải nào ghi danh đội của bạn. Liên hệ ban tổ chức để tham gia.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {boarded.flatMap((tournament) => tournament.myEntries.map((entry) => (
              <li key={`${tournament.id}:${entry.teamId}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
                <TournamentRatingProvider tournamentId={tournament.id}>
                <div><h2 className="font-semibold">{tournament.name}</h2><p className="mt-1 text-xs text-[var(--text-secondary)]"><TeamRatingName teamId={entry.teamId} name={entry.teamName} rating={null}/> · {stateLabel[tournament.state] ?? tournament.state}</p></div>
                <Link prefetch={false} href={`/workspace/tournaments/${encodeURIComponent(tournament.id)}/teams/${encodeURIComponent(entry.teamId)}`} className="rounded-md border border-[var(--border-control)] px-3 py-2 text-sm font-medium hover:border-[var(--action)]">Xem giải →</Link>
                </TournamentRatingProvider>
              </li>
            )))}
          </ul>
        )}
      </section>
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
