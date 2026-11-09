import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export type IssueType =
  | 'SALE_NOT_IN_LEDGER' // verified payment whose sale journal is missing or wrong
  | 'REFUND_NOT_IN_LEDGER' // completed refunds that don't match the refund journal
  | 'PAID_WITHOUT_PAYMENT' // order marked paid with no verified payment behind it
  | 'NEEDS_REFUND' // money received for a cancelled / already-paid order, not yet refunded
  | 'UNVERIFIED_TRANSFER' // a reported bank transfer still waiting for someone to check (§26 #5)
  | 'TRANSFER_ON_CLOSED_ORDER' // reported transfer still unchecked after its order was cancelled
  | 'REFUND_STUCK'; // provider refund still processing after a week

export interface Issue { type: IssueType; severity: 'error' | 'warning'; reference: string | null; orderId: string | null; orderReference: string | null; detail: string }

const PAID_LIKE = ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const DEFAULT_STALE_HOURS = 24;

/**
 * Payment reconciliation (MASTER-SPEC §12 "Payment reconciliation", §26 #5/#12). Read-only: it compares payment
 * records, refunds, orders and the ledger and lists what a person must look at. Balanced journals are already
 * guaranteed by the database; this checks that every recognised money movement HAS its journal with the right
 * amounts, and that unverified transfers and stray payments don't go unnoticed.
 * All queries are bound to one tenant id (raw SQL with a bound parameter).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async report(tenantId: string, now = new Date()) {
    const staleHours = await this.staleHours();
    const staleBefore = new Date(now.getTime() - staleHours * 3_600_000);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const issues: Issue[] = [];
    const q = this.prisma.$queryRaw.bind(this.prisma);

    // 1. Every verified order payment: the seller's SALES_REVENUE credit equals the gross.
    const sales = await q<Array<{ reference: string; order_id: string | null; order_reference: string | null; gross: bigint; booked: bigint | null }>>`
      SELECT t.reference, t.order_id, o.reference AS order_reference, t.gross_minor AS gross,
             (SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END)::bigint
                FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
               WHERE e.transaction_id = t.id AND a.code = 'SALES_REVENUE' AND a.tenant_id = ${tenantId}::uuid) AS booked
        FROM payment_transactions t LEFT JOIN orders o ON o.id = t.order_id
       WHERE t.tenant_id = ${tenantId}::uuid AND t.purpose = 'ORDER' AND t.status = 'SUCCEEDED'
         AND t.verified_by <> 'demo-seed'`; // development demo rows (prisma/seed-demo.ts) have no journals
    for (const r of sales) {
      if ((r.booked ?? 0n) !== r.gross) issues.push({ type: 'SALE_NOT_IN_LEDGER', severity: 'error', reference: r.reference, orderId: r.order_id, orderReference: r.order_reference, detail: `Payment of ${r.gross} kobo has ${r.booked ?? 0n} kobo of sales in the ledger` });
    }

    // 2. Completed refunds per payment equal the SALES_REFUNDS debits.
    const refunds = await q<Array<{ reference: string; order_id: string | null; order_reference: string | null; refunded: bigint; booked: bigint | null }>>`
      SELECT t.reference, t.order_id, o.reference AS order_reference, SUM(r.amount_minor)::bigint AS refunded,
             (SELECT SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END)::bigint
                FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
               WHERE e.transaction_id = t.id AND a.code = 'SALES_REFUNDS' AND a.tenant_id = ${tenantId}::uuid) AS booked
        FROM payment_refunds r JOIN payment_transactions t ON t.id = r.transaction_id LEFT JOIN orders o ON o.id = t.order_id
       WHERE r.tenant_id = ${tenantId}::uuid AND r.status = 'SUCCEEDED'
       GROUP BY t.id, t.reference, t.order_id, o.reference`;
    for (const r of refunds) {
      if ((r.booked ?? 0n) !== r.refunded) issues.push({ type: 'REFUND_NOT_IN_LEDGER', severity: 'error', reference: r.reference, orderId: r.order_id, orderReference: r.order_reference, detail: `Refunds of ${r.refunded} kobo but ${r.booked ?? 0n} kobo in the ledger` });
    }

    // 3. Orders shown as paid must have a verified payment that settled them.
    const unpaid = await q<Array<{ id: string; reference: string; status: string }>>`
      SELECT o.id, o.reference, o.status::text AS status FROM orders o
       WHERE o.tenant_id = ${tenantId}::uuid AND o.status::text = ANY(${PAID_LIKE}::text[])
         AND NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.order_id = o.id AND t.status = 'SUCCEEDED' AND t.failure_reason IS NULL)
       ORDER BY o.created_at DESC LIMIT 200`;
    for (const o of unpaid) issues.push({ type: 'PAID_WITHOUT_PAYMENT', severity: 'error', reference: null, orderId: o.id, orderReference: o.reference, detail: `Order is ${o.status.toLowerCase().replace(/_/g, ' ')} but no verified payment is recorded` });

    // 4. Money received that can't be applied (stray / duplicate) and isn't refunded yet.
    const stray = await q<Array<{ reference: string; order_id: string | null; order_reference: string | null; gross: bigint; refunded: bigint; reason: string }>>`
      SELECT t.reference, t.order_id, o.reference AS order_reference, t.gross_minor AS gross, t.failure_reason AS reason,
             COALESCE((SELECT SUM(r.amount_minor) FROM payment_refunds r WHERE r.transaction_id = t.id AND r.status = 'SUCCEEDED'), 0)::bigint AS refunded
        FROM payment_transactions t LEFT JOIN orders o ON o.id = t.order_id
       WHERE t.tenant_id = ${tenantId}::uuid AND t.status = 'SUCCEEDED' AND t.failure_reason IS NOT NULL`;
    for (const r of stray) {
      if (r.refunded < r.gross) issues.push({ type: 'NEEDS_REFUND', severity: 'error', reference: r.reference, orderId: r.order_id, orderReference: r.order_reference, detail: `${r.gross - r.refunded} kobo received but not applied to the order (${r.reason}); refund the customer` });
    }

    // 5. Reported transfers nobody has checked yet.
    const transfers = await this.prisma.forTenant(tenantId).paymentTransaction.findMany({
      where: { provider: 'BANK_TRANSFER', status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200,
      select: { reference: true, createdAt: true, grossMinor: true, order: { select: { id: true, reference: true, status: true } } },
    });
    for (const t of transfers) {
      if (t.order?.status === 'CANCELLED') {
        issues.push({ type: 'TRANSFER_ON_CLOSED_ORDER', severity: 'error', reference: t.reference, orderId: t.order.id, orderReference: t.order.reference, detail: 'The customer reported a transfer but the order was cancelled before anyone checked it. Check your bank; if the money arrived, verify it and refund.' });
      } else if (t.createdAt < staleBefore) {
        issues.push({ type: 'UNVERIFIED_TRANSFER', severity: 'warning', reference: t.reference, orderId: t.order?.id ?? null, orderReference: t.order?.reference ?? null, detail: `Reported ${Math.floor((now.getTime() - t.createdAt.getTime()) / 3_600_000)} h ago and still not checked` });
      }
    }

    // 6. Provider refunds that never completed.
    const stuck = await this.prisma.forTenant(tenantId).paymentRefund.findMany({
      where: { status: 'PROCESSING', createdAt: { lt: weekAgo } }, take: 100,
      select: { amountMinor: true, transaction: { select: { reference: true, order: { select: { id: true, reference: true } } } } },
    });
    for (const r of stuck) issues.push({ type: 'REFUND_STUCK', severity: 'warning', reference: r.transaction.reference, orderId: r.transaction.order?.id ?? null, orderReference: r.transaction.order?.reference ?? null, detail: `Refund of ${r.amountMinor} kobo still processing after 7 days; check the provider dashboard` });

    const [verified, unverified] = await Promise.all([
      this.prisma.forTenant(tenantId).paymentTransaction.aggregate({ where: { purpose: 'ORDER', status: 'SUCCEEDED' }, _sum: { grossMinor: true }, _count: true }),
      this.prisma.forTenant(tenantId).paymentTransaction.aggregate({ where: { provider: 'BANK_TRANSFER', status: 'PENDING' }, _sum: { grossMinor: true }, _count: true }),
    ]);
    const refunded = await this.prisma.forTenant(tenantId).paymentRefund.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountMinor: true } });
    return {
      checkedAt: now, staleAfterHours: staleHours,
      summary: {
        verifiedPayments: verified._count, verifiedMinor: verified._sum.grossMinor ?? 0n, refundedMinor: refunded._sum.amountMinor ?? 0n,
        unverifiedTransfers: unverified._count, unverifiedMinor: unverified._sum.grossMinor ?? 0n,
        errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length,
      },
      issues,
    };
  }

  /** Platform view: issue counts per store, worst first. */
  async platformReport(now = new Date()) {
    const tenants = await this.prisma.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id FROM payment_transactions WHERE created_at > ${new Date(now.getTime() - 90 * 86_400_000)}`;
    const rows = [];
    for (const { tenant_id } of tenants) {
      const r = await this.report(tenant_id, now);
      if (r.summary.errors || r.summary.warnings) rows.push({ tenantId: tenant_id, ...r.summary, types: [...new Set(r.issues.map((i) => i.type))] });
    }
    rows.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
    return { checkedAt: now, stores: rows };
  }

  /** Daily job: records which stores have reconciliation issues (the report itself stays read-only). */
  async runDaily(now = new Date()) {
    const r = await this.platformReport(now);
    for (const s of r.stores) {
      await this.audit.record({ action: 'payments.reconciliation_issues', tenantId: s.tenantId, entityType: 'reconciliation', metadata: { errors: s.errors, warnings: s.warnings, types: s.types } });
    }
    if (r.stores.length) this.logger.warn(`Reconciliation: ${r.stores.length} store(s) with issues`);
    return { stores: r.stores.length };
  }

  private async staleHours() {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'payments.transfer_stale_hours' } });
    const v = Number(s?.value);
    return Number.isInteger(v) && v >= 1 && v <= 720 ? v : DEFAULT_STALE_HOURS;
  }
}
