import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { c } from './tokens';

/** Seller-chosen look of the app, kept on this phone only (no account data). */
export interface Prefs {
  mode: 'system' | 'light' | 'dark';
  accent: keyof typeof ACCENTS;
  depth: '3d' | 'flat';
  startTab: 'index' | 'orders' | 'live' | 'products';
}
export const DEFAULT_PREFS: Prefs = { mode: 'system', accent: 'green', depth: '3d', startTab: 'index' };

/** Accent colours: [light-mode brand, light soft, dark-mode brand, dark soft]. All meet 4.5:1 on their surfaces. */
export const ACCENTS = {
  green: { label: 'LiveSell green', light: ['#0e7a4d', '#e7f4ee'], dark: ['#3ccf8e', '#123526'] },
  blue: { label: 'Ocean blue', light: ['#1d5fa8', '#eaf2fb'], dark: ['#6aa8ff', '#152a45'] },
  purple: { label: 'Royal purple', light: ['#6b3fc4', '#f1ebfc'], dark: ['#b291ff', '#2a1f47'] },
  orange: { label: 'Sunset orange', light: ['#b4510f', '#fdf0e6'], dark: ['#ff9d5c', '#45260f'] },
  pink: { label: 'Ankara pink', light: ['#b0306b', '#fbeaf2'], dark: ['#ff7fb6', '#46182e'] },
} as const;

const LIGHT = {
  ink: '#17201b', ink2: '#3d4842', ink3: '#66706b', line: '#e3e6e4', canvas: '#f3f5f4', surface: '#ffffff', sunken: '#eef0ef',
  good: '#0e7a4d', goodBg: '#e7f4ee', warn: '#8a5a00', warnBg: '#fdf5e3', bad: '#b42318', badBg: '#fdf0ee', info: '#1d5fa8', infoBg: '#eaf2fb',
  shadow: '#0b1f15',
};
const DARK: typeof LIGHT = {
  ink: '#eef2ef', ink2: '#c3cbc6', ink3: '#8e9893', line: '#2a332e', canvas: '#0d1210', surface: '#161d19', sunken: '#1d2521',
  good: '#4fd79a', goodBg: '#123526', warn: '#f2c35b', warnBg: '#3a2c0c', bad: '#ff8a7a', badBg: '#3d1612', info: '#7fb2ff', infoBg: '#152a45',
  shadow: '#000000',
};

const KEY = 'ls.prefs';
interface ThemeCtx { prefs: Prefs; dark: boolean; version: number; set: (p: Partial<Prefs>) => void }
const Ctx = createContext<ThemeCtx>({ prefs: DEFAULT_PREFS, dark: false, version: 0, set: () => undefined });

/** Writes the palette into the shared `c` tokens; every screen reads `c` at render time and re-renders via useTheme(). */
export function applyPalette(dark: boolean, accent: Prefs['accent'], depth: Prefs['depth']) {
  const a = ACCENTS[accent] ?? ACCENTS.green;
  const [brand, brandSoft] = dark ? a.dark : a.light;
  Object.assign(c, dark ? DARK : LIGHT, { brand, brandSoft, onBrand: dark ? '#08110c' : '#ffffff', dark, depth: depth === '3d' });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const dark = prefs.mode === 'dark' || (prefs.mode === 'system' && system === 'dark');

  useEffect(() => {
    void AsyncStorage.getItem(KEY).then((raw) => {
      if (!raw) return;
      try { setPrefs({ ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }); } catch { /* keep defaults */ }
    }).catch(() => undefined).finally(() => setReady(true));
  }, []);

  // Apply before children render with the new values (state change → this render → palette → children read `c`).
  useMemo(() => applyPalette(dark, prefs.accent, prefs.depth), [dark, prefs.accent, prefs.depth]);
  useEffect(() => setVersion((v) => v + 1), [dark, prefs.accent, prefs.depth]);

  const set = useCallback((p: Partial<Prefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      void AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, dark, version, set }), [prefs, dark, version, set]);
  // Wait for the saved look (one quick local read) so the app never flashes the wrong theme or start screen.
  return <Ctx.Provider value={value}>{ready ? children : null}</Ctx.Provider>;
}

/** Subscribe a screen to theme changes (re-render when the palette changes) and read the preferences. */
export const useTheme = () => useContext(Ctx);
