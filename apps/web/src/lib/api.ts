/**
 * API client.
 * - The access token lives only in this module's memory (never localStorage / cookies readable by JS).
 * - The refresh token is an httpOnly, SameSite=Strict cookie scoped to /api/v1/auth; the browser sends it.
 * - Refresh is single-flight within a tab and serialised across tabs (Web Locks), because the API rotates
 *   refresh tokens and treats a replayed one as theft (it revokes the whole session family).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: unknown) {
    super(message);
  }
}

let accessToken: string | null = null;
let accessExpiresAt = 0;
let tenantId: string | null = null;
let inflight: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export function onSessionChange(fn: (signedIn: boolean) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setSession(token: string | null, expiresInSeconds = 0) {
  const was = !!accessToken;
  accessToken = token;
  accessExpiresAt = token ? Date.now() + expiresInSeconds * 1000 : 0;
  if (was !== !!token) listeners.forEach((l) => l(!!token));
}

export function hasSession() {
  return !!accessToken;
}

export function setActiveTenant(id: string | null) {
  tenantId = id;
}

export function getActiveTenant() {
  return tenantId;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) {
      setSession(null);
      return false;
    }
    const body = (await res.json()) as { accessToken: string; expiresIn: number };
    setSession(body.accessToken, body.expiresIn);
    return true;
  } catch {
    // Network failure: keep the current state; callers surface the error.
    return !!accessToken;
  }
}

/** Refreshes the access token. Concurrent callers share one request; other tabs wait their turn. */
export function refreshSession(): Promise<boolean> {
  if (inflight) return inflight;
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  // `.then` flattens the lock's Promise<Promise<boolean>> typing (runtime already resolves the inner promise).
  const run: Promise<boolean> = locks ? locks.request('livesell-refresh', () => doRefresh()).then((r) => r) : doRefresh();
  const shared = run.finally(() => {
    inflight = null;
  });
  inflight = shared;
  return shared;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send X-Tenant-Id for the active workspace (default true when one is selected). */
  tenant?: boolean;
  signal?: AbortSignal;
  /** Extra request headers (e.g. Idempotency-Key). Auth and tenant headers are always set by this function. */
  headers?: Record<string, string>;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  if (accessToken && accessExpiresAt - Date.now() < 30_000) await refreshSession();
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.tenant !== false && tenantId) headers['X-Tenant-Id'] = tenantId;

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      method: opts.method ?? 'GET', headers, credentials: 'include', signal: opts.signal,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, "Can't reach LiveSell right now. Check your connection and try again.");
  }

  if (res.status === 401 && accessToken && !retried && !path.startsWith('/auth/login')) {
    if (await refreshSession()) return api<T>(path, opts, true);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) throw toError(res.status, body);
  return body as T;
}

/** Binary GET (PDF reports) with the same auth, tenant and refresh handling as `api`. */
export async function apiBlob(path: string, retried = false): Promise<Blob> {
  if (accessToken && accessExpiresAt - Date.now() < 30_000) await refreshSession();
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, { headers, credentials: 'include' });
  } catch {
    throw new ApiError(0, "Can't reach LiveSell right now. Check your connection and try again.");
  }
  if (res.status === 401 && accessToken && !retried && (await refreshSession())) return apiBlob(path, true);
  if (!res.ok) {
    const text = await res.text();
    throw toError(res.status, text ? safeJson(text) : undefined);
  }
  return res.blob();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toError(status: number, body: unknown): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; code?: string };
  const raw = Array.isArray(b.message) ? b.message.join('. ') : typeof b.message === 'string' ? b.message : undefined;
  const fallback =
    status === 429 ? 'Too many attempts. Please wait a moment and try again.'
    : status >= 500 ? 'Something went wrong on our side. Please try again.'
    : 'The request could not be completed.';
  return new ApiError(status, raw ?? fallback, b.code, body);
}

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
}
