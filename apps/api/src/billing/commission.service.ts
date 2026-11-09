import { Injectable } from '@nestjs/common';
import type { PaymentProviderCode } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_STATUSES } from './entitlements.service';

export type CommissionSource = 'trial' | 'plan' | 'seller_override' | 'platform_default';

export interface EffectiveCommission {
  bps: number;
  source: CommissionSource;
  pricingModel: 'SUBSCRIPTION' | 'COMMISSION';
}

/**
 * Platform commission on a seller's verified sale, in minor units. Rounded DOWN, so a seller is never charged a
 * fraction of a kobo more than the rate. bps = basis points (100 bps = 1%).
 */
export function commissionFor(grossMinor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError('Commission must be 0–10000 bps');
  if (grossMinor <= 0n) return 0n;
  return (grossMinor * BigInt(bps)) / 10_000n;
}

/**
 * Which commission rate applies to a seller's sales right now. Used by the payments module (Phase 5+) when it
 * records platform commission and seller proceeds on each verified transaction.
 *
 * Order of precedence:
 *  1. Free trial → 0 (no commission during the trial, whichever model was chosen).
 *  2. A negotiated per-seller override on the seller's payment account for that provider.
 *  3. COMMISSION plan → the plan's rate.
 *  4. SUBSCRIPTION plan → platform setting `commission.default_bps` (0 unless the admin sets one).
 * Returns null when the workspace has no live subscription (it cannot take orders).
 */
@Injectable()
export class CommissionService {
  constructor(private readonly prisma: PrismaService) {}

  async effectiveRate(tenantId: string, provider?: PaymentProviderCode): Promise<EffectiveCommission | null> {
    const db = this.prisma.forTenant(tenantId);
    const sub = await db.subscription.findFirst({
      where: { status: { in: [...LIVE_STATUSES] } }, include: { plan: { select: { pricingModel: true, commissionBps: true } } },
    });
    if (!sub) return null;
    const pricingModel = sub.plan.pricingModel;
    if (sub.status === 'TRIALING') return { bps: 0, source: 'trial', pricingModel };

    if (provider) {
      const account = await db.sellerPaymentAccount.findFirst({
        where: { provider: { code: provider }, isActive: true, commissionBps: { not: null } }, select: { commissionBps: true },
      });
      if (account?.commissionBps != null) return { bps: account.commissionBps, source: 'seller_override', pricingModel };
    }
    if (pricingModel === 'COMMISSION') return { bps: sub.plan.commissionBps ?? 0, source: 'plan', pricingModel };

    const setting = await this.prisma.platformSetting.findUnique({ where: { key: 'commission.default_bps' } });
    const v = Number(setting?.value);
    return { bps: Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : 0, source: 'platform_default', pricingModel };
  }
}
