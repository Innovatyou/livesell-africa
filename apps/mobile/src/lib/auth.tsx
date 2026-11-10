import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, login as apiLogin, logout as apiLogout, refresh, registerAccount, session } from './api';
import * as bio from './biometric';
import { disablePush } from './push';

export interface Membership { id: string; role: { key: string; name: string }; tenant: { id: string; slug: string; businessName: string; status: string } }
export interface Me { id: string; email: string; fullName: string; memberships: Membership[] }
export interface Workspace { id: string; slug: string; businessName: string; defaultCurrency: string; role: string; permissions: string[] }

/** `locked`: a saved session exists but biometric unlock is on and hasn't happened yet (app start, or back after 5 min). */
type Status = 'loading' | 'signedOut' | 'signedIn' | 'locked';
const LOCK_AFTER_MS = 5 * 60_000;
interface Auth {
  status: Status;
  me: Me | null;
  workspace: Workspace | null;
  /** Email or phone + password. `remember` keeps the email/phone (never the password) to prefill next time. */
  login: (identifier: string, password: string, remember: boolean) => Promise<void>;
  /** Biometric prompt; on success the saved session opens. */
  unlock: () => Promise<boolean>;
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

  const resume = useCallback(async () => {
    try {
      if (await refresh()) await load();
      else signOutLocal();
    } catch {
      signOutLocal();
    }
  }, [load, signOutLocal]);

  useEffect(() => {
    session.onSignedOut(signOutLocal);
    // Resume a saved session (rotate the refresh token, load the user), behind biometrics when the seller turned them on.
    (async () => {
      if ((await session.hasRefresh()) && (await bio.isEnabled())) setStatus('locked');
      else await resume();
    })();
  }, [resume, signOutLocal]);

  // Lock again after 5 minutes in the background.
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    let leftAt = 0;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') leftAt = Date.now();
      if (s === 'active' && leftAt && Date.now() - leftAt > LOCK_AFTER_MS && statusRef.current === 'signedIn') {
        void bio.isEnabled().then((on) => { if (on) setStatus('locked'); });
      }
    });
    return () => sub.remove();
  }, []);

  const value = useMemo<Auth>(() => ({
    status, me, workspace,
    login: async (identifier, password, remember) => {
      await apiLogin(identifier, password);
      await bio.rememberIdentifier(remember ? identifier : null);
      await load();
    },
    unlock: async () => {
      if (!(await bio.authenticate())) return false;
      if (me) setStatus('signedIn'); // back from the background: the session is still loaded
      else { setStatus('loading'); await resume(); }
      return true;
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
  }), [status, me, workspace, load, loadWorkspace, signOutLocal, resume]);

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
