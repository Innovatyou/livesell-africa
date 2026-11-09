/**
 * Pure billing arithmetic. All money is BigInt minor units (kobo); no floats anywhere.
 */
export type Interval = 'MONTHLY' | 'ANNUAL';

export interface PricedPlan {
  monthlyPriceMinor: bigint | null;
  annualPriceMinor: bigint | null;
}

const MONTHS: Record<Interval, bigint> = { MONTHLY: 1n, ANNUAL: 12n };

/** Calendar arithmetic in UTC, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
export function addInterval(from: Date, interval: Interval, count = 1): Date {
  const months = interval === 'MONTHLY' ? count : 12 * count;
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function priceFor(plan: PricedPlan, interval: Interval): bigint | null {
  return interval === 'MONTHLY' ? plan.monthlyPriceMinor : plan.annualPriceMinor;
}

/**
 * Compares price per month without dividing: a/ma vs b/mb  ⇔  a·mb vs b·ma.
 * Returns -1, 0 or 1. Plans without a price (custom/Enterprise) cannot be compared.
 */
export function comparePerMonth(aPrice: bigint, aInterval: Interval, bPrice: bigint, bInterval: Interval): -1 | 0 | 1 {
  const left = aPrice * MONTHS[bInterval];
  const right = bPrice * MONTHS[aInterval];
  return left === right ? 0 : left > right ? 1 : -1;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export type ChangeTiming = 'immediate' | 'period_end';

export interface ChangeQuote {
  timing: ChangeTiming;
  /** Amount due now (0 for period-end changes). */
  amountMinor: bigint;
  /** Period the immediate invoice covers / the new period after payment. */
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Decides how a paid plan change on an ACTIVE subscription is handled.
 *
 * - Upgrade, same interval: immediate; charge the price difference for the rest of the current period
 *   (rounded up to the kobo), period end unchanged.
 * - Upgrade from monthly to annual: immediate; new annual period starts now; unused monthly time is credited
 *   (rounded down), never below zero.
 * - Downgrades, same-price changes and any annual → monthly change: at the end of the current period, no charge.
 */
export function quoteChange(input: {
  currentPrice: bigint; currentInterval: Interval;
  targetPrice: bigint; targetInterval: Interval;
  periodStart: Date; periodEnd: Date; now: Date;
}): ChangeQuote {
  const { currentPrice, currentInterval, targetPrice, targetInterval, periodStart, periodEnd, now } = input;
  const atPeriodEnd: ChangeQuote = { timing: 'period_end', amountMinor: 0n, periodStart: periodEnd, periodEnd: addInterval(periodEnd, targetInterval) };

  const cmp = comparePerMonth(targetPrice, targetInterval, currentPrice, currentInterval);
  if (cmp <= 0) return atPeriodEnd;
  if (currentInterval === 'ANNUAL' && targetInterval === 'MONTHLY') return atPeriodEnd;

  const total = BigInt(Math.max(1, periodEnd.getTime() - periodStart.getTime()));
  const remaining = BigInt(Math.min(Math.max(0, periodEnd.getTime() - now.getTime()), Number(total)));

  if (currentInterval === targetInterval) {
    const diff = targetPrice - currentPrice;
    return { timing: 'immediate', amountMinor: ceilDiv(diff * remaining, total), periodStart: now, periodEnd };
  }
  // MONTHLY → ANNUAL
  const credit = (currentPrice * remaining) / total;
  const due = targetPrice - credit;
  return { timing: 'immediate', amountMinor: due > 0n ? due : 0n, periodStart: now, periodEnd: addInterval(now, targetInterval) };
}

/** Whole days until `end`, rounded up (a reminder "1 day left" fires within the last 24h). */
export function daysUntil(end: Date, now: Date): number {
  return Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Which reminder threshold applies now, if any: the smallest configured threshold ≥ days left.
 * Thresholds already passed are skipped, so a late run never sends "7 days" when 2 days remain.
 */
export function reminderThreshold(daysLeft: number, thresholds: number[]): number | null {
  if (daysLeft < 0) return null;
  const sorted = [...new Set(thresholds)].filter((t) => t > 0).sort((a, b) => a - b);
  return sorted.find((t) => daysLeft <= t) ?? null;
}
