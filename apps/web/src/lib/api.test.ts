import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API rotates refresh tokens and revokes the whole session if an old one is replayed, so the client must
 * never send two refreshes at once, must retry a 401 once after refreshing, and must keep the access token
 * out of persistent storage.
 */
describe('api client session handling', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('shares one refresh request between concurrent callers', async () => {
    let refreshes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: 'new-token', expiresIn: 900 });
      }
      return json(404, {});
    }));
    const { refreshSession, hasSession } = await import('./api');
    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(results).toEqual([true, true, true]);
    expect(refreshes).toBe(1);
    expect(hasSession()).toBe(true);
  });

  it('retries a 401 once after refreshing, with the new token and the tenant header', async () => {
    const seen: Array<{ url: string; auth?: string; tenant?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: h.Authorization, tenant: h['X-Tenant-Id'] });
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'fresh', expiresIn: 900 });
      return h.Authorization === 'Bearer fresh' ? json(200, { ok: true }) : json(401, { message: 'Invalid or expired token' });
    }));
    const { api, setSession, setActiveTenant } = await import('./api');
    setSession('stale', 900);
    setActiveTenant('11111111-1111-4111-8111-111111111111');
    await expect(api('/workspace')).resolves.toEqual({ ok: true });
    expect(seen.map((s) => s.url.replace(/^.*\/api\/v1/, ''))).toEqual(['/workspace', '/auth/refresh', '/workspace']);
    expect(seen[2]).toMatchObject({ auth: 'Bearer fresh', tenant: '11111111-1111-4111-8111-111111111111' });
  });

  it('signs out when refresh fails and surfaces server validation messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) return json(401, { message: 'Session expired' });
      if (url.endsWith('/store/profile')) return json(400, { message: ['whatsappNumber must be E.164', 'name too short'] });
      return json(401, {});
    }));
    const { api, setSession, hasSession, onSessionChange, ApiError } = await import('./api');
    const events: boolean[] = [];
    onSessionChange((s) => events.push(s));
    setSession('stale', 900);
    await expect(api('/workspace')).rejects.toBeInstanceOf(ApiError);
    expect(hasSession()).toBe(false);
    expect(events).toEqual([true, false]);
    await expect(api('/store/profile', { method: 'PATCH', body: {} })).rejects.toMatchObject({ status: 400, message: 'whatsappNumber must be E.164. name too short' });
  });

  it('never writes the access token to web storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { accessToken: 'secret-token', expiresIn: 900 })));
    const { refreshSession } = await import('./api');
    await refreshSession();
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie;
    expect(dump).not.toContain('secret-token');
  });
});
