/// <reference types="jest" />
import { ApiError } from './api';
import { discard, enqueue, flush, list, newClientRef, retryable } from './offline-queue';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-secure-store', () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'x', getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));
jest.mock('./api', () => {
  const actual = jest.requireActual('./api');
  return { ...actual, api: jest.fn() };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api } = require('./api') as { api: jest.Mock };

describe('offline order queue', () => {
  beforeEach(async () => {
    for (const q of await list()) await discard(q.clientRef);
    api.mockReset();
  });

  it('keeps each order once, with its clientRef in the body', async () => {
    const body = { liveSessionId: 's1', clientRef: newClientRef(), items: [{ productCode: 'BAG001', quantity: 1 }] };
    await enqueue('t1', body, '1 x BAG001');
    await enqueue('t1', body, '1 x BAG001'); // same order saved twice
    const q = await list();
    expect(q).toHaveLength(1);
    expect(q[0].body.clientRef).toBe(body.clientRef);
    expect(q[0].clientRef).toMatch(/^m-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('sends this store’s orders oldest first, stops while offline, keeps refused ones with the reason', async () => {
    await enqueue('t1', { clientRef: 'm-a-00000001' }, 'A');
    await enqueue('t1', { clientRef: 'm-b-00000002' }, 'B');
    await enqueue('t2', { clientRef: 'm-c-00000003' }, 'other store');
    api.mockRejectedValueOnce(new ApiError(0, 'offline'));
    expect(await flush('t1')).toEqual({ sent: 0, failed: 0, left: 2 });
    expect(api).toHaveBeenCalledTimes(1); // stopped at the first network failure

    api.mockResolvedValueOnce({ id: 'o1' }).mockRejectedValueOnce(new ApiError(409, 'Only 0 left', 'INSUFFICIENT_STOCK'));
    expect(await flush('t1')).toEqual({ sent: 1, failed: 1, left: 1 });
    const left = await list();
    expect(left.find((q) => q.clientRef === 'm-b-00000002')).toMatchObject({ failed: 'Only 0 left', attempts: 1 });
    expect(left.find((q) => q.tenantId === 't2')).toBeDefined(); // another store's orders wait for that store

    api.mockClear();
    await flush('t1');
    expect(api).not.toHaveBeenCalled(); // refused orders aren't retried; the seller decides
  });

  it('only network trouble, rate limits and server errors are worth retrying', () => {
    expect(retryable(new ApiError(0, 'x'))).toBe(true);
    expect(retryable(new ApiError(503, 'x'))).toBe(true);
    expect(retryable(new ApiError(429, 'x'))).toBe(true);
    expect(retryable(new ApiError(409, 'x'))).toBe(false);
    expect(retryable(new Error('x'))).toBe(false);
  });
});

describe('notification taps', () => {
  it('open the order in its store; anything else is ignored', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { routeFor } = require('./push') as typeof import('./push');
    const id = '2b56b257-bd8c-4056-a081-5ca687f4dc76';
    expect(routeFor({ type: 'new_order', orderId: id, tenantId: 't1' })).toEqual({ tenantId: 't1', path: `/orders/${id}` });
    expect(routeFor({ orderId: '../../admin', tenantId: 't1' })).toBeNull();
    expect(routeFor(undefined)).toBeNull();
  });
});
