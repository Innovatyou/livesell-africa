import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { ALL_LESSONS } from '@/content/academy';

/** Which Academy lessons this seller finished, kept on the phone. */
const KEY = 'ls.academy.done';

export async function loadDone(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && ALL_LESSONS.some((l) => l.id === x)) : []);
  } catch {
    return new Set();
  }
}

export async function setDone(id: string, done: boolean): Promise<Set<string>> {
  const cur = await loadDone();
  if (done) cur.add(id); else cur.delete(id);
  await AsyncStorage.setItem(KEY, JSON.stringify([...cur])).catch(() => undefined);
  return cur;
}

/** Progress for screens; reloads when the screen is focused via `reload`. */
export function useAcademy() {
  const [done, setDoneState] = useState<Set<string>>(new Set());
  const reload = useCallback(() => { void loadDone().then(setDoneState); }, []);
  useEffect(reload, [reload]);
  const toggle = useCallback(async (id: string, on: boolean) => setDoneState(await setDone(id, on)), []);
  const total = ALL_LESSONS.length;
  return { done, toggle, reload, total, completed: done.size, next: ALL_LESSONS.find((l) => !done.has(l.id)) ?? null };
}
