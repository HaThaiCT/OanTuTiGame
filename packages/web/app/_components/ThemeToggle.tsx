'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

const choices: { value: Theme; label: string; icon: string }[] = [
  { value: 'light', label: 'Giao diện sáng', icon: '☀' },
  { value: 'dark', label: 'Giao diện tối', icon: '☾' },
  { value: 'system', label: 'Theo hệ thống', icon: '▣' },
];

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => {
      let choice: string | null = null;
      try {
        choice = localStorage.getItem('oantuti-theme');
      } catch {
        /* Keep the document choice when storage is unavailable. */
      }
      const selected: Theme =
        choice === 'light' || choice === 'system'
          ? choice
          : choice === 'dark'
            ? 'dark'
            : document.documentElement.dataset.theme === 'light'
              ? 'light'
              : 'dark';
      document.documentElement.dataset.theme =
        selected === 'system' ? (media.matches ? 'light' : 'dark') : selected;
      setTheme(selected);
    };

    sync();
    window.addEventListener('oantuti:theme-changed', sync);
    window.addEventListener('storage', sync);
    media.addEventListener('change', sync);
    return () => {
      window.removeEventListener('oantuti:theme-changed', sync);
      window.removeEventListener('storage', sync);
      media.removeEventListener('change', sync);
    };
  }, []);

  return (
    <div className="arena-theme-selector" role="group" aria-label="Giao diện trang web">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-label={choice.label}
          title={choice.label}
          aria-pressed={theme === choice.value}
          onClick={() => {
            const resolved =
              choice.value === 'system'
                ? window.matchMedia('(prefers-color-scheme: light)').matches
                  ? 'light'
                  : 'dark'
                : choice.value;
            document.documentElement.dataset.theme = resolved;
            setTheme(choice.value);
            try {
              localStorage.setItem('oantuti-theme', choice.value);
            } catch {
              /* Visual selection remains available without storage. */
            }
            window.dispatchEvent(new Event('oantuti:theme-changed'));
          }}
        >
          <span aria-hidden="true">{choice.icon}</span>
        </button>
      ))}
    </div>
  );
}
