'use client';

import { useState, type FormEvent } from 'react';
import { apiRequest, errorText } from '../../lib/client';

/**
 * Surfaces where a person chooses their own password (register, reset) use the same floor; the API
 * only enforces eight characters for a change.
 */
const MIN_PASSWORD_LENGTH = 12;

interface Props {
  readonly username: string;
  /** Re-reads `/api/v2/auth/me`; the workspace renders its team panels once the scope is FULL again. */
  readonly onChanged: () => Promise<void>;
}

/**
 * First sign-in with an admin-issued credential: `POST /auth/login` answers a `PASSWORD_CHANGE_ONLY`
 * session that may only change the password or sign out, so every other call answers 403
 * `PASSWORD_CHANGE_REQUIRED` until this form succeeds. The route revokes all sessions — including
 * this one — and installs a fresh FULL-scope cookie, so only the new password works afterwards.
 */
export default function FirstPasswordChange({ username, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const oldPassword = String(data.get('oldPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmPassword = String(data.get('confirmPassword') ?? '');

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Mật khẩu mới phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Xác nhận mật khẩu không khớp với mật khẩu mới.');
      return;
    }
    if (newPassword === oldPassword) {
      setError('Mật khẩu mới phải khác mật khẩu tạm ban đầu.');
      return;
    }

    setBusy(true);
    const result = await apiRequest('/api/v2/auth/change-password', {
      method: 'POST',
      body: { oldPassword, newPassword },
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorText(result, 'Đổi mật khẩu thất bại.'));
      return;
    }
    setError(null);
    setDone(true);
    form.reset();
    await onChanged();
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Đổi mật khẩu lần đầu</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Tài khoản <span className="font-semibold">{username}</span> đang dùng mật khẩu tạm do ban tổ chức
          cấp. Hãy đặt mật khẩu riêng trước khi dùng không gian đội.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Mật khẩu tạm</span>
          <input
            name="oldPassword"
            type="password"
            required
            autoComplete="current-password"
            className="h-11 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Mật khẩu mới</span>
          <input
            name="newPassword"
            type="password"
            required
            autoComplete="new-password"
            className="h-11 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
          />
          <span className="text-xs text-[var(--text-secondary)]">Tối thiểu {MIN_PASSWORD_LENGTH} ký tự.</span>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Xác nhận mật khẩu mới</span>
          <input
            name="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
            className="h-11 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="min-h-10 rounded-md bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[var(--action-text)] disabled:opacity-60"
        >
          {busy ? 'Đang đổi…' : 'Đổi mật khẩu và vào không gian đội'}
        </button>

        {error ? (
          <p role="alert" className="rounded-md border border-[var(--danger-text)] bg-[var(--surface-subtle)] p-3 text-sm text-[var(--danger-text)]">
            {error}
          </p>
        ) : null}
        {done ? (
          <p role="status" className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3 text-sm text-[var(--text-secondary)]">
            Đã đổi mật khẩu. Mọi phiên đăng nhập cũ của tài khoản này đã bị thu hồi; phiên hiện tại đã được cấp
            lại với đầy đủ quyền.
          </p>
        ) : null}
      </form>

      <p className="text-xs text-[var(--text-secondary)]">
        Quên mật khẩu? Ở hồ sơ LAN_OFFLINE, ban tổ chức cấp lại mật khẩu tạm cho bạn; không có email tự phục vụ.
      </p>
    </div>
  );
}
