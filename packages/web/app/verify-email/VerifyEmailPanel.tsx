'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../../lib/client';
import { isProfileDisabled, resendEmailVerification, verifyEmailToken } from '../../lib/api';
import { OnlineOnlyNotice, ProfileProbeNotice, useAuthProfile } from '../_components/AuthProfile';

/** Vietnamese explanation per verification failure code; unknown codes fall back to `errorText`. */
const VERIFY_FAILURE: Record<string, string> = {
  EMAIL_VERIFICATION_INVALID: 'Token xác minh không hợp lệ.',
  EMAIL_VERIFICATION_EXPIRED: 'Token xác minh đã hết hạn (token chỉ sống 24 giờ). Đăng nhập rồi yêu cầu gửi lại email xác minh.',
  EMAIL_VERIFICATION_CONSUMED: 'Token xác minh đã được dùng trước đó; tài khoản này đã xác minh.',
};

export default function VerifyEmailPanel() {
  const profile = useAuthProfile();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    setToken(fragment.get('token'));
    setReady(true);
  }, []);
  const [verified, setVerified] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  /** Raw `PROFILE_DISABLED` message from the API: evidence that this deployment is LAN_OFFLINE. */
  const [profileRefusal, setProfileRefusal] = useState<string | null>(null);

  /** Posts the token on demand; the ref keeps a double click from firing a second request. */
  const run = useCallback(async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setCode(null);
    const result = await verifyEmailToken(token);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setVerified(true);
      return;
    }
    if (isProfileDisabled(result)) {
      setProfileRefusal(result.message);
      return;
    }
    setCode(result.code ?? null);
    setError(VERIFY_FAILURE[result.code ?? ''] ?? errorText(result, 'Xác minh email thất bại.'));
  }, [profile, token]);

  const [resent, setResent] = useState(false);
  if (profile === 'LAN_OFFLINE' || profileRefusal) return <OnlineOnlyNotice message={profileRefusal} />;
  if (profile === undefined || !ready) return <ProfileProbeNotice />;
  if (profile === null) return <p role="alert">Không thể xác định hồ sơ xác thực; xác minh email đã bị khóa.</p>;

  if (verified) {
    return (
      <section role="status" className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
        <h2 className="text-base font-semibold text-[var(--success-text)]">Email đã được xác minh</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Server đã chấp nhận token và xác minh tài khoản. Bạn có thể đăng nhập ngay bây giờ.
        </p>
        <Link
          href="/workspace"
          className="mt-4 inline-block rounded-md bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[var(--action-text)]"
        >
          Tới trang đăng nhập →
        </Link>
      </section>
    );
  }

  if (!token) {
    return (
      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
        <h2 className="text-base font-semibold">Thiếu token xác minh</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Đường dẫn không có token trong phần <span className="font-mono">#token=</span>. Mở đúng liên kết email; trang không gửi hay dùng token cho đến khi bạn bấm xác nhận.
        </p>
        <Link
          href="/workspace"
          className="mt-4 inline-block rounded-md border border-[var(--border-control)] px-4 py-2 text-sm font-medium hover:border-[var(--action)]"
        >
          Về trang đăng nhập →
        </Link>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-5 border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-7 rounded-2xl shadow-sm">
      <p className="text-xs text-[var(--text-secondary)]">Token trong liên kết ở phần #token= được giữ trong trình duyệt; chưa có yêu cầu gửi đến máy chủ. Bấm nút xác nhận bên dưới để xác minh.</p>

      {busy ? <p role="status" className="text-xs text-[var(--text-secondary)]">Đang xác minh token...</p> : null}
      {error ? (
        <div role="alert" className="border-l-2 border-[var(--danger-text)] bg-[var(--danger-tint)] px-3 py-2 font-mono text-xs text-[var(--danger-text)]">
          {error}
          {code ? <span className="ml-2 font-mono text-xs break-all text-[var(--text-secondary)]">[{code}]</span> : null}
        </div>
      ) : null}
      {code === 'EMAIL_VERIFICATION_EXPIRED' ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-2">Email đăng ký<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="rounded border border-[var(--border-control)] bg-[var(--canvas)] p-2" /></label>
          <button type="button" disabled={busy || !email} onClick={() => { void resendEmailVerification(email).then(result => { if (result.ok) setResent(true); else setError(errorText(result, 'Không thể yêu cầu gửi lại.')); }); }} className="vct-btn-secondary">Yêu cầu gửi lại email xác minh</button>
          {resent ? <p role="status">Nếu tài khoản cần xác minh, email mới đã được yêu cầu.</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="vct-btn-primary !w-full !py-3 !text-sm !rounded-xl mt-2 disabled:opacity-60 cursor-pointer"
      >
        {busy ? 'Đang xác minh...' : 'Xác nhận xác minh email'}
      </button>
    </section>
  );
}
