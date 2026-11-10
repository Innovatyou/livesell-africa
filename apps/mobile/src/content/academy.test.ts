/// <reference types="jest" />
// Jest runs in Node; the app's tsconfig has no Node types, so declare the two helpers used here.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { existsSync } = require('fs') as { existsSync: (p: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join } = require('path') as { join: (...p: string[]) => string };

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ALL_LESSONS, TRACKS } = require('./academy') as typeof import('./academy');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadDone, setDone } = require('@/lib/academy-progress') as typeof import('@/lib/academy-progress');

const APP = join(__dirname, '..', 'app');
/** Does an Expo Router href point at a real screen file? ("/orders?view=x" → (tabs)/orders.tsx) */
function routeExists(href: string) {
  const path = href.split('?')[0].replace(/^\//, '');
  const candidates = [`${path}.tsx`, `${path}/index.tsx`, `(tabs)/${path}.tsx`];
  if (/^products\/new$|^live\/new$/.test(path)) candidates.push(path.replace('/new', '/[id].tsx'), `${path}.tsx`);
  return candidates.some((c) => existsSync(join(APP, c)));
}

describe('LiveSell Academy content', () => {
  it('has unique lesson ids, real steps and valid quiz answers', () => {
    const ids = ALL_LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TRACKS.map((t) => t.id)).toEqual(expect.arrayContaining(['start', 'tiktok', 'instagram', 'facebook', 'whatsapp']));
    for (const l of ALL_LESSONS) {
      expect(l.steps.length).toBeGreaterThanOrEqual(2);
      expect(l.minutes).toBeGreaterThan(0);
      if (l.check) {
        expect(l.check.answer).toBeGreaterThanOrEqual(0);
        expect(l.check.answer).toBeLessThan(l.check.options.length);
      }
    }
  });

  it('every “do it now” button opens a screen that exists', () => {
    for (const l of ALL_LESSONS) for (const a of l.actions ?? []) expect([a.href, routeExists(a.href)]).toEqual([a.href, true]);
  });

  it('remembers finished lessons on the phone and ignores unknown ids', async () => {
    await setDone('start-how', true);
    await setDone('not-a-lesson', true);
    expect([...(await loadDone())]).toEqual(['start-how']);
    await setDone('start-how', false);
    expect((await loadDone()).size).toBe(0);
  });
});
