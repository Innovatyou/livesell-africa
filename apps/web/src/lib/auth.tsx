'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onSessionChange, refreshSession, setActiveTenant, setSession } from './api';
import type { Me, Workspace } from './types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface TokenResponse { accessToken: string; expiresIn: number }

interface AuthState {
  status: Status;
  me: Me | null;
  workspace: Workspace | null;
  /** Use a token pair returned by register / accept-invitation. */
  startSession: (t: TokenResponse) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  selectTenant: (id: string) => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);
const TENANT_KEY = 'ls.tenant';

const readTenant = () => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};
export const rememberTenant = (id: string) => {
  try {
    localStorage.setItem(TENANT_KEY, id);
  } catch {
    /* private mode: the selection just isn't remembered */
  }
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const booted = useRef(false);

  const loadWorkspace = useCallback(async (user: Me, preferred?: string | null) => {
    const ids = user.memberships.map((m) => m.tenant.id);
    const pick = preferred && ids.includes(preferred) ? preferred : ids[0] ?? null;
    setActiveTenant(pick);
    if (!pick) {
      setWorkspace(null);
      return;
    }
    rememberTenant(pick); // a selector only; the API validates membership on every request
    setWorkspace(await api<Workspace>('/workspace'));
  }, []);

  const load = useCallback(async () => {
    const user = await api<Me>('/auth/me', { tenant: false });
    setMe(user);
    await loadWorkspace(user, readTenant());
    setStatus('authenticated');
  }, [loadWorkspace]);

  useEffect(() => {
    if (booted.current) return; // StrictMode runs effects twice in dev; one refresh only.
    booted.current = true;
    (async () => {
      try {
        if (await refreshSession()) await load();
        else setStatus('anonymous');
      } catch {
        setStatus('anonymous');
      }
    })();
  }, [load]);

  useEffect(
    () => onSessionChange((signedIn) => {
      if (!signedIn) {
        setMe(null);
        setWorkspace(null);
        setActiveTenant(null);
        setStatus('anonymous');
      }
    }),
    [],
  );

  // Keep the access token fresh while the tab is open (15-minute tokens).
  useEffect(() => {
    if (status !== 'authenticated') return;
    const id = setInterval(() => void refreshSession(), 12 * 60_000);
    return () => clearInterval(id);
  }, [status]);

  const startSession = useCallback(async (t: TokenResponse) => {
    setSession(t.accessToken, t.expiresIn);
    await load();
  }, [load]);

  const login = useCallback(async (email: string, password: string) => {
    const t = await api<TokenResponse>('/auth/login', { method: 'POST', body: { email, password }, tenant: false });
    await startSession(t);
  }, [startSession]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {}, tenant: false });
    } finally {
      setSession(null);
    }
  }, []);

  const selectTenant = useCallback(async (id: string) => {
    if (!me) return;
    await loadWorkspace(me, id);
  }, [me, loadWorkspace]);

  const value = useMemo<AuthState>(() => ({
    status, me, workspace, startSession, login, logout, reload: load, selectTenant,
    can: (p: string) => !!workspace?.permissions.includes(p),
  }), [status, me, workspace, startSession, login, logout, load, selectTenant]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
