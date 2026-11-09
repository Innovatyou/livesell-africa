'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, Button, ErrorState, PageLoading } from '@/components/ui';
import { adminCall, day, ReasonForm, Section, Stat, useAction, useAdmin, useIsAdmin, when } from '@/components/admin-ui';
import { formatBps, formatCount, formatMoney } from '@/lib/money';

interface Seller {
  id: string; slug: string; businessName: string; email: string; phone: string; status: string; createdAt: string; verifiedAt: string | null; state: string | null; city: string | null;
  subscription: { status: string; currentPeriodEnd: string; plan: { name: string; pricingModel: string; commissionBps: number | null } } | null;
  team: Array<{ userId: string; fullName: string; email: string; role: string }>;
  _count: { orders: number; products: number; customers: number };
  sales: { last30DaysMinor: string; last30DaysPayments: number; allTimeMinor: string };
  invoices: Array<{ id: string; number: string; kind: string; amountMinor: string; status: string; dueAt: string }>;
  commission: { unbilledMinor: string; writesBlocked: boolean; rate: { bps: number } | null };
  recentActivity: Array<{ id: string; action: string; createdAt: string; metadata: Record<string, unknown> }>;
}

export default function SellerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isAdmin = useIsAdmin();
  const res = useAdmin<Seller>(`/admin/sellers/${id}`);
  const act = useAction();
  const [asking, setAsking] = useState(false);
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <PageLoading />;
  const s = res.data;
  const suspended = s.status === 'SUSPENDED';

  return (
    <div className="space-y-6">
      <PageHeader title={s.businessName} description={`/${s.slug} · ${s.email} · ${s.phone}${s.city ? ` · ${s.city}, ${s.state}` : ''} · joined ${day(s.createdAt)}`}
        action={<div className="flex items-center gap-2">
          <Badge tone={suspended ? 'bad' : s.status === 'ACTIVE' ? 'good' : 'info'}>{s.status.toLowerCase()}</Badge>
          {isAdmin && !suspended && s.status !== 'CLOSED' && !asking && <Button size="sm" variant="danger" onClick={() => setAsking(true)}>Suspend</Button>}
          {isAdmin && suspended && <Button size="sm" loading={act.busy === 'reactivate'} onClick={() => void act.run('reactivate', async () => res.setData(await adminCall<Seller>(`/admin/sellers/${id}/reactivate`, 'POST', {})), 'Suspension lifted.')}>Reactivate</Button>}
        </div>} />
      {act.note}
      {asking && <ReasonForm label="Why is this store being suspended?" action="Suspend store" busy={act.busy === 'suspend'} onCancel={() => setAsking(false)}
        onSubmit={(reason) => void act.run('suspend', async () => { res.setData(await adminCall<Seller>(`/admin/sellers/${id}/suspend`, 'POST', { reason })); setAsking(false); }, 'Store suspended. Its team, storefront and checkout are blocked; data is kept.')} />}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Plan" value={s.subscription?.plan.name ?? '—'} hint={s.subscription ? `${s.subscription.status.toLowerCase().replace('_', ' ')} · until ${day(s.subscription.currentPeriodEnd)}` : 'No subscription'} />
        <Stat label="Sales (30 days)" value={formatMoney(s.sales.last30DaysMinor)} hint={`${s.sales.last30DaysPayments} verified payments · ${formatMoney(s.sales.allTimeMinor)} all time`} />
        <Stat label="Catalogue" value={`${formatCount(s._count.products)} products`} hint={`${formatCount(s._count.orders)} orders · ${formatCount(s._count.customers)} customers`} />
        <Stat label="Commission not yet invoiced" value={formatMoney(s.commission.unbilledMinor)} hint={`${s.commission.rate ? formatBps(s.commission.rate.bps) : '—'}${s.commission.writesBlocked ? ' · writes blocked (overdue)' : ''}`} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Team">
          <ul className="divide-y divide-line text-sm">{s.team.map((m) => <li key={m.userId} className="flex justify-between px-5 py-2.5"><span>{m.fullName} <span className="text-ink-3">{m.email}</span></span><span className="text-ink-2">{m.role}</span></li>)}</ul>
        </Section>
        <Section title="Invoices" action={<Link href="/admin/payments" className="text-sm text-brand-700">Commission</Link>}>
          {s.invoices.length === 0 ? <p className="px-5 py-4 text-sm text-ink-3">No invoices yet.</p> : (
            <ul className="divide-y divide-line text-sm">{s.invoices.map((i) => <li key={i.id} className="flex justify-between px-5 py-2.5"><span>{i.number} <span className="text-ink-3">{i.kind.toLowerCase().replace('_', ' ')}</span></span><span className="tabular">{formatMoney(i.amountMinor)} · {i.status.toLowerCase()}</span></li>)}</ul>
          )}
        </Section>
      </div>

      <Section title="Recent activity" action={<Link href={`/admin/audit?tenantId=${id}`} className="text-sm text-brand-700">Full audit log</Link>}>
        <ul className="divide-y divide-line text-sm">{s.recentActivity.map((a) => <li key={a.id} className="flex justify-between gap-3 px-5 py-2"><span className="font-mono text-[12px]">{a.action}</span><span className="shrink-0 text-ink-3">{when(a.createdAt)}</span></li>)}</ul>
      </Section>
    </div>
  );
}
