'use client';

import { useEffect, useState } from 'react';
import { cx } from './ui';

type Mode = 'system' | 'light' | 'dark';
const KEY = 'ls.theme';

/** Runs before first paint (inlined in app/layout.tsx) so the page never flashes the wrong theme. */
export const THEME_BOOT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

function apply(mode: Mode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch { /* private mode: still applies for this visit */ }
}

/** System / Light / Dark switch. Saved in this browser only. */
export function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<Mode>('system');
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setMode(t === 'light' || t === 'dark' ? t : 'system');
  }, []);
  const options: Array<[Mode, string, string]> = [['system', 'Auto', 'Match device'], ['light', 'Light', 'Light theme'], ['dark', 'Dark', 'Dark theme']];
  return (
    <div role="radiogroup" aria-label="Theme" className={cx('inline-flex rounded-full border border-line bg-sunken p-0.5 text-xs', className)}>
      {options.map(([m, label, title]) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} title={title} onClick={() => { setMode(m); apply(m); }}
          className={cx('rounded-full px-2.5 py-1 font-medium transition-colors', mode === m ? 'bg-surface text-ink shadow-[var(--shadow-card)]' : 'text-ink-3 hover:text-ink')}>
          {label}
        </button>
      ))}
    </div>
  );
}
