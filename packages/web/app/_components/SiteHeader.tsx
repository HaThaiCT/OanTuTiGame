'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import HeaderSession from './HeaderSession';
import ThemeToggle from './ThemeToggle';
import { fetchAuthMe } from '../../lib/api';

export default function SiteHeader() {
  const [expanded, setExpanded] = useState(false);
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const result = await fetchAuthMe();
      if (active) setRole(result.ok && result.data?.scope === 'FULL' ? result.data.user.role : null);
    };
    setRole(null);
    void refresh();
    window.addEventListener('oantuti:session-changed', refresh);
    return () => { active = false; window.removeEventListener('oantuti:session-changed', refresh); };
  }, [pathname]);
  const links = [
    { href: '/', label: 'Trang chủ' },
    { href: '/tournaments', label: 'Giải đấu' },
    { href: '/rankings', label: 'Bảng xếp hạng' },
    ...(role === 'ADMIN'
      ? [{ href: '/organizer', label: 'Ban tổ chức' }, { href: '/replays', label: 'Replay' }]
      : role === 'STUDENT'
      ? [{ href: '/workspace', label: 'Không gian đội' }]
      : []),
  ];
  return (
    <header className="arena-header">
      <div className="arena-header-row">
        <Link className="arena-wordmark" href="/" onClick={() => setExpanded(false)}>
          <span className="arena-wordmark-vct-icon" aria-hidden="true" />
          <span className="tracking-tight">OanTuTi</span>
          <span className="text-[var(--text-secondary)] font-medium text-sm ml-0.5">Arena</span>
        </Link>
        <nav className="arena-desktop-nav" aria-label="Điều hướng chính">
          {links.map(link => {
            const isCurrent = link.href === '/'
              ? pathname === '/'
              : pathname === link.href || pathname.startsWith(link.href + '/');
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isCurrent ? 'page' : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="arena-header-controls">
          <ThemeToggle />
          <HeaderSession />
        </div>
        <button
          className="arena-menu-toggle"
          type="button"
          aria-label="Mở điều hướng"
          aria-expanded={expanded}
          aria-controls="arena-mobile-nav"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '✕' : '☰'}
        </button>
      </div>
      {expanded ? (
        <div id="arena-mobile-nav" className="arena-mobile-nav">
          <nav aria-label="Điều hướng thu gọn">
            {links.map(link => {
              const isCurrent = link.href === '/'
                ? pathname === '/'
                : pathname === link.href || pathname.startsWith(link.href + '/');
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={() => setExpanded(false)}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-[var(--border-subtle)]">
            <ThemeToggle />
            <HeaderSession />
          </div>
        </div>
      ) : null}
    </header>
  );
}
