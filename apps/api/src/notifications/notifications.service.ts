import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../common/audit/audit.service';
import type { Env } from '../config/env';
import { Notification, NotificationChannel, Prisma } from '../generated/prisma/client';
import {
  MessagingNotConfiguredError, MessagingProvider, MessagingRejectedError, MessagingUnavailableError, SendResult,
} from '../messaging/messaging-provider';
import { PrismaService } from '../prisma/prisma.service';
import { render, Rendered, TemplateKey } from './templates';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 25 * 60_000, 2 * 3_600_000]; // after attempt 1, 2, 3, 4
const LEASE_MS = 10 * 60_000; // a worker owns a due row this long while sending it
const DELIVERY_WINDOW_MS = 72 * 3_600_000;
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const DEFAULT_PRICES: Record<NotificationChannel, number> = { EMAIL: 0, SMS: 400, WHATSAPP: 600 }; // kobo, placeholders
export const DEFAULT_LIMITS: Record<NotificationChannel, number> = { EMAIL: 2000, SMS: 300, WHATSAPP: 500 }; // per seller per month

export interface SendInput {
  tenantId: string | null;
  channel: NotificationChannel;
  type: string; // e.g. EMAIL_VERIFICATION, BILLING_REMINDER
  template: TemplateKey;
  destination: string;
  vars: Record<string, unknown>;
  /** One message per business event; repeating the event never sends twice. */
  dedupeKey?: string;
  /** Carries a code or sign-in link: never stored, sent once (not retried later), payload left empty. */
  secret?: boolean;
  toName?: string;
  /** WhatsApp outside Meta's 24-hour window: send this approved template instead of free text. */
  whatsappTemplate?: { name: string; language: string; params: string[] };
}

export interface SendOutcome { id: string; status: Notification['status']; error: string | null; duplicate: boolean }

