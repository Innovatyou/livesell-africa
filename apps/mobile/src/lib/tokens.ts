/**
 * Colour tokens shared by every screen (same names as the web's globals.css). Values are replaced at runtime by the
 * theme (light/dark, accent) — see src/lib/theme.tsx; screens read them at render time and re-render via useTheme().
 */
export const c = {
  brand: '#0e7a4d', brandSoft: '#e7f4ee', onBrand: '#ffffff', ink: '#17201b', ink2: '#3d4842', ink3: '#66706b', line: '#e3e6e4', canvas: '#f3f5f4',
  surface: '#ffffff', sunken: '#eef0ef', good: '#0e7a4d', goodBg: '#e7f4ee', warn: '#8a5a00', warnBg: '#fdf5e3', bad: '#b42318', badBg: '#fdf0ee',
  info: '#1d5fa8', infoBg: '#eaf2fb', shadow: '#0b1f15', dark: false, depth: true,
};
