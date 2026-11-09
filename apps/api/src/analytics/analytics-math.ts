/**
 * Analytics helpers (MASTER-SPEC §19). Pure, unit-tested.
 *
 * Reporting days are West Africa Time (UTC+1, no daylight saving), the same as the dashboard. A range is whole
 * local days, `from` and `to` inclusive. Rates are integer basis points (1 % = 100 bps) so nothing is a float.
 */
export const LAGOS_OFFSET = '+01:00';
export const MAX_RANGE_DAYS = 366;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Bucket = 'day' | 'week' | 'month';

export interface Range {
  from: string; // YYYY-MM-DD (local, inclusive)
  to: string; // YYYY-MM-DD (local, inclusive)
  start: Date; // UTC instant of `from` 00:00 local
  end: Date; // UTC instant of the day after `to`, 00:00 local (exclusive)
  days: number;
  bucket: Bucket;
  previous: { from: string; to: string; start: Date; end: Date };
}

export class RangeError400 extends Error {}

const localDay = (d: Date) => new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00${LAGOS_OFFSET}`);

/** Parse `from`/`to`; default the last 30 days ending today (local). */
export function parseRange(from: string | undefined, to: string | undefined, now = new Date()): Range {
  const today = localDay(now);
  const t = to ?? today;
  const f = from ?? localDay(new Date(startOf(t).getTime() - 29 * DAY));
  for (const v of [f, t]) {
    if (!DATE.test(v) || Number.isNaN(startOf(v).getTime()) || localDay(startOf(v)) !== v) throw new RangeError400(`Invalid date ${v}; use YYYY-MM-DD`);
  }
  if (f > t) throw new RangeError400('`from` is after `to`');
  if (t > today) throw new RangeError400('`to` is in the future');
  const start = startOf(f);
  const end = new Date(startOf(t).getTime() + DAY);
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  if (days > MAX_RANGE_DAYS) throw new RangeError400(`A report covers at most ${MAX_RANGE_DAYS} days`);
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - days * DAY);
  return {
    from: f, to: t, start, end, days,
    bucket: days <= 62 ? 'day' : days <= 190 ? 'week' : 'month',
    previous: { from: localDay(prevStart), to: localDay(new Date(prevEnd.getTime() - DAY)), start: prevStart, end: prevEnd },
  };
}

/** n / d in basis points, rounded; null when there is nothing to divide by. */
export function bps(n: number | bigint, d: number | bigint): number | null {
  const N = BigInt(n);
  const D = BigInt(d);
  if (D <= 0n) return null;
  return Number((N * 20_000n + D) / (2n * D)); // round half up
}

/** Change against the previous period: absolute and relative (bps of the previous value; null when it was 0). */
export function delta(current: number | bigint, previous: number | bigint) {
  const c = BigInt(current);
  const p = BigInt(previous);
  const change = c - p;
  const rel = p === 0n ? null : Number(((change * 20_000n) + (change >= 0n ? p : -p)) / (2n * (p < 0n ? -p : p)));
  return { previous: typeof current === 'bigint' ? p : Number(p), change: typeof current === 'bigint' ? change : Number(change), changeBps: rel };
}

/** "₦" isn't in the PDF standard fonts; reports say NGN 25,000.00. */
export function money(minor: bigint | string, currency = 'NGN') {
  const v = BigInt(minor);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${currency} ${whole}.${(a % 100n).toString().padStart(2, '0')}`;
}

/** Plan tiers (`features.analytics`): what each unlocks. */
export type Tier = 'standard' | 'advanced';
export const TIER_LIMITS: Record<Tier, { maxDays: number; pdf: boolean; patterns: boolean; topCustomers: boolean; schedules: boolean }> = {
  standard: { maxDays: 92, pdf: false, patterns: false, topCustomers: false, schedules: false },
  advanced: { maxDays: MAX_RANGE_DAYS, pdf: true, patterns: true, topCustomers: true, schedules: true },
};
export function tierOf(level: unknown): Tier | null {
  if (!level) return null;
  return level === 'advanced' ? 'advanced' : 'standard';
}

/** The last complete Monday–Sunday week (Lagos) before `now`, labelled with its ISO week. */
export function lastCompleteWeek(now: Date) {
  const today = localDay(now);
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(d.getTime() - dow * DAY);
  const from = new Date(thisMonday.getTime() - 7 * DAY);
  const to = new Date(thisMonday.getTime() - DAY);
  // ISO week number of `from` (its Thursday decides the year).
  const thursday = new Date(from.getTime() + 3 * DAY);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const nice = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(from);
  return { from: iso(from), to: iso(to), label: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, periodLabel: `Week of ${nice}` };
}

/** The last complete calendar month (Lagos) before `now`. */
export function lastCompleteMonth(now: Date) {
  const [y, m] = localDay(now).split('-').map(Number);
  const first = new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last), label: iso(first).slice(0, 7), periodLabel: new Intl.DateTimeFormat('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first) };
}

/** Lagos hour of `now` (0–23). */
export const lagosHour = (now: Date) => new Date(now.getTime() + 3_600_000).getUTCHours();

export const pct = (b: number | null) => (b === null ? '—' : `${(b / 100).toFixed(1)}%`);
