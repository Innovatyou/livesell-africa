import {
  BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException,
  UnauthorizedException, UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { commissionFor, CommissionService } from '../billing/commission.service';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { isUniqueViolation } from '../catalog/products.service';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import type { Env } from '../config/env';
import { PaymentProviderCode, PaymentTransaction, Prisma, SellerPaymentAccount } from '../generated/prisma/client';
import { commissionReversal, JournalMode, LedgerService, refundJournals, saleJournals, subscriptionJournal, commissionSettlementJournals } from '../ledger/ledger.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';
import {
  PaymentProvider, PaymentProviderRegistry, ProviderCapabilities, ProviderCapabilityError, ProviderCredentials, ProviderRequestError,
  ProviderUnavailableError, RefundStatus, VerifyPaymentResult,
} from './payment-provider';

type Tx = Prisma.TransactionClient;
/** LiveSell's own subscription invoices are collected through the platform Paystack account. */
const BILLING_PROVIDER: PaymentProviderCode = 'PAYSTACK';
const PROVIDER_CODES: PaymentProviderCode[] = ['PAYSTACK', 'FLUTTERWAVE', 'BACHS'];
const MIN = 60_000;
const LINK_REUSE_MS = 30 * MIN; // an unpaid checkout link is handed out again for this long
const PAYMENT_HOLD_MS = 30 * MIN; // stock stays held at least this long once the customer goes to pay
const RECONCILE_WINDOW_MS = 48 * 60 * MIN; // pending payments are re-checked for two days, then left as abandoned
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OPEN_STATUSES = ['INITIALIZED', 'PENDING', 'ABANDONED'] as const;

export type VerifySource = 'return' | 'webhook' | 'reconcile' | 'staff';
type Route = { code: PaymentProviderCode; adapter: PaymentProvider; account: SellerPaymentAccount; creds: ProviderCredentials; split?: { subaccountCode: string } };

/** Attention flags stored in `failure_reason` on a SUCCEEDED transaction: money arrived but needs a person. */
export const ATTENTION = { ORDER_CLOSED: 'ORDER_NOT_PAYABLE', DUPLICATE: 'DUPLICATE_PAYMENT', INVOICE_CLOSED: 'INVOICE_NOT_OPEN' } as const;

/**
 * Payments (MASTER-SPEC §12). Rule 4 in practice:
 *  - Nothing is marked paid from a redirect, a webhook body or a client claim. Every path (customer return,
 *    webhook, reconciliation job, staff "check payment") ends in `applyVerification`, which only trusts the
 *    provider's server-side verify response, checks amount and currency, and — in ONE database transaction with the
 *    payment row locked — records the transaction, posts balanced ledger journals and marks the order/invoice paid.
 *  - Idempotent: a verified transaction is final; repeating any path is a no-op. Duplicate webhooks are
 *    de-duplicated on (provider, event id).
 *  - Provider outages (§26 #11) leave orders untouched and surface as 503 PROVIDER_UNAVAILABLE.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly registry: PaymentProviderRegistry,
    private readonly ledger: LedgerService,
    private readonly orders: OrdersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly commission: CommissionService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ───────────────────────── Availability ─────────────────────────

  /** Whether this store's customers can pay online right now. */
  async availability(tenantId: string) {
    const route = await this.sellerRoute(tenantId).catch(() => null);
    return { online: !!route, provider: route?.code ?? null, providerName: route?.adapter.displayName ?? null, testMode: route?.account.testMode ?? null };
  }

  // ───────────────────────── Order payments ─────────────────────────

  async startOrderPayment(tenantId: string, orderId: string, opts: { email?: string; actorId: string | null; via: 'staff' | 'storefront' }) {
    if (!(await this.anyEnabled())) throw new ServiceUnavailableException({ code: 'PAYMENTS_NOT_ENABLED', message: 'Online payment is not available yet.' });
    const route = await this.sellerRoute(tenantId);
    if (!route) throw new ConflictException({ code: 'PAYMENTS_NOT_SET_UP', message: 'Online payment is not set up for this store yet.' });
    const db = this.prisma.forTenant(tenantId);
    const order = await db.order.findUnique({ where: { id: orderId }, include: { customer: { select: { email: true, fullName: true } } } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING_PAYMENT') {
      throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: order.paymentStatus === 'PAID' ? 'This order is already paid.' : 'This order is not awaiting payment.' });
    }
    const email = (opts.email ?? order.customer?.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.endsWith('.local')) {
      throw new BadRequestException({ code: 'EMAIL_REQUIRED', message: `${route.adapter.displayName} needs an email address to send the receipt to.` });
    }

    const reuse = await db.paymentTransaction.findFirst({
      where: { orderId, status: 'PENDING', provider: route.code, grossMinor: order.totalMinor, sellerPaymentAccountId: route.account.id, checkoutUrl: { not: null }, createdAt: { gte: new Date(Date.now() - LINK_REUSE_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    await this.keepHold(tenantId, orderId);
    if (reuse) return { reference: reuse.reference, checkoutUrl: reuse.checkoutUrl!, amountMinor: reuse.grossMinor, currency: reuse.currency, provider: reuse.provider, reused: true };

    const rate = await this.commission.effectiveRate(tenantId, route.code);
    const commissionMinor = commissionFor(order.totalMinor, rate?.bps ?? 0);
    const reference = `${order.reference}-${randomBytes(6).toString('hex')}`;
    const txn = await db.paymentTransaction.create({
      data: {
        purpose: 'ORDER', orderId, customerId: order.customerId, provider: route.code, reference, idempotencyKey: `pay:${reference}`,
        currency: order.currency, grossMinor: order.totalMinor, platformCommissionMinor: commissionMinor,
        settlementMode: route.split ? 'SPLIT' : 'DIRECT', sellerPaymentAccountId: route.account.id, status: 'INITIALIZED',
      } as Prisma.PaymentTransactionUncheckedCreateInput,
    });
    const checkoutUrl = await this.initialize(route.adapter, txn, route.creds, {
      reference, amountMinor: order.totalMinor, currency: order.currency, customerEmail: email, customerName: order.customer?.fullName ?? null, callbackUrl: this.returnUrl(),
      metadata: { purpose: 'order', order_reference: order.reference, tenant_id: tenantId },
      ...(route.split ? { split: { subaccountCode: route.split.subaccountCode, platformChargeMinor: commissionMinor } } : {}),
    });
    await this.audit.record({
      action: 'payment.initialized', actorId: opts.actorId, tenantId, entityType: 'order', entityId: orderId,
      metadata: { reference, provider: route.code, via: opts.via, amountMinor: order.totalMinor.toString(), commissionMinor: commissionMinor.toString(), mode: txn.settlementMode },
    });
    return { reference, checkoutUrl, amountMinor: order.totalMinor, currency: order.currency, provider: route.code, reused: false };
  }

  /** Storefront "Pay now": the private tracking token proves the caller is the customer. */
  async startStorefrontPayment(tenantId: string, orderReference: string, token: string, email?: string) {
    if (!/^LS-[A-Z0-9]{6}$/i.test(orderReference) || !token || token.length > 100) throw new NotFoundException('Order not found');
    const order = await this.prisma.forTenant(tenantId).order.findFirst({
      where: { reference: orderReference.toUpperCase(), trackingTokenHash: this.crypto.hashToken(token) }, select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.startOrderPayment(tenantId, order.id, { email, actorId: null, via: 'storefront' });
  }

  // ───────────────────────── Subscription invoices (platform account) ─────────────────────────

  async startInvoicePayment(tenantId: string, actorId: string, invoiceId: string) {
    const invoice = await this.prisma.forTenant(tenantId).subscriptionInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status !== 'OPEN') throw new ConflictException('This invoice is not open');
    const creds = this.platformCreds(BILLING_PROVIDER);
    const adapter = (await this.isEnabled(BILLING_PROVIDER)) && creds ? this.registry.get(BILLING_PROVIDER) : null;
    if (!adapter || !creds) throw new ServiceUnavailableException({ code: 'PAYMENTS_NOT_ENABLED', message: 'Online payment is not available yet. Your invoice stays open.' });
    const db = this.prisma.forTenant(tenantId);
    const reuse = await db.paymentTransaction.findFirst({
      where: { subscriptionInvoiceId: invoiceId, status: 'PENDING', grossMinor: invoice.amountMinor, checkoutUrl: { not: null }, createdAt: { gte: new Date(Date.now() - LINK_REUSE_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (reuse) return { reference: reuse.reference, checkoutUrl: reuse.checkoutUrl!, reused: true };
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { email: true } });
    const reference = `LSB-${invoice.number}-${randomBytes(6).toString('hex')}`.replace(/[^A-Za-z0-9.=-]/g, '-');
    const txn = await db.paymentTransaction.create({
      data: {
        purpose: 'SUBSCRIPTION', provider: BILLING_PROVIDER, reference, idempotencyKey: `pay:${reference}`, currency: invoice.currency,
        grossMinor: invoice.amountMinor, subscriptionInvoiceId: invoiceId, status: 'INITIALIZED',
      } as Prisma.PaymentTransactionUncheckedCreateInput,
    });
    const checkoutUrl = await this.initialize(adapter, txn, creds, {
      reference, amountMinor: invoice.amountMinor, currency: invoice.currency, customerEmail: user.email, callbackUrl: this.returnUrl(),
      metadata: { purpose: 'subscription', invoice_number: invoice.number, tenant_id: tenantId },
    });
    await this.audit.record({ action: 'billing.payment_initialized', actorId, tenantId, entityType: 'subscription_invoice', entityId: invoiceId, metadata: { reference } });
    return { reference, checkoutUrl, reused: false };
  }

  // ───────────────────────── Verification (the only way money is recognised) ─────────────────────────

  /**
   * Asks the provider about a payment and applies the answer. Safe to call any number of times from any path.
   * Returns null for unknown references.
   */
  async verifyReference(reference: string, source: VerifySource) {
    const t = await this.prisma.paymentTransaction.findUnique({ where: { reference } });
    if (!t) return null;
    if (!this.needsVerification(t)) return this.summary(t);
    const adapter = this.registry.get(t.provider);
    if (!adapter) return this.summary(t);
    const creds = await this.credsFor(t);
    // ProviderUnavailableError propagates; nothing changes.
    const v = await adapter.verifyPayment(creds, reference, { providerCheckoutId: t.providerCheckoutId });
    return this.applyVerification(t.id, t.tenantId, t.purpose, t.provider, v, source);
  }

  /** Public status check for the payment return page. Never fails because the provider is down. */
  async publicStatus(reference: string) {
    if (!/^[A-Za-z0-9.=-]{8,100}$/.test(reference)) throw new NotFoundException('Payment not found');
    let s: Awaited<ReturnType<PaymentsService['verifyReference']>>;
    let providerDown = false;
    try {
      s = await this.verifyReference(reference, 'return');
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError)) throw e;
      providerDown = true;
      const t = await this.prisma.paymentTransaction.findUnique({ where: { reference } });
      s = t ? this.summary(t) : null;
    }
    if (!s) throw new NotFoundException('Payment not found');
    const t = await this.prisma.paymentTransaction.findUniqueOrThrow({
      where: { reference }, select: { purpose: true, order: { select: { reference: true } }, tenant: { select: { slug: true, businessName: true } } },
    });
    return {
      status: s.status, amountMinor: s.grossMinor, currency: s.currency, provider: s.provider, providerDown, kind: t.purpose === 'ORDER' ? 'order' : 'subscription',
      orderReference: t.order?.reference ?? null, store: t.purpose === 'ORDER' ? { slug: t.tenant.slug, businessName: t.tenant.businessName } : null,
    };
  }

  /** Seller "check payment" on an order: re-verifies every open attempt. */
  async verifyOrder(tenantId: string, orderId: string) {
    const db = this.prisma.forTenant(tenantId);
    const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found');
    const open = await db.paymentTransaction.findMany({ where: { orderId, status: { in: [...OPEN_STATUSES] }, checkoutUrl: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5 });
    const results = [];
    for (const t of open) {
      try {
        results.push(await this.verifyReference(t.reference, 'staff'));
      } catch (e) {
        if (e instanceof ProviderUnavailableError) throw this.unavailable();
        throw e;
      }
    }
    return { checked: results.length, results };
  }

  private needsVerification(t: PaymentTransaction) {
    if (t.status === 'SUCCEEDED' || t.status === 'REVERSED') return false;
    if (!t.checkoutUrl) return false; // never reached the provider
    if (t.status === 'FAILED') return false;
    return Date.now() - t.createdAt.getTime() < RECONCILE_WINDOW_MS + 24 * 60 * MIN;
  }

  private async applyVerification(id: string, tenantId: string, purpose: 'ORDER' | 'SUBSCRIPTION', provider: PaymentProviderCode, v: VerifyPaymentResult, source: VerifySource) {
    const verifiedBy = `${provider.toLowerCase()}:${source}`;
    const run = <T>(fn: (tx: Tx) => Promise<T>) => (purpose === 'ORDER' ? this.prisma.tenantTransaction(tenantId, fn) : this.prisma.$transaction(fn));
    const outcome = await run(async (tx) => {
      const t = await this.lockTransaction(tx, id);
      if (t.status === 'SUCCEEDED' || t.status === 'REVERSED') return { t, event: null as string | null };
      const raw = (v.raw ?? undefined) as Prisma.InputJsonValue | undefined;

      if (v.status === 'SUCCEEDED') {
        if (v.amountMinor !== t.grossMinor || (v.currency ?? '').toUpperCase() !== t.currency) {
          const u = await tx.paymentTransaction.update({ where: { id }, data: { status: 'FAILED', failureReason: 'AMOUNT_MISMATCH', rawProviderResponse: raw, providerReference: v.providerReference } });
          return { t: u, event: 'payment.amount_mismatch' };
        }
        const fee = v.feeMinor ?? 0n;
        const mode = journalMode(t.settlementMode);
        const proceeds = t.grossMinor - t.platformCommissionMinor - fee;
        let attention: string | null = null;

        if (purpose === 'ORDER') {
          const j = saleJournals({ grossMinor: t.grossMinor, feeMinor: fee, commissionMinor: t.platformCommissionMinor, mode });
          await this.ledger.post(tx, { tenantId, currency: t.currency, transactionId: id, lines: j.seller });
          if (j.platform) await this.ledger.post(tx, { tenantId: null, currency: t.currency, transactionId: id, lines: j.platform });
          const { payable, status } = await this.orders.isPayableTx(tx, tenantId, t.orderId!);
          if (payable) {
            await this.orders.markPaidTx(tx, tenantId, t.orderId!, { verifiedBy });
          } else {
            attention = status === 'CANCELLED' ? ATTENTION.ORDER_CLOSED : ATTENTION.DUPLICATE;
            await this.orders.noteTx(tx, tenantId, t.orderId!, `Payment ${t.reference} was received but the order was already ${status === 'CANCELLED' ? 'cancelled' : 'paid'}. Refund it from the order's payments.`);
          }
        } else {
          const inv = t.subscriptionInvoiceId ? await tx.subscriptionInvoice.findUnique({ where: { id: t.subscriptionInvoiceId }, select: { kind: true } }) : null;
          if (inv?.kind === 'COMMISSION') {
            const j = commissionSettlementJournals(t.grossMinor, fee);
            await this.ledger.post(tx, { tenantId, currency: t.currency, transactionId: id, lines: j.seller });
            await this.ledger.post(tx, { tenantId: null, currency: t.currency, transactionId: id, lines: j.platform });
          } else {
            await this.ledger.post(tx, { tenantId: null, currency: t.currency, transactionId: id, lines: subscriptionJournal(t.grossMinor, fee) });
          }
          const applied = t.subscriptionInvoiceId ? await this.subscriptions.applyPaidInvoiceTx(tx, t.subscriptionInvoiceId, v.paidAt ?? new Date(), id, null) : { applied: false };
          if (!applied.applied) attention = ATTENTION.INVOICE_CLOSED;
        }
        const u = await tx.paymentTransaction.update({
          where: { id },
          data: {
            status: 'SUCCEEDED', providerReference: v.providerReference, providerFeeMinor: v.feeMinor, sellerProceedsMinor: purpose === 'ORDER' && proceeds >= 0n ? proceeds : null,
            verifiedAt: new Date(), verifiedBy, settlementStatus: 'PENDING', failureReason: attention, rawProviderResponse: raw,
          },
        });
        return { t: u, event: attention ? 'payment.needs_refund' : 'payment.verified' };
      }

      if (v.status === 'FAILED' || v.status === 'REVERSED') {
        const u = await tx.paymentTransaction.update({ where: { id }, data: { status: v.status, failureReason: v.message?.slice(0, 300) ?? v.status, rawProviderResponse: raw, providerReference: v.providerReference } });
        return { t: u, event: v.status === 'FAILED' ? 'payment.failed' : null };
      }
      if (v.status === 'NOT_FOUND') {
        // The customer never reached the payment page; after an hour stop asking.
        if (Date.now() - t.createdAt.getTime() > 60 * MIN) {
          return { t: await tx.paymentTransaction.update({ where: { id }, data: { status: 'ABANDONED' } }), event: null };
        }
        return { t, event: null };
      }
      // PENDING / ABANDONED: not final; keep checking until the window closes.
      const next = v.status === 'ABANDONED' ? 'ABANDONED' : 'PENDING';
      return { t: t.status === next ? t : await tx.paymentTransaction.update({ where: { id }, data: { status: next } }), event: null };
    });

    if (outcome.event) {
      const t = outcome.t;
      await this.audit.record({
        action: outcome.event, tenantId, entityType: t.purpose === 'ORDER' ? 'order' : 'subscription_invoice', entityId: t.orderId ?? t.subscriptionInvoiceId ?? undefined,
        metadata: { reference: t.reference, source, amountMinor: t.grossMinor.toString(), verifiedAmountMinor: v.amountMinor?.toString() ?? null, attention: t.failureReason },
      });
      if (outcome.event !== 'payment.verified') this.logger.warn(`${outcome.event}: ${t.reference}`);
    }
    return this.summary(outcome.t);
  }

  // ───────────────────────── Refunds (§26 #12) ─────────────────────────

  async refund(tenantId: string, actorId: string, orderId: string, dto: { amountMinor?: string; reason?: string; transactionId?: string }, idempotencyKey?: string) {
    const db = this.prisma.forTenant(tenantId);
    if (!(await db.order.findUnique({ where: { id: orderId }, select: { id: true } }))) throw new NotFoundException('Order not found');
    const paid = await db.paymentTransaction.findMany({ where: { orderId, status: 'SUCCEEDED', ...(dto.transactionId ? { id: dto.transactionId } : {}) }, orderBy: { createdAt: 'asc' } });
    if (!paid.length) throw new ConflictException({ code: 'NOTHING_TO_REFUND', message: 'This order has no verified payment to refund.' });
    // Default: the payment that settled the order (not one flagged as a stray/duplicate).
    const target = paid.find((p) => !p.failureReason) ?? paid[0];
    // A bank transfer is refunded by the seller from their own bank; LiveSell records it (it can't send the money).
    const manual = target.provider === 'BANK_TRANSFER';
    if (manual && !dto.reason?.trim()) {
      throw new BadRequestException({ code: 'REFUND_DETAILS_REQUIRED', message: 'Say how you refunded the customer, e.g. "Transfer from GTBank, ref 000123".' });
    }
    const adapter = manual ? null : this.registry.get(target.provider);
    if (!manual && !adapter) throw this.unavailable();
    const key = `refund:${tenantId}:${idempotencyKey ?? randomBytes(12).toString('hex')}`;

    const existing = await db.paymentRefund.findUnique({ where: { idempotencyKey: key } });
    if (existing) return { refund: existing, duplicate: true };

    let refund;
    try {
      refund = await this.prisma.tenantTransaction(tenantId, async (tx) => {
        const t = await this.lockTransaction(tx, target.id);
        const taken = await tx.paymentRefund.aggregate({ where: { transactionId: t.id, status: { not: 'FAILED' } }, _sum: { amountMinor: true } });
        const remaining = t.grossMinor - (taken._sum.amountMinor ?? 0n);
        const amount = dto.amountMinor != null ? BigInt(dto.amountMinor) : remaining;
        if (remaining <= 0n) throw new ConflictException({ code: 'FULLY_REFUNDED', message: 'This payment has already been fully refunded.' });
        if (adapter && !adapter.capabilities.multipleRefunds && (taken._sum.amountMinor ?? 0n) > 0n) {
          throw new ConflictException({ code: 'ONE_REFUND_ONLY', message: `${adapter.displayName} allows one refund per payment, and this payment already has one.` });
        }
        if (amount <= 0n || amount > remaining) throw new BadRequestException({ code: 'REFUND_TOO_LARGE', message: `You can refund at most ${remaining} kobo on this payment.`, remainingMinor: remaining.toString() });
        if (adapter && amount < adapter.capabilities.minRefundMinor) {
          throw new BadRequestException({ code: 'REFUND_TOO_SMALL', message: `${adapter.displayName} refunds must be at least ${adapter.capabilities.minRefundMinor} kobo.` });
        }
        return tx.paymentRefund.create({
          data: { transactionId: t.id, amountMinor: amount, currency: t.currency, reason: dto.reason?.slice(0, 300) ?? null, status: 'REQUESTED', idempotencyKey: key, requestedBy: actorId } as Prisma.PaymentRefundUncheckedCreateInput,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { refund: await db.paymentRefund.findUniqueOrThrow({ where: { idempotencyKey: key } }), duplicate: true };
      throw e;
    }
    await this.audit.record({
      action: manual ? 'payment.refund_recorded' : 'payment.refund_requested', actorId, tenantId, entityType: 'order', entityId: orderId,
      metadata: { refundId: refund.id, amountMinor: refund.amountMinor.toString(), reference: target.reference, manual },
    });
    if (manual || !adapter) {
      // Seller-confirmed: applied at once (ledger reversal from SELLER_BANK and the order's refund status).
      await this.settleRefund(tenantId, refund.id, 'SUCCEEDED', actorId);
      return { refund: await db.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } }), duplicate: false };
    }

    const creds = await this.credsFor(target);
    try {
      const r = await adapter.refundPayment(creds, {
        reference: target.reference, providerReference: target.providerReference, amountMinor: refund.amountMinor, currency: refund.currency, note: dto.reason, refundId: refund.id,
      });
      await db.paymentRefund.update({ where: { id: refund.id }, data: { status: 'PROCESSING', providerReference: r.providerReference } });
      if (r.status !== 'PROCESSING') await this.settleRefund(tenantId, refund.id, r.status, actorId);
    } catch (e) {
      const unavailable = e instanceof ProviderUnavailableError;
      await db.paymentRefund.update({ where: { id: refund.id }, data: { status: 'FAILED' } });
      await this.audit.record({ action: 'payment.refund_failed', actorId, tenantId, entityType: 'order', entityId: orderId, metadata: { refundId: refund.id, unavailable, message: (e as Error).message } });
      if (unavailable) throw new ServiceUnavailableException({ code: 'PROVIDER_UNAVAILABLE', message: `${adapter.displayName} did not respond. Check your ${adapter.displayName} dashboard before trying again.` });
      if (e instanceof ProviderRequestError) throw new UnprocessableEntityException({ code: 'REFUND_DECLINED', message: `${adapter.displayName} declined the refund: ${e.message}` });
      throw e;
    }
    return { refund: await db.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } }), duplicate: false };
  }

  /** Applies a provider-confirmed refund outcome once: ledger reversal and order status in one transaction. */
  async settleRefund(tenantId: string, refundId: string, status: RefundStatus, actorId: string | null = null) {
    if (status === 'PROCESSING') return false;
    const done = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM payment_refunds WHERE id = ${refundId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
      if (!rows.length) return null;
      const refund = await tx.paymentRefund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status !== 'PROCESSING' && refund.status !== 'REQUESTED') return null;
      if (status === 'FAILED') {
        await tx.paymentRefund.update({ where: { id: refundId }, data: { status: 'FAILED' } });
        return { refund, failed: true };
      }
      const t = await this.lockTransaction(tx, refund.transactionId);
      const prior = await tx.paymentRefund.findMany({ where: { transactionId: t.id, status: 'SUCCEEDED' }, select: { amountMinor: true } });
      const refundedBefore = prior.reduce((s, r) => s + r.amountMinor, 0n);
      const fully = refundedBefore + refund.amountMinor >= t.grossMinor;
      const reversedBefore = prior.reduce((s, r) => s + commissionReversal(t.platformCommissionMinor, t.grossMinor, r.amountMinor, 0n, false), 0n);
      const cr = commissionReversal(t.platformCommissionMinor, t.grossMinor, refund.amountMinor, reversedBefore, fully);
      const j = refundJournals(refund.amountMinor, cr, journalMode(t.settlementMode));
      await this.ledger.post(tx, { tenantId, currency: t.currency, transactionId: t.id, lines: j.seller });
      if (j.platform) await this.ledger.post(tx, { tenantId: null, currency: t.currency, transactionId: t.id, lines: j.platform });
      await tx.paymentRefund.update({ where: { id: refundId }, data: { status: 'SUCCEEDED' } });
      // A stray/duplicate payment doesn't change the order; refunding the payment that settled it does.
      if (t.orderId) {
        const note = `Refund of ${refund.amountMinor} kobo on ${t.reference} completed${fully ? ' (payment fully refunded)' : ''}`;
        if (t.failureReason) await this.orders.noteTx(tx, tenantId, t.orderId, note, actorId);
        else await this.orders.applyRefundTx(tx, tenantId, t.orderId, { fully, actorId, note });
      }
      return { refund, failed: false };
    });
    if (done) {
      await this.audit.record({
        action: done.failed ? 'payment.refund_failed' : 'payment.refunded', actorId, tenantId, entityType: 'payment_refund', entityId: refundId,
        metadata: { amountMinor: done.refund.amountMinor.toString() },
      });
    }
    return !!done;
  }

  // ───────────────────────── Webhooks (a hint to verify; never trusted for money) ─────────────────────────

  /**
   * `accountId` set: the event comes from a seller's own provider account and is checked with that account's
   * secret. Otherwise it is the platform account's. Duplicates are dropped on (provider, event id) — §26 #3.
   */
  async handleWebhook(code: PaymentProviderCode, accountId: string | null, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const adapter = this.registry.get(code);
    if (!adapter) throw new NotFoundException('Unknown payment provider');
    if (!this.webhooksEnabled(code)) return { received: true, processed: false, reason: 'webhooks_disabled' };
    if (!rawBody?.length) throw new BadRequestException('Empty body');
    let creds: ProviderCredentials | null = null;
    if (accountId) {
      const acc = await this.prisma.sellerPaymentAccount.findFirst({ where: { id: accountId, settlementMode: 'DIRECT', isActive: true, provider: { code } } });
      if (acc?.credentialsEnc) creds = this.decryptCreds(acc.credentialsEnc, acc.tenantId);
    } else {
      creds = this.platformCreds(code);
    }
    const evt = creds ? adapter.parseWebhook(creds, rawBody, headers) : null;
    if (!evt) throw new UnauthorizedException('Invalid signature');

    let payload: Prisma.InputJsonValue;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    let event;
    try {
      event = await this.prisma.paymentWebhookEvent.create({ data: { provider: code, eventId: evt.eventId.slice(0, 200), eventType: evt.eventType.slice(0, 100), signatureValid: true, payload } });
    } catch (e) {
      if (isUniqueViolation(e)) return { received: true, duplicate: true }; // §26 #3
      throw e;
    }

    try {
      let t: PaymentTransaction | null = null;
      let refund: { id: string; providerReference: string | null } | null = null;
      if (evt.refundProviderReference) {
        const r = await this.prisma.paymentRefund.findFirst({ where: { providerReference: evt.refundProviderReference, transaction: { provider: code } }, include: { transaction: true } });
        if (r) { t = r.transaction; refund = r; }
      } else if (evt.paymentReference) {
        t = await this.prisma.paymentTransaction.findUnique({ where: { reference: evt.paymentReference } });
      }
      if (!t && evt.providerCheckoutId) t = await this.prisma.paymentTransaction.findFirst({ where: { provider: code, providerCheckoutId: evt.providerCheckoutId } });
      // The event must come from the account that owns the payment.
      const owns = t && t.provider === code && (accountId ? t.sellerPaymentAccountId === accountId : t.settlementMode !== 'DIRECT');
      if (!t || !owns) {
        await this.prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: 'IGNORED', processedAt: new Date(), error: t ? 'account mismatch' : 'unknown payment' } });
        return { received: true, processed: false };
      }
      if (refund?.providerReference) {
        const r = await adapter.getRefund(await this.credsFor(t), refund.providerReference);
        await this.settleRefund(t.tenantId, refund.id, r.status);
      } else if (!evt.eventType.startsWith('refund.')) {
        await this.verifyReference(t.reference, 'webhook');
      }
      await this.prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: 'PROCESSED', processedAt: new Date(), transactionId: t.id } });
      return { received: true, processed: true };
    } catch (e) {
      await this.prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: 'FAILED', processedAt: new Date(), error: (e as Error).message.slice(0, 500) } });
      if (e instanceof ProviderUnavailableError) throw this.unavailable(adapter.displayName); // non-2xx so the provider retries
      throw e;
    }
  }

  // ───────────────────────── Reconciliation job ─────────────────────────

  /** Re-checks open payments and processing refunds with the provider. Idempotent; safe on several workers. */
  async reconcile(now = new Date()) {
    const out = { checked: 0, succeeded: 0, refundsSettled: 0, abandoned: 0, errors: 0 };
    const open = await this.prisma.paymentTransaction.findMany({
      where: { status: { in: [...OPEN_STATUSES] }, checkoutUrl: { not: null }, createdAt: { gte: new Date(now.getTime() - RECONCILE_WINDOW_MS), lte: new Date(now.getTime() - 2 * MIN) } },
      orderBy: { createdAt: 'asc' }, take: 100, select: { reference: true },
    });
    for (const { reference } of open) {
      try {
        const s = await this.verifyReference(reference, 'reconcile');
        out.checked++;
        if (s?.status === 'SUCCEEDED') out.succeeded++;
      } catch (e) {
        out.errors++;
        if (e instanceof ProviderUnavailableError) break; // try again next run
        this.logger.error(`Reconcile ${reference}: ${(e as Error).message}`);
      }
    }
    out.abandoned = (await this.prisma.paymentTransaction.updateMany({
      where: { status: { in: ['INITIALIZED', 'PENDING'] }, createdAt: { lt: new Date(now.getTime() - RECONCILE_WINDOW_MS) } }, data: { status: 'ABANDONED' },
    })).count;

    const refunds = await this.prisma.paymentRefund.findMany({ where: { status: 'PROCESSING', providerReference: { not: null } }, take: 100, include: { transaction: true } });
    for (const r of refunds) {
      const adapter = this.registry.get(r.transaction.provider);
      if (!adapter) continue;
      try {
        const res = await adapter.getRefund(await this.credsFor(r.transaction), r.providerReference!);
        if (await this.settleRefund(r.tenantId, r.id, res.status)) out.refundsSettled++;
      } catch (e) {
        out.errors++;
        if (e instanceof ProviderUnavailableError) break;
        this.logger.error(`Reconcile refund ${r.id}: ${(e as Error).message}`);
      }
    }
    if (out.succeeded || out.refundsSettled || out.abandoned || out.errors) this.logger.log(`Payments reconcile: ${JSON.stringify(out)}`);
    return out;
  }

  // ───────────────────────── Seller payment settings ─────────────────────────

  /** Every integrated provider with this store's connection (if any). Secrets are never returned. */
  async settings(tenantId: string) {
    const rows = await this.prisma.paymentProvider.findMany({ where: { code: { in: PROVIDER_CODES } } });
    const accounts = await this.prisma.forTenant(tenantId).sellerPaymentAccount.findMany({ include: { provider: { select: { code: true } } } });
    const bankIds = accounts.map((a) => a.bankAccountId).filter((x): x is string => !!x);
    const banks = bankIds.length ? await this.prisma.forTenant(tenantId).bankAccount.findMany({ where: { id: { in: bankIds } } }) : [];
    const commission = await this.commission.effectiveRate(tenantId);
    const route = await this.sellerRoute(tenantId).catch(() => null);
    const providers = PROVIDER_CODES.filter((c) => this.registry.get(c)).map((code) => {
      const acc = accounts.find((a) => a.provider.code === code) ?? null;
      return this.providerView(code, rows.find((r) => r.code === code)?.isEnabled ?? false, acc, acc?.bankAccountId ? banks.find((b) => b.id === acc.bankAccountId) ?? null : null);
    });
    return { commission, defaultProvider: route?.code ?? null, providers };
  }

  /** One provider's card: what's connected, test mode, webhook URL and what the provider supports. */
  async providerSettings(tenantId: string, code: PaymentProviderCode) {
    const row = await this.prisma.paymentProvider.findUnique({ where: { code } });
    const acc = await this.prisma.forTenant(tenantId).sellerPaymentAccount.findFirst({ where: { provider: { code } } });
    const bank = acc?.bankAccountId ? await this.prisma.forTenant(tenantId).bankAccount.findUnique({ where: { id: acc.bankAccountId } }) : null;
    return { ...this.providerView(code, !!row?.isEnabled, acc, bank), commission: await this.commission.effectiveRate(tenantId, code) };
  }

  async connectDirect(tenantId: string, actorId: string, code: PaymentProviderCode, dto: { secretKey: string; publicKey?: string; webhookSecret?: string }, ip?: string) {
    const adapter = await this.enabledAdapter(code);
    const sk = dto.secretKey.trim();
    const pk = dto.publicKey?.trim() || null;
    const mode = adapter.keyMode(sk);
    if (!mode) throw new BadRequestException({ code: 'INVALID_KEY_FORMAT', message: `That doesn't look like a ${adapter.displayName} secret key. ${KEY_HINT[code]}` });
    if (code === 'PAYSTACK') {
      const pkMode = pk ? /^pk_(test|live)_[A-Za-z0-9]{10,}$/.exec(pk)?.[1] : null;
      if (!pkMode) throw new BadRequestException({ code: 'INVALID_KEY_FORMAT', message: `Paste the secret key and public key. ${KEY_HINT.PAYSTACK}` });
      if (pkMode !== mode) throw new BadRequestException({ code: 'KEY_MODE_MISMATCH', message: 'Both keys must be test keys or both live keys.' });
    }
    if (code === 'FLUTTERWAVE' && pk) {
      const pkMode = /^FLWPUBK(_TEST)?-[A-Za-z0-9]{16,}-X$/.exec(pk);
      if (!pkMode) throw new BadRequestException({ code: 'INVALID_KEY_FORMAT', message: 'The public key starts with FLWPUBK.' });
      if ((pkMode[1] ? 'test' : 'live') !== mode) throw new BadRequestException({ code: 'KEY_MODE_MISMATCH', message: 'Both keys must be test keys or both live keys.' });
    }
    const webhookSecret = dto.webhookSecret?.trim() || null;
    if (webhookSecret && adapter.capabilities.webhookSecret !== 'separate') throw new BadRequestException({ code: 'WEBHOOK_SECRET_NOT_USED', message: `${adapter.displayName} signs webhooks with your secret key; no separate secret is needed.` });
    let valid: boolean;
    try {
      ({ valid } = await adapter.validateCredentials({ secretKey: sk }));
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw this.unavailable(adapter.displayName);
      throw e;
    }
    if (!valid) throw new UnprocessableEntityException({ code: 'INVALID_KEY', message: `${adapter.displayName} did not accept this secret key.` });
    // Keep a previously saved webhook secret when the seller only rotates the API key.
    const existing = await this.findAccount(tenantId, code);
    const keptSecret = webhookSecret ?? (existing?.credentialsEnc && existing.settlementMode === 'DIRECT' ? this.decryptCreds(existing.credentialsEnc, tenantId).webhookSecret ?? null : null);
    const acc = await this.upsertAccount(tenantId, code, {
      settlementMode: 'DIRECT', credentialsEnc: this.encryptCreds({ secretKey: sk, webhookSecret: keptSecret }, tenantId), publicKey: pk, subaccountCode: null, bankAccountId: null,
      testMode: mode === 'test', lastVerifiedAt: new Date(), isActive: true,
    });
    await this.audit.record({ action: 'payments.account_connected', actorId, tenantId, entityType: 'seller_payment_account', entityId: acc.id, ip, metadata: { provider: code, mode: 'DIRECT', testMode: mode === 'test', webhookSecretSaved: !!keptSecret } });
    return this.providerSettings(tenantId, code);
  }

  async connectSplit(tenantId: string, actorId: string, code: PaymentProviderCode, dto: { bankCode: string; accountNumber: string }, ip?: string) {
    const adapter = await this.enabledAdapter(code);
    const creds = this.platformCreds(code);
    if (!adapter.capabilities.split || !creds) {
      throw new ServiceUnavailableException({ code: 'SPLIT_NOT_AVAILABLE', message: `Settlement through LiveSell is not available on ${adapter.displayName} yet. Connect your own ${adapter.displayName} account instead.` });
    }
    try {
      const banks = await this.banks(code);
      const bank = banks.find((b) => b.code === dto.bankCode);
      if (!bank) throw new BadRequestException({ code: 'UNKNOWN_BANK', message: 'Choose your bank from the list.' });
      const resolved = await adapter.resolveAccount(creds, dto);
      if (!resolved) throw new UnprocessableEntityException({ code: 'ACCOUNT_NOT_RESOLVED', message: "We couldn't confirm that account number with the bank. Check it and try again." });
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessName: true, phone: true, email: true } });
      const { subaccountCode } = await adapter.createSubaccount(creds, {
        businessName: tenant.businessName, bankCode: dto.bankCode, accountNumber: dto.accountNumber, contactEmail: tenant.email ?? undefined, contactPhone: tenant.phone ?? undefined,
      });
      const db = this.prisma.forTenant(tenantId);
      const bankAccount = await db.bankAccount.create({
        data: {
          bankName: bank.name, bankCode: bank.code, accountName: resolved.accountName, accountNumberEnc: this.crypto.encrypt(dto.accountNumber, tenantId),
          accountNumberLast4: dto.accountNumber.slice(-4), currencies: ['NGN'],
        } as Prisma.BankAccountUncheckedCreateInput,
      });
      const acc = await this.upsertAccount(tenantId, code, {
        settlementMode: 'SPLIT', credentialsEnc: null, publicKey: null, subaccountCode, bankAccountId: bankAccount.id,
        testMode: adapter.keyMode(creds.secretKey) === 'test', lastVerifiedAt: new Date(), isActive: true,
      });
      await this.audit.record({ action: 'payments.account_connected', actorId, tenantId, entityType: 'seller_payment_account', entityId: acc.id, ip, metadata: { provider: code, mode: 'SPLIT', bank: bank.name, last4: bankAccount.accountNumberLast4 } });
      return this.providerSettings(tenantId, code);
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw this.unavailable(adapter.displayName);
      if (e instanceof ProviderRequestError) throw new UnprocessableEntityException({ code: 'PROVIDER_REJECTED', message: e.message });
      throw e;
    }
  }

  async setActive(tenantId: string, actorId: string, code: PaymentProviderCode, isActive: boolean) {
    const acc = await this.findAccount(tenantId, code);
    if (!acc) throw new NotFoundException(`No ${this.name(code)} account is connected`);
    await this.prisma.forTenant(tenantId).sellerPaymentAccount.update({ where: { id: acc.id }, data: { isActive } });
    await this.audit.record({ action: isActive ? 'payments.account_enabled' : 'payments.account_disabled', actorId, tenantId, entityType: 'seller_payment_account', entityId: acc.id, metadata: { provider: code } });
    return this.providerSettings(tenantId, code);
  }

  /** Which connected provider customers pay with. Exactly one account is the default. */
  async setDefault(tenantId: string, actorId: string, code: PaymentProviderCode) {
    const acc = await this.findAccount(tenantId, code);
    if (!acc) throw new NotFoundException(`No ${this.name(code)} account is connected`);
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      await tx.sellerPaymentAccount.updateMany({ where: { id: { not: acc.id } }, data: { isDefault: false } });
      await tx.sellerPaymentAccount.update({ where: { id: acc.id }, data: { isDefault: true } });
    });
    await this.audit.record({ action: 'payments.default_provider_set', actorId, tenantId, entityType: 'seller_payment_account', entityId: acc.id, metadata: { provider: code } });
    return this.settings(tenantId);
  }

  /**
   * Confirms an account name with the bank through a provider's account-resolution API (platform keys: Paystack,
   * then Flutterwave). Null when no provider can resolve it or the account doesn't resolve.
   */
  async resolveBankAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string; via: PaymentProviderCode } | null> {
    for (const code of ['PAYSTACK', 'FLUTTERWAVE'] as const) {
      const adapter = this.registry.get(code);
      const creds = this.platformCreds(code);
      if (!adapter?.capabilities.split || !creds) continue;
      try {
        const r = await adapter.resolveAccount(creds, { bankCode, accountNumber });
        if (r) return { accountName: r.accountName, via: code };
      } catch {
        // unavailable: try the next provider, or fall back to the name the seller typed
      }
    }
    return null;
  }

  /** Nigerian banks for a provider's settlement form. Cached for a day. */
  async banks(code: PaymentProviderCode = 'PAYSTACK'): Promise<Array<{ name: string; code: string }>> {
    const key = `banks:${code}`;
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached);
    const adapter = this.registry.get(code);
    if (!adapter?.capabilities.split) return [];
    const list = await adapter.listBanks(this.platformCreds(code));
    if (list.length) await this.redis.set(key, JSON.stringify(list), 'EX', 86_400).catch(() => undefined);
    return list;
  }

  async listTransactions(tenantId: string, q: { page?: number; pageSize?: number; status?: string }) {
    const db = this.prisma.forTenant(tenantId);
    const page = q.page ?? 1;
    const take = q.pageSize ?? 25;
    const where: Prisma.PaymentTransactionWhereInput = { purpose: 'ORDER', ...(q.status ? { status: q.status as PaymentTransaction['status'] } : {}) };
    const [items, total] = await Promise.all([
      db.paymentTransaction.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take,
        select: {
          id: true, reference: true, provider: true, status: true, grossMinor: true, providerFeeMinor: true, platformCommissionMinor: true, sellerProceedsMinor: true,
          currency: true, settlementMode: true, failureReason: true, verifiedAt: true, createdAt: true, order: { select: { id: true, reference: true } },
          refunds: { select: { amountMinor: true, status: true } },
        },
      }),
      db.paymentTransaction.count({ where }),
    ]);
    return { items, total, page, pageSize: take };
  }

  // ───────────────────────── Platform admin ─────────────────────────

  async listProviders() {
    const rows = await this.prisma.paymentProvider.findMany({ orderBy: { code: 'asc' } });
    return rows.map((p) => {
      const adapter = this.registry.get(p.code);
      return {
        ...p, adapterAvailable: !!adapter, platformKeyConfigured: adapter ? !!this.platformCreds(p.code) : null,
        webhooksEnabled: adapter ? this.webhooksEnabled(p.code) : null, capabilities: adapter?.capabilities ? serializeCaps(adapter.capabilities) : null,
      };
    });
  }

  async updateProvider(actorId: string, code: PaymentProviderCode, dto: { isEnabled?: boolean; sandboxMode?: boolean }) {
    if (dto.isEnabled && !this.registry.get(code)) throw new ConflictException({ code: 'ADAPTER_NOT_AVAILABLE', message: `${code} is not integrated yet and can't be enabled.` });
    const row = await this.prisma.paymentProvider.update({ where: { code }, data: dto });
    await this.audit.record({ action: 'platform.payment_provider_updated', actorId, entityType: 'payment_provider', entityId: row.id, metadata: { code, ...dto } });
    return row;
  }

  // ───────────────────────── internals ─────────────────────────

  private providerView(code: PaymentProviderCode, enabled: boolean, acc: SellerPaymentAccount | null, bank: { bankName: string; accountName: string; accountNumberLast4: string } | null) {
    const adapter = this.registry.get(code)!;
    const creds = acc?.credentialsEnc ? this.decryptCreds(acc.credentialsEnc, acc.tenantId) : null;
    return {
      provider: { code, name: adapter.displayName, enabled },
      splitAvailable: adapter.capabilities.split && !!this.platformCreds(code),
      webhooksEnabled: this.webhooksEnabled(code),
      capabilities: serializeCaps(adapter.capabilities),
      account: acc ? {
        id: acc.id, mode: acc.settlementMode, isActive: acc.isActive, isDefault: acc.isDefault, testMode: acc.testMode, publicKey: acc.publicKey,
        hasSecretKey: !!creds?.secretKey, hasWebhookSecret: adapter.capabilities.webhookSecret === 'secret_key' ? !!creds?.secretKey : !!creds?.webhookSecret,
        subaccountCode: acc.subaccountCode, lastVerifiedAt: acc.lastVerifiedAt,
        bankAccount: bank ? { bankName: bank.bankName, accountName: bank.accountName, last4: bank.accountNumberLast4 } : null,
        webhookUrl: acc.settlementMode === 'DIRECT' ? `${this.apiUrl()}/api/v1/payments/${code.toLowerCase()}/webhook/${acc.id}` : null,
      } : null,
    };
  }

  private async initialize(adapter: PaymentProvider, txn: PaymentTransaction, creds: ProviderCredentials, input: Parameters<PaymentProvider['initializePayment']>[1]) {
    const db = this.prisma.forTenant(txn.tenantId);
    try {
      const r = await adapter.initializePayment(creds, input);
      await db.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'PENDING', checkoutUrl: r.checkoutUrl, providerCheckoutId: r.providerCheckoutId ?? null } });
      return r.checkoutUrl;
    } catch (e) {
      const unavailable = e instanceof ProviderUnavailableError;
      await db.paymentTransaction.update({ where: { id: txn.id }, data: { status: 'FAILED', failureReason: unavailable ? 'PROVIDER_UNAVAILABLE' : (e as Error).message.slice(0, 300) } });
      if (unavailable) throw this.unavailable(adapter.displayName);
      if (e instanceof ProviderRequestError || e instanceof ProviderCapabilityError) {
        throw new BadGatewayException({ code: 'PROVIDER_REJECTED', message: `${adapter.displayName} could not start the payment: ${e.message}` });
      }
      throw e;
    }
  }

  private unavailable(name = 'The payment provider') {
    return new ServiceUnavailableException({ code: 'PROVIDER_UNAVAILABLE', message: `${name} is not responding right now. Nothing was charged and your order is safe; please try again in a few minutes.` });
  }

  /** Keeps the stock hold alive while the customer is on the payment page. */
  private async keepHold(tenantId: string, orderId: string) {
    const min = new Date(Date.now() + PAYMENT_HOLD_MS);
    await this.prisma.forTenant(tenantId).order.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT', reservationExpiresAt: { lt: min } }, data: { reservationExpiresAt: min } });
  }

  private async lockTransaction(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM payment_transactions WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.paymentTransaction.findUniqueOrThrow({ where: { id } });
  }

  private summary(t: PaymentTransaction) {
    return { id: t.id, reference: t.reference, provider: t.provider, status: t.status, grossMinor: t.grossMinor, currency: t.currency, attention: t.status === 'SUCCEEDED' ? t.failureReason : null, verifiedAt: t.verifiedAt };
  }

  private name(code: PaymentProviderCode) {
    return this.registry.get(code)?.displayName ?? code;
  }

  private async isEnabled(code: PaymentProviderCode) {
    const row = await this.prisma.paymentProvider.findUnique({ where: { code }, select: { isEnabled: true } });
    return !!row?.isEnabled && !!this.registry.get(code);
  }

  private async anyEnabled() {
    const rows = await this.prisma.paymentProvider.findMany({ where: { code: { in: PROVIDER_CODES }, isEnabled: true }, select: { code: true } });
    return rows.some((r) => this.registry.get(r.code));
  }

  private async enabledAdapter(code: PaymentProviderCode) {
    const adapter = (await this.isEnabled(code)) ? this.registry.get(code) : null;
    if (!adapter) throw new ServiceUnavailableException({ code: 'PAYMENTS_NOT_ENABLED', message: `${this.name(code)} payments are not available yet.` });
    return adapter;
  }

  /**
   * How this seller is paid right now: the default active account on an enabled provider (else the most recently
   * updated one). DIRECT = the seller's own key; SPLIT = the platform key + the seller's subaccount.
   */
  private async sellerRoute(tenantId: string): Promise<Route | null> {
    const enabled = new Set((await this.prisma.paymentProvider.findMany({ where: { isEnabled: true }, select: { code: true } })).map((r) => r.code));
    const accounts = await this.prisma.forTenant(tenantId).sellerPaymentAccount.findMany({
      where: { isActive: true }, include: { provider: { select: { code: true } } }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    for (const acc of accounts) {
      const code = acc.provider.code;
      const adapter = this.registry.get(code);
      if (!adapter || !enabled.has(code)) continue;
      if (acc.settlementMode === 'DIRECT' && acc.credentialsEnc) return { code, adapter, account: acc, creds: this.decryptCreds(acc.credentialsEnc, tenantId) };
      const platform = this.platformCreds(code);
      if (acc.settlementMode === 'SPLIT' && acc.subaccountCode && platform && adapter.capabilities.split) {
        return { code, adapter, account: acc, creds: platform, split: { subaccountCode: acc.subaccountCode } };
      }
    }
    return null;
  }

  /** Credentials that created a transaction: the seller's own key for DIRECT, otherwise the platform key. */
  private async credsFor(t: Pick<PaymentTransaction, 'tenantId' | 'sellerPaymentAccountId' | 'settlementMode' | 'provider'>): Promise<ProviderCredentials> {
    if (t.settlementMode === 'DIRECT' && t.sellerPaymentAccountId) {
      const acc = await this.prisma.sellerPaymentAccount.findFirst({ where: { id: t.sellerPaymentAccountId, tenantId: t.tenantId } });
      if (!acc?.credentialsEnc) throw new ConflictException(`The ${this.name(t.provider)} account that took this payment is no longer connected`);
      return this.decryptCreds(acc.credentialsEnc, t.tenantId);
    }
    const p = this.platformCreds(t.provider);
    if (!p) throw new ServiceUnavailableException({ code: 'PAYMENTS_NOT_ENABLED', message: `The platform ${this.name(t.provider)} account is not configured.` });
    return p;
  }

  /** Seller credentials are stored as encrypted JSON; Phase 5 Paystack accounts stored the bare key. */
  private decryptCreds(enc: string, tenantId: string): ProviderCredentials {
    const plain = this.crypto.decrypt(enc, tenantId);
    if (!plain.startsWith('{')) return { secretKey: plain };
    const o = JSON.parse(plain) as { secretKey: string; webhookSecret?: string | null };
    return { secretKey: o.secretKey, webhookSecret: o.webhookSecret ?? null };
  }

  private encryptCreds(c: ProviderCredentials, tenantId: string) {
    return this.crypto.encrypt(JSON.stringify({ secretKey: c.secretKey, ...(c.webhookSecret ? { webhookSecret: c.webhookSecret } : {}) }), tenantId);
  }

  private platformCreds(code: PaymentProviderCode): ProviderCredentials | null {
    const get = <K extends keyof Env>(k: K) => this.config.get(k, { infer: true }) as Env[K];
    if (code === 'PAYSTACK') { const k = get('PAYSTACK_SECRET_KEY'); return k ? { secretKey: k } : null; }
    if (code === 'FLUTTERWAVE') { const k = get('FLUTTERWAVE_SECRET_KEY'); return k ? { secretKey: k, webhookSecret: get('FLUTTERWAVE_WEBHOOK_HASH') ?? null } : null; }
    if (code === 'BACHS') { const k = get('BACHS_API_KEY'); return k ? { secretKey: k, webhookSecret: get('BACHS_WEBHOOK_SECRET') ?? null } : null; }
    return null;
  }

  private webhooksEnabled(code: PaymentProviderCode): boolean {
    if (code === 'PAYSTACK') return this.config.get('PAYSTACK_WEBHOOKS_ENABLED', { infer: true });
    if (code === 'FLUTTERWAVE') return this.config.get('FLUTTERWAVE_WEBHOOKS_ENABLED', { infer: true });
    if (code === 'BACHS') return this.config.get('BACHS_WEBHOOKS_ENABLED', { infer: true });
    return false;
  }

  private returnUrl() {
    return `${this.config.get('APP_URL', { infer: true })}/payments/return`;
  }

  private apiUrl() {
    return this.config.get('API_PUBLIC_URL', { infer: true });
  }

  private findAccount(tenantId: string, code: PaymentProviderCode) {
    return this.prisma.forTenant(tenantId).sellerPaymentAccount.findFirst({ where: { provider: { code } } });
  }

  /** Creates or replaces this store's account for a provider. The first connected account becomes the default. */
  private async upsertAccount(tenantId: string, code: PaymentProviderCode, data: Omit<Prisma.SellerPaymentAccountUncheckedCreateInput, 'tenantId' | 'providerId' | 'isDefault'>) {
    const provider = await this.prisma.paymentProvider.findUniqueOrThrow({ where: { code } });
    const db = this.prisma.forTenant(tenantId);
    const existing = await db.sellerPaymentAccount.findFirst({ where: { providerId: provider.id } });
    if (existing) return db.sellerPaymentAccount.update({ where: { id: existing.id }, data });
    const hasDefault = (await db.sellerPaymentAccount.count({ where: { isDefault: true } })) > 0;
    return db.sellerPaymentAccount.create({ data: { ...data, providerId: provider.id, isDefault: !hasDefault } as Prisma.SellerPaymentAccountUncheckedCreateInput });
  }
}

const KEY_HINT: Record<PaymentProviderCode, string> = {
  PAYSTACK: 'Find it in Paystack → Settings → API Keys & Webhooks (sk_test_… or sk_live_…).',
  FLUTTERWAVE: 'Find it in Flutterwave → Settings → API Keys (FLWSECK_TEST-…-X or FLWSECK-…-X).',
  BACHS: 'Find it in the Bachs Developer Portal → API keys (sk_sandbox_… or sk_live_…).',
  BANK_TRANSFER: '',
};

function serializeCaps(c: ProviderCapabilities) {
  return { split: c.split, multipleRefunds: c.multipleRefunds, minRefundMinor: c.minRefundMinor.toString(), webhookSecret: c.webhookSecret, requiresPublicCallback: c.requiresPublicCallback };
}

/** Which journal recipe a transaction's settlement uses. */
export function journalMode(m: PaymentTransaction['settlementMode']): JournalMode {
  return m === 'SPLIT' ? 'SPLIT' : m === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'DIRECT';
}
