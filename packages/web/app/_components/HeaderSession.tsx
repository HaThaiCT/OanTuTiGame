'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { fetchAuthMe, logout } from '../../lib/api';

/**
 * Session-aware header control. The rest of the layout stays static: this component asks
 * `/api/v2/auth/me` from the browser, so a signed-in visitor no longer sees “Đăng nhập”, and a
 * signed-out one never sees a name that the server session no longer backs.
 */
export default function HeaderSession() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<{ displayName: string; role: string; scope: string } | null>(null);
  const [known, setKnown] = useState(false);
  const [pending, setPending] = useState(false);

  async function refresh() {
    const result = await fetchAuthMe();
    if (result.ok && result.data) {
      setUser({ displayName: result.data.user.displayName || result.data.user.username, role: result.data.user.role, scope: result.data.scope });
    } else {
      setUser(null);
    }
    setKnown(true);
  }

  useEffect(() => {
    void refresh();
  }, [pathname]);

  useEffect(() => {
    // Sign-in/sign-out happens inside pages that share this layout; they announce the change.
    const handler = () => void refresh();
    window.addEventListener('oantuti:session-changed', handler);
    return () => window.removeEventListener('oantuti:session-changed', handler);
  }, []);

  async function signOut() {
    setPending(true);
    await logout();
    setPending(false);
    setUser(null);
    window.dispatchEvent(new Event('oantuti:session-changed'));
    router.refresh();
  }

  if (!known) {
    // Reserve the space so the header does not jump once the session is known.
    return <span className="h-8 w-24 rounded-full border border-[var(--border-control)] opacity-30" aria-hidden />;
  }

  if (user === null) {
    return (
      <Link
        href="/workspace"
        className="vct-btn-primary !py-1.5 !px-4 !text-xs !rounded-full"
      >
        Đăng nhập
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href={user.scope === 'FULL' && user.role === 'ADMIN' ? '/organizer' : '/workspace'}
        className="inline-flex items-center gap-2 border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider rounded-full hover:border-[var(--action)] transition-all shadow-sm"
        title={user.role === 'ADMIN' ? 'Ban tổ chức' : 'Không gian đội'}
      >
        <span className="text-[var(--action)] text-xs">●</span>
        {user.displayName}
      </Link>
      <button
        type="button"
        disabled={pending}
        onClick={() => void signOut()}
        className="border border-[var(--border-control)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] rounded-full hover:border-[var(--danger-text)] hover:text-[var(--danger-text)] disabled:opacity-60 cursor-pointer transition-colors"
      >
        {pending ? '...' : 'Đăng xuất'}
      </button>
    </div>
  );
}
