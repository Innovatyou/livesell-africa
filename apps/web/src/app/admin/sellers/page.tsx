'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorState, Input, PageLoading, Select } from '@/components/ui';
import { day, Pager, useAdmin } from '@/components/admin-ui';

interface Row {
  id: string; slug: string; businessName: string; email: string; phone: string; status: string; createdAt: string; verifiedAt: string | null;
  subscription: { status: string; plan: { name: string; code: string } } | null; _count: { orders: number; products: number };
}
const TENANT_TONE: Record<string, 'good' | 'info' | 'bad' | 'neutral'> = { ACTIVE: 'good', TRIAL: 'info', SUSPENDED: 'bad', CLOSED: 'neutral' };

export default function SellersPage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...(query ? { search: query } : {}), ...(status ? { status } : {}) }).toString();
  const res = useAdmin<{ items: Row[]; total: number; page: number; pageSize: number }>(`/admin/sellers?${qs}`);
  return (
    <div className="space-y-4">
      <PageHeader title="Sellers" description="Every store on LiveSell. Open one to see its plan, sales and history, or to suspend it." />
      <Card>
        <form className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); }}>
          <Input aria-label="Search sellers" placeholder="Business name, store name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="sm:w-48">
            <option value="">All statuses</option>{['TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </Select>
        </form>
        {res.error ? <div className="p-5"><ErrorState message={res.error} onRetry={res.reload} /></div> : !res.data ? <PageLoading /> : res.data.items.length === 0 ? <EmptyState title="No sellers match" /> : (
          <ul className="divide-y divide-line">
            {res.data.items.map((s) => (
              <li key={s.id}>
                <Link href={`/admin/sellers/${s.id}`} className="flex flex-col gap-1 px-5 py-3 text-sm hover:bg-sunken sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><p className="font-medium">{s.businessName} <span className="font-normal text-ink-3">/{s.slug}</span></p><p className="truncate text-[13px] text-ink-3">{s.email} · joined {day(s.createdAt)} · {s._count.orders} orders · {s._count.products} products</p></div>
                  <div className="flex shrink-0 items-center gap-2">
                    {s.subscription && <span className="text-[13px] text-ink-2">{s.subscription.plan.name} · {s.subscription.status.toLowerCase().replace('_', ' ')}</span>}
                    {s.verifiedAt && <Badge tone="info">Verified</Badge>}
                    <Badge tone={TENANT_TONE[s.status] ?? 'neutral'}>{s.status.toLowerCase()}</Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {res.data && <Pager page={page} total={res.data.total} size={res.data.pageSize} onPage={setPage} />}
      </Card>
    </div>
  );
}
