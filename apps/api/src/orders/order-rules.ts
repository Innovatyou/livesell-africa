import { randomInt } from 'node:crypto';
import type { FulfilmentStatus, OrderStatus, PaymentStatus } from '../generated/prisma/client';

/**
 * Order status machine (MASTER-SPEC §11). Pure, unit-tested.
 *
 * `user` transitions are what sellers/staff can do. `system` transitions come only from the payments module
 * (after server-side verification — rule 4) or from scheduled jobs (reservation expiry). PAID, PAYMENT_VERIFICATION,
 * REFUNDED and PARTIALLY_REFUNDED can never be set by a person through the orders API.
 */
type Actor = 'user' | 'system';

const T: Record<OrderStatus, Partial<Record<OrderStatus, Actor[]>>> = {
  DRAFT: { PENDING_PAYMENT: ['user'], CANCELLED: ['user'] },
  PENDING_PAYMENT: { PAYMENT_VERIFICATION: ['system'], PAID: ['system'], CANCELLED: ['user', 'system'] },
  PAYMENT_VERIFICATION: { PAID: ['system'], PENDING_PAYMENT: ['system'], CANCELLED: ['user', 'system'] },
  // Fulfilment may skip steps forward (small sellers often go straight from paid to dispatched).
  PAID: { PROCESSING: ['user'], READY_FOR_DISPATCH: ['user'], DISPATCHED: ['user'], DELIVERED: ['user'], REFUNDED: ['system'], PARTIALLY_REFUNDED: ['system'] },
  PROCESSING: { READY_FOR_DISPATCH: ['user'], DISPATCHED: ['user'], DELIVERED: ['user'], REFUNDED: ['system'], PARTIALLY_REFUNDED: ['system'] },
  READY_FOR_DISPATCH: { DISPATCHED: ['user'], DELIVERED: ['user'], REFUNDED: ['system'], PARTIALLY_REFUNDED: ['system'] },
  DISPATCHED: { DELIVERED: ['user'], REFUNDED: ['system'], PARTIALLY_REFUNDED: ['system'] },
  DELIVERED: { REFUNDED: ['system'], PARTIALLY_REFUNDED: ['system'] },
  PARTIALLY_REFUNDED: { REFUNDED: ['system'] },
  REFUNDED: {},
  CANCELLED: {},
};

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return !!T[from][to]?.includes(actor);
}

/** Statuses a person may move this order to next (drives the UI's action buttons). */
export function nextUserStatuses(from: OrderStatus): OrderStatus[] {
  return (Object.entries(T[from]) as Array<[OrderStatus, Actor[]]>).filter(([, a]) => a.includes('user')).map(([s]) => s);
}

export function paymentStatusFor(status: OrderStatus, current: PaymentStatus): PaymentStatus {
  switch (status) {
    case 'DRAFT': return 'UNPAID';
    case 'PENDING_PAYMENT': return 'PENDING';
    case 'PAYMENT_VERIFICATION': return 'AWAITING_VERIFICATION';
    case 'REFUNDED': return 'REFUNDED';
    case 'PARTIALLY_REFUNDED': return 'PARTIALLY_REFUNDED';
    case 'CANCELLED': return current === 'PAID' ? 'PAID' : current === 'PENDING' || current === 'AWAITING_VERIFICATION' ? 'UNPAID' : current;
    default: return 'PAID';
  }
}

export function fulfilmentStatusFor(status: OrderStatus, current: FulfilmentStatus): FulfilmentStatus {
  switch (status) {
    case 'PROCESSING': return 'PROCESSING';
    case 'READY_FOR_DISPATCH': return 'READY';
    case 'DISPATCHED': return 'DISPATCHED';
    case 'DELIVERED': return 'DELIVERED';
    default: return current;
  }
}

/** Unpaid statuses whose reservation can expire. */
export const HOLD_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'];
/** Reserved units become a sale when the goods leave. */
export const commitsStock = (to: OrderStatus) => to === 'DISPATCHED' || to === 'DELIVERED';
/** Orders whose items/amounts can still be edited. */
export const EDITABLE: OrderStatus[] = ['DRAFT', 'PENDING_PAYMENT'];

export interface LineInput { unitPriceMinor: bigint; quantity: number; discountMinor: bigint }

export class TotalsError extends Error {}

/** Integer kobo arithmetic, mirrored by DB CHECK constraints. */
export function computeTotals(lines: LineInput[], discountMinor: bigint, deliveryFeeMinor: bigint) {
  if (discountMinor < 0n || deliveryFeeMinor < 0n) throw new TotalsError('Discount and delivery fee cannot be negative');
  const items = lines.map((l, i) => {
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw new TotalsError(`Line ${i + 1}: quantity must be at least 1`);
    if (l.unitPriceMinor < 0n || l.discountMinor < 0n) throw new TotalsError(`Line ${i + 1}: amounts cannot be negative`);
    const gross = l.unitPriceMinor * BigInt(l.quantity);
    if (l.discountMinor > gross) throw new TotalsError(`Line ${i + 1}: discount is larger than the line amount`);
    return { ...l, lineTotalMinor: gross - l.discountMinor };
  });
  const subtotalMinor = items.reduce((s, l) => s + l.lineTotalMinor, 0n);
  if (discountMinor > subtotalMinor + deliveryFeeMinor) throw new TotalsError('Order discount is larger than the order amount');
  return { items, subtotalMinor, discountMinor, deliveryFeeMinor, totalMinor: subtotalMinor - discountMinor + deliveryFeeMinor };
}

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L — readable over the phone and on WhatsApp

/** Customer-facing reference, e.g. LS-7K3QXP. Random (doesn't reveal order volume); unique per store via DB index. */
export function orderReference(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `LS-${s}`;
}
