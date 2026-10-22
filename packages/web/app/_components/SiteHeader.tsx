'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import HeaderSession from './HeaderSession';
import ThemeToggle from './ThemeToggle';
import { fetchAuthMe } from '../../lib/api';
import UetLogo from './UetLogo';

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
  if (pathname?.startsWith('/projector/')) return null;
  const links = [
    { href: '/', label: 'Trang chủ' },
    { href: '/tournaments', label: 'Giải đấu' },
    { href: '/rankings', label: 'Bảng xếp hạng' },
    ...(role === 'ADMIN'
      ? [
          { href: '/organizer', label: 'Ban tổ chức' },
          { href: '/replays', label: 'Replay' },
          { href: '/account', label: 'Hồ sơ' },
        ]
      : role !== null
      ? [{ href: '/account', label: 'Hồ sơ' }]
      : []),
  ];
  return (
    <header className="arena-header">
      <div className="arena-header-row">
        <Link className="arena-wordmark group" href="/" onClick={() => setExpanded(false)} title="OanTuTi Arena — Trường Đại học Công nghệ, ĐHQGHN">
          <UetLogo size={32} priority />
          <div className="flex flex-col leading-tight">
            <div className="flex items-baseline gap-1">
              <span className="tracking-tight text-lg font-black font-heading text-[var(--text-primary)]">OanTuTi</span>
              <span className="text-[var(--action)] font-bold text-xs uppercase tracking-wider font-mono">Arena</span>
            </div>
            <span className="text-[10px] font-mono tracking-tight text-[var(--text-secondary)] font-medium">UET · ĐHQGHN</span>
          </div>
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
