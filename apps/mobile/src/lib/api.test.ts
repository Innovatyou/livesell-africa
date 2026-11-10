/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';
import { api, ApiError, login, logout, messageOf, refresh, session } from './api';
import { e164, holdLabel, isE164, money, toKobo } from './format';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDevice',
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
    __store: store,
  };
});
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const json = (status: number, body: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('mobile session client', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    store.clear();
    session.reset();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  const call = (i: number) => {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };

  it('login asks for a mobile session and keeps the refresh token in secure storage only', async () => {
    fetchMock.mockImplementationOnce(() => json(200, { accessToken: 'a1', expiresIn: 900, refreshToken: 'r1' }));
    await login('ada@example.com', 'CorrectHorse42');
    expect(call(0).headers['X-Client-Type']).toBe('mobile');
    expect(call(0).init.credentials).toBe('omit');
    expect(call(0).body).toEqual({ identifier: 'ada@example.com', password: 'CorrectHorse42' });
    expect(store.get('ls.refresh')).toBe('r1');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('ls.refresh', 'r1', { keychainAccessible: 'afterFirstUnlockThisDevice' });
    fetchMock.mockImplementationOnce(() => json(200, { ok: true }));
    await session.setTenant('t-1');
    await api('/products');
    expect(call(1).headers).toMatchObject({ Authorization: 'Bearer a1', 'X-Tenant-Id': 't-1' });
  });

  it('wrong credentials read plainly', async () => {
    fetchMock.mockImplementationOnce(() => json(401, { message: 'Invalid credentials' }));
    await expect(login('a@b.ng', 'x')).rejects.toThrow('Wrong email, phone or password.');
  });

  it('a 401 refreshes once (rotating the token) and retries; concurrent calls share one refresh', async () => {
    store.set('ls.refresh', 'r1');
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'a2', expiresIn: 900, refreshToken: 'r2' });
      const auth = (fetchMock.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>;
      return auth.Authorization === 'Bearer a2' ? json(200, { ok: 1 }) : json(401, { message: 'expired' });
    });
    const [a, b] = await Promise.all([api('/orders'), api('/products')]);
    expect(a).toEqual({ ok: 1 });
    expect(b).toEqual({ ok: 1 });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(store.get('ls.refresh')).toBe('r2');
    const refreshCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/refresh'))!;
    expect(JSON.parse(String((refreshCall[1] as RequestInit).body))).toEqual({ refreshToken: 'r1' });
  });

  it('a rejected refresh signs out and clears secure storage', async () => {
    store.set('ls.refresh', 'r1');
    const signedOut = jest.fn();
    session.onSignedOut(signedOut);
    fetchMock.mockImplementation((url: string) => (url.endsWith('/auth/refresh') ? json(401, { message: 'reused' }) : json(401, { message: 'expired' })));
    await expect(api('/orders')).rejects.toBeInstanceOf(ApiError);
    expect(signedOut).toHaveBeenCalled();
    expect(store.has('ls.refresh')).toBe(false);
    expect(await refresh()).toBe(false);
  });

  it('errors carry the server message and code; offline reads plainly', async () => {
    fetchMock.mockImplementationOnce(() => json(409, { code: 'INSUFFICIENT_STOCK', message: 'Only 1 left' }));
    await expect(api('/orders', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK', message: 'Only 1 left' });
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Network request failed')));
    await expect(api('/orders')).rejects.toMatchObject({ status: 0 });
    expect(messageOf(400, { message: ['a', 'b'] })).toBe('a. b');
  });

  it('logout revokes the token on the server and forgets it', async () => {
    store.set('ls.refresh', 'r9');
    fetchMock.mockImplementationOnce(() => json(204, undefined));
    await logout();
    expect(call(0).body).toEqual({ refreshToken: 'r9' });
    expect(store.size).toBe(0);
  });
});

describe('format', () => {
  it('money and amounts stay exact', () => {
    expect(money('2500000')).toBe('₦25,000');
    expect(money('123456789')).toBe('₦1,234,567.89');
    expect(toKobo('25,000')).toBe('2500000');
    expect(toKobo('₦1,234.5')).toBe('123450');
    expect(toKobo('1.234')).toBeNull();
    expect(toKobo('abc')).toBeNull();
  });
  it('phones and holds', () => {
    expect(e164('0803 123 4567')).toBe('+2348031234567');
    expect(isE164(e164('2348031234567'))).toBe(true);
    expect(isE164('0803')).toBe(false);
    const now = Date.parse('2026-11-08T10:00:00Z');
    expect(holdLabel('2026-11-08T13:20:00Z', now)).toBe('stock held 3h 20m more');
    expect(holdLabel('2026-11-08T09:00:00Z', now)).toBe('hold expired');
  });
});
