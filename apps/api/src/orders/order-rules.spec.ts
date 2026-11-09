import { canTransition, commitsStock, computeTotals, fulfilmentStatusFor, nextUserStatuses, orderReference, paymentStatusFor, TotalsError } from './order-rules';

describe('order rules', () => {
  it('people can never mark an order paid, verified or refunded — only the payment system can', () => {
    for (const from of ['DRAFT', 'PENDING_PAYMENT', 'PAYMENT_VERIFICATION'] as const) {
      expect(canTransition(from, 'PAID', 'user')).toBe(false);
    }
    expect(canTransition('PENDING_PAYMENT', 'PAYMENT_VERIFICATION', 'user')).toBe(false);
    expect(canTransition('DELIVERED', 'REFUNDED', 'user')).toBe(false);
    expect(canTransition('PENDING_PAYMENT', 'PAID', 'system')).toBe(true);
    expect(canTransition('PAYMENT_VERIFICATION', 'PAID', 'system')).toBe(true);
  });

  it('fulfilment moves forward (may skip steps) but never back; paid orders cannot simply be cancelled', () => {
    expect(nextUserStatuses('PAID')).toEqual(['PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED']);
    expect(canTransition('DISPATCHED', 'PROCESSING', 'user')).toBe(false);
    expect(canTransition('PAID', 'CANCELLED', 'user')).toBe(false); // needs a refund (Phase 5)
    expect(nextUserStatuses('DRAFT')).toEqual(['PENDING_PAYMENT', 'CANCELLED']);
    expect(nextUserStatuses('PENDING_PAYMENT')).toEqual(['CANCELLED']);
    expect(nextUserStatuses('CANCELLED')).toEqual([]);
    expect(nextUserStatuses('DELIVERED')).toEqual([]);
    expect(commitsStock('DISPATCHED')).toBe(true);
    expect(commitsStock('PROCESSING')).toBe(false);
  });

  it('keeps payment and fulfilment statuses in step with the order status', () => {
    expect(paymentStatusFor('PENDING_PAYMENT', 'UNPAID')).toBe('PENDING');
    expect(paymentStatusFor('PAYMENT_VERIFICATION', 'PENDING')).toBe('AWAITING_VERIFICATION');
    expect(paymentStatusFor('DISPATCHED', 'PAID')).toBe('PAID');
    expect(paymentStatusFor('CANCELLED', 'PENDING')).toBe('UNPAID');
    expect(fulfilmentStatusFor('READY_FOR_DISPATCH', 'UNFULFILLED')).toBe('READY');
    expect(fulfilmentStatusFor('CANCELLED', 'UNFULFILLED')).toBe('UNFULFILLED');
  });

  it('computes totals in kobo and rejects impossible discounts', () => {
    const t = computeTotals([{ unitPriceMinor: 2_500_000n, quantity: 2, discountMinor: 100_000n }, { unitPriceMinor: 1_850_000n, quantity: 1, discountMinor: 0n }], 50_000n, 150_000n);
    expect(t.items.map((l) => l.lineTotalMinor)).toEqual([4_900_000n, 1_850_000n]);
    expect(t).toMatchObject({ subtotalMinor: 6_750_000n, totalMinor: 6_850_000n });
    expect(() => computeTotals([{ unitPriceMinor: 100n, quantity: 1, discountMinor: 101n }], 0n, 0n)).toThrow(TotalsError);
    expect(() => computeTotals([{ unitPriceMinor: 100n, quantity: 1, discountMinor: 0n }], 201n, 100n)).toThrow(TotalsError);
    expect(() => computeTotals([{ unitPriceMinor: 100n, quantity: 0, discountMinor: 0n }], 0n, 0n)).toThrow(TotalsError);
    expect(() => computeTotals([], -1n, 0n)).toThrow(TotalsError);
    expect(computeTotals([{ unitPriceMinor: 100n, quantity: 1, discountMinor: 0n }], 200n, 100n).totalMinor).toBe(0n);
  });

  it('generates readable references', () => {
    const refs = new Set(Array.from({ length: 500 }, orderReference));
    for (const r of refs) expect(r).toMatch(/^LS-[2-9A-HJKMNP-Z]{6}$/);
    expect(refs.size).toBeGreaterThan(495);
  });
});
