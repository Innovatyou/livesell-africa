import { describe, expect, it } from 'vitest';
import { changeLabel, changeTone, lagosDay, presetRange, rate } from './analytics-labels';
import { deliveryActionLabel, splitList } from './delivery-labels';

describe('analytics labels', () => {
  it('shows rates and changes without inventing numbers', () => {
    expect(rate(6667)).toBe('66.7%');
    expect(rate(null)).toBe('—');
    expect(changeLabel(5000, '7500000')).toBe('+50.0%');
    expect(changeLabel(-6667, -2)).toBe('−66.7%');
    expect(changeLabel(null, 5)).toBe('new');
    expect(changeLabel(null, 0)).toBe('no change');
    expect(changeTone('-1')).toBe('bad');
    expect(changeTone(3)).toBe('good');
    expect(changeTone(3, false)).toBe('bad');
  });

  it('presets are Lagos calendar days ending today', () => {
    const now = new Date('2026-11-06T23:30:00Z'); // already 7 Nov in Lagos
    expect(lagosDay(now)).toBe('2026-11-07');
    expect(presetRange('7d', now)).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    expect(presetRange('month', now)).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    expect(presetRange('last_month', now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('last_month', new Date('2026-01-15T10:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('delivery labels', () => {
  it('pickup is collected, not delivered', () => {
    expect(deliveryActionLabel('DELIVERED', 'PICKUP')).toBe('Mark collected');
    expect(deliveryActionLabel('DELIVERED', 'THIRD_PARTY')).toBe('Mark delivered');
    expect(deliveryActionLabel('IN_TRANSIT', 'SELLER_DELIVERY')).toBe('Mark on the way');
  });
  it('splits typed lists of states or cities', () => {
    expect(splitList(' Lagos, ogun\nLAGOS , ,Oyo  State ')).toEqual(['Lagos', 'ogun', 'Oyo State']);
    expect(splitList('')).toEqual([]);
  });
});

describe('order patterns grid', () => {
  it('turns sparse cells into a 7 × 24 grid with the busiest count', async () => {
    const { patternGrid } = await import('@/components/analytics-advanced');
    const { grid, max } = patternGrid([{ weekday: 1, hour: 20, orders: 3, paidOrders: 2, grossSalesMinor: '1' }, { weekday: 7, hour: 0, orders: 1, paidOrders: 0, grossSalesMinor: '0' }]);
    expect(grid).toHaveLength(7);
    expect(grid[0]).toHaveLength(24);
    expect(grid[0][20]).toBe(3);
    expect(grid[6][0]).toBe(1);
    expect(max).toBe(3);
  });
});
