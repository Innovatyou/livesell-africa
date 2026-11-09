'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Input, Select, Skeleton, cx } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { downloadCsv } from '@/lib/download';
import { formatMoney } from '@/lib/money';
import { ORDER_STATUS, relativeHold } from '@/lib/order-labels';
import type { OrderListItem, Page, SalesChannel } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const VIEWS: Array<[string, string]> = [['', 'All'], ['awaiting_payment', 'Awaiting payment'], ['to_fulfil', 'To fulfil'], ['completed', 'Delivered'], ['cancelled', 'Cancelled']];
const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

function Orders() {
  const { can } = useAuth();
  const params = useSearchParams();
  const liveSessionId = params.get('liveSessionId') ?? '';
  const [view, setView] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [channelId, setChannelId] = useState('');
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (view) p.set('view', view);
    if (query) p.set('search', query);
    if (channelId) p.set('channelId', channelId);
    if (liveSessionId) p.set('liveSessionId', liveSessionId);
    return p.toString();
  }, [view, query, channelId, liveSessionId, page]);
  const list = useApi<Page<OrderListItem>>(can('orders:read') ? `/orders?${qs}` : null);
  const channels = useApi<SalesChannel[]>(can('orders:read') ? '/sales-channels' : null);
  if (!can('orders:read')) return <Card><EmptyState title="Your role can't view orders" /></Card>;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const filtered = !!(view || query || channelId || liveSessionId);

  return (
    <>
      <PageHeader title="Orders" description="Unpaid orders hold stock until they are paid or the hold runs out."
        action={<div className="flex gap-2">
          {can('customers:export') && <Button size="sm" variant="secondary" onClick={() => downloadCsv(`/orders/export?${qs}`, 'orders.csv').catch((e) => setMsg(errorMessage(e)))}>Export CSV</Button>}
          {can('orders:create') && <ButtonLink href="/orders/new" size="sm">New order</ButtonLink>}
        </div>} />
      {msg && <Alert tone="bad" className="mb-4">{msg}</Alert>}
      {liveSessionId && <Alert tone="info" className="mb-4" action={<ButtonLink href="/orders" size="sm" variant="secondary">Show all</ButtonLink>}>Showing orders from one live session.</Alert>}
      <div role="tablist" aria-label="Order views" className="mb-4 flex gap-1 overflow-x-auto pb-1">
        {VIEWS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => { setView(k); setPage(1); }}
            className={cx('whitespace-nowrap rounded-full border px-3 py-1.5 text-sm', view === k ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-line bg-surface text-ink-2 hover:text-ink')}>{l}</button>
        ))}
      </div>
      <Card>
        <div className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row">
          <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); }}>
            <Input aria-label="Search orders" placeholder="Reference, customer, phone or product code" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          <Select aria-label="Channel" className="sm:w-52" value={channelId} onChange={(e) => { setChannelId(e.target.value); setPage(1); }}>
            <option value="">All channels</option>{channels.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11" />)}</div>
          : list.data.items.length === 0 ? (filtered
            ? <EmptyState title="No orders match">Try another view or search.</EmptyState>
            : <EmptyState title="No orders yet" action={can('orders:create') ? <ButtonLink href="/orders/new">Record an order</ButtonLink> : undefined}>Orders from your storefront, live sessions and manual entry appear here.</EmptyState>)
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Order</th><th className="px-5 py-2.5 font-medium">Customer</th><th className="px-5 py-2.5 font-medium">Channel</th>
                  <th className="px-5 py-2.5 font-medium">Status</th><th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((o) => (
                    <tr key={o.id}>
                      <td className="px-5 py-3"><Link href={`/orders/${o.id}`} className="font-mono font-medium hover:text-brand-700">{o.reference}</Link><p className="text-[12px] text-ink-3">{when(o.createdAt)} · {o._count.items} item{o._count.items === 1 ? '' : 's'}</p></td>
                      <td className="px-5 py-3">{o.customer ? <><p>{o.customer.fullName}</p><p className="text-[12px] text-ink-3">{o.customer.phone}</p></> : <span className="text-ink-3">—</span>}</td>
                      <td className="px-5 py-3 text-ink-2">{o.liveSession ? <Link href={`/live/${o.liveSession.id}`} className="hover:text-ink">{o.liveSession.title}</Link> : o.channel?.name ?? '—'}</td>
                      <td className="px-5 py-3"><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>{o.reservationExpiresAt && <p className="mt-0.5 text-[12px] text-ink-3">{relativeHold(o.reservationExpiresAt)}</p>}</td>
                      <td className="px-5 py-3 text-right tabular">{formatMoney(o.totalMinor, o.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {list.data && list.data.total > list.data.pageSize && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
            <span className="text-ink-3">{list.data.total} orders · page {page} of {pages}</span>
            <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
          </div>
        )}
      </Card>
    </>
  );
}

export default function OrdersPage() {
  return <Suspense fallback={<Skeleton className="h-40" />}><Orders /></Suspense>;
}
