import type { DeliveryMethod, DeliveryStatus, OrderStatus } from '../generated/prisma/client';

/**
 * Delivery rules (MASTER-SPEC §18). Pure functions, unit-tested.
 *
 * A delivery belongs to one order. Its status moves on its own track (PENDING → ASSIGNED → IN_TRANSIT → DELIVERED,
 * with FAILED and RETURNED) and drives the order's fulfilment status: IN_TRANSIT dispatches the order, DELIVERED
 * delivers it. FAILED and RETURNED are recorded on the delivery and in the order's history; what happens to the
 * money (refund) and the stock (adjustment) stays a deliberate seller action.
 */

export interface DeliverySettings {
  pickupEnabled: boolean;
  pickupAddress: string | null;
  pickupInstructions: string | null;
  /** Take orders to places no zone covers; the fee is then agreed with the customer. */
  deliverOutsideZones: boolean;
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = { pickupEnabled: false, pickupAddress: null, pickupInstructions: null, deliverOutsideZones: true };

export function deliverySettings(stored: unknown): DeliverySettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const pickupAddress = str(s.pickupAddress, 300);
  return {
    // Pickup needs an address to send people to.
    pickupEnabled: s.pickupEnabled === true && !!pickupAddress,
    pickupAddress,
    pickupInstructions: str(s.pickupInstructions, 300),
    deliverOutsideZones: typeof s.deliverOutsideZones === 'boolean' ? s.deliverOutsideZones : DEFAULT_DELIVERY_SETTINGS.deliverOutsideZones,
  };
}

export interface ZoneLike { id: string; name: string; states: string[]; cities: string[]; feeMinor: bigint; etaDays: number | null; isActive: boolean }

const norm = (v: string) => v.toLowerCase().replace(/\bstate\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The zone for an address. A zone that names the city beats one that only names the state; among equals the
 * cheaper one wins (the customer never pays more because of how zones overlap). Inactive zones never match.
 */
export function matchZone<Z extends ZoneLike>(zones: Z[], address: { state: string; city: string }): Z | null {
  const state = norm(address.state);
  const city = norm(address.city);
  let best: { zone: Z; score: number } | null = null;
  for (const z of zones) {
    if (!z.isActive) continue;
    const states = z.states.map(norm);
    const cities = z.cities.map(norm);
    const stateOk = states.length === 0 || states.includes(state);
    const cityOk = cities.length > 0 && cities.includes(city);
    if (!stateOk) continue;
    if (cities.length > 0 && !cityOk) continue; // a city list limits the zone to those cities
    if (states.length === 0 && cities.length === 0) continue; // empty zone covers nothing
    const score = cityOk ? 2 : 1;
    if (!best || score > best.score || (score === best.score && z.feeMinor < best.zone.feeMinor)) best = { zone: z, score };
  }
  return best?.zone ?? null;
}

/** `feeMinor` null = can't deliver there; `feeToBeAgreed` = the order goes in with 0 and the seller confirms the fee. */
export interface Quote { method: 'DELIVERY'; available: boolean; feeMinor: bigint | null; zone: { id: string; name: string; etaDays: number | null } | null; feeToBeAgreed: boolean }

/** What delivery costs for this address under these settings (the server always recomputes this; clients only display it). */
export function quoteDelivery(zones: ZoneLike[], settings: DeliverySettings, address: { state: string; city: string } | null): Quote {
  const active = zones.filter((z) => z.isActive);
  if (!address) return { method: 'DELIVERY', available: active.length > 0 || settings.deliverOutsideZones, feeMinor: null, zone: null, feeToBeAgreed: active.length === 0 };
  const z = matchZone(active, address);
  if (z) return { method: 'DELIVERY', available: true, feeMinor: z.feeMinor, zone: { id: z.id, name: z.name, etaDays: z.etaDays }, feeToBeAgreed: false };
  // No zones at all: the pre-Phase-10 behaviour (the seller confirms any fee). Zones but none match: the store decides.
  const available = active.length === 0 || settings.deliverOutsideZones;
  return { method: 'DELIVERY', available, feeMinor: available ? 0n : null, zone: null, feeToBeAgreed: available };
}

export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'FAILED'],
  ASSIGNED: ['IN_TRANSIT', 'DELIVERED', 'FAILED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED', 'RETURNED'],
  FAILED: ['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED'],
  DELIVERED: [],
  RETURNED: [],
};

export function canMoveDelivery(from: DeliveryStatus, to: DeliveryStatus, method: DeliveryMethod): boolean {
  if (method === 'PICKUP' && (to === 'ASSIGNED' || to === 'IN_TRANSIT' || to === 'RETURNED')) return false; // collected, or not
  return DELIVERY_TRANSITIONS[from].includes(to);
}

/** Order statuses in which a delivery can move (it must be paid; a cancelled or refunded order doesn't ship). */
export const SHIPPABLE: OrderStatus[] = ['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED'];

/** The order status a delivery status pulls the order to, if it isn't there yet. */
export function orderStatusFor(to: DeliveryStatus, method: DeliveryMethod): OrderStatus | null {
  if (to === 'DELIVERED') return 'DELIVERED';
  if (to === 'IN_TRANSIT' && method !== 'PICKUP') return 'DISPATCHED';
  return null;
}

/** The delivery status an order status implies (when staff move the order itself). */
export function deliveryStatusFor(order: OrderStatus, method: DeliveryMethod): DeliveryStatus | null {
  if (order === 'DELIVERED') return 'DELIVERED';
  if (order === 'DISPATCHED') return method === 'PICKUP' ? null : 'IN_TRANSIT';
  return null;
}

/** Customer-facing sentence for the dispatch message ("Sent with GIG Logistics, tracking 123"). */
export function dispatchNote(d: { method: DeliveryMethod; carrierName: string | null; trackingReference: string | null; dispatchNote: string | null; carrierPhone?: string | null }): string | null {
  const parts: string[] = [];
  if (d.carrierName) parts.push(`sent with ${d.carrierName}${d.carrierPhone ? ` (${d.carrierPhone})` : ''}`);
  if (d.trackingReference) parts.push(`tracking ${d.trackingReference}`);
  if (d.dispatchNote) parts.push(d.dispatchNote);
  if (!parts.length) return null;
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
