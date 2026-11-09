import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import { CommissionBillingService } from '../billing/commission-billing.service';
import { AuditService } from '../common/audit/audit.service';
import { Prisma, TenantStatus } from '../generated/prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

const DAY = 86_400_000;
const LIVE = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;
const bps = (n: number, d: number) => (d > 0 ? Math.round((n * 10_000) / d) : null);

/** Platform settings an admin may change here, with their allowed values (other settings have their own pages). */
export const EDITABLE_SETTINGS: Record<string, { label: string; validate: (v: unknown) => boolean; hint: string }> = {
  'commission.default_bps': { label: 'Commission on subscription plans (bps)', hint: '0–10000; 100 = 1%', validate: (v) => int(v, 0, 10_000) },
  'commission.invoice_due_days': { label: 'Days to pay a commission invoice', hint: '0–60', validate: (v) => int(v, 0, 60) },
  'commission.min_invoice_minor': { label: 'Smallest commission invoice (kobo)', hint: 'Smaller amounts carry over', validate: (v) => int(v, 0, 100_000_000) },
  'billing.grace_days': { label: 'Grace days after an invoice falls due', hint: '0–60', validate: (v) => int(v, 0, 60) },
  'billing.reminder_days': { label: 'Renewal reminder days', hint: 'Up to 5 values, 1–60', validate: (v) => Array.isArray(v) && v.length > 0 && v.length <= 5 && v.every((x) => int(x, 1, 60)) },
  'orders.staff_hold_hours': { label: 'Stock hold for staff orders (hours)', hint: '1–168', validate: (v) => int(v, 1, 168) },
  'orders.checkout_hold_minutes': { label: 'Stock hold for online orders (minutes)', hint: '15–10080', validate: (v) => int(v, 15, 10_080) },
  'orders.transfer_hold_hours': { label: 'Stock hold after a transfer is reported (hours)', hint: '1–168', validate: (v) => int(v, 1, 168) },
  'payments.transfer_stale_hours': { label: 'Flag unverified transfers after (hours)', hint: '1–168', validate: (v) => int(v, 1, 168) },
};
function int(v: unknown, min: number, max: number) {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

/**
 * Super-admin portal (MASTER-SPEC §21). Platform-wide reads over the raw client (platform code, not seller code);
 * every change is audited. Money is kobo (BigInt) throughout.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly commission: CommissionBillingService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ───────────────────────── overview ─────────────────────────

  async overview(now = new Date()) {
    const since30 = new Date(now.getTime() - 30 * DAY);
    const [tenants, liveTenants, newTenants, orders, volume, gateways, subsByStatus, subsByPlan, ledgerTotals, messaging, failedWebhooks, failedMessages, top, signups, health] = await Promise.all([
      this.prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subscription.findMany({ where: { status: { in: [...LIVE] } }, select: { tenantId: true }, distinct: ['tenantId'] }),
      this.prisma.tenant.count({ where: { createdAt: { gte: since30 } } }),
      this.prisma.order.count({ where: { status: { not: 'DRAFT' } } }),
      this.prisma.paymentTransaction.groupBy({ by: ['currency'], where: { purpose: 'ORDER', status: 'SUCCEEDED' }, _sum: { grossMinor: true }, _count: { _all: true } }),
      this.prisma.paymentTransaction.groupBy({ by: ['provider', 'status'], where: { purpose: 'ORDER', createdAt: { gte: since30 } }, _count: { _all: true }, _sum: { grossMinor: true } }),
      this.prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subscription.groupBy({ by: ['planId'], where: { status: { in: [...LIVE] } }, _count: { _all: true } }),
      this.platformLedger(),
      this.prisma.notification.groupBy({ by: ['channel', 'status'], where: { createdAt: { gte: since30 } }, _count: { _all: true } }),
      this.prisma.paymentWebhookEvent.count({ where: { OR: [{ status: 'FAILED' }, { signatureValid: false }], receivedAt: { gte: since30 } } }),
      this.prisma.notification.count({ where: { status: 'FAILED', createdAt: { gte: new Date(now.getTime() - DAY) } } }),
      this.topSellers(since30),
      this.prisma.$queryRaw<Array<{ day: Date; n: number }>>`
        SELECT date_trunc('day', (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos') AS day, COUNT(*)::int AS n
          FROM tenants WHERE created_at >= (${since30.toISOString()}::timestamptz AT TIME ZONE 'UTC') GROUP BY 1 ORDER BY 1`,
      this.health(),
    ]);
    const plans = await this.prisma.subscriptionPlan.findMany({ select: { id: true, name: true, code: true } });
    const count = (s: TenantStatus) => tenants.find((t) => t.status === s)?._count._all ?? 0;
    const totalSellers = tenants.reduce((n, t) => n + t._count._all, 0);
    const active = liveTenants.length;
    const providers = [...new Set(gateways.map((g) => g.provider))].map((p) => {
      const rows = gateways.filter((g) => g.provider === p);
      const n = (s: string) => rows.filter((r) => r.status === s).reduce((t, r) => t + r._count._all, 0);
      const started = rows.reduce((t, r) => t + r._count._all, 0);
      return {
        provider: p, started, succeeded: n('SUCCEEDED'), failed: n('FAILED'), abandoned: n('ABANDONED'), pending: n('PENDING') + n('INITIALIZED'),
        successBps: bps(n('SUCCEEDED'), started), volumeMinor: rows.filter((r) => r.status === 'SUCCEEDED').reduce((t, r) => t + (r._sum.grossMinor ?? 0n), 0n),
      };
    });
    return {
      sellers: { total: totalSellers, active, inactive: totalSellers - active, suspended: count('SUSPENDED'), closed: count('CLOSED'), newLast30Days: newTenants },
      signups: signups.map((s) => ({ day: s.day.toISOString().slice(0, 10), count: s.n })),
      orders: { total: orders },
      transactionVolume: volume.map((v) => ({ currency: v.currency, grossMinor: v._sum.grossMinor ?? 0n, payments: v._count._all })),
      revenue: ledgerTotals,
      gateways: providers,
      subscriptions: {
        byStatus: subsByStatus.map((s) => ({ status: s.status, count: s._count._all })),
        byPlan: subsByPlan.map((s) => ({ plan: plans.find((p) => p.id === s.planId)?.name ?? s.planId, code: plans.find((p) => p.id === s.planId)?.code ?? null, count: s._count._all })),
      },
      messaging: messaging.map((m) => ({ channel: m.channel, status: m.status, count: m._count._all })),
      topSellers: top,
      problems: { failedWebhooks30d: failedWebhooks, failedMessages24h: failedMessages },
      health,
    };
  }

  /** Platform revenue from the ledger (NGN): subscriptions, commission earned, commission still owed by sellers. */
  private async platformLedger() {
    const rows = await this.prisma.$queryRaw<Array<{ code: string; balance: bigint }>>`
      SELECT a.code, COALESCE(SUM(CASE WHEN e.direction::text = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)::bigint AS balance
        FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
       WHERE a.tenant_id IS NULL AND a.currency = 'NGN' AND a.code IN ('SUBSCRIPTION_REVENUE', 'COMMISSION_REVENUE', 'COMMISSION_RECEIVABLE')
       GROUP BY a.code`;
    const b = (code: string) => rows.find((r) => r.code === code)?.balance ?? 0n;
    return { currency: 'NGN', subscriptionRevenueMinor: -b('SUBSCRIPTION_REVENUE'), commissionRevenueMinor: -b('COMMISSION_REVENUE'), commissionReceivableMinor: b('COMMISSION_RECEIVABLE') };
  }

  private async topSellers(since: Date) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; slug: string; gross: bigint; payments: number }>>`
      SELECT t.id, t.business_name AS name, t.slug, SUM(p.gross_minor)::bigint AS gross, COUNT(*)::int AS payments
        FROM payment_transactions p JOIN tenants t ON t.id = p.tenant_id
       WHERE p.purpose::text = 'ORDER' AND p.status::text = 'SUCCEEDED' AND p.currency = 'NGN'
         AND p.verified_at >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       GROUP BY t.id ORDER BY gross DESC LIMIT 10`;
    return rows.map((r) => ({ tenantId: r.id, businessName: r.name, slug: r.slug, grossMinor: r.gross, payments: r.payments }));
  }

  async health() {
    const timed = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
        return { status: 'up' as const, ms: Date.now() - t };
      } catch {
        return { status: 'down' as const, ms: Date.now() - t };
      }
    };
    const [database, redis] = await Promise.all([timed(() => this.prisma.$queryRaw`SELECT 1`), timed(() => this.redis.ping())]);
    const outbox = await this.prisma.outboxEvent.count({ where: { processedAt: null, createdAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
    const queued = await this.prisma.notification.count({ where: { status: 'QUEUED' } });
    return { database, redis, stuckOutboxEvents: outbox, queuedMessages: queued, checkedAt: new Date() };
  }

  // ───────────────────────── sellers ─────────────────────────

  async sellers(q: { search?: string; status?: TenantStatus; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const where: Prisma.TenantWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { OR: [{ businessName: { contains: q.search, mode: 'insensitive' } }, { slug: { contains: q.search.toLowerCase() } }, { email: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        select: {
          id: true, slug: true, businessName: true, email: true, phone: true, status: true, createdAt: true, verifiedAt: true,
          subscriptions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, plan: { select: { name: true, code: true } } } },
          _count: { select: { orders: true, products: true } },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);
    return { items: items.map(({ subscriptions, ...t }) => ({ ...t, subscription: subscriptions[0] ?? null })), total, page, pageSize };
  }

  async seller(id: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 1, include: { plan: { select: { name: true, code: true, pricingModel: true, commissionBps: true } } } },
        members: { where: { status: 'ACTIVE' }, include: { user: { select: { id: true, fullName: true, email: true } }, role: { select: { key: true, name: true } } } },
        _count: { select: { orders: true, products: true, customers: true } },
      },
    });
    if (!t) throw new NotFoundException('Seller not found');
    const since30 = new Date(Date.now() - 30 * DAY);
    const [sales30, salesAll, invoices, audit, commission] = await Promise.all([
      this.prisma.paymentTransaction.aggregate({ where: { tenantId: id, purpose: 'ORDER', status: 'SUCCEEDED', verifiedAt: { gte: since30 } }, _sum: { grossMinor: true }, _count: { _all: true } }),
      this.prisma.paymentTransaction.aggregate({ where: { tenantId: id, purpose: 'ORDER', status: 'SUCCEEDED' }, _sum: { grossMinor: true } }),
      this.prisma.subscriptionInvoice.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.auditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, action: true, actorId: true, metadata: true, createdAt: true } }),
      this.commission.summary(id),
    ]);
    const { subscriptions, members, ...rest } = t;
    return {
      ...rest, subscription: subscriptions[0] ?? null,
      team: members.map((m) => ({ userId: m.user.id, fullName: m.user.fullName, email: m.user.email, role: m.role.name })),
      sales: { last30DaysMinor: sales30._sum.grossMinor ?? 0n, last30DaysPayments: sales30._count._all, allTimeMinor: salesAll._sum.grossMinor ?? 0n },
      invoices, recentActivity: audit,
      commission: { unbilledMinor: commission.unbilledMinor, writesBlocked: commission.writesBlocked, rate: commission.rate },
    };
  }

  /** Suspend: the store, its storefront and its team are blocked at once (TenantGuard, storefront). Data is kept. */
  async suspend(actorId: string, id: string, reason: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id }, select: { status: true } });
    if (!t) throw new NotFoundException('Seller not found');
    if (t.status === 'SUSPENDED') throw new ConflictException('This seller is already suspended');
    if (t.status === 'CLOSED') throw new ConflictException('This account is closed');
    await this.prisma.tenant.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.audit.record({ action: 'admin.seller_suspended', actorId, tenantId: id, entityType: 'tenant', entityId: id, metadata: { reason, previousStatus: t.status } });
    return this.seller(id);
  }

  async reactivate(actorId: string, id: string, note?: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id }, select: { status: true } });
    if (!t) throw new NotFoundException('Seller not found');
    if (t.status !== 'SUSPENDED') throw new ConflictException('Only suspended sellers can be reactivated');
    const trialing = await this.prisma.subscription.count({ where: { tenantId: id, status: 'TRIALING' } });
    await this.prisma.tenant.update({ where: { id }, data: { status: trialing ? 'TRIAL' : 'ACTIVE' } });
    await this.audit.record({ action: 'admin.seller_reactivated', actorId, tenantId: id, entityType: 'tenant', entityId: id, metadata: { note: note ?? null } });
    return this.seller(id);
  }

  // ───────────────────────── commission ─────────────────────────

  /** Commission owed by sellers who collect directly: open/overdue invoices, newest first. */
  async commissionInvoices(q: { status?: 'OPEN' | 'PAID' | 'UNCOLLECTIBLE'; page?: number }) {
    const page = q.page ?? 1;
    const where: Prisma.SubscriptionInvoiceWhereInput = { kind: 'COMMISSION', ...(q.status ? { status: q.status } : {}) };
    const [items, total, open] = await Promise.all([
      this.prisma.subscriptionInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 25, take: 25, include: { subscription: { select: { tenant: { select: { id: true, businessName: true, slug: true } } } } } }),
      this.prisma.subscriptionInvoice.count({ where }),
      this.prisma.subscriptionInvoice.aggregate({ where: { kind: 'COMMISSION', status: 'OPEN' }, _sum: { amountMinor: true }, _count: { _all: true } }),
    ]);
    const grace = (await this.commission.settings()).graceDays;
    return {
      openTotalMinor: open._sum.amountMinor ?? 0n, openCount: open._count._all, total, page,
      items: items.map(({ subscription, ...i }) => ({ ...i, store: subscription.tenant, overdue: i.status === 'OPEN' && i.dueAt.getTime() + grace * DAY < Date.now() })),
    };
  }

  /**
   * Waive (write off) an open commission invoice: marked UNCOLLECTIBLE (it still counts as billed, so it is never
   * invoiced again), the seller's payable and the platform's receivable are reversed in one transaction, and the
   * write-block it caused lifts.
   */
  async waiveCommission(actorId: string, invoiceId: string, reason: string) {
    const inv = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.subscriptionInvoice.updateMany({ where: { id: invoiceId, kind: 'COMMISSION', status: 'OPEN' }, data: { status: 'UNCOLLECTIBLE' } });
      if (claimed.count !== 1) {
        const exists = await tx.subscriptionInvoice.findUnique({ where: { id: invoiceId }, select: { kind: true, status: true } });
        if (!exists || exists.kind !== 'COMMISSION') throw new NotFoundException('Commission invoice not found');
        throw new ConflictException(`This invoice is ${exists.status.toLowerCase()}, not open`);
      }
      const i = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      await this.ledger.post(tx, { tenantId: i.tenantId, currency: i.currency, lines: [
        { account: 'COMMISSION_PAYABLE', amountMinor: i.amountMinor, description: `Commission waived (${i.number})` },
        { account: 'COMMISSION_EXPENSE', amountMinor: -i.amountMinor, description: `Commission waived (${i.number})` },
      ] });
      await this.ledger.post(tx, { tenantId: null, currency: i.currency, lines: [
        { account: 'COMMISSION_REVENUE', amountMinor: i.amountMinor, description: `Commission waived (${i.number})` },
        { account: 'COMMISSION_RECEIVABLE', amountMinor: -i.amountMinor, description: `Commission waived (${i.number})` },
      ] });
      await tx.subscriptionEvent.create({ data: { tenantId: i.tenantId, subscriptionId: i.subscriptionId, type: 'INVOICE_VOIDED', actorId, invoiceId, metadata: { kind: 'COMMISSION', waived: true, reason } } });
      return i;
    });
    await this.audit.record({ action: 'admin.commission_waived', actorId, tenantId: inv.tenantId, entityType: 'subscription_invoice', entityId: inv.id, metadata: { amountMinor: inv.amountMinor.toString(), reason } });
    return { ...inv, status: 'UNCOLLECTIBLE' as const };
  }

  // ───────────────────────── system ─────────────────────────

  async webhooks(q: { status?: 'FAILED' | 'IGNORED' | 'PROCESSED' | 'RECEIVED'; invalidOnly?: boolean; page?: number }) {
    const page = q.page ?? 1;
    const where: Prisma.PaymentWebhookEventWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.invalidOnly ? { signatureValid: false } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.paymentWebhookEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: (page - 1) * 25, take: 25, select: { id: true, provider: true, eventId: true, eventType: true, signatureValid: true, status: true, error: true, transactionId: true, receivedAt: true, processedAt: true } }),
      this.prisma.paymentWebhookEvent.count({ where }),
    ]);
    return { items, total, page };
  }

  async auditLogs(q: { tenantId?: string; action?: string; actorId?: string; platformOnly?: boolean; page?: number }) {
    const page = q.page ?? 1;
    const where: Prisma.AuditLogWhereInput = {
      ...(q.tenantId ? { tenantId: q.tenantId } : {}), ...(q.platformOnly ? { tenantId: null } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}), ...(q.actorId ? { actorId: q.actorId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50, include: { actor: { select: { fullName: true, email: true } }, tenant: { select: { businessName: true, slug: true } } } }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page, pageSize: 50 };
  }

  async settings() {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: Object.keys(EDITABLE_SETTINGS) } } });
    return Object.entries(EDITABLE_SETTINGS).map(([key, s]) => ({ key, label: s.label, hint: s.hint, value: rows.find((r) => r.key === key)?.value ?? null }));
  }

  async updateSetting(actorId: string, key: string, value: unknown) {
    const def = EDITABLE_SETTINGS[key];
    if (!def) throw new NotFoundException('Unknown setting');
    if (!def.validate(value)) throw new BadRequestException(`${def.label}: ${def.hint}`);
    const before = await this.prisma.platformSetting.findUnique({ where: { key } });
    await this.prisma.platformSetting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
    await this.audit.record({ action: 'admin.setting_changed', actorId, entityType: 'platform_setting', entityId: key, metadata: { key, from: before?.value ?? null, to: value as Prisma.InputJsonValue } });
    return this.settings();
  }
}
