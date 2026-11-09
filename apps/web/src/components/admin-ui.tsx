'use client';

import { useState } from 'react';
import { Alert, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

/** Admin routes are not store-scoped: never send X-Tenant-Id. */
export const useAdmin = <T,>(path: string | null) => useApi<T>(path, { tenant: false });
export const adminCall = <T,>(path: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown = {}) => api<T>(path, { method, body, tenant: false });
export const useIsAdmin = () => useAuth().me?.platformRole === 'PLATFORM_ADMIN';

export const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s));
export const day = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));

/** Runs an admin action with busy / message state. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
      return true;
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, msg, run, note: msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null };
}

/** A required reason (suspension, rejection, waiver): asked inline, never with a bare confirm. */
export function ReasonForm({ label, action, busy, onSubmit, onCancel }: { label: string; action: string; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <Field label={label} hint="At least 5 characters; recorded in the audit log">{(p) => <Input {...p} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}</Field>
      <div className="flex gap-2">
        <Button size="sm" variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={() => onSubmit(reason.trim())}>{action}</Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="space-y-1 p-4">
      <p className="text-[13px] text-ink-3">{label}</p>
      <p className="text-xl font-semibold tabular">{value}</p>
      {hint && <p className="text-[12px] text-ink-3">{hint}</p>}
    </Card>
  );
}

export function Section({ title, description, children, action }: { title: string; description?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <Card><CardHeader title={title} description={description} action={action} />{children}</Card>;
}

export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="text-ink-3">Page {page} of {pages}</span>
      <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}