/**
 * Notifications (MASTER-SPEC §15): every message is a `notifications` row; seller-attributed messages also get a
 * `notification_usage` row with its cost (§15 "Messaging billing"). Rules:
 *  - sending never throws into the business flow that asked for it (§26 #10): a failure is recorded, temporary
 *    failures are retried with backoff (1 m, 5 m, 25 m, 2 h), and after 5 attempts the row is FAILED;
 *  - every send carries an idempotency key derived from the row (`ls-<id>-<seq>`), so a retry after a timeout can
 *    never send twice; the sequence only moves on after a definite failure;
 *  - per-seller monthly limits per channel (platform setting or plan override) are checked before sending;
 *  - secrets (OTP codes, verification and reset links) are rendered in memory and never persisted.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly provider: MessagingProvider,
  ) {}

  channelEnabled(channel: NotificationChannel) {
    return this.provider.channelEnabled(channel);
  }

  async send(input: SendInput): Promise<SendOutcome> {
    const destination = normaliseDestination(input.channel, input.destination);
    if (!destination) throw new BadRequestException(`Invalid ${input.channel === 'EMAIL' ? 'email address' : 'phone number'} for this message`);

    if (input.dedupeKey) {
      const existing = await this.prisma.notification.findUnique({ where: { dedupeKey: input.dedupeKey } });
      if (existing) return { id: existing.id, status: existing.status, error: existing.error, duplicate: true };
    }

    const base = {
      tenantId: input.tenantId, channel: input.channel, type: input.type, destination, templateKey: input.template,
      payload: (input.secret ? {} : toJson({ ...input.vars, ...(input.whatsappTemplate ? { _wa: input.whatsappTemplate } : {}) })) as Prisma.InputJsonValue, provider: this.provider.name,
      dedupeKey: input.dedupeKey ?? null, retryable: !input.secret,
    };

    // Seller limit for this channel this month (messages that went out or are still queued).
    if (input.tenantId) {
      const { limit, used } = await this.quota(input.tenantId, input.channel);
      if (used >= limit) {
        const row = await this.create({ ...base, status: 'FAILED', error: 'LIMIT_REACHED' });
        if (!row.duplicate) await this.audit.record({ action: 'messaging.limit_reached', tenantId: input.tenantId, entityType: 'notification', entityId: row.id, metadata: { channel: input.channel, limit } });
        return { id: row.id, status: 'FAILED', error: 'LIMIT_REACHED', duplicate: row.duplicate };
      }
    }

    const created = await this.create({ ...base, status: 'QUEUED' });
    if (created.duplicate) return { id: created.id, status: created.status, error: created.error, duplicate: true };
    const rendered = render(input.template, input.vars, this.appUrl());
    const row = await this.deliver(created.id, rendered, input.toName);
    return { id: row.id, status: row.status, error: row.error, duplicate: false };
  }

  /** Retries due messages (job, every minute). Only non-secret rows are queued for retry. */
  async retryDue(now = new Date()) {
    const due = await this.prisma.notification.findMany({
      where: { status: 'QUEUED', retryable: true, nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 100,
    });
    let sent = 0;
    for (const n of due) {
      // Claim with a lease so two workers never send the same row at once.
      const claimed = await this.prisma.notification.updateMany({ where: { id: n.id, status: 'QUEUED', nextAttemptAt: n.nextAttemptAt }, data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) } });
      if (claimed.count !== 1) continue;
      const out = await this.deliver(n.id, render(n.templateKey as TemplateKey, fromJson(n.payload), this.appUrl()));
      if (out.status === 'SENT') sent++;
    }
    return { due: due.length, sent };
  }

  /** Delivery receipts for recent SMS (job, every 10 minutes). */
  async syncDelivery(now = new Date()) {
    const rows = await this.prisma.notification.findMany({
      where: { channel: 'SMS', status: 'SENT', providerMessageId: { not: null }, sentAt: { gte: new Date(now.getTime() - DELIVERY_WINDOW_MS) } }, take: 200,
    });
    let updated = 0;
    for (const n of rows) {
      try {
        const state = await this.provider.smsDelivery(n.providerMessageId!);
        if (state === 'DELIVERED') updated += (await this.prisma.notification.updateMany({ where: { id: n.id, status: 'SENT' }, data: { status: 'DELIVERED', deliveredAt: now } })).count;
        if (state === 'FAILED') updated += (await this.prisma.notification.updateMany({ where: { id: n.id, status: 'SENT' }, data: { status: 'FAILED', error: 'Not delivered (carrier receipt)' } })).count;
      } catch (e) {
        if (e instanceof MessagingUnavailableError) break;
        this.logger.warn(`Delivery receipt for ${n.id}: ${(e as Error).message}`);
      }
    }
    return { checked: rows.length, updated };
  }

  /** Admin: send a failed, retryable message again now (attempt counter restarts). */
  async retryNow(id: string, actorId: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundException('Message not found');
    if (n.status !== 'FAILED' || !n.retryable || n.error === 'LIMIT_REACHED') throw new BadRequestException('Only failed messages that can be re-sent are retried');
    await this.prisma.notification.update({ where: { id }, data: { status: 'QUEUED', attempts: 0, error: null, nextAttemptAt: null, providerKeySeq: { increment: 1 } } });
    await this.audit.record({ action: 'messaging.retried', actorId, tenantId: n.tenantId, entityType: 'notification', entityId: id });
    const out = await this.deliver(id, render(n.templateKey as TemplateKey, fromJson(n.payload), this.appUrl()));
    return this.view(out);
  }

  /** WhatsApp delivery statuses forwarded by Veltrix (message.status) for messages we sent. */
  async applyWhatsappStatus(providerMessageId: string, status: string, error?: string | null) {
    const s = status.toLowerCase();
    if (s === 'delivered' || s === 'read') {
      return (await this.prisma.notification.updateMany({ where: { channel: 'WHATSAPP', providerMessageId, status: 'SENT' }, data: { status: 'DELIVERED', deliveredAt: new Date() } })).count;
    }
    if (s === 'failed') {
      return (await this.prisma.notification.updateMany({ where: { channel: 'WHATSAPP', providerMessageId, status: { in: ['SENT', 'DELIVERED'] } }, data: { status: 'FAILED', error: `Not delivered: ${error ?? 'WhatsApp reported a failure'}`.slice(0, 300) } })).count;
    }
    return 0;
  }

  /** Messages sent about one order (they carry its id in their dedupe key). */
  async forOrder(tenantId: string, orderId: string) {
    const rows = await this.prisma.forTenant(tenantId).notification.findMany({
      where: { dedupeKey: { startsWith: `order:${orderId}:` } }, orderBy: { createdAt: 'desc' }, take: 50, include: { usage: { select: { costMinor: true } } },
    });
    return rows.map((r) => ({ ...this.view(r), costMinor: r.usage?.costMinor ?? null }));
  }

  // ───────────────────────── reports ─────────────────────────

  async quota(tenantId: string, channel: NotificationChannel) {
    const limits = await this.limitsFor(tenantId);
    const used = await this.prisma.notification.count({
      where: { tenantId, channel, status: { in: ['QUEUED', 'SENT', 'DELIVERED'] }, createdAt: { gte: monthStart() } },
    });
    return { limit: limits[channel], used };
  }

  /** Seller view: this month's messages per channel against their limits, and what they cost. */
  async usage(tenantId: string, period = billedPeriod(new Date())) {
    const [from, to] = periodRange(period);
    const limits = await this.limitsFor(tenantId);
    const counts = await this.prisma.notification.groupBy({ by: ['channel', 'status'], where: { tenantId, createdAt: { gte: from, lt: to } }, _count: true });
    const costs = await this.prisma.notificationUsage.groupBy({ by: ['channel'], where: { tenantId, billedPeriod: period }, _sum: { costMinor: true }, _count: true });
    const channels = (['WHATSAPP', 'SMS', 'EMAIL'] as const).map((c) => {
      const by = (s: string) => counts.filter((x) => x.channel === c && x.status === s).reduce((a, x) => a + x._count, 0);
      const cost = costs.find((x) => x.channel === c);
      return {
        channel: c, limit: limits[c], sent: by('SENT') + by('DELIVERED'), delivered: by('DELIVERED'), failed: by('FAILED'), queued: by('QUEUED'),
        billed: cost?._count ?? 0, costMinor: (cost?._sum.costMinor ?? 0n).toString(), enabled: this.provider.channelEnabled(c),
      };
    });
    return { period, currency: 'NGN', channels, totalCostMinor: channels.reduce((s, c) => s + BigInt(c.costMinor), 0n).toString() };
  }

  async list(tenantId: string | null, q: { status?: string; channel?: string; page?: number; pageSize?: number; all?: boolean }) {
    const where: Prisma.NotificationWhereInput = {
      ...(q.all ? {} : { tenantId }), ...(q.status ? { status: q.status as Notification['status'] } : {}), ...(q.channel ? { channel: q.channel as NotificationChannel } : {}),
    };
    const page = q.page ?? 1;
    const take = q.pageSize ?? 25;
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take, include: { usage: { select: { costMinor: true } }, tenant: { select: { businessName: true, slug: true } } } }),
      this.prisma.notification.count({ where }),
    ]);
    return { items: rows.map((r) => ({ ...this.view(r), costMinor: r.usage?.costMinor ?? null, store: q.all ? r.tenant : undefined })), total, page, pageSize: take };
  }

  /** Platform view: messaging cost attributed to each seller this period. */
  async platformUsage(period = billedPeriod(new Date())) {
    const rows = await this.prisma.notificationUsage.groupBy({ by: ['tenantId', 'channel'], where: { billedPeriod: period }, _sum: { costMinor: true }, _count: true });
    const tenants = await this.prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, businessName: true, slug: true } });
    const by = new Map<string, { tenantId: string; businessName: string; slug: string; messages: number; costMinor: bigint; channels: Record<string, number> }>();
    for (const r of rows) {
      const t = tenants.find((x) => x.id === r.tenantId);
      const e = by.get(r.tenantId) ?? { tenantId: r.tenantId, businessName: t?.businessName ?? '', slug: t?.slug ?? '', messages: 0, costMinor: 0n, channels: {} };
      e.messages += r._count;
      e.costMinor += r._sum.costMinor ?? 0n;
      e.channels[r.channel] = r._count;
      by.set(r.tenantId, e);
    }
    const stores = [...by.values()].sort((a, b) => Number(b.costMinor - a.costMinor));
    const failed = await this.prisma.notification.count({ where: { status: 'FAILED', createdAt: { gte: periodRange(period)[0], lt: periodRange(period)[1] } } });
    return { period, stores, totals: { messages: stores.reduce((s, x) => s + x.messages, 0), costMinor: stores.reduce((s, x) => s + x.costMinor, 0n), failed } };
  }

  async settings() {
    const [prices, limits] = await Promise.all([this.setting('messaging.price_kobo', DEFAULT_PRICES), this.setting('messaging.monthly_limits', DEFAULT_LIMITS)]);
    return { prices, limits, defaults: { prices: DEFAULT_PRICES, limits: DEFAULT_LIMITS } };
  }

  async updateSettings(actorId: string, dto: { prices?: Partial<Record<NotificationChannel, number>>; limits?: Partial<Record<NotificationChannel, number>> }) {
    const current = await this.settings();
    const prices = { ...current.prices, ...(dto.prices ?? {}) };
    const limits = { ...current.limits, ...(dto.limits ?? {}) };
    for (const [k, v] of [...Object.entries(prices), ...Object.entries(limits)]) {
      if (!Number.isInteger(v) || v < 0 || v > 100_000_000) throw new BadRequestException(`${k} must be a whole number ≥ 0`);
    }
    await this.prisma.$transaction([
      this.prisma.platformSetting.upsert({ where: { key: 'messaging.price_kobo' }, create: { key: 'messaging.price_kobo', value: prices }, update: { value: prices } }),
      this.prisma.platformSetting.upsert({ where: { key: 'messaging.monthly_limits' }, create: { key: 'messaging.monthly_limits', value: limits }, update: { value: limits } }),
    ]);
    await this.audit.record({ action: 'platform.messaging_settings_updated', actorId, entityType: 'platform_setting', metadata: { prices, limits } });
    return this.settings();
  }

  // ───────────────────────── internals ─────────────────────────

  /** One attempt. Never throws: the outcome is written to the row. */
  private async deliver(id: string, rendered: Rendered, toName?: string): Promise<Notification> {
    const n = await this.prisma.notification.update({ where: { id }, data: { attempts: { increment: 1 } } });
    const key = `ls-${n.id}-${n.providerKeySeq}`;
    try {
      let r: SendResult;
      if (n.channel === 'EMAIL') r = await this.provider.sendEmail({ to: n.destination, toName, subject: rendered.subject ?? 'LiveSell', html: rendered.html ?? rendered.text, idempotencyKey: key });
      else if (n.channel === 'SMS') r = await this.provider.sendSms({ to: n.destination, text: rendered.text, idempotencyKey: key });
      else {
        const tpl = ((n.payload ?? {}) as { _wa?: { name: string; language: string; params: string[] } })._wa;
        r = await this.provider.sendWhatsapp(tpl ? { to: n.destination, template: tpl, idempotencyKey: key } : { to: n.destination, text: rendered.text, idempotencyKey: key });
      }
      return this.prisma.$transaction(async (tx) => {
        const sent = await tx.notification.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), providerMessageId: r.providerMessageId, error: null, nextAttemptAt: null } });
        if (sent.tenantId) {
          const prices = await this.setting('messaging.price_kobo', DEFAULT_PRICES);
          await tx.notificationUsage.create({ data: { tenantId: sent.tenantId, notificationId: sent.id, channel: sent.channel, costMinor: BigInt(prices[sent.channel] ?? 0), billedPeriod: billedPeriod(sent.createdAt) } });
        }
        return sent;
      });
    } catch (e) {
      if (e instanceof MessagingUnavailableError) {
        const again = n.retryable && n.attempts < MAX_ATTEMPTS;
        const failed = await this.prisma.notification.update({
          where: { id },
          data: {
            status: again ? 'QUEUED' : 'FAILED', error: e.message.slice(0, 300), nextAttemptAt: again ? new Date(Date.now() + BACKOFF_MS[n.attempts - 1]) : null,
            ...(e.definite ? { providerKeySeq: { increment: 1 } } : {}),
          },
        });
        if (!again) this.logger.warn(`Notification ${id} (${n.type}) failed after ${n.attempts} attempt(s): ${e.message}`);
        return failed;
      }
      const code = e instanceof MessagingRejectedError ? e.code : e instanceof MessagingNotConfiguredError ? 'NOT_CONFIGURED' : 'ERROR';
      if (!(e instanceof MessagingRejectedError) && !(e instanceof MessagingNotConfiguredError)) this.logger.error(`Notification ${id}: ${(e as Error).message}`);
      return this.prisma.notification.update({ where: { id }, data: { status: 'FAILED', error: `${code}: ${(e as Error).message}`.slice(0, 300), nextAttemptAt: null } });
    }
  }

  private async create(data: Prisma.NotificationUncheckedCreateInput): Promise<Notification & { duplicate: boolean }> {
    try {
      return { ...(await this.prisma.notification.create({ data })), duplicate: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && data.dedupeKey) {
        return { ...(await this.prisma.notification.findUniqueOrThrow({ where: { dedupeKey: data.dedupeKey } })), duplicate: true };
      }
      throw e;
    }
  }

  private async limitsFor(tenantId: string): Promise<Record<NotificationChannel, number>> {
    const base = await this.setting('messaging.monthly_limits', DEFAULT_LIMITS);
    const sub = await this.prisma.forTenant(tenantId).subscription.findFirst({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: { select: { limits: true } } } });
    const planMessaging = ((sub?.plan.limits ?? {}) as { messaging?: Partial<Record<NotificationChannel, number>> }).messaging ?? {};
    return { ...base, ...planMessaging };
  }

  private async setting(key: string, fallback: Record<NotificationChannel, number>): Promise<Record<NotificationChannel, number>> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key } });
    const v = (s?.value ?? {}) as Partial<Record<NotificationChannel, unknown>>;
    const out = { ...fallback };
    for (const c of ['EMAIL', 'SMS', 'WHATSAPP'] as const) if (Number.isInteger(v[c]) && (v[c] as number) >= 0) out[c] = v[c] as number;
    return out;
  }

  private view(n: Notification) {
    return {
      id: n.id, channel: n.channel, type: n.type, destination: maskDestination(n.channel, n.destination), status: n.status, error: n.error,
      attempts: n.attempts, retryable: n.retryable, providerMessageId: n.providerMessageId, sentAt: n.sentAt, deliveredAt: n.deliveredAt, createdAt: n.createdAt,
    };
  }

  private appUrl() {
    return this.config.get('APP_URL', { infer: true });
  }
}

