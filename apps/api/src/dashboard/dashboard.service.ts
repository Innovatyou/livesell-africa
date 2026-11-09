import { Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Nigeria first: reporting days/weeks/months are in West Africa Time. Per-tenant time zones come later. */
export const REPORTING_TZ = 'Africa/Lagos';

export type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const CHART_PERIODS: Record<ChartPeriod, { unit: 'day' | 'week' | 'month' | 'year'; buckets: number; step: string }> = {
  daily: { unit: 'day', buckets: 30, step: '1 day' },
  weekly: { unit: 'week', buckets: 12, step: '1 week' },
  monthly: { unit: 'month', buckets: 12, step: '1 month' },
  yearly: { unit: 'year', buckets: 5, step: '1 year' },
};

/** Orders that have been paid (incl. partially refunded) — the basis for products sold, AOV and top sellers. */
export const PAID_PAYMENT_STATUSES: PaymentStatus[] = ['PAID', 'PARTIALLY_REFUNDED'];
export const PENDING_PAYMENT_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'];
/** Paid but not yet delivered. */
export const OUTSTANDING_STATUSES: OrderStatus[] = ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED'];

/**
 * Seller dashboard (MASTER-SPEC §7), computed from real rows only.
 *
 * Definitions (also in docs/PHASE-2.md):
 * - Sales = gross of SUCCEEDED, verified ORDER payment transactions (never SaaS subscription payments),
 *   by verification time, in the workspace's default currency.
 * - Order counts exclude drafts. Amounts are in the default currency; other currencies are not mixed in.
 *
 * Prisma model queries go through the tenant-scoped client. The two time-bucket queries need SQL; they take
 * the tenant id as a bound parameter and filter every joined table by it.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string) {
    const db = this.prisma.forTenant(tenantId);
    const { defaultCurrency: currency } = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });

    const [sales, byStatus, paidAgg, sold, inventory, topProducts, recentCustomers, recentTransactions] = await Promise.all([
      this.salesTodayAndMonth(tenantId, currency),
      db.order.groupBy({ by: ['status', 'paymentStatus', 'currency'], where: { status: { not: 'DRAFT' } }, _count: { _all: true }, _sum: { totalMinor: true } }),
      db.order.aggregate({ where: { paymentStatus: { in: PAID_PAYMENT_STATUSES }, currency }, _count: { _all: true }, _sum: { totalMinor: true } }),
      db.orderItem.aggregate({ where: { order: { paymentStatus: { in: PAID_PAYMENT_STATUSES } } }, _sum: { quantity: true } }),
      db.inventory.aggregate({
        where: { variant: { isActive: true, product: { deletedAt: null, status: { not: 'ARCHIVED' } } } },
        _sum: { onHand: true, reserved: true },
      }),
      this.topProducts(tenantId, currency),
      this.recentCustomers(tenantId, currency),
      db.paymentTransaction.findMany({
        where: { purpose: 'ORDER' }, orderBy: { createdAt: 'desc' }, take: 5,
        select: { id: true, reference: true, provider: true, grossMinor: true, currency: true, status: true, createdAt: true, verifiedAt: true, order: { select: { id: true, reference: true } } },
      }),
    ]);

    const count = (pred: (r: (typeof byStatus)[number]) => boolean) => byStatus.filter(pred).reduce((n, r) => n + r._count._all, 0);
    const pendingAmount = byStatus
      .filter((r) => PENDING_PAYMENT_STATUSES.includes(r.status) && r.currency === currency)
      .reduce((s, r) => s + (r._sum.totalMinor ?? 0n), 0n);
    const paidCount = BigInt(paidAgg._count._all);

    return {
      currency,
      timezone: REPORTING_TZ,
      salesTodayMinor: sales.today,
      salesThisMonthMinor: sales.month,
      totalOrders: count(() => true),
      paidOrders: count((r) => PAID_PAYMENT_STATUSES.includes(r.paymentStatus)),
      pendingPayments: { count: count((r) => PENDING_PAYMENT_STATUSES.includes(r.status)), amountMinor: pendingAmount },
      cancelledOrders: count((r) => r.status === 'CANCELLED'),
      outstandingOrders: count((r) => OUTSTANDING_STATUSES.includes(r.status)),
      productsSold: sold._sum.quantity ?? 0,
      availableInventory: (inventory._sum.onHand ?? 0) - (inventory._sum.reserved ?? 0),
      averageOrderValueMinor: paidCount > 0n ? (paidAgg._sum.totalMinor ?? 0n) / paidCount : 0n,
      topProducts,
      recentCustomers,
      recentTransactions,
    };
  }

  /** Verified sales per bucket, zero-filled, oldest first. */
  async salesChart(tenantId: string, period: ChartPeriod) {
    const { defaultCurrency: currency } = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
    const p = CHART_PERIODS[period];
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; amount: bigint; payments: bigint }>>`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${p.unit}, now() AT TIME ZONE ${REPORTING_TZ}) - ${`${p.buckets - 1} ${p.unit}s`}::interval,
          date_trunc(${p.unit}, now() AT TIME ZONE ${REPORTING_TZ}),
          ${p.step}::interval
        ) AS bucket
      ), tx AS (
        SELECT date_trunc(${p.unit}, (verified_at AT TIME ZONE 'UTC') AT TIME ZONE ${REPORTING_TZ}) AS bucket,
               SUM(gross_minor)::bigint AS amount, COUNT(*)::bigint AS payments
        FROM payment_transactions
        WHERE tenant_id = ${tenantId}::uuid AND purpose = 'ORDER' AND status = 'SUCCEEDED'
          AND currency = ${currency} AND verified_at IS NOT NULL
          AND (verified_at AT TIME ZONE 'UTC') AT TIME ZONE ${REPORTING_TZ} >= (SELECT MIN(bucket) FROM buckets)
        GROUP BY 1
      )
      SELECT b.bucket, COALESCE(tx.amount, 0)::bigint AS amount, COALESCE(tx.payments, 0)::bigint AS payments
      FROM buckets b LEFT JOIN tx ON tx.bucket = b.bucket
      ORDER BY b.bucket`;
    const points = rows.map((r) => ({
      // Local (WAT) bucket start as a calendar label, e.g. "2026-11-05".
      label: localLabel(r.bucket, p.unit),
      amountMinor: r.amount,
      payments: Number(r.payments),
    }));
    const total = points.reduce((s, x) => s + x.amountMinor, 0n);
    return { period, currency, timezone: REPORTING_TZ, totalMinor: total, points };
  }

  private async salesTodayAndMonth(tenantId: string, currency: string) {
    const [row] = await this.prisma.$queryRaw<Array<{ today: bigint; month: bigint }>>`
      SELECT
        COALESCE(SUM(gross_minor) FILTER (
          WHERE (verified_at AT TIME ZONE 'UTC') AT TIME ZONE ${REPORTING_TZ} >= date_trunc('day', now() AT TIME ZONE ${REPORTING_TZ})
        ), 0)::bigint AS today,
        COALESCE(SUM(gross_minor), 0)::bigint AS month
      FROM payment_transactions
      WHERE tenant_id = ${tenantId}::uuid AND purpose = 'ORDER' AND status = 'SUCCEEDED' AND currency = ${currency}
        AND verified_at IS NOT NULL
        AND (verified_at AT TIME ZONE 'UTC') AT TIME ZONE ${REPORTING_TZ} >= date_trunc('month', now() AT TIME ZONE ${REPORTING_TZ})`;
    return { today: row.today, month: row.month };
  }

  private topProducts(tenantId: string, currency: string) {
    return this.prisma.$queryRaw<Array<{ productId: string; name: string; productCode: string; quantity: bigint; revenueMinor: bigint }>>`
      SELECT p.id AS "productId", p.name, p.product_code AS "productCode",
             SUM(oi.quantity)::bigint AS quantity, SUM(oi.line_total_minor)::bigint AS "revenueMinor"
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.tenant_id = ${tenantId}::uuid
      JOIN product_variants v ON v.id = oi.variant_id AND v.tenant_id = ${tenantId}::uuid
      JOIN products p ON p.id = v.product_id AND p.tenant_id = ${tenantId}::uuid
      WHERE oi.tenant_id = ${tenantId}::uuid AND o.currency = ${currency}
        AND o.payment_status IN (${Prisma.join(PAID_PAYMENT_STATUSES.map((s) => Prisma.sql`${s}::"PaymentStatus"`))})
      GROUP BY p.id, p.name, p.product_code
      ORDER BY quantity DESC, "revenueMinor" DESC
      LIMIT 5`;
  }

  private async recentCustomers(tenantId: string, currency: string) {
    const db = this.prisma.forTenant(tenantId);
    const customers = await db.customer.findMany({
      orderBy: { createdAt: 'desc' }, take: 5,
      select: { id: true, fullName: true, phone: true, email: true, createdAt: true, _count: { select: { orders: true } } },
    });
    if (!customers.length) return [];
    const spend = await db.order.groupBy({
      by: ['customerId'], where: { customerId: { in: customers.map((c) => c.id) }, paymentStatus: { in: PAID_PAYMENT_STATUSES }, currency },
      _sum: { totalMinor: true },
    });
    const byId = new Map(spend.map((s) => [s.customerId, s._sum.totalMinor ?? 0n]));
    return customers.map(({ _count, ...c }) => ({ ...c, orderCount: _count.orders, totalSpentMinor: byId.get(c.id) ?? 0n }));
  }
}

function localLabel(bucket: Date, unit: string) {
  // `bucket` is a timestamp without time zone (local WAT wall time) that the driver reads as UTC.
  const iso = bucket.toISOString();
  return unit === 'year' ? iso.slice(0, 4) : unit === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}
