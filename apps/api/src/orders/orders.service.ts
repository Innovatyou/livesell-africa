import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service';
import { koboToNaira, normaliseCode, toCsv } from '../catalog/catalog-utils';
import { isUniqueViolation } from '../catalog/products.service';
import { AuditService } from '../common/audit/audit.service';
import type { TenantContext } from '../common/auth/request-context';
import { ChannelType, DeliveryMethod, OrderStatus, Prisma } from '../generated/prisma/client';
import { deliveryStatusFor, canMoveDelivery } from '../logistics/delivery-rules';
import { InventoryService, StockLine } from '../inventory/inventory.service';
import type { PermissionKey } from '../rbac/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  canTransition, commitsStock, computeTotals, EDITABLE, fulfilmentStatusFor, HOLD_STATUSES, nextUserStatuses, orderReference,
  paymentStatusFor, TotalsError,
} from './order-rules';
import { CreateOrderDto, ListOrdersQuery, OrderCustomerDto, OrderItemInputDto, ShippingAddressDto, UpdateOrderDto } from './orders.dto';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;
const DEFAULT_STAFF_HOLD_HOURS = 48;
const DEFAULT_CHECKOUT_HOLD_MINUTES = 24 * 60;
const PAID_LIKE: OrderStatus[] = ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'PARTIALLY_REFUNDED'];

