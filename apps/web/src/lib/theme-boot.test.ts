import { describe, expect, it } from 'vitest';
import { THEME_BOOT } from '@/components/theme-toggle';

/** The inline pre-paint script: applies only a saved light/dark choice, ignores anything else, never throws. */
function boot(saved: string | null, throws = false) {
  const root = { dataset: {} as Record<string, string> };
  const localStorage = { getItem: () => { if (throws) throw new Error('blocked'); return saved; } };
  new Function('localStorage', 'document', THEME_BOOT)(localStorage, { documentElement: root });
  return root.dataset.theme;
}

describe('theme boot script', () => {
  it('applies a saved light or dark choice before paint', () => {
    expect(boot('dark')).toBe('dark');
    expect(boot('light')).toBe('light');
  });
  it('leaves the device setting in charge otherwise, and survives blocked storage', () => {
    expect(boot(null)).toBeUndefined();
    expect(boot('"><script>')).toBeUndefined();
    expect(boot('dark', true)).toBeUndefined();
  });
});
