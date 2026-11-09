import { addInterval, comparePerMonth, daysUntil, priceFor, quoteChange, reminderThreshold } from './billing-math';
import { limitViolations } from './entitlements.service';
import { validateFeatures } from './plans.service';

const d = (s: string) => new Date(s);

describe('billing math', () => {
  it('adds calendar months/years in UTC, clamping to month end', () => {
    expect(addInterval(d('2026-01-31T10:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addInterval(d('2028-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addInterval(d('2026-11-05T09:30:00Z'), 'MONTHLY').toISOString()).toBe('2026-12-05T09:30:00.000Z');
    expect(addInterval(d('2026-12-15T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(addInterval(d('2028-02-29T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });

  it('compares plans per month without floats', () => {
    expect(comparePerMonth(1_200_000n, 'MONTHLY', 500_000n, 'MONTHLY')).toBe(1);
    expect(comparePerMonth(5_000_000n, 'ANNUAL', 500_000n, 'MONTHLY')).toBe(-1); // ₦50k/yr < ₦5k/mo
    expect(comparePerMonth(6_000_000n, 'ANNUAL', 500_000n, 'MONTHLY')).toBe(0);
  });

  it('returns null for custom-priced plans', () => {
    expect(priceFor({ monthlyPriceMinor: null, annualPriceMinor: null }, 'MONTHLY')).toBeNull();
    expect(priceFor({ monthlyPriceMinor: 1n, annualPriceMinor: 10n }, 'ANNUAL')).toBe(10n);
  });

  describe('plan change quotes', () => {
    const periodStart = d('2026-11-01T00:00:00Z');
    const periodEnd = d('2026-12-01T00:00:00Z'); // 30 days

    it('same-interval upgrade charges the prorated difference, rounded up to the kobo, period unchanged', () => {
      const now = d('2026-11-16T00:00:00Z'); // exactly half the period left
      const q = quoteChange({ currentPrice: 500_000n, currentInterval: 'MONTHLY', targetPrice: 1_200_000n, targetInterval: 'MONTHLY', periodStart, periodEnd, now });
      expect(q.timing).toBe('immediate');
      expect(q.amountMinor).toBe(350_000n); // (1,200,000 − 500,000) × 15/30
      expect(q.periodEnd).toEqual(periodEnd);

      const odd = quoteChange({ currentPrice: 500_000n, currentInterval: 'MONTHLY', targetPrice: 1_200_001n, targetInterval: 'MONTHLY', periodStart, periodEnd, now: d('2026-11-21T00:00:00Z') });
      expect(odd.amountMinor).toBe(233_334n); // 700,001 × 10/30 = 233,333.67 → ceil
    });

    it('monthly → annual upgrade starts a new year and credits unused time, never below zero', () => {
      const now = d('2026-11-16T00:00:00Z');
      const q = quoteChange({ currentPrice: 1_200_000n, currentInterval: 'MONTHLY', targetPrice: 25_000_000n, targetInterval: 'ANNUAL', periodStart, periodEnd, now });
      expect(q.timing).toBe('immediate');
      expect(q.amountMinor).toBe(25_000_000n - 600_000n);
      expect(q.periodStart).toEqual(now);
      expect(q.periodEnd.toISOString()).toBe('2027-11-16T00:00:00.000Z');
    });

    it('downgrades, equal prices and annual → monthly are scheduled for period end at no charge', () => {
      const now = d('2026-11-10T00:00:00Z');
      for (const [cp, ci, tp, ti] of [
        [1_200_000n, 'MONTHLY', 500_000n, 'MONTHLY'],
        [6_000_000n, 'ANNUAL', 500_000n, 'MONTHLY'],
        [5_000_000n, 'ANNUAL', 2_500_000n, 'MONTHLY'], // more per month, but annual → monthly waits
      ] as const) {
        const q = quoteChange({ currentPrice: cp, currentInterval: ci, targetPrice: tp, targetInterval: ti, periodStart, periodEnd, now });
        expect(q.timing).toBe('period_end');
        expect(q.amountMinor).toBe(0n);
        expect(q.periodStart).toEqual(periodEnd);
      }
    });

    it('an upgrade requested after the period end charges nothing extra for the elapsed period', () => {
      const q = quoteChange({ currentPrice: 500_000n, currentInterval: 'MONTHLY', targetPrice: 1_200_000n, targetInterval: 'MONTHLY', periodStart, periodEnd, now: d('2026-12-05T00:00:00Z') });
      expect(q.amountMinor).toBe(0n);
    });
  });

  it('counts days left rounding up and picks the right reminder threshold once', () => {
    const now = d('2026-11-05T12:00:00Z');
    expect(daysUntil(d('2026-11-06T11:00:00Z'), now)).toBe(1);
    expect(daysUntil(d('2026-11-12T12:00:00Z'), now)).toBe(7);
    expect(reminderThreshold(7, [7, 3, 1])).toBe(7);
    expect(reminderThreshold(5, [7, 3, 1])).toBe(7);
    expect(reminderThreshold(2, [1, 3, 7])).toBe(3); // skips the stale 7-day reminder
    expect(reminderThreshold(1, [7, 3, 1])).toBe(1);
    expect(reminderThreshold(8, [7, 3, 1])).toBeNull();
    expect(reminderThreshold(-1, [7, 3, 1])).toBeNull();
  });
});

describe('plan limits and features', () => {
  it('flags usage above limits; null means unlimited', () => {
    expect(limitViolations({ staff: 1, products: 50 }, { staff: 3, products: 10 })).toEqual([{ limit: 'staff', allowed: 1, used: 3 }]);
    expect(limitViolations({ staff: null, products: null }, { staff: 300, products: 9000 })).toEqual([]);
  });

  it('accepts short flags and labels, rejects anything else', () => {
    expect(() => validateFeatures({ whatsappNotifications: true, analytics: 'standard' })).not.toThrow();
    expect(() => validateFeatures({ 'bad key': true })).toThrow();
    expect(() => validateFeatures({ analytics: { nested: true } })).toThrow();
    expect(() => validateFeatures({ label: 'x'.repeat(41) })).toThrow();
  });
});
