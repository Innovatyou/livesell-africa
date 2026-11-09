'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Skeleton, cx } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { downloadCsv } from '@/lib/download';
import { formatMoney } from '@/lib/money';
import { E164, normalisePhone } from '@/lib/nav';
import type { CustomerListItem, CustomerSegment, Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const SEGMENTS: Array<[CustomerSegment, string, string]> = [
  ['all', 'All', 'Everyone'], ['vip', 'Top spenders', 'Top 10% by paid spend'], ['repeat', 'Repeat', '2+ paid orders'],
  ['new', 'New', 'Added in the last 30 days'], ['inactive', 'Inactive', 'Bought before, nothing in 90 days'],
  ['outstanding', 'Open orders', 'Awaiting payment or delivery'], ['opted_in', 'WhatsApp opt-in', 'Agreed to WhatsApp messages'],
];
const date = (s: string | null) => (s ? new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s)) : '—');

export default function CustomersPage() {
  const { can } = useAuth();
  const [segment, setSegment] = useState<CustomerSegment>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const qs = useMemo(() => new URLSearchParams({ segment, sort, page: String(page), pageSize: '25', ...(query ? { search: query } : {}) }).toString(), [segment, sort, page, query]);
  const list = useApi<Page<CustomerListItem>>(can('customers:read') ? `/customers?${qs}` : null);
  if (!can('customers:read')) return <Card><EmptyState title="Your role can't view customers" /></Card>;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="Customers" description="Spend and order figures come from paid orders."
        action={<div className="flex gap-2">
          {can('customers:export') && <Button size="sm" variant="secondary" onClick={() => downloadCsv(`/customers/export?segment=${segment}${query ? `&search=${encodeURIComponent(query)}` : ''}`, 'customers.csv').then(() => setMsg({ tone: 'good', text: 'Export downloaded. It contains personal data — store it securely.' }), (e) => setMsg({ tone: 'bad', text: errorMessage(e) }))}>Export CSV</Button>}
          {can('customers:write') && <Button size="sm" onClick={() => setAdding(true)}>New customer</Button>}
        </div>}
      />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      <div role="tablist" aria-label="Segments" className="mb-4 flex gap-1 overflow-x-auto pb-1">
        {SEGMENTS.map(([k, label, hint]) => (
          <button key={k} role="tab" aria-selected={segment === k} title={hint} onClick={() => { setSegment(k); setPage(1); }}
            className={cx('whitespace-nowrap rounded-full border px-3 py-1.5 text-sm', segment === k ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-line bg-surface text-ink-2 hover:text-ink')}>{label}</button>
        ))}
      </div>
      <Card>
        <div className="flex flex-col gap-2 border-b border-line p-4 sm:flex-row">
          <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); }}>
            <Input aria-label="Search customers" placeholder="Search name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          <Select aria-label="Sort" className="sm:w-48" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
            <option value="recent">Newest first</option><option value="spend">Highest spend</option><option value="orders">Most orders</option><option value="last_order">Recent buyers</option><option value="name">Name A–Z</option>
          </Select>
        </div>
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11" />)}</div>
          : list.data.items.length === 0 ? (
            segment === 'all' && !query
              ? <EmptyState title="No customers yet" action={can('customers:write') ? <Button onClick={() => setAdding(true)}>Add a customer</Button> : undefined}>Customers are also added automatically when they order.</EmptyState>
              : <EmptyState title="No customers in this view">Try another segment or search.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Customer</th><th className="px-5 py-2.5 font-medium">Contact</th><th className="px-5 py-2.5 text-right font-medium">Orders</th>
                  <th className="px-5 py-2.5 text-right font-medium">Spent</th><th className="px-5 py-2.5 text-right font-medium">Last order</th>
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((c) => (
                    <tr key={c.id}>
                      <td className="px-5 py-3">
                        <Link href={`/customers/${c.id}`} className="font-medium hover:text-brand-700">{c.fullName}</Link>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {c.vip && <Badge tone="brand">Top spender</Badge>}{c.repeat && <Badge tone="good">Repeat</Badge>}
                          {c.outstanding > 0 && <Badge tone="warn">{c.outstanding} open</Badge>}{c.anonymizedAt && <Badge>Erased</Badge>}
                          {c.tags.slice(0, 3).map((t) => <Badge key={t}>{t}</Badge>)}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-ink-2">{c.phone ?? c.email ?? '—'}</td>
                      <td className="px-5 py-3 text-right tabular">{c.orderCount}</td>
                      <td className="px-5 py-3 text-right tabular">{formatMoney(c.totalSpentMinor)}</td>
                      <td className="px-5 py-3 text-right text-ink-3">{date(c.lastOrderAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {list.data && list.data.total > list.data.pageSize && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
            <span className="text-ink-3">{list.data.total} customers · page {page} of {pages}</span>
            <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
          </div>
        )}
      </Card>
      {adding && <NewCustomerDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function NewCustomerDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ fullName: '', phone: '', email: '', tags: '', whatsappOptIn: false, line1: '', city: '', state: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; existingId?: string } | null>(null);
  const phoneErr = f.phone && !E164.test(normalisePhone(f.phone)) ? 'Enter a valid phone number' : null;
  const addr = f.line1 || f.city || f.state;
  const valid = f.fullName.trim().length >= 2 && (f.phone || f.email) && !phoneErr && (!addr || (f.line1.trim().length >= 3 && f.city.trim().length >= 2 && f.state.trim().length >= 2));
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string }>('/customers', {
        method: 'POST',
        body: {
          fullName: f.fullName.trim(), ...(f.phone ? { phone: normalisePhone(f.phone) } : {}), ...(f.email ? { email: f.email.trim() } : {}),
          tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), whatsappOptIn: f.whatsappOptIn,
          ...(addr ? { address: { line1: f.line1.trim(), city: f.city.trim(), state: f.state.trim() } } : {}),
        },
      });
      router.push(`/customers/${c.id}`);
    } catch (e) {
      const existingId = e instanceof ApiError ? (e.body as { customerId?: string })?.customerId : undefined;
      setError({ text: errorMessage(e), existingId });
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="New customer" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={() => void save()}>Add customer</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert tone="bad" className="sm:col-span-2" action={error.existingId ? <Button size="sm" variant="secondary" onClick={() => router.push(`/customers/${error.existingId}`)}>Open</Button> : undefined}>{error.text}</Alert>}
        <Field label="Full name" className="sm:col-span-2">{(p) => <Input {...p} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
        <Field label="Phone" error={phoneErr}>{(p) => <Input {...p} type="tel" placeholder="0803 123 4567" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="Tags" hint="Comma separated" className="sm:col-span-2">{(p) => <Input {...p} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />}</Field>
        <label className="flex items-start gap-2 text-sm text-ink-2 sm:col-span-2">
          <input type="checkbox" className="mt-0.5" checked={f.whatsappOptIn} onChange={(e) => setF({ ...f, whatsappOptIn: e.target.checked })} />
          The customer agreed to receive WhatsApp messages from this store
        </label>
        <p className="text-[13px] font-medium text-ink-2 sm:col-span-2">Delivery address (optional)</p>
        <Field label="Address" className="sm:col-span-2">{(p) => <Input {...p} value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} />}</Field>
        <Field label="City">{(p) => <Input {...p} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
        <Field label="State">{(p) => <Input {...p} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />}</Field>
        {!f.phone && !f.email && <p className="text-[13px] text-ink-3 sm:col-span-2">Add a phone number or an email.</p>}
      </div>
    </Dialog>
  );
}
