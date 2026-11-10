import * as SecureStore from 'expo-secure-store';

/**
 * LiveSell API client for the seller app (same /api/v1 as the web).
 *
 * Session rules (mobile, `X-Client-Type: mobile`):
 *  - the access token lives in memory only;
 *  - the refresh token is kept in the device keychain/keystore (expo-secure-store, available after first unlock,
 *    this device only — never synced to backups) and rotated on every refresh;
 *  - a 401 triggers one refresh (shared by concurrent requests), then one retry; a failed refresh signs out;
 *  - cookies are never used (`credentials: 'omit'`).
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const REFRESH_KEY = 'ls.refresh';
const TENANT_KEY = 'ls.tenant';
const STORE_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: unknown) {
    super(message);
  }
}

interface SessionBody { accessToken: string; expiresIn: number; refreshToken?: string }

let accessToken: string | null = null;
let tenantId: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export const session = {
  setTenant: async (id: string | null) => {
    tenantId = id;
    if (id) await SecureStore.setItemAsync(TENANT_KEY, id, STORE_OPTS);
    else await SecureStore.deleteItemAsync(TENANT_KEY, STORE_OPTS);
  },
  savedTenant: () => SecureStore.getItemAsync(TENANT_KEY, STORE_OPTS),
  hasRefresh: async () => !!(await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTS)),
  onSignedOut: (fn: () => void) => { onSignedOut = fn; },
  /** For tests. */
  reset: () => { accessToken = null; tenantId = null; refreshing = null; },
};

async function store(body: SessionBody) {
  accessToken = body.accessToken;
  if (!body.refreshToken) throw new ApiError(500, 'The server did not return a mobile session');
  await SecureStore.setItemAsync(REFRESH_KEY, body.refreshToken, STORE_OPTS);
}

async function clear() {
  accessToken = null;
  tenantId = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY, STORE_OPTS);
  await SecureStore.deleteItemAsync(TENANT_KEY, STORE_OPTS);
}

/** Plain-language message for an error body ({ message } or class-validator's string[]). */
export function messageOf(status: number, body: unknown): string {
  const b = (body ?? {}) as { message?: unknown };
  if (Array.isArray(b.message)) return b.message.join('. ');
  if (typeof b.message === 'string' && b.message) return b.message;
  if (status === 0) return 'Can’t reach LiveSell. Check your connection and try again.';
  if (status === 429) return 'Too many attempts. Please wait a little and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return 'The request could not be completed.';
}

async function raw(path: string, init: RequestInit & { tenant?: boolean }) {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Client-Type': 'mobile', ...(init.headers as Record<string, string>) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (init.tenant !== false && tenantId) headers['X-Tenant-Id'] = tenantId;
  try {
    return await fetch(`${API_URL}/api/v1${path}`, { ...init, headers, credentials: 'omit' });
  } catch {
    throw new ApiError(0, messageOf(0, null));
  }
}

/** Rotate the refresh token. Concurrent callers share one attempt. */
export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const token = await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTS);
      if (!token) return false;
      const res = await raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: token }), tenant: false });
      if (!res.ok) {
        if (res.status === 401) await clear();
        return false;
      }
      await store((await res.json()) as SessionBody);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; tenant?: boolean } = {}, retried = false): Promise<T> {
  const res = await raw(path, { method: opts.method ?? 'GET', body: opts.body === undefined ? undefined : JSON.stringify(opts.body), tenant: opts.tenant });
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, opts, true);
    await clear();
    onSignedOut?.();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, messageOf(res.status, body), (body as { code?: string } | undefined)?.code, body);
  return body as T;
}

/** Sign in with an email or a phone number (the server accepts 0803…, +234… and emails). */
export async function login(identifier: string, password: string) {
  const res = await raw('/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }), tenant: false });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? 'Wrong email, phone or password.' : messageOf(res.status, body), (body as { code?: string }).code, body);
  await store(body as SessionBody);
}

/** Create a store (same rules as the web sign-up) and start a mobile session on it. Returns the new store id. */
export async function registerAccount(body: Record<string, unknown>): Promise<string> {
  const res = await raw('/auth/register', { method: 'POST', body: JSON.stringify(body), tenant: false });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, messageOf(res.status, data), (data as { code?: string }).code, data);
  await store(data as SessionBody);
  return (data as { tenant: { id: string } }).tenant.id;
}

export async function logout() {
  const token = await SecureStore.getItemAsync(REFRESH_KEY, STORE_OPTS);
  if (token) await raw('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: token }), tenant: false }).catch(() => undefined);
  await clear();
}
