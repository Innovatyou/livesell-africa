import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../common/audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillingNotifier } from './billing-notifier';
import { CommissionService } from './commission.service';
import { LIVE_STATUSES } from './entitlements.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

/** Start of the Lagos (UTC+1) calendar month containing `d`, as a UTC instant. */
export function lagosMonthStart(d: Date): Date {
  const local = new Date(d.getTime() + 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 3_600_000);
}

/** Start of the month before. */
export function previousMonthStart(monthStart: Date): Date {
  const local = new Date(monthStart.getTime() + 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - 3_600_000);
}

/** "October 2026" for the month that starts at `start`. */
export function monthLabel(start: Date): string {
  return new Intl.DateTimeFormat('en-NG', { month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' }).format(start);
}

/** Pure: how much to invoice now. Small or negative amounts (refunds after billing) carry over. */
export function commissionToInvoice(owedNetMinor: bigint, billedMinor: bigint, minInvoiceMinor: bigint): bigint {
  const due = owedNetMinor - billedMinor;
  return due >= minInvoiceMinor && due > 0n ? due : 0n;
}

/**
 * Commission on sales the seller collected themselves (MASTER-SPEC §14 commission model; decided 2026-11-06).
 *
 * - SPLIT payments: LiveSell's share is taken at source by the gateway (Phase 5/6). Nothing to collect.
 * - DIRECT (seller's own gateway key) and BANK_TRANSFER: the money is in the seller's account. Each verified sale
 *   already posts `COMMISSION_PAYABLE` (seller) / `COMMISSION_RECEIVABLE` (platform) in its own transaction, and
 *   refunds reverse it in proportion. Once a month this service invoices the net amount accrued on ORDER
 *   transactions up to the month's start, minus what earlier commission invoices already billed.
 * - The invoice is paid like a subscription invoice (platform Paystack). On verification the ledger moves
 *   receivable → cash; the seller's payable is cleared.
 * - Unpaid past its due date + `billing.grace_days`: tenant writes are blocked (402 COMMISSION_OVERDUE) until it is
 *   paid; reads keep working. Commission invoices are never voided by plan changes or expiry.
 */
@Injectable()
export class CommissionBillingService {
  private readonly logger = new Logger(CommissionBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: BillingNotifier,
    private readonly commission: CommissionService,
  ) {}

  async settings() {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: ['commission.invoice_due_days', 'commission.min_invoice_minor', 'billing.grace_days'] } } });
    const get = (k: string, d: number, max: number) => {
      const v = Number(rows.find((r) => r.key === k)?.value);
      return Number.isInteger(v) && v >= 0 && v <= max ? v : d;
    };
    return { dueDays: get('commission.invoice_due_days', 7, 60), minInvoiceMinor: BigInt(get('commission.min_invoice_minor', 100_000, 100_000_000)), graceDays: get('billing.grace_days', 3, 60) };
  }

  /** Net commission accrued on the store's directly collected sales before `cutoff` (refund reversals netted). */
  async owedNet(db: Tx | PrismaService, tenantId: string, currency: string, cutoff: Date): Promise<bigint> {
    const [row] = await db.$queryRaw<Array<{ owed: bigint }>>`
      SELECT COALESCE(SUM(CASE WHEN e.direction::text = 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END), 0)::bigint AS owed
        FROM ledger_entries e
        JOIN ledger_accounts a ON a.id = e.account_id AND a.tenant_id = ${tenantId}::uuid AND a.code = 'COMMISSION_PAYABLE' AND a.currency = ${currency}
        JOIN payment_transactions t ON t.id = e.transaction_id AND t.tenant_id = ${tenantId}::uuid AND t.purpose::text = 'ORDER'
       WHERE e.created_at < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    return row.owed;
  }

  /** Everything earlier commission invoices asked for (open, paid, or waived — a waived amount is never re-billed). */
  async billed(db: Tx | PrismaService, tenantId: string, currency: string): Promise<bigint> {
    const agg = await db.subscriptionInvoice.aggregate({ where: { tenantId, kind: 'COMMISSION', status: { in: ['OPEN', 'PAID', 'UNCOLLECTIBLE'] }, currency }, _sum: { amountMinor: true } });
    return agg._sum.amountMinor ?? 0n;
  }

  /** What the seller sees on Plan & billing. */
  async summary(tenantId: string, now = new Date()) {
    const { defaultCurrency: currency } = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
    const db = this.prisma.forTenant(tenantId);
    const monthStart = lagosMonthStart(now);
    const [rate, cfg, owedAll, owedBefore, billed, invoices, splitThisMonth] = await Promise.all([
      this.commission.effectiveRate(tenantId),
      this.settings(),
      this.owedNet(this.prisma, tenantId, currency, new Date(now.getTime() + DAY)),
      this.owedNet(this.prisma, tenantId, currency, monthStart),
      this.billed(this.prisma, tenantId, currency),
      db.subscriptionInvoice.findMany({ where: { kind: 'COMMISSION' }, orderBy: { createdAt: 'desc' }, take: 24 }),
      db.paymentTransaction.aggregate({ where: { purpose: 'ORDER', status: 'SUCCEEDED', settlementMode: 'SPLIT', currency, verifiedAt: { gte: monthStart } }, _sum: { platformCommissionMinor: true } }),
    ]);
    const overdue = invoices.filter((i) => i.status === 'OPEN' && i.dueAt.getTime() + cfg.graceDays * DAY < now.getTime());
    return {
      currency, rate,
      /** Commission on this month's directly collected sales; invoiced at the start of next month. */
      thisMonthMinor: owedAll - owedBefore,
      /** Not yet invoiced (this month + any amount carried over). */
      unbilledMinor: owedAll - billed > 0n ? owedAll - billed : 0n,
      /** Taken at source on split payments this month (nothing to pay). */
      collectedAtSourceThisMonthMinor: splitThisMonth._sum.platformCommissionMinor ?? 0n,
      nextInvoiceOn: new Date(lagosMonthStart(new Date(monthStart.getTime() + 32 * DAY)).getTime()),
      minInvoiceMinor: cfg.minInvoiceMinor, dueDays: cfg.dueDays, graceDays: cfg.graceDays,
      invoices: invoices.map((i) => ({ ...i, overdue: overdue.some((o) => o.id === i.id), accessBlockedFrom: i.status === 'OPEN' ? new Date(i.dueAt.getTime() + cfg.graceDays * DAY) : null })),
      writesBlocked: overdue.length > 0,
    };
  }

  /** Job (hourly; idempotent): issue last month's commission invoice for every store that owes one. */
  async issueDue(now = new Date()) {
    const tenants = await this.prisma.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT a.tenant_id FROM ledger_accounts a WHERE a.code = 'COMMISSION_PAYABLE' AND a.tenant_id IS NOT NULL`;
    let issued = 0;
    for (const { tenant_id } of tenants) {
      try {
        if (await this.issueFor(tenant_id, now)) issued++;
      } catch (e) {
        this.logger.error(`Commission invoice for ${tenant_id}: ${(e as Error).message}`);
      }
    }
    return { stores: tenants.length, issued };
  }

  /** Issue the invoice for the month before `now` (one per store per month; concurrent runs serialise on a lock). */
  async issueFor(tenantId: string, now = new Date()) {
    const cfg = await this.settings();
    const periodEnd = lagosMonthStart(now);
    const periodStart = previousMonthStart(periodEnd);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`commission:${tenantId}`}))`;
      const existing = await tx.subscriptionInvoice.findFirst({ where: { tenantId, kind: 'COMMISSION', periodStart, status: { not: 'VOID' } }, select: { id: true } });
      if (existing) return null;
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true, email: true, businessName: true } });
      const amount = commissionToInvoice(await this.owedNet(tx, tenantId, tenant.defaultCurrency, periodEnd), await this.billed(tx, tenantId, tenant.defaultCurrency), cfg.minInvoiceMinor);
      if (amount === 0n) return null;
      const sub = (await tx.subscription.findFirst({ where: { tenantId, status: { in: [...LIVE_STATUSES] } } })) ?? (await tx.subscription.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }));
      if (!sub) return null;
      const dueAt = new Date(now.getTime() + cfg.dueDays * DAY);
      const invoice = await tx.subscriptionInvoice.create({
        data: {
          subscriptionId: sub.id, tenantId, number: `COM-${new Date(periodStart.getTime() + 3_600_000).toISOString().slice(0, 7).replace('-', '')}-${randomBytes(5).toString('hex').toUpperCase()}`,
          kind: 'COMMISSION', planId: sub.planId, interval: sub.interval, description: `Commission on sales collected directly, up to the end of ${monthLabel(periodStart)}`,
          amountMinor: amount, currency: tenant.defaultCurrency, status: 'OPEN', periodStart, periodEnd, dueAt,
        },
      });
      await tx.subscriptionEvent.create({ data: { tenantId, subscriptionId: sub.id, type: 'INVOICE_ISSUED', invoiceId: invoice.id, metadata: { kind: 'COMMISSION', amountMinor: amount.toString() } } });
      return { invoice, tenant };
    });
    if (!result) return null;
    await this.audit.record({ action: 'billing.commission_invoiced', tenantId, entityType: 'subscription_invoice', entityId: result.invoice.id, metadata: { amountMinor: result.invoice.amountMinor.toString(), period: monthLabel(periodStart) } });
    try {
      await this.notifier.sendCommissionInvoice(result.tenant.email, {
        businessName: result.tenant.businessName, invoiceNumber: result.invoice.number, amountMinor: result.invoice.amountMinor,
        currency: result.invoice.currency, periodLabel: monthLabel(periodStart), dueAt: result.invoice.dueAt,
      });
    } catch (e) {
      this.logger.warn(`Commission invoice email for ${tenantId}: ${(e as Error).message}`);
    }
    return result.invoice;
  }
}
