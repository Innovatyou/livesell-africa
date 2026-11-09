'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, Button, EmptyState, ErrorState, PageLoading, Select } from '@/components/ui';
import { adminCall, day, Pager, ReasonForm, Section, Stat, useAction, useAdmin, useIsAdmin } from '@/components/admin-ui';
import { formatMoney } from '@/lib/money';

interface Provider { code: string; name: string; isEnabled: boolean; sandboxMode: boolean; adapterAvailable: boolean; platformKeyConfigured: boolean | null; webhooksEnabled: boolean | null }
interface Commission {
  openTotalMinor: string; openCount: number; total: number; page: number;
  items: Array<{ id: string; number: string; amountMinor: string; status: string; dueAt: string; description: string | null; overdue: boolean; store: { id: string; businessName: string; slug: string } }>;
}

/** Payment providers (on/off, sandbox) and commission owed by sellers who collect payments themselves. */
export default function AdminPayments() {
  const isAdmin = useIsAdmin();
  const providers = useAdmin<Provider[]>('/admin/payment-providers');
  const [status, setStatus] = useState('OPEN');
  const [page, setPage] = useState(1);
  const commission = useAdmin<Commission>(`/admin/commission?page=${page}${status ? `&status=${status}` : ''}`);
  const act = useAction();
  const [waiving, setWaiving] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader title="Payments & commission" description="Gateway keys live in the server environment; here you switch providers on or off and follow commission owed." />
      {act.note}
      <Section title="Payment providers">
        {providers.error ? <div className="p-5"><ErrorState message={providers.error} onRetry={providers.reload} /></div> : !providers.data ? <PageLoading /> : (
          <ul className="divide-y divide-line text-sm">
            {providers.data.map((p) => (
              <li key={p.code} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{p.name} <Badge tone={p.isEnabled ? 'good' : 'neutral'}>{p.isEnabled ? 'On' : 'Off'}</Badge> {p.sandboxMode && <Badge tone="warn">Sandbox</Badge>}</p>
                  <p className="text-[13px] text-ink-3">{!p.adapterAvailable ? 'Not integrated' : `Platform key ${p.platformKeyConfigured ? 'set' : 'missing'} · webhooks ${p.webhooksEnabled ? 'on' : 'off'}`}</p>
                </div>
                {isAdmin && p.adapterAvailable && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" loading={act.busy === `en-${p.code}`} onClick={() => void act.run(`en-${p.code}`, async () => { await adminCall(`/admin/payment-providers/${p.code.toLowerCase()}`, 'PATCH', { isEnabled: !p.isEnabled }); await providers.reload(); }, `${p.name} switched ${p.isEnabled ? 'off' : 'on'}.`)}>{p.isEnabled ? 'Switch off' : 'Switch on'}</Button>
                    <Button size="sm" variant="ghost" loading={act.busy === `sb-${p.code}`} onClick={() => void act.run(`sb-${p.code}`, async () => { await adminCall(`/admin/payment-providers/${p.code.toLowerCase()}`, 'PATCH', { sandboxMode: !p.sandboxMode }); await providers.reload(); }, 'Saved.')}>{p.sandboxMode ? 'Use live mode' : 'Use sandbox'}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Commission invoices" description="Monthly invoices for commission on sales sellers collected themselves (own payment account, bank transfer). Split payments settle at source."
        action={<Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-9 w-auto"><option value="OPEN">Open</option><option value="PAID">Paid</option><option value="UNCOLLECTIBLE">Waived</option><option value="">All</option></Select>}>
        {commission.data && <div className="grid gap-3 p-5 sm:grid-cols-2"><Stat label="Open commission" value={formatMoney(commission.data.openTotalMinor)} hint={`${commission.data.openCount} invoice(s)`} /></div>}
        {commission.error ? <div className="p-5"><ErrorState message={commission.error} onRetry={commission.reload} /></div> : !commission.data ? <PageLoading /> : commission.data.items.length === 0 ? <EmptyState title="No invoices here" /> : (
          <ul className="divide-y divide-line text-sm">
            {commission.data.items.map((i) => (
              <li key={i.id} className="space-y-2 px-5 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div><p className="font-medium"><Link href={`/admin/sellers/${i.store.id}`} className="hover:text-brand-700">{i.store.businessName}</Link> <span className="font-normal text-ink-3">· {i.number}</span></p><p className="text-[13px] text-ink-3">Due {day(i.dueAt)}</p></div>
                  <div className="flex items-center gap-2">
                    <span className="tabular font-semibold">{formatMoney(i.amountMinor)}</span>
                    <Badge tone={i.status === 'PAID' ? 'good' : i.status === 'UNCOLLECTIBLE' ? 'neutral' : i.overdue ? 'bad' : 'warn'}>{i.status === 'UNCOLLECTIBLE' ? 'Waived' : i.overdue ? 'Overdue' : i.status.toLowerCase()}</Badge>
                    {isAdmin && i.status === 'OPEN' && waiving !== i.id && <Button size="sm" variant="ghost" onClick={() => setWaiving(i.id)}>Waive</Button>}
                  </div>
                </div>
                {waiving === i.id && <ReasonForm label="Why is this commission being waived?" action="Waive invoice" busy={act.busy === `w-${i.id}`} onCancel={() => setWaiving(null)}
                  onSubmit={(reason) => void act.run(`w-${i.id}`, async () => { await adminCall(`/admin/commission/invoices/${i.id}/waive`, 'POST', { reason }); setWaiving(null); await commission.reload(); }, 'Invoice waived; the ledger is reversed and any block on the store is lifted.')} />}
              </li>
            ))}
          </ul>
        )}
        {commission.data && <Pager page={page} total={commission.data.total} size={25} onPage={setPage} />}
      </Section>
    </div>
  );
}
