'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../../lib/client';
import { isProfileDisabled, verifyEmailToken } from '../../lib/api';
import { OnlineOnlyNotice, ProfileProbeNotice, useAuthProfile } from '../_components/AuthProfile';

/** Vietnamese explanation per verification failure code; unknown codes fall back to `errorText`. */
const VERIFY_FAILURE: Record<string, string> = {
  EMAIL_VERIFICATION_INVALID: 'Token xác minh không hợp lệ.',
  EMAIL_VERIFICATION_EXPIRED: 'Token xác minh đã hết hạn (token chỉ sống 24 giờ) — hãy đăng ký lại để nhận token mới.',
  EMAIL_VERIFICATION_CONSUMED: 'Token xác minh đã được dùng trước đó; tài khoản này đã xác minh.',
};

export default function VerifyEmailPanel({ token }: { token: string | null }) {
  const profile = useAuthProfile();
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  /** Raw `PROFILE_DISABLED` message from the API: evidence that this deployment is LAN_OFFLINE. */
  const [profileRefusal, setProfileRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);
  const autoRan = useRef(false);

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
  }, [token]);

  // One automatic attempt per page load, and only once the profile is known: in LAN_OFFLINE the
  // refusal notice renders instead, so the verify route is never called. The ref survives the
  // StrictMode double-invoked effect, keeping the attempt exactly-once.
  useEffect(() => {
    if (autoRan.current || !token || profile === undefined || profile === 'LAN_OFFLINE') return;
    autoRan.current = true;
    void run();
  }, [run, token, profile]);

  if (profile === 'LAN_OFFLINE' || profileRefusal) return <OnlineOnlyNotice message={profileRefusal} />;
  if (profile === undefined) return <ProfileProbeNotice />;

  if (verified) {
    return (
      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
        <h2 className="text-base font-semibold text-[var(--success-text)]">Email đã được xác minh</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Server đã chấp nhận token và xác minh tài khoản. Bạn có thể đăng nhập ngay bây giờ.
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
        <h2 className="text-base font-semibold">Thiếu token xác minh</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Đường dẫn không có tham số <span className="font-mono">?token=</span>, nên chưa có gì để xác minh. Hãy mở đúng liên
          kết trong email xác minh, hoặc đăng nhập nếu tài khoản đã được xác minh.
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
    <section className="flex flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
      <p className="text-sm leading-6 text-[var(--text-secondary)]">
        Token trong đường dẫn đã được đọc và được gửi thẳng tới server (không hiển thị lại ở đây).
      </p>
      {busy ? <p className="text-sm text-[var(--text-secondary)]">Đang xác minh…</p> : null}
      {error ? (
        <p className="rounded-md border border-[var(--danger-text)] px-3 py-2 text-sm text-[var(--danger-text)]">
          {error}
          {code ? <span className="ml-2 font-mono text-xs break-all text-[var(--text-secondary)]">{code}</span> : null}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="h-10 rounded-sm bg-[var(--action)] text-sm font-semibold text-[#151618] hover:bg-[var(--action-hover)] disabled:opacity-60"
      >
        {busy ? 'Đang xác minh…' : 'Xác minh email'}
      </button>
    </section>
  );
}
