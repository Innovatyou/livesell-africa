import { BadRequestException } from '@nestjs/common';
import { commissionFor } from './commission.service';
import { validatePricing } from './plans.service';

describe('commission', () => {
  it('computes commission in kobo, rounding down in the seller’s favour', () => {
    expect(commissionFor(2_500_000n, 300)).toBe(75_000n); // 3% of ₦25,000 = ₦750
    expect(commissionFor(3_333n, 300)).toBe(99n); // 99.99 → 99
    expect(commissionFor(1n, 9_999)).toBe(0n);
    expect(commissionFor(1_000_000n, 0)).toBe(0n);
    expect(commissionFor(1_000_000n, 10_000)).toBe(1_000_000n);
    expect(commissionFor(0n, 300)).toBe(0n);
    expect(commissionFor(900_719_925_474_099_312n, 250)).toBe(22_517_998_136_852_482n); // beyond Number precision
  });

  it('rejects impossible rates', () => {
    expect(() => commissionFor(100n, -1)).toThrow(RangeError);
    expect(() => commissionFor(100n, 10_001)).toThrow(RangeError);
    expect(() => commissionFor(100n, 2.5)).toThrow(RangeError);
  });

  it('commission plans need a rate and no fixed fee; subscription plans carry no rate', () => {
    const ok = { pricingModel: 'COMMISSION' as const, commissionBps: 300, monthlyPriceMinor: 0n, annualPriceMinor: 0n };
    expect(() => validatePricing(ok)).not.toThrow();
    expect(() => validatePricing({ ...ok, commissionBps: null })).toThrow(BadRequestException);
    expect(() => validatePricing({ ...ok, monthlyPriceMinor: 500_000n })).toThrow(/no fixed fee/);
    expect(() => validatePricing({ ...ok, annualPriceMinor: null })).toThrow(/no fixed fee/);
    expect(() => validatePricing({ pricingModel: 'SUBSCRIPTION', commissionBps: 300, monthlyPriceMinor: 500_000n, annualPriceMinor: null })).toThrow(/only applies/);
    expect(() => validatePricing({ pricingModel: 'SUBSCRIPTION', commissionBps: null, monthlyPriceMinor: 500_000n, annualPriceMinor: null })).not.toThrow();
  });
});
