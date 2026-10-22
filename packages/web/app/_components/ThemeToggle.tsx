'use client';

import { useEffect, useState } from 'react';
import { getStoredBgMode, setStoredBgMode, type BgMode } from './BackgroundSystem';
type Theme = 'dark' | 'light' | 'system';
const choices: { value: Theme; label: string; icon: string }[] = [
  { value: 'light', label: 'Giao diện sáng', icon: '☀' },
  { value: 'dark', label: 'Giao diện tối', icon: '☾' },
  { value: 'system', label: 'Theo hệ thống', icon: '▣' },
];
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [bgMode, setBgMode] = useState<BgMode>('solid');

  useEffect(() => {
    const syncBg = () => setBgMode(getStoredBgMode());
    syncBg();
    window.addEventListener('oantuti:bg-changed', syncBg);
    return () => window.removeEventListener('oantuti:bg-changed', syncBg);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => {
      let choice: string | null = null;
      try { choice = localStorage.getItem('oantuti-theme'); } catch { /* Keep the document choice when storage is unavailable. */ }
      const selected: Theme = choice === 'light' || choice === 'system' ? choice : choice === 'dark' ? 'dark' : document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = selected === 'system' ? (media.matches ? 'light' : 'dark') : selected;
      setTheme(selected);
    };
    sync();
    window.addEventListener('oantuti:theme-changed', sync);
    window.addEventListener('storage', sync);
    media.addEventListener('change', sync);
    return () => { window.removeEventListener('oantuti:theme-changed', sync); window.removeEventListener('storage', sync); media.removeEventListener('change', sync); };
  }, []);
  return <div className="arena-theme-selector" role="group" aria-label="Giao diện trang web">{choices.map(choice => <button key={choice.value} type="button" aria-label={choice.label} title={choice.label} aria-pressed={theme === choice.value} onClick={() => {
    const resolved = choice.value === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : choice.value;
    document.documentElement.dataset.theme = resolved;
    setTheme(choice.value);
    try { localStorage.setItem('oantuti-theme', choice.value); } catch { /* Visual selection remains available without storage. */ }
    window.dispatchEvent(new Event('oantuti:theme-changed'));
  }}><span aria-hidden="true">{choice.icon}</span></button>)}
      <button
        type="button"
        aria-label={bgMode === 'solid' ? 'Bật hiệu ứng animation nền' : 'Chuyển về nền trơn'}
        title={bgMode === 'solid' ? 'Nền: Trơn (Bấm để bật hiệu ứng sao công nghệ)' : 'Nền: Hiệu ứng động (Bấm để chuyển về nền trơn basic)'}
        aria-pressed={bgMode === 'animation'}
        onClick={() => {
          const next = bgMode === 'solid' ? 'animation' : 'solid';
          setBgMode(next);
          setStoredBgMode(next);
        }}
        className="px-2 text-xs font-mono font-bold border-l border-[var(--border-subtle)] hover:text-[var(--text-primary)] transition-colors"
      >
        <span aria-hidden="true">{bgMode === 'animation' ? '✦' : '—'}</span>
      </button>
    </div>;
}
