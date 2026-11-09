import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { LiveSessionStatus, OrderStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChannelDto, CreateSessionDto, ListSessionsQuery, UpdateChannelDto, UpdateSessionDto } from './live.dto';

type Tx = Prisma.TransactionClient;
const PAID_LIKE: OrderStatus[] = ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'PARTIALLY_REFUNDED'];
const AWAITING: OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'];

/**
 * Live-selling sessions (MASTER-SPEC §9) and the sales channels they run on. Orders are recorded against a
 * session manually or by product code (OrdersService). Session numbers come only from real orders; viewer counts
 * are stored only when the seller enters what the platform showed them — never estimated or fabricated (rule 10).
 */
@Injectable()
export class LiveService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ── channels ──

  channels(tenantId: string) {
    return this.prisma.forTenant(tenantId).salesChannel.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, type: true, name: true, handle: true, isActive: true, createdAt: true, _count: { select: { orders: true, liveSessions: true } } },
    });
  }

  async createChannel(tenantId: string, actorId: string, dto: CreateChannelDto) {
    const row = await this.prisma.forTenant(tenantId).salesChannel.create({ data: { type: dto.type, name: dto.name, handle: dto.handle ?? null } as Prisma.SalesChannelUncheckedCreateInput });
    await this.audit.record({ action: 'channel.created', actorId, tenantId, entityType: 'sales_channel', entityId: row.id, metadata: { type: dto.type } });
    return row;
  }

  async updateChannel(tenantId: string, actorId: string, id: string, dto: UpdateChannelDto) {
    const db = this.prisma.forTenant(tenantId);
    if (!(await db.salesChannel.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Sales channel not found');
    const row = await db.salesChannel.update({ where: { id }, data: { name: dto.name, handle: dto.handle, isActive: dto.isActive } });
    await this.audit.record({ action: 'channel.updated', actorId, tenantId, entityType: 'sales_channel', entityId: id });
    return row;
  }

  // ── sessions ──

  async list(tenantId: string, q: ListSessionsQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const where: Prisma.LiveSessionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.when === 'upcoming' ? { status: { in: ['SCHEDULED', 'LIVE'] as LiveSessionStatus[] } } : {}),
      ...(q.when === 'past' ? { status: { in: ['ENDED', 'CANCELLED'] as LiveSessionStatus[] } } : {}),
    };
    const db = this.prisma.forTenant(tenantId);
    const [rows, total] = await Promise.all([
      db.liveSession.findMany({
        where, skip: (page - 1) * pageSize, take: pageSize,
        orderBy: q.when === 'upcoming' ? { scheduledAt: 'asc' } : { scheduledAt: 'desc' },
        include: { channel: { select: { id: true, type: true, name: true } }, _count: { select: { products: true, orders: true } } },
      }),
      db.liveSession.count({ where }),
    ]);
    const stats = rows.length ? await db.order.groupBy({
      by: ['liveSessionId'], where: { liveSessionId: { in: rows.map((r) => r.id) }, status: { in: PAID_LIKE } }, _sum: { totalMinor: true }, _count: { _all: true },
    }) : [];
    const byId = new Map(stats.map((s) => [s.liveSessionId, s]));
    return {
      items: rows.map((r) => ({ ...r, paidOrders: byId.get(r.id)?._count._all ?? 0, revenueMinor: byId.get(r.id)?._sum.totalMinor ?? 0n })),
      total, page, pageSize,
    };
  }

  async get(tenantId: string, id: string) {
    const s = await this.prisma.forTenant(tenantId).liveSession.findUnique({
      where: { id },
      include: {
        channel: { select: { id: true, type: true, name: true, handle: true } },
        products: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: {
              select: {
                id: true, name: true, productCode: true, status: true, deletedAt: true,
                variants: { where: { isActive: true }, select: { id: true, sku: true, name: true, priceMinor: true, promoPriceMinor: true, inventory: { select: { onHand: true, reserved: true } } } },
              },
            },
          },
        },
        moderators: { include: { member: { select: { id: true, user: { select: { fullName: true } }, role: { select: { name: true } } } } } },
      },
    });
    if (!s) throw new NotFoundException('Live session not found');
    return {
      ...s,
      products: s.products.map((sp) => ({
        productId: sp.productId, sessionPriceMinor: sp.sessionPriceMinor, sortOrder: sp.sortOrder,
        product: {
          ...sp.product,
          variants: sp.product.variants.map(({ inventory, ...v }) => ({ ...v, available: (inventory?.onHand ?? 0) - (inventory?.reserved ?? 0) })),
        },
      })),
      moderators: s.moderators.map((m) => ({ memberId: m.memberId, name: m.member.user.fullName, role: m.member.role.name })),
    };
  }

  async create(tenantId: string, actorId: string, dto: CreateSessionDto) {
    await this.assertChannel(tenantId, dto.channelId);
    const id = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const s = await tx.liveSession.create({
        data: {
          title: dto.title, channelId: dto.channelId, scheduledAt: new Date(dto.scheduledAt), description: dto.description ?? null,
          orderInstructions: dto.orderInstructions ?? null, createdBy: actorId,
        } as Prisma.LiveSessionUncheckedCreateInput,
        select: { id: true },
      });
      await this.setProducts(tx, s.id, dto.products ?? []);
      await this.setModerators(tx, s.id, dto.moderatorIds ?? []);
      return s.id;
    });
    await this.audit.record({ action: 'live_session.created', actorId, tenantId, entityType: 'live_session', entityId: id });
    return this.get(tenantId, id);
  }

  async update(tenantId: string, actorId: string, id: string, dto: UpdateSessionDto) {
    const db = this.prisma.forTenant(tenantId);
    const s = await db.liveSession.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Live session not found');
    if (!['SCHEDULED', 'LIVE'].includes(s.status)) throw new ConflictException('Ended or cancelled sessions can’t be edited');
    if (dto.channelId) await this.assertChannel(tenantId, dto.channelId);
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      await tx.liveSession.update({
        where: { id },
        data: {
          title: dto.title, channelId: dto.channelId, scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
          description: dto.description, orderInstructions: dto.orderInstructions,
        },
      });
      if (dto.products) await this.setProducts(tx, id, dto.products);
      if (dto.moderatorIds) await this.setModerators(tx, id, dto.moderatorIds);
    });
    await this.audit.record({ action: 'live_session.updated', actorId, tenantId, entityType: 'live_session', entityId: id, metadata: { fields: Object.keys(dto) } });
    return this.get(tenantId, id);
  }

  async start(tenantId: string, actorId: string, id: string) {
    return this.move(tenantId, actorId, id, 'SCHEDULED', 'LIVE', { startedAt: new Date() }, 'live_session.started');
  }

  async end(tenantId: string, actorId: string, id: string, peakViewers?: number) {
    return this.move(tenantId, actorId, id, 'LIVE', 'ENDED', { endedAt: new Date(), ...(peakViewers !== undefined ? { peakViewers } : {}) }, 'live_session.ended');
  }

  async cancel(tenantId: string, actorId: string, id: string) {
    return this.move(tenantId, actorId, id, 'SCHEDULED', 'CANCELLED', {}, 'live_session.cancelled');
  }

  /** Sales report from real orders in the session. No conversion rate: viewer data isn't reliably available. */
  async report(tenantId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    const s = await db.liveSession.findUnique({ where: { id }, include: { channel: { select: { name: true, type: true } } } });
    if (!s) throw new NotFoundException('Live session not found');
    const orders = await db.order.findMany({
      where: { liveSessionId: id, status: { not: 'DRAFT' } },
      select: { id: true, status: true, totalMinor: true, customerId: true, items: { select: { productName: true, productCode: true, quantity: true, lineTotalMinor: true } } },
    });
    const count = (pred: (st: OrderStatus) => boolean) => orders.filter((o) => pred(o.status)).length;
    const sum = (pred: (st: OrderStatus) => boolean) => orders.filter((o) => pred(o.status)).reduce((t, o) => t + o.totalMinor, 0n);
    const paid = orders.filter((o) => PAID_LIKE.includes(o.status));
    const products = new Map<string, { productCode: string | null; name: string; quantity: number; revenueMinor: bigint }>();
    for (const o of paid) for (const i of o.items) {
      const k = i.productCode ?? i.productName;
      const cur = products.get(k) ?? { productCode: i.productCode, name: i.productName, quantity: 0, revenueMinor: 0n };
      cur.quantity += i.quantity;
      cur.revenueMinor += i.lineTotalMinor;
      products.set(k, cur);
    }
    const confirmed = orders.length;
    const paidCount = paid.length;
    const cancelled = count((st) => st === 'CANCELLED');
    const revenue = sum((st) => PAID_LIKE.includes(st));
    return {
      session: { id: s.id, title: s.title, status: s.status, channel: s.channel, scheduledAt: s.scheduledAt, startedAt: s.startedAt, endedAt: s.endedAt, peakViewers: s.peakViewers },
      durationMinutes: s.startedAt ? Math.round(((s.endedAt ?? new Date()).getTime() - s.startedAt.getTime()) / 60_000) : null,
      orders: { total: confirmed, paid: paidCount, awaitingPayment: count((st) => AWAITING.includes(st)), cancelled },
      revenueMinor: revenue,
      awaitingPaymentMinor: sum((st) => AWAITING.includes(st)),
      unitsSold: paid.reduce((n, o) => n + o.items.reduce((m, i) => m + i.quantity, 0), 0),
      averageOrderValueMinor: paidCount ? revenue / BigInt(paidCount) : 0n,
      uniqueCustomers: new Set(orders.map((o) => o.customerId).filter(Boolean)).size,
      /** Shares of confirmed orders, in basis points (integer); null when there are no orders yet. */
      paymentCompletionBps: confirmed ? Math.round((paidCount * 10_000) / confirmed) : null,
      cancellationBps: confirmed ? Math.round((cancelled * 10_000) / confirmed) : null,
      topProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity || Number(b.revenueMinor - a.revenueMinor)).slice(0, 10),
      viewerData: s.peakViewers === null ? 'not_provided' : 'seller_reported',
    };
  }

  // ── helpers ──

  private async move(tenantId: string, actorId: string, id: string, from: LiveSessionStatus, to: LiveSessionStatus, extra: Prisma.LiveSessionUpdateManyMutationInput, action: string) {
    const res = await this.prisma.forTenant(tenantId).liveSession.updateMany({ where: { id, status: from }, data: { status: to, ...extra } });
    if (!res.count) {
      const exists = await this.prisma.forTenant(tenantId).liveSession.findUnique({ where: { id }, select: { status: true } });
      if (!exists) throw new NotFoundException('Live session not found');
      throw new ConflictException(`A ${exists.status.toLowerCase()} session can't be moved to ${to.toLowerCase()}`);
    }
    await this.audit.record({ action, actorId, tenantId, entityType: 'live_session', entityId: id, metadata: 'peakViewers' in extra ? { peakViewers: extra.peakViewers } : {} });
    return this.get(tenantId, id);
  }

  private async assertChannel(tenantId: string, channelId: string) {
    const ch = await this.prisma.forTenant(tenantId).salesChannel.findUnique({ where: { id: channelId }, select: { isActive: true } });
    if (!ch) throw new NotFoundException('Sales channel not found');
    if (!ch.isActive) throw new BadRequestException('That sales channel is switched off');
  }

  /** Replaces promoted products. `tx` is tenant-scoped, so only this store's products are found (rule 1). */
  private async setProducts(tx: Tx, sessionId: string, products: Array<{ productId: string; sessionPriceMinor?: string | null }>) {
    const ids = [...new Set(products.map((p) => p.productId))];
    if (ids.length !== products.length) throw new BadRequestException('A product is listed twice');
    if (ids.length) {
      const found = await tx.product.count({ where: { id: { in: ids }, deletedAt: null } });
      if (found !== ids.length) throw new NotFoundException('One or more products were not found');
    }
    await tx.liveSessionProduct.deleteMany({ where: { liveSessionId: sessionId } });
    if (products.length) {
      await tx.liveSessionProduct.createMany({
        data: products.map((p, i) => ({ liveSessionId: sessionId, productId: p.productId, sessionPriceMinor: p.sessionPriceMinor ? BigInt(p.sessionPriceMinor) : null, sortOrder: i })),
      });
    }
  }

  private async setModerators(tx: Tx, sessionId: string, memberIds: string[]) {
    const ids = [...new Set(memberIds)];
    if (ids.length) {
      const found = await tx.tenantMember.count({ where: { id: { in: ids }, status: 'ACTIVE' } });
      if (found !== ids.length) throw new NotFoundException('One or more team members were not found');
    }
    await tx.liveSessionModerator.deleteMany({ where: { liveSessionId: sessionId } });
    if (ids.length) await tx.liveSessionModerator.createMany({ data: ids.map((memberId) => ({ liveSessionId: sessionId, memberId })) });
  }
}
