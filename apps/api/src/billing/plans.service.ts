import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanDto, UpdatePlanDto } from './plans.dto';

export interface PlanLimits {
  products: number | null;
  ordersPerMonth: number | null;
  staff: number | null;
  paymentGateways: number | null;
}

const PUBLIC_SELECT = {
  id: true, code: true, name: true, description: true, currency: true, monthlyPriceMinor: true,
  annualPriceMinor: true, trialDays: true, limits: true, features: true, sortOrder: true, pricingModel: true, commissionBps: true,
} as const;

interface PricingShape { pricingModel: 'SUBSCRIPTION' | 'COMMISSION'; commissionBps: number | null; monthlyPriceMinor: bigint | null; annualPriceMinor: bigint | null }

/** Commission plans: a rate and no fixed fee. Subscription plans: no rate. (Mirrors the DB CHECK.) */
export function validatePricing(p: PricingShape) {
  if (p.pricingModel === 'COMMISSION') {
    if (p.commissionBps == null) throw new BadRequestException('commissionBps is required for a commission plan');
    if (p.monthlyPriceMinor !== 0n || p.annualPriceMinor !== 0n) {
      throw new BadRequestException('A commission plan has no fixed fee: set monthlyPriceMinor and annualPriceMinor to "0"');
    }
  } else if (p.commissionBps != null) {
    throw new BadRequestException('commissionBps only applies to commission plans; use null for a subscription plan');
  }
}

/** Feature flags shown on the pricing page: short camelCase keys; values boolean or a short label. */
export function validateFeatures(features: Record<string, unknown>) {
  const entries = Object.entries(features);
  if (entries.length > 40) throw new BadRequestException('features: at most 40 entries');
  for (const [k, v] of entries) {
    if (!/^[a-z][a-zA-Z0-9]{0,40}$/.test(k)) throw new BadRequestException(`features: invalid key "${k}"`);
    const ok = typeof v === 'boolean' || (typeof v === 'string' && v.length > 0 && v.length <= 40);
    if (!ok) throw new BadRequestException(`features.${k}: must be true/false or a short label`);
  }
  return features as Prisma.InputJsonObject;
}

const toKobo = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : BigInt(v));

/** Global (non-tenant) catalogue of SaaS plans. Admin-editable; prices apply to invoices issued after the change. */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  listPublic() {
    return this.prisma.subscriptionPlan.findMany({
      where: { isActive: true, isPublic: true }, orderBy: { sortOrder: 'asc' }, select: PUBLIC_SELECT,
    });
  }

  listAll() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { subscriptions: { where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } } } } },
    });
  }

  async create(dto: CreatePlanDto, actorId: string) {
    const pricingModel = dto.pricingModel ?? 'SUBSCRIPTION';
    const commission = pricingModel === 'COMMISSION';
    const monthly = commission && dto.monthlyPriceMinor == null ? 0n : toKobo(dto.monthlyPriceMinor) ?? null;
    const annual = commission && dto.annualPriceMinor == null ? 0n : toKobo(dto.annualPriceMinor) ?? null;
    validatePricing({ pricingModel, commissionBps: dto.commissionBps ?? null, monthlyPriceMinor: monthly, annualPriceMinor: annual });
    try {
      const plan = await this.prisma.subscriptionPlan.create({
        data: {
          pricingModel, commissionBps: dto.commissionBps ?? null,
          code: dto.code, name: dto.name, description: dto.description ?? null, currency: dto.currency ?? 'NGN',
          monthlyPriceMinor: monthly, annualPriceMinor: annual,
          trialDays: dto.trialDays ?? 14, limits: { ...dto.limits }, features: validateFeatures(dto.features),
          isActive: dto.isActive ?? true, isPublic: dto.isPublic ?? true, sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.audit.record({ action: 'plan.created', actorId, entityType: 'subscription_plan', entityId: plan.id, metadata: { code: plan.code } });
      return plan;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A plan with this code already exists');
      throw e;
    }
  }

  async update(id: string, dto: UpdatePlanDto, actorId: string) {
    const before = await this.prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Plan not found');
    const merged = {
      pricingModel: dto.pricingModel ?? before.pricingModel,
      commissionBps: dto.commissionBps !== undefined ? dto.commissionBps : dto.pricingModel === 'SUBSCRIPTION' ? null : before.commissionBps,
      monthlyPriceMinor: dto.monthlyPriceMinor !== undefined ? toKobo(dto.monthlyPriceMinor) ?? null : before.monthlyPriceMinor,
      annualPriceMinor: dto.annualPriceMinor !== undefined ? toKobo(dto.annualPriceMinor) ?? null : before.annualPriceMinor,
    };
    if (dto.pricingModel === 'COMMISSION' && before.pricingModel !== 'COMMISSION') {
      if (dto.monthlyPriceMinor === undefined) merged.monthlyPriceMinor = 0n;
      if (dto.annualPriceMinor === undefined) merged.annualPriceMinor = 0n;
    }
    validatePricing(merged);
    if (merged.pricingModel !== before.pricingModel) {
      const live = await this.prisma.subscription.count({ where: { planId: id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } });
      if (live) throw new ConflictException('Sellers are on this plan; create a new plan instead of changing its pricing model');
    }
    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: dto.name, description: dto.description, trialDays: dto.trialDays, isActive: dto.isActive,
        isPublic: dto.isPublic, sortOrder: dto.sortOrder,
        monthlyPriceMinor: merged.monthlyPriceMinor, annualPriceMinor: merged.annualPriceMinor,
        pricingModel: merged.pricingModel, commissionBps: merged.commissionBps,
        limits: dto.limits ? { ...dto.limits } : undefined,
        features: dto.features ? validateFeatures(dto.features) : undefined,
      },
    });
    await this.audit.record({
      action: 'plan.updated', actorId, entityType: 'subscription_plan', entityId: id,
      metadata: {
        code: plan.code, fields: Object.keys(dto),
        priceBefore: { monthly: before.monthlyPriceMinor?.toString() ?? null, annual: before.annualPriceMinor?.toString() ?? null },
        priceAfter: { monthly: plan.monthlyPriceMinor?.toString() ?? null, annual: plan.annualPriceMinor?.toString() ?? null },
        commissionBefore: before.commissionBps, commissionAfter: plan.commissionBps, pricingModel: plan.pricingModel,
      },
    });
    return plan;
  }
}
