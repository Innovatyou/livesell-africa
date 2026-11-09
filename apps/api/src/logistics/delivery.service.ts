import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import type { TenantContext } from '../common/auth/request-context';
import { DeliveryMethod, DeliveryStatus, Prisma } from '../generated/prisma/client';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { canMoveDelivery, deliverySettings, DeliverySettings, dispatchNote, orderStatusFor, quoteDelivery, SHIPPABLE } from './delivery-rules';
import { LogisticsRegistry } from './logistics-provider';

export interface ZoneInput { name: string; states?: string[]; cities?: string[]; feeMinor: string; etaDays?: number | null; isActive?: boolean }
export interface DeliveryDetailsInput { method?: DeliveryMethod; zoneId?: string | null; courierId?: string | null; carrierName?: string | null; trackingReference?: string | null; dispatchNote?: string | null }
export interface CourierInput { name: string; kind?: 'RIDER' | 'COMPANY'; phone?: string | null; notes?: string | null; showPhoneToCustomer?: boolean; isActive?: boolean }

const STATUS_WORD: Record<DeliveryStatus, string> = { PENDING: 'pending', ASSIGNED: 'assigned to a rider', IN_TRANSIT: 'on the way', DELIVERED: 'delivered', FAILED: 'attempt failed', RETURNED: 'returned' };
const clean = (v: string | null | undefined, max: number) => (v === undefined ? undefined : v === null ? null : v.trim().replace(/\s+/g, ' ').slice(0, max) || null);
const list = (v: string[] | undefined) => (v === undefined ? undefined : [...new Set(v.map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 80)))].slice(0, 60));

/**
 * Delivery management (MASTER-SPEC §18): zones and fees, pickup, the delivery record of each order (method, carrier,
 * tracking reference, dispatch note, status). The order's fulfilment moves with the delivery through
 * OrdersService.transitionTx in the same transaction, so stock commit, history and the customer message stay as in
 * Phase 4/9. Couriers go through LogisticsProvider adapters; today only the manual adapter exists.
 */
