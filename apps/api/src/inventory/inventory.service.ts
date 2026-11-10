import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { InventoryMovementType, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export interface StockLine { variantId: string; quantity: number }

/** Thrown when a reservation can't be met. Carries what *is* available so callers can tell the customer. */
export class InsufficientStockError extends ConflictException {
  constructor(public readonly shortages: Array<{ variantId: string; requested: number; available: number }>) {
    super({ code: 'INSUFFICIENT_STOCK', shortages, message: 'Not enough stock for one or more items' });
  }
}

interface Locked { id: string; variant_id: string; on_hand: number; reserved: number }

/**
 * Stock levels. Every change locks the inventory row (SELECT … FOR UPDATE) inside a transaction, writes an
 * append-only movement with the balances after the change, and bumps `version`. The DB CHECKs
 * (on_hand ≥ 0, reserved ≥ 0, reserved ≤ on_hand) are the backstop, not the mechanism.
 *
 * reserve / release / commitSale take a transaction so the order flow (Phase 4) can include them atomically.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Seller adjustment: add (restock / return), remove (damage, loss) or set to a counted quantity. */
  async adjust(
    tenantId: string, actorId: string, variantId: string,
    input: { mode: 'add' | 'remove' | 'set'; quantity: number; reason: string; type?: 'RESTOCK' | 'ADJUSTMENT' | 'RETURN' },
  ) {
    const result = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const [row] = await this.lock(tx, tenantId, [variantId]);
      if (!row) throw new NotFoundException('Variant not found');
      const delta = input.mode === 'add' ? input.quantity : input.mode === 'remove' ? -input.quantity : input.quantity - row.on_hand;
      if (delta === 0) return { onHand: row.on_hand, reserved: row.reserved, delta: 0 };
      const onHand = row.on_hand + delta;
      if (onHand < row.reserved) {
        throw new ConflictException({
          code: 'BELOW_RESERVED', reserved: row.reserved,
          message: `Stock can't go below ${row.reserved}: that many units are reserved for open orders`,
        });
      }
      const type: InventoryMovementType = input.type ?? (input.mode === 'add' ? 'RESTOCK' : 'ADJUSTMENT');
      await this.apply(tx, row, { onHand, reserved: row.reserved }, type, delta, input.reason, actorId, null);
      if (delta > 0) await this.allocateBackordersTx(tx, [row], actorId);
      return { onHand: row.on_hand, reserved: row.reserved, delta };
    });
    if (result.delta !== 0) {
      await this.audit.record({
        action: 'inventory.adjusted', actorId, tenantId, entityType: 'product_variant', entityId: variantId,
        metadata: { mode: input.mode, delta: result.delta, onHand: result.onHand, reason: input.reason },
      });
    }
    return { onHand: result.onHand, reserved: result.reserved, available: result.onHand - result.reserved };
  }

  /** Opening stock / goods received, inside the caller's transaction (product creation, import). */
  async receiveTx(tx: Tx, tenantId: string, variantId: string, quantity: number, reason: string, actorId: string | null) {
    const [row] = await this.lock(tx, tenantId, [variantId]);
    if (!row) throw new NotFoundException('Variant not found');
    await this.apply(tx, row, { onHand: row.on_hand + quantity, reserved: row.reserved }, 'RESTOCK', quantity, reason, actorId, null);
    await this.allocateBackordersTx(tx, [row], actorId);
  }

  /** Stock count inside the caller's transaction (CSV import): sets on hand, never below what is reserved. */
  async setOnHandTx(tx: Tx, tenantId: string, variantId: string, onHand: number, reason: string, actorId: string | null) {
    const [row] = await this.lock(tx, tenantId, [variantId]);
    if (!row) throw new NotFoundException('Variant not found');
    if (onHand === row.on_hand) return;
    if (onHand < row.reserved) throw new ConflictException(`Stock for this variant can't go below ${row.reserved} (reserved for open orders)`);
    const grew = onHand > row.on_hand;
    await this.apply(tx, row, { onHand, reserved: row.reserved }, 'ADJUSTMENT', onHand - row.on_hand, reason, actorId, null);
    if (grew) await this.allocateBackordersTx(tx, [row], actorId);
  }

  /**
   * Reservation for an order. Rows are locked in a fixed order to avoid deadlocks.
   * Default: all-or-nothing (throws InsufficientStockError). With `allowShortfall` (the store sells pre-orders) it holds
   * what exists and returns the units still missing per variant, which the caller records as order_items.backordered_qty.
   */
  async reserve(tx: Tx, tenantId: string, lines: StockLine[], orderId: string | null, actorId: string | null, opts: { allowShortfall?: boolean } = {}) {
    const merged = mergeLines(lines);
    const rows = await this.lock(tx, tenantId, [...merged.keys()]);
    const byVariant = new Map(rows.map((r) => [r.variant_id, r]));
    const shortages: InsufficientStockError['shortages'] = [];
    for (const [variantId, quantity] of merged) {
      const r = byVariant.get(variantId);
      const available = r ? r.on_hand - r.reserved : 0;
      if (!r || available < quantity) shortages.push({ variantId, requested: quantity, available: Math.max(0, available) });
    }
    if (shortages.length && !opts.allowShortfall) throw new InsufficientStockError(shortages);
    if (shortages.some((s) => !byVariant.has(s.variantId))) throw new InsufficientStockError(shortages); // no stock record at all
    const shortfall = new Map<string, number>();
    for (const [variantId, quantity] of merged) {
      const r = byVariant.get(variantId)!;
      const take = Math.min(quantity, Math.max(0, r.on_hand - r.reserved));
      if (take < quantity) shortfall.set(variantId, quantity - take);
      if (take > 0) await this.apply(tx, r, { onHand: r.on_hand, reserved: r.reserved + take }, 'RESERVATION', take, null, actorId, orderId);
    }
    return shortfall;
  }

  /**
   * Returns reserved units to available stock (cancelled / expired / edited order). Never releases more than is
   * reserved. Pass only what the order actually holds (quantity − backordered). Freed units then go to waiting
   * pre-orders (oldest first), unless `allocate: false` (an edit that re-reserves for the same order straight away).
   */
  async release(tx: Tx, tenantId: string, lines: StockLine[], orderId: string | null, actorId: string | null, opts: { allocate?: boolean } = {}) {
    const merged = mergeLines(lines);
    const rows = await this.lock(tx, tenantId, [...merged.keys()]);
    for (const r of rows) {
      const qty = Math.min(merged.get(r.variant_id) ?? 0, r.reserved);
      if (qty > 0) await this.apply(tx, r, { onHand: r.on_hand, reserved: r.reserved - qty }, 'RELEASE', -qty, null, actorId, orderId);
    }
    if (opts.allocate !== false) await this.allocateBackordersTx(tx, rows, actorId, orderId);
  }

  /**
   * Pre-orders waiting for stock get it oldest order first, as soon as units are available (restock, cancellation).
   * `rows` must already be locked by the caller. Never touches the order being released (`exceptOrderId`).
   */
  private async allocateBackordersTx(tx: Tx, rows: Locked[], actorId: string | null, exceptOrderId: string | null = null) {
    for (const r of rows) {
      if (r.on_hand - r.reserved <= 0) continue;
      const waiting = await tx.$queryRaw<Array<{ id: string; order_id: string; backordered_qty: number }>>`
        SELECT oi.id, oi.order_id, oi.backordered_qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.variant_id = ${r.variant_id}::uuid AND oi.backordered_qty > 0
          AND o.status IN ('PENDING_PAYMENT', 'PAYMENT_VERIFICATION', 'PAID', 'PROCESSING', 'READY_FOR_DISPATCH')
          AND (${exceptOrderId}::uuid IS NULL OR o.id <> ${exceptOrderId}::uuid)
        ORDER BY o.created_at, oi.position FOR UPDATE OF oi`;
      for (const w of waiting) {
        const take = Math.min(w.backordered_qty, r.on_hand - r.reserved);
        if (take <= 0) break;
        await this.apply(tx, r, { onHand: r.on_hand, reserved: r.reserved + take }, 'RESERVATION', take, 'Pre-order filled from new stock', actorId, w.order_id);
        await tx.orderItem.update({ where: { id: w.id }, data: { backorderedQty: { decrement: take } } });
      }
    }
  }

  /** Converts reserved units into a sale (paid order fulfilled): on hand and reserved both decrease. */
  async commitSale(tx: Tx, tenantId: string, lines: StockLine[], orderId: string, actorId: string | null) {
    const merged = mergeLines(lines);
    const rows = await this.lock(tx, tenantId, [...merged.keys()]);
    for (const r of rows) {
      const qty = merged.get(r.variant_id) ?? 0;
      if (qty > r.reserved) throw new ConflictException('Cannot sell more units than were reserved');
      await this.apply(tx, r, { onHand: r.on_hand - qty, reserved: r.reserved - qty }, 'SALE', -qty, null, actorId, orderId);
    }
  }

  async movements(tenantId: string, filter: { variantId?: string; productId?: string }, take = 50) {
    return this.prisma.forTenant(tenantId).inventoryMovement.findMany({
      where: {
        inventory: {
          ...(filter.variantId ? { variantId: filter.variantId } : {}),
          ...(filter.productId ? { variant: { productId: filter.productId } } : {}),
        },
      },
      orderBy: { createdAt: 'desc' }, take,
      select: {
        id: true, type: true, quantity: true, reason: true, orderId: true, actorId: true, onHandAfter: true, reservedAfter: true, createdAt: true,
        inventory: { select: { variant: { select: { id: true, sku: true, name: true } } } },
      },
    });
  }

  /** Active variants at or below their product's low-stock threshold (available = on hand − reserved). */
  lowStock(tenantId: string, take = 50) {
    return this.prisma.$queryRaw<Array<{
      variantId: string; sku: string; variantName: string; productId: string; productName: string; productCode: string;
      onHand: number; reserved: number; available: number; threshold: number;
    }>>`
      SELECT v.id AS "variantId", v.sku, v.name AS "variantName", p.id AS "productId", p.name AS "productName",
             p.product_code AS "productCode", i.on_hand AS "onHand", i.reserved, (i.on_hand - i.reserved) AS available,
             p.low_stock_threshold AS threshold
      FROM inventory i
      JOIN product_variants v ON v.id = i.variant_id AND v.tenant_id = ${tenantId}::uuid
      JOIN products p ON p.id = v.product_id AND p.tenant_id = ${tenantId}::uuid
      WHERE i.tenant_id = ${tenantId}::uuid AND v.is_active AND p.deleted_at IS NULL AND p.status <> 'ARCHIVED'
        AND (i.on_hand - i.reserved) <= p.low_stock_threshold
      ORDER BY (i.on_hand - i.reserved) ASC, p.name ASC
      LIMIT ${take}`;
  }

  // ── internals ──

  private lock(tx: Tx, tenantId: string, variantIds: string[]) {
    if (!variantIds.length) return Promise.resolve([] as Locked[]);
    const ids = [...variantIds].sort();
    return tx.$queryRaw<Locked[]>`
      SELECT id, variant_id, on_hand, reserved FROM inventory
      WHERE tenant_id = ${tenantId}::uuid AND variant_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY variant_id
      FOR UPDATE`;
  }

  private async apply(
    tx: Tx, row: Locked, after: { onHand: number; reserved: number }, type: InventoryMovementType, quantity: number,
    reason: string | null, actorId: string | null, orderId: string | null,
  ) {
    await tx.inventory.update({ where: { id: row.id }, data: { onHand: after.onHand, reserved: after.reserved, version: { increment: 1 } } });
    await tx.inventoryMovement.create({
      data: { inventoryId: row.id, type, quantity, reason, orderId, actorId, onHandAfter: after.onHand, reservedAfter: after.reserved } as Prisma.InventoryMovementUncheckedCreateInput,
    });
    row.on_hand = after.onHand;
    row.reserved = after.reserved;
  }
}

function mergeLines(lines: StockLine[]) {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new ConflictException('Quantities must be positive whole numbers');
    m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  }
  return m;
}
