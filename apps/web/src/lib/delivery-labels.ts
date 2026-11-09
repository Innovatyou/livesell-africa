import type { DeliveryMethod, DeliveryStatus } from './types';

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone; action: string }> = {
  PENDING: { label: 'Not sent yet', tone: 'neutral', action: 'Pending' },
  ASSIGNED: { label: 'Rider assigned', tone: 'info', action: 'Rider assigned' },
  IN_TRANSIT: { label: 'On the way', tone: 'info', action: 'Mark on the way' },
  DELIVERED: { label: 'Delivered', tone: 'good', action: 'Mark delivered' },
  FAILED: { label: 'Attempt failed', tone: 'warn', action: 'Attempt failed' },
  RETURNED: { label: 'Returned', tone: 'bad', action: 'Returned to us' },
};

export const DELIVERY_METHOD: Record<DeliveryMethod, string> = {
  PICKUP: 'Customer pickup',
  SELLER_DELIVERY: 'Our own delivery',
  THIRD_PARTY: 'Courier / logistics company',
};

/** Pickup is collected, not delivered: the words change, the status doesn't. */
export function deliveryActionLabel(status: DeliveryStatus, method: DeliveryMethod): string {
  if (method === 'PICKUP' && status === 'DELIVERED') return 'Mark collected';
  if (method === 'PICKUP' && status === 'FAILED') return 'Not collected';
  return DELIVERY_STATUS[status].action;
}

/** Comma/newline separated list typed by a seller → clean array (no blanks, no duplicates, case-insensitive). */
export function splitList(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}