@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly registry: LogisticsRegistry,
  ) {}

  // ───────────────────────── settings & zones ─────────────────────────

  async settings(tenantId: string) {
    const db = this.prisma.forTenant(tenantId);
    const [sf, zones, couriers] = await Promise.all([
      db.storefrontSettings.findFirst({ select: { deliverySettings: true } }),
      db.deliveryZone.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      db.courier.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], include: { _count: { select: { deliveries: true } } } }),
    ]);
    return { settings: deliverySettings(sf?.deliverySettings), zones, couriers, providers: this.registry.list() };
  }

  async saveSettings(tenantId: string, actorId: string, input: Partial<DeliverySettings>) {
    if (input.pickupEnabled && !(input.pickupAddress ?? '').trim()) throw new BadRequestException('Add the pickup address customers should come to');
    const merged = deliverySettings(input);
    const db = this.prisma.forTenant(tenantId);
    const sf = await db.storefrontSettings.findFirst({ select: { id: true } });
    if (!sf) throw new NotFoundException('Store settings not found');
    await db.storefrontSettings.update({ where: { id: sf.id }, data: { deliverySettings: merged as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ action: 'delivery.settings_updated', actorId, tenantId, entityType: 'storefront_settings', entityId: sf.id, metadata: { pickupEnabled: merged.pickupEnabled, deliverOutsideZones: merged.deliverOutsideZones } });
    return this.settings(tenantId);
  }

  async createZone(tenantId: string, actorId: string, z: ZoneInput) {
    const data = this.zoneData(z, true);
    const db = this.prisma.forTenant(tenantId);
    if ((await db.deliveryZone.count()) >= 100) throw new BadRequestException('A store can have at most 100 delivery zones');
    const currency = (await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
    const row = await db.deliveryZone.create({ data: { ...data, currency } as Prisma.DeliveryZoneUncheckedCreateInput });
    await this.audit.record({ action: 'delivery.zone_created', actorId, tenantId, entityType: 'delivery_zone', entityId: row.id, metadata: { name: row.name, feeMinor: row.feeMinor.toString() } });
    return row;
  }

  async updateZone(tenantId: string, actorId: string, id: string, z: Partial<ZoneInput>) {
    const db = this.prisma.forTenant(tenantId);
    if (!(await db.deliveryZone.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Delivery zone not found');
    const row = await db.deliveryZone.update({ where: { id }, data: this.zoneData(z, false) });
    await this.audit.record({ action: 'delivery.zone_updated', actorId, tenantId, entityType: 'delivery_zone', entityId: id, metadata: { name: row.name, feeMinor: row.feeMinor.toString(), isActive: row.isActive } });
    return row;
  }

  async deleteZone(tenantId: string, actorId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    const z = await db.deliveryZone.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { deliveries: true } } } });
    if (!z) throw new NotFoundException('Delivery zone not found');
    // Zones used by past orders are switched off, not deleted, so those orders keep their zone.
    if (z._count.deliveries) await db.deliveryZone.update({ where: { id }, data: { isActive: false } });
    else await db.deliveryZone.delete({ where: { id } });
    await this.audit.record({ action: 'delivery.zone_removed', actorId, tenantId, entityType: 'delivery_zone', entityId: id, metadata: { name: z.name, archived: z._count.deliveries > 0 } });
    return { removed: true, archived: z._count.deliveries > 0 };
  }

  private zoneData(z: Partial<ZoneInput>, create: boolean) {
    const states = list(z.states);
    const cities = list(z.cities);
    if (create && !(states?.length || cities?.length)) throw new BadRequestException('Name at least one state or city the zone covers');
    if (!create && states !== undefined && cities !== undefined && !states.length && !cities.length) throw new BadRequestException('Name at least one state or city the zone covers');
    return {
      ...(z.name !== undefined ? { name: z.name.trim().slice(0, 80) } : {}),
      ...(states !== undefined ? { states } : {}),
      ...(cities !== undefined ? { cities } : {}),
      ...(z.feeMinor !== undefined ? { feeMinor: BigInt(z.feeMinor) } : {}),
      ...(z.etaDays !== undefined ? { etaDays: z.etaDays } : {}),
      ...(z.isActive !== undefined ? { isActive: z.isActive } : {}),
    };
  }

  // ───────────────────────── the seller's own couriers ─────────────────────────

  /** A rider on the seller's team or a courier company they book themselves (MASTER-SPEC §18 "seller-managed / third-party"). */
  async createCourier(tenantId: string, actorId: string, c: CourierInput) {
    const db = this.prisma.forTenant(tenantId);
    if ((await db.courier.count()) >= 200) throw new BadRequestException('A store can keep at most 200 couriers');
    const row = await db.courier.create({ data: this.courierData(c) as Prisma.CourierUncheckedCreateInput });
    await this.audit.record({ action: 'delivery.courier_created', actorId, tenantId, entityType: 'courier', entityId: row.id, metadata: { name: row.name, kind: row.kind } });
    return row;
  }

  async updateCourier(tenantId: string, actorId: string, id: string, c: Partial<CourierInput>) {
    const db = this.prisma.forTenant(tenantId);
    if (!(await db.courier.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Courier not found');
    const row = await db.courier.update({ where: { id }, data: this.courierData(c) });
    await this.audit.record({ action: 'delivery.courier_updated', actorId, tenantId, entityType: 'courier', entityId: id, metadata: { name: row.name, isActive: row.isActive } });
    return row;
  }

  async deleteCourier(tenantId: string, actorId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    const c = await db.courier.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { deliveries: true } } } });
    if (!c) throw new NotFoundException('Courier not found');
    // Couriers who carried orders are switched off, not deleted, so those deliveries keep who carried them.
    if (c._count.deliveries) await db.courier.update({ where: { id }, data: { isActive: false } });
    else await db.courier.delete({ where: { id } });
    await this.audit.record({ action: 'delivery.courier_removed', actorId, tenantId, entityType: 'courier', entityId: id, metadata: { name: c.name, archived: c._count.deliveries > 0 } });
    return { removed: true, archived: c._count.deliveries > 0 };
  }

  private courierData(c: Partial<CourierInput>) {
    if (c.showPhoneToCustomer && c.phone === null) throw new BadRequestException('Add the phone number to show it to customers');
    return {
      ...(c.name !== undefined ? { name: c.name.trim().replace(/\s+/g, ' ').slice(0, 80) } : {}),
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      ...(c.phone !== undefined ? { phone: c.phone } : {}),
      ...(c.notes !== undefined ? { notes: clean(c.notes, 300) } : {}),
      ...(c.showPhoneToCustomer !== undefined ? { showPhoneToCustomer: c.showPhoneToCustomer } : {}),
      ...(c.isActive !== undefined ? { isActive: c.isActive } : {}),
    };
  }

  // ───────────────────────── quotes ─────────────────────────

  /** Delivery and pickup options for an address (null = not yet typed). Used by checkout, WhatsApp and the public quote. */
  async options(tenantId: string, address: { state: string; city: string } | null) {
    const { settings, zones } = await this.settings(tenantId);
    const delivery = quoteDelivery(zones, settings, address);
    return {
      delivery,
      pickup: { available: settings.pickupEnabled, address: settings.pickupEnabled ? settings.pickupAddress : null, instructions: settings.pickupEnabled ? settings.pickupInstructions : null, feeMinor: 0n },
    };
  }

  /** Server-side price for an order being placed by a customer. Throws when the method isn't offered. */
  async priceFor(tenantId: string, method: 'DELIVERY' | 'PICKUP', address: { state: string; city: string } | null) {
    const o = await this.options(tenantId, address);
    if (method === 'PICKUP') {
      if (!o.pickup.available) throw new BadRequestException({ code: 'PICKUP_UNAVAILABLE', message: 'This store doesn’t offer pickup' });
      return { method: 'PICKUP' as const, zoneId: null, feeMinor: 0n };
    }
    if (!address) throw new BadRequestException('A delivery address is needed');
    if (!o.delivery.available) throw new BadRequestException({ code: 'DELIVERY_UNAVAILABLE', message: 'This store doesn’t deliver to that area yet. Choose pickup or message the seller.' });
    return { method: 'SELLER_DELIVERY' as const, zoneId: o.delivery.zone?.id ?? null, feeMinor: o.delivery.feeMinor };
  }

  // ───────────────────────── per order ─────────────────────────

  async forOrder(tenantId: string, orderId: string) {
    const db = this.prisma.forTenant(tenantId);
    const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, shippingAddress: true, deliveryFeeMinor: true, currency: true, delivery: { include: { zone: { select: { id: true, name: true, etaDays: true } }, courier: { select: { id: true, name: true, kind: true, phone: true, showPhoneToCustomer: true, isActive: true } } } } } });
    if (!o) throw new NotFoundException('Order not found');
    const d = o.delivery;
    return {
      orderId: o.id, orderStatus: o.status, feeMinor: o.deliveryFeeMinor, currency: o.currency, hasAddress: !!o.shippingAddress,
      delivery: d ? { ...d, nextStatuses: (Object.keys(STATUS_WORD) as DeliveryStatus[]).filter((s) => canMoveDelivery(d.status, s, d.method)) } : null,
      shippable: SHIPPABLE.includes(o.status),
    };
  }

  /** Method, carrier, tracking reference, dispatch note. Doesn't move the status (see `move`). */
  async saveDetails(t: TenantContext, actorId: string, orderId: string, input: DeliveryDetailsInput) {
    if (input.method === 'THIRD_PARTY' && input.carrierName === null) throw new BadRequestException('Name the courier for a third-party delivery');
    const changed = await this.prisma.tenantTransaction(t.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM orders WHERE id = ${orderId}::uuid AND tenant_id = ${t.tenantId}::uuid FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Order not found');
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, shippingAddress: true, delivery: true } });
      if (o.status === 'CANCELLED' || o.status === 'DRAFT') throw new ConflictException('This order isn’t being delivered');
      const d = o.delivery;
      if (d && (d.status === 'DELIVERED' || d.status === 'RETURNED') && input.method && input.method !== d.method) throw new ConflictException('This delivery is finished; its method can’t change');
      const method = input.method ?? d?.method ?? (o.shippingAddress ? 'SELLER_DELIVERY' : 'PICKUP');
      if (method !== 'PICKUP' && !o.shippingAddress) throw new BadRequestException('Add a delivery address to the order first');
      if (input.zoneId) {
        const z = await tx.deliveryZone.findUnique({ where: { id: input.zoneId }, select: { id: true } });
        if (!z) throw new NotFoundException('Delivery zone not found'); // tenant-scoped tx: another store's zone isn't visible
      }
      // Picking one of the seller's couriers fills in the carrier name (kept as written at the time).
      let courierName: string | undefined;
      if (input.courierId) {
        const c = await tx.courier.findUnique({ where: { id: input.courierId }, select: { name: true, isActive: true } });
        if (!c) throw new NotFoundException('Courier not found');
        if (!c.isActive && input.courierId !== d?.courierId) throw new BadRequestException('That courier is switched off');
        courierName = c.name;
      }
      if (method === 'PICKUP' && input.courierId) throw new BadRequestException('A pickup has no courier');
      const data = {
        method,
        ...(input.zoneId !== undefined ? { zoneId: input.zoneId } : {}),
        ...(input.courierId !== undefined ? { courierId: input.courierId } : method === 'PICKUP' ? { courierId: null } : {}),
        ...(courierName !== undefined ? { carrierName: courierName } : input.carrierName !== undefined ? { carrierName: clean(input.carrierName, 80) } : {}),
        ...(input.trackingReference !== undefined ? { trackingReference: clean(input.trackingReference, 80) } : {}),
        ...(input.dispatchNote !== undefined ? { dispatchNote: clean(input.dispatchNote, 300) } : {}),
      };
      if (method === 'THIRD_PARTY' && !(data.carrierName ?? d?.carrierName)) throw new BadRequestException('Name the courier for a third-party delivery');
      if (d) await tx.deliveryOrder.update({ where: { id: d.id }, data });
      else await tx.deliveryOrder.create({ data: { ...data, orderId, logisticsProvider: 'manual' } as Prisma.DeliveryOrderUncheckedCreateInput });
      return Object.keys(data);
    });
    await this.audit.record({ action: 'delivery.updated', actorId, tenantId: t.tenantId, entityType: 'order', entityId: orderId, metadata: { fields: changed } });
    return this.forOrder(t.tenantId, orderId);
  }

  /**
   * Move a delivery: ASSIGNED / IN_TRANSIT / DELIVERED / FAILED / RETURNED. IN_TRANSIT dispatches the order and
   * DELIVERED delivers it (same transaction; the customer is told by the Phase 9 outbox, with carrier + tracking).
   */
  async move(t: TenantContext, actorId: string, orderId: string, to: DeliveryStatus, note?: string) {
    if (!t.permissions.has('orders:update_status')) throw new ForbiddenException('Missing permission: orders:update_status');
    const result = await this.prisma.tenantTransaction(t.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM orders WHERE id = ${orderId}::uuid AND tenant_id = ${t.tenantId}::uuid FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Order not found');
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, shippingAddress: true, delivery: true } });
      if (!SHIPPABLE.includes(o.status)) throw new ConflictException('Only paid orders are delivered. Verify the payment first.');
      let d = o.delivery;
      if (!d) d = await tx.deliveryOrder.create({ data: { orderId, method: o.shippingAddress ? 'SELLER_DELIVERY' : 'PICKUP', logisticsProvider: 'manual' } as Prisma.DeliveryOrderUncheckedCreateInput });
      if (!canMoveDelivery(d.status, to, d.method)) {
        throw new ConflictException(d.method === 'PICKUP' && ['ASSIGNED', 'IN_TRANSIT', 'RETURNED'].includes(to)
          ? 'A pickup is either collected (delivered) or not; it has no rider or transit'
          : `A delivery that is ${STATUS_WORD[d.status]} can’t be marked ${STATUS_WORD[to]}`);
      }
      const clean500 = note?.trim().slice(0, 300) || null;
      if ((to === 'FAILED' || to === 'RETURNED') && !clean500) throw new BadRequestException('Say what happened (e.g. "Customer not reachable")');
      const now = new Date();
      await tx.deliveryOrder.update({
        where: { id: d.id },
        data: {
          status: to,
          ...(to === 'IN_TRANSIT' && !d.dispatchedAt ? { dispatchedAt: now } : {}),
          ...(to === 'DELIVERED' ? { deliveredAt: now } : {}),
          ...(to === 'FAILED' || to === 'RETURNED' ? { problemNote: clean500 } : {}),
        },
      });
      const target = orderStatusFor(to, d.method);
      if (target && target !== o.status) {
        // Moving straight to DELIVERED from PAID is allowed by the order rules; the order records the delivery note.
        const courier = d.courierId ? await tx.courier.findUnique({ where: { id: d.courierId }, select: { phone: true, showPhoneToCustomer: true } }) : null;
        const msg = target === 'DISPATCHED' ? dispatchNote({ ...d, dispatchNote: clean500 ?? d.dispatchNote, carrierPhone: courier?.showPhoneToCustomer ? courier.phone : null }) : clean500;
        await this.orders.transitionTx(tx, t.tenantId, actorId, orderId, target, msg ?? undefined);
      } else {
        await this.orders.noteTx(tx, t.tenantId, orderId, `Delivery ${STATUS_WORD[to]}${clean500 ? `: ${clean500}` : ''}`, actorId);
      }
      return { from: d.status, orderFrom: o.status, orderTo: target && target !== o.status ? target : o.status };
    });
    await this.audit.record({ action: 'delivery.status_changed', actorId, tenantId: t.tenantId, entityType: 'order', entityId: orderId, metadata: { from: result.from, to, order: `${result.orderFrom}->${result.orderTo}` } });
    return this.forOrder(t.tenantId, orderId);
  }

  /** Dispatch board: deliveries of paid orders, by status. */
  async board(tenantId: string, q: { status?: DeliveryStatus; courierId?: string; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const db = this.prisma.forTenant(tenantId);
    // Paid orders not yet delivered show up even before anyone opened their delivery record.
    const where: Prisma.OrderWhereInput = q.status
      ? q.status === 'PENDING'
        ? { status: { in: ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH'] }, OR: [{ delivery: null }, { delivery: { status: 'PENDING' } }] }
        : { delivery: { status: q.status } }
      : { status: { in: SHIPPABLE } };
    if (q.courierId) Object.assign(where, { AND: [{ delivery: { courierId: q.courierId } }] });
    const [items, total] = await Promise.all([
      db.order.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        select: {
          id: true, reference: true, status: true, totalMinor: true, deliveryFeeMinor: true, currency: true, createdAt: true, shippingAddress: true,
          customer: { select: { fullName: true, phone: true } },
          delivery: { select: { method: true, status: true, carrierName: true, courierId: true, trackingReference: true, dispatchedAt: true, deliveredAt: true, problemNote: true, zone: { select: { name: true } } } },
        },
      }),
      db.order.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** What the customer sees on their tracking page. */
  async publicView(tenantId: string, orderId: string) {
    const d = await this.prisma.forTenant(tenantId).deliveryOrder.findUnique({
      where: { orderId }, select: { method: true, status: true, carrierName: true, trackingReference: true, dispatchedAt: true, deliveredAt: true, zone: { select: { name: true, etaDays: true } }, courier: { select: { phone: true, showPhoneToCustomer: true } } },
    });
    if (!d) return null;
    const { courier, ...rest } = d;
    const pickup = d.method === 'PICKUP' ? (await this.settings(tenantId)).settings : null;
    // The courier's phone only when the seller chose to share it, and only while the order is on its way.
    const carrierPhone = courier?.showPhoneToCustomer && ['ASSIGNED', 'IN_TRANSIT', 'FAILED'].includes(d.status) ? courier.phone : null;
    return { ...rest, carrierPhone, pickupAddress: pickup?.pickupAddress ?? null, pickupInstructions: pickup?.pickupInstructions ?? null };
  }
}
