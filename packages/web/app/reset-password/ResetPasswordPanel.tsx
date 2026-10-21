'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { errorText } from '../../lib/client';
import { isProfileDisabled, resetPasswordWithToken } from '../../lib/api';
import { OnlineOnlyNotice, ProfileProbeNotice, useAuthProfile } from '../_components/AuthProfile';

/** Client-side mirror of the server rule (`packages/server/src/identity/service.ts`). */
const MIN_PASSWORD_LENGTH = 12;

/** Vietnamese explanation per reset failure code; unknown codes fall back to `errorText`. */
const RESET_FAILURE: Record<string, string> = {
  WEAK_PASSWORD: `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`,
  PASSWORD_RESET_INVALID: 'Token đặt lại mật khẩu không hợp lệ.',
  PASSWORD_RESET_EXPIRED: 'Token đặt lại mật khẩu đã hết hạn (token chỉ sống 30 phút) — hãy yêu cầu lại.',
  PASSWORD_RESET_CONSUMED: 'Token đặt lại mật khẩu đã được dùng trước đó.',
};

const FIELD_CLASS =
  'h-11 border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] rounded-xl transition-colors';
export default function ResetPasswordPanel() {
  const profile = useAuthProfile();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    setToken(fragment.get('token'));
  }, []);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  /** Raw `PROFILE_DISABLED` message from the API: evidence that this deployment is LAN_OFFLINE. */
  const [profileRefusal, setProfileRefusal] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      setCode(null);
      return;
    }
    if (password !== confirm) {
      setError('Xác nhận mật khẩu không khớp.');
      setCode(null);
      return;
    }
    if (!token) return;
    setBusy(true);
    setError(null);
    setCode(null);
    const result = await resetPasswordWithToken(token, password);
    setBusy(false);
    if (!result.ok) {
      if (isProfileDisabled(result)) {
        setProfileRefusal(result.message);
        return;
      }
      setCode(result.code ?? null);
      setError(RESET_FAILURE[result.code ?? ''] ?? errorText(result, 'Đặt lại mật khẩu thất bại.'));
      return;
    }
    setDone(true);
  }

  if (profile === 'LAN_OFFLINE' || profileRefusal) return <OnlineOnlyNotice message={profileRefusal} />;
  if (profile === undefined) return <ProfileProbeNotice />;
  if (profile === null) return <p role="alert">Không thể xác định hồ sơ xác thực; đặt lại mật khẩu đã bị khóa.</p>;

  if (done) {
    return (
      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
        <h2 className="text-base font-semibold text-[var(--success-text)]">Mật khẩu đã được đặt lại</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Server đã đổi mật khẩu và thu hồi mọi phiên đăng nhập cũ của tài khoản. Hãy đăng nhập lại bằng mật khẩu mới.
        </p>
        <Link
          href="/workspace"
          className="mt-4 inline-block rounded-md bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[#0B0D17]"
        >
          Tới trang đăng nhập →
        </Link>
      </section>
    );
  }

  if (!token) {
    return (
      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
        <h2 className="text-base font-semibold">Thiếu token đặt lại</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Đường dẫn không có token trong phần <span className="font-mono">#token=</span>, nên chưa thể đổi mật khẩu. Hãy mở đúng liên
          kết trong email khôi phục, hoặc yêu cầu một liên kết mới.
        </p>
        <Link
          href="/forgot-password"
          className="mt-4 inline-block rounded-md border border-[var(--border-control)] px-4 py-2 text-sm font-medium hover:border-[var(--action)]"
        >
          Yêu cầu liên kết mới →
        </Link>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-7 rounded-2xl shadow-sm">
      <p className="text-sm leading-6 text-[var(--text-secondary)]">
        Token trong phần #token= được giữ trong trình duyệt và chỉ gửi cùng mật khẩu mới sau khi bạn xác nhận biểu mẫu.
      </p>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">Mật khẩu mới</span>
        <input
          name="newPassword"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={FIELD_CLASS}
        />
        <span className="text-xs text-[var(--text-secondary)]">Tối thiểu {MIN_PASSWORD_LENGTH} ký tự.</span>
      </label>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">Xác nhận mật khẩu mới</span>
        <input
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className={FIELD_CLASS}
        />
      </label>

      {error ? (
        <p className="rounded-md border border-[var(--danger-text)] px-3 py-2 text-sm text-[var(--danger-text)]">
          {error}
          {code ? <span className="ml-2 font-mono text-xs break-all text-[var(--text-secondary)]">{code}</span> : null}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="vct-btn-primary !w-full !py-3 !text-sm !rounded-xl mt-2 disabled:opacity-60 cursor-pointer"
      >
        {busy ? 'Đang đặt lại...' : 'Xác nhận mật khẩu mới'}
      </button>
      <p className="text-xs text-[var(--text-secondary)]">
        <Link href="/workspace" className="text-[var(--action)] font-medium hover:underline">
          ← Quay lại đăng nhập
        </Link>
      </p>
    </form>
  );
}
