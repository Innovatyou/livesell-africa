import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PlanLimits } from './plans.service';

export const LIVE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

export interface Usage {
  staff: number; // active members (incl. owner) + pending, unexpired invitations
  products: number; // non-deleted products
}

export type LimitKey = keyof Usage;

export function limitViolations(limits: Partial<PlanLimits>, usage: Usage): Array<{ limit: LimitKey; allowed: number; used: number }> {
  const out: Array<{ limit: LimitKey; allowed: number; used: number }> = [];
  for (const key of ['staff', 'products'] as const) {
    const allowed = limits[key];
    if (typeof allowed === 'number' && usage[key] > allowed) out.push({ limit: key, allowed, used: usage[key] });
  }
  return out;
}

/** Plan limits vs real usage, always read from the database. */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async usage(tenantId: string): Promise<Usage> {
    const db = this.prisma.forTenant(tenantId);
    const [members, invites, products] = await Promise.all([
      db.tenantMember.count({ where: { status: 'ACTIVE' } }),
      db.staffInvitation.count({ where: { status: 'PENDING', expiresAt: { gt: new Date() } } }),
      db.product.count({ where: { deletedAt: null } }),
    ]);
    return { staff: members + invites, products };
  }

  /** Limits of the tenant's live plan; null when there is no live subscription. */
  async limits(tenantId: string): Promise<PlanLimits | null> {
    const sub = await this.prisma.forTenant(tenantId).subscription.findFirst({
      where: { status: { in: [...LIVE_STATUSES] } }, include: { plan: { select: { limits: true } } },
    });
    return sub ? (sub.plan.limits as unknown as PlanLimits) : null;
  }

  async assertCanAdd(tenantId: string, key: LimitKey, adding = 1) {
    const [limits, usage] = await Promise.all([this.limits(tenantId), this.usage(tenantId)]);
    if (!limits) throw new ForbiddenException({ code: 'SUBSCRIPTION_INACTIVE', message: 'Your subscription is not active' });
    const allowed = limits[key];
    if (typeof allowed === 'number' && usage[key] + adding > allowed) {
      const noun = key === 'staff' ? 'team member' : 'product';
      throw new ForbiddenException({
        code: 'PLAN_LIMIT_REACHED', limit: key, allowed, used: usage[key],
        message: `Your plan allows ${allowed} ${noun}${allowed === 1 ? '' : 's'}. Upgrade to add more.`,
      });
    }
  }
}
