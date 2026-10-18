'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { probeAuthProfile, type AuthProfile } from '../../lib/api';

/**
 * Active deployment authentication profile, resolved by `probeAuthProfile()` — `GET /auth/me` when
 * a session exists, otherwise the ONLINE-only probe route (`404 PROFILE_DISABLED` ⇒ LAN_OFFLINE).
 *
 * - `undefined`: the probe is still in flight, so no screen may be shown yet;
 * - `null`: the profile could not be established (API unreachable or an unexpected answer). No
 *   ONLINE-only surface may be assumed and no success may be claimed in either direction.
 */
export function useAuthProfile(): AuthProfile | null | undefined {
  const [profile, setProfile] = useState<AuthProfile | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void probeAuthProfile().then((found) => {
      if (active) setProfile(found);
    });
    return () => {
      active = false;
    };
  }, []);
  return profile;
}

/**
 * Refusal for an ONLINE-only screen opened in a `LAN_OFFLINE` deployment. It is rendered only from
 * the API's own answer — 404 `PROFILE_DISABLED` (`packages/server/src/identity/routes.ts`) — never
 * from an assumption, and `message` is the raw body the API sent so the reason stays quotable.
 */
export function OnlineOnlyNotice({ message }: { message?: string | null }) {
  return (
    <section className="rounded-xl border border-[var(--warning-text)] bg-[var(--surface)] p-6">
      <h2 className="text-lg font-bold text-[var(--warning-text)]">Tính năng chỉ dành cho cấu hình ONLINE</h2>
      <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
        Server này chạy cấu hình xác thực{' '}
        <span className="font-mono text-[var(--text-primary)]">LAN_OFFLINE</span> nên tuyến đường trả về{' '}
        <span className="font-mono text-[var(--text-primary)]">404 PROFILE_DISABLED</span> và không thực hiện thao tác nào.
        Tài khoản LAN do ban tổ chức cấp: không có đăng ký tự phục vụ, xác minh email hay khôi phục mật khẩu qua email.
      </p>
      {message ? (
        <p className="mt-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-2 font-mono text-xs break-words text-[var(--text-secondary)]">
          {message}
        </p>
      ) : null}
      <Link
        href="/workspace"
        className="mt-4 inline-block rounded-md border border-[var(--border-control)] px-4 py-2 text-sm font-medium hover:border-[var(--action)]"
      >
        Về trang đăng nhập →
      </Link>
    </section>
  );
}

/** Neutral placeholder while the profile probe runs, so no flow is offered before it is known. */
export function ProfileProbeNotice() {
  return (
    <p className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
      Đang kiểm tra cấu hình xác thực của server…
    </p>
  );
}
