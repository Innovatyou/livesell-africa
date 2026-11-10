/// <reference types="jest" />
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
import { applyPalette, ACCENTS } from './theme';
import { c } from './tokens';

describe('theme', () => {
  it('dark mode swaps every surface and text colour; accents follow the mode; flat turns depth off', () => {
    applyPalette(false, 'green', '3d');
    const light = { ...c };
    applyPalette(true, 'blue', 'flat');
    expect(c.dark).toBe(true);
    expect(c.depth).toBe(false);
    for (const k of ['canvas', 'surface', 'ink', 'ink2', 'ink3', 'line'] as const) expect(c[k]).not.toBe(light[k]);
    expect(c.brand).toBe(ACCENTS.blue.dark[0]);
    applyPalette(false, 'purple', '3d');
    expect(c.brand).toBe(ACCENTS.purple.light[0]);
    expect(c.onBrand).toBe('#ffffff');
  });

  it('an unknown saved accent falls back to LiveSell green', () => {
    applyPalette(false, 'nope' as never, '3d');
    expect(c.brand).toBe(ACCENTS.green.light[0]);
  });
});