// ───────────────────────── helpers (exported for tests) ─────────────────────────

export function normaliseDestination(channel: NotificationChannel, raw: string): string | null {
  const s = raw.trim();
  if (channel === 'EMAIL') return EMAIL.test(s) ? s.toLowerCase() : null;
  let p = s.replace(/[\s()-]/g, '');
  if (/^0\d{10}$/.test(p)) p = `+234${p.slice(1)}`;
  if (/^234\d{10}$/.test(p)) p = `+${p}`;
  return E164.test(p) ? p : null;
}

export function maskDestination(channel: NotificationChannel, d: string) {
  if (channel === 'EMAIL') {
    const [u, host] = d.split('@');
    return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${host}`;
  }
  return `${d.slice(0, 7)}•••${d.slice(-2)}`;
}

/** Billing month in Lagos time (YYYY-MM). */
export function billedPeriod(d: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((x) => x.type === 'year')!.value}-${parts.find((x) => x.type === 'month')!.value}`;
}

/** [start, end) of a YYYY-MM period in Lagos time (UTC+1, no DST). */
export function periodRange(period: string): [Date, Date] {
  const [y, m] = period.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1) - 3_600_000), new Date(Date.UTC(y, m, 1) - 3_600_000)];
}

const monthStart = () => periodRange(billedPeriod(new Date()))[0];

function toJson(vars: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(vars, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
}

function fromJson(payload: unknown): Record<string, unknown> {
  const o = (payload ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v]));
}
