import type { NotificationStatus } from './types';

export const CHANNEL_LABEL: Record<string, string> = { WHATSAPP: 'WhatsApp', SMS: 'SMS', EMAIL: 'Email' };

export const NOTIFICATION_STATUS: Record<NotificationStatus, [string, 'good' | 'warn' | 'bad' | 'neutral' | 'info']> = {
  QUEUED: ['Retrying', 'warn'], SENT: ['Sent', 'info'], DELIVERED: ['Delivered', 'good'], FAILED: ['Failed', 'bad'],
};

/** Plain-language reason for a failed message (the API stores "CODE: detail"). */
export function failureReason(error: string | null): string {
  if (!error) return '';
  if (error === 'LIMIT_REACHED') return 'Monthly limit reached';
  if (error.startsWith('INSUFFICIENT_BALANCE')) return 'Messaging credit ran out';
  if (error.startsWith('NOT_CONFIGURED')) return 'Channel not set up';
  if (error.startsWith('CHANNEL_DISABLED')) return 'Channel switched off';
  return error.replace(/^[A-Z_]+: /, '');
}

/** Share of the monthly limit used, 0–100 (whole percent, never NaN). */
export function usedPercent(sent: number, limit: number): number {
  if (limit <= 0) return sent > 0 ? 100 : 0;
  return Math.min(100, Math.floor((sent * 100) / limit));
}

/** Customer messages about an order (Phase 9), in the order the seller sees them in settings. */
export const ORDER_EVENT_LABEL: Record<string, string> = {
  ORDER_PLACED: 'Order placed (with invoice by email)',
  PAYMENT_RECEIVED: 'Payment confirmed (with receipt by email)',
  PAYMENT_REMINDER: 'Payment reminder',
  ABANDONED_CHECKOUT: 'Unpaid online order nudge',
  TRANSFER_REPORTED: 'Bank transfer report received',
  TRANSFER_NOT_FOUND: 'Bank transfer not found',
  ORDER_DISPATCHED: 'Order dispatched',
  ORDER_DELIVERED: 'Order delivered',
  ORDER_CANCELLED: 'Order cancelled',
  REFUND_COMPLETED: 'Refund completed',
};

/** Readable name for a notification type ("PAYMENT_REMINDER" → "Payment reminder"). */
export function messageTypeLabel(type: string): string {
  return ORDER_EVENT_LABEL[type]?.replace(/ \(.*\)$/, '') ?? (type === 'WHATSAPP_REPLY' ? 'WhatsApp reply' : type.charAt(0) + type.slice(1).replace(/_/g, ' ').toLowerCase());
}