const VIEWS: Record<string, OrderStatus[]> = {
  open: ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION', 'PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED'],
  awaiting_payment: ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'],
  to_fulfil: ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED'],
  completed: ['DELIVERED'],
  cancelled: ['CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
};

/** Who may move an order to which status (checked on top of the route's permission). */
const TRANSITION_PERMISSION: Record<string, PermissionKey> = {
  PENDING_PAYMENT: 'orders:create', CANCELLED: 'orders:cancel',
  PROCESSING: 'orders:update_status', READY_FOR_DISPATCH: 'orders:update_status', DISPATCHED: 'orders:update_status', DELIVERED: 'orders:update_status',
};

export interface CreateOptions {
  actorId: string | null;
  /** storefront and whatsapp are customer-placed: database prices only, checkout hold, customer never renamed. */
  source: 'staff' | 'storefront' | 'whatsapp';
  trackingTokenHash?: string;
  /** The same tracking token, encrypted (tenant-bound), so customer messages can carry the private link. */
  trackingTokenEnc?: string;
  /** The customer asked for order updates on WhatsApp (checkbox, or ordering over WhatsApp). */
  whatsappOptIn?: boolean;
  /**
   * Phase 10: how the order reaches the customer, priced server-side by DeliveryService.quote(). For customer-placed
   * orders its fee replaces any client value; null fee = to be agreed with the seller (0 on the order for now).
   */
  delivery?: { method: DeliveryMethod; zoneId: string | null; feeMinor: bigint | null };
}

/** Order changes the customer is told about (Phase 9). The event is written in the transaction that makes the change. */
export function customerEvent(from: OrderStatus | null, to: OrderStatus): string | null {
  if (to === 'PENDING_PAYMENT') return from === null || from === 'DRAFT' ? 'ORDER_PLACED' : from === 'PAYMENT_VERIFICATION' ? 'TRANSFER_NOT_FOUND' : null;
  if (to === 'PAYMENT_VERIFICATION') return from === 'PENDING_PAYMENT' ? 'TRANSFER_REPORTED' : null;
  if (from === to) return null;
  switch (to) {
    case 'PAID': return 'PAYMENT_RECEIVED';
    case 'DISPATCHED': return 'ORDER_DISPATCHED';
    case 'DELIVERED': return 'ORDER_DELIVERED';
    case 'CANCELLED': return 'ORDER_CANCELLED';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'REFUND_COMPLETED';
    default: return null;
  }
}

interface ResolvedLine { variantId: string; productId: string; productName: string; productCode: string; variantName: string; sku: string; unitPriceMinor: bigint; quantity: number; discountMinor: bigint }

/**
 * Orders (MASTER-SPEC §11). Stock is reserved through InventoryService inside the same transaction as the order
 * write; unpaid orders hold stock until `reservationExpiresAt`, then a job cancels them and releases it.
 * An order becomes PAID only through `markPaid()`, which the payments module calls after server-side
 * verification (rule 4) — never from this module's HTTP API.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ───────────────────────── reads ─────────────────────────

  async get(tenantId: string, id: string) {
    const o = await this.prisma.forTenant(tenantId).order.findUnique({
      where: { id },
      include: {
        items: { orderBy: { position: 'asc' } },
        customer: { select: { id: true, fullName: true, phone: true, email: true, anonymizedAt: true } },
        channel: { select: { id: true, type: true, name: true } },
        liveSession: { select: { id: true, title: true, status: true } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        transactions: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, reference: true, provider: true, status: true, grossMinor: true, currency: true, providerFeeMinor: true, platformCommissionMinor: true,
            sellerProceedsMinor: true, settlementMode: true, failureReason: true, verifiedAt: true, verifiedBy: true, transferEvidence: true, createdAt: true,
            refunds: { orderBy: { createdAt: 'desc' }, select: { id: true, amountMinor: true, currency: true, status: true, reason: true, createdAt: true } },
          },
        },
      },
    });
    if (!o) throw new NotFoundException('Order not found');
    const actorIds = [...new Set(o.statusHistory.map((h) => h.actorId).filter((x): x is string => !!x))];
    const actors = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } }) : [];
    const names = new Map(actors.map((a) => [a.id, a.fullName]));
    const { trackingTokenHash: _hidden, ...rest } = o;
    return {
      ...rest,
      statusHistory: o.statusHistory.map((h) => ({ ...h, actorName: h.actorId ? names.get(h.actorId) ?? null : null })),
      nextStatuses: nextUserStatuses(o.status),
      editable: EDITABLE.includes(o.status),
      canExtendHold: HOLD_STATUSES.includes(o.status),
    };
  }

  async list(tenantId: string, q: ListOrdersQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const where = this.listWhere(q);
    const db = this.prisma.forTenant(tenantId);
    const [items, total] = await Promise.all([
      db.order.findMany({
        where, skip: (page - 1) * pageSize, take: pageSize,
        orderBy: q.sort === 'oldest' ? { createdAt: 'asc' } : q.sort === 'total_desc' ? { totalMinor: 'desc' } : { createdAt: 'desc' },
        select: {
          id: true, reference: true, status: true, paymentStatus: true, fulfilmentStatus: true, totalMinor: true, currency: true,
          createdAt: true, reservationExpiresAt: true, customer: { select: { id: true, fullName: true, phone: true } },
          channel: { select: { type: true, name: true } }, liveSession: { select: { id: true, title: true } }, _count: { select: { items: true } },
        },
      }),
      db.order.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** Orders export: contains customer names and phones, so it needs customers:export and is audited. */
  async exportCsv(tenantId: string, actorId: string, q: ListOrdersQuery, ip?: string) {
    const rows = await this.prisma.forTenant(tenantId).order.findMany({
      where: this.listWhere(q), orderBy: { createdAt: 'desc' }, take: 10_000,
      include: { items: true, customer: { select: { fullName: true, phone: true } }, channel: { select: { name: true } }, liveSession: { select: { title: true } } },
    });
    await this.audit.record({ action: 'orders.exported', actorId, tenantId, entityType: 'order', metadata: { count: rows.length, view: q.view, status: q.status }, ip });
    return toCsv(
      ['reference', 'date', 'status', 'payment_status', 'customer', 'phone', 'channel', 'live_session', 'items', 'subtotal', 'discount', 'delivery', 'total', 'currency'],
      rows.map((o) => [
        o.reference, o.createdAt.toISOString(), o.status, o.paymentStatus, o.customer?.fullName ?? '', o.customer?.phone ?? '', o.channel?.name ?? '',
        o.liveSession?.title ?? '', o.items.map((i) => `${i.productCode ?? i.sku} x${i.quantity}`).join('; '),
        koboToNaira(o.subtotalMinor), koboToNaira(o.discountMinor), koboToNaira(o.deliveryFeeMinor), koboToNaira(o.totalMinor), o.currency,
      ]),
    );
  }

  // ───────────────────────── writes ─────────────────────────

  async create(tenantId: string, dto: CreateOrderDto, opts: CreateOptions): Promise<{ id: string; reference: string; replayed?: boolean }> {
    const confirm = dto.confirm ?? true;
    const db = this.prisma.forTenant(tenantId);
    // A retried send from the mobile offline queue gets the order it already created.
    if (dto.clientRef) {
      const prior = await db.order.findFirst({ where: { clientRef: dto.clientRef }, select: { id: true, reference: true } });
      if (prior) return { ...prior, replayed: true };
    }
    const session = dto.liveSessionId ? await db.liveSession.findUnique({ where: { id: dto.liveSessionId }, include: { products: true } }) : null;
    if (dto.liveSessionId && !session) throw new NotFoundException('Live session not found');
    if (session && !['LIVE', 'ENDED'].includes(session.status)) throw new ConflictException('Start the live session before recording orders against it');
    const customerPlaced = opts.source !== 'staff';
    const channelId = await this.resolveChannel(tenantId, dto.channelId ?? session?.channelId, opts.source === 'storefront' ? 'STOREFRONT' : opts.source === 'whatsapp' ? 'WHATSAPP' : 'MANUAL');
    const lines = await this.resolveLines(tenantId, dto.items, session?.products ?? [], customerPlaced);
    const fee = customerPlaced ? (opts.delivery?.feeMinor ?? 0n).toString() : dto.deliveryFeeMinor;
    const totals = this.totals(lines, dto.discountMinor, fee);
    if (confirm) await this.assertOrderQuota(tenantId);
    const hold = confirm ? await this.holdUntil(customerPlaced ? 'storefront' : 'staff') : null;

    for (let attempt = 0; ; attempt++) {
      try {
        const order = await this.prisma.tenantTransaction(tenantId, async (tx) => {
          const customerId = await this.resolveCustomer(tx, dto.customer, customerPlaced);
          if (customerId && opts.whatsappOptIn) {
            await tx.customer.updateMany({ where: { id: customerId, whatsappOptIn: false }, data: { whatsappOptIn: true, optInAt: new Date(), whatsappOptOutAt: null } });
          }
          const shippingAddress = await this.resolveAddress(tx, customerId, dto.addressId, dto.shippingAddress, dto.customer);
          const status: OrderStatus = confirm ? 'PENDING_PAYMENT' : 'DRAFT';
          const o = await tx.order.create({
            data: {
              reference: orderReference(), customerId, channelId, liveSessionId: session?.id ?? null, status,
              paymentStatus: paymentStatusFor(status, 'UNPAID'), currency: await this.currency(tenantId),
              subtotalMinor: totals.subtotalMinor, discountMinor: totals.discountMinor, deliveryFeeMinor: totals.deliveryFeeMinor, totalMinor: totals.totalMinor,
              shippingAddress: shippingAddress ?? Prisma.DbNull, notes: dto.notes ?? null, reservationExpiresAt: hold, createdBy: opts.actorId,
              trackingTokenHash: opts.trackingTokenHash ?? null, trackingTokenEnc: opts.trackingTokenEnc ?? null, clientRef: dto.clientRef ?? null,
              items: { create: this.itemRows(tenantId, lines, totals.items) },
            } as Prisma.OrderUncheckedCreateInput,
            select: { id: true, reference: true },
          });
          await this.history(tx, o.id, null, status, opts.actorId, customerPlaced ? 'customer' : 'user', opts.source === 'storefront' ? 'Placed on the storefront' : opts.source === 'whatsapp' ? 'Placed on WhatsApp' : session ? `Recorded during live: ${session.title}` : undefined);
          if (opts.delivery) {
            await tx.deliveryOrder.create({ data: { orderId: o.id, method: opts.delivery.method, zoneId: opts.delivery.zoneId, logisticsProvider: 'manual' } as Prisma.DeliveryOrderUncheckedCreateInput });
          }
          if (confirm) await this.inventory.reserve(tx, tenantId, toStock(lines), o.id, opts.actorId);
          return o;
        });
        await this.audit.record({ action: 'order.created', actorId: opts.actorId, tenantId, entityType: 'order', entityId: order.id, metadata: { reference: order.reference, source: opts.source, confirm, total: totals.totalMinor.toString() } });
        return order;
      } catch (e) {
        if (isUniqueViolation(e) && dto.clientRef) {
          const prior = await db.order.findFirst({ where: { clientRef: dto.clientRef }, select: { id: true, reference: true } });
          if (prior) return { ...prior, replayed: true }; // two sends raced: one order
        }
        if (isUniqueViolation(e) && attempt < 3) continue; // reference collision: try another
        throw e;
      }
    }
  }

  async update(t: TenantContext, actorId: string, id: string, dto: UpdateOrderDto) {
    const result = await this.prisma.tenantTransaction(t.tenantId, async (tx) => {
      const o = await this.lockOrder(tx, t.tenantId, id);
      if (!EDITABLE.includes(o.status)) throw new ConflictException('Only draft orders and orders awaiting payment can be edited');
      const session = o.liveSessionId ? await tx.liveSession.findUnique({ where: { id: o.liveSessionId }, include: { products: true } }) : null;
      const changes: string[] = [];
      let lines: ResolvedLine[] | null = null;
      if (dto.items) {
        lines = await this.resolveLines(t.tenantId, dto.items, session?.products ?? [], false);
        changes.push('items');
      }
      const currentLines: ResolvedLine[] = o.items.map((i) => ({
        variantId: i.variantId, productId: '', productName: i.productName, productCode: i.productCode ?? '', variantName: i.variantName, sku: i.sku,
        unitPriceMinor: i.unitPriceMinor, quantity: i.quantity, discountMinor: i.discountMinor,
      }));
      const totals = this.totals(lines ?? currentLines, dto.discountMinor ?? o.discountMinor.toString(), dto.deliveryFeeMinor ?? o.deliveryFeeMinor.toString());
      if (dto.discountMinor !== undefined) changes.push('discount');
      if (dto.deliveryFeeMinor !== undefined) changes.push('delivery fee');

      let customerId = o.customerId;
      if (dto.customer) { customerId = await this.resolveCustomer(tx, dto.customer, false); changes.push('customer'); }
      const shippingAddress = dto.shippingAddress || dto.addressId ? await this.resolveAddress(tx, customerId, dto.addressId, dto.shippingAddress, dto.customer) : undefined;
      if (shippingAddress !== undefined) changes.push('delivery address');
      if (dto.notes !== undefined) changes.push('notes');

      if (lines && o.status === 'PENDING_PAYMENT') {
        await this.inventory.release(tx, t.tenantId, o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), o.id, actorId);
        await this.inventory.reserve(tx, t.tenantId, toStock(lines), o.id, actorId);
      }
      if (lines) {
        await tx.orderItem.deleteMany({ where: { orderId: o.id } });
        await tx.orderItem.createMany({ data: this.itemRows(t.tenantId, lines, totals.items).map((r) => ({ ...r, orderId: o.id })) as Prisma.OrderItemCreateManyInput[] });
      }
      await tx.order.update({
        where: { id: o.id },
        data: {
          customerId, subtotalMinor: totals.subtotalMinor, discountMinor: totals.discountMinor, deliveryFeeMinor: totals.deliveryFeeMinor,
          totalMinor: totals.totalMinor, notes: dto.notes, shippingAddress: shippingAddress === undefined ? undefined : shippingAddress ?? Prisma.DbNull,
        },
      });
      if (changes.length) await this.history(tx, o.id, o.status, o.status, actorId, 'user', `Edited: ${changes.join(', ')}`);
      return { changes, reference: o.reference };
    });
    await this.audit.record({ action: 'order.updated', actorId, tenantId: t.tenantId, entityType: 'order', entityId: id, metadata: { changes: result.changes } });
    return this.get(t.tenantId, id);
  }

  /** A person moves the order on: confirm, cancel, or a fulfilment step. Stock effects happen in the same transaction. */
  async transition(t: TenantContext, actorId: string, id: string, to: OrderStatus, note?: string) {
    const needed = TRANSITION_PERMISSION[to];
    if (!needed || !t.permissions.has(needed)) throw new ForbiddenException(`Missing permission: ${needed ?? 'orders'}`);
    if (to === 'PENDING_PAYMENT') await this.assertOrderQuota(t.tenantId);
    const hold = to === 'PENDING_PAYMENT' ? await this.holdUntil('staff') : null;
    const from = await this.prisma.tenantTransaction(t.tenantId, (tx) => this.transitionTx(tx, t.tenantId, actorId, id, to, note, hold));
    await this.audit.record({ action: 'order.status_changed', actorId, tenantId: t.tenantId, entityType: 'order', entityId: id, metadata: { from, to, note } });
    return this.get(t.tenantId, id);
  }

  /**
   * The transition itself, inside the caller's transaction (permission is the caller's job). Stock effects, status,
   * history + outbox and the delivery record all change together. Returns the previous status.
   */
  async transitionTx(tx: Tx, tenantId: string, actorId: string, id: string, to: OrderStatus, note?: string, hold: Date | null = null) {
    const o = await this.lockOrder(tx, tenantId, id);
    if (!canTransition(o.status, to, 'user')) {
      throw new ConflictException(o.status === 'PAID' && to === 'CANCELLED'
        ? 'This order is paid. Cancelling it needs a refund, which arrives with online payments.'
        : `An order that is ${label(o.status)} can't be moved to ${label(to)}`);
    }
    const stock = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    if (to === 'PENDING_PAYMENT') await this.inventory.reserve(tx, tenantId, stock, o.id, actorId);
    if (to === 'CANCELLED' && HOLD_STATUSES.includes(o.status)) await this.inventory.release(tx, tenantId, stock, o.id, actorId);
    const commit = commitsStock(to) && !o.stockCommittedAt;
    if (commit) await this.inventory.commitSale(tx, tenantId, stock, o.id, actorId);
    await tx.order.update({
      where: { id: o.id },
      data: {
        status: to, paymentStatus: paymentStatusFor(to, o.paymentStatus), fulfilmentStatus: fulfilmentStatusFor(to, o.fulfilmentStatus),
        reservationExpiresAt: to === 'PENDING_PAYMENT' ? hold : HOLD_STATUSES.includes(to) ? undefined : null,
        ...(commit ? { stockCommittedAt: new Date() } : {}),
      },
    });
    if (to === 'DISPATCHED' || to === 'DELIVERED') await this.syncDeliveryTx(tx, o.id, !!o.shippingAddress, to);
    await this.history(tx, o.id, o.status, to, actorId, 'user', note);
    return o.status;
  }

  /** Keep the delivery record in step when the order itself is dispatched or delivered. */
  private async syncDeliveryTx(tx: Tx, orderId: string, hasAddress: boolean, to: 'DISPATCHED' | 'DELIVERED') {
    const now = new Date();
    let d = await tx.deliveryOrder.findUnique({ where: { orderId } });
    if (!d) d = await tx.deliveryOrder.create({ data: { orderId, method: hasAddress ? 'SELLER_DELIVERY' : 'PICKUP', logisticsProvider: 'manual' } as Prisma.DeliveryOrderUncheckedCreateInput });
    const next = deliveryStatusFor(to, d.method);
    const move = next && next !== d.status && canMoveDelivery(d.status, next, d.method);
    await tx.deliveryOrder.update({
      where: { id: d.id },
      data: {
        ...(move ? { status: next } : {}),
        ...(to === 'DISPATCHED' && !d.dispatchedAt ? { dispatchedAt: now } : {}),
        ...(to === 'DELIVERED' ? { deliveredAt: d.deliveredAt ?? now, ...(d.method !== 'PICKUP' && !d.dispatchedAt ? { dispatchedAt: now } : {}) } : {}),
      },
    });
  }

  async extendHold(tenantId: string, actorId: string, id: string, hours: number) {
    const until = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const o = await this.lockOrder(tx, tenantId, id);
      if (!HOLD_STATUSES.includes(o.status)) throw new ConflictException('Only orders awaiting payment hold stock');
      const base = Math.max(Date.now(), o.reservationExpiresAt?.getTime() ?? 0);
      const next = new Date(Math.min(base + hours * 3_600_000, Date.now() + 7 * DAY_MS));
      await tx.order.update({ where: { id }, data: { reservationExpiresAt: next } });
      await this.history(tx, id, o.status, o.status, actorId, 'user', `Stock hold extended to ${next.toISOString()}`);
      return next;
    });
    await this.audit.record({ action: 'order.hold_extended', actorId, tenantId, entityType: 'order', entityId: id, metadata: { until: until.toISOString() } });
    return this.get(tenantId, id);
  }

  // ───────────────────────── system (payments, jobs) ─────────────────────────

  /**
   * PAYMENT HOOK. Marks an order paid. Call ONLY after server-side provider verification or a signature-verified
   * webhook (Phase 5), or an authorised bank-transfer verification (Phase 7), inside the transaction that records
   * the payment. Idempotent: an already-paid order is left as is.
   */
  async markPaidTx(tx: Tx, tenantId: string, orderId: string, verification: { verifiedBy: string; actorId?: string | null }) {
    const o = await this.lockOrder(tx, tenantId, orderId);
    if (PAID_LIKE.includes(o.status)) return { applied: false, status: o.status };
    if (!canTransition(o.status, 'PAID', 'system')) throw new ConflictException(`An order that is ${label(o.status)} can't be marked paid`);
    await tx.order.update({ where: { id: o.id }, data: { status: 'PAID', paymentStatus: 'PAID', reservationExpiresAt: null } });
    await this.history(tx, o.id, o.status, 'PAID', verification.actorId ?? null, 'system', `Payment verified (${verification.verifiedBy})`);
    return { applied: true, status: 'PAID' as const };
  }

  markPaid(tenantId: string, orderId: string, verification: { verifiedBy: string; actorId?: string | null }) {
    return this.prisma.tenantTransaction(tenantId, (tx) => this.markPaidTx(tx, tenantId, orderId, verification));
  }

  /** Whether a verified payment can still settle this order (false once it was cancelled or already paid). */
  async isPayableTx(tx: Tx, tenantId: string, orderId: string) {
    const o = await this.lockOrder(tx, tenantId, orderId);
    return { payable: canTransition(o.status, 'PAID', 'system'), status: o.status };
  }

  /**
   * BANK-TRANSFER HOOK. A transfer was reported (by the customer or staff): the order shows as awaiting verification
   * and keeps its stock at least until `holdUntil`. Nothing is paid until an authorised person verifies it.
   */
  async awaitVerificationTx(tx: Tx, tenantId: string, orderId: string, r: { holdUntil: Date; actorId: string | null; actorType: 'user' | 'customer'; note: string }) {
    const o = await this.lockOrder(tx, tenantId, orderId);
    if (!HOLD_STATUSES.includes(o.status)) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: `An order that is ${label(o.status)} isn't waiting for payment` });
    const hold = !o.reservationExpiresAt || o.reservationExpiresAt < r.holdUntil ? r.holdUntil : o.reservationExpiresAt;
    if (o.status === 'PENDING_PAYMENT') {
      await tx.order.update({ where: { id: o.id }, data: { status: 'PAYMENT_VERIFICATION', paymentStatus: paymentStatusFor('PAYMENT_VERIFICATION', o.paymentStatus), reservationExpiresAt: hold } });
      await this.history(tx, o.id, o.status, 'PAYMENT_VERIFICATION', r.actorId, r.actorType, r.note);
    } else {
      await tx.order.update({ where: { id: o.id }, data: { reservationExpiresAt: hold } });
      await this.history(tx, o.id, o.status, o.status, r.actorId, r.actorType, r.note);
    }
  }

  /** Every reported transfer was rejected: the order goes back to awaiting payment (its hold is unchanged). */
  async backToPendingTx(tx: Tx, tenantId: string, orderId: string, actorId: string | null, note: string) {
    const o = await this.lockOrder(tx, tenantId, orderId);
    if (o.status !== 'PAYMENT_VERIFICATION') {
      await this.history(tx, o.id, o.status, o.status, actorId, 'system', note);
      return;
    }
    await tx.order.update({ where: { id: o.id }, data: { status: 'PENDING_PAYMENT', paymentStatus: paymentStatusFor('PENDING_PAYMENT', o.paymentStatus) } });
    await this.history(tx, o.id, o.status, 'PENDING_PAYMENT', actorId, 'system', note);
  }

  /** Adds a system note to the order's history without changing its status (e.g. a payment that needs a refund). */
  async noteTx(tx: Tx, tenantId: string, orderId: string, note: string, actorId: string | null = null) {
    const o = await this.lockOrder(tx, tenantId, orderId);
    await this.history(tx, o.id, o.status, o.status, actorId, 'system', note);
  }

  /**
   * REFUND HOOK. Called by the payments module only once the provider reports the refund as completed, in the
   * transaction that records it and posts the ledger journal. A full refund of goods that haven't left releases
   * their reserved stock. Orders that were never paid (a stray payment on a cancelled order) keep their status.
   */
  async applyRefundTx(tx: Tx, tenantId: string, orderId: string, r: { fully: boolean; actorId: string | null; note: string }) {
    const o = await this.lockOrder(tx, tenantId, orderId);
    const to: OrderStatus = r.fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (o.status === to || !canTransition(o.status, to, 'system')) {
      await this.history(tx, o.id, o.status, o.status, r.actorId, 'system', r.note);
      return { status: o.status, released: false };
    }
    // Paid orders still hold their reservation until dispatch commits it as a sale.
    const release = r.fully && !o.stockCommittedAt && PAID_LIKE.includes(o.status);
    if (release) await this.inventory.release(tx, tenantId, o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), o.id, r.actorId);
    await tx.order.update({ where: { id: o.id }, data: { status: to, paymentStatus: paymentStatusFor(to, o.paymentStatus) } });
    await this.history(tx, o.id, o.status, to, r.actorId, 'system', r.note);
    return { status: to, released: release };
  }

  /** §26 #2 (abandoned checkout): unpaid orders past their hold are cancelled and their stock released. Idempotent. */
  async expireReservations(now = new Date()) {
    const due = await this.prisma.order.findMany({
      where: { status: { in: HOLD_STATUSES }, reservationExpiresAt: { lte: now } }, take: 200, select: { id: true, tenantId: true },
    });
    let expired = 0;
    for (const { id, tenantId } of due) {
      try {
        const done = await this.prisma.tenantTransaction(tenantId, async (tx) => {
          const o = await this.lockOrder(tx, tenantId, id);
          if (!HOLD_STATUSES.includes(o.status) || !o.reservationExpiresAt || o.reservationExpiresAt > now) return false;
          await this.inventory.release(tx, tenantId, o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), o.id, null);
          await tx.order.update({ where: { id }, data: { status: 'CANCELLED', paymentStatus: paymentStatusFor('CANCELLED', o.paymentStatus), reservationExpiresAt: null } });
          await this.history(tx, id, o.status, 'CANCELLED', null, 'system', 'Payment was not received before the stock hold expired');
          return true;
        });
        if (done) {
          expired++;
          await this.audit.record({ action: 'order.expired', tenantId, entityType: 'order', entityId: id });
        }
      } catch (e) {
        this.logger.error(`Expiring order ${id} failed: ${(e as Error).message}`);
      }
    }
    if (expired) this.logger.log(`Expired ${expired} unpaid order(s)`);
    return expired;
  }

  // ───────────────────────── internals ─────────────────────────

  private listWhere(q: ListOrdersQuery): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {};
    if (q.status) where.status = q.status;
    else if (q.view) where.status = { in: VIEWS[q.view] };
    if (q.channelId) where.channelId = q.channelId;
    if (q.liveSessionId) where.liveSessionId = q.liveSessionId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    if (q.search) {
      const digits = q.search.replace(/\D/g, '');
      where.OR = [
        { reference: { contains: q.search.toUpperCase() } },
        { customer: { fullName: { contains: q.search, mode: 'insensitive' } } },
        ...(digits.length >= 4 ? [{ customer: { phone: { contains: digits } } }] : []),
        { items: { some: { productCode: { equals: normaliseCode(q.search) } } } },
      ];
    }
    return where;
  }

  /** Locks the order row for the rest of the transaction and returns it with items. */
  private async lockOrder(tx: Tx, tenantId: string, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM orders WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Order not found');
    return tx.order.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { position: 'asc' } } } });
  }

  private async resolveLines(tenantId: string, items: OrderItemInputDto[], sessionProducts: Array<{ productId: string; sessionPriceMinor: bigint | null }>, storefront: boolean): Promise<ResolvedLine[]> {
    const db = this.prisma.forTenant(tenantId);
    const sessionPrice = new Map(sessionProducts.map((p) => [p.productId, p.sessionPriceMinor]));
    const out: ResolvedLine[] = [];
    for (const [i, item] of items.entries()) {
      const n = i + 1;
      let variant;
      if (item.variantId) {
        variant = await db.productVariant.findUnique({ where: { id: item.variantId }, include: { product: true } });
        if (!variant) throw new NotFoundException(`Item ${n}: product not found`);
      } else if (item.productCode) {
        const product = await db.product.findFirst({ where: { productCode: item.productCode, deletedAt: null }, include: { variants: { where: { isActive: true } } } });
        if (!product) throw new NotFoundException(`Item ${n}: no product with code ${item.productCode}`);
        const candidates = item.variantSku ? product.variants.filter((v) => v.sku.toLowerCase() === item.variantSku!.toLowerCase()) : product.variants;
        if (candidates.length !== 1) {
          throw new BadRequestException({
            code: 'VARIANT_REQUIRED', productCode: product.productCode,
            variants: product.variants.map((v) => ({ sku: v.sku, name: v.name })),
            message: candidates.length ? `${product.productCode} comes in ${product.variants.map((v) => v.name).join(', ')} — choose one` : `Item ${n}: no such variant of ${product.productCode}`,
          });
        }
        variant = { ...candidates[0], product };
      } else {
        throw new BadRequestException(`Item ${n}: give a variantId or a productCode`);
      }
      const p = variant.product;
      if (p.deletedAt || !variant.isActive || p.status === 'ARCHIVED' || (storefront && p.status !== 'ACTIVE')) {
        throw new ConflictException(`Item ${n}: ${p.name}${variant.name !== 'Default' ? ` (${variant.name})` : ''} is not available`);
      }
      const unit = sessionPrice.get(p.id) ?? variant.promoPriceMinor ?? variant.priceMinor;
      out.push({
        variantId: variant.id, productId: p.id, productName: p.name, productCode: p.productCode, variantName: variant.name, sku: variant.sku,
        unitPriceMinor: unit, quantity: item.quantity, discountMinor: item.discountMinor ? BigInt(item.discountMinor) : 0n,
      });
    }
    return out;
  }

  private totals(lines: ResolvedLine[], discount?: string, delivery?: string) {
    try {
      return computeTotals(lines, BigInt(discount ?? '0'), BigInt(delivery ?? '0'));
    } catch (e) {
      if (e instanceof TotalsError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private itemRows(tenantId: string, lines: ResolvedLine[], computed: Array<{ lineTotalMinor: bigint }>) {
    return lines.map((l, i) => ({
      tenantId, position: i, variantId: l.variantId, productName: l.productName, productCode: l.productCode || null, variantName: l.variantName, sku: l.sku,
      quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountMinor: l.discountMinor, lineTotalMinor: computed[i].lineTotalMinor,
    }));
  }

  /** Existing customer by id (same tenant), else by phone, else a new customer. Storefront never overwrites names. */
  private async resolveCustomer(tx: Tx, c: OrderCustomerDto | undefined, storefront: boolean): Promise<string | null> {
    if (!c) return null;
    if (c.customerId) {
      const found = await tx.customer.findUnique({ where: { id: c.customerId }, select: { id: true, anonymizedAt: true } });
      if (!found) throw new NotFoundException('Customer not found');
      if (found.anonymizedAt) throw new ConflictException("This customer's data was erased; create a new customer");
      return found.id;
    }
    if (!c.phone && !c.email) throw new BadRequestException('Give the customer a phone number or email');
    if (c.phone) {
      const existing = await tx.customer.findFirst({ where: { phone: c.phone }, select: { id: true, email: true } });
      if (existing) {
        if (!storefront && c.email && !existing.email) await tx.customer.update({ where: { id: existing.id }, data: { email: c.email } });
        return existing.id;
      }
    }
    if (!c.fullName) throw new BadRequestException("Add the customer's name");
    const created = await tx.customer.create({ data: { fullName: c.fullName, phone: c.phone ?? null, email: c.email ?? null } as Prisma.CustomerUncheckedCreateInput, select: { id: true } });
    return created.id;
  }

  private async resolveAddress(tx: Tx, customerId: string | null, addressId: string | undefined, address: ShippingAddressDto | undefined, c?: OrderCustomerDto) {
    if (addressId) {
      if (!customerId) throw new BadRequestException('Choose the customer before choosing a saved address');
      const a = await tx.customerAddress.findFirst({ where: { id: addressId, customerId } });
      if (!a) throw new NotFoundException('Address not found for this customer');
      return { line1: a.line1, line2: a.line2, city: a.city, state: a.state, country: a.country, landmark: a.landmark, fullName: c?.fullName ?? null, phone: c?.phone ?? null } as Prisma.InputJsonObject;
    }
    if (!address) return null;
    return { ...address, country: 'NG', fullName: address.fullName ?? c?.fullName ?? null, phone: address.phone ?? c?.phone ?? null } as Prisma.InputJsonObject;
  }

  private async resolveChannel(tenantId: string, channelId: string | undefined, fallback: ChannelType) {
    const db = this.prisma.forTenant(tenantId);
    if (channelId) {
      const ch = await db.salesChannel.findUnique({ where: { id: channelId }, select: { id: true } });
      if (!ch) throw new NotFoundException('Sales channel not found');
      return ch.id;
    }
    const ch = await db.salesChannel.findFirst({ where: { type: fallback }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (ch) return ch.id;
    // First order taken on the platform WhatsApp number: give it its own channel so reports show where it came from.
    if (fallback === 'WHATSAPP') {
      return (await db.salesChannel.create({ data: { type: 'WHATSAPP', name: 'WhatsApp ordering' } as Prisma.SalesChannelUncheckedCreateInput, select: { id: true } })).id;
    }
    return null;
  }

  /** Plan limit: confirmed orders per calendar month (Africa/Lagos). Drafts don't count. */
  private async assertOrderQuota(tenantId: string) {
    const limits = await this.entitlements.limits(tenantId);
    if (!limits) throw new ForbiddenException({ code: 'SUBSCRIPTION_INACTIVE', message: 'Your subscription is not active' });
    if (limits.ordersPerMonth === null || limits.ordersPerMonth === undefined) return;
    const [row] = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = ${tenantId}::uuid AND status <> 'DRAFT'
        AND (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos' >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')`;
    if (row.n >= limits.ordersPerMonth) {
      throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', limit: 'ordersPerMonth', allowed: limits.ordersPerMonth, used: row.n, message: `Your plan allows ${limits.ordersPerMonth} orders a month. Upgrade to take more.` });
    }
  }

  private async holdUntil(source: 'staff' | 'storefront') {
    const key = source === 'storefront' ? 'orders.checkout_hold_minutes' : 'orders.staff_hold_hours';
    const s = await this.prisma.platformSetting.findUnique({ where: { key } });
    const v = Number(s?.value);
    const minutes = source === 'storefront'
      ? (Number.isInteger(v) && v >= 10 && v <= 7 * 1440 ? v : DEFAULT_CHECKOUT_HOLD_MINUTES)
      : (Number.isInteger(v) && v >= 1 && v <= 168 ? v : DEFAULT_STAFF_HOLD_HOURS) * 60;
    return new Date(Date.now() + minutes * 60_000);
  }

  private async currency(tenantId: string) {
    return (await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
  }

  private async history(tx: Tx, orderId: string, from: OrderStatus | null, to: OrderStatus, actorId: string | null, actorType: string, note?: string) {
    await tx.orderStatusHistory.create({ data: { orderId, fromStatus: from, toStatus: to, actorId, actorType, note: note ?? null } as Prisma.OrderStatusHistoryUncheckedCreateInput });
    // Phase 9 outbox: the customer message is decided later, but the fact is recorded in this transaction.
    const event = customerEvent(from, to);
    if (event) {
      // tenantId is stamped by the tenant-scoped transaction client (every caller runs in prisma.tenantTransaction).
      await tx.outboxEvent.create({ data: { type: event, entityId: orderId, payload: { from, to, actorType, ...(note ? { note: note.slice(0, 300) } : {}) } } as unknown as Prisma.OutboxEventUncheckedCreateInput });
    }
  }
}

function toStock(lines: ResolvedLine[]): StockLine[] {
  return lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
}

function label(s: OrderStatus) {
  return s.toLowerCase().replace(/_/g, ' ');
}
