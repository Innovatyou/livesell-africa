import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PushMessage, PushProvider } from './push-provider';

const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/;
const RECEIPT_AFTER_MS = 15 * 60_000;

/** Pure: "₦25,000" from kobo. */
const naira = (minor: bigint, currency: string) => `${currency === 'NGN' ? '₦' : `${currency} `}${(minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${minor % 100n ? `.${(minor % 100n).toString().padStart(2, '0')}` : ''}`;

/** Pure: which order events push to the seller's team, and to whom (by permission). */
export function sellerPushFor(type: string, channelType: string | null, actorType: string | null): { permission: string; kind: 'new_order' | 'transfer_reported' } | null {
  if (type === 'ORDER_PLACED' && (channelType === 'STOREFRONT' || channelType === 'WHATSAPP')) return { permission: 'orders:read', kind: 'new_order' };
  if (type === 'TRANSFER_REPORTED' && actorType === 'customer') return { permission: 'payments:verify_transfer', kind: 'transfer_reported' };
  return null;
}

/**
 * Push notifications to sellers' phones (mobile app): a new customer order (storefront or WhatsApp) and a bank
 * transfer the customer says they sent. Driven by the Phase 9 order outbox, so each event pushes once. Best effort:
 * a push failure never blocks the order flow. Tokens Expo reports as DeviceNotRegistered are switched off.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  constructor(private readonly prisma: PrismaService, private readonly provider: PushProvider, private readonly audit: AuditService) {}

  async register(userId: string, dto: { token: string; platform: 'ios' | 'android'; deviceName?: string }) {
    if (!EXPO_TOKEN.test(dto.token)) throw new BadRequestException('Not an Expo push token');
    // A phone that changed hands moves to the new user.
    const row = await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: { userId, token: dto.token, platform: dto.platform, deviceName: dto.deviceName?.slice(0, 80) ?? null },
      update: { userId, platform: dto.platform, deviceName: dto.deviceName?.slice(0, 80) ?? null, disabledAt: null, lastSeenAt: new Date() },
    });
    await this.audit.record({ action: 'push.device_registered', actorId: userId, entityType: 'device_token', entityId: row.id, metadata: { platform: dto.platform } });
    return { registered: true, enabled: this.provider.enabled };
  }

  async unregister(userId: string, token: string) {
    const n = await this.prisma.deviceToken.updateMany({ where: { token, userId, disabledAt: null }, data: { disabledAt: new Date() } });
    return { unregistered: n.count > 0 };
  }

  async devices(userId: string) {
    return this.prisma.deviceToken.findMany({ where: { userId, disabledAt: null }, select: { id: true, platform: true, deviceName: true, lastSeenAt: true, createdAt: true }, orderBy: { lastSeenAt: 'desc' } });
  }

  /** Called by the order outbox for every customer-relevant order event. Never throws. */
  async orderEvent(tenantId: string, orderId: string, type: string, actorType: string | null) {
    try {
      if (!this.provider.enabled) return { sent: 0 };
      const o = await this.prisma.order.findFirst({
        where: { id: orderId, tenantId },
        select: { reference: true, totalMinor: true, currency: true, customer: { select: { fullName: true } }, channel: { select: { type: true } }, tenant: { select: { businessName: true } } },
      });
      if (!o) return { sent: 0 };
      const rule = sellerPushFor(type, o.channel?.type ?? null, actorType);
      if (!rule) return { sent: 0 };
      const devices = await this.prisma.deviceToken.findMany({
        where: { disabledAt: null, user: { status: { not: 'SUSPENDED' }, memberships: { some: { tenantId, status: 'ACTIVE', role: { permissions: { some: { permission: { key: rule.permission } } } } } } } },
        select: { id: true, token: true },
      });
      if (!devices.length) return { sent: 0 };
      const who = o.customer?.fullName ?? 'A customer';
      const amount = naira(o.totalMinor, o.currency);
      const msg = rule.kind === 'new_order'
        ? { title: `New order ${o.reference}`, body: `${who} · ${amount} · ${o.channel?.type === 'WHATSAPP' ? 'WhatsApp' : 'online store'}` }
        : { title: `Transfer to check · ${o.reference}`, body: `${who} says they sent ${amount}. Check your bank, then confirm in the app.` };
      const messages: PushMessage[] = devices.map((d) => ({
        to: d.token, ...msg, channelId: 'orders', priority: 'high',
        data: { type: rule.kind, orderId, tenantId, store: o.tenant.businessName },
      }));
      const tickets = await this.provider.send(messages);
      let sent = 0;
      for (const [i, t] of tickets.entries()) {
        if (t.status === 'ok') {
          sent++;
          await this.prisma.pushTicket.create({ data: { ticketId: t.id, deviceTokenId: devices[i].id } }).catch(() => undefined);
        } else if (t.error === 'DeviceNotRegistered') {
          await this.prisma.deviceToken.update({ where: { id: devices[i].id }, data: { disabledAt: new Date() } });
        }
      }
      return { sent };
    } catch (e) {
      this.logger.warn(`Push for ${type} ${orderId}: ${(e as Error).message}`);
      return { sent: 0 };
    }
  }

  /** Job (every 15 min): read delivery receipts; switch off phones that uninstalled the app. Idempotent. */
  async checkReceipts(now = new Date()) {
    if (!this.provider.enabled) return { checked: 0, disabled: 0 };
    const due = await this.prisma.pushTicket.findMany({ where: { createdAt: { lte: new Date(now.getTime() - RECEIPT_AFTER_MS) } }, take: 1000 });
    if (!due.length) return { checked: 0, disabled: 0 };
    const receipts = await this.provider.receipts(due.map((t) => t.ticketId));
    let disabled = 0;
    for (const t of due) {
      const r = receipts[t.ticketId];
      if (r?.status === 'error' && r.error === 'DeviceNotRegistered') {
        await this.prisma.deviceToken.update({ where: { id: t.deviceTokenId }, data: { disabledAt: now } });
        disabled++;
      }
    }
    // Receipts are kept 24 h by Expo; anything older than that without one is dropped too.
    await this.prisma.pushTicket.deleteMany({ where: { OR: [{ id: { in: due.filter((t) => receipts[t.ticketId]).map((t) => t.id) } }, { createdAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } }] } });
    return { checked: due.length, disabled };
  }
}
