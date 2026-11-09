import { describe, expect, it } from 'vitest';
import { failureReason, usedPercent } from './messaging-labels';

describe('messaging labels', () => {
  it('explains failures in plain words', () => {
    expect(failureReason('LIMIT_REACHED')).toBe('Monthly limit reached');
    expect(failureReason('INSUFFICIENT_BALANCE: Insufficient wallet balance.')).toBe('Messaging credit ran out');
    expect(failureReason('REJECTED: invalid number')).toBe('invalid number');
    expect(failureReason(null)).toBe('');
  });
  it('limit usage is a whole percent capped at 100', () => {
    expect([usedPercent(0, 300), usedPercent(150, 300), usedPercent(301, 300), usedPercent(1, 3), usedPercent(5, 0)]).toEqual([0, 50, 100, 33, 100]);
  });
});

describe('order message labels (Phase 9)', () => {
  it('names every automatic message and reads notification types', async () => {
    const { ORDER_EVENT_LABEL, messageTypeLabel } = await import('./messaging-labels');
    expect(Object.keys(ORDER_EVENT_LABEL)).toHaveLength(10);
    expect(messageTypeLabel('PAYMENT_RECEIVED')).toBe('Payment confirmed');
    expect(messageTypeLabel('WHATSAPP_REPLY')).toBe('WhatsApp reply');
    expect(messageTypeLabel('BILLING_REMINDER')).toBe('Billing reminder');
  });
});
