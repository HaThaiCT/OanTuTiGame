'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchAuthMe, probeAuthProfile, type AuthProfile } from '../../lib/api';
import { safeReturnTo } from '../../lib/navigation';
import FirstPasswordChange from './FirstPasswordChange';
import UetLogo from '../_components/UetLogo';

interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

export default function WorkspacePage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refreshSession() {
    const result = await fetchAuthMe();
    if (!result.ok || !result.data) {
      setUser(null);
      setScope(null);
      const probed = await probeAuthProfile();
      setAuthProfile(probed);
      setLoading(false);
      window.dispatchEvent(new Event('oantuti:session-changed'));
      return;
    }
    const sessionUser: SessionUser = {
      id: result.data.user.id,
      username: result.data.user.username,
      displayName: result.data.user.displayName,
      role: result.data.user.role,
    };
    setUser(sessionUser);
    setScope(result.data.scope);
    setAuthProfile(result.data.authProfile);
    setLoading(false);
    window.dispatchEvent(new Event('oantuti:session-changed'));
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = params.get('returnTo');
    if (target) {
      setReturnTo(target);
    }
    void refreshSession();
  }, []);

  useEffect(() => {
    if (user && scope === 'FULL') {
      const destination = safeReturnTo(returnTo) ?? (user.role === 'ADMIN' ? '/organizer' : '/tournaments');
      router.replace(destination);
    }
  }, [user, scope, returnTo, router]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/v2/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
        }),
      });
      const payload = (await response.json()) as { user?: SessionUser; message?: string };
      if (!response.ok) {
        setError(payload.message ?? 'Đăng nhập thất bại.');
        return;
      }
      const session = await fetchAuthMe();
      if (session.ok && session.data) {
        const loggedUser: SessionUser = {
          id: session.data.user.id,
          username: session.data.user.username,
          displayName: session.data.user.displayName,
          role: session.data.user.role,
        };
        setUser(loggedUser);
        setScope(session.data.scope);
        setAuthProfile(session.data.authProfile);
        window.dispatchEvent(new Event('oantuti:session-changed'));

        if (session.data.scope === 'PASSWORD_CHANGE_ONLY') {
          return;
        }

        const destination = safeReturnTo(returnTo) ?? (loggedUser.role === 'ADMIN' ? '/organizer' : '/tournaments');
        router.replace(destination);
      } else if (payload.user) {
        setUser(payload.user);
        window.dispatchEvent(new Event('oantuti:session-changed'));
        const destination = safeReturnTo(returnTo) ?? (payload.user.role === 'ADMIN' ? '/organizer' : '/tournaments');
        router.replace(destination);
      }
    } catch {
      setError('Lỗi mạng khi đăng nhập.');
    } finally {
      setBusy(false);
    }
  }

  // An admin-issued credential signs in with a limited session: the API allows only the password
  // change (and sign-out) until it succeeds.
  if (user && scope === 'PASSWORD_CHANGE_ONLY') {
    return <FirstPasswordChange username={user.username} onChanged={refreshSession} />;
  }

  if (user && scope === 'FULL') {
    const destination = safeReturnTo(returnTo) ?? (user.role === 'ADMIN' ? '/organizer' : '/tournaments');
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 border border-[var(--border-subtle)] bg-[var(--surface)] p-8 text-center rounded-2xl shadow-sm">
        <UetLogo size={48} priority />
        <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
          Đã đăng nhập ({user.displayName})
        </h1>
        <p className="text-xs text-[var(--text-secondary)]">
          Đang chuyển hướng tới trang đích...
        </p>
        <Link href={destination} className="vct-btn-primary !py-2 !px-5 !text-xs !rounded-full mt-2">
          Tiếp tục ngay →
        </Link>
      </div>
    );
  }

  if (loading && authProfile === null) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center justify-center gap-3 p-12 text-[var(--text-secondary)]">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-control)] border-t-[var(--action)]" />
        <span className="text-xs">Đang kiểm tra phiên đăng nhập…</span>
      </div>
    );
  }

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

      {returnTo ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-2.5 text-xs text-[var(--text-secondary)]">
          Đăng nhập để tiếp tục đến trang bạn đang truy cập.
        </div>
      ) : null}

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
            <Link
              href={returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : '/register'}
              className="vct-btn-secondary !py-1.5 !px-3.5 !text-xs !rounded-full"
            >
              Đăng ký
            </Link>
            <Link href="/forgot-password" className="vct-btn-secondary !py-1.5 !px-3.5 !text-xs !rounded-full">
              Quên mật khẩu
            </Link>
          </div>
        </nav>
      ) : null}

      <div className="text-center pt-2">
        <Link href="/tournaments" className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
          ← Quay lại danh sách giải đấu
        </Link>
      </div>
    </div>
  );
}
