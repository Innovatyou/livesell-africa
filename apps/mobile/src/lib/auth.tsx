import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, login as apiLogin, logout as apiLogout, refresh, registerAccount, session } from './api';
import { disablePush } from './push';

export interface Membership { id: string; role: { key: string; name: string }; tenant: { id: string; slug: string; businessName: string; status: string } }
export interface Me { id: string; email: string; fullName: string; memberships: Membership[] }
export interface Workspace { id: string; slug: string; businessName: string; defaultCurrency: string; role: string; permissions: string[] }

type Status = 'loading' | 'signedOut' | 'signedIn';
interface Auth {
  status: Status;
  me: Me | null;
  workspace: Workspace | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (body: Record<string, unknown>) => Promise<void>;
  logout: () => Promise<void>;
  selectTenant: (id: string) => Promise<void>;
  can: (permission: string) => boolean;
}

const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  const loadWorkspace = useCallback(async (user: Me, preferred: string | null) => {
    const ids = user.memberships.map((m) => m.tenant.id);
    const pick = preferred && ids.includes(preferred) ? preferred : ids[0] ?? null;
    await session.setTenant(pick);
    setWorkspace(pick ? await api<Workspace>('/workspace') : null);
  }, []);

  const load = useCallback(async () => {
    const user = await api<Me>('/auth/me', { tenant: false });
    setMe(user);
    await loadWorkspace(user, await session.savedTenant());
    setStatus('signedIn');
  }, [loadWorkspace]);

  const signOutLocal = useCallback(() => {
    setMe(null);
    setWorkspace(null);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    session.onSignedOut(signOutLocal);
    // Resume a saved session: rotate the refresh token, then load the user.
    (async () => {
      try {
        if (await refresh()) await load();
        else signOutLocal();
      } catch {
        signOutLocal();
      }
    })();
  }, [load, signOutLocal]);

  const value = useMemo<Auth>(() => ({
    status, me, workspace,
    login: async (email, password) => {
      await apiLogin(email, password);
      await load();
    },
    signup: async (body) => {
      const tenantId = await registerAccount(body);
      await session.setTenant(tenantId);
      await load();
    },
    logout: async () => {
      await disablePush(); // this phone stops getting the store's notifications
      await apiLogout();
      signOutLocal();
    },
    selectTenant: async (id) => {
      if (me) await loadWorkspace(me, id);
    },
    can: (p) => !!workspace?.permissions.includes(p),
  }), [status, me, workspace, load, loadWorkspace, signOutLocal]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const a = useContext(Ctx);
  if (!a) throw new Error('useAuth outside AuthProvider');
  return a;
}

/** GET with loading / error / reload, refetched when the path or the store changes. */
export function useApi<T>(path: string | null) {
  const { workspace } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path, workspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
