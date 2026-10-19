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
  const links = [{ href: '/', label: 'Giải đấu' }, { href: '/rankings', label: 'Xếp hạng đội' }, ...(role === 'ADMIN' ? [{ href: '/organizer', label: 'Ban tổ chức' }, { href: '/replays', label: 'Replay' }] : role === 'STUDENT' ? [{ href: '/workspace', label: 'Không gian đội' }] : [])];
  return (
    <header className="arena-header">
      <div className="arena-header-row">
        <Link className="arena-wordmark" href="/" onClick={() => setExpanded(false)}>oantuti-arena</Link>
        <nav className="arena-desktop-nav" aria-label="Điều hướng chính">
          {links.map(link => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined}>{link.label}</Link>)}
        </nav>
        <div className="arena-header-controls"><ThemeToggle /><HeaderSession /></div>
        <button className="arena-menu-toggle" type="button" aria-label="Mở điều hướng" aria-expanded={expanded} aria-controls="arena-mobile-nav" onClick={() => setExpanded(!expanded)}>{expanded ? '−' : '⌄'}</button>
      </div>
      {expanded ? <div id="arena-mobile-nav" className="arena-mobile-nav"><nav aria-label="Điều hướng thu gọn">{links.map(link => <Link key={link.href} href={link.href} onClick={() => setExpanded(false)}>{link.label}</Link>)}</nav><div className="flex flex-wrap items-center gap-3"><ThemeToggle /><HeaderSession /></div></div> : null}
    </header>
  );
}
