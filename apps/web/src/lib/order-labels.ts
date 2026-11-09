import type { LiveStatus, OrderStatus } from './types';

export const LIVE_BADGE: Record<LiveStatus, ['neutral' | 'bad' | 'good' | 'info', string]> = { SCHEDULED: ['info', 'Scheduled'], LIVE: ['bad', '● Live'], ENDED: ['neutral', 'Ended'], CANCELLED: ['neutral', 'Cancelled'] };

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warn' },
  PAYMENT_VERIFICATION: { label: 'Verifying payment', tone: 'warn' },
  PAID: { label: 'Paid', tone: 'good' },
  PROCESSING: { label: 'Processing', tone: 'info' },
  READY_FOR_DISPATCH: { label: 'Ready to dispatch', tone: 'info' },
  DISPATCHED: { label: 'Dispatched', tone: 'brand' },
  DELIVERED: { label: 'Delivered', tone: 'good' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REFUNDED: { label: 'Refunded', tone: 'bad' },
  PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'bad' },
};

/** Button wording for the next step a person can take. */
export const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  PENDING_PAYMENT: 'Confirm order', PROCESSING: 'Start processing', READY_FOR_DISPATCH: 'Mark ready',
  DISPATCHED: 'Mark dispatched', DELIVERED: 'Mark delivered', CANCELLED: 'Cancel order',
};

export function relativeHold(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'hold expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `stock held ${Math.floor(h / 24)}d ${h % 24}h more` : `stock held ${h}h ${m}m more`;
}
