import { describe, expect, it, vi } from 'vitest';
import { ACTION_LABEL, ORDER_STATUS, relativeHold } from './order-labels';

describe('order labels', () => {
  it('has a label for every status and an action for every step a person can take', () => {
    expect(Object.keys(ORDER_STATUS)).toHaveLength(11);
    for (const s of ['PENDING_PAYMENT', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED', 'CANCELLED'] as const) expect(ACTION_LABEL[s]).toBeTruthy();
    expect(ACTION_LABEL.PAID).toBeUndefined(); // never a manual action
  });

  it('describes how long stock stays held', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-06T12:00:00Z'));
    expect(relativeHold('2026-11-06T14:30:00Z')).toBe('stock held 2h 30m more');
    expect(relativeHold('2026-11-08T13:00:00Z')).toBe('stock held 2d 1h more');
    expect(relativeHold('2026-11-06T11:00:00Z')).toBe('hold expired');
    expect(relativeHold(null)).toBeNull();
    vi.useRealTimers();
  });
});
