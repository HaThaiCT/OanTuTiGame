'use client';

import Link from 'next/link';
import { useState } from 'react';
import { errorText } from '../../lib/client';
import { isProfileDisabled, requestPasswordReset } from '../../lib/api';
import { OnlineOnlyNotice, ProfileProbeNotice, useAuthProfile } from '../_components/AuthProfile';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One identical text for every accepted request. The API answers 202 whether or not the address is
 * registered (`requestPasswordReset` never discloses membership), so this screen must not vary
 * either — otherwise the UI itself would become the enumeration oracle.
 */
const ACCEPTANCE_TEXT =
  'Yêu cầu đã được tiếp nhận. Nếu email này thuộc một tài khoản, hướng dẫn đặt lại mật khẩu sẽ được gửi tới đó — môi trường phát triển có thể hiển thị token qua outbox.';

export default function ForgotPasswordPage() {
  const profile = useAuthProfile();
  const [email, setEmail] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Raw `PROFILE_DISABLED` message from the API: evidence that this deployment is LAN_OFFLINE. */
  const [profileRefusal, setProfileRefusal] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError('Email không đúng định dạng.');
      setCode(null);
      setAccepted(false);
      return;
    }
    setBusy(true);
    setError(null);
    setCode(null);
    const result = await requestPasswordReset(email.trim());
    setBusy(false);
    if (!result.ok) {
      if (isProfileDisabled(result)) {
        setProfileRefusal(result.message);
        return;
      }
      setAccepted(false);
      setError(errorText(result, 'Không gửi được yêu cầu đặt lại mật khẩu.'));
      setCode(result.code ?? null);
      return;
    }
    setAccepted(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-4 sm:py-8">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
          Quên mật khẩu
        </h1>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Nhập email tài khoản để nhận liên kết khôi phục mật khẩu.
        </p>
      </div>

      {profile === 'LAN_OFFLINE' || profileRefusal ? <OnlineOnlyNotice message={profileRefusal} /> : null}
      {profile === undefined ? <ProfileProbeNotice /> : null}

      {accepted ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5 text-sm leading-6 text-[var(--success-text)]">
          {ACCEPTANCE_TEXT}
        </p>
      ) : null}

      {profile === 'ONLINE' && !profileRefusal ? (
        <form onSubmit={submit} className="flex flex-col gap-5 border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-7 rounded-2xl shadow-sm">
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11 border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] rounded-xl transition-colors"
            />
            <span className="text-xs text-[var(--text-secondary)]">Đúng địa chỉ đã dùng khi đăng ký.</span>
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
            {busy ? 'Đang gửi yêu cầu...' : 'Gửi liên kết khôi phục'}
          </button>
          <p className="text-xs text-[var(--text-secondary)]">
            <Link href="/workspace" className="text-[var(--action)] font-medium hover:underline">
              ← Quay lại đăng nhập
            </Link>
          </p>
        </form>
      ) : null}

      {profile === null && !profileRefusal ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
          Không xác định được cấu hình xác thực của server nên chưa thể gửi yêu cầu. Hãy kiểm tra kết nối API rồi tải lại.
        </p>
      ) : null}
    </div>
  );
}
