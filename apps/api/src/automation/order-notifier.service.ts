import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import type { Env } from '../config/env';
import { NotificationChannel, Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';
import { ORDER_EVENTS, OrderEvent, OrderVars, WHATSAPP_PARAMS, whatsappParams } from '../notifications/order-templates';
import { PrismaService } from '../prisma/prisma.service';
import { mergePreferences, planChannels, Preferences } from './preferences';

const WINDOW_MS = 24 * 3_600_000;
const MAX_EVENT_ATTEMPTS = 5;
const MANUAL_REMINDER_EVERY_MS = 6 * 3_600_000;

export interface TemplateMapping { name: string; language: string }

export const formatMinor = (minor: bigint | string, currency = 'NGN') => {
  const v = BigInt(minor);
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (v % 100n).toString().padStart(2, '0');
  return `${currency === 'NGN' ? '₦' : `${currency} `}${whole}${frac === '00' ? '' : `.${frac}`}`;
};
const lagos = (d: Date) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' }).format(d);

/**
 * Automatic customer messages about orders (MASTER-SPEC §15 WhatsApp/SMS/email list, §16 "after payment verification,
 * send order confirmation"). Input is the transactional outbox (written by OrdersService in the same transaction as the
 * change) and two timed reminders. One message per event per channel (dedupe key), never blocking the order flow.
 */
@Injectable()
export class OrderNotifier {
  private readonly logger = new Logger(OrderNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly push: PushService,
  ) {}

  // ───────────────────────── outbox ─────────────────────────

  /** Job (every 15 s): turn pending order events into messages. Safe on several workers (claim by attempts). */
  async dispatchOutbox(limit = 100) {
    const due = await this.prisma.outboxEvent.findMany({ where: { processedAt: null, attempts: { lt: MAX_EVENT_ATTEMPTS } }, orderBy: { createdAt: 'asc' }, take: limit });
    let done = 0;
    for (const e of due) {
      const claimed = await this.prisma.outboxEvent.updateMany({ where: { id: e.id, processedAt: null, attempts: e.attempts }, data: { attempts: { increment: 1 } } });
      if (claimed.count !== 1) continue;
      try {
        if ((ORDER_EVENTS as readonly string[]).includes(e.type)) {
          const p = (e.payload ?? {}) as { note?: string; actorType?: string };
          await this.notify(e.tenantId, e.entityId, e.type as OrderEvent, { note: p.note ?? null, eventId: e.id });
          // The seller's phones: new customer orders and reported transfers (best effort, never throws).
          await this.push.orderEvent(e.tenantId, e.entityId, e.type, p.actorType ?? null);
        }
        await this.prisma.outboxEvent.update({ where: { id: e.id }, data: { processedAt: new Date(), error: null } });
        done++;
      } catch (err) {
        this.logger.warn(`Outbox ${e.type} ${e.entityId}: ${(err as Error).message}`);
        await this.prisma.outboxEvent.update({ where: { id: e.id }, data: { error: (err as Error).message.slice(0, 300) } });
      }
    }
    return { due: due.length, done };
  }

  /** Job (every 10 min): payment reminders before the hold ends, and abandoned online checkouts. */
  async runReminders(now = new Date()) {
    const out = { reminders: 0, abandoned: 0 };
    const prefsCache = new Map<string, Preferences>();
    const prefs = async (tenantId: string) => {
      if (!prefsCache.has(tenantId)) prefsCache.set(tenantId, await this.preferences(tenantId));
      return prefsCache.get(tenantId)!;
    };
    const awaiting = await this.prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', customerId: { not: null }, reservationExpiresAt: { gt: now, lte: new Date(now.getTime() + 72 * 3_600_000) } },
      select: { id: true, tenantId: true, createdAt: true, reservationExpiresAt: true, channel: { select: { type: true } } }, take: 500, orderBy: { reservationExpiresAt: 'asc' },
    });
    for (const o of awaiting) {
      const p = await prefs(o.tenantId);
      if (!p.enabled) continue;
      const online = o.channel?.type === 'STOREFRONT' || o.channel?.type === 'WHATSAPP';
      try {
        if (online && p.abandonedAfterMinutes > 0 && now.getTime() - o.createdAt.getTime() >= p.abandonedAfterMinutes * 60_000) {
          const r = await this.notify(o.tenantId, o.id, 'ABANDONED_CHECKOUT');
          if (r.sent) out.abandoned++;
        }
        const left = o.reservationExpiresAt!.getTime() - now.getTime();
        if (p.paymentReminderHoursBefore > 0 && left <= p.paymentReminderHoursBefore * 3_600_000 && now.getTime() - o.createdAt.getTime() >= 30 * 60_000) {
          const r = await this.notify(o.tenantId, o.id, 'PAYMENT_REMINDER');
          if (r.sent) out.reminders++;
        }
      } catch (err) {
        this.logger.warn(`Reminder for ${o.id}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Seller presses "Send payment reminder" (at most every 6 hours per order). */
  async remindNow(tenantId: string, actorId: string, orderId: string) {
    const o = await this.prisma.forTenant(tenantId).order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!o) throw new NotFoundException('Order not found');
    if (o.status !== 'PENDING_PAYMENT') throw new ConflictException('Only orders awaiting payment get payment reminders');
    const bucket = Math.floor(Date.now() / MANUAL_REMINDER_EVERY_MS);
    const r = await this.notify(tenantId, orderId, 'PAYMENT_REMINDER', { suffix: `:manual:${bucket}`, force: true });
    if (r.results.length && r.results.every((x) => x.duplicate)) throw new ConflictException('A reminder was already sent recently. You can send another in a few hours.');
    await this.audit.record({ action: 'order.reminder_sent', actorId, tenantId, entityType: 'order', entityId: orderId, metadata: { channels: r.results.map((x) => `${x.channel}:${x.status}`) } });
    return r;
  }

  // ───────────────────────── one event ─────────────────────────

  async notify(tenantId: string, orderId: string, event: OrderEvent, opts: { note?: string | null; suffix?: string; force?: boolean; eventId?: string } = {}) {
    const o = await this.prisma.forTenant(tenantId).order.findUnique({
      where: { id: orderId },
      include: {
        customer: true, channel: { select: { type: true } }, items: { orderBy: { position: 'asc' } },
        transactions: { where: { status: 'SUCCEEDED' }, include: { refunds: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 } } },
      },
    });
    if (!o) throw new NotFoundException('Order not found');
    const c = o.customer;
    if (!c || c.anonymizedAt) return { sent: false, results: [], plan: null };
    const prefs = await this.preferences(tenantId);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessName: true, slug: true, storefront: { select: { whatsappNumber: true } } } });

    const refund = o.transactions.flatMap((t) => t.refunds)[0];
    const vars: OrderVars = {
      customerName: c.fullName, storeName: tenant.businessName, orderReference: o.reference, total: formatMinor(o.totalMinor, o.currency),
      link: await this.customerLink(tenantId, o, tenant.slug),
      items: o.items.map((i) => ({ name: `${i.productName}${i.variantName !== 'Default' ? ` (${i.variantName})` : ''}`, quantity: i.quantity, lineTotal: formatMinor(i.lineTotalMinor, o.currency) })),
      holdUntil: o.reservationExpiresAt ? lagos(o.reservationExpiresAt) : null, note: opts.note ?? null,
      refundAmount: refund ? formatMinor(refund.amountMinor, refund.currency) : null, storeWhatsapp: tenant.storefront?.whatsappNumber ?? null,
    };

    const conv = c.phone ? await this.prisma.whatsappConversation.findUnique({ where: { phone: c.phone } }) : null;
    const templates = await this.templates();
    const plan = planChannels(event, opts.force ? { ...prefs, enabled: true } : prefs, {
      phone: c.phone, email: c.email, whatsappOptIn: c.whatsappOptIn, whatsappOptedOut: !!c.whatsappOptOutAt, smsOptOut: c.smsOptOut,
    }, {
      inWindow: !!conv && Date.now() - conv.lastInboundAt.getTime() < WINDOW_MS, hasTemplate: !!templates[event],
      enabled: { WHATSAPP: this.notifications.channelEnabled('WHATSAPP'), SMS: this.notifications.channelEnabled('SMS'), EMAIL: this.notifications.channelEnabled('EMAIL') },
    });
    // An order placed in the WhatsApp conversation was already answered there.
    if (event === 'ORDER_PLACED' && o.channel?.type === 'WHATSAPP') {
      plan.whatsapp = null;
      plan.sms = false;
    }

    const base = { tenantId, type: event, template: 'ORDER_EVENT' as const, vars: { event, order: vars } };
    const key = (ch: NotificationChannel) => `order:${orderId}:${event}${opts.suffix ?? ''}${event === 'REFUND_COMPLETED' && refund ? `:${refund.id}` : ''}:${ch.toLowerCase()}`;
    const results: Array<{ channel: NotificationChannel; status: string; duplicate: boolean; error: string | null }> = [];
    const send = async (channel: NotificationChannel, destination: string, extra: Partial<{ whatsappTemplate: { name: string; language: string; params: string[] }; toName: string }> = {}) => {
      try {
        const r = await this.notifications.send({ ...base, channel, destination, dedupeKey: key(channel), ...extra });
        results.push({ channel, status: r.status, duplicate: r.duplicate, error: r.error });
      } catch (e) {
        results.push({ channel, status: 'FAILED', duplicate: false, error: (e as Error).message });
      }
    };
    if (plan.whatsapp) {
      const t = templates[event];
      await send('WHATSAPP', c.phone!, plan.whatsapp === 'template' && t ? { whatsappTemplate: { name: t.name, language: t.language, params: whatsappParams(event, vars) } } : {});
    }
    if (plan.sms) await send('SMS', c.phone!);
    if (plan.email) await send('EMAIL', c.email!, { toName: c.fullName });
    return { sent: results.some((r) => !r.duplicate && r.status !== 'FAILED'), results, plan };
  }

  // ───────────────────────── settings ─────────────────────────

  async preferences(tenantId: string): Promise<Preferences> {
    const row = await this.prisma.forTenant(tenantId).notificationPreference.findFirst();
    return mergePreferences(row?.settings);
  }

  async savePreferences(tenantId: string, actorId: string, input: unknown) {
    const merged = mergePreferences(input);
    const db = this.prisma.forTenant(tenantId);
    const existing = await db.notificationPreference.findFirst();
    if (existing) await db.notificationPreference.update({ where: { id: existing.id }, data: { settings: merged as unknown as Prisma.InputJsonValue } });
    else await db.notificationPreference.create({ data: { settings: merged as unknown as Prisma.InputJsonValue } as Prisma.NotificationPreferenceUncheckedCreateInput });
    await this.audit.record({ action: 'notifications.preferences_updated', actorId, tenantId, entityType: 'notification_preference', metadata: { enabled: merged.enabled } });
    return merged;
  }

  /** Platform mapping of order events to approved WhatsApp templates ("whatsapp.templates"). */
  async templates(): Promise<Partial<Record<OrderEvent, TemplateMapping>>> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'whatsapp.templates' } });
    const v = (s?.value ?? {}) as Record<string, TemplateMapping | null>;
    const out: Partial<Record<OrderEvent, TemplateMapping>> = {};
    for (const e of ORDER_EVENTS) if (v[e]?.name && v[e]?.language) out[e] = { name: v[e]!.name, language: v[e]!.language };
    return out;
  }

  static templateParams() {
    return WHATSAPP_PARAMS;
  }

  /**
   * The customer's private order page. The token is kept encrypted for this purpose; orders without one get a
   * new link (staff/WhatsApp orders). A pre-Phase-9 storefront order whose token was only ever hashed keeps its
   * original link working, so messages point to the store instead of replacing it.
   */
  private async customerLink(tenantId: string, o: { id: string; reference: string; trackingTokenEnc: string | null; trackingTokenHash: string | null }, slug: string) {
    const app = this.config.get('APP_URL', { infer: true });
    const page = (token: string) => `${app}/store/${slug}/order/${o.reference}?token=${encodeURIComponent(token)}`;
    if (o.trackingTokenEnc) return page(this.crypto.decrypt(o.trackingTokenEnc, tenantId));
    if (o.trackingTokenHash) return `${app}/store/${slug}`;
    const token = this.crypto.randomToken(24);
    const set = await this.prisma.forTenant(tenantId).order.updateMany({
      where: { id: o.id, trackingTokenHash: null }, data: { trackingTokenHash: this.crypto.hashToken(token), trackingTokenEnc: this.crypto.encrypt(token, tenantId) },
    });
    if (set.count === 1) return page(token);
    const again = await this.prisma.forTenant(tenantId).order.findUniqueOrThrow({ where: { id: o.id }, select: { trackingTokenEnc: true } });
    return again.trackingTokenEnc ? page(this.crypto.decrypt(again.trackingTokenEnc, tenantId)) : `${app}/store/${slug}`;
  }
}
