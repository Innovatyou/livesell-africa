'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

/**
 * GET hook with loading / error / data and a reload. Re-runs when `path` changes; `null` path = skip.
 * `tenant: false` leaves out X-Tenant-Id (platform-admin routes are not store-scoped).
 */
export function useApi<T>(path: string | null, opts: { tenant?: boolean } = {}) {
  const tenant = opts.tenant !== false;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ status?: number; code?: string }>({});
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api<T>(path, { tenant });
      if (mine === seq.current) setData(d);
    } catch (e) {
      if (mine === seq.current) {
        setError(errorMessage(e));
        const err = e as { status?: number; code?: string };
        setStatus({ status: err.status, code: err.code });
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path, tenant]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, errorStatus: status.status, errorCode: status.code, loading, reload: load, setData };
}
