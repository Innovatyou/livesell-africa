import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Env } from '../config/env';
import { AuditService } from '../common/audit/audit.service';
import {
  BillingInterval, InvoiceKind, Prisma, SubscriptionEventType, SubscriptionPlan,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addInterval, daysUntil, priceFor, quoteChange, reminderThreshold } from './billing-math';
import { BillingNotifier } from './billing-notifier';
import { CommissionService } from './commission.service';
import { EntitlementsService, LIVE_STATUSES, limitViolations } from './entitlements.service';
import type { PlanLimits } from './plans.service';

type Tx = Prisma.TransactionClient;
const DEFAULT_GRACE_DAYS = 3;
const DEFAULT_REMINDER_DAYS = [7, 3, 1];
const BATCH = 200;

export interface LifecycleResult { trialsEnded: number; renewalsDue: number; renewedWithoutCharge: number; expired: number; cancelled: number; reminders: number }

/**
 * LiveSell's own SaaS subscriptions (never mixed with sellers' sales).
 *
 * States: TRIALING → (trial ends) PAST_DUE with an open invoice → ACTIVE once the invoice is paid.
 * ACTIVE → (period ends) PAST_DUE with a renewal invoice → ACTIVE when paid, or EXPIRED after the grace period.
 * cancelAtPeriodEnd → CANCELLED at the end of the trial/period. Access is allowed in TRIALING, ACTIVE, PAST_DUE.
 *
 * An invoice is marked paid only by `applyPaidInvoiceTx`, which PaymentsService calls after server-side provider
 * verification, in the transaction that records the payment and its ledger journal.
 * Every transition is a guarded conditional update, so the lifecycle job is idempotent and safe to run
 * concurrently on several workers.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly notifier: BillingNotifier,
    private readonly entitlements: EntitlementsService,
    private readonly commission: CommissionService,
  ) {}

  // ───────────────────────── Seller-facing reads ─────────────────────────

  async overview(tenantId: string) {
    const db = this.prisma.forTenant(tenantId);
    const include = { plan: true, pendingPlan: true } as const;
    const current =
      (await db.subscription.findFirst({ where: { status: { in: [...LIVE_STATUSES] } }, include })) ??
      (await db.subscription.findFirst({ orderBy: { createdAt: 'desc' }, include }));
    const [usage, openInvoices, graceDays, commission] = await Promise.all([
      this.entitlements.usage(tenantId),
      db.subscriptionInvoice.findMany({ where: { status: 'OPEN' }, orderBy: { dueAt: 'asc' }, include: { plan: { select: { code: true, name: true } } } }),
      this.graceDays(),
      this.commission.effectiveRate(tenantId),
    ]);
    const now = new Date();
    return {
      subscription: current && {
        id: current.id, status: current.status, interval: current.interval,
        currentPeriodStart: current.currentPeriodStart, currentPeriodEnd: current.currentPeriodEnd,
        trialEndsAt: current.trialEndsAt, cancelAtPeriodEnd: current.cancelAtPeriodEnd, endedAt: current.endedAt,
        daysLeft: Math.max(0, daysUntil(current.currentPeriodEnd, now)),
        accessEndsAt: current.status === 'PAST_DUE' ? addDays(current.currentPeriodEnd, graceDays) : null,
        plan: publicPlan(current.plan),
        pendingChange: current.pendingPlan ? { plan: publicPlan(current.pendingPlan), interval: current.pendingInterval, effectiveAt: current.currentPeriodEnd } : null,
      },
      usage,
      limits: current ? (current.plan.limits as unknown as PlanLimits) : null,
      openInvoices,
      /** Rate the payments module will apply to this seller's verified sales (null: no live subscription). */
      commission,
      paymentCollectionEnabled: !!this.config.get('PAYSTACK_SECRET_KEY', { infer: true }) && !!(await this.prisma.paymentProvider.findUnique({ where: { code: 'PAYSTACK' }, select: { isEnabled: true } }))?.isEnabled,
    };
  }

  invoices(tenantId: string) {
    return this.prisma.forTenant(tenantId).subscriptionInvoice.findMany({
      orderBy: { createdAt: 'desc' }, take: 100, include: { plan: { select: { code: true, name: true } } },
    });
  }

  history(tenantId: string) {
    return this.prisma.forTenant(tenantId).subscriptionEvent.findMany({
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, type: true, fromPlanId: true, toPlanId: true, invoiceId: true, metadata: true, actorId: true, createdAt: true },
    });
  }

  // ───────────────────────── Seller-facing changes ─────────────────────────

  /**
   * - Trial: switch immediately, no charge (trial end date unchanged).
   * - Active upgrade: open a prorated UPGRADE invoice; the plan switches when it is paid.
   * - Active downgrade / annual→monthly: scheduled for the end of the period (usage must fit the new limits).
   * - Past due: the outstanding invoice is replaced by one for the chosen plan.
   * - Expired / cancelled: a REACTIVATION invoice; the subscription restarts when it is paid.
   * - Nothing to pay (commission plans, or credit covers it): applied immediately, no collection.
   * Commission plans are always monthly (there is no fee to discount annually).
   */
  async changePlan(tenantId: string, actorId: string, planCode: string, requestedInterval: BillingInterval) {
    const target = await this.prisma.subscriptionPlan.findUnique({ where: { code: planCode } });
    if (!target || !target.isActive || !target.isPublic) throw new NotFoundException('That plan is not available');
    const interval: BillingInterval = target.pricingModel === 'COMMISSION' ? 'MONTHLY' : requestedInterval;
    const targetPrice = priceFor(target, interval);
    if (targetPrice === null) throw new BadRequestException('This plan has custom pricing. Contact our sales team to subscribe.');

    const result = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const sub = await this.lockCurrent(tx, tenantId);
      if (!sub) throw new ConflictException('No subscription found for this workspace. Contact support.');
      const now = new Date();
      const samePlan = sub.planId === target.id && sub.interval === interval;

      if (sub.status === 'TRIALING') {
        if (samePlan) throw new ConflictException('You are already on this plan');
        await this.assertFits(tenantId, target);
        await tx.subscription.update({ where: { id: sub.id }, data: { planId: target.id, interval, pendingPlanId: null, pendingInterval: null } });
        await this.event(tx, sub, 'PLAN_CHANGED', actorId, { fromPlanId: sub.planId, toPlanId: target.id, metadata: { interval, during: 'trial' } });
        return { action: 'changed' as const };
      }

      if (sub.status === 'ACTIVE') {
        if (samePlan) {
          if (!sub.pendingPlanId) throw new ConflictException('You are already on this plan');
          return this.clearPending(tx, sub, actorId);
        }
        const currentPrice = priceFor(sub.plan, sub.interval);
        if (currentPrice === null) throw new BadRequestException('Your plan has custom pricing. Contact support to change it.');
        const quote = quoteChange({
          currentPrice, currentInterval: sub.interval, targetPrice, targetInterval: interval,
          periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, now,
        });
        await this.voidOpenInvoices(tx, sub, actorId, ['UPGRADE']);
        if (quote.timing === 'period_end') {
          await this.assertFits(tenantId, target);
          await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id, pendingInterval: interval } });
          await this.event(tx, sub, 'DOWNGRADE_SCHEDULED', actorId, { fromPlanId: sub.planId, toPlanId: target.id, metadata: { interval, effectiveAt: sub.currentPeriodEnd.toISOString() } });
          return { action: 'scheduled' as const, effectiveAt: sub.currentPeriodEnd };
        }
        await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null, pendingInterval: null } });
        const invoice = await this.issueInvoice(tx, sub, actorId, {
          kind: 'UPGRADE', plan: target, interval, amountMinor: quote.amountMinor,
          periodStart: quote.periodStart, periodEnd: quote.periodEnd, dueAt: now,
          description: `Upgrade to ${target.name} (${interval.toLowerCase()})`,
        });
        await this.event(tx, sub, 'UPGRADE_REQUESTED', actorId, { fromPlanId: sub.planId, toPlanId: target.id, invoiceId: invoice.id, metadata: { interval } });
        if (quote.amountMinor === 0n) {
          // Fully covered by unused time: nothing to collect, apply now.
          await this.applyPaidInvoiceTx(tx, invoice.id, now, null, actorId);
          return { action: 'changed' as const, invoice };
        }
        return { action: 'payment_required' as const, invoice };
      }

      // PAST_DUE, EXPIRED or CANCELLED: a full-period invoice for the chosen plan.
      await this.assertFits(tenantId, target);
      await this.voidOpenInvoices(tx, sub, actorId);
      const isPastDue = sub.status === 'PAST_DUE';
      const start = isPastDue ? sub.currentPeriodEnd : now;
      const invoice = await this.issueInvoice(tx, sub, actorId, {
        kind: isPastDue ? (sub.trialEndsAt && sub.trialEndsAt.getTime() === sub.currentPeriodEnd.getTime() ? 'TRIAL_CONVERSION' : 'RENEWAL') : 'REACTIVATION',
        plan: target, interval, amountMinor: targetPrice, periodStart: start, periodEnd: addInterval(start, interval), dueAt: now,
        description: `${target.name} (${interval.toLowerCase()})`,
      });
      if (isPastDue) await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null, pendingInterval: null } });
      if (invoice.amountMinor === 0n) {
        await this.applyPaidInvoiceTx(tx, invoice.id, now, null, actorId);
        return { action: 'changed' as const, invoice };
      }
      return { action: 'payment_required' as const, invoice };
    });

    await this.audit.record({
      action: 'billing.plan_change', actorId, tenantId, entityType: 'subscription',
      metadata: { planCode, interval, pricingModel: target.pricingModel, commissionBps: target.commissionBps, result: result.action },
    });
    return result;
  }

  async cancelPendingChange(tenantId: string, actorId: string) {
    return this.prisma.tenantTransaction(tenantId, async (tx) => {
      const sub = await this.lockCurrent(tx, tenantId);
      if (!sub?.pendingPlanId) throw new ConflictException('There is no scheduled plan change');
      return this.clearPending(tx, sub, actorId);
    });
  }

  /** Cancel at the end of the trial / current period. Access continues until then. */
  async scheduleCancel(tenantId: string, actorId: string) {
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const sub = await this.lockCurrent(tx, tenantId);
      if (!sub || !['TRIALING', 'ACTIVE'].includes(sub.status)) throw new ConflictException('Only an active or trial subscription can be cancelled');
      if (sub.cancelAtPeriodEnd) throw new ConflictException('Cancellation is already scheduled');
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, pendingPlanId: null, pendingInterval: null } });
      await this.event(tx, sub, 'CANCEL_SCHEDULED', actorId, { metadata: { effectiveAt: sub.currentPeriodEnd.toISOString() } });
    });
    await this.audit.record({ action: 'billing.cancel_scheduled', actorId, tenantId, entityType: 'subscription' });
    return { status: 'cancel_scheduled' };
  }

  async resume(tenantId: string, actorId: string) {
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const sub = await this.lockCurrent(tx, tenantId);
      if (!sub?.cancelAtPeriodEnd || !['TRIALING', 'ACTIVE'].includes(sub.status)) throw new ConflictException('No cancellation is scheduled');
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
      await this.event(tx, sub, 'RESUMED', actorId, {});
    });
    await this.audit.record({ action: 'billing.resumed', actorId, tenantId, entityType: 'subscription' });
    return { status: 'resumed' };
  }

  // ───────────────────────── Payment hook (Phase 5 caller) ─────────────────────────

  /**
   * Applies a paid invoice. MUST only be called after server-side verification of the payment (provider
   * verify call or signature-verified webhook), inside the same flow that records the transaction.
   * Idempotent: a second call for the same invoice is a no-op.
   */
  async applyPaidInvoice(invoiceId: string, paidAt: Date, transactionId: string | null) {
    return this.prisma.$transaction((tx) => this.applyPaidInvoiceTx(tx, invoiceId, paidAt, transactionId, null));
  }

  /** Same as applyPaidInvoice, inside the caller's transaction (the payments module's verification transaction). */
  async applyPaidInvoiceTx(tx: Tx, invoiceId: string, paidAt: Date, transactionId: string | null, actorId: string | null) {
    const claimed = await tx.subscriptionInvoice.updateMany({
      where: { id: invoiceId, status: 'OPEN' }, data: { status: 'PAID', paidAt, transactionId },
    });
    if (claimed.count !== 1) return { applied: false };
    const inv = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
    if (inv.kind === 'COMMISSION') {
      // A debt for past sales: paying it changes nothing about the plan or period.
      await this.event(tx, sub, 'INVOICE_PAID', actorId, { invoiceId, metadata: { kind: 'COMMISSION', amountMinor: inv.amountMinor.toString(), currency: inv.currency } });
      return { applied: true };
    }
    const base = { planId: inv.planId, interval: inv.interval, retryCount: 0 };

    if (inv.kind === 'UPGRADE') {
      const intervalChanged = inv.interval !== sub.interval;
      await tx.subscription.update({
        where: { id: sub.id },
        data: { ...base, ...(intervalChanged ? { currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd } : {}) },
      });
      await this.event(tx, sub, 'PLAN_CHANGED', actorId, { fromPlanId: sub.planId, toPlanId: inv.planId, invoiceId });
    } else if (inv.kind === 'REACTIVATION') {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { ...base, status: 'ACTIVE', currentPeriodStart: paidAt, currentPeriodEnd: addInterval(paidAt, inv.interval), endedAt: null, cancelAtPeriodEnd: false, pendingPlanId: null, pendingInterval: null },
      });
      await this.event(tx, sub, 'REACTIVATED', actorId, { toPlanId: inv.planId, invoiceId });
    } else {
      // TRIAL_CONVERSION / RENEWAL: the subscription moves into the paid period.
      await tx.subscription.update({
        where: { id: sub.id },
        data: { ...base, status: 'ACTIVE', currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd },
      });
    }
    await this.event(tx, sub, 'INVOICE_PAID', actorId, { invoiceId, metadata: { amountMinor: inv.amountMinor.toString(), currency: inv.currency } });
    await tx.tenant.updateMany({ where: { id: sub.tenantId, status: 'TRIAL' }, data: { status: 'ACTIVE' } });
    return { applied: true };
  }

  // ───────────────────────── Scheduled lifecycle (BullMQ) ─────────────────────────

  /** Platform job: runs across all tenants (raw client, like platform-admin code). Idempotent. */
  async runLifecycle(now = new Date()): Promise<LifecycleResult> {
    const out: LifecycleResult = { trialsEnded: 0, renewalsDue: 0, renewedWithoutCharge: 0, expired: 0, cancelled: 0, reminders: 0 };
    const graceDays = await this.graceDays();

    const trials = await this.prisma.subscription.findMany({ where: { status: 'TRIALING', trialEndsAt: { lte: now } }, take: BATCH, select: { id: true } });
    for (const { id } of trials) {
      const r = await this.safely(id, () => this.endPeriod(id, 'TRIALING', now, graceDays));
      if (r === 'cancelled') out.cancelled++; else if (r === 'renewed') out.renewedWithoutCharge++; else if (r) out.trialsEnded++;
    }
    const due = await this.prisma.subscription.findMany({ where: { status: 'ACTIVE', currentPeriodEnd: { lte: now } }, take: BATCH, select: { id: true } });
    for (const { id } of due) {
      const r = await this.safely(id, () => this.endPeriod(id, 'ACTIVE', now, graceDays));
      if (r === 'cancelled') out.cancelled++; else if (r === 'renewed') out.renewedWithoutCharge++; else if (r) out.renewalsDue++;
    }
    const overdue = await this.prisma.subscription.findMany({
      where: { status: 'PAST_DUE', currentPeriodEnd: { lte: addDays(now, -graceDays) } }, take: BATCH, select: { id: true },
    });
    for (const { id } of overdue) if (await this.safely(id, () => this.expire(id, now, graceDays))) out.expired++;

    out.reminders = await this.sendReminders(now);
    if (Object.values(out).some(Boolean)) this.logger.log(`Lifecycle: ${JSON.stringify(out)}`);
    return out;
  }

  /** Trial or paid period has ended: cancel if scheduled, otherwise open the next invoice and go PAST_DUE. */
  private async endPeriod(id: string, from: 'TRIALING' | 'ACTIVE', now: Date, graceDays: number) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id }, include: { plan: true, pendingPlan: true, tenant: { select: { email: true, businessName: true } } } });
      const end = from === 'TRIALING' ? sub.trialEndsAt! : sub.currentPeriodEnd;
      if (sub.cancelAtPeriodEnd) {
        const c = await tx.subscription.updateMany({ where: { id, status: from }, data: { status: 'CANCELLED', endedAt: end } });
        if (!c.count) return null;
        await this.event(tx, sub, 'CANCELLED', null, { metadata: { at: end.toISOString() } });
        return { kind: 'cancelled' as const, sub };
      }
      const plan = sub.pendingPlan ?? sub.plan;
      const interval = sub.pendingInterval ?? sub.interval;
      const price = priceFor(plan, interval);
      if (price === 0n) {
        // No fixed fee (commission plan or a free plan): roll straight into the next period, nothing to invoice.
        const r = await tx.subscription.updateMany({
          where: { id, status: from },
          data: { status: 'ACTIVE', planId: plan.id, interval, pendingPlanId: null, pendingInterval: null, currentPeriodStart: end, currentPeriodEnd: addInterval(end, interval) },
        });
        if (!r.count) return null;
        if (sub.pendingPlanId) await this.event(tx, sub, 'PLAN_CHANGED', null, { fromPlanId: sub.planId, toPlanId: plan.id, metadata: { scheduled: true } });
        await this.event(tx, sub, from === 'TRIALING' ? 'TRIAL_ENDED' : 'RENEWED', null, { metadata: { pricingModel: plan.pricingModel, commissionBps: plan.commissionBps } });
        return { kind: 'renewed' as const, sub };
      }
      const c = await tx.subscription.updateMany({
        where: { id, status: from },
        data: { status: 'PAST_DUE', planId: plan.id, interval, pendingPlanId: null, pendingInterval: null, currentPeriodEnd: end },
      });
      if (!c.count) return null;
      if (sub.pendingPlanId) await this.event(tx, sub, 'PLAN_CHANGED', null, { fromPlanId: sub.planId, toPlanId: plan.id, metadata: { scheduled: true } });
      await this.event(tx, sub, from === 'TRIALING' ? 'TRIAL_ENDED' : 'RENEWAL_DUE', null, {});
      const invoice = price === null ? null : await this.issueInvoice(tx, sub, null, {
        kind: from === 'TRIALING' ? 'TRIAL_CONVERSION' : 'RENEWAL', plan, interval, amountMinor: price,
        periodStart: end, periodEnd: addInterval(end, interval), dueAt: end, description: `${plan.name} (${interval.toLowerCase()})`,
      });
      return { kind: 'past_due' as const, sub, plan, invoice };
    });
    if (!outcome) return null;
    if (outcome.kind === 'cancelled') return 'cancelled';
    if (outcome.kind === 'renewed') return 'renewed';

    const { sub, plan, invoice } = outcome;
    if (invoice) {
      // Phase 5: attempt automatic collection here via PaymentProviderRegistry when a saved authorization exists.
      await this.notify(() => this.notifier.sendPaymentOverdue(sub.tenant.email, {
        businessName: sub.tenant.businessName, planName: plan.name, invoiceNumber: invoice.number,
        amountMinor: invoice.amountMinor, currency: invoice.currency, accessEndsAt: addDays(invoice.periodStart, graceDays),
      }));
    }
    return 'past_due';
  }

  private async expire(id: string, now: Date, graceDays: number) {
    const sub = await this.prisma.$transaction(async (tx) => {
      const c = await tx.subscription.updateMany({
        where: { id, status: 'PAST_DUE', currentPeriodEnd: { lte: addDays(now, -graceDays) } },
        data: { status: 'EXPIRED', endedAt: now },
      });
      if (!c.count) return null;
      const s = await tx.subscription.findUniqueOrThrow({ where: { id }, include: { plan: true, tenant: { select: { email: true, businessName: true } } } });
      await this.voidOpenInvoices(tx, s, null);
      await this.event(tx, s, 'EXPIRED', null, { metadata: { graceDays } });
      return s;
    });
    if (!sub) return false;
    await this.audit.record({ action: 'billing.subscription_expired', tenantId: sub.tenantId, entityType: 'subscription', entityId: sub.id });
    await this.notify(() => this.notifier.sendSubscriptionExpired(sub.tenant.email, { businessName: sub.tenant.businessName, planName: sub.plan.name }));
    return true;
  }

  /**
   * Trial-ending and renewal reminders at the configured thresholds (default 7, 3, 1 days).
   * Each (subscription, period end, threshold) is sent at most once — the event's unique dedupe key —
   * and the key is released if sending fails, so the next run retries.
   */
  private async sendReminders(now: Date) {
    const thresholds = await this.reminderDays();
    const horizon = addDays(now, Math.max(...thresholds));
    const subs = await this.prisma.subscription.findMany({
      where: {
        cancelAtPeriodEnd: false,
        OR: [{ status: 'TRIALING', trialEndsAt: { gt: now, lte: horizon } }, { status: 'ACTIVE', currentPeriodEnd: { gt: now, lte: horizon } }],
      },
      take: BATCH * 5,
      include: { plan: true, pendingPlan: true, tenant: { select: { email: true, businessName: true } } },
    });
    let sent = 0;
    for (const sub of subs) {
      const end = sub.status === 'TRIALING' ? sub.trialEndsAt! : sub.currentPeriodEnd;
      const daysLeft = daysUntil(end, now);
      const t = reminderThreshold(daysLeft, thresholds);
      if (t === null) continue;
      const next = sub.pendingPlan ?? sub.plan;
      // A renewal with no fixed fee needs no reminder; trial-ending reminders are still sent.
      if (sub.status === 'ACTIVE' && priceFor(next, sub.pendingInterval ?? sub.interval) === 0n) continue;
      const dedupeKey = `reminder:${sub.id}:${end.toISOString()}:${t}`;
      let eventId: string;
      try {
        const ev = await this.prisma.subscriptionEvent.create({
          data: { tenantId: sub.tenantId, subscriptionId: sub.id, type: 'REMINDER_SENT', dedupeKey, metadata: { threshold: t, daysLeft, endsAt: end.toISOString() } },
        });
        eventId = ev.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // already sent
        throw e;
      }
      try {
        await this.notifier.sendRenewalReminder(sub.tenant.email, {
          businessName: sub.tenant.businessName, planName: next.name, endsAt: end, daysLeft,
          kind: sub.status === 'TRIALING' ? 'trial_ending' : 'renewal_due',
          pricingModel: next.pricingModel, commissionBps: next.commissionBps,
        });
        sent++;
      } catch (e) {
        this.logger.error(`Reminder for subscription ${sub.id} failed: ${(e as Error).message}`);
        await this.prisma.subscriptionEvent.delete({ where: { id: eventId } }).catch(() => undefined);
      }
    }
    return sent;
  }

  // ───────────────────────── helpers ─────────────────────────

  /** Current subscription (live first, else most recent), row-locked for the rest of the transaction. */
  private async lockCurrent(tx: Tx, tenantId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM subscriptions WHERE tenant_id = ${tenantId}::uuid
      ORDER BY (status IN ('TRIALING','ACTIVE','PAST_DUE')) DESC, created_at DESC LIMIT 1 FOR UPDATE`;
    if (!rows.length) return null;
    return tx.subscription.findUnique({ where: { id: rows[0].id }, include: { plan: true } });
  }

  private async assertFits(tenantId: string, plan: SubscriptionPlan) {
    const violations = limitViolations(plan.limits as unknown as PlanLimits, await this.entitlements.usage(tenantId));
    if (violations.length) {
      const detail = violations.map((v) => `${v.used} ${v.limit === 'staff' ? 'team members (incl. pending invitations)' : 'products'}, ${plan.name} allows ${v.allowed}`).join('; ');
      throw new ConflictException({ code: 'USAGE_EXCEEDS_PLAN', violations, message: `Your current usage doesn't fit ${plan.name}: ${detail}.` });
    }
  }

  private async clearPending(tx: Tx, sub: { id: string; tenantId: string; pendingPlanId: string | null }, actorId: string) {
    await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null, pendingInterval: null } });
    await this.event(tx, sub, 'PENDING_CHANGE_CANCELLED', actorId, { toPlanId: sub.pendingPlanId });
    return { action: 'pending_change_cancelled' as const };
  }

  private async issueInvoice(
    tx: Tx, sub: { id: string; tenantId: string }, actorId: string | null,
    i: { kind: InvoiceKind; plan: SubscriptionPlan; interval: BillingInterval; amountMinor: bigint; periodStart: Date; periodEnd: Date; dueAt: Date; description: string },
  ) {
    const invoice = await tx.subscriptionInvoice.create({
      data: {
        subscriptionId: sub.id, tenantId: sub.tenantId, number: invoiceNumber(i.dueAt), kind: i.kind, planId: i.plan.id,
        interval: i.interval, description: i.description, amountMinor: i.amountMinor, currency: i.plan.currency,
        status: 'OPEN', periodStart: i.periodStart, periodEnd: i.periodEnd, dueAt: i.dueAt,
      },
    });
    await this.event(tx, sub, 'INVOICE_ISSUED', actorId, { invoiceId: invoice.id, toPlanId: i.plan.id, metadata: { kind: i.kind, amountMinor: i.amountMinor.toString() } });
    return invoice;
  }

  private async voidOpenInvoices(tx: Tx, sub: { id: string; tenantId: string }, actorId: string | null, kinds?: InvoiceKind[]) {
    // Commission invoices are money already owed for past sales: plan changes and expiry never void them.
    const open = await tx.subscriptionInvoice.findMany({ where: { subscriptionId: sub.id, status: 'OPEN', kind: kinds ? { in: kinds.filter((k) => k !== 'COMMISSION') } : { not: 'COMMISSION' } }, select: { id: true } });
    for (const inv of open) {
      const v = await tx.subscriptionInvoice.updateMany({ where: { id: inv.id, status: 'OPEN' }, data: { status: 'VOID' } });
      if (v.count) await this.event(tx, sub, 'INVOICE_VOIDED', actorId, { invoiceId: inv.id });
    }
  }

  private event(
    tx: Tx, sub: { id: string; tenantId: string }, type: SubscriptionEventType, actorId: string | null,
    e: { fromPlanId?: string | null; toPlanId?: string | null; invoiceId?: string; metadata?: Record<string, unknown> },
  ) {
    return tx.subscriptionEvent.create({
      data: {
        tenantId: sub.tenantId, subscriptionId: sub.id, type, actorId, fromPlanId: e.fromPlanId ?? null,
        toPlanId: e.toPlanId ?? null, invoiceId: e.invoiceId ?? null, metadata: (e.metadata ?? {}) as Prisma.InputJsonObject,
      },
    });
  }

  private async safely<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.logger.error(`Lifecycle step failed for subscription ${id}: ${(e as Error).message}`);
      return null;
    }
  }

  private async notify(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.logger.error(`Billing notification failed: ${(e as Error).message}`);
    }
  }

  async graceDays(): Promise<number> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'billing.grace_days' } });
    const v = Number(s?.value);
    return Number.isInteger(v) && v >= 0 && v <= 30 ? v : DEFAULT_GRACE_DAYS;
  }

  async reminderDays(): Promise<number[]> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'billing.reminder_days' } });
    const v = Array.isArray(s?.value) ? (s!.value as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 60) : [];
    return v.length ? v : DEFAULT_REMINDER_DAYS;
  }
}

function addDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 86_400_000);
}

/** INV-YYYYMMDD-XXXXXXXX (random, unique index enforces no collision). */
function invoiceNumber(at: Date) {
  const ymd = at.toISOString().slice(0, 10).replace(/-/g, '');
  return `INV-${ymd}-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function publicPlan(p: SubscriptionPlan) {
  return {
    id: p.id, code: p.code, name: p.name, currency: p.currency, monthlyPriceMinor: p.monthlyPriceMinor,
    annualPriceMinor: p.annualPriceMinor, limits: p.limits, features: p.features,
    pricingModel: p.pricingModel, commissionBps: p.commissionBps,
  };
}
