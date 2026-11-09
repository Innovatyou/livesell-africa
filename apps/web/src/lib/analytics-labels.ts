/** Analytics display helpers (pure, tested). Rates arrive as integer basis points. */

export function rate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  return `${(bps / 100).toFixed(1)}%`;
}

/** "+12.5%" / "−3.0%" / "new" (previous was zero) / "no change". */
export function changeLabel(changeBps: number | null, change: number | string): string {
  const c = BigInt(change);
  if (c === 0n) return 'no change';
  if (changeBps === null) return 'new';
  return `${changeBps > 0 ? '+' : '−'}${(Math.abs(changeBps) / 100).toFixed(1)}%`;
}

export function changeTone(change: number | string, higherIsBetter = true): 'good' | 'bad' | 'neutral' {
  const c = BigInt(change);
  if (c === 0n) return 'neutral';
  return (c > 0n) === higherIsBetter ? 'good' : 'bad';
}

/** Local (WAT, UTC+1) YYYY-MM-DD for an instant. */
export function lagosDay(d: Date): string {
  return new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
}

export type Preset = '7d' | '30d' | '90d' | 'month' | 'last_month' | 'year';
export const PRESETS: Array<[Preset, string]> = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['month', 'This month'], ['last_month', 'Last month'], ['year', 'Last 12 months']];

/** Date range for a preset, ending today (Lagos). */
export function presetRange(p: Preset, now = new Date()): { from: string; to: string } {
  const today = lagosDay(now);
  const [y, m] = today.split('-').map(Number);
  const back = (days: number) => lagosDay(new Date(now.getTime() - days * 86_400_000));
  switch (p) {
    case '7d': return { from: back(6), to: today };
    case '30d': return { from: back(29), to: today };
    case '90d': return { from: back(89), to: today };
    case 'year': return { from: back(364), to: today };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const first = new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
    }
  }
}
