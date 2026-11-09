'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorState, Input, PageLoading } from '@/components/ui';
import { Pager, useAdmin, when } from '@/components/admin-ui';

interface Entry { id: string; action: string; entityType: string | null; entityId: string | null; metadata: Record<string, unknown>; ip: string | null; createdAt: string; actor: { fullName: string; email: string } | null; tenant: { businessName: string; slug: string } | null }

function Audit() {
  const params = useSearchParams();
  const tenantId = params.get('tenantId') ?? '';
  const [action, setAction] = useState('');
  const [query, setQuery] = useState('');
  const [platformOnly, setPlatformOnly] = useState(false);
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...(tenantId ? { tenantId } : {}), ...(query ? { action: query } : {}), ...(platformOnly ? { platformOnly: 'true' } : {}) }).toString();
  const res = useAdmin<{ items: Entry[]; total: number; pageSize: number }>(`/admin/audit?${qs}`);
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description={tenantId ? 'One seller’s security and money events.' : 'Security- and money-relevant events across LiveSell. Secrets are redacted before they are stored.'} />
      <Card>
        <form className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row sm:items-center" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(action.trim()); }}>
          <Input aria-label="Action starts with" placeholder="Action starts with, e.g. payment. or admin." value={action} onChange={(e) => setAction(e.target.value)} />
          {!tenantId && <label className="flex shrink-0 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={platformOnly} onChange={(e) => { setPlatformOnly(e.target.checked); setPage(1); }} /> Platform-level only</label>}
        </form>
        {res.error ? <div className="p-5"><ErrorState message={res.error} onRetry={res.reload} /></div> : !res.data ? <PageLoading /> : res.data.items.length === 0 ? <EmptyState title="No events match" /> : (
          <ul className="divide-y divide-line text-sm">
            {res.data.items.map((a) => (
              <li key={a.id} className="px-5 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-mono text-[12px] font-medium">{a.action}</span><span className="text-[12px] text-ink-3">{when(a.createdAt)}</span></div>
                <p className="text-[13px] text-ink-3">{a.actor ? `${a.actor.fullName} (${a.actor.email})` : 'System / customer'}{a.tenant ? ` · ${a.tenant.businessName}` : ''}{a.entityType ? ` · ${a.entityType}` : ''}{a.ip ? ` · ${a.ip}` : ''}</p>
                {Object.keys(a.metadata ?? {}).length > 0 && <p className="mt-1 break-all font-mono text-[11px] text-ink-3">{JSON.stringify(a.metadata)}</p>}
              </li>
            ))}
          </ul>
        )}
        {res.data && <Pager page={page} total={res.data.total} size={res.data.pageSize} onPage={setPage} />}
      </Card>
    </div>
  );
}

export default function AuditPage() {
  return <Suspense fallback={<PageLoading />}><Audit /></Suspense>;
}
